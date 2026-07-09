import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type SessionEntry, type SessionManager } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import {
  dropOrphanedToolResults,
  repairToolUseResultPairing,
} from "../session-transcript-repair.js";
import { estimateAgentMessagesTokens } from "./message-token-estimate.js";
import {
  calculateMaxToolResultChars,
  getToolResultTextLength,
  getToolResultToolName,
  truncateToolResultMessage,
} from "./tool-result-truncation.js";

export type EmergencyCompactionReason =
  | "timeout"
  | "summary_budget_exhausted"
  | "context_overflow_after_compaction"
  | "compaction_error";

export type EmergencyCompactionDetails = {
  kind: "openclaw.emergency_compaction";
  runId: string;
  emergencyId: string;
  reason: EmergencyCompactionReason;
  preLeafId: string | null;
  preCompactionCount: number;
  originalFirstKeptEntryId: string;
  firstKeptEntryId: string;
  contextWindowTokens: number;
  originalMessageCount: number;
  tailBudgetTokens?: number;
  keptTokens?: number;
  largeToolOutputs?: LargeToolOutputSummary[];
};

export type AppendEmergencyCompactionParams = {
  sessionManager: SessionManager;
  runId: string;
  reason: EmergencyCompactionReason;
  contextWindowTokens: number;
  repairToolUseResultPairing: boolean;
  keepRecentTokens?: number;
  keepRecentUserTurns?: number;
  preLeafId?: string | null;
  preCompactionCount?: number;
  emergencyId?: string;
};

export type AppendEmergencyCompactionResult = {
  appended: boolean;
  rebuiltMessages: AgentMessage[];
  firstKeptEntryId: string | null;
  originalFirstKeptEntryId: string | null;
  tokensBefore: number;
  reason: EmergencyCompactionReason | "already_compacted" | "no_kept_entries";
};

type ContextEntry = {
  entry: SessionEntry;
  message?: AgentMessage;
};

const CONTEXT_ENTRY_SYMBOL = Symbol("openclaw.emergencyCompaction.contextEntry");

type ContextAgentMessage = AgentMessage & {
  [CONTEXT_ENTRY_SYMBOL]?: SessionEntry;
};

type LargeToolOutputSummary = {
  action: "dropped" | "truncated";
  toolName?: string;
  toolCallId?: string;
  originalChars: number;
  keptChars: number;
};

type KeptSelection = {
  keptStart: number;
  messages: AgentMessage[];
  tailBudgetTokens: number;
  keptTokens: number;
  largeToolOutputs: LargeToolOutputSummary[];
};

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const EMERGENCY_TAIL_CONTEXT_SHARE = 0.3;
const EMERGENCY_TAIL_HARD_CAP_TOKENS = 60_000;

function timestampToMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function attachSourceEntry(message: AgentMessage, entry: SessionEntry): AgentMessage {
  Object.defineProperty(message, CONTEXT_ENTRY_SYMBOL, {
    configurable: false,
    enumerable: false,
    value: entry,
  });
  return message;
}

function getSourceEntry(message: AgentMessage): SessionEntry | undefined {
  return (message as ContextAgentMessage)[CONTEXT_ENTRY_SYMBOL];
}

function getContextMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return attachSourceEntry(
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: timestampToMillis(entry.timestamp),
      } as AgentMessage,
      entry,
    );
  }
  if (entry.type === "branch_summary") {
    return attachSourceEntry(
      {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: timestampToMillis(entry.timestamp),
      } as AgentMessage,
      entry,
    );
  }
  return undefined;
}

function isContextEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
  );
}

function getContextEntries(branchEntries: SessionEntry[]): ContextEntry[] {
  const out: ContextEntry[] = [];
  for (const entry of branchEntries) {
    if (!isContextEntry(entry)) {
      continue;
    }
    out.push({ entry, message: getContextMessageFromEntry(entry) });
  }
  return out;
}

export function resolveFirstKeptEntryId(
  branchEntries: SessionEntry[],
  keptMessageBoundary: number,
): string | null {
  const contextEntries = getContextEntries(branchEntries);
  const index = Math.max(0, Math.floor(keptMessageBoundary));
  return contextEntries[index]?.entry.id ?? null;
}

