import type {
  ChatHistoryParams,
  ChatHistoryResult,
} from "../../../../src/gateway/protocol/schema/types.js";
import { extractText } from "../chat/message-extract.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatHistoryLoadingOlder: boolean;
  chatHistoryHasMore: boolean;
  chatHistoryNextBefore: string | null;
  chatHistorySessionKey: string;
  chatHistoryRequestGeneration: number;
  chatHistoryInitialRequestId: number;
  chatHistoryOlderRequestId: number;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatHistoryPort = {
  load(params: ChatHistoryParams): Promise<ChatHistoryResult>;
};

const CHAT_HISTORY_INITIAL_LIMIT = 1000;
const CHAT_HISTORY_OLDER_PAGE_LIMIT = 100;

export function createGatewayChatHistoryPort(
  client: Pick<GatewayBrowserClient, "request">,
): ChatHistoryPort {
  return {
    load: (params) => client.request<ChatHistoryResult>("chat.history", params),
  };
}

function historyEntryId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as { historyEntryId?: unknown }).historyEntryId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupeHistoryMessages(messages: unknown[]): unknown[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const id = historyEntryId(message);
    if (!id) {
      return true;
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function mergeLatestHistory(
  existing: unknown[],
  latest: unknown[],
): {
  messages: unknown[];
  overlap: boolean;
  preservedOlderPrefix: boolean;
} {
  const existingIndexById = new Map<string, number>();
  existing.forEach((message, index) => {
    const id = historyEntryId(message);
    if (id && !existingIndexById.has(id)) {
      existingIndexById.set(id, index);
    }
  });
  let overlapIndex = -1;
  for (const message of latest) {
    const id = historyEntryId(message);
    const existingIndex = id ? existingIndexById.get(id) : undefined;
    if (existingIndex !== undefined) {
      overlapIndex = existingIndex;
      break;
    }
  }
  if (overlapIndex < 0) {
    return { messages: latest, overlap: false, preservedOlderPrefix: false };
  }
  const olderPrefix = existing.slice(0, overlapIndex);
  return {
    messages: dedupeHistoryMessages([...olderPrefix, ...latest]),
    overlap: true,
    preservedOlderPrefix: olderPrefix.length > 0,
  };
}

function applyHistoryCursor(state: ChatState, result: ChatHistoryResult) {
  const nextBefore = result.nextBefore?.trim() || null;
  state.chatHistoryNextBefore = nextBefore;
  state.chatHistoryHasMore = Boolean(result.hasMore && nextBefore);
}

export function resetChatHistoryPagination(state: ChatState) {
  state.chatHistoryLoadingOlder = false;
  state.chatHistoryHasMore = false;
  state.chatHistoryNextBefore = null;
}

export function resetChatHistoryForSessionSwitch(state: ChatState) {
  resetChatHistoryPagination(state);
  state.chatLoading = false;
  state.chatMessages = [];
  state.chatHistorySessionKey = state.sessionKey;
  state.chatHistoryRequestGeneration += 1;
}

function prepareChatHistoryRequest(state: ChatState, requestedSessionKey: string): number {
  state.chatHistoryRequestGeneration += 1;
  if (state.chatHistorySessionKey !== requestedSessionKey) {
    resetChatHistoryPagination(state);
    state.chatMessages = [];
    state.chatHistorySessionKey = requestedSessionKey;
  }
  return state.chatHistoryRequestGeneration;
}

function isCurrentChatHistoryRequest(
  state: ChatState,
  requestedSessionKey: string,
  requestGeneration: number,
) {
  return (
    state.sessionKey === requestedSessionKey &&
    state.chatHistorySessionKey === requestedSessionKey &&
    state.chatHistoryRequestGeneration === requestGeneration
  );
}

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export async function loadChatHistory(state: ChatState, historyPort?: ChatHistoryPort) {
  if (!state.connected || (!historyPort && !state.client)) {
    return;
  }
  const requestedSessionKey = state.sessionKey;
  const requestGeneration = prepareChatHistoryRequest(state, requestedSessionKey);
  // The shared generation invalidates result application across both history
  // request kinds, so loading flags must be released against a per-kind id.
  const initialRequestId = ++state.chatHistoryInitialRequestId;
  const previousMessages = state.chatMessages;
  const previousHasMore = state.chatHistoryHasMore;
  const previousNextBefore = state.chatHistoryNextBefore;
  const port = historyPort ?? createGatewayChatHistoryPort(state.client!);
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await port.load({
      sessionKey: requestedSessionKey,
      limit: CHAT_HISTORY_INITIAL_LIMIT,
    });
    if (!isCurrentChatHistoryRequest(state, requestedSessionKey, requestGeneration)) {
      return;
    }
    const latest = Array.isArray(res.messages) ? res.messages : [];
    const merged = mergeLatestHistory(previousMessages, latest);
    const reset = res.cursorReset || (previousMessages.length > 0 && !merged.overlap);
    state.chatMessages = reset ? latest : merged.messages;
    if (!reset && merged.preservedOlderPrefix) {
      state.chatHistoryHasMore = previousHasMore;
      state.chatHistoryNextBefore = previousNextBefore;
    } else {
      applyHistoryCursor(state, res);
    }
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    if (isCurrentChatHistoryRequest(state, requestedSessionKey, requestGeneration)) {
      state.lastError = String(err);
    }
  } finally {
    if (state.chatHistoryInitialRequestId === initialRequestId) {
      state.chatLoading = false;
    }
  }
}

export async function loadOlderChatHistory(state: ChatState, historyPort?: ChatHistoryPort) {
  if (
    !state.connected ||
    (!historyPort && !state.client) ||
    state.chatHistoryLoadingOlder ||
    !state.chatHistoryHasMore ||
    !state.chatHistoryNextBefore
  ) {
    return;
  }
  const requestedSessionKey = state.sessionKey;
  if (state.chatHistorySessionKey !== requestedSessionKey) {
    resetChatHistoryForSessionSwitch(state);
    return;
  }
  const requestGeneration = prepareChatHistoryRequest(state, requestedSessionKey);
  const olderRequestId = ++state.chatHistoryOlderRequestId;
  const before = state.chatHistoryNextBefore;
  const port = historyPort ?? createGatewayChatHistoryPort(state.client!);
  state.chatHistoryLoadingOlder = true;
  state.lastError = null;
  try {
    const res = await port.load({
      sessionKey: requestedSessionKey,
      before,
      limit: CHAT_HISTORY_OLDER_PAGE_LIMIT,
    });
    if (!isCurrentChatHistoryRequest(state, requestedSessionKey, requestGeneration)) {
      return;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    if (res.cursorReset) {
      state.chatMessages = messages;
    } else {
      state.chatMessages = dedupeHistoryMessages([...messages, ...state.chatMessages]);
    }
    applyHistoryCursor(state, res);
    state.chatThinkingLevel = res.thinkingLevel ?? state.chatThinkingLevel;
  } catch (err) {
    if (isCurrentChatHistoryRequest(state, requestedSessionKey, requestGeneration)) {
      state.lastError = String(err);
    }
  } finally {
    if (state.chatHistoryOlderRequestId === olderRequestId) {
      state.chatHistoryLoadingOlder = false;
    }
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: true,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return runId;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim()) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
