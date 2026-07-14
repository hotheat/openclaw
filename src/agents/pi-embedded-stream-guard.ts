export type AssistantStreamLimitReason =
  | "total_chars"
  | "consecutive_whitespace_chars"
  | "consecutive_whitespace_events"
  | "consecutive_whitespace_duration";

export type AssistantStreamLimits = {
  maxTotalChars: number;
  maxConsecutiveWhitespaceChars: number;
  maxConsecutiveWhitespaceEvents: number;
  maxConsecutiveWhitespaceMs: number;
};

export type AssistantStreamGuardState = {
  totalChars: number;
  consecutiveWhitespaceChars: number;
  consecutiveWhitespaceEvents: number;
  whitespaceStartedAt?: number;
  aborted: boolean;
  abortReason?: AssistantStreamLimitReason;
};

export type AssistantStreamGuardResult = {
  whitespaceOnly: boolean;
  abortReason?: AssistantStreamLimitReason;
};

export const DEFAULT_ASSISTANT_STREAM_LIMITS: AssistantStreamLimits = {
  maxTotalChars: 1_000_000,
  maxConsecutiveWhitespaceChars: 64 * 1024,
  maxConsecutiveWhitespaceEvents: 256,
  maxConsecutiveWhitespaceMs: 30_000,
};

export function createAssistantStreamGuardState(): AssistantStreamGuardState {
  return {
    totalChars: 0,
    consecutiveWhitespaceChars: 0,
    consecutiveWhitespaceEvents: 0,
    whitespaceStartedAt: undefined,
    aborted: false,
    abortReason: undefined,
  };
}

function abortGuard(
  state: AssistantStreamGuardState,
  reason: AssistantStreamLimitReason,
): AssistantStreamGuardResult {
  state.aborted = true;
  state.abortReason = reason;
  return { whitespaceOnly: false, abortReason: reason };
}

export function inspectAssistantStreamChunk(params: {
  state: AssistantStreamGuardState;
  chunk: string;
  now?: number;
  limits?: AssistantStreamLimits;
}): AssistantStreamGuardResult {
  const { state, chunk } = params;
  if (state.aborted) {
    return { whitespaceOnly: false };
  }

  const limits = params.limits ?? DEFAULT_ASSISTANT_STREAM_LIMITS;
  const now = params.now ?? Date.now();
  state.totalChars += chunk.length;
  if (state.totalChars > limits.maxTotalChars) {
    return abortGuard(state, "total_chars");
  }

  const whitespaceOnly = chunk.trim().length === 0;
  if (!whitespaceOnly) {
    state.consecutiveWhitespaceChars = 0;
    state.consecutiveWhitespaceEvents = 0;
    state.whitespaceStartedAt = undefined;
    return { whitespaceOnly: false };
  }

  state.consecutiveWhitespaceChars += chunk.length;
  state.consecutiveWhitespaceEvents += 1;
  state.whitespaceStartedAt ??= now;

  if (state.consecutiveWhitespaceChars > limits.maxConsecutiveWhitespaceChars) {
    return abortGuard(state, "consecutive_whitespace_chars");
  }
  if (state.consecutiveWhitespaceEvents > limits.maxConsecutiveWhitespaceEvents) {
    return abortGuard(state, "consecutive_whitespace_events");
  }
  if (now - state.whitespaceStartedAt > limits.maxConsecutiveWhitespaceMs) {
    return abortGuard(state, "consecutive_whitespace_duration");
  }

  return { whitespaceOnly: true };
}

export function createAssistantStreamLimitError(params: {
  reason: AssistantStreamLimitReason;
  state: AssistantStreamGuardState;
}): Error {
  const error = new Error(
    `Upstream assistant stream exceeded safety limits: reason=${params.reason} ` +
      `totalChars=${params.state.totalChars} ` +
      `whitespaceChars=${params.state.consecutiveWhitespaceChars} ` +
      `whitespaceEvents=${params.state.consecutiveWhitespaceEvents}`,
  );
  error.name = "AssistantStreamLimitError";
  return error;
}
