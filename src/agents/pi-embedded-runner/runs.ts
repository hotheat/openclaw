import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
type PendingEmbeddedRunToken = {
  id: number;
  sessionId: string;
  sessionKey?: string;
  consumed: boolean;
  cleared: boolean;
  abortSignal: AbortSignal;
  abort: (reason?: unknown) => void;
};
type PendingEmbeddedRunState = {
  tokens: PendingEmbeddedRunToken[];
  sessionKey?: string;
};
const PENDING_EMBEDDED_RUNS = new Map<string, PendingEmbeddedRunState>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();
let nextPendingEmbeddedRunId = 1;

function getPendingEmbeddedRunCount(sessionId: string): number {
  return PENDING_EMBEDDED_RUNS.get(sessionId)?.tokens.length ?? 0;
}

function hasPendingEmbeddedRun(sessionId: string): boolean {
  return getPendingEmbeddedRunCount(sessionId) > 0;
}

function isEmbeddedPiRunBusy(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.has(sessionId) || hasPendingEmbeddedRun(sessionId);
}

function deletePendingStateIfEmpty(sessionId: string) {
  if (getPendingEmbeddedRunCount(sessionId) === 0) {
    PENDING_EMBEDDED_RUNS.delete(sessionId);
  }
}

function abortPendingEmbeddedRunToken(token: PendingEmbeddedRunToken, reason?: unknown) {
  if (token.abortSignal.aborted) {
    return;
  }
  token.abort(reason);
}

function cancelPendingEmbeddedRuns(sessionId: string, reason: string, sessionKey?: string): number {
  const pendingState = PENDING_EMBEDDED_RUNS.get(sessionId);
  if (!pendingState || pendingState.tokens.length === 0) {
    return 0;
  }
  const tokens = pendingState.tokens.slice();
  PENDING_EMBEDDED_RUNS.delete(sessionId);
  for (const token of tokens) {
    token.cleared = true;
    abortPendingEmbeddedRunToken(token, reason);
  }
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    logSessionStateChange({
      sessionId,
      sessionKey: sessionKey ?? pendingState.sessionKey,
      state: "idle",
      reason,
    });
    notifyEmbeddedRunEnded(sessionId);
  }
  if (!sessionId.startsWith("probe-")) {
    diag.debug(
      `run pending cancelled: sessionId=${sessionId} count=${tokens.length} active=${ACTIVE_EMBEDDED_RUNS.has(
        sessionId,
      )} reason=${reason}`,
    );
  }
  return tokens.length;
}

export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  return steerEmbeddedPiRun(sessionId, text).status === "accepted";
}

export type EmbeddedPiSteerResult =
  | { status: "accepted" }
  | {
      status: "not_steerable";
      reason: "run_inactive" | "not_streaming" | "compacting";
    };

export function steerEmbeddedPiRun(sessionId: string, text: string): EmbeddedPiSteerResult {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return { status: "not_steerable", reason: "run_inactive" };
  }
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return { status: "not_steerable", reason: "not_streaming" };
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return { status: "not_steerable", reason: "compacting" };
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return { status: "accepted" };
}

