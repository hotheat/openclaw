import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { recordSubagentLifecycleTraceEvent, runWithAgentTraceRun } from "./tracing/context.js";

const lifecycleMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => lifecycleMocks.getGlobalHookRunner(),
}));

import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";

function createRunEntry(): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "task",
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

describe("emitSubagentEndedHookOnce", () => {
  const createEmitParams = (
    overrides?: Partial<Parameters<typeof emitSubagentEndedHookOnce>[0]>,
  ) => {
    const entry = overrides?.entry ?? createRunEntry();
    return {
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: "acct-1",
      inFlightRunIds: new Set<string>(),
      persist: vi.fn(),
      ...overrides,
    };
  };

  beforeEach(() => {
    lifecycleMocks.getGlobalHookRunner.mockClear();
    lifecycleMocks.runSubagentEnded.mockClear();
  });

  it("records ended hook marker even when no subagent_ended hooks are registered", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => false,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams();
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
    expect(params.persist).toHaveBeenCalledTimes(1);
  });

  it("runs subagent_ended hooks when available", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams();
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
    expect(params.persist).toHaveBeenCalledTimes(1);
  });

  it("records subagent ended lifecycle on the registered trace run", async () => {
    const recordSubagentLifecycle = vi.fn();
    await runWithAgentTraceRun({ recordSubagentLifecycle }, async () => {
      await recordSubagentLifecycleTraceEvent({
        phase: "spawned",
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child-1",
        requesterSessionKey: "agent:main:main",
      });
    });
    recordSubagentLifecycle.mockClear();
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => false,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams({
      outcome: "ok",
    });
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(recordSubagentLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "ended",
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child-1",
        requesterSessionKey: "agent:main:main",
        outcome: "ok",
      }),
    );
  });

  it("revokes shared TaskFlow access when the run carries a taskFlowId", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const revokeTaskFlowAccess = vi.fn(async () => {});
    const entry = { ...createRunEntry(), taskFlowId: "tf_1" };
    const params = createEmitParams({ entry, revokeTaskFlowAccess });
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(revokeTaskFlowAccess).toHaveBeenCalledTimes(1);
    expect(revokeTaskFlowAccess).toHaveBeenCalledWith(entry);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  });

  it("does not revoke TaskFlow access when the run has no taskFlowId", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const revokeTaskFlowAccess = vi.fn(async () => {});
    const params = createEmitParams({ revokeTaskFlowAccess });
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(revokeTaskFlowAccess).not.toHaveBeenCalled();
  });

  it("still emits the ended hook when TaskFlow revocation fails", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const revokeTaskFlowAccess = vi.fn(async () => {
      throw new Error("revoke failed");
    });
    const entry = { ...createRunEntry(), taskFlowId: "tf_1" };
    const params = createEmitParams({ entry, revokeTaskFlowAccess });
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(revokeTaskFlowAccess).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
  });

  it("returns false when runId is blank", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), runId: "   " },
    });
    const emitted = await emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when ended hook marker already exists", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), endedHookEmittedAt: Date.now() },
    });
    const emitted = await emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when runId is already in flight", async () => {
    const entry = createRunEntry();
    const inFlightRunIds = new Set<string>([entry.runId]);
    const params = createEmitParams({ entry, inFlightRunIds });
    const emitted = await emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when subagent hook execution throws", async () => {
    lifecycleMocks.runSubagentEnded.mockRejectedValueOnce(new Error("boom"));
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const entry = createRunEntry();
    const inFlightRunIds = new Set<string>();
    const params = createEmitParams({ entry, inFlightRunIds });
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(inFlightRunIds.has(entry.runId)).toBe(false);
    expect(entry.endedHookEmittedAt).toBeUndefined();
  });
});
