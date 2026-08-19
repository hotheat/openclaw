import type { DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode, SubagentCompletionDelivery } from "./subagent-spawn.js";

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  sessionLabel?: string;
  model?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  taskFlowId?: string;
  trackingTaskFlowId?: string;
  createdAt: number;
  startedAt?: number;
  /** Earliest accepted start boundary used to reject terminal snapshots from an older generation. */
  generationStartedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  completionDelivery?: SubagentCompletionDelivery;
  /** Browser-visible sessions_spawn tool call that created this run. */
  sourceToolCallId?: string;
  /** Number of announce delivery attempts that returned false (deferred). */
  announceRetryCount?: number;
  /** Timestamp of the last announce retry attempt (for backoff). */
  lastAnnounceRetryAt?: number;
  /** Terminal lifecycle reason recorded when the run finishes. */
  endedReason?: SubagentLifecycleEndedReason;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Ignore stale transcript terminal errors at or before this timestamp. */
  staleTerminalContinuationAfterMs?: number;
  /** Original wait deadline for stale-terminal re-arm recovery. */
  staleTerminalWaitDeadlineMs?: number;
};
