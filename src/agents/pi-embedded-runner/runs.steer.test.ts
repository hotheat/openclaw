import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  isEmbeddedPiRunCompacting,
  queueEmbeddedPiMessage,
  setActiveEmbeddedRun,
  steerEmbeddedPiRun,
  type EmbeddedPiQueueHandle,
} from "./runs.js";

const activeHandles: Array<{ sessionId: string; handle: EmbeddedPiQueueHandle }> = [];

function registerHandle(
  sessionId: string,
  state: { streaming: boolean; compacting: boolean },
): EmbeddedPiQueueHandle {
  const handle: EmbeddedPiQueueHandle = {
    queueMessage: vi.fn(async () => undefined),
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

    registerHandle("not-streaming", { streaming: false, compacting: false });
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

  it("queues accepted steer messages and preserves the boolean wrapper", () => {
    const handle = registerHandle("active", { streaming: true, compacting: false });

    expect(steerEmbeddedPiRun("active", "first")).toEqual({ status: "accepted" });
    expect(queueEmbeddedPiMessage("active", "second")).toBe(true);
    expect(handle.queueMessage).toHaveBeenNthCalledWith(1, "first");
    expect(handle.queueMessage).toHaveBeenNthCalledWith(2, "second");
    expect(queueEmbeddedPiMessage("missing", "ignored")).toBe(false);
  });
});
