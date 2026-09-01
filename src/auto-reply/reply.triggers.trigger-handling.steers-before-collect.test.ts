import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../agents/pi-embedded-runner/runs.js";
import {
  getIsEmbeddedPiRunActiveMock,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  requireSessionStorePath,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";
import { clearFollowupQueue, getFollowupQueueDepth } from "./reply/queue.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
let previousFastTestEnv: string | undefined;

beforeAll(async () => {
  previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  ({ getReplyFromConfig } = await import("./reply.js"));
});

afterAll(() => {
  if (previousFastTestEnv === undefined) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("steers an active run before collect queue handling", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      cfg.commands = { text: true };
      cfg.messages = {
        ...cfg.messages,
        queue: { mode: "collect", debounceMs: 0 },
      };
      const sessionKey = "agent:main:feishu:direct:ou_user";
      const sessionId = "feishu-session";
      await fs.writeFile(
        requireSessionStorePath(cfg),
        JSON.stringify({
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
            channel: "feishu",
            chatType: "direct",
          },
        }),
      );

      const queueMessage = vi.fn(() => true);
      const handle = {
        runId: "current-run",
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
      const body = "/steer Keep APIName\n- 检查 timer.ts\n- 保留现有结论";
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      getIsEmbeddedPiRunActiveMock().mockReturnValue(true);

      try {
        const result = await getReplyFromConfig(
          {
            Body: body,
            RawBody: body,
            CommandBody: body,
            From: "ou_user",
            To: "feishu:bot",
            ChatType: "direct",
            Provider: "feishu",
            Surface: "feishu",
            SessionKey: sessionKey,
            CommandAuthorized: true,
          },
          {},
          cfg,
        );

        const text = Array.isArray(result) ? result[0]?.text : result?.text;
        expect(text).toBe("已注入当前运行。");
        expect(queueMessage).toHaveBeenCalledWith("Keep APIName\n- 检查 timer.ts\n- 保留现有结论");
        expect(getFollowupQueueDepth(sessionKey)).toBe(0);
        expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
      } finally {
        getIsEmbeddedPiRunActiveMock().mockReturnValue(false);
        clearFollowupQueue(sessionKey);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });
});
