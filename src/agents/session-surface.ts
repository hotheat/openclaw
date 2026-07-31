import { normalizeMessageChannel } from "../utils/message-channel.js";

export function isParentWebchatSessionKey(sessionKey?: string): boolean {
  const parts = sessionKey?.split(":") ?? [];
  return (
    parts.length === 5 &&
    parts[0] === "agent" &&
    Boolean(parts[1]) &&
    parts[2] === "webchat" &&
    Boolean(parts[3]) &&
    Boolean(parts[4])
  );
}

export function isParentWebchatSessionContext(params: {
  channel?: string;
  sessionKey?: string;
}): boolean {
  const channel = normalizeMessageChannel(params.channel);
  return (
    (channel === "webchat" || channel === "internal") &&
    isParentWebchatSessionKey(params.sessionKey)
  );
}
