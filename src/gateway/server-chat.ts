import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { CONTROL_UI_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = loadConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({
      cfg,
      channel: CONTROL_UI_MESSAGE_CHANNEL,
    });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaRevisions: Map<string, number>;
  deltaLastBroadcastRevisions: Map<string, number>;
  deltaLastNodeRevisions: Map<string, number>;
  deltaSeqs: Map<string, number>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaRevisions = new Map<string, number>();
  const deltaLastBroadcastRevisions = new Map<string, number>();
  const deltaLastNodeRevisions = new Map<string, number>();
  const deltaSeqs = new Map<string, number>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaRevisions.clear();
    deltaLastBroadcastRevisions.clear();
    deltaLastNodeRevisions.clear();
    deltaSeqs.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaRevisions,
    deltaLastBroadcastRevisions,
    deltaLastNodeRevisions,
    deltaSeqs,
    deltaSentAt,
    abortedRuns,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
}: AgentEventHandlerOptions) {
  const createChatDeltaPayload = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    text: string,
    timestamp: number,
  ) => ({
    runId: clientRunId,
    sessionKey,
    seq,
    state: "delta" as const,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp,
    },
  });

  const shouldSuppressChatDelta = (clientRunId: string, sourceRunId: string, text: string) =>
    isSilentReplyText(text, SILENT_REPLY_TOKEN) ||
    isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
    shouldHideHeartbeatChatOutput(clientRunId, sourceRunId);

  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
  ) => {
    const cleaned = stripInlineDirectiveTagsForDisplay(text).text;
    if (!cleaned) {
      return;
    }
    chatRunState.buffers.set(clientRunId, cleaned);
    const revision = (chatRunState.deltaRevisions.get(clientRunId) ?? 0) + 1;
    chatRunState.deltaRevisions.set(clientRunId, revision);
    chatRunState.deltaSeqs.set(clientRunId, seq);
    if (shouldSuppressChatDelta(clientRunId, sourceRunId, cleaned)) {
      return;
    }
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = createChatDeltaPayload(sessionKey, clientRunId, seq, cleaned, now);
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
    chatRunState.deltaLastNodeRevisions.set(clientRunId, revision);
  };

  // Boundary deltas reuse the seq of the latest assistant event they carry.
  // A reliable repeat may therefore share a seq with the earlier droppable
  // delta, while terminal events keep their own larger seq.
  const flushBufferedChatDeltaIfNeeded = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
  ) => {
    const revision = chatRunState.deltaRevisions.get(clientRunId);
    const sourceSeq = chatRunState.deltaSeqs.get(clientRunId);
    if (revision === undefined || sourceSeq === undefined) {
      return;
    }
    const needsReliableBroadcast =
      revision !== chatRunState.deltaLastBroadcastRevisions.get(clientRunId);
    const needsNodeSend = revision !== chatRunState.deltaLastNodeRevisions.get(clientRunId);
    if (!needsReliableBroadcast && !needsNodeSend) {
      return;
    }
    const cleaned = stripInlineDirectiveTagsForDisplay(
      chatRunState.buffers.get(clientRunId) ?? "",
    ).text;
    if (!cleaned || shouldSuppressChatDelta(clientRunId, sourceRunId, cleaned)) {
      return;
    }
    const now = Date.now();
    const payload = createChatDeltaPayload(sessionKey, clientRunId, sourceSeq, cleaned, now);
    if (needsReliableBroadcast) {
      broadcast("chat", payload);
      chatRunState.deltaLastBroadcastRevisions.set(clientRunId, revision);
    }
    if (needsNodeSend) {
      nodeSendToSession(sessionKey, "chat", payload);
      chatRunState.deltaLastNodeRevisions.set(clientRunId, revision);
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
    assistantMessageId?: string,
  ) => {
    flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, sourceRunId);
    const bufferedText = stripInlineDirectiveTagsForDisplay(
      chatRunState.buffers.get(clientRunId) ?? "",
    ).text.trim();
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: bufferedText,
    });
    const text = normalizedHeartbeatText.text.trim();
    const shouldSuppressSilent =
      normalizedHeartbeatText.suppress || isSilentReplyText(text, SILENT_REPLY_TOKEN);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaRevisions.delete(clientRunId);
    chatRunState.deltaLastBroadcastRevisions.delete(clientRunId);
    chatRunState.deltaLastNodeRevisions.delete(clientRunId);
    chatRunState.deltaSeqs.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        ...(shouldSuppressSilent ? { silent: true as const } : {}),
        ...(text && !shouldSuppressSilent && assistantMessageId
          ? { messageId: assistantMessageId }
          : {}),
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isReplay = evt.seq <= last;
    const isToolEvent = evt.stream === "tool";
    const toolPhase = isToolEvent && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload: strip result/partialResult unless verbose=full
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, Math.max(last, evt.seq));
    if (!isReplay && !isAborted && sessionKey && toolPhase === "start") {
      flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId);
    }
    if (isToolEvent) {
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients && recipients.size > 0) {
        broadcastToConnIds("agent", toolPayload, recipients);
      }
    } else {
      broadcast("agent", agentPayload);
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const assistantMessageId =
      lifecyclePhase === "end" &&
      typeof evt.data?.assistantMessageId === "string" &&
      evt.data.assistantMessageId.trim()
        ? evt.data.assistantMessageId
        : undefined;

    if (sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
      }
      if (
        !isReplay &&
        !isAborted &&
        evt.stream === "assistant" &&
        typeof evt.data?.text === "string"
      ) {
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text);
      } else if (
        !isReplay &&
        !isAborted &&
        (lifecyclePhase === "end" || lifecyclePhase === "error")
      ) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            assistantMessageId,
          );
        } else {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            assistantMessageId,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaRevisions.delete(clientRunId);
        chatRunState.deltaLastBroadcastRevisions.delete(clientRunId);
        chatRunState.deltaLastNodeRevisions.delete(clientRunId);
        chatRunState.deltaSeqs.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (!isReplay && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }
  };
}
