const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { detectedMimeMatchesExtension, requiresDetectedMime } = require("./artifact-mime.js");
const { normalizeRelativePath } = require("./artifact-profiles.js");
const { asTrimmedString, isPathInsideBase } = require("./runtime-context.js");

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const SUPPORTS_NONBLOCK = process.platform !== "win32" && "O_NONBLOCK" in fsConstants;
const SAFE_READ_FLAGS =
  fsConstants.O_RDONLY |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0) |
  (SUPPORTS_NONBLOCK ? fsConstants.O_NONBLOCK : 0);
const SAFE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const MIME_SNIFF_BYTES = 1024 * 1024;
const DEFAULT_STAGING_PREFIX = path.posix.join("artifacts", "imports", "subagent");

class ArtifactStagingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactStagingError";
    this.code = code;
  }
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sanitizeRunId(value) {
  const raw = asTrimmedString(value);
  if (!raw) return "";
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  if (safe && safe === raw && raw !== "." && raw !== "..") return safe;
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${safe || "run"}-${digest}`;
}

function resolveStagingPrefix(config = {}) {
  return normalizeRelativePath(config.stagingPrefix) || DEFAULT_STAGING_PREFIX;
}

function buildRequesterRelativePath(sourceRelativePath, runId, config = {}) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const stagingPrefix = resolveStagingPrefix(config);
  const runSegment = sanitizeRunId(runId);
  if (!normalizedSourcePath || !stagingPrefix || !runSegment) return "";
  return path.posix.join(stagingPrefix, runSegment, path.posix.basename(normalizedSourcePath));
}

async function openRegularFileWithinRoot(candidatePath, rootPath, maxBytes) {
  const rootRealPath = await fs.realpath(rootPath);
  let handle;
  try {
    handle = await fs.open(candidatePath, SAFE_READ_FLAGS);
    const [stat, linkStat, realPath] = await Promise.all([
      handle.stat(),
      fs.lstat(candidatePath),
      fs.realpath(candidatePath),
    ]);
    if (linkStat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
      throw new ArtifactStagingError(
        "staging-failed",
        "Subagent artifact source must be a non-empty regular file",
      );
    }
    if (maxBytes > 0 && stat.size > maxBytes) {
      throw new ArtifactStagingError(
        "file-size-rejected",
        `Subagent artifact exceeds the ${maxBytes} byte staging limit`,
      );
    }

    const realStat = await fs.stat(realPath);
    if (!sameFileSnapshot(stat, realStat) || !isPathInsideBase(realPath, rootRealPath)) {
      throw new ArtifactStagingError(
        "unsafe-artifact-path",
        "Subagent artifact source escapes its workspace",
      );
    }
    return { handle, realPath, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function ensureDestinationDirectory(workspaceDir, relativeDirectory, signal) {
  if (signal?.aborted) throw signal.reason || new Error("Artifact staging aborted");
  await fs.mkdir(workspaceDir, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspaceDir);
  let currentDirectory = workspaceRealPath;

  for (const segment of relativeDirectory.replaceAll("\\", "/").split("/").filter(Boolean)) {
    if (signal?.aborted) throw signal.reason || new Error("Artifact staging aborted");
    const nextDirectory = path.join(currentDirectory, segment);
    try {
      await fs.mkdir(nextDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const directoryStat = await fs.lstat(nextDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("Artifact staging destination contains a non-directory entry");
    }
    const realDirectory = await fs.realpath(nextDirectory);
    if (!isPathInsideBase(realDirectory, workspaceRealPath)) {
      throw new Error("Artifact staging destination escapes the requester workspace");
    }
    currentDirectory = realDirectory;
  }
  return currentDirectory;
}

async function detectOpenedFileMime(openedSource, detectMime) {
  if (typeof detectMime !== "function") {
    throw new Error("Plugin runtime MIME detection is unavailable");
  }
  const length = Math.min(openedSource.stat.size, MIME_SNIFF_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await openedSource.handle.read(buffer, 0, length, 0);
  if (bytesRead <= 0) return "";
  return (
    (await detectMime({
      buffer: buffer.subarray(0, bytesRead),
    })) || ""
  );
}

async function hashOpenedFile(openedFile) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (true) {
    const { bytesRead } = await openedFile.handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const currentStat = await openedFile.handle.stat();
  if (!sameFileSnapshot(openedFile.stat, currentStat) || offset !== openedFile.stat.size) {
    throw new Error("Artifact changed while its content digest was calculated");
  }
  return { sha256: hash.digest("hex"), size: offset };
}

async function copyOpenedFileAtomically(
  openedSource,
  destinationPath,
  requesterWorkspaceDir,
  maxBytes,
  signal,
) {
  if (signal?.aborted) throw signal.reason || new Error("Artifact staging aborted");
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let temporaryHandle;
  try {
    temporaryHandle = await fs.open(temporaryPath, SAFE_CREATE_FLAGS, 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copiedBytes = 0;
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error("Artifact staging aborted");
      const { bytesRead } = await openedSource.handle.read(buffer, 0, buffer.length, copiedBytes);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));

      let writtenBytes = 0;
      while (writtenBytes < bytesRead) {
        const result = await temporaryHandle.write(
          buffer,
          writtenBytes,
          bytesRead - writtenBytes,
          copiedBytes + writtenBytes,
        );
        if (result.bytesWritten <= 0) {
          throw new Error("Artifact staging copy made no progress");
        }
        writtenBytes += result.bytesWritten;
      }
      copiedBytes += bytesRead;
    }

    const [sourceAfterCopy, temporaryStat] = await Promise.all([
      openedSource.handle.stat(),
      temporaryHandle.stat(),
    ]);
    if (
      !sameFileSnapshot(openedSource.stat, sourceAfterCopy) ||
      !temporaryStat.isFile() ||
      temporaryStat.size !== openedSource.stat.size ||
      copiedBytes !== openedSource.stat.size
    ) {
      throw new Error("Subagent artifact source changed while it was copied");
    }

    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    if (signal?.aborted) throw signal.reason || new Error("Artifact staging aborted");
    const sourceDigest = { sha256: hash.digest("hex"), size: copiedBytes };
    try {
      await fs.link(temporaryPath, destinationPath);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const openedDestination = await openRegularFileWithinRoot(
        destinationPath,
        requesterWorkspaceDir,
        maxBytes,
      );
      try {
        const destinationDigest = await hashOpenedFile(openedDestination);
        if (
          destinationDigest.size !== sourceDigest.size ||
          destinationDigest.sha256 !== sourceDigest.sha256
        ) {
          throw new ArtifactStagingError(
            "staging-failed",
            "Immutable staged artifact already exists with different content",
          );
        }
        return;
      } finally {
        await openedDestination.handle.close().catch(() => {});
      }
    }
  } finally {
    await temporaryHandle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function stageArtifactIntoRequester(params) {
  const sourceRelativePath = normalizeRelativePath(params.sourceRelativePath);
  const requesterRelativePath = buildRequesterRelativePath(
    sourceRelativePath,
    params.runId,
    params.config,
  );
  const childWorkspaceDir = path.resolve(asTrimmedString(params.childWorkspaceDir));
  const requesterWorkspaceDir = path.resolve(asTrimmedString(params.requesterWorkspaceDir));
  if (
    !sourceRelativePath ||
    !requesterRelativePath ||
    !asTrimmedString(params.childWorkspaceDir) ||
    !asTrimmedString(params.requesterWorkspaceDir)
  ) {
    throw new Error("Artifact staging workspace or path is unavailable");
  }

  const sourcePath = path.resolve(childWorkspaceDir, sourceRelativePath);
  if (!isPathInsideBase(sourcePath, childWorkspaceDir) || sourcePath === childWorkspaceDir) {
    throw new Error("Subagent artifact source escapes its workspace");
  }

  const openedSource = await openRegularFileWithinRoot(
    sourcePath,
    childWorkspaceDir,
    params.maxBytes,
  );
  try {
    const detectedMimeType = await detectOpenedFileMime(openedSource, params.detectMime);
    if (!detectedMimeType && requiresDetectedMime(sourceRelativePath)) {
      throw new ArtifactStagingError(
        "mime-type-rejected",
        "Subagent artifact content MIME could not be detected",
      );
    }
    if (detectedMimeType && !detectedMimeMatchesExtension(sourceRelativePath, detectedMimeType)) {
      throw new ArtifactStagingError(
        "mime-type-rejected",
        `Subagent artifact content MIME ${detectedMimeType} does not match its extension`,
      );
    }

    const destinationDirectory = await ensureDestinationDirectory(
      requesterWorkspaceDir,
      path.posix.dirname(requesterRelativePath),
      params.signal,
    );
    const requesterWorkspaceRealPath = await fs.realpath(requesterWorkspaceDir);
    const destinationPath = path.join(
      destinationDirectory,
      path.posix.basename(requesterRelativePath),
    );
    if (!isPathInsideBase(destinationPath, requesterWorkspaceRealPath)) {
      throw new Error("Artifact staging destination escapes the requester workspace");
    }
    await copyOpenedFileAtomically(
      openedSource,
      destinationPath,
      requesterWorkspaceRealPath,
      params.maxBytes,
      params.signal,
    );
    return {
      sourceRelativePath,
      requesterRelativePath,
      destinationPath,
      detectedMimeType,
    };
  } finally {
    await openedSource.handle.close().catch(() => {});
  }
}

module.exports = {
  ArtifactStagingError,
  buildRequesterRelativePath,
  resolveStagingPrefix,
  sanitizeRunId,
  stageArtifactIntoRequester,
};
