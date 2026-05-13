import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const noop = () => {};
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const announceSpy = vi.fn(async (_params: unknown) => true);

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((_handler: unknown) => noop),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
    })),
  };
});

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry transcript fallback", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    callGatewayMock.mockReset().mockImplementation(async (_request: unknown) => ({}));
    announceSpy.mockReset().mockResolvedValue(true);
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  function mockTimedOutAgentWaitWithFakeClock() {
    return async (request: unknown) => {
      const typed = request as { method?: string; params?: { timeoutMs?: unknown } };
      if (typed.method !== "agent.wait") {
        return undefined;
      }
      const timeoutMs =
        typeof typed.params?.timeoutMs === "number" && Number.isFinite(typed.params.timeoutMs)
          ? typed.params.timeoutMs
          : 0;
      if (timeoutMs > 0) {
        vi.setSystemTime(Date.now() + timeoutMs);
      }
      return { status: "timeout", startedAt: 1000 };
    };
  }

  it("completes early from transcript error when agent.wait keeps timing out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T01:43:40.000Z"));

    callGatewayMock.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string };
      const waitResult = await mockTimedOutAgentWaitWithFakeClock()(request);
      if (waitResult) {
        return waitResult;
      }
      if (typed.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "terminated",
              timestamp: "2026-05-12T01:43:04.410Z",
            },
            {
              role: "toolResult",
              content: [{ type: "text", text: "late tool result" }],
              timestamp: "2026-05-12T01:43:14.657Z",
            },
          ],
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-terminated",
      childSessionKey: "agent:researcher:subagent:dead-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "research task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);

    const agentWaitCallsBeforeStabilize = callGatewayMock.mock.calls.filter(
      ([request]) => (request as { method?: string }).method === "agent.wait",
    );
    expect(agentWaitCallsBeforeStabilize.length).toBeLessThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(15_000);

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-terminated");
    expect(run?.outcome).toEqual({ status: "error", error: "terminated" });
    expect(run?.endedAt).toBeDefined();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as {
      childRunId?: string;
      waitForCompletion?: boolean;
      outcome?: { status?: string; error?: string };
    };
    expect(announce.childRunId).toBe("run-terminated");
    expect(announce.waitForCompletion).toBe(false);
    expect(announce.outcome).toEqual({ status: "error", error: "terminated" });
  });

  it("treats assistant error text as terminal when error metadata is also present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T01:43:40.000Z"));

    callGatewayMock.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string };
      const waitResult = await mockTimedOutAgentWaitWithFakeClock()(request);
      if (waitResult) {
        return waitResult;
      }
      if (typed.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "terminated" }],
              stopReason: "error",
              errorMessage: "terminated",
              timestamp: "2026-05-12T01:43:04.410Z",
            },
            {
              role: "toolResult",
              content: [{ type: "text", text: "late tool result" }],
              timestamp: "2026-05-12T01:43:14.657Z",
            },
          ],
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-terminated-with-text",
      childSessionKey: "agent:researcher:subagent:dead-child-with-text",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "research task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(15_000);

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-terminated-with-text");
    expect(run?.outcome).toEqual({ status: "error", error: "terminated" });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as {
      childRunId?: string;
      outcome?: { status?: string; error?: string };
    };
    expect(announce.childRunId).toBe("run-terminated-with-text");
    expect(announce.outcome).toEqual({ status: "error", error: "terminated" });
  });

  it("accepts numeric transcript timestamps for terminal error fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T01:43:40.000Z"));

    const assistantTimestampMs = Date.parse("2026-05-12T01:43:04.410Z");
    const toolResultTimestampMs = Date.parse("2026-05-12T01:43:14.657Z");

    callGatewayMock.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string };
      const waitResult = await mockTimedOutAgentWaitWithFakeClock()(request);
      if (waitResult) {
        return waitResult;
      }
      if (typed.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "terminated",
              timestamp: assistantTimestampMs,
            },
            {
              role: "toolResult",
              content: [{ type: "text", text: "late tool result" }],
              timestamp: toolResultTimestampMs,
            },
          ],
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-terminated-numeric-ts",
      childSessionKey: "agent:researcher:subagent:dead-child-numeric-ts",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "research task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(15_000);

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-terminated-numeric-ts");
    expect(run?.outcome).toEqual({ status: "error", error: "terminated" });
    expect(run?.endedAt).toBe(assistantTimestampMs);

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as {
      childRunId?: string;
      outcome?: { status?: string; error?: string };
      endedAt?: number;
    };
    expect(announce.childRunId).toBe("run-terminated-numeric-ts");
    expect(announce.outcome).toEqual({ status: "error", error: "terminated" });
    expect(announce.endedAt).toBe(assistantTimestampMs);
  });
});