export function isEmbeddedPiRunCompacting(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.get(sessionId)?.isCompacting() ?? false;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const pendingCancelled = cancelPendingEmbeddedRuns(sessionId, "run_pending_cancelled");
  if (!handle) {
    if (pendingCancelled > 0) {
      diag.debug(`aborting pending run: sessionId=${sessionId} cancelled=${pendingCancelled}`);
      return true;
    }
    diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run pendingCount=0`);
    return false;
  }
  diag.debug(`aborting run: sessionId=${sessionId} pendingCancelled=${pendingCancelled}`);
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  const pendingCount = getPendingEmbeddedRunCount(sessionId);
  if (active || pendingCount > 0) {
    diag.debug(
      `run active check: sessionId=${sessionId} active=${active} pendingCount=${pendingCount}`,
    );
  }
  return active || pendingCount > 0;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming();
}

export function getActiveEmbeddedRunCount(): number {
  return ACTIVE_EMBEDDED_RUNS.size;
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !isEmbeddedPiRunBusy(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!isEmbeddedPiRunBusy(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  const pendingState = PENDING_EMBEDDED_RUNS.get(sessionId);
  const pendingToken = pendingState?.tokens.shift();
  if (pendingToken) {
    pendingToken.consumed = true;
    deletePendingStateIfEmpty(sessionId);
  }
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  logSessionStateChange({
    sessionId,
    sessionKey,
    state: "processing",
    reason: wasActive ? "run_replaced" : pendingToken ? "run_started_from_pending" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(
      `run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size} pendingCount=${getPendingEmbeddedRunCount(
        sessionId,
      )}`,
    );
  }
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    const pendingCount = getPendingEmbeddedRunCount(sessionId);
    if (pendingCount > 0) {
      logSessionStateChange({
        sessionId,
        sessionKey,
        state: "waiting",
        reason: "run_completed_pending",
      });
    } else {
      logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "run_completed" });
      notifyEmbeddedRunEnded(sessionId);
    }
    if (!sessionId.startsWith("probe-")) {
      diag.debug(
        `run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size} pendingCount=${pendingCount}`,
      );
    }
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

export function registerPendingEmbeddedRun(
  sessionId: string,
  sessionKey?: string,
): PendingEmbeddedRunToken {
  const state = PENDING_EMBEDDED_RUNS.get(sessionId) ?? { tokens: [], sessionKey };
  state.sessionKey = sessionKey ?? state.sessionKey;
  const controller = new AbortController();
  const token: PendingEmbeddedRunToken = {
    id: nextPendingEmbeddedRunId++,
    sessionId,
    sessionKey: sessionKey ?? state.sessionKey,
    consumed: false,
    cleared: false,
    abortSignal: controller.signal,
    abort: controller.abort.bind(controller),
  };
  state.tokens.push(token);
  PENDING_EMBEDDED_RUNS.set(sessionId, state);
  logSessionStateChange({
    sessionId,
    sessionKey: token.sessionKey,
    state: ACTIVE_EMBEDDED_RUNS.has(sessionId) ? "processing" : "waiting",
    reason: ACTIVE_EMBEDDED_RUNS.has(sessionId) ? "run_pending_while_active" : "run_pending",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(
      `run pending registered: sessionId=${sessionId} pendingCount=${state.tokens.length} active=${ACTIVE_EMBEDDED_RUNS.has(
        sessionId,
      )}`,
    );
  }
  return token;
}

export function clearPendingEmbeddedRun(token: PendingEmbeddedRunToken): boolean {
  if (token.consumed || token.cleared) {
    return false;
  }
  const state = PENDING_EMBEDDED_RUNS.get(token.sessionId);
  if (!state) {
    token.cleared = true;
    return false;
  }
  const nextTokens = state.tokens.filter((entry) => entry.id !== token.id);
  if (nextTokens.length === state.tokens.length) {
    token.cleared = true;
    return false;
  }
  state.tokens = nextTokens;
  token.cleared = true;
  deletePendingStateIfEmpty(token.sessionId);
  const pendingCount = getPendingEmbeddedRunCount(token.sessionId);
  const hasActive = ACTIVE_EMBEDDED_RUNS.has(token.sessionId);
  if (!hasActive && pendingCount > 0) {
    logSessionStateChange({
      sessionId: token.sessionId,
      sessionKey: token.sessionKey ?? state.sessionKey,
      state: "waiting",
      reason: "pending_updated",
    });
  } else if (!hasActive) {
    logSessionStateChange({
      sessionId: token.sessionId,
      sessionKey: token.sessionKey ?? state.sessionKey,
      state: "idle",
      reason: "pending_cleared",
    });
    notifyEmbeddedRunEnded(token.sessionId);
  }
  if (!token.sessionId.startsWith("probe-")) {
    diag.debug(
      `run pending cleared: sessionId=${token.sessionId} pendingCount=${pendingCount} active=${hasActive}`,
    );
  }
  return true;
}

export function isPendingEmbeddedRunCancelled(token: PendingEmbeddedRunToken): boolean {
  return token.abortSignal.aborted;
}

export function getPendingEmbeddedRunAbortSignal(token: PendingEmbeddedRunToken): AbortSignal {
  return token.abortSignal;
}

export type { EmbeddedPiQueueHandle, PendingEmbeddedRunToken };
