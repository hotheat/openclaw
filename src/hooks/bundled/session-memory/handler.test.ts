import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

// Avoid calling the embedded Pi agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

const DEFAULT_STRUCTURED_SUMMARY = [
  "## Daily Structured Summary",
  "",
  "- **Generated At**: 2026-05-15 04:00 CST",
  "- **Source**: reset",
  "- **Source Sessions**: test-123",
  "",
  "### 最终结论",
  "- 已将本轮可复用结论沉淀为结构化记忆。",
  "",
  "### 已验证有效的方法",
  "- 优先给出精确结论，避免模糊表述。",
  "",
  "### 稳定约束 / 用户偏好 / 重要决策",
  "- 偏好精确结论，并要求输出中文。",
  "- 仅采官方来源。",
  "",
  "### 待继续事项",
  "- 继续核对 Roche 财报。",
  "",
  "### 稳定失败教训",
  "- 未披露剂量不得推断，避免模糊剂量。",
].join("\n");

const EMPTY_STRUCTURED_SUMMARY = [
  "## Daily Structured Summary",
  "",
  "- **Generated At**: 2026-05-15 04:00 CST",
  "- **Source**: reset",
  "- **Source Sessions**: test-123",
  "",
  "- 无可靠新增项。",
].join("\n");

const HEARTBEAT_NOISE_STRUCTURED_SUMMARY = [
  "## Daily Structured Summary",
  "",
  "- **Generated At**: 2026-05-15 04:00 CST",
  "- **Source**: daily-rollover",
  "- **Source Sessions**: test-123",
  "",
  "### 最终结论",
  "- 周一清晨例行心跳检查，无主动用户请求。",
  "",
  "### 稳定失败教训",
  "- Connection error after retries.",
].join("\n");

const OPERATIONAL_DEBUG_STRUCTURED_SUMMARY = [
  "## Daily Structured Summary",
  "",
  "- **Generated At**: 2026-05-15 04:00 CST",
  "- **Source**: reset",
  "- **Source Sessions**: test-123",
  "",
  "### 最终结论",
  "- 用户明确要求排查 Connection error。",
  "",
  "### 稳定约束 / 用户偏好 / 重要决策",
  "- 将网关连接错误排查作为当前任务。",
].join("\n");

const DEFAULT_LONG_TERM_MEMORY_UPDATE = {
  user: {
    workContext: {
      summary: "主要负责 OpenClaw 网关与记忆链路。",
      shouldUpdate: true,
    },
    personalContext: {
      summary: "",
      shouldUpdate: false,
    },
    topOfMind: {
      summary: "当前重点是把 daily rollover 与 MEMORY.md 打通。",
      shouldUpdate: true,
    },
  },
  history: {
    recentMonths: {
      summary: "最近持续围绕 builtin memory、session rollover 和 Postgres 索引做演进。",
      shouldUpdate: true,
    },
    earlierContext: {
      summary: "",
      shouldUpdate: false,
    },
    longTermBackground: {
      summary: "长期维护本地部署的 OpenClaw 环境。",
      shouldUpdate: true,
    },
  },
  newFacts: [
    {
      content: "偏好使用 PostgreSQL 作为 memory 存储。",
      category: "preference",
      confidence: 0.92,
    },
    {
      content: "负责 OpenClaw gateway 与 memory manager 调试。",
      category: "context",
      confidence: 0.95,
    },
    {
      content: "当前目标是让 daily rollover 自动沉淀长期记忆。",
      category: "goal",
      confidence: 0.88,
    },
    {
      content: "上次 agent 未确认即删除文件。",
      category: "correction",
      confidence: 0.95,
      sourceError: "直接 rm -rf 未确认",
    },
    {
      content: "偶尔接受宽泛表述。",
      category: "behavior",
      confidence: 0.65,
    },
  ],
  factsToRemove: ["fact_remove_me"],
};

const SEMANTIC_MERGE_MEMORY_UPDATE = {
  user: {},
  history: {},
  newFacts: [
    {
      content: "更偏 Python 而非 Go",
      category: "preference",
      confidence: 0.9,
    },
  ],
  factsToRemove: [],
};

const CONTRADICTION_MEMORY_UPDATE = {
  user: {},
  history: {},
  newFacts: [
    {
      content: "用户偏好 Python 而非 Go",
      category: "preference",
      confidence: 0.93,
    },
  ],
  factsToRemove: [],
};

