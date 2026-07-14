import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  findGatewayRequest,
  getCallGatewayMock,
  getGatewayMethods,
  getSessionsSpawnTool,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import { createTaskFlowStore } from "./taskflow/store.js";
import { runWithAgentTraceRun } from "./tracing/context.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
      requester?: { channel?: string };
    };
    if (!input.threadRequested) {
      return undefined;
    }
    const channel = input.requester?.channel?.trim().toLowerCase();
    if (channel !== "discord") {
      const channelLabel = input.requester?.channel?.trim() || "unknown";
      return {
        status: "error" as const,
        error: `thread=true is not supported for channel "${channelLabel}". Only Discord thread-bound subagent sessions are supported right now.`,
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) =>
      hookName === "subagent_spawning" ||
      hookName === "subagent_spawned" ||
      (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
    runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
    runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
    runSubagentEnded: hookRunnerMocks.runSubagentEnded,
  })),
}));

function expectSessionsDeleteWithoutAgentStart() {
  const methods = getGatewayMethods();
  expect(methods).toContain("sessions.delete");
  expect(methods).not.toContain("agent");
}

function mockAgentStartFailure() {
  const callGatewayMock = getCallGatewayMock();
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      throw new Error("spawn failed");
    }
    return {};
  });
}

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    const callGatewayMock = getCallGatewayMock();
    callGatewayMock.mockClear();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-1", status: "running" };
      }
      return {};
    });
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("runs subagent_spawning and emits subagent_spawned with requester metadata", async () => {
    const recordSubagentLifecycle = vi.fn();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: 456,
    });

    const result = await runWithAgentTraceRun({ recordSubagentLifecycle }, async () => {
      return await tool.execute("call", {
        task: "do thing",
        label: "research",
        runTimeoutSeconds: 1,
        thread: true,
      });
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledWith(
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        agentId: "main",
        label: "research",
        mode: "session",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
          threadId: 456,
        },
        threadRequested: true,
      },
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        requesterSessionKey: "main",
      },
    );

    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event, ctx] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      runId: "run-1",
      agentId: "main",
      label: "research",
      mode: "session",
      requester: {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      threadRequested: true,
    });
    expect(event.childSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
    expect(ctx).toMatchObject({
      runId: "run-1",
      requesterSessionKey: "main",
      childSessionKey: event.childSessionKey,
    });
    expect(recordSubagentLifecycle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "spawning",
        childSessionKey: event.childSessionKey,
        requesterSessionKey: "main",
        agentId: "main",
        label: "research",
        mode: "session",
      }),
    );
    expect(recordSubagentLifecycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "spawned",
        runId: "run-1",
        childSessionKey: event.childSessionKey,
        requesterSessionKey: "main",
        agentId: "main",
        label: "research",
        mode: "session",
      }),
    );
  });

  it("emits subagent_spawned with threadRequested=false when not requested", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call2", {
      task: "do thing",
      runTimeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: false,
      requester: {
        channel: "discord",
        to: "channel:123",
      },
    });
  });

  it("respects explicit mode=run when thread binding is requested", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call3", {
      task: "do thing",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "run",
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1", mode: "run" });
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: true,
    });
  });

  it("returns error when thread binding cannot be created", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "error",
      error: "Unable to create or bind a Discord thread for this subagent session.",
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call4", {
      task: "do thing",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string; childSessionKey?: string };
    expect(details.error).toMatch(/thread/i);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: details.childSessionKey,
      emitLifecycleHooks: false,
    });
  });

  it("returns error when thread binding is not marked ready", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "ok",
      threadBindingReady: false,
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call4b", {
      task: "do thing",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string; childSessionKey?: string };
    expect(details.error).toMatch(/unable to create or bind a thread/i);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: details.childSessionKey,
      emitLifecycleHooks: false,
    });
  });

  it("rejects mode=session when thread=true is not requested", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call6", {
      task: "do thing",
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string };
    expect(details.error).toMatch(/requires thread=true/i);
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    const callGatewayMock = getCallGatewayMock();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects thread=true on channels without thread support", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "signal",
      agentTo: "+123",
    });

    const result = await tool.execute("call5", {
      task: "do thing",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string };
    expect(details.error).toMatch(/only discord/i);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
  });

  it("runs subagent_ended cleanup hook when agent start fails after successful bind", async () => {
    mockAgentStartFailure();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call7", {
      task: "do thing",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentEnded.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      targetSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      accountId: "work",
      targetKind: "subagent",
      reason: "spawn-failed",
      sendFarewell: true,
      outcome: "error",
      error: "Session failed to start",
    });
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: event.targetSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });

  it("emits terminal trace lifecycle when non-thread agent start fails", async () => {
    const recordSubagentLifecycle = vi.fn();
    mockAgentStartFailure();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await runWithAgentTraceRun({ recordSubagentLifecycle }, async () => {
      return await tool.execute("call7b", {
        task: "do thing",
        runTimeoutSeconds: 1,
      });
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { childSessionKey?: string; runId?: string };
    expect(recordSubagentLifecycle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "spawning",
        childSessionKey: details.childSessionKey,
        requesterSessionKey: "main",
        agentId: "main",
        mode: "run",
      }),
    );
    expect(recordSubagentLifecycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "ended",
        runId: details.runId,
        childSessionKey: details.childSessionKey,
        requesterSessionKey: "main",
        mode: "run",
        outcome: "error",
        error: "Session failed to start",
      }),
    );
  });

  it("falls back to sessions.delete cleanup when subagent_ended hook is unavailable", async () => {
    hookRunnerMocks.hasSubagentEndedHook = false;
    mockAgentStartFailure();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call8", {
      task: "do thing",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  });
});

