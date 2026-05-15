import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.hoisted(() => vi.fn());

const noop = () => {};

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

beforeEach(() => {
  callGatewayMock.mockReset();
  callGatewayMock.mockImplementation(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
      return { status: "pending" };
    }
    return {};
  });
});

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
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry archive behavior", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("does not set archiveAtMs for persistent session-mode runs", () => {
    mod.registerSubagentRun({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-session-1");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("keeps archiveAtMs unset when replacing a session-mode run after steer restart", () => {
    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-new");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("does not finalize completion on the first agent.wait timeout before the overall deadline", async () => {
    vi.useFakeTimers();
    callGatewayMock.mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });

    try {
      mod.registerSubagentRun({
        runId: "run-timeout-window",
        childSessionKey: "agent:main:subagent:timeout-window",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "long-running-task",
        cleanup: "keep",
        runTimeoutSeconds: 1,
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(900);

      const beforeDeadline = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-window");
      expect(beforeDeadline?.endedAt).toBeUndefined();
      expect(beforeDeadline?.cleanupCompletedAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(200);

      const afterDeadline = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-window");
      expect(afterDeadline?.outcome).toEqual({ status: "timeout" });
      expect(afterDeadline?.endedAt).toBeTypeOf("number");
    } finally {
      vi.useRealTimers();
    }
  });
});