const CONCURRENT_MEMORY_UPDATE_A = {
  user: {},
  history: {},
  newFacts: [
    {
      content: "并发长期事实 A",
      category: "knowledge",
      confidence: 0.91,
    },
  ],
  factsToRemove: [],
};

const CONCURRENT_MEMORY_UPDATE_B = {
  user: {},
  history: {},
  newFacts: [
    {
      content: "并发长期事实 B",
      category: "knowledge",
      confidence: 0.92,
    },
  ],
  factsToRemove: [],
};

const SEMANTIC_CONSOLIDATION_MERGE = {
  operations: [
    {
      op: "merge",
      targetFactId: "fact_python_pref",
      canonicalContent: "更偏 Python 而非 Go",
      confidence: 0.93,
      reason: "新事实表达更完整，但与既有偏好指向同一长期偏好。",
    },
  ],
};

const SEMANTIC_CONSOLIDATION_REPLACE = {
  operations: [
    {
      op: "replace",
      targetFactId: "fact_lang_pref",
      canonicalContent: "用户偏好 Python 而非 Go",
      confidence: 0.95,
      reason: "新事实与旧偏好直接冲突，且当前会话给出的偏好更新更明确。",
    },
  ],
};

const SEMANTIC_CONSOLIDATION_NOOP = {
  operations: [],
};

vi.mock("../../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(async ({ prompt }: { prompt?: string }) => {
    if (
      typeof prompt === "string" &&
      prompt.includes("Decide whether to write the daily structured memory summary")
    ) {
      const shouldWrite =
        prompt.includes("USER_DEBUG_OPERATIONAL_TEST") ||
        (!prompt.includes("HEARTBEAT_NOISE_TEST") &&
          !prompt.includes("无新增记忆测试") &&
          prompt.includes("偏好精确结论"));
      return {
        payloads: [
          {
            text: JSON.stringify({
              shouldWriteDailyNote: shouldWrite,
              containsDurableMemory: shouldWrite,
              containsOnlyOperationalNoise: !shouldWrite,
              reason: shouldWrite
                ? "user explicitly asked to debug the operational issue"
                : "only heartbeat polling and transport errors",
            }),
          },
        ],
      };
    }
    if (typeof prompt === "string" && prompt.includes("Return strict JSON with this shape")) {
      if (prompt.includes("Source Session ID: test-merge")) {
        return {
          payloads: [
            {
              text: JSON.stringify(SEMANTIC_CONSOLIDATION_MERGE, null, 2),
            },
          ],
        };
      }
      if (prompt.includes("Source Session ID: test-contradiction")) {
        return {
          payloads: [
            {
              text: JSON.stringify(SEMANTIC_CONSOLIDATION_REPLACE, null, 2),
            },
          ],
        };
      }
      return {
        payloads: [
          {
            text: JSON.stringify(SEMANTIC_CONSOLIDATION_NOOP, null, 2),
          },
        ],
      };
    }
    if (typeof prompt === "string" && prompt.includes("Return strict JSON matching this shape")) {
      if (prompt.includes("Source Session ID: test-merge")) {
        return {
          payloads: [
            {
              text: JSON.stringify(SEMANTIC_MERGE_MEMORY_UPDATE, null, 2),
            },
          ],
        };
      }
      if (prompt.includes("Source Session ID: test-contradiction")) {
        return {
          payloads: [
            {
              text: JSON.stringify(CONTRADICTION_MEMORY_UPDATE, null, 2),
            },
          ],
        };
      }
      if (prompt.includes("Source Session ID: concurrent-a")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          payloads: [
            {
              text: JSON.stringify(CONCURRENT_MEMORY_UPDATE_A, null, 2),
            },
          ],
        };
      }
      if (prompt.includes("Source Session ID: concurrent-b")) {
        return {
          payloads: [
            {
              text: JSON.stringify(CONCURRENT_MEMORY_UPDATE_B, null, 2),
            },
          ],
        };
      }
      return {
        payloads: [
          {
            text: JSON.stringify(DEFAULT_LONG_TERM_MEMORY_UPDATE, null, 2),
          },
        ],
      };
    }
    return {
      payloads: [
        {
          text:
            typeof prompt === "string" && prompt.includes("无新增记忆测试")
              ? EMPTY_STRUCTURED_SUMMARY
              : typeof prompt === "string" && prompt.includes("HEARTBEAT_NOISE_TEST")
                ? HEARTBEAT_NOISE_STRUCTURED_SUMMARY
                : typeof prompt === "string" && prompt.includes("USER_DEBUG_OPERATIONAL_TEST")
                  ? OPERATIONAL_DEBUG_STRUCTURED_SUMMARY
                  : DEFAULT_STRUCTURED_SUMMARY,
        },
      ],
    };
  }),
}));

