import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleFollowupDrain } from "./drain.js";
import { enqueueFollowupRun, removeFollowupRun } from "./enqueue.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
  getFollowupQueue,
  markFollowupRunStarted,
} from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: overrides.prompt ?? "hello",
    enqueuedAt: Date.now(),
    run: { sessionId: "session", sessionKey: "main" } as FollowupRun["run"],
    ...overrides,
  };
}

const collect: QueueSettings = { mode: "collect", debounceMs: 0, cap: 10, dropPolicy: "old" };

describe("follow-up queue settlement", () => {
  afterEach(() => {
    clearFollowupQueue("main");
    clearFollowupQueue("cleared");
    clearFollowupQueue("summary");
    clearFollowupQueue("cap-drain");
    clearFollowupQueue("aborted-summary");
    clearFollowupQueue("orphan-drain");
    clearFollowupQueue("deferred-merge");
    clearFollowupQueue("batch-increment");
  });

  it("settles the item dropped by the cap policy", () => {
    const onSettledOld = vi.fn();
    const onSettledNew = vi.fn();
    const settings: QueueSettings = { ...collect, cap: 1, dropPolicy: "old" };
    expect(enqueueFollowupRun("main", createRun({ onSettled: onSettledOld }), settings)).toBe(true);
    expect(enqueueFollowupRun("main", createRun({ onSettled: onSettledNew }), settings)).toBe(true);

    expect(onSettledOld).toHaveBeenCalledWith({ outcome: "dropped", reason: "cap" });
    expect(onSettledNew).not.toHaveBeenCalled();
  });

  it("defers the summarize-evicted merge until the summary actually runs", () => {
    const onSettledEvicted = vi.fn();
    const onSettledNew = vi.fn();
    const settings: QueueSettings = { ...collect, cap: 1, dropPolicy: "summarize" };
    expect(
      enqueueFollowupRun("deferred-merge", createRun({ onSettled: onSettledEvicted }), settings),
    ).toBe(true);
    expect(
      enqueueFollowupRun("deferred-merge", createRun({ onSettled: onSettledNew }), settings),
    ).toBe(true);

    // The evicted prompt is folded into a later summary run, but the merge is
    // only honest once that summary runs: until then the caller must not be
    // told their content will be processed.
    expect(onSettledEvicted).not.toHaveBeenCalled();
    expect(onSettledNew).not.toHaveBeenCalled();

    // Clearing the queue before the summary runs reports the drop instead.
    expect(clearFollowupQueue("deferred-merge")).toBe(2);
    expect(onSettledEvicted).toHaveBeenCalledWith({ outcome: "dropped", reason: "cleared" });
    expect(onSettledNew).toHaveBeenCalledWith({ outcome: "dropped", reason: "cleared" });
  });

  it("settles a rejected item under the drop-new policy and duplicates", () => {
    const onSettledNew = vi.fn();
    const onSettledDup = vi.fn();
    const settings: QueueSettings = { ...collect, cap: 1, dropPolicy: "new" };
    expect(enqueueFollowupRun("main", createRun({ messageId: "m1" }), settings)).toBe(true);
    expect(
      enqueueFollowupRun("main", createRun({ messageId: "m1", onSettled: onSettledDup }), settings),
    ).toBe(false);
    expect(
      enqueueFollowupRun("main", createRun({ messageId: "m2", onSettled: onSettledNew }), settings),
    ).toBe(false);

    expect(onSettledDup).toHaveBeenCalledWith({ outcome: "dropped", reason: "duplicate" });
    expect(onSettledNew).toHaveBeenCalledWith({ outcome: "dropped", reason: "cap" });
  });

  it("settles cleared items as dropped", () => {
    const onSettled = vi.fn();
    enqueueFollowupRun("main", createRun({ onSettled }), collect);

    expect(clearFollowupQueue("main")).toBe(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "dropped", reason: "cleared" });
  });

  it("keeps started items for the drain when the queue is cleared", async () => {
    const startedSettle = vi.fn();
    const waitingSettle = vi.fn();
    const started = createRun({ prompt: "started", onSettled: startedSettle });
    const waiting = createRun({ prompt: "waiting", onSettled: waitingSettle });
    enqueueFollowupRun("cleared", started, collect);
    enqueueFollowupRun("cleared", waiting, collect);
    markFollowupRunStarted(started);

    expect(clearFollowupQueue("cleared")).toBe(1);
    expect(waitingSettle).toHaveBeenCalledWith({ outcome: "dropped", reason: "cleared" });
    // The started run is mid-flight; clearing must not double-settle it as an error.
    expect(startedSettle).not.toHaveBeenCalled();

    // When the drain finishes the started item it settles normally and the queue empties.
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("cleared", runFollowup);
    await vi.waitFor(() => {
      expect(startedSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
  });

  it("runs overflow summaries without consuming the head item", async () => {
    const followup: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const evictedSettle = vi.fn();
    const headSettle = vi.fn();
    const evicted = createRun({ prompt: "evicted message", onSettled: evictedSettle });
    const head = createRun({ prompt: "head message", runId: "run-head", onSettled: headSettle });
    enqueueFollowupRun("summary", evicted, followup);
    enqueueFollowupRun("summary", head, followup);

    // The merge lands only when the summary run actually carries the content.
    expect(evictedSettle).not.toHaveBeenCalled();

    const prompts: string[] = [];
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      prompts.push(queued.prompt);
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("summary", runFollowup);
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(2);
    });

    // The synthetic summary run carries the overflow notice; the head keeps its own prompt.
    expect(prompts[0]).toContain("Queue overflow");
    expect(prompts[0]).toContain("evicted message");
    expect(prompts[1]).toBe("head message");
    expect(evictedSettle).toHaveBeenCalledWith({ outcome: "merged", runId: undefined });
    expect(headSettle).toHaveBeenCalledWith({ outcome: "done" });
  });

  it("removes only items that have not started", () => {
    const waiting = createRun();
    const started = createRun();
    enqueueFollowupRun("main", started, collect);
    enqueueFollowupRun("main", waiting, collect);
    markFollowupRunStarted(started);

    expect(removeFollowupRun("main", started)).toBe(false);
    expect(removeFollowupRun("main", waiting)).toBe(true);
    expect(removeFollowupRun("main", waiting)).toBe(false);
  });

  it("runs a collected batch under the newest caller run id and settles the rest as merged", async () => {
    const first = createRun({
      prompt: "first",
      runId: "run-a",
      onAgentRunStart: vi.fn(),
      onSettled: vi.fn(),
    });
    const second = createRun({
      prompt: "second",
      runId: "run-b",
      onAgentRunStart: vi.fn(),
      onSettled: vi.fn(),
    });
    const third = createRun({ prompt: "third", onSettled: vi.fn() });
    enqueueFollowupRun("main", first, collect);
    enqueueFollowupRun("main", second, collect);
    enqueueFollowupRun("main", third, collect);

    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      queued.onAgentRunStart?.(queued.runId ?? "random");
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("main", runFollowup);
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(1);
    });

    const merged = runFollowup.mock.calls[0]?.[0];
    expect(merged?.runId).toBe("run-b");
    expect(merged?.prompt).toContain("first");
    expect(merged?.prompt).toContain("third");
    expect(second.onAgentRunStart).toHaveBeenCalledWith("run-b");
    expect(second.onSettled).toHaveBeenCalledWith({ outcome: "done" });
    // Merged items settle only after the batch finished, so a failing batch can
    // still deliver its outcome to every caller.
    await vi.waitFor(() => {
      expect(first.onSettled).toHaveBeenCalledWith({ outcome: "merged", runId: "run-b" });
      expect(third.onSettled).toHaveBeenCalledWith({ outcome: "merged", runId: "run-b" });
    });
    // Items in a running batch can no longer be pulled out from under the drain.
    expect(removeFollowupRun("main", first)).toBe(false);
  });

  it("settles every caller with the batch error when a collected batch fails", async () => {
    const first = createRun({ prompt: "first", runId: "run-a", onSettled: vi.fn() });
    const second = createRun({ prompt: "second", runId: "run-b", onSettled: vi.fn() });
    enqueueFollowupRun("main", first, collect);
    enqueueFollowupRun("main", second, collect);

    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      queued.onSettled?.({ outcome: "error", error: "provider down" });
    });
    scheduleFollowupDrain("main", runFollowup);
    await vi.waitFor(() => {
      expect(second.onSettled).toHaveBeenCalledWith({ outcome: "error", error: "provider down" });
      expect(first.onSettled).toHaveBeenCalledWith({ outcome: "error", error: "provider down" });
    });
  });

  it("settles aborted queued items without running their prompts", async () => {
    const abortedController = new AbortController();
    abortedController.abort();
    const abortedSettle = vi.fn();
    const activeSettle = vi.fn();
    const aborted = createRun({
      prompt: "aborted message",
      runId: "run-aborted",
      abortSignal: abortedController.signal,
      onSettled: abortedSettle,
    });
    const active = createRun({
      prompt: "active message",
      runId: "run-active",
      onSettled: activeSettle,
    });
    enqueueFollowupRun("main", aborted, collect);
    enqueueFollowupRun("main", active, collect);

    const prompts: string[] = [];
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      prompts.push(queued.prompt);
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("main", runFollowup);
    await vi.waitFor(() => {
      expect(activeSettle).toHaveBeenCalledWith({ outcome: "done" });
    });

    expect(abortedSettle).toHaveBeenCalledWith({ outcome: "aborted" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("active message");
    expect(prompts[0]).not.toContain("aborted message");
  });

  it("delivers the overflow summary once and exits when every queued item was aborted", async () => {
    const settings: QueueSettings = { ...collect, cap: 1, dropPolicy: "summarize" };
    const evictedSettle = vi.fn();
    const abortedSettle = vi.fn();
    const evicted = createRun({ prompt: "evicted message", onSettled: evictedSettle });
    enqueueFollowupRun("aborted-summary", evicted, settings);

    const controller = new AbortController();
    const aborted = createRun({
      prompt: "aborted message",
      runId: "run-aborted",
      abortSignal: controller.signal,
      onSettled: abortedSettle,
    });
    // Cap eviction folds "evicted message" into the overflow summary.
    enqueueFollowupRun("aborted-summary", aborted, settings);
    controller.abort();

    const prompts: string[] = [];
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      prompts.push(queued.prompt);
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("aborted-summary", runFollowup);
    await vi.waitFor(() => {
      expect(abortedSettle).toHaveBeenCalledWith({ outcome: "aborted" });
      expect(evictedSettle).toHaveBeenCalledWith({ outcome: "merged", runId: undefined });
      expect(runFollowup).toHaveBeenCalledTimes(1);
    });

    // The synthetic summary run carries the overflow notice; the aborted prompt never runs.
    expect(prompts[0]).toContain("Queue overflow");
    expect(prompts[0]).toContain("evicted message");
    expect(prompts[0]).not.toContain("aborted message");
    // The drain must terminate and release the queue instead of spinning on
    // droppedCount > 0 with an empty item list.
    await vi.waitFor(() => {
      expect(getExistingFollowupQueue("aborted-summary")).toBeUndefined();
    });
    expect(runFollowup).toHaveBeenCalledTimes(1);
  });

  it("does not cap-evict a started collect batch or swallow a later enqueue", async () => {
    const settings: QueueSettings = { ...collect, cap: 1, dropPolicy: "old" };
    const firstSettle = vi.fn();
    const secondSettle = vi.fn();
    const first = createRun({ prompt: "first", runId: "run-a", onSettled: firstSettle });
    enqueueFollowupRun("cap-drain", first, settings);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      if (queued.runId === "run-a") {
        const second = createRun({ prompt: "second", runId: "run-b", onSettled: secondSettle });
        expect(enqueueFollowupRun("cap-drain", second, settings)).toBe(true);
        expect(firstSettle).not.toHaveBeenCalled();
        await gate;
      }
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("cap-drain", runFollowup);
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(1);
    });
    release();
    await vi.waitFor(() => {
      expect(firstSettle).toHaveBeenCalledWith({ outcome: "done" });
      expect(secondSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
    expect(firstSettle).toHaveBeenCalledTimes(1);
    expect(runFollowup.mock.calls.map((call) => call[0]?.runId)).toEqual(["run-a", "run-b"]);
  });

  it("does not unregister a replacement queue when an orphaned drain exits", async () => {
    const aSettle = vi.fn();
    const bSettle = vi.fn();
    const settings: QueueSettings = { ...collect, debounceMs: 60_000 };
    enqueueFollowupRun("orphan-drain", createRun({ prompt: "a", onSettled: aSettle }), settings);

    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      queued.onSettled?.({ outcome: "done" });
    });
    // Park D1 on the debounce (backdate so the check resolves as a microtask,
    // i.e. only after this synchronous block finishes).
    const queue = getFollowupQueue("orphan-drain", settings);
    queue.lastEnqueuedAt = Date.now() - 120_000;
    scheduleFollowupDrain("orphan-drain", runFollowup);
    // Simulate chat.abort's clear while D1 still holds the queue: A settles
    // dropped and the key is removed.
    expect(clearFollowupQueue("orphan-drain")).toBe(1);
    expect(aSettle).toHaveBeenCalledWith({ outcome: "dropped", reason: "cleared" });
    // A new message registers a replacement queue; enqueue alone does not
    // schedule a drain (run completion does), so B depends entirely on the
    // replacement staying registered.
    enqueueFollowupRun(
      "orphan-drain",
      createRun({ prompt: "b", runId: "run-b", onSettled: bSettle }),
      settings,
    );
    const replacement = getExistingFollowupQueue("orphan-drain");
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(queue);
    // Backdate the replacement's debounce so the drain the orphan hands over
    // (below) proceeds immediately instead of parking on the 60s window.
    replacement!.lastEnqueuedAt = Date.now() - 120_000;

    // D1 exits its loop on the emptied orphan queue.
    await vi.waitFor(() => {
      expect(queue.draining).toBe(false);
    });

    // The orphan's exit must hand the runner to the replacement: nothing else
    // schedules a drain (enqueue never does; a followup run completing
    // bypasses finalizeWithFollowup), so without the hand-off B strands
    // forever behind a composer locked on the queued run.
    await vi.waitFor(() => {
      expect(bSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
    expect(getExistingFollowupQueue("orphan-drain")).toBeUndefined();
  });

  it("keeps summary increments that land while a collect batch runs", async () => {
    const settings: QueueSettings = { ...collect, cap: 2, dropPolicy: "summarize" };
    const firstSettle = vi.fn();
    const secondSettle = vi.fn();
    const first = createRun({ prompt: "first", runId: "run-a", onSettled: firstSettle });
    enqueueFollowupRun("batch-increment", first, settings);

    const midBatchEvictedSettle = vi.fn();
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      if (queued.runId === "run-a") {
        // While the batch runs, cap eviction folds another prompt into the
        // pending overflow summary; it must survive this batch's completion.
        const evicted = createRun({
          prompt: "mid batch message",
          onSettled: midBatchEvictedSettle,
        });
        const second = createRun({ prompt: "second", runId: "run-b", onSettled: secondSettle });
        enqueueFollowupRun("batch-increment", evicted, settings);
        enqueueFollowupRun("batch-increment", second, settings);
        await batchGate;
      }
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("batch-increment", runFollowup);
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(1);
    });
    // While the batch is still gated mid-run, the eviction is pending only.
    expect(midBatchEvictedSettle).not.toHaveBeenCalled();
    releaseBatch();
    await vi.waitFor(() => {
      expect(firstSettle).toHaveBeenCalledWith({ outcome: "done" });
    });

    // The drain continues: run-b's batch carries the pending summary with it.
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(2);
    });
    const secondPrompt = runFollowup.mock.calls[1]?.[0]?.prompt ?? "";
    expect(secondPrompt).toContain("mid batch message");
    await vi.waitFor(() => {
      expect(secondSettle).toHaveBeenCalledWith({ outcome: "done" });
      expect(midBatchEvictedSettle).toHaveBeenCalledWith({ outcome: "merged", runId: "run-b" });
    });
    await vi.waitFor(() => {
      expect(getExistingFollowupQueue("batch-increment")).toBeUndefined();
    });
  });

  it("settles a pending summary item as aborted and retracts its line", async () => {
    const settings: QueueSettings = { ...collect, cap: 1, dropPolicy: "summarize" };
    const evictedController = new AbortController();
    const evictedSettle = vi.fn();
    const evicted = createRun({
      prompt: "evicted then aborted",
      abortSignal: evictedController.signal,
      onSettled: evictedSettle,
    });
    enqueueFollowupRun("aborted-summary", evicted, settings);
    const headSettle = vi.fn();
    const head = createRun({ prompt: "head", runId: "run-head", onSettled: headSettle });
    enqueueFollowupRun("aborted-summary", head, settings);
    evictedController.abort();

    const prompts: string[] = [];
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      prompts.push(queued.prompt);
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("aborted-summary", runFollowup);
    await vi.waitFor(() => {
      expect(headSettle).toHaveBeenCalledWith({ outcome: "done" });
      expect(evictedSettle).toHaveBeenCalledWith({ outcome: "aborted" });
    });
    // The aborted prompt must not reach the model through the summary either.
    expect(prompts.join("\n")).not.toContain("evicted then aborted");
  });

  it("retries a failed summary run without losing or double-settling its items", async () => {
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const evictedSettle = vi.fn();
    const evicted = createRun({ prompt: "evicted for retry", onSettled: evictedSettle });
    enqueueFollowupRun("summary", evicted, settings);
    const headSettle = vi.fn();
    const head = createRun({ prompt: "head", runId: "run-head", onSettled: headSettle });
    enqueueFollowupRun("summary", head, settings);

    const prompts: string[] = [];
    let attempt = 0;
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      prompts.push(queued.prompt);
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("summary", runFollowup);
    await vi.waitFor(() => {
      expect(evictedSettle).toHaveBeenCalledWith({ outcome: "merged", runId: undefined });
      expect(headSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
    // The first attempt rejected before the model saw anything: the retry must
    // redeliver the overflow summary, not swallow the evicted prompt.
    expect(prompts.join("\n")).toContain("evicted for retry");
    expect(evictedSettle).toHaveBeenCalledTimes(1);
  });

  it("caps persistent summary delivery failures instead of retrying forever", async () => {
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const evictedSettle = vi.fn();
    const evicted = createRun({ prompt: "evicted forever failing", onSettled: evictedSettle });
    enqueueFollowupRun("summary", evicted, settings);
    const headSettle = vi.fn();
    const head = createRun({ prompt: "head", runId: "run-head", onSettled: headSettle });
    enqueueFollowupRun("summary", head, settings);

    let summaryAttempts = 0;
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      if (queued.prompt.includes("Queue overflow")) {
        summaryAttempts += 1;
        throw new Error("persistent failure");
      }
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("summary", runFollowup);
    // After the initial attempt plus three retries the drain gives up and
    // settles the evicted caller instead of spinning on the restore/reschedule
    // cycle forever. The head item itself still drains normally.
    await vi.waitFor(() => {
      expect(evictedSettle).toHaveBeenCalledWith({
        outcome: "dropped",
        reason: "summary-discarded",
      });
      expect(headSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
    expect(summaryAttempts).toBe(4);
    await vi.waitFor(() => {
      expect(getExistingFollowupQueue("summary")).toBeUndefined();
    });
    expect(summaryAttempts).toBe(4);
  });

  it("settles evicted callers with the summary run's failure outcome", async () => {
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const evictedSettle = vi.fn();
    const evicted = createRun({ prompt: "evicted failing run", onSettled: evictedSettle });
    enqueueFollowupRun("summary", evicted, settings);
    const headSettle = vi.fn();
    const head = createRun({ prompt: "head", runId: "run-head", onSettled: headSettle });
    enqueueFollowupRun("summary", head, settings);

    // The followup runner swallows model failures (settles internally instead
    // of rejecting): the drain must read that settlement and report it rather
    // than defaulting every evicted caller to "merged".
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      if (queued.prompt.includes("Queue overflow")) {
        queued.onSettled?.({ outcome: "error", error: "provider down" });
        return;
      }
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("summary", runFollowup);
    await vi.waitFor(() => {
      expect(evictedSettle).toHaveBeenCalledWith({ outcome: "error", error: "provider down" });
      expect(headSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
    expect(evictedSettle).toHaveBeenCalledTimes(1);
  });

  it("settles leased summary items when no run context remains to deliver them", async () => {
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const evictedSettle = vi.fn();
    const evicted = createRun({ prompt: "evicted without run", onSettled: evictedSettle });
    enqueueFollowupRun("summary", evicted, settings);
    const headSettle = vi.fn();
    const head = createRun({ prompt: "head", runId: "run-head", onSettled: headSettle });
    enqueueFollowupRun("summary", head, settings);
    // Simulate the run context disappearing (e.g. clear) while the eviction
    // summary is still pending.
    getExistingFollowupQueue("summary")!.lastRun = undefined;

    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      queued.onSettled?.({ outcome: "done" });
    });
    scheduleFollowupDrain("summary", runFollowup);
    await vi.waitFor(() => {
      // The lease owns the evicted items at this point; the discard path must
      // settle them, not only the (already emptied) pending list.
      expect(evictedSettle).toHaveBeenCalledWith({
        outcome: "dropped",
        reason: "summary-discarded",
      });
      expect(headSettle).toHaveBeenCalledWith({ outcome: "done" });
    });
    expect(runFollowup).toHaveBeenCalledTimes(1);
  });

  it("does not roll back a settlement when the callback throws", () => {
    const onSettled = vi.fn(() => {
      throw new Error("callback boom");
    });
    const run = createRun({ onSettled });
    enqueueFollowupRun("main", run, collect);

    expect(() => clearFollowupQueue("main")).not.toThrow();
    expect(onSettled).toHaveBeenCalledTimes(1);
    // The exactly-once guard must hold: a retry reports the run as settled.
    expect(() => clearFollowupQueue("main")).not.toThrow();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
