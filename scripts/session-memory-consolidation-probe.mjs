import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  runEmbeddedPiAgent,
} from "../dist/extensionAPI.js";
import { loadConfig } from "../dist/index.js";

function resolveConfigPath() {
  const explicit =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || process.env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");
  return path.join(path.resolve(stateDir), "openclaw.json");
}

function loadConfigSnapshot() {
  const configPath = resolveConfigPath();
  return {
    configPath,
    config: loadConfig(),
  };
}

function resolveSessionMemoryHookConfig(config) {
  return config?.hooks?.internal?.entries?.["session-memory"] ?? {};
}

function resolveModelOverride(hookConfig) {
  const providerRaw = typeof hookConfig?.provider === "string" ? hookConfig.provider.trim() : "";
  const modelRaw = typeof hookConfig?.model === "string" ? hookConfig.model.trim() : "";

  if (modelRaw.includes("/")) {
    const slashIndex = modelRaw.indexOf("/");
    return {
      provider: modelRaw.slice(0, slashIndex).trim() || DEFAULT_PROVIDER,
      model: modelRaw.slice(slashIndex + 1).trim() || DEFAULT_MODEL,
      source: "session-memory.model",
    };
  }

  if (providerRaw || modelRaw) {
    return {
      provider: providerRaw || DEFAULT_PROVIDER,
      model: modelRaw || undefined,
      source:
        providerRaw && modelRaw
          ? "session-memory.provider+model"
          : providerRaw
            ? "session-memory.provider"
            : "session-memory.model",
    };
  }

  return {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    source: "agent-default",
  };
}

function buildPrompt() {
  const existingFacts = [
    {
      id: "fact_reply_style",
      category: "preference",
      content: "用户偏好先给结论，再展开细节",
      confidence: 0.84,
      updatedAt: "2026-05-14 22:00:00 CST",
    },
  ];

  const incomingFact = {
    category: "preference",
    content: "用户希望回复保持简洁，并先给结论",
    confidence: 0.93,
    sourceError: "",
  };

  const transcript = [
    "user: 这类问题先给结论，别绕。",
    "assistant: 明白，后续会先给结论，再补必要说明。",
    "user: 回复也尽量简洁一点。",
  ].join("\n");

  return [
    "You are consolidating long-term memory facts within the same category.",
    "Decide whether the incoming fact should merge with an existing fact, replace a contradicted fact, append as new, or be dropped.",
    "Only reason within the same category. Do not create or remove facts in other categories.",
    "Return strict JSON with this shape and nothing else:",
    "{",
    '  "operations": [',
    '    { "op": "merge|replace|append|drop", "targetFactId": "fact_x", "canonicalContent": "...", "confidence": 0.0 }',
    "  ]",
    "}",
    "Rules:",
    "- `merge` means same underlying fact or a more specific restatement; preserve the target fact id.",
    "- `replace` means the incoming fact contradicts an existing fact in the same category and should supersede it.",
    "- `append` means this is a distinct new fact worth keeping.",
    "- `drop` means the incoming fact is too noisy, too short-term, or not suitable for long-term memory.",
    "- Emit at most one operation.",
    "- If using `merge` or `replace`, `targetFactId` must match one of the existing facts below.",
    "- Keep `canonicalContent` concise, durable, and user-facing.",
    "",
    "Generated At: 2026-05-15 18:00:00 CST",
    "Source: session-memory-probe",
    "Source Session ID: probe-session",
    "",
    "Existing Facts:",
    JSON.stringify(existingFacts, null, 2),
    "",
    "Incoming Fact:",
    JSON.stringify(incomingFact, null, 2),
    "",
    "Sanitized Transcript:",
    transcript,
  ].join("\n");
}

function extractJson(text) {
  if (!text) {
    return null;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = (fenced || text).trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return null;
  }

  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

async function main() {
  /* ======== 步骤1：解析配置与模型来源 ======== */
  console.info("[session-memory-probe] loading config");
  const { configPath, config } = loadConfigSnapshot();
  const agentId = process.argv[2]?.trim() || "main";
  const hookConfig = resolveSessionMemoryHookConfig(config);
  const override = resolveModelOverride(hookConfig);
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const agentDir = resolveAgentDir(config, agentId);

  /* ======== 步骤2：构造临时会话与 consolidation prompt ======== */
  console.info("[session-memory-probe] preparing prompt");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-probe-"));
  const sessionId = `session-memory-probe-${Date.now()}`;
  const sessionFile = path.join(tempDir, "probe-session.jsonl");

  try {
    /* ======== 步骤3：调用真实 deepseek LLM consolidation ======== */
    console.info(
      `[session-memory-probe] calling provider=${override.provider} model=${override.model ?? "(provider default)"} source=${override.source}`,
    );
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: "temp:session-memory-probe",
      agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config,
      provider: override.provider,
      model: override.model,
      prompt: buildPrompt(),
      timeoutMs: 30_000,
      runId: sessionId,
    });

    /* ======== 步骤4：解析返回并输出验证结果 ======== */
    const rawText =
      Array.isArray(result?.payloads) && result.payloads.length > 0
        ? (result.payloads.find((payload) => typeof payload?.text === "string")?.text?.trim() ??
          null)
        : null;
    const parsed = extractJson(rawText);
    const operation = Array.isArray(parsed?.operations) ? (parsed.operations[0] ?? null) : null;

    const output = {
      ok: Boolean(rawText && operation),
      configPath,
      hookConfig: {
        provider: hookConfig?.provider ?? null,
        model: hookConfig?.model ?? null,
      },
      resolvedModel: {
        provider: override.provider,
        model: override.model ?? null,
        source: override.source,
      },
      agentId,
      workspaceDir,
      rawText,
      parsed,
      firstOperation: operation,
    };

    console.log(JSON.stringify(output, null, 2));

    if (!output.ok) {
      process.exitCode = 1;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    "[session-memory-probe] failed:",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
