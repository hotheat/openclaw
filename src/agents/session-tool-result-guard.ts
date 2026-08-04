import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  calculatePersistenceToolResultChars,
  getToolResultToolName,
  truncateToolResultMessage,
} from "./pi-embedded-runner/tool-result-truncation.js";
import type { AgentToolMetadata } from "./pi-tools.types.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

export type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  mutatingAction: boolean;
  actionFingerprint?: string;
};

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg: AgentMessage, toolName?: string): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") {
    return msg;
  }
  const resolvedToolName = toolName ?? getToolResultToolName(msg);
  return truncateToolResultMessage(msg, calculatePersistenceToolResultChars(resolvedToolName), {
    suffix: GUARD_TRUNCATION_SUFFIX,
    minKeepChars: 2_000,
    toolName: resolvedToolName,
  });
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Optional set/list of tool names accepted for assistant toolCall/toolUse blocks.
     * When set, tool calls with unknown names are dropped before persistence.
     */
    allowedToolNames?: Iterable<string>;
    /** Structured metadata for tools available in this run. */
    toolMetadataByName?: ReadonlyMap<string, AgentToolMetadata>;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
  },
): {
  flushPendingToolResults: () => PendingToolCall[];
  getPendingIds: () => string[];
  getPendingToolCalls: () => PendingToolCall[];
  updatePendingToolCall: (params: {
    toolCallId: string;
    toolName: string;
    toolParams: unknown;
    toolMetadata?: AgentToolMetadata;
  }) => void;
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, PendingToolCall>();
  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const beforeWrite = opts?.beforeMessageWriteHook;

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (msg: AgentMessage): AgentMessage | null => {
    if (!beforeWrite) {
      return msg;
    }
    const result = beforeWrite({ message: msg });
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return result.message;
    }
    return msg;
  };

  const flushPendingToolResults = (): PendingToolCall[] => {
    if (pending.size === 0) {
      return [];
    }
    const flushedCalls = Array.from(pending.values());
    if (allowSyntheticToolResults) {
      for (const call of flushedCalls) {
        const synthetic = makeMissingToolResult({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        });
        const flushed = applyBeforeWriteHook(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            isSynthetic: true,
          }),
        );
        if (flushed) {
          originalAppend(flushed as never);
        }
      }
    }
    pending.clear();
    return allowSyntheticToolResults ? flushedCalls : [];
  };

  const updatePendingToolCall = (params: {
    toolCallId: string;
    toolName: string;
    toolParams: unknown;
    toolMetadata?: AgentToolMetadata;
  }) => {
    if (!pending.has(params.toolCallId)) {
      return;
    }
    const mutation = buildToolMutationState(
      params.toolName,
      params.toolParams,
      undefined,
      params.toolMetadata,
    );
    pending.set(params.toolCallId, {
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      mutatingAction: mutation.mutatingAction,
      actionFingerprint: mutation.actionFingerprint,
    });
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message], {
        allowedToolNames: opts?.allowedToolNames,
      });
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName =
        (id ? pending.get(id)?.toolName : undefined) ?? getToolResultToolName(nextMessage);
      if (id) {
        pending.delete(id);
      }
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(persistMessage(nextMessage), toolName);
      const hooked = applyBeforeWriteHook(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
      const persisted = hooked ? capToolResultSize(hooked, toolName) : null;
      if (!persisted) {
        return undefined;
      }
      return originalAppend(persisted as never);
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const toolName = call.name ?? "unknown";
        const mutation = buildToolMutationState(
          toolName,
          call.arguments,
          undefined,
          opts?.toolMetadataByName?.get(normalizeToolName(toolName)),
        );
        pending.set(call.id, {
          toolCallId: call.id,
          toolName,
          mutatingAction: mutation.mutatingAction,
          actionFingerprint: mutation.actionFingerprint,
        });
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
    getPendingToolCalls: () => Array.from(pending.values()),
    updatePendingToolCall,
  };
}
