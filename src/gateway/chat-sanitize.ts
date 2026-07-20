import { INBOUND_MEDIA_REPLY_HINT } from "../auto-reply/media-note.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";

export { stripEnvelope };

const MEDIA_ATTACHED_LINE_RE = /^\[media attached(?::| \d+\/\d+:) .*\]$/;

function stripLeadingInboundMediaPrompt(text: string): string {
  const lines = text.split(/\r?\n/);
  if (!MEDIA_ATTACHED_LINE_RE.test(lines[0] ?? "")) {
    return text;
  }

  let index = 0;
  while (index < lines.length && MEDIA_ATTACHED_LINE_RE.test(lines[index] ?? "")) {
    index += 1;
  }
  if (lines[index] === INBOUND_MEDIA_REPLY_HINT) {
    index += 1;
  }
  while (lines[index] === "") {
    index += 1;
  }
  return lines.slice(index).join("\n");
}

function stripTextForDisplay(text: string, stripUserEnvelope: boolean): string {
  const inboundStripped = stripInboundMetadata(text);
  if (!stripUserEnvelope) {
    return inboundStripped;
  }
  const mediaStripped = stripLeadingInboundMediaPrompt(inboundStripped);
  return stripMessageIdHints(stripEnvelope(mediaStripped));
}

export function stripUserTextForDisplay(text: string): string {
  return stripTextForDisplay(text, true);
}

function stripEnvelopeFromContentWithRole(
  content: unknown[],
  stripUserEnvelope: boolean,
): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return item;
    }
    const stripped = stripTextForDisplay(entry.text, stripUserEnvelope);
    if (stripped === entry.text) {
      return item;
    }
    changed = true;
    return {
      ...entry,
      text: stripped,
    };
  });
  return { content: next, changed };
}

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const stripUserEnvelope = role === "user";

  let changed = false;
  const next: Record<string, unknown> = { ...entry };

  if (typeof entry.content === "string") {
    const stripped = stripTextForDisplay(entry.content, stripUserEnvelope);
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContentWithRole(entry.content, stripUserEnvelope);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripTextForDisplay(entry.text, stripUserEnvelope);
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : messages;
}
