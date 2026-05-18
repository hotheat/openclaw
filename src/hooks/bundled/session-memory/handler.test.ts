import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

// Avoid calling the embedded Pi agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

vi.mock("../../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(async () => ({
    payloads: [
      {
        text: [
          "## Daily Structured Summary",
          "",
          "- **Generated At**: 2026-05-15 04:00 CST",
          "- **Source**: reset",
          "- **Source Sessions**: test-123",
          "",
          "### 用户偏好",
          "- 偏好精确结论。",
          "",
          "### 自定义需求",
          "- 输出中文。",
          "",
          "### 失败经验 / 反模式",
          "- 避免模糊剂量。",
          "",
          "### 重要决策",
          "- 仅采官方来源。",
          "",
          "### 未完成事项",
          "- 继续核对 Roche 财报。",
          "",
          "### 风险 / 注意点",
          "- 未披露剂量不得推断。",
        ].join("\n"),
      },
    ],
  })),
}));

let handler: HookHandler;
let captureSessionToMemory: typeof import("./handler.js").captureSessionToMemory;

beforeAll(async () => {
  ({ default: handler, captureSessionToMemory } = await import("./handler.js"));
});

beforeEach(() => {
  vi.mocked(runEmbeddedPiAgent).mockClear();
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
  timestamp?: Date;
}): Promise<{ files: string[]; memoryContent: string; memoryDir: string }> {
  const event = createHookEvent("command", params.action ?? "new", "agent:main:main", {
    cfg:
      params.cfg ??
      ({
        agents: { defaults: { workspace: params.tempDir } },
      } satisfies OpenClawConfig),
    previousSessionEntry: params.previousSessionEntry,
  });
  event.timestamp = params.timestamp ?? new Date("2026-05-15T04:00:00.000Z");

  await handler(event);

  const memoryDir = path.join(params.tempDir, "memory");
  let files: string[] = [];
  let memoryContent = "";
  try {
    files = await fs.readdir(memoryDir);
    memoryContent =
      files.length > 0 ? await fs.readFile(path.join(memoryDir, files[0]), "utf-8") : "";
  } catch {
    // Allow callers to assert that no memory file was created.
  }
  return { files, memoryContent, memoryDir };
}

