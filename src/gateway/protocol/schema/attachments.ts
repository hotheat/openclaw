import { Type } from "@sinclair/typebox";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_WEBCHAT_WORKSPACE_UPLOAD_BYTES,
} from "../../chat-attachment-limits.js";

const AttachmentTypeSchema = Type.String({ minLength: 1, maxLength: 64 });
const AttachmentMimeTypeSchema = Type.String({ minLength: 1, maxLength: 255 });
const AttachmentFileNameSchema = Type.String({ minLength: 1, maxLength: 255 });
const AttachmentIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const InlineChatAttachmentSchema = Type.Object(
  {
    type: Type.Optional(AttachmentTypeSchema),
    mimeType: Type.Optional(AttachmentMimeTypeSchema),
    fileName: Type.Optional(AttachmentFileNameSchema),
    content: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const WorkspaceFileChatAttachmentSchema = Type.Object(
  {
    type: Type.Literal("workspace_file"),
    mimeType: Type.Optional(AttachmentMimeTypeSchema),
    fileName: Type.Optional(AttachmentFileNameSchema),
    workspacePath: Type.String({ minLength: 1, maxLength: 1024 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_WEBCHAT_WORKSPACE_UPLOAD_BYTES }),
    sha256: Type.String({ pattern: "^[0-9a-fA-F]{64}$" }),
    attachmentId: Type.Optional(AttachmentIdSchema),
  },
  { additionalProperties: false },
);

export const ChatAttachmentSchema = Type.Union([
  InlineChatAttachmentSchema,
  WorkspaceFileChatAttachmentSchema,
]);

export const InlineChatAttachmentsSchema = Type.Array(InlineChatAttachmentSchema, {
  maxItems: MAX_CHAT_ATTACHMENTS,
});

export const ChatAttachmentsSchema = Type.Array(ChatAttachmentSchema, {
  maxItems: MAX_CHAT_ATTACHMENTS,
});
