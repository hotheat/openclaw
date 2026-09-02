import { Type } from "@sinclair/typebox";
import { ChatAttachmentsSchema } from "./attachments.js";
import { NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    before: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);

export const ChatHistoryMessageSchema = Type.Unsafe<
  { historyEntryId: string; timestamp?: number } & Record<string, unknown>
>({
  type: "object",
  properties: {
    historyEntryId: NonEmptyString,
    timestamp: Type.Optional(Type.Number({ minimum: 1 })),
  },
  required: ["historyEntryId"],
  additionalProperties: true,
});

export const ChatHistoryResultSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    sessionId: Type.Optional(NonEmptyString),
    messages: Type.Array(ChatHistoryMessageSchema),
    nextBefore: Type.Optional(NonEmptyString),
    hasMore: Type.Boolean(),
    cursorReset: Type.Boolean(),
    thinkingLevel: Type.Optional(Type.String()),
    verboseLevel: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(ChatAttachmentsSchema),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatSteerParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: NonEmptyString,
    idempotencyKey: NonEmptyString,
    message: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatSteerResultSchema = Type.Union([
  Type.Object(
    {
      runId: NonEmptyString,
      status: Type.Literal("accepted"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: NonEmptyString,
      status: Type.Literal("not_steerable"),
      reason: Type.Union([
        Type.Literal("run_inactive"),
        Type.Literal("not_streaming"),
        Type.Literal("compacting"),
      ]),
    },
    { additionalProperties: false },
  ),
]);

export const ChatAttachmentMaterializeParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    artifactId: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" }),
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.String({ minLength: 1, maxLength: 255 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: 100 * 1024 * 1024 }),
    sha256: Type.String({ pattern: "^[0-9a-fA-F]{64}$" }),
    downloadUrl: Type.String({ minLength: 1, maxLength: 8192 }),
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    messageId: Type.Optional(NonEmptyString),
    silent: Type.Optional(Type.Boolean()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