function countCompactionEntries(entries: SessionEntry[]): number {
  return entries.filter((entry) => entry.type === "compaction").length;
}

/**
 * Detect whether any compaction entry was appended after the recovery baseline.
 *
 * The baseline (`preCompactionCount`) is captured before the failed compaction
 * attempt, so any compaction that exists past it — whether a prior emergency
 * from this same run or a late-settling normal SDK compaction that committed
 * during the abort grace window — means the history is already compacted.
 * Appending again on top of it would produce a duplicate compaction summary and
 * an extra deterministic tail-drop on already-compacted history, so we bail.
 */
function hasCompactedSinceBaseline(params: {
  entries: SessionEntry[];
  preCompactionCount: number;
}): boolean {
  return countCompactionEntries(params.entries) > params.preCompactionCount;
}

function alreadyCompactedResult(params: {
  sessionManager: SessionManager;
  tokensBefore?: number;
}): AppendEmergencyCompactionResult {
  return {
    appended: false,
    rebuiltMessages: params.sessionManager.buildSessionContext().messages,
    firstKeptEntryId: null,
    originalFirstKeptEntryId: null,
    tokensBefore: params.tokensBefore ?? 0,
    reason: "already_compacted",
  };
}

function selectKeptContextStart(
  contextEntries: ContextEntry[],
  keepRecentUserTurns: number,
): number {
  let remainingUserTurns = Math.max(1, Math.floor(keepRecentUserTurns));
  for (let i = contextEntries.length - 1; i >= 0; i -= 1) {
    const message = contextEntries[i]?.message;
    if (message?.role !== "user") {
      continue;
    }
    remainingUserTurns -= 1;
    if (remainingUserTurns <= 0) {
      return i;
    }
  }
  return Math.max(0, contextEntries.length - 1);
}

function calculateTailBudgetTokens(params: {
  contextWindowTokens: number;
  keepRecentTokens?: number;
}): number {
  const keepRecentTokens =
    typeof params.keepRecentTokens === "number" && Number.isFinite(params.keepRecentTokens)
      ? Math.max(1, Math.floor(params.keepRecentTokens))
      : DEFAULT_KEEP_RECENT_TOKENS;
  // `Math.max(1, undefined)` is NaN, not 1, so a missing/NaN context window
  // (e.g. a model without metadata) would poison the whole tail budget and the
  // `keptTokens > tailBudget` checks would never fire — leaving the oversized
  // tail intact and defeating the recovery. Coerce non-finite input to a safe
  // default before it reaches the Math.min chain.
  const contextWindowTokens =
    typeof params.contextWindowTokens === "number" &&
    Number.isFinite(params.contextWindowTokens) &&
    params.contextWindowTokens > 0
      ? Math.max(1, Math.floor(params.contextWindowTokens))
      : DEFAULT_CONTEXT_TOKENS;
  return Math.max(
    1,
    Math.min(
      keepRecentTokens,
      Math.floor(contextWindowTokens * EMERGENCY_TAIL_CONTEXT_SHARE),
      EMERGENCY_TAIL_HARD_CAP_TOKENS,
    ),
  );
}

function getMessagesFromContextEntries(
  contextEntries: ContextEntry[],
  startIndex: number,
): AgentMessage[] {
  return contextEntries
    .slice(startIndex)
    .map((item) => item.message)
    .filter((message): message is AgentMessage => Boolean(message));
}