let handler: HookHandler;
let captureSessionToMemory: typeof import("./handler.js").captureSessionToMemory;

beforeAll(async () => {
  ({ default: handler, captureSessionToMemory } = await import("./handler.js"));
});

/**
 * Create a mock session JSONL file with various entry types
 */
function createMockSessionContent(
  entries: Array<{ role: string; content: string } | ({ type: string } & Record<string, unknown>)>,
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          type: "message",
          message: {
            role: entry.role,
            content: entry.content,
          },
        });
      }
      // Non-message entry (tool call, system, etc.)
      return JSON.stringify(entry);
    })
    .join("\n");
}

async function runNewWithPreviousSessionEntry(params: {
  tempDir: string;
  previousSessionEntry: { sessionId: string; sessionFile?: string };
  cfg?: OpenClawConfig;
  action?: "new" | "reset";
  commandSource?: string;
  timestamp?: Date;
}): Promise<{
  files: string[];
  memoryContent: string;
  memoryDir: string;
  rootMemoryContent: string;
  rootMemoryPath: string;
}> {
  const event = createHookEvent("command", params.action ?? "new", "agent:main:main", {
    cfg:
      params.cfg ??
      ({
        agents: { defaults: { workspace: params.tempDir } },
      } satisfies OpenClawConfig),
    previousSessionEntry: params.previousSessionEntry,
    ...(params.commandSource ? { commandSource: params.commandSource } : {}),
  });
  event.timestamp = params.timestamp ?? new Date("2026-05-15T04:00:00.000Z");

  await handler(event);

  const memoryDir = path.join(params.tempDir, "memory");
  const rootMemoryPath = path.join(params.tempDir, "MEMORY.md");
  let files: string[] = [];
  let memoryContent = "";
  let rootMemoryContent = "";
  try {
    files = await fs.readdir(memoryDir);
    memoryContent =
      files.length > 0 ? await fs.readFile(path.join(memoryDir, files[0]), "utf-8") : "";
  } catch {
    // Allow callers to assert that no memory file was created.
  }
  try {
    rootMemoryContent = await fs.readFile(rootMemoryPath, "utf-8");
  } catch {
    rootMemoryContent = "";
  }
  return { files, memoryContent, memoryDir, rootMemoryContent, rootMemoryPath };
}

async function runNewWithPreviousSession(params: {
  sessionContent: string;
  cfg?: (tempDir: string) => OpenClawConfig;
  action?: "new" | "reset";
  commandSource?: string;
}): Promise<{
  tempDir: string;
  files: string[];
  memoryContent: string;
  memoryDir: string;
  rootMemoryContent: string;
  rootMemoryPath: string;
}> {
  const tempDir = await makeTempWorkspace("openclaw-session-memory-");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "test-session.jsonl",
    content: params.sessionContent,
  });

  const cfg =
    params.cfg?.(tempDir) ??
    ({
      agents: { defaults: { workspace: tempDir } },
    } satisfies OpenClawConfig);

  const { files, memoryContent, memoryDir, rootMemoryContent, rootMemoryPath } =
    await runNewWithPreviousSessionEntry({
      tempDir,
      cfg,
      action: params.action,
      commandSource: params.commandSource,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });
  return { tempDir, files, memoryContent, memoryDir, rootMemoryContent, rootMemoryPath };
}

function makeSessionMemoryConfig(tempDir: string, messages?: number): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
    ...(typeof messages === "number"
      ? {
          hooks: {
            internal: {
              entries: {
                "session-memory": { enabled: true, messages },
              },
            },
          },
        }
      : {}),
  } satisfies OpenClawConfig;
}

async function createSessionMemoryWorkspace(params?: {
  activeSession?: { name: string; content: string };
}): Promise<{ tempDir: string; sessionsDir: string; activeSessionFile?: string }> {
  const tempDir = await makeTempWorkspace("openclaw-session-memory-");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  if (!params?.activeSession) {
    return { tempDir, sessionsDir };
  }

  const activeSessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: params.activeSession.name,
    content: params.activeSession.content,
  });
  return { tempDir, sessionsDir, activeSessionFile };
}

