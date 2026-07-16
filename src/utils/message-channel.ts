import type { ChannelId } from "../channels/plugins/types.js";
import {
  CHANNEL_IDS,
  listChatChannelAliases,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../gateway/protocol/client-info.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

export const INTERNAL_MESSAGE_CHANNEL = "internal" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;
export const CONTROL_UI_MESSAGE_CHANNEL = "control-ui" as const;
export type ControlUiMessageChannel = typeof CONTROL_UI_MESSAGE_CHANNEL;
export const WEBCHAT_MESSAGE_CHANNEL = "webchat" as const;
export type WebchatMessageChannel = typeof WEBCHAT_MESSAGE_CHANNEL;

const MARKDOWN_CAPABLE_CHANNELS = new Set<string>([
  "slack",
  "telegram",
  "signal",
  "discord",
  "googlechat",
  "tui",
  INTERNAL_MESSAGE_CHANNEL,
  CONTROL_UI_MESSAGE_CHANNEL,
  WEBCHAT_MESSAGE_CHANNEL,
]);

export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

const FIRST_PARTY_UI_CLIENT_NAMES = new Set<GatewayClientName>([
  GATEWAY_CLIENT_NAMES.CONTROL_UI,
  GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  GATEWAY_CLIENT_NAMES.MACOS_APP,
  GATEWAY_CLIENT_NAMES.IOS_APP,
  GATEWAY_CLIENT_NAMES.ANDROID_APP,
]);

export function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

export function isInternalMessageChannel(raw?: string | null): raw is InternalMessageChannel {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

export function isControlUiMessageChannel(raw?: string | null): raw is ControlUiMessageChannel {
  return normalizeMessageChannel(raw) === CONTROL_UI_MESSAGE_CHANNEL;
}

export function isControlUiClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.CONTROL_UI;
}

export function isFirstPartyUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientName = normalizeGatewayClientName(client?.id);
  return (
    normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.UI &&
    clientName !== undefined &&
    FIRST_PARTY_UI_CLIENT_NAMES.has(clientName)
  );
}

export function isWebchatMessageChannel(raw?: string | null): raw is WebchatMessageChannel {
  return normalizeMessageChannel(raw) === WEBCHAT_MESSAGE_CHANNEL;
}

export function isWebchatClient(client?: GatewayClientInfoLike | null): boolean {
  if (isControlUiClient(client)) {
    return false;
  }
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return true;
  }
  const clientName = normalizeGatewayClientName(client?.id);
  return (
    clientName === GATEWAY_CLIENT_NAMES.WEBCHAT_UI || clientName === GATEWAY_CLIENT_NAMES.WEBCHAT
  );
}

export function resolveGatewayClientMessageChannel(
  client?: GatewayClientInfoLike | null,
): ControlUiMessageChannel | WebchatMessageChannel | InternalMessageChannel {
  if (isControlUiClient(client) || isFirstPartyUiClient(client)) {
    return CONTROL_UI_MESSAGE_CHANNEL;
  }
  if (isWebchatClient(client)) {
    return WEBCHAT_MESSAGE_CHANNEL;
  }
  return INTERNAL_MESSAGE_CHANNEL;
}

export function normalizeMessageChannel(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  if (normalized === CONTROL_UI_MESSAGE_CHANNEL) {
    return CONTROL_UI_MESSAGE_CHANNEL;
  }
  if (normalized === WEBCHAT_MESSAGE_CHANNEL) {
    return WEBCHAT_MESSAGE_CHANNEL;
  }
  const builtIn = normalizeChatChannelId(normalized);
  if (builtIn) {
    return builtIn;
  }
  const registry = getActivePluginRegistry();
  const pluginMatch = registry?.channels.find((entry) => {
    if (entry.plugin.id.toLowerCase() === normalized) {
      return true;
    }
    return (entry.plugin.meta.aliases ?? []).some(
      (alias) => alias.trim().toLowerCase() === normalized,
    );
  });
  return pluginMatch?.plugin.id ?? normalized;
}

const listPluginChannelIds = (): string[] => {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return [];
  }
  return registry.channels.map((entry) => entry.plugin.id);
};

const listPluginChannelAliases = (): string[] => {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return [];
  }
  return registry.channels.flatMap((entry) => entry.plugin.meta.aliases ?? []);
};

export const listDeliverableMessageChannels = (): ChannelId[] =>
  Array.from(new Set([...CHANNEL_IDS, ...listPluginChannelIds()]));

export type DeliverableMessageChannel = ChannelId;

export type GatewayMessageChannel =
  | DeliverableMessageChannel
  | InternalMessageChannel
  | ControlUiMessageChannel
  | WebchatMessageChannel;

export const listGatewayMessageChannels = (): GatewayMessageChannel[] => [
  ...listDeliverableMessageChannels(),
  INTERNAL_MESSAGE_CHANNEL,
  CONTROL_UI_MESSAGE_CHANNEL,
  WEBCHAT_MESSAGE_CHANNEL,
];

export const listGatewayAgentChannelAliases = (): string[] =>
  Array.from(new Set([...listChatChannelAliases(), ...listPluginChannelAliases()]));

export type GatewayAgentChannelHint = GatewayMessageChannel | "last";

export const listGatewayAgentChannelValues = (): string[] =>
  Array.from(
    new Set([...listGatewayMessageChannels(), "last", ...listGatewayAgentChannelAliases()]),
  );

export function isGatewayMessageChannel(value: string): value is GatewayMessageChannel {
  return listGatewayMessageChannels().includes(value as GatewayMessageChannel);
}

export function isDeliverableMessageChannel(value: string): value is DeliverableMessageChannel {
  return listDeliverableMessageChannels().includes(value as DeliverableMessageChannel);
}

export function resolveGatewayMessageChannel(
  raw?: string | null,
): GatewayMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized) {
    return undefined;
  }
  return isGatewayMessageChannel(normalized) ? normalized : undefined;
}

export function resolveMessageChannel(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}

export function isMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return false;
  }
  return MARKDOWN_CAPABLE_CHANNELS.has(channel);
}
