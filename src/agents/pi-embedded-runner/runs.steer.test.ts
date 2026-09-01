import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  isEmbeddedPiRunCompacting,
  queueEmbeddedPiMessage,
  registerPendingEmbeddedRun,
  setActiveEmbeddedRun,
  steerEmbeddedPiRun,
  steerEmbeddedPiRunAllowPending,
  steerEmbeddedPiRunById,
  type EmbeddedPiQueueHandle,
} from "./runs.js";

const activeHandles: Array<{ sessionId: string; handle: EmbeddedPiQueueHandle }> = [];

function registerHandle(
  sessionId: string,
  state: { streaming: boolean; compacting: boolean; accepting?: boolean },
): EmbeddedPiQueueHandle {
  const handle: EmbeddedPiQueueHandle = {
    runId: `run-${sessionId}`,
    queueMessage: vi.fn(() => state.accepting !== false),
    isStreaming: () => state.streaming,
    isCompacting: () => state.compacting,
    abort: vi.fn(),
  };
  setActiveEmbeddedRun(sessionId, handle);
  activeHandles.push({ sessionId, handle });
  return handle;
}

afterEach(() => {
  for (const { sessionId, handle } of activeHandles.splice(0)) {
    clearActiveEmbeddedRun(sessionId, handle);
  }
});

describe("steerEmbeddedPiRun", () => {
  it("distinguishes inactive, non-streaming, and compacting runs", () => {
    expect(steerEmbeddedPiRun("missing", "message")).toEqual({
      status: "not_steerable",
      reason: "run_inactive",
    });

    registerHandle("not-streaming", {
      streaming: false,
      compacting: false,
      accepting: false,
    });
    expect(steerEmbeddedPiRun("not-streaming", "message")).toEqual({
      status: "not_steerable",
      reason: "not_streaming",
    });

    registerHandle("compacting", { streaming: true, compacting: true });
    expect(isEmbeddedPiRunCompacting("compacting")).toBe(true);
    expect(steerEmbeddedPiRun("compacting", "message")).toEqual({
      status: "not_steerable",
      reason: "compacting",
    });
  });

  it("steers only the requested active run", () => {
    const handle = registerHandle("active-by-id", { streaming: true, compacting: false });

    expect(steerEmbeddedPiRunById("active-by-id", "stale-run", "ignored")).toEqual({
      status: "not_steerable",
      reason: "run_inactive",
    });
    expect(steerEmbeddedPiRunById("active-by-id", handle.runId, "accepted")).toEqual({
      status: "accepted",
    });
    expect(handle.queueMessage).toHaveBeenCalledOnce();
    expect(handle.queueMessage).toHaveBeenCalledWith("accepted");
  });

  it("queues accepted steer messages and preserves the boolean wrapper", () => {
    const handle = registerHandle("active", { streaming: true, compacting: false });

    expect(steerEmbeddedPiRun("active", "first")).toEqual({ status: "accepted" });
    expect(queueEmbeddedPiMessage("active", "second")).toBe(true);
    expect(handle.queueMessage).toHaveBeenNthCalledWith(1, "first");
    expect(handle.queueMessage).toHaveBeenNthCalledWith(2, "second");
    expect(queueEmbeddedPiMessage("missing", "ignored")).toBe(false);
  });

  it("accepts a steer while the requested run is waiting to register", () => {
    registerPendingEmbeddedRun("pending", "run-pending");

    expect(steerEmbeddedPiRunById("pending", "run-pending", "early")).toEqual({
      status: "accepted",
    });
    expect(steerEmbeddedPiRunById("pending", "other-run", "ignored")).toEqual({
      status: "not_steerable",
      reason: "run_inactive",
    });

    const handle = registerHandle("pending", { streaming: false, compacting: false });
    expect(handle.queueMessage).toHaveBeenCalledOnce();
    expect(handle.queueMessage).toHaveBeenCalledWith("early");
  });

  it("queues guidance for the only pending run and replays it on registration", () => {
    registerPendingEmbeddedRun("pending-allow", "run-pending-allow");

    expect(steerEmbeddedPiRunAllowPending("pending-allow", "early guidance")).toEqual({
      status: "accepted",
      mode: "queued",
    });

    const handle = registerHandle("pending-allow", { streaming: false, compacting: false });
    expect(handle.queueMessage).toHaveBeenCalledOnce();
    expect(handle.queueMessage).toHaveBeenCalledWith("early guidance");
  });

  it("rejects an ambiguous pending target", () => {
    registerPendingEmbeddedRun("multiple-pending", "run-pending-1");
    registerPendingEmbeddedRun("multiple-pending", "run-pending-2");

    expect(steerEmbeddedPiRunAllowPending("multiple-pending", "ambiguous")).toEqual({
      status: "not_steerable",
      reason: "run_inactive",
    });

    abortEmbeddedPiRun("multiple-pending");
  });

  it("steers an active handle through the allow-pending entry point", () => {
    const handle = registerHandle("active-allow", { streaming: true, compacting: false });

    expect(steerEmbeddedPiRunAllowPending("active-allow", "active guidance")).toEqual({
      status: "accepted",
      mode: "steered",
    });
    expect(handle.queueMessage).toHaveBeenCalledWith("active guidance");
  });

  it("keeps the no-run-id API inactive for a pending-only session", () => {
    registerPendingEmbeddedRun("pending-contract", "run-pending-contract");

    expect(steerEmbeddedPiRun("pending-contract", "must not queue")).toEqual({
      status: "not_steerable",
      reason: "run_inactive",
    });

    abortEmbeddedPiRun("pending-contract");
  });
});
