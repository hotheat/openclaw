import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/config.js";
import type { captureSessionToMemory as captureSessionToMemoryType } from "../src/hooks/bundled/session-memory/handler.js";

const { runEmbeddedPiAgentMock } = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(async () => ({
    payloads: [
      {
        text: [
          "### 最终结论",
          "- 已记录用户对结构化总结的偏好。",
          "",
          "### 稳定约束 / 用户偏好 / 重要决策",
          "- 偏好结构化总结。",
          "- 使用配置模型。",
        ].join("\n"),
      },
    ],
  })),
}));

const tempDirs: string[] = [];
let captureSessionToMemory: typeof captureSessionToMemoryType;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-e2e-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSessionFile(workspaceDir: string): Promise<string> {
  const sessionsDir = path.join(workspaceDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "configured-model-session.jsonl");
  const content = [
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "请记住我偏好结构化总结" },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: "已记录" },
    }),
  ].join("\n");
  await fs.writeFile(sessionFile, content, "utf-8");
  return sessionFile;
}

describe("session-memory configured model e2e", () => {
  beforeEach(async () => {
    vi.resetModules();
    runEmbeddedPiAgentMock.mockClear();
    vi.doMock("../src/agents/pi-embedded.js", () => ({
      runEmbeddedPiAgent: runEmbeddedPiAgentMock,
    }));
    ({ captureSessionToMemory } = await import("../src/hooks/bundled/session-memory/handler.js"));
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("uses hooks.internal.entries.session-memory.model for structured summaries", async () => {
    const workspaceDir = await makeTempDir();
    const sessionFile = await writeSessionFile(workspaceDir);
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "micu/gpt-5.4",
          },
        },
      },
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "session-memory": {
              enabled: true,
              model: "deepseek/deepseek-v4-pro",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await captureSessionToMemory({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "configured-model-session",
      sessionFile,
      source: "e2e",
      timestamp: new Date("2026-05-18T10:00:00.000Z"),
    });

    expect(result?.status).toBe("written");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });
});
