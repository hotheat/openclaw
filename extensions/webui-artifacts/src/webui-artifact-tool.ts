import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { Type } from "@sinclair/typebox";
import { FsSafeError, root, type OpenResult } from "openclaw/plugin-sdk";
import {
  ARTIFACT_SESSION_LIMIT_CODE,
  ArtifactApiError,
  type ArtifactTransport,
} from "./artifact-client.js";

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const ARTIFACT_SESSION_LIMIT_MESSAGE = "本会话最多交付 50 个文件，请新建会话后继续";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bat": "application/x-msdownload",
  ".cmd": "application/x-msdownload",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".exe": "application/x-msdownload",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".msi": "application/x-msdownload",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".sh": "application/x-sh",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

type ArtifactToolParams = {
  filePath: string;
  filename?: string;
  caption?: string;
};

type FileDigest = {
  sizeBytes: number;
  sha256: string;
  md5Hex: string;
  md5Base64: string;
  signature: Buffer;
};

type ArtifactToolOptions = {
  client: ArtifactTransport;
  sessionKey: string;
  workspaceDir: string;
  afterScan?: (opened: OpenResult) => void | Promise<void>;
};

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function resolveContentType(fileName: string, stat: Stats, signature: Buffer): string {
  if (signature.subarray(0, 2).equals(Buffer.from("MZ"))) {
    return "application/x-msdownload";
  }
  if (
    signature.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    signature.subarray(0, 2).equals(Buffer.from("#!")) ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(
      signature.subarray(0, 4).toString("hex"),
    )
  ) {
    return "application/x-executable";
  }
  const fromExtension = MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()];
  if (fromExtension) {
    return fromExtension;
  }
  return (stat.mode & 0o111) !== 0 ? "application/x-executable" : "application/octet-stream";
}

function resolveFileName(value: string | undefined, realPath: string): string {
  const fallback = path.basename(realPath);
  const requested = value?.trim();
  if (!requested) {
    return fallback;
  }
  if (
    requested !== path.basename(requested) ||
    requested === "." ||
    requested === ".." ||
    /[\u0000-\u001f\u007f]/.test(requested)
  ) {
    throw new Error("Artifact filename is invalid");
  }
  return requested;
}

async function scanFile(
  opened: OpenResult,
  afterScan?: ArtifactToolOptions["afterScan"],
): Promise<FileDigest> {
  if (opened.stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact file exceeds the 100 MB limit");
  }
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let sizeBytes = 0;
  let signature = Buffer.alloc(0);
  const stream = opened.handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    sizeBytes += buffer.byteLength;
    if (sizeBytes > MAX_ARTIFACT_BYTES) {
      stream.destroy();
      throw new Error("Artifact file exceeds the 100 MB limit");
    }
    if (signature.byteLength < 4) {
      signature = Buffer.concat([signature, buffer.subarray(0, 4 - signature.byteLength)]);
    }
    sha256.update(buffer);
    md5.update(buffer);
  }
  await afterScan?.(opened);
  const [afterStat, pathStat] = await Promise.all([opened.handle.stat(), fs.stat(opened.realPath)]);
  if (
    sizeBytes !== opened.stat.size ||
    !sameFileSnapshot(opened.stat, afterStat) ||
    opened.stat.dev !== pathStat.dev ||
    opened.stat.ino !== pathStat.ino
  ) {
    throw new Error("Artifact file changed while it was being scanned");
  }
  const md5Digest = md5.digest();
  return {
    sizeBytes,
    sha256: sha256.digest("hex"),
    md5Hex: md5Digest.toString("hex"),
    md5Base64: md5Digest.toString("base64"),
    signature,
  };
}

export function createUploadCounter(declaredSize: number): Transform {
  let uploadedBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      uploadedBytes += chunk.byteLength;
      if (uploadedBytes > declaredSize || uploadedBytes > MAX_ARTIFACT_BYTES) {
        callback(new Error("Artifact upload exceeded the declared size"));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (uploadedBytes !== declaredSize) {
        callback(new Error("Artifact upload size did not match the declared size"));
        return;
      }
      callback();
    },
  });
  return counter;
}

function createCountedUploadStream(opened: OpenResult, declaredSize: number): Transform {
  const counter = createUploadCounter(declaredSize);
  const source = opened.handle.createReadStream({ autoClose: false, start: 0 });
  source.once("error", (error) => counter.destroy(error));
  counter.once("close", () => {
    if (!source.readableEnded) {
      source.destroy();
    }
  });
  source.pipe(counter);
  return counter;
}

