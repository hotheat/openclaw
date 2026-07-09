import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { sanitizeToolResultsAfterHistoryLimit } from "../session-transcript-repair.js";
import { estimateAgentMessagesTokens } from "./message-token-estimate.js";
import {
  calculateMaxToolResultChars,
  getToolResultTextLength,
  getToolResultToolName,
  truncateToolResultMessage,
} from "./tool-result-truncation.js";

export const DEFAULT_TARGET_RATIO = 0.6;
const DEFAULT_PROTECTED_ASSISTANT_TURNS = 2;
const HARD_CLEAR_PLACEHOLDER = "[pruned before prompt: older large tool output removed]";

export type PreflightPruningMetrics = {
  messagesBefore: number;
  messagesAfter: number;
  historyTokensBefore: number;
  historyTokensAfter: number;
  targetHistoryTokens: number;
  toolResultCharsBefore: number;
  toolResultCharsAfter: number;
  truncatedCount: number;
  clearedCount: number;
  droppedCount: number;
};

export type PreflightPruningResult = {
  messages: AgentMessage[];
  pruned: boolean;
  metrics: PreflightPruningMetrics;
};

function sumToolResultChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += getToolResultTextLength(message);
  }
  return total;
}

function findProtectedStart(messages: AgentMessage[], protectedAssistantTurns: number): number {
  let assistantTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown }).role !== "assistant") {
      continue;
    }
    assistantTurns += 1;
    if (assistantTurns >= protectedAssistantTurns) {
      return i;
    }
  }

  const lastUserIndex = messages.findLastIndex(
    (message) => (message as { role?: unknown }).role === "user",
  );
  return lastUserIndex >= 0 ? lastUserIndex : Math.max(0, messages.length - 1);
}

function isVolatileLargeOutputTool(toolName: string | undefined): boolean {
  return (
    toolName === "web_fetch" ||
    toolName === "web_search" ||
    toolName === "exec" ||
    toolName === "bash" ||
    toolName === "shell" ||
    toolName === "browser"
  );
}

function replaceToolResultText(message: AgentMessage, text: string): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const truncation = (message as { openclawToolResultTruncation?: { originalChars?: unknown } })
    .openclawToolResultTruncation;
  const originalChars =
    typeof truncation?.originalChars === "number"
      ? truncation.originalChars
      : getToolResultTextLength(message);
  const sourceRecord = message as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: [{ type: "text", text }],
    openclawToolResultPruning: {
      action: "hard_clear",
      toolName: getToolResultToolName(message),
      originalChars,
      keptChars: text.length,
      timestamp: Date.now(),
    },
  } as unknown as AgentMessage;
}

function buildMetrics(params: {
  originalMessages: AgentMessage[];
  messages: AgentMessage[];
  targetHistoryTokens: number;
  truncatedCount: number;
  clearedCount: number;
}): PreflightPruningMetrics {
  return {
    messagesBefore: params.originalMessages.length,
    messagesAfter: params.messages.length,
    historyTokensBefore: estimateAgentMessagesTokens(params.originalMessages),
    historyTokensAfter: estimateAgentMessagesTokens(params.messages),
    targetHistoryTokens: params.targetHistoryTokens,
    toolResultCharsBefore: sumToolResultChars(params.originalMessages),
    toolResultCharsAfter: sumToolResultChars(params.messages),
    truncatedCount: params.truncatedCount,
    clearedCount: params.clearedCount,
    droppedCount: params.originalMessages.length - params.messages.length,
  };
}

