import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { repairToolUseResultPairing, stripToolResultDetails } from "./session-transcript-repair.js";

const log = createSubsystemLogger("compaction");

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const DEFAULT_MAX_SUMMARY_CHUNKS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into a single cohesive summary. Preserve decisions," +
  " TODOs, open questions, and any constraints.";

export type SummaryCallBudget = {
  maxCalls: number;
  usedCalls: number;
  tryConsume: (label: string) => boolean;
};

export class SummaryCallBudgetExhaustedError extends Error {
  constructor(
    readonly label: string,
    readonly budget: Pick<SummaryCallBudget, "maxCalls" | "usedCalls">,
  ) {
    super(`Summary call budget exhausted before ${label}`);
    this.name = "SummaryCallBudgetExhaustedError";
  }
}

export function createSummaryCallBudget(maxCalls: number): SummaryCallBudget {
  const budget = {
    maxCalls: Math.max(0, Math.floor(maxCalls)),
    usedCalls: 0,
    tryConsume(label: string): boolean {
      void label;
      if (budget.usedCalls >= budget.maxCalls) {
        return false;
      }
      budget.usedCalls += 1;
      return true;
    },
  };
  return budget;
}

function makeDroppedNoteMessage(note: string): AgentMessage {
  return {
    role: "user",
    content: note,
    timestamp: 0,
  };
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details can contain untrusted/verbose payloads; never include in LLM-facing compaction.
  const safe = stripToolResultDetails(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function estimateCompactionMessageTokens(message: AgentMessage): number {
  return estimateMessagesTokens([message]);
}

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// Overhead reserved for summarization prompt, system prompt, previous summary,
// and serialization wrappers (<conversation> tags, instructions, etc.).
// generateSummary uses reasoning: "high" which also consumes context budget.
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

export function chunkMessagesByMaxTokens(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  // Apply safety margin to compensate for estimateTokens() underestimation
  // (chars/4 heuristic misses multi-byte chars, special tokens, code tokens, etc.)
  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));

  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > effectiveMax) {
      // Split oversized messages to avoid unbounded chunk growth.
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function formatDroppedChunkNote(params: {
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
}): string {
  return (
    `[Summarization input pruned: omitted ${params.droppedMessages} older message(s) ` +
    `from ${params.droppedChunks} chunk(s), approx ${params.droppedTokens} token(s).]`
  );
}

function limitSummaryChunks(
  chunks: AgentMessage[][],
  maxChunks = DEFAULT_MAX_SUMMARY_CHUNKS,
): {
  chunks: AgentMessage[][];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
} {
  const normalizedMaxChunks = Math.max(1, Math.floor(maxChunks));
  if (chunks.length <= normalizedMaxChunks) {
    return { chunks, droppedChunks: 0, droppedMessages: 0, droppedTokens: 0 };
  }

  const dropped = chunks.slice(0, chunks.length - normalizedMaxChunks);
  const kept = chunks.slice(chunks.length - normalizedMaxChunks);
  const droppedMessages = dropped.flat();
  const droppedTokens = estimateMessagesTokens(droppedMessages);
  const note = makeDroppedNoteMessage(
    formatDroppedChunkNote({
      droppedChunks: dropped.length,
      droppedMessages: droppedMessages.length,
      droppedTokens,
    }),
  );
  return {
    chunks: [[note, ...kept[0]], ...kept.slice(1)],
    droppedChunks: dropped.length,
    droppedMessages: droppedMessages.length,
    droppedTokens,
  };
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;

  // Apply safety margin to account for estimation inaccuracy
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateCompactionMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

async function summarizeChunks(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
  summaryBudget?: SummaryCallBudget;
  maxChunks?: number;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // SECURITY: never feed toolResult.details into summarization prompts.
  const safeMessages = stripToolResultDetails(params.messages);
  const chunkLimit = limitSummaryChunks(
    chunkMessagesByMaxTokens(safeMessages, params.maxChunkTokens),
    params.maxChunks,
  );
  const chunks = chunkLimit.chunks;
  let summary = params.previousSummary;

  for (const chunk of chunks) {
    // Consume one budget slot per chunk BEFORE retrying. Tying tryConsume to the retry
    // callback previously let a single flaky chunk burn up to `attempts` slots, starving
    // later chunks and deterministically exhausting the staged path's budget. Per-chunk
    // consumption makes one summary == one slot regardless of transient retries.
    const label = "compaction/generateSummary";
    if (params.summaryBudget && !params.summaryBudget.tryConsume(label)) {
      throw new SummaryCallBudgetExhaustedError(label, params.summaryBudget);
    }
    summary = await retryAsync(
      () =>
        generateSummary(
          chunk,
          params.model,
          params.reserveTokens,
          params.apiKey,
          params.signal,
          params.customInstructions,
          summary,
        ),
      {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 5000,
        jitter: 0.2,
        label,
        shouldRetry: (err) => !(err instanceof Error && err.name === "AbortError"),
      },
    );
  }

  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
export async function summarizeWithFallback(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  summaryBudget?: SummaryCallBudget;
  maxChunks?: number;
}): Promise<string> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization first
  try {
    return await summarizeChunks(params);
  } catch (fullError) {
    if (fullError instanceof SummaryCallBudgetExhaustedError) {
      throw fullError;
    }
    log.warn(
      `Full summarization failed, trying partial: ${
        fullError instanceof Error ? fullError.message : String(fullError)
      }`,
    );
  }

  // Fallback 1: Summarize only small messages, note oversized ones
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of messages) {
    if (isOversizedForSummary(msg, contextWindow)) {
      const role = (msg as { role?: string }).role ?? "message";
      const tokens = estimateCompactionMessageTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partialSummary = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partialSummary + notes;
    } catch (partialError) {
      if (partialError instanceof SummaryCallBudgetExhaustedError) {
        throw partialError;
      }
      log.warn(
        `Partial summarization also failed: ${
          partialError instanceof Error ? partialError.message : String(partialError)
        }`,
      );
    }
  }

  // Final fallback: Just note what was there
  return (
    `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
    `Summary unavailable due to size limits.`
  );
}

export async function summarizeInStages(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
  summaryBudget?: SummaryCallBudget;
  maxChunks?: number;
}): Promise<string> {
  const inputPrune = pruneMessagesForSummarizationBudget({
    messages: params.messages,
    contextWindow: params.contextWindow,
  });
  const { messages } = inputPrune;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  // Each phase self-budgets when the caller doesn't provide one. A staged phase needs
  // `parts` partial summaries plus one merge, and each summarizeWithFallback call may
  // internally fan out to up to `maxChunks` chunks — so (parts + 1) * maxChunks is the
  // tight upper bound for one phase. Callers (compaction-safeguard) previously shared a
  // single budget(2), which a normal 3-call staged phase deterministically exhausted,
  // forcing every phase into the truncation fallback. Per-phase budgeting lets each
  // phase complete independently while still bounding runaway calls.
  const maxChunks = params.maxChunks ?? DEFAULT_MAX_SUMMARY_CHUNKS;
  const summaryBudget = params.summaryBudget ?? createSummaryCallBudget((parts + 1) * maxChunks);
  const callParams = { ...params, summaryBudget };

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback({ ...callParams, messages });
  }

  const splitLimit = limitSummaryChunks(
    splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0),
    params.maxChunks,
  );
  const splits = splitLimit.chunks;
  if (splits.length <= 1) {
    return summarizeWithFallback({ ...callParams, messages });
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...callParams,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: AgentMessage[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...callParams,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages: AgentMessage[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) {
      break;
    }
    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();

    // After dropping a chunk, repair tool_use/tool_result pairing to handle
    // orphaned tool_results (whose tool_use was in the dropped chunk).
    // repairToolUseResultPairing drops orphaned tool_results, preventing
    // "unexpected tool_use_id" errors from Anthropic's API.
    const repairReport = repairToolUseResultPairing(flatRest);
    const repairedKept = repairReport.messages;

    // Track orphaned tool_results as dropped (they were in kept but their tool_use was dropped)
    const orphanedCount = repairReport.droppedOrphanCount;

    droppedChunks += 1;
    droppedMessages += dropped.length + orphanedCount;
    droppedTokens += estimateMessagesTokens(dropped);
    // Note: We don't have the actual orphaned messages to add to droppedMessagesList
    // since repairToolUseResultPairing doesn't return them. This is acceptable since
    // the dropped messages are used for summarization, and orphaned tool_results
    // without their tool_use context aren't useful for summarization anyway.
    allDroppedMessages.push(...dropped);
    keptMessages = repairedKept;
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

export function pruneMessagesForSummarizationBudget(params: {
  messages: AgentMessage[];
  contextWindow: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
  droppedNote?: string;
} {
  const pruned = pruneHistoryForContextShare({
    messages: params.messages,
    maxContextTokens: params.contextWindow,
    maxHistoryShare: params.maxHistoryShare ?? 0.5,
    parts: params.parts,
  });
  if (pruned.droppedMessages === 0) {
    return { ...pruned, droppedNote: undefined };
  }

  const droppedNote =
    `[Summarization input pruned: dropped ${pruned.droppedMessages} older message(s) ` +
    `from ${pruned.droppedChunks} chunk(s), approx ${pruned.droppedTokens} token(s); ` +
    `kept ${pruned.keptTokens}/${pruned.budgetTokens} budget token(s).]`;

  return {
    ...pruned,
    messages: [makeDroppedNoteMessage(droppedNote), ...pruned.messages],
    droppedNote,
  };
}

export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  return Math.max(1, Math.floor(model?.contextWindow ?? DEFAULT_CONTEXT_TOKENS));
}
