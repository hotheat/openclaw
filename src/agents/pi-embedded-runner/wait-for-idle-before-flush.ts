import type { PendingToolCall } from "../session-tool-result-guard.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => PendingToolCall[]) | undefined;
  getPendingToolCalls?: (() => PendingToolCall[]) | undefined;
};

export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS = 1_000;

export type ToolWaitStatus =
  | "idle"
  | "idle_after_abort"
  | "aborted"
  | "timeout"
  | "unsupported"
  | "error";

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<Exclude<ToolWaitStatus, "idle_after_abort">> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return "unsupported";
  }
  if (abortSignal?.aborted) {
    return "aborted";
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const waiters: Array<Promise<"idle" | "timeout" | "aborted">> = [
      waitForIdle.call(agent).then(() => "idle" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ];
    if (abortSignal) {
      waiters.push(
        new Promise<"aborted">((resolve) => {
          abortHandler = () => resolve("aborted");
          abortSignal.addEventListener("abort", abortHandler, { once: true });
          if (abortSignal.aborted) {
            abortHandler();
          }
        }),
      );
    }
    return await Promise.race(waiters);
  } catch {
    // Best-effort during cleanup.
    return "error";
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  abortAgent?: (() => Promise<void> | void) | undefined;
  abortSettlementTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{
  waitStatus: ToolWaitStatus;
  pendingBeforeFlush: PendingToolCall[];
  syntheticResults: PendingToolCall[];
}> {
  let waitStatus: ToolWaitStatus = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
    opts.abortSignal,
  );

  /*
   * Stop an agent that did not settle before the caller's deadline. Pending
   * tool calls are not a reliable activity signal because the agent may be
   * generating the final assistant response after all tool results landed.
   */
  const waitWasAborted = waitStatus === "aborted";
  let shouldWaitForAbortSettlement = waitWasAborted;
  if (waitStatus === "timeout" && opts.abortAgent) {
    try {
      const abortPromise = opts.abortAgent();
      if (abortPromise) {
        void abortPromise.catch(() => {
          // The bounded idle check below determines whether cleanup can safely flush.
        });
      }
      shouldWaitForAbortSettlement = true;
    } catch {
      waitStatus = "error";
    }
  }
  if (shouldWaitForAbortSettlement) {
    const abortWaitStatus = await waitForAgentIdleBestEffort(
      opts.agent,
      opts.abortSettlementTimeoutMs ?? DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS,
    );
    waitStatus =
      abortWaitStatus === "idle"
        ? "idle_after_abort"
        : waitWasAborted && abortWaitStatus === "timeout"
          ? "aborted"
          : abortWaitStatus;
  }

  const pendingBeforeFlush = opts.sessionManager?.getPendingToolCalls?.() ?? [];
  const canFlush = waitStatus !== "aborted" && waitStatus !== "timeout" && waitStatus !== "error";
  const syntheticResults = canFlush ? (opts.sessionManager?.flushPendingToolResults?.() ?? []) : [];
  return { waitStatus, pendingBeforeFlush, syntheticResults };
}
