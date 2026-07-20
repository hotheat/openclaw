import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { MAX_WEBCHAT_WORKSPACE_UPLOAD_BYTES } from "./chat-attachment-limits.js";

export { MAX_WEBCHAT_WORKSPACE_UPLOAD_BYTES } from "./chat-attachment-limits.js";

export type ChatAttachmentMaterializeParams = {
  sessionKey: string;
  artifactId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
};

export type MaterializedChatAttachment = {
  workspacePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

function resolveWebchatClientSessionId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (
    parts.length !== 5 ||
    parts[0] !== "agent" ||
    !parts[1] ||
    parts[2] !== "webchat" ||
    !parts[3] ||
    !/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(parts[4] ?? "")
  ) {
    throw new Error("attachment materialization requires a parent WebChat session");
  }
  return parts[4];
}

function sanitizeUploadFileName(fileName: string): string {
  const base = path.basename(fileName.normalize("NFC"));
  const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") {
    return "upload.bin";
  }
  return safe.slice(0, 180);
}

async function hashExistingFile(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const rawChunk of createReadStream(filePath)) {
    const chunk = Buffer.from(rawChunk);
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function inspectExistingTarget(
  targetPath: string,
  expected: { sizeBytes: number; sha256: string },
): Promise<"missing" | "matching" | "conflict"> {
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isFile()) {
      return "conflict";
    }
    const actual = await hashExistingFile(targetPath);
    return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256
      ? "matching"
      : "conflict";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "conflict";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

export async function materializeChatAttachment(params: {
  cfg: OpenClawConfig;
  input: ChatAttachmentMaterializeParams;
}): Promise<MaterializedChatAttachment> {
  const { input } = params;
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_WEBCHAT_WORKSPACE_UPLOAD_BYTES
  ) {
    throw new Error("attachment size exceeds the configured limit");
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.artifactId)) {
    throw new Error("attachment artifact ID is invalid");
  }
  const expectedSha256 = input.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("attachment SHA-256 is invalid");
  }

  const clientSessionId = resolveWebchatClientSessionId(input.sessionKey);
  const agentId = resolveSessionAgentId({ sessionKey: input.sessionKey, config: params.cfg });
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, agentId));
  await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
  const safeName = sanitizeUploadFileName(input.fileName);
  const relativePath = path.join(
    "uploads",
    "webchat",
    clientSessionId,
    `${input.artifactId}-${safeName}`,
  );
  const targetPath = path.resolve(workspaceDir, relativePath);
  const allowedRoot = path.resolve(workspaceDir, "uploads", "webchat");
  if (targetPath !== allowedRoot && !targetPath.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error("attachment target escapes the Agent workspace");
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const canonicalParentDir = await fs.realpath(path.dirname(targetPath));
  const canonicalAllowedRoot = path.join(canonicalWorkspaceDir, "uploads", "webchat");
  if (
    canonicalParentDir !== canonicalAllowedRoot &&
    !canonicalParentDir.startsWith(`${canonicalAllowedRoot}${path.sep}`)
  ) {
    throw new Error("attachment target resolves outside the Agent workspace");
  }
  const expectedTarget = { sizeBytes: input.sizeBytes, sha256: expectedSha256 };
  const existingTarget = await inspectExistingTarget(targetPath, expectedTarget);
  if (existingTarget === "matching") {
    return {
      workspacePath: relativePath,
      fileName: safeName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: expectedSha256,
    };
  }
  if (existingTarget === "conflict") {
    throw new Error("attachment artifact already exists with different content");
  }

  const tempPath = `${targetPath}.tmp-${randomUUID()}`;
  let release: (() => Promise<void>) | undefined;
  try {
    const fetched = await fetchWithSsrFGuard({
      url: input.downloadUrl,
      maxRedirects: 2,
      timeoutMs: 2 * 60_000,
      auditContext: "webchat-workspace-upload",
    });
    release = fetched.release;
    if (!fetched.response.ok || !fetched.response.body) {
      throw new Error(`attachment download failed with HTTP ${fetched.response.status}`);
    }
    const contentLengthHeader = fetched.response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength !== input.sizeBytes) {
        throw new Error("attachment content length does not match declared size");
      }
    }

    const hash = createHash("sha256");
    let receivedBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > input.sizeBytes || receivedBytes > MAX_WEBCHAT_WORKSPACE_UPLOAD_BYTES) {
          callback(new Error("attachment download exceeds the configured limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(fetched.response.body as unknown as import("stream/web").ReadableStream),
      meter,
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
    if (receivedBytes !== input.sizeBytes || hash.digest("hex") !== expectedSha256) {
      throw new Error("attachment integrity verification failed");
    }
    try {
      await fs.link(tempPath, targetPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      if ((await inspectExistingTarget(targetPath, expectedTarget)) !== "matching") {
        throw new Error("attachment artifact already exists with different content", {
          cause: error,
        });
      }
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
    await release?.();
  }

  return {
    workspacePath: relativePath,
    fileName: safeName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    sha256: expectedSha256,
  };
}
