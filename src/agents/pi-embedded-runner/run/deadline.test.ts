import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedRunDeadline } from "./deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createEmbeddedRunDeadline", () => {
  it("fires after the initial timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onTimeout = vi.fn();
    createEmbeddedRunDeadline({ timeoutMs: 100, onTimeout });

    await vi.advanceTimersByTimeAsync(99);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("grants one additional timeout window when steer is accepted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onTimeout = vi.fn();
    const deadline = createEmbeddedRunDeadline({ timeoutMs: 100, onTimeout });

    await vi.advanceTimersByTimeAsync(90);
    expect(deadline.extendForContinuation()).toEqual({
      extended: true,
      deadlineAt: 1_200,
      maxDeadlineAt: 1_200,
    });

    await vi.advanceTimersByTimeAsync(109);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("does not extend again for later steer messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onTimeout = vi.fn();
    const deadline = createEmbeddedRunDeadline({ timeoutMs: 100, onTimeout });

    await vi.advanceTimersByTimeAsync(90);
    expect(deadline.extendForContinuation()).toEqual({
      extended: true,
      deadlineAt: 1_200,
      maxDeadlineAt: 1_200,
    });
    expect(deadline.extendForContinuation().extended).toBe(false);

    await vi.advanceTimersByTimeAsync(110);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("does not extend after the initial deadline has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const deadline = createEmbeddedRunDeadline({ timeoutMs: 100, onTimeout: vi.fn() });

    vi.setSystemTime(1_100);

    expect(deadline.extendForContinuation()).toEqual({
      extended: false,
      deadlineAt: 1_100,
      maxDeadlineAt: 1_200,
    });
  });

  it("chunks continuation deadlines that exceed Node's timer limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onTimeout = vi.fn();
    const maxTimerDelayMs = 2_147_000_000;
    const deadline = createEmbeddedRunDeadline({
      timeoutMs: maxTimerDelayMs,
      onTimeout,
    });

    expect(deadline.extendForContinuation().extended).toBe(true);

    await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("cancels the timeout when closed", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = createEmbeddedRunDeadline({ timeoutMs: 100, onTimeout });

    deadline.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(deadline.extendForContinuation().extended).toBe(false);
  });
});
