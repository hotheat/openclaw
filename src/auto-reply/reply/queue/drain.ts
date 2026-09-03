import { defaultRuntime } from "../../../runtime.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import {
  consumeQueueSummary,
  discardQueueSummary,
  FOLLOWUP_QUEUES,
  markFollowupRunStarted,
  settleFollowupRun,
  type FollowupQueueState,
} from "./state.js";
import type { FollowupRun, FollowupRunSettlement } from "./types.js";

/** Failed summary delivery attempts before the drain gives up and settles dropped. */
const SUMMARY_DELIVERY_MAX_RETRIES = 3;

/**
 * Fold a settlement outcome into merged callers: success reports the merge
 * (`runId` names the run that answered), failure/abort reaches every caller.
 */
function fanOutSettlement(
  items: FollowupRun[],
  settlement: FollowupRunSettlement | undefined,
  runId?: string,
): void {
  for (const item of items) {
    settleFollowupRun(
      item,
      !settlement || settlement.outcome === "done" ? { outcome: "merged", runId } : settlement,
    );
  }
}

/**
 * A summary handoff rejected before the model saw the content: retry a bounded
 * number of times, then settle the leased callers as dropped. Without the cap,
 * restore + finally-reschedule loops forever (a debounce of 0 spins the event
 * loop; any debounce leaves the pending items un-settled indefinitely).
 */
