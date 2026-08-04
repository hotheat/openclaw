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

export type ToolWaitStatus = "idle" | "idle_after_abort" | "timeout" | "unsupported" | "error";

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<Exclude<ToolWaitStatus, "idle_after_abort">> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return "unsupported";
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForIdle.call(agent).then(() => "idle" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
  } catch {
    // Best-effort during cleanup.
    return "error";
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  abortAgent?: (() => Promise<void> | void) | undefined;
  abortSettlementTimeoutMs?: number;
}): Promise<{
  waitStatus: ToolWaitStatus;
  pendingBeforeFlush: PendingToolCall[];
  syntheticResults: PendingToolCall[];
}> {
  let waitStatus: ToolWaitStatus = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
  );

  /*
   * ======== 步骤1：终止迟迟未收敛的工具执行 ========
   * 目标：避免 synthetic result 写入后，旧工具又写入同一个 toolCallId。
   * 1) 只有确实存在 pending 调用时才中止 agent。
   * 2) 中止后再等待一个短暂收敛窗口。
   */
  const pendingAfterWait = opts.sessionManager?.getPendingToolCalls?.() ?? [];
  if (waitStatus === "timeout" && pendingAfterWait.length > 0 && opts.abortAgent) {
    try {
      const abortPromise = opts.abortAgent();
      if (abortPromise) {
        void abortPromise.catch(() => {
          // The bounded idle check below determines whether cleanup can safely flush.
        });
      }
      const abortWaitStatus = await waitForAgentIdleBestEffort(
        opts.agent,
        opts.abortSettlementTimeoutMs ?? DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS,
      );
      waitStatus = abortWaitStatus === "idle" ? "idle_after_abort" : abortWaitStatus;
    } catch {
      waitStatus = "error";
    }
  }

  const pendingBeforeFlush = opts.sessionManager?.getPendingToolCalls?.() ?? [];
  const canFlush = waitStatus !== "timeout" && waitStatus !== "error";
  const syntheticResults = canFlush ? (opts.sessionManager?.flushPendingToolResults?.() ?? []) : [];
  return { waitStatus, pendingBeforeFlush, syntheticResults };
}