describe("sessions_spawn shared TaskFlow grants", () => {
  let tempDir: string;
  const ownerSessionKey = "main";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-taskflow-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    resetSubagentRegistryForTests();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
    const callGatewayMock = getCallGatewayMock();
    callGatewayMock.mockClear();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-1", status: "running" };
      }
      return {};
    });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeOwnerStore() {
    return createTaskFlowStore({
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      stateDir: tempDir,
      idFactory: () => "tf_shared",
    });
  }

  it("rolls back the shared grant when the child agent fails to start", async () => {
    const store = makeOwnerStore();
    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey,
      scope: "shared",
      title: "Shared",
      items: [{ id: "item_a", title: "A", assigneeAgentId: "main" }],
    });
    expect(created.status).toBe("success");

    mockAgentStartFailure();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });
    const result = await tool.execute("tf-fail", {
      task: "do thing",
      runTimeoutSeconds: 1,
      taskFlowId: "tf_shared",
      taskFlowScope: "shared",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { childSessionKey?: string };
    expect(details.childSessionKey).toBeTruthy();

    const read = await store.readTaskFlow({
      taskFlowId: "tf_shared",
      agentId: "main",
      sessionKey: ownerSessionKey,
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    const permission = read.snapshot.permissions.find(
      (candidate) => candidate.sessionKey === details.childSessionKey,
    );
    expect(permission).toBeDefined();
    expect(permission?.revokedReason).toBe("subagent_ended");
    expect(typeof permission?.revokedAt).toBe("string");
  });

  it("does not auto-track persistent session-mode children", async () => {
    const store = makeOwnerStore();
    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey,
      title: "Local",
      items: [{ id: "item_a", title: "A", status: "in_progress" }],
    });
    expect(created.status).toBe("success");

    const tool = await getSessionsSpawnTool({
      agentSessionKey: ownerSessionKey,
      agentChannel: "discord",
      agentTo: "channel:123",
    });
    const result = await tool.execute("tf-session", {
      task: "stay available",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const runs = listSubagentRunsForRequester(ownerSessionKey);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trackingTaskFlowId).toBeUndefined();
  });

  it("applies a TTL to run-mode grants and records taskFlowId on the run", async () => {
    const store = makeOwnerStore();
    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey,
      scope: "shared",
      title: "Shared",
      items: [{ id: "item_a", title: "A", assigneeAgentId: "main" }],
    });
    expect(created.status).toBe("success");

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });
    const result = await tool.execute("tf-ok", {
      task: "do thing",
      runTimeoutSeconds: 60,
      taskFlowId: "tf_shared",
      taskFlowScope: "shared",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const details = result.details as { childSessionKey?: string };

    const read = await store.readTaskFlow({
      taskFlowId: "tf_shared",
      agentId: "main",
      sessionKey: ownerSessionKey,
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    const permission = read.snapshot.permissions.find(
      (candidate) => candidate.sessionKey === details.childSessionKey,
    );
    expect(permission?.access).toBe("write_assigned");
    expect(typeof permission?.expiresAt).toBe("string");
    expect(Date.parse(permission?.expiresAt ?? "")).toBeGreaterThan(Date.now() + 60_000);

    const runs = listSubagentRunsForRequester("main");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.taskFlowId).toBe("tf_shared");
  });

  it("cleans up the provisional session when the shared grant fails", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });
    const result = await tool.execute("tf-grant-fail", {
      task: "do thing",
      runTimeoutSeconds: 1,
      taskFlowId: "tf_missing",
      taskFlowScope: "shared",
    });

    expect(result.details).toMatchObject({ status: "error" });
    expectSessionsDeleteWithoutAgentStart();
  });
});
