import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_WORKSPACE_ATTACHMENTS_TOTAL_BYTES,
} from "./chat-attachment-limits.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
  workspacePath?: string;
  sizeBytes?: number;
  sha256?: string;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
  mediaPaths: string[];
  mediaTypes: string[];
};

type AttachmentLog = {
  warn: (message: string) => void;
};

type NormalizedAttachment = {
  label: string;
  mime: string;
  base64: string;
};

type ParseMessageWithAttachmentsOptions = {
  maxBytes?: number;
  log?: AttachmentLog;
  workspaceDir?: string;
  webchatClientSessionId?: string;
};

function normalizeMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidBase64(value: string): boolean {
  // Minimal validation; avoid full decode allocations for large payloads.
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function normalizeAttachment(
  att: ChatAttachment,
  idx: number,
  opts: { stripDataUrlPrefix: boolean; requireImageMime: boolean },
): NormalizedAttachment {
  const mime = att.mimeType ?? "";
  const content = att.content;
  const label = att.fileName || att.type || `attachment-${idx + 1}`;

  if (typeof content !== "string") {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  if (opts.requireImageMime && !mime.startsWith("image/")) {
    throw new Error(`attachment ${label}: only image/* supported`);
  }

  let base64 = content.trim();
  if (opts.stripDataUrlPrefix) {
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,...").
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
    if (dataUrlMatch) {
      base64 = dataUrlMatch[1];
    }
  }
  return { label, mime, base64 };
}

function validateAttachmentBase64OrThrow(
  normalized: NormalizedAttachment,
  opts: { maxBytes: number },
): number {
  if (!isValidBase64(normalized.base64)) {
    throw new Error(`attachment ${normalized.label}: invalid base64 content`);
  }
  const sizeBytes = estimateBase64DecodedBytes(normalized.base64);
  if (sizeBytes <= 0 || sizeBytes > opts.maxBytes) {
    throw new Error(
      `attachment ${normalized.label}: exceeds size limit (${sizeBytes} > ${opts.maxBytes} bytes)`,
    );
  }
  return sizeBytes;
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const rawChunk of createReadStream(filePath)) {
    hash.update(Buffer.from(rawChunk));
  }
  return hash.digest("hex");
}

function validateAttachmentBudgets(attachments: ChatAttachment[]): void {
  if (attachments.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(
      `attachments exceed count limit (${attachments.length} > ${MAX_CHAT_ATTACHMENTS})`,
    );
  }

  let workspaceBytes = 0;
  for (const [idx, att] of attachments.entries()) {
    if (!att || att.type !== "workspace_file") {
      continue;
    }
    const label = att.fileName || idx + 1;
    if (!Number.isSafeInteger(att.sizeBytes) || (att.sizeBytes ?? 0) <= 0) {
      throw new Error(`attachment ${label}: workspace file size is required`);
    }
    const expectedSha256 = att.sha256?.trim().toLowerCase() ?? "";
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error(`attachment ${label}: workspace file SHA-256 is required`);
    }
    workspaceBytes += att.sizeBytes as number;
    if (workspaceBytes > MAX_CHAT_WORKSPACE_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(
        `workspace attachments exceed total size limit (${workspaceBytes} > ${MAX_CHAT_WORKSPACE_ATTACHMENTS_TOTAL_BYTES} bytes)`,
      );
    }
  }
}

