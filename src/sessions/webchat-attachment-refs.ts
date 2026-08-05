import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type WebchatAttachmentRef = {
  attachmentId: string;
  ordinal: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeWebchatAttachmentRefs(value: unknown): WebchatAttachmentRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const refs: WebchatAttachmentRef[] = [];
  const seen = new Set<string>();
  const seenOrdinals = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.attachmentId !== "string" ||
      !UUID_PATTERN.test(record.attachmentId) ||
      !Number.isSafeInteger(record.ordinal) ||
      (record.ordinal as number) < 0 ||
      seen.has(record.attachmentId) ||
      seenOrdinals.has(record.ordinal as number)
    ) {
      return undefined;
    }
    seen.add(record.attachmentId);
    seenOrdinals.add(record.ordinal as number);
    refs.push({
      attachmentId: record.attachmentId,
      ordinal: record.ordinal as number,
    });
  }
  return refs.toSorted((left, right) => left.ordinal - right.ordinal);
}

export function applyWebchatAttachmentRefsToUserMessage(
  message: AgentMessage,
  refs: readonly WebchatAttachmentRef[] | undefined,
): AgentMessage {
  if (!refs || refs.length === 0 || (message as { role?: unknown }).role !== "user") {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    __openclaw: {
      attachments: refs.map((ref) => ({ ...ref })),
    },
  } as unknown as AgentMessage;
}

export function stripOpenClawPrivateFields(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (!("__openclaw" in (message as unknown as Record<string, unknown>))) {
      return message;
    }
    const next = { ...(message as unknown as Record<string, unknown>) };
    delete next.__openclaw;
    changed = true;
    return next as unknown as AgentMessage;
  });
  return changed ? sanitized : messages;
}
