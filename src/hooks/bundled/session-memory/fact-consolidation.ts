import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  SameCategoryConsolidationOperation,
  SameCategoryConsolidationResult,
  SessionMemoryLlmOverrides,
  StructuredMemoryCategory,
  StructuredMemoryFact,
  StructuredMemoryFactUpdate,
} from "./types.js";

const log = createSubsystemLogger("hooks/session-memory");

function extractTextPayload(payloads: unknown): string | null {
  if (!Array.isArray(payloads)) {
    return null;
  }
  const match = payloads.find(
    (payload) => typeof (payload as { text?: unknown })?.text === "string",
  ) as { text?: string } | undefined;
  const text = match?.text?.trim();
  return text || null;
}

function buildSameCategoryConsolidationPrompt(params: {
  category: StructuredMemoryCategory;
  incomingFact: StructuredMemoryFactUpdate;
  existingFacts: StructuredMemoryFact[];
  transcript: string | null;
  generatedAt: string;
  source: string;
  sessionId?: string;
}): string {
  return [
    "You are consolidating long-term memory facts within the same category.",
    "Decide whether the incoming fact should merge with an existing fact, replace a contradicted fact, append as new, or be dropped.",
    "Only reason within the same category. Do not create or remove facts in other categories.",
    "Return strict JSON with this shape and nothing else:",
    "{",
    '  "operations": [',
    '    { "op": "merge|replace|append|drop", "targetFactId": "fact_x", "canonicalContent": "...", "confidence": 0.0, "reason": "..." }',
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
    "- Always include `reason` with a short audit-friendly explanation for the chosen operation.",
    "",
    `Generated At: ${params.generatedAt}`,
    `Source: ${params.source}`,
    `Source Session ID: ${params.sessionId ?? "unknown"}`,
    "",
    "Existing Facts:",
    JSON.stringify(
      params.existingFacts.map((fact) => ({
        id: fact.id,
        category: fact.category,
        content: fact.content,
        confidence: fact.confidence,
        updatedAt: fact.updatedAt,
      })),
      null,
      2,
    ),
    "",
    "Incoming Fact:",
    JSON.stringify(
      {
        category: params.incomingFact.category,
        content: params.incomingFact.content,
        confidence: params.incomingFact.confidence,
        sourceError: params.incomingFact.sourceError,
      },
      null,
      2,
    ),
    "",
    "Sanitized Transcript:",
    (params.transcript?.trim() || "(No usable transcript content was available.)").slice(0, 4000),
  ].join("\n");
}

function extractSameCategoryConsolidationResult(
  text: string | null,
): SameCategoryConsolidationResult | null {
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
    return JSON.parse(
      candidate.slice(firstBrace, lastBrace + 1),
    ) as SameCategoryConsolidationResult;
  } catch {
    return null;
  }
}

export async function consolidateSameCategoryFact(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  llmOverrides?: SessionMemoryLlmOverrides;
  llmTimeoutMs: number;
  category: StructuredMemoryCategory;
  incomingFact: StructuredMemoryFactUpdate;
  existingFacts: StructuredMemoryFact[];
  transcript: string | null;
  generatedAt: string;
  source: string;
  sessionId?: string;
}): Promise<SameCategoryConsolidationOperation | null> {
  if (!params.cfg || params.existingFacts.length === 0) {
    return null;
  }

  let tempSessionFile: string | null = null;
  try {
    const agentDir = resolveAgentDir(params.cfg, params.agentId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-consolidate-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");
    const result = await runEmbeddedPiAgent({
      sessionId: `memory-consolidate-${Date.now()}`,
      sessionKey: "temp:memory-consolidate",
      agentId: params.agentId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir,
      config: params.cfg,
      provider: params.llmOverrides?.provider,
      model: params.llmOverrides?.model,
      prompt: buildSameCategoryConsolidationPrompt({
        category: params.category,
        incomingFact: params.incomingFact,
        existingFacts: params.existingFacts,
        transcript: params.transcript,
        generatedAt: params.generatedAt,
        source: params.source,
        sessionId: params.sessionId,
      }),
      timeoutMs: params.llmTimeoutMs,
      runId: `memory-consolidate-${Date.now()}`,
    });
    const parsed = extractSameCategoryConsolidationResult(extractTextPayload(result.payloads));
    return parsed?.operations?.[0] ?? null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`failed to consolidate same-category fact: ${message}`);
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
