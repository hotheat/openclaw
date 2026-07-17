import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyPayloadKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  isRenderablePayload,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

export function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: Parameters<
    typeof shouldSuppressMessagingToolReplies
  >[0]["messagingToolSentTargets"];
  originatingTo?: string;
  accountId?: string;
}): {
  replyPayloads: ReplyPayload[];
  didLogHeartbeatStrip: boolean;
  didSkipSilentPayload: boolean;
} {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  let didSkipSilentPayload = false;
  const sanitizedPayloads = params.isHeartbeat
    ? params.payloads
    : params.payloads.flatMap((payload) => {
        let text = payload.text;

        if (payload.isError && text && isBunFetchSocketError(text)) {
          text = formatBunFetchSocketError(text);
        }

        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [{ ...payload, text }];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        if (stripped.didStrip && !didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from reply");
        }
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });

  const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode: params.replyToMode,
    replyToChannel: params.replyToChannel,
    currentMessageId: params.currentMessageId,
  })
    .map((payload) => {
      const normalized = normalizeReplyPayloadDirectives({
        payload,
        currentMessageId: params.currentMessageId,
        silentToken: SILENT_REPLY_TOKEN,
        parseMode: "always",
      });
      didSkipSilentPayload =
        didSkipSilentPayload || (normalized.isSilent && !isRenderablePayload(normalized.payload));
      return normalized.payload;
    })
    .filter(isRenderablePayload);

  // A mixed final list can contain streamed progress blocks plus a later non-streamed answer.
  // Preserve historical whole-list suppression when no final payload matches the pipeline.
  // If streaming aborted, suppress only payloads that were actually delivered.
  const didCompleteBlockStreaming =
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: params.messageProvider,
    messagingToolSentTargets,
    originatingTo: params.originatingTo,
    accountId: params.accountId,
  });
  // Only dedupe against messaging tool sends for the same origin target.
  // Cross-target sends (for example posting to another channel) must not
  // suppress the current conversation's final reply.
  // If target metadata is unavailable, keep legacy dedupe behavior.
  const dedupeMessagingToolPayloads =
    suppressMessagingToolReplies || messagingToolSentTargets.length === 0;
  const dedupedPayloads = dedupeMessagingToolPayloads
    ? filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: messagingToolSentTexts,
      })
    : replyTaggedPayloads;
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: params.messagingToolSentMediaUrls ?? [],
      })
    : dedupedPayloads;
  const includesEnqueuedBlockPayload =
    didCompleteBlockStreaming &&
    mediaFilteredPayloads.some((payload) => params.blockReplyPipeline?.hasEnqueuedPayload(payload));
  const shouldDropAllFinalPayloads = didCompleteBlockStreaming && !includesEnqueuedBlockPayload;
  // Filter out payloads already sent via pipeline or directly during tool flush.
  const filteredPayloads = shouldDropAllFinalPayloads
    ? []
    : params.blockStreamingEnabled
      ? mediaFilteredPayloads.filter((payload) =>
          didCompleteBlockStreaming
            ? !params.blockReplyPipeline?.hasEnqueuedPayload(payload)
            : !params.blockReplyPipeline?.hasSentPayload(payload),
        )
      : params.directlySentBlockKeys?.size
        ? mediaFilteredPayloads.filter(
            (payload) => !params.directlySentBlockKeys!.has(createBlockReplyPayloadKey(payload)),
          )
        : mediaFilteredPayloads;
  const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

  return {
    replyPayloads,
    didLogHeartbeatStrip,
    didSkipSilentPayload,
  };
}
