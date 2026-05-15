import type { EmbeddedRunAttemptResult } from "./types.js";

export type RunCompletionClass =
  | "completed"
  | "tool_calls"
  | "empty_result"
  | "non_terminal_text"
  | "failed_but_incomplete";

export type RunCompletionRecoveryAction =
  | "none"
  | "retry_same_step"
  | "switch_strategy"
  | "finalize_partial";

export type RunCompletionAssessment = {
  classification: RunCompletionClass;
  recoveryAction: RunCompletionRecoveryAction;
  reason: string;
};

const NON_TERMINAL_TEXT_MAX_CHARS = 160;
const NON_TERMINAL_PATTERNS = [
  /^(?:我会|我将|我再|接着|随后).{0,80}(?:继续|再|随后|接着|分析|检查|排查|处理|执行|推进|尝试|重试|试)/iu,
  /^正在.{0,80}(?:分析|检查|排查|处理|执行|整理|重试|继续)/iu,
  /^下一步.{0,80}(?:继续|再|分析|检查|排查|处理|执行|推进|尝试|重试|试)/iu,
  /^next\s+step.{0,80}(?:continue|retry|keep|try|investigate|check|look)/iu,
  /^i(?:'|’)ll\s+(?:continue|retry|keep|try|investigate|check|look)\b/iu,
  /^(?:continue|retry|keep trying|investigat(?:e|ing)|checking)\b/iu,
] as const;

function normalizeText(text: string | undefined): string {
  return typeof text === "string" ? text.trim() : "";
}

function hasUserFacingReply(attempt: EmbeddedRunAttemptResult): boolean {
  if (attempt.didSendViaMessagingTool) {
    return true;
  }
  return attempt.assistantTexts.some((text) => normalizeText(text).length > 0);
}

function looksNonTerminal(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (normalized.length > NON_TERMINAL_TEXT_MAX_CHARS) {
    return false;
  }
  const compact = normalized.replace(/\s+/gu, " ");
  return NON_TERMINAL_PATTERNS.some((pattern) => pattern.test(compact));
}

function getLastAssistantText(attempt: EmbeddedRunAttemptResult): string {
  for (let i = attempt.assistantTexts.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeText(attempt.assistantTexts[i]);
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

export function isCompletionContractEnabled(params: {
  sessionKey?: string;
  agentId?: string;
}): boolean {
  const sessionKey = params.sessionKey?.trim() ?? "";
  const agentId = params.agentId?.trim() ?? "";
  return sessionKey.includes(":subagent:") || agentId === "researcher";
}

export function buildCompletionContinuationPrompt(params: {
  assessment: RunCompletionAssessment;
  attempt: EmbeddedRunAttemptResult;
  retryIndex: number;
}): string {
  const lines = [
    "Your previous reply did not satisfy the run completion contract.",
    "Do not send another progress update.",
    "Finish this same task now.",
  ];

  if (params.assessment.classification === "failed_but_incomplete") {
    const toolName = params.attempt.lastToolError?.toolName?.trim() || "unknown_tool";
    const toolError = params.attempt.lastToolError?.error?.trim();
    lines.push(`Recent tool failure: ${toolName}${toolError ? ` - ${toolError}` : ""}.`);
    lines.push(
      "Either switch strategy and continue, or provide a partial/failure handoff with concrete findings and the blocker.",
    );
  } else if (params.assessment.classification === "empty_result") {
    lines.push("Your previous turn ended without a user-facing result.");
    lines.push("Continue immediately and return the actual result in this turn.");
  } else {
    lines.push(
      "Your previous message looked like commentary about future work instead of a completed result.",
    );
    lines.push("Continue immediately and produce the actual result in this turn.");
  }

  if (params.retryIndex >= 1) {
    lines.push(
      "This is the last retry. If you still cannot complete the task, return a concise partial result and clearly state the blocker.",
    );
  }

  return lines.join("\n");
}

export function assessRunCompletion(attempt: EmbeddedRunAttemptResult): RunCompletionAssessment {
  if (attempt.clientToolCall) {
    return {
      classification: "tool_calls",
      recoveryAction: "none",
      reason: "client tool call pending",
    };
  }

  const lastAssistantText = getLastAssistantText(attempt);
  const hasReply = hasUserFacingReply(attempt);

  if (attempt.lastToolError && !hasReply) {
    return {
      classification: "failed_but_incomplete",
      recoveryAction: "switch_strategy",
      reason: "tool failed without any user-facing result",
    };
  }

  if (!hasReply) {
    return {
      classification: "empty_result",
      recoveryAction: "retry_same_step",
      reason: "assistant produced no user-facing result",
    };
  }

  if (attempt.lastToolError && looksNonTerminal(lastAssistantText)) {
    return {
      classification: "failed_but_incomplete",
      recoveryAction: "switch_strategy",
      reason: "tool failed and assistant only promised follow-up work",
    };
  }

  if (looksNonTerminal(lastAssistantText)) {
    return {
      classification: "non_terminal_text",
      recoveryAction: "retry_same_step",
      reason: "assistant reply looked like progress text, not a completed result",
    };
  }

  return {
    classification: "completed",
    recoveryAction: "none",
    reason: hasReply ? "assistant produced a user-facing result" : "no completion contract trigger",
  };
}
