import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;

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
