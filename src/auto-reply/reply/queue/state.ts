import { defaultRuntime } from "../../../runtime.js";
import {
  applyQueueRuntimeSettings,
  buildQueueSummaryLine,
  buildQueueSummaryPrompt,
  clearQueueSummaryState,
} from "../../../utils/queue-helpers.js";
import type {
  FollowupRun,
  FollowupRunSettlement,
  QueueDropPolicy,
  QueueMode,
  QueueSettings,
} from "./types.js";

const STARTED_FOLLOWUP_RUNS = new WeakSet<FollowupRun>();
const SETTLED_FOLLOWUP_RUNS = new WeakSet<FollowupRun>();

/**
 * Mark a queued run as picked up by the drain loop. The drain removes items from the queue
 * only after their run finishes, so started items must not be removed out from under it.
 */
export function markFollowupRunStarted(run: FollowupRun): void {
  STARTED_FOLLOWUP_RUNS.add(run);
}

/** Whether a queued run has been picked up by the drain loop. */
export function isFollowupRunStarted(run: FollowupRun): boolean {
  return STARTED_FOLLOWUP_RUNS.has(run);
}

/**
 * Deliver a queued run's settlement exactly once. Enqueue eviction, abort cancellation,
 * clear, drain fan-out, and the runner can all race to settle the same item; the first
 * settlement wins so callers never observe two terminals for one run id.
 */
export function settleFollowupRun(run: FollowupRun, settlement: FollowupRunSettlement): void {
  if (SETTLED_FOLLOWUP_RUNS.has(run)) {
    return;
  }
  SETTLED_FOLLOWUP_RUNS.add(run);
  try {
    run.onSettled?.(settlement);
  } catch (err) {
    // A throwing callback must not roll the settlement back: the drain would
    // re-run the whole batch under a second run and callers would observe two
    // terminals for one run id.
    defaultRuntime.error?.(`followup queue settlement callback failed: ${String(err)}`);
  }
}

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  /**
   * Cap-evicted items whose prompts are folded into the pending overflow
   * summary. They settle as `merged` only when that summary is actually handed
   * to a run; if the summary is discarded or the queue cleared, they settle as
   * `dropped` instead of reporting a merge that never happens.
   */
  pendingSummaryItems: FollowupRun[];
  /** Consecutive failed delivery attempts for the pending overflow summary. */
  summaryRetryCount: number;
  lastRun?: FollowupRun["run"];
};

export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

export const FOLLOWUP_QUEUES = new Map<string, FollowupQueueState>();

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  return FOLLOWUP_QUEUES.get(cleaned);
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    return existing;
  }

  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
    pendingSummaryItems: [],
    summaryRetryCount: 0,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

/**
 * Settle cap-evicted items whose abort fired while their summary was still
 * pending, and retract the summary line so the aborted prompt never reaches
 * the model (mirrors the drain's treatment of aborted waiting items).
 */
export function filterAbortedPendingSummaryItems(queue: FollowupQueueState): void {
  if (queue.pendingSummaryItems.length === 0) {
    return;
  }
  const remaining: FollowupRun[] = [];
  for (const item of queue.pendingSummaryItems) {
    if (!item.abortSignal?.aborted) {
      remaining.push(item);
      continue;
    }
    const line = buildQueueSummaryLine(item.summaryLine?.trim() || item.prompt.trim());
    const index = queue.summaryLines.indexOf(line);
    if (index >= 0) {
      queue.summaryLines.splice(index, 1);
    }
    if (queue.droppedCount > 0) {
      queue.droppedCount -= 1;
    }
    settleFollowupRun(item, { outcome: "aborted" });
  }
  queue.pendingSummaryItems = remaining;
}

/**
 * Atomically build the pending overflow summary and take ownership of the
 * evicted items waiting on it. Building clears `droppedCount`/`summaryLines`,
 * so evictions that happen while the summary run executes accumulate for the
 * next summary instead of being wiped by a post-run clear. Items stay pending
 * when no summary is deliverable yet.
 *
 * The lease is restore-or-discard on failure: if handing the summary to a run
 * rejects before the model ever saw it, `restore()` rolls the state back so
 * the drain retry redelivers the same summary; when delivery must be given up
 * (retry cap reached, no run context left), `discard()` settles the leased
 * items so their callers do not hang on a merge that will never happen.
 */
export function consumeQueueSummary(queue: FollowupQueueState): {
  prompt?: string;
  items: FollowupRun[];
  restore: () => void;
  discard: () => void;
} {
  filterAbortedPendingSummaryItems(queue);
  const snapshotLines = [...queue.summaryLines];
  const snapshotCount = queue.droppedCount;
  const prompt = buildQueueSummaryPrompt({ state: queue, noun: "message" });
  if (!prompt) {
    return { items: [], restore: () => {}, discard: () => {} };
  }
  const items = queue.pendingSummaryItems;
  queue.pendingSummaryItems = [];
  return {
    prompt,
    items,
    restore: () => {
      queue.summaryLines.unshift(...snapshotLines);
      queue.droppedCount += snapshotCount;
      queue.pendingSummaryItems = [...items, ...queue.pendingSummaryItems];
    },
    discard: () => {
      // consumeQueueSummary already cleared the summary counters; only the
      // leased items still need their terminal.
      for (const item of items) {
        settleFollowupRun(item, { outcome: "dropped", reason: "summary-discarded" });
      }
    },
  };
}

/** Drop a summary that can never run and settle its pending items as dropped. */
export function discardQueueSummary(queue: FollowupQueueState): void {
  clearQueueSummaryState(queue);
  for (const item of queue.pendingSummaryItems) {
    settleFollowupRun(item, { outcome: "dropped", reason: "summary-discarded" });
  }
  queue.pendingSummaryItems = [];
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }
  // Started items are mid-run inside the drain loop; they settle via the runner and
  // stay in queue.items until the drain shifts them out. Clearing them here would
  // emit a second terminal state under the same run id while the agent still runs.
  // Mutate in place: the drain loop and drainNextQueueItem hold references to the
  // items array, so replacing it would desynchronize their bookkeeping.
  const settled: FollowupRun[] = [];
  for (let i = queue.items.length - 1; i >= 0; i--) {
    const item = queue.items[i];
    if (item && !isFollowupRunStarted(item)) {
      queue.items.splice(i, 1);
      settled.push(item);
    }
  }
  const settledSummaryItems = queue.pendingSummaryItems;
  queue.pendingSummaryItems = [];
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  if (queue.items.length === 0) {
    FOLLOWUP_QUEUES.delete(cleaned);
  }
  for (const item of settled) {
    settleFollowupRun(item, { outcome: "dropped", reason: "cleared" });
  }
  for (const item of settledSummaryItems) {
    // Their overflow summary died with the clear; report the drop instead of a
    // merge that will never deliver their content.
    settleFollowupRun(item, { outcome: "dropped", reason: "cleared" });
  }
  return settled.length + settledSummaryItems.length;
}