function extractToolResultId(message: AgentMessage): string | undefined {
  const record = message as unknown as {
    toolCallId?: unknown;
    toolUseId?: unknown;
    tool_call_id?: unknown;
  };
  const id = record.toolCallId ?? record.toolUseId ?? record.tool_call_id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function buildToolOutputSummary(params: {
  message: AgentMessage;
  action: LargeToolOutputSummary["action"];
  keptChars: number;
}): LargeToolOutputSummary | null {
  const originalChars = getToolResultTextLength(params.message);
  if (originalChars <= 0) {
    return null;
  }
  return {
    action: params.action,
    toolName: getToolResultToolName(params.message),
    toolCallId: extractToolResultId(params.message),
    originalChars,
    keptChars: params.keptChars,
  };
}

function collectDroppedToolOutputs(messages: AgentMessage[]): LargeToolOutputSummary[] {
  const summaries: LargeToolOutputSummary[] = [];
  for (const message of messages) {
    if ((message as { role?: unknown }).role !== "toolResult") {
      continue;
    }
    const summary = buildToolOutputSummary({
      message,
      action: "dropped",
      keptChars: 0,
    });
    if (summary) {
      summaries.push(summary);
    }
  }
  return summaries;
}

function truncateToolResultsForTailBudget(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): { messages: AgentMessage[]; largeToolOutputs: LargeToolOutputSummary[] } {
  const largeToolOutputs: LargeToolOutputSummary[] = [];
  let changed = false;
  const messages = params.messages.map((message) => {
    if ((message as { role?: unknown }).role !== "toolResult") {
      return message;
    }
    const toolName = getToolResultToolName(message);
    const maxChars = calculateMaxToolResultChars(params.contextWindowTokens, toolName);
    if (getToolResultTextLength(message) <= maxChars) {
      return message;
    }
    const truncated = truncateToolResultMessage(message, maxChars, { toolName });
    const summary = buildToolOutputSummary({
      message,
      action: "truncated",
      keptChars: getToolResultTextLength(truncated),
    });
    if (summary) {
      largeToolOutputs.push(summary);
    }
    changed = true;
    return truncated;
  });
  return { messages: changed ? messages : params.messages, largeToolOutputs };
}

function selectEmergencyKeptMessages(params: {
  contextEntries: ContextEntry[];
  contextWindowTokens: number;
  keepRecentTokens?: number;
  keepRecentUserTurns: number;
  repairToolUseResultPairing: boolean;
}): KeptSelection {
  const tailBudgetTokens = calculateTailBudgetTokens({
    contextWindowTokens: params.contextWindowTokens,
    keepRecentTokens: params.keepRecentTokens,
  });
  let keptStart = selectKeptContextStart(params.contextEntries, params.keepRecentUserTurns);
  let messages = sanitizeKeptMessages({
    messages: getMessagesFromContextEntries(params.contextEntries, keptStart),
    repairToolUseResultPairing: params.repairToolUseResultPairing,
  });
  let keptTokens = estimateAgentMessagesTokens(messages);

  if (keptTokens > tailBudgetTokens && params.keepRecentUserTurns > 1) {
    const droppedBeforeFallback = getMessagesFromContextEntries(
      params.contextEntries,
      keptStart,
    ).slice(0, Math.max(0, selectKeptContextStart(params.contextEntries, 1) - keptStart));
    keptStart = selectKeptContextStart(params.contextEntries, 1);
    messages = sanitizeKeptMessages({
      messages: getMessagesFromContextEntries(params.contextEntries, keptStart),
      repairToolUseResultPairing: params.repairToolUseResultPairing,
    });
    keptTokens = estimateAgentMessagesTokens(messages);
    const largeToolOutputs = collectDroppedToolOutputs(droppedBeforeFallback);
    if (keptTokens <= tailBudgetTokens) {
      return { keptStart, messages, tailBudgetTokens, keptTokens, largeToolOutputs };
    }
    const truncated = truncateToolResultsForTailBudget({
      messages,
      contextWindowTokens: params.contextWindowTokens,
    });
    messages = sanitizeKeptMessages({
      messages: truncated.messages,
      repairToolUseResultPairing: params.repairToolUseResultPairing,
    });
    keptTokens = estimateAgentMessagesTokens(messages);
    return {
      keptStart,
      messages,
      tailBudgetTokens,
      keptTokens,
      largeToolOutputs: [...largeToolOutputs, ...truncated.largeToolOutputs],
    };
  }

  if (keptTokens > tailBudgetTokens) {
    const truncated = truncateToolResultsForTailBudget({
      messages,
      contextWindowTokens: params.contextWindowTokens,
    });
    messages = sanitizeKeptMessages({
      messages: truncated.messages,
      repairToolUseResultPairing: params.repairToolUseResultPairing,
    });
    keptTokens = estimateAgentMessagesTokens(messages);
    return {
      keptStart,
      messages,
      tailBudgetTokens,
      keptTokens,
      largeToolOutputs: truncated.largeToolOutputs,
    };
  }

  return { keptStart, messages, tailBudgetTokens, keptTokens, largeToolOutputs: [] };
}

function sanitizeKeptMessages(params: {
  messages: AgentMessage[];
  repairToolUseResultPairing: boolean;
}): AgentMessage[] {
  const withoutOrphans = dropOrphanedToolResults(params.messages);
  return params.repairToolUseResultPairing
    ? repairToolUseResultPairing(withoutOrphans).messages
    : withoutOrphans;
}

function appendMessageCopies(params: {
  sessionManager: SessionManager;
  parentId: string | null;
  messages: AgentMessage[];
}): string | null {
  if (params.parentId) {
    params.sessionManager.branch(params.parentId);
  } else {
    params.sessionManager.resetLeaf();
  }

  let firstId: string | null = null;
  for (const message of params.messages) {
    const sourceEntry = getSourceEntry(message);
    const id =
      sourceEntry?.type === "custom_message"
        ? params.sessionManager.appendCustomMessageEntry(
            sourceEntry.customType,
            sourceEntry.content,
            sourceEntry.display,
            sourceEntry.details,
          )
        : sourceEntry?.type === "branch_summary"
          ? params.sessionManager.branchWithSummary(
              params.sessionManager.getLeafId(),
              sourceEntry.summary,
              sourceEntry.details,
              sourceEntry.fromHook,
            )
          : params.sessionManager.appendMessage(
              message as Parameters<SessionManager["appendMessage"]>[0],
            );
    firstId ??= id;
  }
  return firstId;
}

function buildEmergencySummary(params: {
  reason: EmergencyCompactionReason;
  originalMessageCount: number;
  keptMessageCount: number;
  tokensBefore: number;
  contextWindowTokens: number;
  tailBudgetTokens: number;
  keptTokens: number;
  largeToolOutputs: LargeToolOutputSummary[];
}): string {
  const lines = [
    "Emergency compaction",
    "",
    `Reason: ${params.reason}`,
    `Original messages: ${params.originalMessageCount}`,
    `Kept messages: ${params.keptMessageCount}`,
    `Estimated tokens before: ${params.tokensBefore}`,
    `Estimated kept tokens: ${params.keptTokens}`,
    `Tail budget tokens: ${params.tailBudgetTokens}`,
    `Context window: ${params.contextWindowTokens}`,
    "",
    "Older verbose tool outputs and historical context were dropped deterministically without calling a model.",
  ];
  if (params.largeToolOutputs.length > 0) {
    lines.push("", "Dropped Large Tool Outputs");
    for (const item of params.largeToolOutputs.slice(0, 12)) {
      const details = [
        `action=${item.action}`,
        `tool=${item.toolName ?? "unknown"}`,
        item.toolCallId ? `id=${item.toolCallId}` : undefined,
        `originalChars=${item.originalChars}`,
        `keptChars=${item.keptChars}`,
      ].filter((value): value is string => Boolean(value));
      lines.push(`- ${details.join(" ")}`);
    }
  }
  return lines.join("\n");
}

function restoreLeaf(sessionManager: SessionManager, leafId: string | null): void {
  if (leafId) {
    sessionManager.branch(leafId);
    return;
  }
  sessionManager.resetLeaf();
}

export async function appendEmergencyCompaction(
  params: AppendEmergencyCompactionParams,
): Promise<AppendEmergencyCompactionResult> {
  const entries = params.sessionManager.getEntries();
  const preLeafId = params.preLeafId ?? params.sessionManager.getLeafId();
  const preCompactionCount = params.preCompactionCount ?? countCompactionEntries(entries);

  if (hasCompactedSinceBaseline({ entries, preCompactionCount })) {
    return alreadyCompactedResult({ sessionManager: params.sessionManager });
  }

  const branch = params.sessionManager.getBranch();
  const contextEntries = getContextEntries(branch);
  const originalMessages = contextEntries
    .map((item) => item.message)
    .filter((message): message is AgentMessage => Boolean(message));
  const tokensBefore = estimateAgentMessagesTokens(originalMessages);
  const selection = selectEmergencyKeptMessages({
    contextEntries,
    contextWindowTokens: params.contextWindowTokens,
    keepRecentTokens: params.keepRecentTokens,
    keepRecentUserTurns: params.keepRecentUserTurns ?? 1,
    repairToolUseResultPairing: params.repairToolUseResultPairing,
  });
  const keptStart = selection.keptStart;
  const originalFirstKeptEntryId = resolveFirstKeptEntryId(branch, keptStart);
  if (!originalFirstKeptEntryId) {
    return {
      appended: false,
      rebuiltMessages: params.sessionManager.buildSessionContext().messages,
      firstKeptEntryId: null,
      originalFirstKeptEntryId: null,
      tokensBefore,
      reason: "no_kept_entries",
    };
  }

  const originalFirstKeptEntry = branch.find((entry) => entry.id === originalFirstKeptEntryId);
  const entriesBeforeReplay = params.sessionManager.getEntries();
  if (hasCompactedSinceBaseline({ entries: entriesBeforeReplay, preCompactionCount })) {
    return alreadyCompactedResult({ sessionManager: params.sessionManager, tokensBefore });
  }
  const firstKeptEntryId = appendMessageCopies({
    sessionManager: params.sessionManager,
    parentId: originalFirstKeptEntry?.parentId ?? null,
    messages: selection.messages,
  });
  if (!firstKeptEntryId) {
    return {
      appended: false,
      rebuiltMessages: params.sessionManager.buildSessionContext().messages,
      firstKeptEntryId: null,
      originalFirstKeptEntryId,
      tokensBefore,
      reason: "no_kept_entries",
    };
  }

  const entriesBeforeAppend = params.sessionManager.getEntries();
  if (hasCompactedSinceBaseline({ entries: entriesBeforeAppend, preCompactionCount })) {
    // Synchronous-window invariant: between `appendMessageCopies` above and this check there
    // is no `await`, so a compaction that lands here can only have been appended synchronously
    // by an append-hook during replay — in which case it attaches to the *replayed* branch, and
    // `restoreLeaf(preLeafId)` correctly drops both the replayed tail and that stray compaction.
    // If an `await` is ever inserted in this span, an async SDK compaction could instead settle
    // on the original branch; this rollback would then need to follow that compaction rather
    // than simply restoring `preLeafId`.
    restoreLeaf(params.sessionManager, preLeafId);
    return alreadyCompactedResult({ sessionManager: params.sessionManager, tokensBefore });
  }

  const summary = buildEmergencySummary({
    reason: params.reason,
    originalMessageCount: originalMessages.length,
    keptMessageCount: selection.messages.length,
    tokensBefore,
    contextWindowTokens: params.contextWindowTokens,
    tailBudgetTokens: selection.tailBudgetTokens,
    keptTokens: selection.keptTokens,
    largeToolOutputs: selection.largeToolOutputs,
  });
  const details: EmergencyCompactionDetails = {
    kind: "openclaw.emergency_compaction",
    runId: params.runId,
    emergencyId: params.emergencyId ?? randomUUID(),
    reason: params.reason,
    preLeafId,
    preCompactionCount,
    originalFirstKeptEntryId,
    firstKeptEntryId,
    contextWindowTokens: params.contextWindowTokens,
    originalMessageCount: originalMessages.length,
    tailBudgetTokens: selection.tailBudgetTokens,
    keptTokens: selection.keptTokens,
    largeToolOutputs: selection.largeToolOutputs,
  };

  params.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
  return {
    appended: true,
    rebuiltMessages: params.sessionManager.buildSessionContext().messages,
    firstKeptEntryId,
    originalFirstKeptEntryId,
    tokensBefore,
    reason: params.reason,
  };
}