async function runNewWithPreviousSession(params: {
  sessionContent: string;
  cfg?: (tempDir: string) => OpenClawConfig;
  action?: "new" | "reset";
}): Promise<{ tempDir: string; files: string[]; memoryContent: string; memoryDir: string }> {
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

  const { files, memoryContent, memoryDir } = await runNewWithPreviousSessionEntry({
    tempDir,
    cfg,
    action: params.action,
    previousSessionEntry: {
      sessionId: "test-123",
      sessionFile,
    },
  });
  return { tempDir, files, memoryContent, memoryDir };
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
    expect(saved).toContain("### 用户偏好");
  });

  it("preserves all blocks when multiple captures append to the same daily file concurrently", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Capture this conversation" },
      { role: "assistant", content: "Structured summary incoming" },
    ]);
    const tempDir = await makeTempWorkspace("openclaw-session-memory-concurrent-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "shared-session.jsonl",
      content: sessionContent,
    });
    const timestamp = new Date("2026-05-14T00:05:00.000Z");
    const memoryFilePath = path.join(tempDir, "memory", "2026-05-14.md");
    const originalWriteFile = fs.writeFile.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      const writeTarget =
        typeof file === "string"
          ? file
          : Buffer.isBuffer(file)
            ? file.toString("utf-8")
            : file instanceof URL
              ? file.pathname
              : null;
      if (writeTarget === memoryFilePath) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await originalWriteFile(file, data, options);
    });

    try {
      await Promise.all([
        captureSessionToMemory({
          cfg: {
            agents: { defaults: { workspace: tempDir } },
          } satisfies OpenClawConfig,
          sessionKey: "agent:main:main",
          sessionId: "daily-rollover-a",
          sessionFile,
          source: "daily-rollover",
          timestamp,
        }),
        captureSessionToMemory({
          cfg: {
            agents: { defaults: { workspace: tempDir } },
          } satisfies OpenClawConfig,
          sessionKey: "agent:main:main",
          sessionId: "daily-rollover-b",
          sessionFile,
          source: "reset",
          timestamp,
        }),
      ]);
    } finally {
      writeSpy.mockRestore();
    }

    const saved = await fs.readFile(memoryFilePath, "utf-8");
    expect(saved.match(/^## Daily Structured Summary$/gm)).toHaveLength(2);
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

  it("does not create memory file on /new command", async () => {
    // Create a mock session file with user/assistant messages
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4" },
    ]);
    const { files, memoryDir } = await runNewWithPreviousSession({ sessionContent });
    expect(files.length).toBe(0);
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("creates structured summary in daily note on /reset command", async () => {
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
    expect(memoryContent).toContain("### 用户偏好");
    expect(memoryContent).not.toContain("Please reset and keep notes");
    expect(memoryContent).not.toContain("Captured before reset");
    expect(memoryContent.match(/\*\*Generated At\*\*/g)?.length).toBe(1);
    expect(memoryContent.match(/\*\*Source\*\*/g)?.length).toBe(1);
    expect(memoryContent.match(/\*\*Source Sessions\*\*/g)?.length).toBe(1);
  });

  it("uses configured session-memory model for structured summary generation", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Please keep this preference" },
      { role: "assistant", content: "Preference captured" },
    ]);
    const configuredModel = "deepseek/deepseek-v4-pro";

    await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
      cfg: (tempDir) =>
        ({
          agents: { defaults: { workspace: tempDir } },
          hooks: {
            internal: {
              entries: {
                "session-memory": {
                  enabled: true,
                  model: configuredModel,
                },
              },
            },
          },
        }) satisfies OpenClawConfig,
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
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

  it("skips writing memory when the structured summary has no reliable additions", async () => {
    const { files } = await runNewWithPreviousSession({ sessionContent: "", action: "reset" });
    expect(files.length).toBe(0);
  });

  it("skips writing memory when the model summary has only empty sections", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
      payloads: [
        {
          text: [
            "## Daily Structured Summary",
            "",
            "- **Generated At**: 2026-05-15 04:00 CST",
            "- **Source**: reset",
            "- **Source Sessions**: test-123",
            "",
            "### 用户偏好",
            "- 无可靠新增项。",
            "",
            "### 自定义需求",
            "- 无可靠新增项。",
            "",
            "### 失败经验 / 反模式",
            "- 无可靠新增项。",
            "",
            "### 重要决策",
            "- 无可靠新增项。",
            "",
            "### 未完成事项",
            "- 无可靠新增项。",
            "",
            "### 风险 / 注意点",
            "- 无可靠新增项。",
          ].join("\n"),
        },
      ],
    } as Awaited<ReturnType<typeof runEmbeddedPiAgent>>);

    const sessionContent = createMockSessionContent([
      { role: "user", content: "闲聊，没有需要沉淀的信息" },
      { role: "assistant", content: "收到。" },
    ]);
    const { files } = await runNewWithPreviousSession({ sessionContent, action: "reset" });
    expect(files.length).toBe(0);
  });

  it("writes memory when researcher export is the only reliable addition", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "assistant",
        content: [
          "<SUBAGENT_HANDOFF>",
          JSON.stringify({
            mode: "export-file",
            summary: "已输出研究草案。",
            export: {
              path: "artifacts/exports/feishu/test/report.md",
              title: "研究草案",
            },
          }),
          "</SUBAGENT_HANDOFF>",
        ].join("\n"),
      },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });
    expect(files.length).toBe(1);
    expect(memoryContent).toContain("### Researcher 产物");
    expect(memoryContent).toContain("`artifacts/exports/feishu/test/report.md`");
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
