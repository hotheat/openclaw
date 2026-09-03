import type { ImageContent } from "@mariozechner/pi-ai";
import type { WebchatAttachmentRef } from "../sessions/webchat-attachment-refs.js";
import type { FollowupRunSettlement } from "./reply/queue/types.js";
import type { TypingController } from "./reply/typing.js";

export type BlockReplyContext = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

/** Context passed to onModelSelected callback with actual model used. */
export type ModelSelectedContext = {
  provider: string;
  model: string;
  thinkLevel: string | undefined;
};

export type SessionLaneStartContext = {
  sessionId: string;
};

export type GetReplyOptions = {
  /** Override run id for agent events (defaults to random UUID). */
  runId?: string;
  /** Abort signal for the underlying agent run. */
  abortSignal?: AbortSignal;
  /** Optional inbound images (used for webchat attachments). */
  images?: ImageContent[];
  /** Private references persisted with the initial WebChat user message only. */
  webchatAttachmentRefs?: readonly WebchatAttachmentRef[];
  /** Notifies when an agent run actually starts (useful for webchat command handling). */
  onAgentRunStart?: (runId: string) => void;
  onReplyStart?: () => Promise<void> | void;
  /** Called when the typing controller cleans up (e.g., run ended with NO_REPLY). */
  onTypingCleanup?: () => void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean;
  /** Internal lifecycle hook invoked after the embedded session lane is acquired. */
  onSessionLaneStart?: (context: SessionLaneStartContext) => Promise<void> | void;
  /** Internal lifecycle hook invoked before the embedded session lane is released. */
  onSessionLaneComplete?: (payloads: ReplyPayload[] | undefined) => Promise<void> | void;
  /** Resolved heartbeat model override (provider/model string from merged per-agent config). */
  heartbeatModelOverride?: string;
  /** Resolved heartbeat thinking override from merged per-agent config. */
  heartbeatThinkingOverride?: string;
  /** If true, suppress tool error warning payloads for this run. */
  suppressToolErrorWarnings?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when a thinking/reasoning block ends. */
  onReasoningEnd?: () => Promise<void> | void;
  /** Called when a new assistant message starts (e.g., after tool call or thinking block). */
  onAssistantMessageStart?: () => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when a tool phase starts/updates, before summary payloads are emitted. */
  onToolStart?: (payload: { name?: string; phase?: string }) => Promise<void> | void;
  /** Called when a run completed user-visible work without dispatcher payloads. */
  onHandledWithoutReply?: (
    reason: "messaging_tool" | "silent" | "queued" | "dropped",
  ) => Promise<void> | void;
  /**
   * Called once a message reported as `queued` settles: it ran as its own agent run
   * (reusing `runId`), was merged/steered into another run, or never ran.
   */
  onQueuedRunSettled?: (settlement: FollowupRunSettlement) => void;
  /** Called when the actual model is selected (including after fallback).
   * Use this to get model/provider/thinkLevel for responsePrefix template interpolation. */
  onModelSelected?: (ctx: ModelSelectedContext) => void;
  disableBlockStreaming?: boolean;
  /** Timeout for block reply delivery (ms). */
  blockReplyTimeoutMs?: number;
  /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[];
  /** Mutable ref to track if a reply was sent (for Slack "first" threading mode). */
  hasRepliedRef?: { value: boolean };
  /** Override agent timeout in seconds (0 = no timeout). Threads through to resolveAgentTimeoutMs. */
  timeoutOverrideSeconds?: number;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  replyToTag?: boolean;
  /** True when [[reply_to_current]] was present but not yet mapped to a message id. */
  replyToCurrent?: boolean;
  /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  isError?: boolean;
  /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};
