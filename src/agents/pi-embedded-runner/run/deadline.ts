export type EmbeddedRunDeadlineExtension = {
  extended: boolean;
  deadlineAt: number;
  maxDeadlineAt: number;
};

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function createEmbeddedRunDeadline(params: { timeoutMs: number; onTimeout: () => void }) {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const startedAt = Date.now();
  const maxDeadlineAt = startedAt + timeoutMs * 2;
  let deadlineAt = startedAt + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const arm = () => {
    if (closed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    const delayMs = Math.max(1, deadlineAt - Date.now());
    timer = setTimeout(
      () => {
        timer = undefined;
        if (Date.now() < deadlineAt) {
          arm();
          return;
        }
        closed = true;
        params.onTimeout();
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS),
    );
  };

  arm();

  return {
    extendForContinuation(): EmbeddedRunDeadlineExtension {
      if (closed) {
        return { extended: false, deadlineAt, maxDeadlineAt };
      }
      if (Date.now() >= deadlineAt || deadlineAt >= maxDeadlineAt) {
        return { extended: false, deadlineAt, maxDeadlineAt };
      }
      deadlineAt = maxDeadlineAt;
      arm();
      return { extended: true, deadlineAt, maxDeadlineAt };
    },

    remainingMs(): number {
      return Math.max(1, deadlineAt - Date.now());
    },

    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