async function loadMemoryFromActiveSessionPointer(params: {
  tempDir: string;
  activeSessionFile: string;
  action?: "new" | "reset";
}): Promise<string> {
  const { memoryContent } = await runNewWithPreviousSessionEntry({
    tempDir: params.tempDir,
    action: params.action,
    previousSessionEntry: {
      sessionId: "test-123",
      sessionFile: params.activeSessionFile,
    },
  });
  return memoryContent;
}

describe("session-memory hook", () => {
  it("exports reusable structured summary helper for non-command session capture flows", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Discussed release train handoff" },
      { role: "assistant", content: "Captured the daily rollover handoff" },
    ]);
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "daily-rollover.jsonl",
      content: sessionContent,
    });

    const output = await captureSessionToMemory({
      cfg: {
        agents: { defaults: { workspace: tempDir } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      sessionId: "daily-rollover-session",
      sessionFile,
      source: "daily-rollover",
      timestamp: new Date("2026-05-14T00:05:00.000Z"),
    });

    expect(output?.memoryFilePath).toBeTruthy();
    const saved = await fs.readFile(output!.memoryFilePath, "utf-8");
    expect(output?.memoryFilePath.endsWith(path.join("memory", "2026-05-14.md"))).toBe(true);
    expect(saved).toContain("## Daily Structured Summary");
    expect(saved).toContain("**Source**: daily-rollover");
    expect(saved).toContain("### 最终结论");
    expect(saved).toContain("### 已验证有效的方法");
    expect(saved).toContain("### 稳定约束 / 用户偏好 / 重要决策");
    expect(saved).toContain("### 待继续事项");
    expect(saved).toContain("### 稳定失败教训");
  });

  it("skips non-command events", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for non-command events
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("skips commands other than reset", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");

    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for other commands
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("skips structured summary capture on /new command", async () => {
    // Create a mock session file with user/assistant messages
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4" },
    ]);
    const { files, memoryDir } = await runNewWithPreviousSession({
      sessionContent,
      commandSource: "whatsapp",
    });
    expect(files).toEqual([]);
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("creates structured summary in daily note on reset events", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Please reset and keep notes" },
      { role: "assistant", content: "Captured before reset" },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(files).toEqual(["2026-05-15.md"]);
    expect(memoryContent).toContain("## Daily Structured Summary");
    expect(memoryContent).toContain("**Source**: reset");
    expect(memoryContent).toContain("### 最终结论");
    expect(memoryContent).toContain("### 已验证有效的方法");
    expect(memoryContent).toContain("### 稳定约束 / 用户偏好 / 重要决策");
    expect(memoryContent).toContain("### 待继续事项");
    expect(memoryContent).toContain("### 稳定失败教训");
    expect(memoryContent).not.toContain("Please reset and keep notes");
    expect(memoryContent).not.toContain("Captured before reset");
    expect(memoryContent.match(/\*\*Generated At\*\*/g)?.length).toBe(1);
    expect(memoryContent.match(/\*\*Source\*\*/g)?.length).toBe(1);
    expect(memoryContent.match(/\*\*Source Sessions\*\*/g)?.length).toBe(1);
  });

  it("updates MEMORY.md with structured long-term memory while preserving manual notes", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "请把长期偏好也沉淀下来" },
      { role: "assistant", content: "会把 daily rollover 和 MEMORY.md 接起来" },
    ]);
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "# Manual Notes",
        "",
        "- Keep this manual line.",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_remove_me",
        "- Category: goal",
        "- Confidence: 0.91",
        "- Content: 旧目标，后续应删除。",
        "- Created At: 2026-05-14 23:59:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const { rootMemoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
      cfg: {
        agents: {
          defaults: {
            workspace: tempDir,
            userTimezone: "Asia/Shanghai",
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(rootMemoryContent).toContain("# Manual Notes");
    expect(rootMemoryContent).toContain("Keep this manual line.");
    expect(rootMemoryContent).toContain("## OpenClaw Structured Memory");
    expect(rootMemoryContent).toContain("#### Work Context");
    expect(rootMemoryContent).toContain("主要负责 OpenClaw 网关与记忆链路。");
    expect(rootMemoryContent).toContain("#### Top Of Mind");
    expect(rootMemoryContent).toContain("当前重点是把 daily rollover 与 MEMORY.md 打通。");
    expect(rootMemoryContent).toContain("#### Recent Months");
    expect(rootMemoryContent).toContain(
      "最近持续围绕 builtin memory、session rollover 和 Postgres 索引做演进。",
    );
    expect(rootMemoryContent).toContain("偏好使用 PostgreSQL 作为 memory 存储。");
    expect(rootMemoryContent).toContain("负责 OpenClaw gateway 与 memory manager 调试。");
    expect(rootMemoryContent).toContain("当前目标是让 daily rollover 自动沉淀长期记忆。");
    expect(rootMemoryContent).toContain("上次 agent 未确认即删除文件。");
    expect(rootMemoryContent).toContain("直接 rm -rf 未确认");
    expect(rootMemoryContent).not.toContain("旧目标，后续应删除。");
    expect(rootMemoryContent).not.toContain("偶尔接受宽泛表述。");
  });

  it("merges same-category semantic preference facts into one canonical fact", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_python_pref",
        "- Category: preference",
        "- Confidence: 0.84",
        "- Content: Python 优先",
        "- Created At: 2026-05-14 23:59:00 CST",
        "- Updated At: 2026-05-14 23:59:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const sessionContent = createMockSessionContent([
      { role: "user", content: "语义合并测试" },
      { role: "assistant", content: "这轮要把 Python 偏好与 Go 对比收敛成一条" },
    ]);
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const { rootMemoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-merge",
        sessionFile,
      },
      cfg: {
        agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
      } satisfies OpenClawConfig,
    });

    expect(rootMemoryContent).toContain("更偏 Python 而非 Go");
    expect(rootMemoryContent).not.toContain("- Content: Python 优先");
    expect(rootMemoryContent).toContain("新事实表达更完整，但与既有偏好指向同一长期偏好。");
    expect(rootMemoryContent.match(/- Category: preference/g)?.length).toBe(1);
  });

  it("replaces contradicted same-category preference fact with the newer one", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_lang_pref",
        "- Category: preference",
        "- Confidence: 0.80",
        "- Content: 用户主要偏好 Go",
        "- Created At: 2026-05-14 10:00:00 CST",
        "- Updated At: 2026-05-14 10:00:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const sessionContent = createMockSessionContent([
      { role: "user", content: "冲突覆盖测试" },
      { role: "assistant", content: "现在确认用户偏好 Python 而非 Go" },
    ]);
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const { rootMemoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-contradiction",
        sessionFile,
      },
      cfg: {
        agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
      } satisfies OpenClawConfig,
    });

    expect(rootMemoryContent).toContain("用户偏好 Python 而非 Go");
    expect(rootMemoryContent).not.toContain("用户主要偏好 Go");
    expect(rootMemoryContent).toContain("新事实与旧偏好直接冲突，且当前会话给出的偏好更新更明确。");
    expect(rootMemoryContent.match(/- Category: preference/g)?.length).toBe(1);
  });

  it("uses hook-level provider/model overrides for all session-memory LLM runs", async () => {
    const embeddedRunMock = vi.mocked(runEmbeddedPiAgent);
    embeddedRunMock.mockClear();

    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_python_pref",
        "- Category: preference",
        "- Confidence: 0.84",
        "- Content: Python 优先",
        "- Created At: 2026-05-14 23:59:00 CST",
        "- Updated At: 2026-05-14 23:59:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const sessionContent = createMockSessionContent([
      { role: "user", content: "语义合并测试" },
      { role: "assistant", content: "这轮要把 Python 偏好与 Go 对比收敛成一条" },
    ]);
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-llm-overrides",
        sessionFile,
      },
      cfg: {
        agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
        hooks: {
          internal: {
            entries: {
              "session-memory": {
                enabled: true,
                provider: "openai",
                model: "gpt-4.1-mini",
              },
            },
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(embeddedRunMock).toHaveBeenCalledTimes(4);
    for (const [call] of embeddedRunMock.mock.calls) {
      expect(call.provider).toBe("openai");
      expect(call.model).toBe("gpt-4.1-mini");
    }
    const longTermPrompt = embeddedRunMock.mock.calls.find(
      ([call]) =>
        typeof call.prompt === "string" &&
        call.prompt.includes("Latest Structured Summary Markdown:"),
    )?.[0].prompt;
    expect(longTermPrompt).toContain("Latest Structured Summary Markdown:");
    expect(longTermPrompt).not.toContain("Sanitized Transcript:");
  });

  it("uses 30s as the default timeout for session-memory LLM runs", async () => {
    const embeddedRunMock = vi.mocked(runEmbeddedPiAgent);
    embeddedRunMock.mockClear();

    const sessionContent = createMockSessionContent([
      { role: "user", content: "请记录今天的 session-memory 默认超时配置。" },
      { role: "assistant", content: "默认超时应该是 30 秒。" },
    ]);

    await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(embeddedRunMock).toHaveBeenCalledTimes(3);
    for (const [call] of embeddedRunMock.mock.calls) {
      expect(call.timeoutMs).toBe(30_000);
    }
  });

  it("uses hook-level timeout override for all session-memory LLM runs", async () => {
    const embeddedRunMock = vi.mocked(runEmbeddedPiAgent);
    embeddedRunMock.mockClear();

    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_timeout_pref",
        "- Category: preference",
        "- Confidence: 0.84",
        "- Content: 偏好显式配置 session-memory 超时",
        "- Created At: 2026-05-14 23:59:00 CST",
        "- Updated At: 2026-05-14 23:59:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "语义合并测试" },
        { role: "assistant", content: "这轮要确认 timeoutMs 配置传给所有记忆 LLM 调用" },
      ]),
    });

    await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-timeout-override",
        sessionFile,
      },
      cfg: {
        agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
        hooks: {
          internal: {
            entries: {
              "session-memory": {
                enabled: true,
                timeoutMs: 60_000,
              },
            },
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(embeddedRunMock).toHaveBeenCalledTimes(4);
    for (const [call] of embeddedRunMock.mock.calls) {
      expect(call.timeoutMs).toBe(60_000);
    }
  });

  it("uses deepseek/deepseek-v4-pro when session-memory model is configured to that ref", async () => {
    const embeddedRunMock = vi.mocked(runEmbeddedPiAgent);
    embeddedRunMock.mockClear();

    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_python_pref",
        "- Category: preference",
        "- Confidence: 0.84",
        "- Content: Python 优先",
        "- Created At: 2026-05-14 23:59:00 CST",
        "- Updated At: 2026-05-14 23:59:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const sessionContent = createMockSessionContent([
      { role: "user", content: "语义合并测试" },
      { role: "assistant", content: "这轮要确认 deepseek consolidation 配置生效" },
    ]);
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-deepseek-v4-pro",
        sessionFile,
      },
      cfg: {
        agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
        hooks: {
          internal: {
            entries: {
              "session-memory": {
                enabled: true,
                model: "deepseek/deepseek-v4-pro",
              },
            },
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(embeddedRunMock).toHaveBeenCalledTimes(4);
    for (const [call] of embeddedRunMock.mock.calls) {
      expect(call.provider).toBe("deepseek");
      expect(call.model).toBe("deepseek-v4-pro");
    }
  });

  it("preserves unrelated existing facts while applying long-term memory updates", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_unrelated_context",
        "- Category: context",
        "- Confidence: 0.90",
        "- Content: 用户常驻上海办公",
        "- Created At: 2026-05-14 10:00:00 CST",
        "- Updated At: 2026-05-14 10:00:00 CST",
        "- Source: legacy:test-session",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const sessionContent = createMockSessionContent([
      { role: "user", content: "保持无关事实" },
      { role: "assistant", content: "新增别的长期事实，但不能把原有 context 弄丢" },
    ]);
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const { rootMemoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-preserve",
        sessionFile,
      },
      cfg: {
        agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
      } satisfies OpenClawConfig,
    });

    expect(rootMemoryContent).toContain("用户常驻上海办公");
  });

  it("serializes concurrent MEMORY.md updates without dropping long-term facts", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFileA = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "concurrent-a.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "并发记忆 A：请记录第一条长期事实。" },
        { role: "assistant", content: "会写入并发长期事实 A。" },
      ]),
    });
    const sessionFileB = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "concurrent-b.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "并发记忆 B：请记录第二条长期事实。" },
        { role: "assistant", content: "会写入并发长期事实 B。" },
      ]),
    });
    const cfg = {
      agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Shanghai" } },
    } satisfies OpenClawConfig;

    const firstCapture = captureSessionToMemory({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "concurrent-a",
      sessionFile: sessionFileA,
      source: "reset",
      timestamp: new Date("2026-05-15T04:00:00.000Z"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondCapture = captureSessionToMemory({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "concurrent-b",
      sessionFile: sessionFileB,
      source: "reset",
      timestamp: new Date("2026-05-15T04:00:01.000Z"),
    });

    const [firstResult, secondResult] = await Promise.all([firstCapture, secondCapture]);

    expect(firstResult?.status).toBe("written");
    expect(secondResult?.status).toBe("written");
    const rootMemoryContent = await fs.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    expect(rootMemoryContent).toContain("并发长期事实 A");
    expect(rootMemoryContent).toContain("并发长期事实 B");
  });

  it("appends export-file handoff summary even when assistant text has no researcher label", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "整理成文件" },
      {
        role: "assistant",
        content: [
          "已完成导出。",
          "",
          "<SUBAGENT_HANDOFF>",
          JSON.stringify({
            mode: "export-file",
            summary: "已输出研究草案。",
            export: {
              path: "artifacts/exports/feishu/test/no-header-report.md",
              title: "研究草案",
            },
          }),
          "</SUBAGENT_HANDOFF>",
        ].join("\n"),
      },
    ]);
    const { memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(memoryContent).toContain("### Researcher 产物");
    expect(memoryContent).toContain("`artifacts/exports/feishu/test/no-header-report.md`");
    expect(memoryContent).toContain("已输出研究草案。");
    expect(memoryContent).not.toContain("<SUBAGENT_HANDOFF>");
  });

  it("falls back to latest .jsonl.reset.* transcript when active file is empty", async () => {
    const { tempDir, sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: { name: "test-session.jsonl", content: "" },
    });

    // Simulate /new rotation where useful content is now in .reset.* file
    const resetContent = createMockSessionContent([
      { role: "user", content: "Message from rotated transcript" },
      { role: "assistant", content: "Recovered from reset fallback" },
    ]);
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
      content: resetContent,
    });

    const { memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile: activeSessionFile!,
      },
    });

    expect(memoryContent).toContain("## Daily Structured Summary");
  });

  it("handles reset-path session pointers from previousSessionEntry", async () => {
    const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "reset-pointer-session";
    const resetSessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
      content: createMockSessionContent([
        { role: "user", content: "Message from reset pointer" },
        { role: "assistant", content: "Recovered directly from reset file" },
      ]),
    });

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: makeSessionMemoryConfig(tempDir),
      action: "reset",
      previousSessionEntry: {
        sessionId,
        sessionFile: resetSessionFile,
      },
    });
    expect(files.length).toBe(1);
    expect(memoryContent).toContain("## Daily Structured Summary");
  });

  it("does not recover an unrelated transcript when the target reset-path session is absent", async () => {
    const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();
    const targetSessionId = "absent-reset-pointer-session";
    const resetSessionFile = path.join(
      sessionsDir,
      `${targetSessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
    );

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "unrelated-session.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "Unrelated private preference" },
        { role: "assistant", content: "This belongs to another conversation" },
      ]),
    });

    vi.mocked(runEmbeddedPiAgent).mockClear();

    const output = await captureSessionToMemory({
      cfg: makeSessionMemoryConfig(tempDir),
      sessionKey: "agent:main:main",
      sessionId: targetSessionId,
      sessionFile: resetSessionFile,
      source: "daily-rollover",
      timestamp: new Date("2026-05-15T04:00:00.000Z"),
    });

    expect(output?.status).toBe("skipped-missing-source");
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    const files = await fs.readdir(path.join(tempDir, "memory")).catch(() => []);
    expect(files).toEqual([]);
  });

  it("recovers transcript when previousSessionEntry.sessionFile is missing", async () => {
    const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "missing-session-file";
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl`,
      content: "",
    });
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
      content: createMockSessionContent([
        { role: "user", content: "Recovered with missing sessionFile pointer" },
        { role: "assistant", content: "Recovered by sessionId fallback" },
      ]),
    });

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: makeSessionMemoryConfig(tempDir),
      action: "reset",
      previousSessionEntry: {
        sessionId,
      },
    });
    expect(files.length).toBe(1);
    expect(memoryContent).toContain("## Daily Structured Summary");
  });

  it("does not summarize another transcript when the target reset transcript is absent", async () => {
    const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "other-session-a.jsonl",
      content: createMockSessionContent([{ role: "user", content: "Wrong transcript A" }]),
    });
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "other-session-b.jsonl",
      content: createMockSessionContent([{ role: "user", content: "Wrong transcript B" }]),
    });

    const { files } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: makeSessionMemoryConfig(tempDir),
      action: "reset",
      previousSessionEntry: {
        sessionId: "missing-target-session",
        sessionFile: path.join(
          sessionsDir,
          "missing-target-session.jsonl.reset.2026-02-16T22-26-33.000Z",
        ),
      },
    });

    expect(files).toEqual([]);
  });

  it("prefers the newest reset transcript when multiple reset candidates exist", async () => {
    const { tempDir, sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: { name: "test-session.jsonl", content: "" },
    });

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Older rotated transcript" },
        { role: "assistant", content: "Old summary" },
      ]),
    });
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-34.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Newest rotated transcript" },
        { role: "assistant", content: "Newest summary" },
      ]),
    });

    const memoryContent = await loadMemoryFromActiveSessionPointer({
      tempDir,
      activeSessionFile: activeSessionFile!,
      action: "reset",
    });

    expect(memoryContent).toContain("## Daily Structured Summary");
    expect(memoryContent).not.toContain("Older rotated transcript");
  });

  it("prefers active transcript when it is non-empty even with reset candidates", async () => {
    const { tempDir, sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: {
        name: "test-session.jsonl",
        content: createMockSessionContent([
          { role: "user", content: "Active transcript message" },
          { role: "assistant", content: "Active transcript summary" },
        ]),
      },
    });

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-34.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Reset fallback message" },
        { role: "assistant", content: "Reset fallback summary" },
      ]),
    });

    const memoryContent = await loadMemoryFromActiveSessionPointer({
      tempDir,
      activeSessionFile: activeSessionFile!,
      action: "reset",
    });

    expect(memoryContent).toContain("## Daily Structured Summary");
    expect(memoryContent).not.toContain("Reset fallback message");
  });

  it("handles empty session files gracefully", async () => {
    // Should not throw
    const { files } = await runNewWithPreviousSession({ sessionContent: "", action: "reset" });
    expect(files).toEqual([]);
  });

  it("does not write a daily note when structured summary has no reliable additions", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "无新增记忆测试：只是普通寒暄。" },
      { role: "assistant", content: "没有形成可靠新增记忆。" },
    ]);

    const { files, rootMemoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(files).toEqual([]);
    expect(rootMemoryContent).toBe("");
  });

  it("does not write a daily note for heartbeat-only transport noise", async () => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
    const sessionContent = createMockSessionContent([
      { role: "user", content: "HEARTBEAT_NOISE_TEST 例行心跳检查。" },
      { role: "assistant", content: "Connection error after retries." },
    ]);

    const { files, rootMemoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(files).toEqual([]);
    expect(rootMemoryContent).toBe("");
    expect(
      vi
        .mocked(runEmbeddedPiAgent)
        .mock.calls.some(([arg]) =>
          String((arg as { prompt?: string }).prompt).includes(
            "Decide whether to write the daily structured memory summary",
          ),
        ),
    ).toBe(true);
  });

  it("writes a daily note when the judge model accepts explicit operational debugging", async () => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
    const sessionContent = createMockSessionContent([
      { role: "user", content: "USER_DEBUG_OPERATIONAL_TEST 请排查 Connection error。" },
      { role: "assistant", content: "将连接错误排查作为当前任务。" },
    ]);

    const { files, memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(files).toEqual(["2026-05-15.md"]);
    expect(memoryContent).toContain("用户明确要求排查 Connection error");
    expect(
      vi
        .mocked(runEmbeddedPiAgent)
        .mock.calls.some(([arg]) =>
          String((arg as { prompt?: string }).prompt).includes(
            "Decide whether to write the daily structured memory summary",
          ),
        ),
    ).toBe(true);
  });

  it("appends a new summary block instead of overwriting daily note", async () => {
    // Only 2 messages but requesting 15 (default)
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", "2026-05-15.md"),
      "# Existing note\n\n- Keep this.\n",
      "utf-8",
    );
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Only message 1" },
      { role: "assistant", content: "Only message 2" },
    ]);
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const { memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      action: "reset",
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
      cfg: {
        agents: {
          defaults: {
            workspace: tempDir,
            userTimezone: "Asia/Shanghai",
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(memoryContent).toContain("# Existing note");
    expect(memoryContent).toContain("## Daily Structured Summary");
    expect(memoryContent.match(/## Daily Structured Summary/g)?.length).toBe(1);
  });
});
