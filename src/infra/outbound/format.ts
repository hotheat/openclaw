import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { getChatChannelMeta, normalizeChatChannelId } from "../../channels/registry.js";
import type { OutboundDeliveryResult } from "./deliver.js";

export type OutboundDeliveryJson = {
  channel: string;
  via: "direct" | "gateway";
  to: string;
  messageId: string;
  mediaUrl: string | null;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  meta?: Record<string, unknown>;
};

export type SafeMessageSendToolPayload = {
  channel?: string;
  via?: string;
  to?: string;
  attachmentCount?: number;
  mirroredFileNames?: string[];
  result?: OutboundDeliveryMeta;
};

type OutboundDeliveryMeta = {
  messageId?: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  meta?: Record<string, unknown>;
};

const resolveChannelLabel = (channel: string) => {
  const pluginLabel = getChannelPlugin(channel as ChannelId)?.meta.label;
  if (pluginLabel) {
    return pluginLabel;
  }
  const normalized = normalizeChatChannelId(channel);
  if (normalized) {
    return getChatChannelMeta(normalized).label;
  }
  return channel;
};

export function formatOutboundDeliverySummary(
  channel: string,
  result?: OutboundDeliveryResult,
): string {
  if (!result) {
    return `✅ Sent via ${resolveChannelLabel(channel)}. Message ID: unknown`;
  }

  const label = resolveChannelLabel(result.channel);
  const base = `✅ Sent via ${label}. Message ID: ${result.messageId}`;

  if ("chatId" in result) {
    return `${base} (chat ${result.chatId})`;
  }
  if ("channelId" in result) {
    return `${base} (channel ${result.channelId})`;
  }
  if ("roomId" in result) {
    return `${base} (room ${result.roomId})`;
  }
  if ("conversationId" in result) {
    return `${base} (conversation ${result.conversationId})`;
  }
  return base;
}

export function buildOutboundDeliveryJson(params: {
  channel: string;
  to: string;
  result?: OutboundDeliveryMeta | OutboundDeliveryResult;
  via?: "direct" | "gateway";
  mediaUrl?: string | null;
}): OutboundDeliveryJson {
  const { channel, to, result } = params;
  const messageId = result?.messageId ?? "unknown";
  const payload: OutboundDeliveryJson = {
    channel,
    via: params.via ?? "direct",
    to,
    messageId,
    mediaUrl: params.mediaUrl ?? null,
  };

  if (result && "chatId" in result && result.chatId !== undefined) {
    payload.chatId = result.chatId;
  }
  if (result && "channelId" in result && result.channelId !== undefined) {
    payload.channelId = result.channelId;
  }
  if (result && "roomId" in result && result.roomId !== undefined) {
    payload.roomId = result.roomId;
  }
  if (result && "conversationId" in result && result.conversationId !== undefined) {
    payload.conversationId = result.conversationId;
  }
  if (result && "timestamp" in result && result.timestamp !== undefined) {
    payload.timestamp = result.timestamp;
  }
  if (result && "toJid" in result && result.toJid !== undefined) {
    payload.toJid = result.toJid;
  }
  if (result && "meta" in result && result.meta !== undefined) {
    payload.meta = result.meta;
  }

  return payload;
}

export function buildSafeMessageSendToolPayload(payload: unknown): SafeMessageSendToolPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const safe: SafeMessageSendToolPayload = {};

  if (typeof record.channel === "string" && record.channel.trim()) {
    safe.channel = record.channel;
  }
  if (typeof record.via === "string" && record.via.trim()) {
    safe.via = record.via;
  }
  if (typeof record.to === "string" && record.to.trim()) {
    safe.to = record.to;
  }

  const mirroredFileNames = Array.isArray(record.mirroredFileNames)
    ? record.mirroredFileNames.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  if (mirroredFileNames.length > 0) {
    safe.mirroredFileNames = mirroredFileNames;
  }

  const mediaUrls = Array.isArray(record.mediaUrls)
    ? record.mediaUrls.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const mediaUrlCount =
    mediaUrls.length > 0
      ? mediaUrls.length
      : typeof record.mediaUrl === "string" && record.mediaUrl.trim()
        ? 1
        : 0;
  const attachmentCount = Math.max(mediaUrlCount, mirroredFileNames.length);
  if (attachmentCount > 0) {
    safe.attachmentCount = attachmentCount;
  }

  const result =
    record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : undefined;
  if (result) {
    const safeResult: OutboundDeliveryMeta = {};
    if (typeof result.messageId === "string" && result.messageId.trim()) {
      safeResult.messageId = result.messageId;
    }
    if (typeof result.chatId === "string" && result.chatId.trim()) {
      safeResult.chatId = result.chatId;
    }
    if (typeof result.channelId === "string" && result.channelId.trim()) {
      safeResult.channelId = result.channelId;
    }
    if (typeof result.roomId === "string" && result.roomId.trim()) {
      safeResult.roomId = result.roomId;
    }
    if (typeof result.conversationId === "string" && result.conversationId.trim()) {
      safeResult.conversationId = result.conversationId;
    }
    if (typeof result.toJid === "string" && result.toJid.trim()) {
      safeResult.toJid = result.toJid;
    }
    if (typeof result.timestamp === "number" && Number.isFinite(result.timestamp)) {
      safeResult.timestamp = result.timestamp;
    }
    if (result.meta && typeof result.meta === "object" && !Array.isArray(result.meta)) {
      safeResult.meta = result.meta as Record<string, unknown>;
    }
    if (Object.keys(safeResult).length > 0) {
      safe.result = safeResult;
    }
  }

  return safe;
}

export function formatGatewaySummary(params: {
  action?: string;
  channel?: string;
  messageId?: string | null;
}): string {
  const action = params.action ?? "Sent";
  const channelSuffix = params.channel ? ` (${params.channel})` : "";
  const messageId = params.messageId ?? "unknown";
  return `✅ ${action} via gateway${channelSuffix}. Message ID: ${messageId}`;
}