async function verifyCurrentPath(opened: OpenResult): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    opened.handle.stat(),
    fs.stat(opened.realPath),
  ]);
  if (
    !sameFileSnapshot(opened.stat, handleStat) ||
    opened.stat.dev !== pathStat.dev ||
    opened.stat.ino !== pathStat.ino
  ) {
    throw new Error("Artifact file changed after it was opened");
  }
}

function safeInputError(error: unknown): Error | null {
  if (error instanceof FsSafeError) {
    return new Error("Artifact file must be a regular file within the current workspace");
  }
  if (
    error instanceof Error &&
    (error.message.startsWith("Artifact file") || error.message.startsWith("Artifact filename"))
  ) {
    return error;
  }
  return null;
}

function toolResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

export type PublishedWorkspaceArtifact = {
  artifactId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  caption?: string;
};

export async function publishWorkspaceArtifact(params: {
  client: ArtifactTransport;
  sessionKey: string;
  workspaceDir: string;
  filePath: string;
  filename?: string;
  caption?: string;
  sourceId?: string;
  signal?: AbortSignal;
  afterScan?: ArtifactToolOptions["afterScan"];
}): Promise<PublishedWorkspaceArtifact> {
  let opened: OpenResult | null = null;
  let artifactId: string | undefined;
  let phase: "scan" | "init" | "upload" | "complete" = "scan";
  try {
    const filePath = params.filePath.trim();
    if (!filePath) {
      throw new Error("Artifact filePath is required");
    }
    opened = await (
      await root(params.workspaceDir)
    ).open(filePath, {
      hardlinks: "allow",
      nonBlockingRead: true,
    });
    const digest = await scanFile(opened, params.afterScan);
    const fileName = resolveFileName(params.filename, opened.realPath);
    const contentType = resolveContentType(
      path.basename(opened.realPath),
      opened.stat,
      digest.signature,
    );
    if (digest.md5Hex.length !== 32) {
      throw new Error("Artifact file hash validation failed");
    }

    phase = "init";
    const initialized = await params.client.init(
      {
        sessionKey: params.sessionKey,
        fileName,
        contentType,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        md5Base64: digest.md5Base64,
        sourceToolCallId: params.sourceId?.trim() || undefined,
      },
      params.signal,
    );
    artifactId = initialized.artifactId;

    await verifyCurrentPath(opened);
    phase = "upload";
    const uploadStream = createCountedUploadStream(opened, digest.sizeBytes);
    try {
      await params.client.upload({
        target: initialized.upload,
        body: uploadStream,
        sizeBytes: digest.sizeBytes,
        signal: params.signal,
      });
    } finally {
      uploadStream.destroy();
    }
    await verifyCurrentPath(opened);

    phase = "complete";
    await params.client.complete(artifactId, params.signal);
    return {
      artifactId,
      fileName,
      contentType,
      sizeBytes: digest.sizeBytes,
      ...(params.caption?.trim() ? { caption: params.caption.trim() } : {}),
    };
  } catch (error) {
    if (
      error instanceof ArtifactApiError &&
      error.phase === "init" &&
      error.status === 409 &&
      error.code === ARTIFACT_SESSION_LIMIT_CODE
    ) {
      throw new Error(ARTIFACT_SESSION_LIMIT_MESSAGE);
    }
    const inputError = artifactId ? null : safeInputError(error);
    if (inputError) {
      throw inputError;
    }
    if (artifactId) {
      await params.client.abort(artifactId).catch(() => {});
    }
    throw new Error(
      `Artifact publish failed (${artifactId ? `artifactId=${artifactId}, ` : ""}phase=${phase})`,
    );
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

export function createWebuiArtifactTool(options: ArtifactToolOptions) {
  return {
    name: "webui_artifact_publish",
    label: "Publish WebUI Artifact",
    description:
      "Publish a file from the current workspace to the current authenticated WebUI session. Use this for browser file delivery; use message only for explicit external channel targets such as Feishu.",
    parameters: Type.Object(
      {
        filePath: Type.String({
          description: "Path to a regular file inside the current workspace.",
        }),
        filename: Type.Optional(
          Type.String({ description: "Optional download filename without directory components." }),
        ),
        caption: Type.Optional(Type.String({ description: "Optional user-facing caption." })),
      },
      { additionalProperties: false },
    ),
    async execute(toolCallId: string, rawParams: ArtifactToolParams, signal?: AbortSignal) {
      return toolResult(
        await publishWorkspaceArtifact({
          client: options.client,
          sessionKey: options.sessionKey,
          workspaceDir: options.workspaceDir,
          filePath: rawParams.filePath,
          filename: rawParams.filename,
          caption: rawParams.caption,
          sourceId: toolCallId,
          signal,
          afterScan: options.afterScan,
        }),
      );
    },
  };
}