function handleFailedSummaryLease(
  queue: FollowupQueueState,
  lease: { restore: () => void; discard: () => void },
): void {
  queue.summaryRetryCount += 1;
  if (queue.summaryRetryCount <= SUMMARY_DELIVERY_MAX_RETRIES) {
    lease.restore();
    return;
  }
  lease.discard();
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/reply-flow.test.ts`
          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel = hasCrossChannelItems(queue.items, (item) => {
            const channel = item.originatingChannel;
            const to = item.originatingTo;
            const accountId = item.originatingAccountId;
            const threadId = item.originatingThreadId;
            if (!channel && !to && !accountId && (threadId == null || threadId === "")) {
              return {};
            }
            if (!isRoutableChannel(channel) || !to) {
              return { cross: true };
            }
            // Support both number (Telegram topic IDs) and string (Slack thread_ts) thread IDs.
            const threadKey = threadId != null && threadId !== "" ? String(threadId) : "";
            return {
              key: [channel, to, accountId || "", threadKey].join("|"),
            };
          });

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: runFollowup,
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const snapshot = queue.items.slice();
          // Drop items aborted while queued: their callers already saw the aborted
          // terminal via chat.abort, and their prompts must not reach the model.
          const items: FollowupRun[] = [];
          for (const item of snapshot) {
            if (item.abortSignal?.aborted) {
              settleFollowupRun(item, { outcome: "aborted" });
              const index = queue.items.indexOf(item);
              if (index >= 0) {
                queue.items.splice(index, 1);
              }
            } else {
              items.push(item);
            }
          }
          if (items.length === 0) {
            if (queue.droppedCount === 0) {
              continue;
            }
            // Every remaining item was aborted, but cap eviction already folded
            // earlier prompts into a pending overflow summary. Deliver it on a
            // standalone synthetic run and clear the counters; leaving
            // droppedCount > 0 with no items would spin this loop (and the
            // finally-reschedule) without ever yielding to the event loop.
            const overflowLease = consumeQueueSummary(queue);
            const overflowRun = queue.lastRun;
            if (overflowLease.prompt && overflowRun) {
              // Capture the synthetic run's own settlement: the followup runner
              // swallows model/transport failures (settles internally instead
              // of rejecting), so the evicted callers must hear that outcome
              // instead of a default "merged".
              let overflowSettlement: FollowupRunSettlement | undefined;
              try {
                await runFollowup({
                  prompt: overflowLease.prompt,
                  run: overflowRun,
                  enqueuedAt: Date.now(),
                  onSettled: (settlement) => {
                    overflowSettlement = settlement;
                  },
                });
                queue.summaryRetryCount = 0;
                fanOutSettlement(overflowLease.items, overflowSettlement);
              } catch (err) {
                handleFailedSummaryLease(queue, overflowLease);
                throw err;
              }
            } else {
              overflowLease.discard();
            }
            continue;
          }
          // Consume the summary atomically with this batch snapshot: evictions
          // landing while the batch runs must survive for the next summary
          // instead of being wiped by a post-run clear.
          const summaryLease = consumeQueueSummary(queue);
          const summary = summaryLease.prompt;
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) {
            break;
          }
          // The merged run answers on behalf of the newest item that carries a caller
          // run id. The rest stay unsettled until the batch finishes so a failed or
          // aborted batch reports the same outcome to every caller instead of a
          // premature "merged success".
          const primary = items.findLast((item) => item.runId) ?? items.at(-1);
          for (const item of items) {
            markFollowupRunStarted(item);
          }
          let primarySettlement: FollowupRunSettlement | undefined;

          // Preserve originating channel from items when collecting same-channel.
          const originatingChannel = items.find((i) => i.originatingChannel)?.originatingChannel;
          const originatingTo = items.find((i) => i.originatingTo)?.originatingTo;
          const originatingAccountId = items.find(
            (i) => i.originatingAccountId,
          )?.originatingAccountId;
          // Support both number (Telegram topic) and string (Slack thread_ts) thread IDs.
          const originatingThreadId = items.find(
            (i) => i.originatingThreadId != null && i.originatingThreadId !== "",
          )?.originatingThreadId;

          const prompt = buildCollectPrompt({
            title: "[Queued messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          try {
            await runFollowup({
              prompt,
              run,
              enqueuedAt: Date.now(),
              runId: primary?.runId,
              abortSignal: primary?.abortSignal,
              onAgentRunStart: primary?.onAgentRunStart,
              onSettled: primary?.onSettled
                ? (settlement) => {
                    primarySettlement = settlement;
                    settleFollowupRun(primary, settlement);
                  }
                : undefined,
              originatingChannel,
              originatingTo,
              originatingAccountId,
              originatingThreadId,
            });
          } catch (err) {
            // The run never delivered this content; retry the summary lease
            // (bounded) so the drain retry redelivers it with the retried batch.
            handleFailedSummaryLease(queue, summaryLease);
            throw err;
          }
          queue.summaryRetryCount = 0;
          // Fan the batch outcome out to the merged items: success folds them into
          // the primary run's reply; failure/abort must reach every caller. When the
          // primary carries no settlement callback (channel-originated items), the
          // reply still ran under the primary run, so merged is the closest truth.
          fanOutSettlement(
            items.filter((item) => item !== primary),
            primarySettlement,
            primary?.runId,
          );
          fanOutSettlement(summaryLease.items, primarySettlement, primary?.runId);
          // Remove the snapshot by identity. Cap eviction / new arrivals may have
          // changed the array length while this batch was running, so a length-based
          // splice would swallow later items without settling them.
          for (const item of items) {
            const index = queue.items.indexOf(item);
            if (index >= 0) {
              queue.items.splice(index, 1);
            }
          }
          continue;
        }

        const summaryLease = consumeQueueSummary(queue);
        if (summaryLease.prompt) {
          const run = queue.lastRun;
          if (!run) {
            // No run context to attach the summary to, and rescheduling cannot
            // create one; settle the leased items instead of respinning forever
            // via the finally-reschedule with droppedCount > 0.
            summaryLease.discard();
            break;
          }
          // Overflow summaries run on a standalone synthetic run. Consuming the head
          // item here would discard its prompt without ever running it, and the head
          // would never settle (the synthetic run carries no caller callbacks).
          // The runner swallows failures internally, so its settlement outcome
          // decides whether the evicted callers hear "merged" or the failure.
          let summarySettlement: FollowupRunSettlement | undefined;
          try {
            await runFollowup({
              prompt: summaryLease.prompt,
              run,
              enqueuedAt: Date.now(),
              onSettled: (settlement) => {
                summarySettlement = settlement;
              },
            });
            queue.summaryRetryCount = 0;
            fanOutSettlement(summaryLease.items, summarySettlement);
          } catch (err) {
            handleFailedSummaryLease(queue, summaryLease);
            throw err;
          }
          continue;
        }

        if (queue.droppedCount > 0 && queue.items.length === 0) {
          // droppedCount without a deliverable summary (drop policy switched away
          // from "summarize" at runtime): discard it so the drain terminates instead
          // of respinning forever on an empty queue.
          discardQueueSummary(queue);
          break;
        }

        if (!(await drainNextQueueItem(queue.items, runFollowup))) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (FOLLOWUP_QUEUES.get(key) === queue) {
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          FOLLOWUP_QUEUES.delete(key);
        } else {
          scheduleFollowupDrain(key, runFollowup);
        }
      } else {
        // The key no longer maps to this queue: a clear removed it and a new
        // message re-registered a replacement while this drain was in flight.
        // Deleting by key here would unregister the replacement and strand its
        // items with no drain ever scheduled, hanging their chat.send waits.
        // This queue is orphaned: settle its leftovers and leave the map alone.
        for (const item of queue.items.splice(0)) {
          settleFollowupRun(item, { outcome: "dropped", reason: "cleared" });
        }
        discardQueueSummary(queue);
        // Enqueue never schedules a drain (only run completion does), and a
        // followup run completing does not go through finalizeWithFollowup —
        // this orphan's exit is the last event on this key. Hand the runner to
        // the replacement so its items still drain; otherwise the client stays
        // locked on the queued run and can never produce the run completion
        // that would have scheduled it.
        if (FOLLOWUP_QUEUES.has(key)) {
          scheduleFollowupDrain(key, runFollowup);
        }
      }
    }
  })();
}