/**
 * Parse attachments and extract images as structured content blocks.
 * Returns the message text and an array of image content blocks
 * compatible with Claude API's image format.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: ParseMessageWithAttachmentsOptions,
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000; // decoded bytes (5,000,000)
  const log = opts?.log;
  if (!attachments || attachments.length === 0) {
    return { message, images: [], mediaPaths: [], mediaTypes: [] };
  }
  validateAttachmentBudgets(attachments);

  const images: ChatImageContent[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  const validatedWorkspaceFiles = new Map<
    string,
    { canonicalPath: string; sizeBytes: number; sha256: string }
  >();

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    if (att.type === "workspace_file") {
      const workspaceDir = opts?.workspaceDir?.trim();
      const webchatClientSessionId = opts?.webchatClientSessionId?.trim();
      const workspacePath = att.workspacePath?.trim();
      if (
        !workspaceDir ||
        !webchatClientSessionId ||
        !workspacePath ||
        path.isAbsolute(workspacePath)
      ) {
        throw new Error(`attachment ${att.fileName || idx + 1}: invalid workspace path`);
      }
      const sizeBytes = att.sizeBytes as number;
      const expectedSha256 = att.sha256?.trim().toLowerCase() ?? "";
      const normalizedRelativePath = path.normalize(workspacePath);
      const allowedPrefix = path.join("uploads", "webchat", webchatClientSessionId) + path.sep;
      if (
        normalizedRelativePath.startsWith(`..${path.sep}`) ||
        !normalizedRelativePath.startsWith(allowedPrefix)
      ) {
        throw new Error(`attachment ${att.fileName || idx + 1}: workspace path is not allowed`);
      }
      const cached = validatedWorkspaceFiles.get(normalizedRelativePath);
      if (cached) {
        if (cached.sizeBytes !== sizeBytes || cached.sha256 !== expectedSha256) {
          throw new Error(
            `attachment ${att.fileName || idx + 1}: workspace file metadata mismatch`,
          );
        }
        mediaPaths.push(cached.canonicalPath);
        mediaTypes.push(normalizeMime(att.mimeType) ?? "application/octet-stream");
        continue;
      }
      const workspaceRoot = path.resolve(workspaceDir);
      const canonicalWorkspaceRoot = await fs.realpath(workspaceRoot).catch(() => undefined);
      if (!canonicalWorkspaceRoot) {
        throw new Error(`attachment ${att.fileName || idx + 1}: workspace is unavailable`);
      }
      const resolvedPath = path.resolve(workspaceRoot, normalizedRelativePath);
      if (!resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error(`attachment ${att.fileName || idx + 1}: workspace path escapes root`);
      }
      const canonicalPath = await fs.realpath(resolvedPath).catch(() => undefined);
      if (!canonicalPath || !canonicalPath.startsWith(`${canonicalWorkspaceRoot}${path.sep}`)) {
        throw new Error(`attachment ${att.fileName || idx + 1}: workspace file is unavailable`);
      }
      const stat = await fs.stat(canonicalPath);
      if (!stat.isFile() || stat.size !== sizeBytes) {
        throw new Error(`attachment ${att.fileName || idx + 1}: workspace file metadata mismatch`);
      }
      if ((await hashFileSha256(canonicalPath)) !== expectedSha256) {
        throw new Error(`attachment ${att.fileName || idx + 1}: workspace file metadata mismatch`);
      }
      validatedWorkspaceFiles.set(normalizedRelativePath, {
        canonicalPath,
        sizeBytes,
        sha256: expectedSha256,
      });
      mediaPaths.push(canonicalPath);
      mediaTypes.push(normalizeMime(att.mimeType) ?? "application/octet-stream");
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: true,
      requireImageMime: false,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64: b64, label, mime } = normalized;

    const providedMime = normalizeMime(mime);
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
    if (sniffedMime && !isImageMime(sniffedMime)) {
      log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
      continue;
    }
    if (!sniffedMime && !isImageMime(providedMime)) {
      log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
      continue;
    }
    if (sniffedMime && providedMime && sniffedMime !== providedMime) {
      log?.warn(
        `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
      );
    }

    images.push({
      type: "image",
      data: b64,
      mimeType: sniffedMime ?? providedMime ?? mime,
    });
  }

  return { message, images, mediaPaths, mediaTypes };
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) {
    return message;
  }

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: false,
      requireImageMime: true,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64, label, mime } = normalized;

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${base64})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) {
    return message;
  }
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