export function pruneMessagesBeforePreflight(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  repairToolUseResultPairing: boolean;
  targetRatio?: number;
  /**
   * Explicit history-token budget. When provided it overrides {@link targetRatio}
   * so callers that know the remaining budget (e.g. emergency recovery that
   * subtracts prompt/system/tools/images/reserve) can request a history target
   * tighter than the default 0.6 ratio. Falls back to the ratio otherwise.
   */
  targetHistoryTokens?: number;
  protectedAssistantTurns?: number;
}): PreflightPruningResult {
  const targetHistoryTokens =
    typeof params.targetHistoryTokens === "number" && Number.isFinite(params.targetHistoryTokens)
      ? Math.max(1, Math.floor(params.targetHistoryTokens))
      : Math.max(
          1,
          Math.floor(
            Math.max(1, params.contextWindowTokens) * (params.targetRatio ?? DEFAULT_TARGET_RATIO),
          ),
        );
  const historyTokensBefore = estimateAgentMessagesTokens(params.messages);
  const unchangedMetrics = buildMetrics({
    originalMessages: params.messages,
    messages: params.messages,
    targetHistoryTokens,
    truncatedCount: 0,
    clearedCount: 0,
  });

  if (historyTokensBefore <= targetHistoryTokens) {
    return { messages: params.messages, pruned: false, metrics: unchangedMetrics };
  }

  const originalMessages = params.messages;
  let messages = params.messages.slice();
  const protectedStart = findProtectedStart(
    messages,
    Math.max(1, Math.floor(params.protectedAssistantTurns ?? DEFAULT_PROTECTED_ASSISTANT_TURNS)),
  );
  let truncatedCount = 0;
  let clearedCount = 0;

  for (let i = 0; i < protectedStart; i++) {
    const message = messages[i];
    if ((message as { role?: unknown }).role !== "toolResult") {
      continue;
    }
    const toolName = getToolResultToolName(message);
    const maxChars = calculateMaxToolResultChars(params.contextWindowTokens, toolName);
    if (getToolResultTextLength(message) <= maxChars) {
      continue;
    }
    messages[i] = truncateToolResultMessage(message, maxChars, { toolName });
    truncatedCount += 1;
  }

  let currentTokens = estimateAgentMessagesTokens(messages);
  if (currentTokens > targetHistoryTokens) {
    for (let i = 0; i < protectedStart; i++) {
      const message = messages[i];
      if ((message as { role?: unknown }).role !== "toolResult") {
        continue;
      }
      const toolName = getToolResultToolName(message);
      if (!isVolatileLargeOutputTool(toolName)) {
        continue;
      }
      if (getToolResultTextLength(message) <= HARD_CLEAR_PLACEHOLDER.length) {
        continue;
      }
      messages[i] = replaceToolResultText(message, HARD_CLEAR_PLACEHOLDER);
      clearedCount += 1;
      currentTokens = estimateAgentMessagesTokens(messages);
      if (currentTokens <= targetHistoryTokens) {
        break;
      }
    }
  }

  if (currentTokens > targetHistoryTokens && protectedStart > 0) {
    const dropBaseline = messages;
    let selectedCandidate: AgentMessage[] | null = null;
    let selectedTokens = currentTokens;
    for (let dropCount = 1; dropCount <= protectedStart; dropCount++) {
      const candidate = sanitizeToolResultsAfterHistoryLimit({
        messages: dropBaseline.slice(dropCount),
        repairToolUseResultPairing: params.repairToolUseResultPairing,
      });
      const candidateTokens = estimateAgentMessagesTokens(candidate);
      if (candidateTokens <= targetHistoryTokens || dropCount === protectedStart) {
        selectedCandidate = candidate;
        selectedTokens = candidateTokens;
      }
      if (candidateTokens <= targetHistoryTokens) {
        break;
      }
    }
    if (selectedCandidate) {
      messages = selectedCandidate;
      currentTokens = selectedTokens;
    }
  }

  const metrics = buildMetrics({
    originalMessages,
    messages,
    targetHistoryTokens,
    truncatedCount,
    clearedCount,
  });

  return {
    messages,
    pruned:
      metrics.truncatedCount > 0 ||
      metrics.clearedCount > 0 ||
      metrics.droppedCount > 0 ||
      metrics.historyTokensAfter < metrics.historyTokensBefore,
    metrics,
  };
}
