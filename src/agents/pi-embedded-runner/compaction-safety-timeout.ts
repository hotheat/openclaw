import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;
export const EMBEDDED_COMPACTION_ABORT_GRACE_MS = 10_000;

export type CompactWithSafetyTimeoutOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

function abortSignalToPromise(
  signal: AbortSignal | undefined,
): { promise: Promise<never>; cleanup: () => void } | undefined {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    return {
      promise: Promise.reject(signal.reason ?? new Error("Compaction aborted")),
      cleanup: () => {},
    };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Compaction aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  optionsOrTimeoutMs: number | CompactWithSafetyTimeoutOptions = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  const options =
    typeof optionsOrTimeoutMs === "number" ? { timeoutMs: optionsOrTimeoutMs } : optionsOrTimeoutMs;
  const abort = abortSignalToPromise(options.signal);
  try {
    return await withTimeout(
      async () => {
        const compactPromise = compact();
        if (!abort) {
          return await compactPromise;
        }
        return await Promise.race([compactPromise, abort.promise]);
      },
      options.timeoutMs ?? EMBEDDED_COMPACTION_TIMEOUT_MS,
      "Compaction",
    );
  } finally {
    abort?.cleanup();
  }
}

export async function waitForCompactionAbortSettlement<T>(
  compactPromise: Promise<T>,
  timeoutMs = EMBEDDED_COMPACTION_ABORT_GRACE_MS,
): Promise<"settled" | "timed_out"> {
  const resolvedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), resolvedTimeoutMs);
    timer.unref?.();
  });
  const settledPromise = compactPromise.then(
    () => "settled" as const,
    () => "settled" as const,
  );

  const result = await Promise.race([settledPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timed_out") {
    compactPromise.catch(() => undefined);
  }
  return result;
}
