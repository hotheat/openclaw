import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import {
  getExistingFollowupQueue,
  getFollowupQueue,
  isFollowupRunStarted,
  settleFollowupRun,
  type FollowupQueueState,
} from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.some((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
  }
  if (!allowPromptFallback) {
    return false;
  }
  return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  const queue = getFollowupQueue(key, settings);
  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    settleFollowupRun(run, { outcome: "dropped", reason: "duplicate" });
    return false;
  }

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  const itemsBeforeDrop = queue.items.slice();
  const shouldEnqueue = applyFollowupQueueDropPolicy(queue);
  for (const item of itemsBeforeDrop) {
    if (!queue.items.includes(item)) {
      if (queue.dropPolicy === "summarize") {
        // The evicted prompt still runs as part of a later summary, but do not
        // settle it as `merged` yet: if the queue is cleared or the summary is
        // discarded before it runs, the caller must hear `dropped` instead of
        // a merge promise that never delivers. Settlement happens when the
        // drain hands the summary to a run (or drops it).
        queue.pendingSummaryItems.push(item);
      } else {
        settleFollowupRun(item, { outcome: "dropped", reason: "cap" });
      }
    }
  }
  if (!shouldEnqueue) {
    settleFollowupRun(run, { outcome: "dropped", reason: "cap" });
    return false;
  }

  queue.items.push(run);
  return true;
}

/**
 * Cap eviction may only drop waiting items. Started items are already owned by the
 * drain loop: splicing them out would let a later snapshot-length splice swallow a
 * newly enqueued run without settling it.
 */
function applyFollowupQueueDropPolicy(queue: FollowupQueueState): boolean {
  const started: FollowupRun[] = [];
  const waiting: FollowupRun[] = [];
  for (const item of queue.items) {
    if (isFollowupRunStarted(item)) {
      started.push(item);
    } else {
      waiting.push(item);
    }
  }

  const waitingQueue = {
    items: waiting,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    droppedCount: queue.droppedCount,
    summaryLines: queue.summaryLines,
  };
  const shouldEnqueue = applyQueueDropPolicy({
    queue: waitingQueue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  queue.droppedCount = waitingQueue.droppedCount;
  queue.summaryLines = waitingQueue.summaryLines;
  // Mutate in place: drain holds a reference to this array.
  queue.items.length = 0;
  queue.items.push(...started, ...waitingQueue.items);
  return shouldEnqueue;
}

/** Remove a queued run that has not started yet. Returns false when it is no longer removable. */
export function removeFollowupRun(key: string, run: FollowupRun): boolean {
  const queue = getExistingFollowupQueue(key);
  if (!queue || isFollowupRunStarted(run)) {
    return false;
  }
  const index = queue.items.indexOf(run);
  if (index < 0) {
    return false;
  }
  queue.items.splice(index, 1);
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}
