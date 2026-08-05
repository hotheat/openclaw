import type { ChatAttachment } from "../chat-attachments.js";

export type RpcAttachmentInput = {
  type?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  content?: unknown;
  workspacePath?: unknown;
  sizeBytes?: unknown;
  sha256?: unknown;
  attachmentId?: unknown;
};

export function normalizeRpcAttachmentsToChatAttachments(
  attachments: RpcAttachmentInput[] | undefined,
): ChatAttachment[] {
  return (
    attachments
      ?.map((a) => ({
        type: typeof a?.type === "string" ? a.type : undefined,
        mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
        fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
        content:
          typeof a?.content === "string"
            ? a.content
            : ArrayBuffer.isView(a?.content)
              ? Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength).toString(
                  "base64",
                )
              : a?.content instanceof ArrayBuffer
                ? Buffer.from(a.content).toString("base64")
                : undefined,
        workspacePath: typeof a?.workspacePath === "string" ? a.workspacePath : undefined,
        sizeBytes: typeof a?.sizeBytes === "number" ? a.sizeBytes : undefined,
        sha256: typeof a?.sha256 === "string" ? a.sha256 : undefined,
        attachmentId: typeof a?.attachmentId === "string" ? a.attachmentId : undefined,
      }))
      .filter((a) => a.content || (a.type === "workspace_file" && a.workspacePath)) ?? []
  );
}
