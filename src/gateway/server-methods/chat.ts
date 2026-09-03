import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { steerEmbeddedPiRunById } from "../../agents/pi-embedded-runner/runs.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { FollowupRunSettlement } from "../../auto-reply/reply/queue.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "../../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import { stripInlineDirectiveTagsFromMessageForDisplay } from "../../utils/directive-tags.js";
import { resolveGatewayClientMessageChannel } from "../../utils/message-channel.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { materializeChatAttachment } from "../chat-attachment-materialize.js";
import {
  extractWebchatAttachmentRefs,
  type ChatImageContent,
  parseMessageWithAttachments,
} from "../chat-attachments.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  type ChatHistoryResult,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatAttachmentMaterializeParams,
  validateChatInjectParams,
  validateChatSendParams,
  validateChatSteerParams,
} from "../protocol/index.js";
import {
  InvalidHistoryCursorError,
  loadSessionHistoryPage,
  SessionHistoryResponseBudgetError,
} from "../session-history-page.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  deduplicated?: boolean;
  error?: string;
};

type AbortOrigin = "rpc" | "stop-command";

const CHAT_STEER_STARTUP_RETRY_MS = 3_000;
const CHAT_STEER_STARTUP_POLL_MS = 50;

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  text: string;
  abortOrigin: AbortOrigin;
};

function resolveWebchatClientSessionId(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  if (
    parts.length === 5 &&
    parts[0] === "agent" &&
    parts[1] &&
    parts[2] === "webchat" &&
    parts[3] &&
    /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(parts[4] ?? "")
  ) {
    return parts[4];
  }
  return undefined;
}

let chatHistoryPlaceholderEmitCount = 0;

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true, deduplicated: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  sessionKey: string;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  if (params.snapshots.length === 0) {
    return;
  }
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatDeltaRevisions: context.chatDeltaRevisions,
    chatDeltaSeqs: context.chatDeltaSeqs,
    chatDeltaLastBroadcastRevisions: context.chatDeltaLastBroadcastRevisions,
    chatDeltaLastNodeRevisions: context.chatDeltaLastNodeRevisions,
    chatDeltaSentAt: context.chatDeltaSentAt,
    chatAbortedRuns: context.chatAbortedRuns,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
}) {
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    sessionKey: params.sessionKey,
    abortOrigin: params.abortOrigin,
  });
  const res = abortChatRunsForSessionKey(params.ops, {
    sessionKey: params.sessionKey,
    stopReason: params.stopReason,
  });
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  return res;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function chatSteerDedupeKey(runId: string, idempotencyKey: string): string {
  return `chat-steer:${runId}:${idempotencyKey}`;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
  /** Settlement outcome for queued runs closed without their own reply (e.g. "merged"). */
  stopReason?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
    stopReason: params.stopReason,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

/**
 * Terminal for a queued run whose batch was aborted through the primary run's
 * id: the message will never get a reply, so clients must see an aborted state
 * (not a merge-shaped silent final). Marking chatAbortedRuns keeps any stray
 * later event from layering on top of this terminal.
 */
function broadcastChatSettlementAborted(params: {
  context: Pick<
    GatewayRequestContext,
    "broadcast" | "nodeSendToSession" | "agentRunSeq" | "chatAbortedRuns"
  >;
  runId: string;
  sessionKey: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "aborted" as const,
    stopReason: "aborted" as const,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
  params.context.chatAbortedRuns.set(params.runId, Date.now());
}

function broadcastChatQueued(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession">;
  runId: string;
  sessionKey: string;
}) {
  // seq 0 marks a pre-run notice without advancing agentRunSeq: the queued run later
  // reuses this run id and its agent lifecycle events start at seq 1, so touching
  // the shared counter here would fabricate a "seq gap" for every queued run.
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq: 0,
    state: "queued" as const,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit, before } = params;
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const startedAt = Date.now();
    let historyPage: Awaited<ReturnType<typeof loadSessionHistoryPage>>;
    try {
      historyPage = await loadSessionHistoryPage({
        sessionId,
        storePath,
        sessionFile: entry?.sessionFile,
        agentId: sessionAgentId,
        before,
        limit: max,
      });
    } catch (error) {
      if (error instanceof InvalidHistoryCursorError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (error instanceof SessionHistoryResponseBudgetError) {
        context.logGateway.warn("chat.history response budget removed every readable message");
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "chat history read failed",
        ),
      );
      return;
    }
    const { diagnostics } = historyPage;
    const placeholderCount = diagnostics.placeholderCount;
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    context.logGateway.debug(
      `chat.history attachment refs structured_ref_messages=${diagnostics.structuredRefMessages} ` +
        `marker_fallback_messages=${diagnostics.markerFallbackMessages}`,
    );
    context.logGateway.debug(
      `chat.history page_records=${historyPage.messages.length} scanned_bytes=${diagnostics.scannedBytes} ` +
        `read_chunks=${diagnostics.readChunks} cursor_reset=${historyPage.cursorReset} ` +
        `malformed_lines=${diagnostics.malformedLines} response_bytes=${diagnostics.responseBytes} ` +
        `duration_ms=${Date.now() - startedAt}`,
    );
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const { provider, model } = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const catalog = await context.loadGatewayModelCatalog();
      thinkingLevel = resolveThinkingDefault({
        cfg,
        agentId: sessionAgentId,
        provider,
        model,
        catalog,
      });
    }
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    const result = {
      sessionKey,
      sessionId,
      messages: historyPage.messages,
      nextBefore: historyPage.nextBefore,
      hasMore: historyPage.hasMore,
      cursorReset: historyPage.cursorReset,
      thinkingLevel,
      verboseLevel,
    } satisfies ChatHistoryResult;
    respond(true, result);
  },
  "chat.steer": async ({ params, respond, context }) => {
    if (!validateChatSteerParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.steer params: ${formatValidationErrors(validateChatSteerParams.errors)}`,
        ),
      );
      return;
    }

    const { sessionKey, runId, idempotencyKey, message } = params;
    const sanitizedMessageResult = sanitizeChatSendMessageInput(message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    if (!sanitizedMessageResult.message.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message required"));
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (active && active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const steerDedupeKey = chatSteerDedupeKey(runId, idempotencyKey);
    if (active?.steerIdempotencyKeys.has(idempotencyKey) || context.dedupe.has(steerDedupeKey)) {
      context.logGateway.debug(`chat.steer status=accepted cached=true runId=${runId}`);
      respond(true, { runId, status: "accepted" }, undefined, { cached: true, runId });
      return;
    }

    let persistedSessionId = loadSessionEntry(sessionKey).entry?.sessionId;
    let sessionId = persistedSessionId ?? active?.sessionId;
    if (!sessionId) {
      context.logGateway.debug(
        `chat.steer status=not_steerable reason=run_inactive runId=${runId}`,
      );
      respond(true, { runId, status: "not_steerable", reason: "run_inactive" });
      return;
    }
    if (active && persistedSessionId && active.sessionId !== persistedSessionId) {
      active.sessionId = persistedSessionId;
    }

    let result = steerEmbeddedPiRunById(sessionId, runId, sanitizedMessageResult.message);
    if (active && result.status === "not_steerable" && result.reason === "run_inactive") {
      const deadline = Date.now() + CHAT_STEER_STARTUP_RETRY_MS;
      while (Date.now() < deadline && context.chatAbortControllers.get(runId) === active) {
        await new Promise((resolve) => setTimeout(resolve, CHAT_STEER_STARTUP_POLL_MS));
        persistedSessionId = loadSessionEntry(sessionKey).entry?.sessionId;
        sessionId = persistedSessionId ?? active.sessionId;
        if (persistedSessionId && active.sessionId !== persistedSessionId) {
          active.sessionId = persistedSessionId;
        }
        result = steerEmbeddedPiRunById(sessionId, runId, sanitizedMessageResult.message);
        if (result.status === "accepted" || result.reason !== "run_inactive") {
          break;
        }
      }
    }
    if (result.status === "accepted") {
      if (active?.continuationExpiresAtMs !== undefined) {
        active.expiresAtMs = Math.max(active.expiresAtMs, active.continuationExpiresAtMs);
      }
      active?.steerIdempotencyKeys.add(idempotencyKey);
      context.dedupe.set(steerDedupeKey, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "accepted" },
      });
      context.logGateway.debug(`chat.steer status=accepted cached=false runId=${runId}`);
    } else {
      context.logGateway.debug(
        `chat.steer status=not_steerable reason=${result.reason} runId=${runId}`,
      );
    }
    respond(true, { runId, ...result }, undefined, { runId });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: rawSessionKey,
        abortOrigin: "rpc",
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.attachment.materialize": async ({ params, respond }) => {
    if (!validateChatAttachmentMaterializeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.attachment.materialize params: ${formatValidationErrors(
            validateChatAttachmentMaterializeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const input = params as {
      sessionKey: string;
      artifactId: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      downloadUrl: string;
    };
    try {
      const { cfg } = loadSessionEntry(input.sessionKey);
      const attachment = await materializeChatAttachment({ cfg, input });
      respond(true, { attachment });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "attachment materialization failed",
        ),
      );
    }
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
        workspacePath?: string;
        sizeBytes?: number;
        sha256?: string;
        attachmentId?: string;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const rawSessionKey = p.sessionKey;
    const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const workspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const webchatAttachmentRefs = extractWebchatAttachmentRefs(normalizedAttachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let parsedMediaPaths: string[] = [];
    let parsedMediaTypes: string[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
          workspaceDir,
          webchatClientSessionId: resolveWebchatClientSessionId(sessionKey),
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
        parsedMediaPaths = parsed.mediaPaths;
        parsedMediaTypes = parsed.mediaTypes;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const sessionDelivery = deliveryContextFromSession(entry);
    const timeoutAgentId = sessionAgentId;
    const { provider: timeoutProvider } = resolveSessionModelRef(cfg, entry, timeoutAgentId);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      provider: timeoutProvider,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        abortOrigin: "stop-command",
        stopReason: "stop",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        continuationExpiresAtMs: resolveChatRunExpiresAtMs({
          now,
          timeoutMs: timeoutMs * 2,
        }),
        steerIdempotencyKeys: new Set(),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const clientInfo = client?.connect?.client;
      const messageChannel = resolveGatewayClientMessageChannel(clientInfo);
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/moltbot/moltbot/issues/3658
      const stampedMessage = injectTimestamp(parsedMessage, timestampOptsFromConfig(cfg));

      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: sessionKey,
        Provider: messageChannel,
        Surface: messageChannel,
        OriginatingChannel: messageChannel,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        GatewayClientScopes: client?.connect?.scopes,
        ...(parsedMediaPaths.length > 0
          ? {
              MediaPath: parsedMediaPaths[0],
              MediaType: parsedMediaTypes[0],
              MediaPaths: parsedMediaPaths,
              MediaTypes: parsedMediaTypes,
            }
          : {}),
      };

      const agentId = resolveSessionAgentId({
        sessionKey,
        config: cfg,
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId,
        channel: messageChannel,
      });
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        ...prefixOptions,
        onError: (err) => {
          context.logGateway.warn(`${messageChannel} dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") {
            return;
          }
          const text = payload.text?.trim() ?? "";
          if (!text) {
            return;
          }
          finalReplyParts.push(text);
          if (
            p.deliver !== true ||
            !sessionDelivery?.to ||
            !isRoutableChannel(sessionDelivery.channel)
          ) {
            return;
          }
          const routed = await routeReply({
            payload,
            channel: sessionDelivery.channel,
            to: sessionDelivery.to,
            accountId: sessionDelivery.accountId,
            threadId: sessionDelivery.threadId,
            sessionKey,
            cfg,
            abortSignal: abortController.signal,
            mirror: false,
          });
          if (!routed.ok) {
            context.logGateway.warn(
              `${messageChannel} external delivery failed: ${routed.error ?? "unknown error"}`,
            );
          }
        },
      });

      let agentRunStarted = false;
      // Resolved once a message parked on the session follow-up queue settles
      // (runs under clientRunId, merges into another run, or never runs).
      let resolveQueuedSettlement: ((settlement: FollowupRunSettlement) => void) | undefined;
      const queuedSettlement = new Promise<FollowupRunSettlement>((resolve) => {
        resolveQueuedSettlement = resolve;
      });
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          webchatAttachmentRefs,
          onQueuedRunSettled: (settlement) => resolveQueuedSettlement?.(settlement),
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            // A queued run starts long after chat.send registered its sweeper
            // deadline; re-arm it from actual agent activity so the maintenance
            // timeout measures this run's own window, not the time spent
            // waiting behind the active run (which already aborted queued
            // messages before their prompt ever reached the model).
            const active = context.chatAbortControllers.get(runId);
            if (active) {
              active.expiresAtMs = Math.max(
                active.expiresAtMs,
                resolveChatRunExpiresAtMs({ now: Date.now(), timeoutMs }),
              );
            }
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
        },
      })
        .then(async (dispatchResult) => {
          const handledWithoutReply = dispatchResult?.handledWithoutReplyReason;
          if (
            !agentRunStarted &&
            (handledWithoutReply === "queued" || handledWithoutReply === "dropped")
          ) {
            // The session was busy: the message waits on the follow-up queue instead of
            // starting a run. Tell clients it is queued (not finished) and keep the run
            // registered so probes report in_flight until the queued run settles.
            // Enqueue failures report "dropped" and already settled; skip the queued flash.
            if (handledWithoutReply === "queued") {
              // chat.abort may have won the race and already broadcast the aborted
              // terminal; a late queued notice would flip clients (e.g. TUI) back
              // to running with no terminal left to clear it.
              if (!context.chatAbortedRuns.has(clientRunId) && !abortController.signal.aborted) {
                // The queued message can wait behind a run for longer than its
                // own timeout window; extend the sweeper deadline to the
                // continuation window so the maintenance sweep does not abort it
                // before its prompt ever reaches the model.
                const active = context.chatAbortControllers.get(clientRunId);
                if (active?.continuationExpiresAtMs) {
                  active.expiresAtMs = Math.max(active.expiresAtMs, active.continuationExpiresAtMs);
                }
                broadcastChatQueued({ context, runId: clientRunId, sessionKey: rawSessionKey });
              }
            }
            // Safety valve: every queue path settles exactly once, but a missed one
            // would hang this closure forever. An abort always unblocks it because
            // chat.abort has already broadcast the aborted terminal state.
            const abortSettlement = new Promise<FollowupRunSettlement>((resolve) => {
              if (abortController.signal.aborted) {
                resolve({ outcome: "aborted" });
                return;
              }
              abortController.signal.addEventListener(
                "abort",
                () => resolve({ outcome: "aborted" }),
                { once: true },
              );
            });
            const settlement = await Promise.race([queuedSettlement, abortSettlement]);
            if (settlement.outcome === "done") {
              // Once the agent emitted activity, its lifecycle owns the terminal event.
              // A queued runner can also finish before emitting any lifecycle event
              // (for example, an early cancellation or empty pre-run result); close that
              // run here so clients do not remain stuck on the queued state. Tag the
              // outcome so clients keep "merged" reserved for real merges.
              if (!agentRunStarted && !context.chatAbortedRuns.has(clientRunId)) {
                broadcastChatFinal({
                  context,
                  runId: clientRunId,
                  sessionKey: rawSessionKey,
                  message: undefined,
                  stopReason: "done",
                });
              }
            } else if (settlement.outcome === "error" || settlement.outcome === "dropped") {
              if (context.chatAbortedRuns.has(clientRunId)) {
                // chat.abort already broadcast the aborted terminal state for this run;
                // never layer an error on top of it.
              } else if (settlement.outcome === "error") {
                // If the queued agent run already started, lifecycle events already
                // emitted the chat error under clientRunId. Synthesize a terminal only
                // when this run never reached onAgentRunStart.
                if (!agentRunStarted) {
                  broadcastChatError({
                    context,
                    runId: clientRunId,
                    sessionKey: rawSessionKey,
                    errorMessage: settlement.error,
                  });
                }
                context.dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: false,
                  payload: {
                    runId: clientRunId,
                    status: "error" as const,
                    summary: settlement.error,
                  },
                  error: errorShape(ErrorCodes.UNAVAILABLE, settlement.error),
                });
                return;
              } else {
                const reason =
                  settlement.reason === "duplicate"
                    ? "message already queued for this session"
                    : settlement.reason === "cleared"
                      ? "queued message discarded: session queue was cleared"
                      : settlement.reason === "summary-discarded"
                        ? "queued message discarded: queue overflow summary was dropped"
                        : "message dropped: session follow-up queue is full";
                broadcastChatError({
                  context,
                  runId: clientRunId,
                  sessionKey: rawSessionKey,
                  errorMessage: reason,
                });
                context.dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: false,
                  payload: { runId: clientRunId, status: "error" as const, summary: reason },
                  error: errorShape(ErrorCodes.UNAVAILABLE, reason),
                });
                return;
              }
            } else if (settlement.outcome === "aborted") {
              // chat.abort already broadcast the aborted state for this run. A batch
              // aborted through another run's id (collect merge) still needs a
              // terminal here or this client would hang on the queued state — and
              // it must say "aborted" (no reply will ever come), not a merge-shaped
              // silent final that clients render as "folded into the next reply".
              if (!context.chatAbortedRuns.has(clientRunId)) {
                broadcastChatSettlementAborted({
                  context,
                  runId: clientRunId,
                  sessionKey: rawSessionKey,
                });
              }
            } else {
              // merged / steered: the reply arrives under another run; close this
              // one silently, tagging the settlement outcome so clients can tell a
              // real merge apart from an aborted batch or an empty completion.
              if (!context.chatAbortedRuns.has(clientRunId)) {
                broadcastChatFinal({
                  context,
                  runId: clientRunId,
                  sessionKey: rawSessionKey,
                  message: undefined,
                  stopReason: settlement.outcome,
                });
              }
            }
            context.dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            });
            return;
          }
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } =
                loadSessionEntry(sessionKey);
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                agentId,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `${messageChannel} transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  // Keep this compatible with Pi stopReason enums even though this message isn't
                  // persisted to the transcript due to the append failure.
                  stopReason: "stop",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: rawSessionKey,
              message,
            });
          }
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            },
            error,
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: rawSessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
      idempotencyKey?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({ sessionKey: rawSessionKey, config: cfg }),
      createIfMissing: false,
      idempotencyKey: p.idempotencyKey,
    });
    if (appended.ok && appended.deduplicated) {
      respond(true, { ok: true, deduplicated: true });
      return;
    }
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to connected chat clients for immediate UI updates.
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey: rawSessionKey,
      seq: 0,
      state: "final" as const,
      message: stripInlineDirectiveTagsFromMessageForDisplay(
        stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
      ),
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(rawSessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
