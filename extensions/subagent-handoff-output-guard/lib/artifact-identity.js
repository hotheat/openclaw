const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { normalizeRelativePath } = require("./artifact-profiles.js");
const { asTrimmedString, isPathInsideBase } = require("./runtime-context.js");

function canonicalArtifactIdentity(input, requesterWorkspaceDir, api, options = {}) {
  let raw = asTrimmedString(input)
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/^\s*MEDIA\s*:\s*/i, "");
  if (!raw || raw.includes("\0") || !requesterWorkspaceDir) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      if (options.audit !== false) {
        api.logger.warn?.(`subagent-handoff-output-guard: rejected invalid file URL ${raw}`);
      }
      return null;
    }
  }
  if (raw === "/workspace" || raw.startsWith("/workspace/")) {
    raw = path.resolve(
      requesterWorkspaceDir,
      ...raw.slice("/workspace".length).split("/").filter(Boolean),
    );
  } else if (raw === "~") {
    raw = os.homedir();
  } else if (raw.startsWith("~/")) {
    raw = path.join(os.homedir(), raw.slice(2));
  }

  let relativePath;
  if (path.isAbsolute(raw)) {
    const absolutePath = path.resolve(raw);
    const workspacePath = path.resolve(requesterWorkspaceDir);
    if (!isPathInsideBase(absolutePath, workspacePath) || absolutePath === workspacePath) {
      if (options.audit !== false) {
        api.logger.warn?.(
          `subagent-handoff-output-guard: rejected workspace-external attachment path ${raw}`,
        );
      }
      return null;
    }
    relativePath = path.relative(workspacePath, absolutePath);
  } else if (path.win32.isAbsolute(raw)) {
    if (options.audit !== false) {
      api.logger.warn?.(
        `subagent-handoff-output-guard: rejected workspace-external attachment path ${raw}`,
      );
    }
    return null;
  } else {
    relativePath = raw;
  }

  const identity = normalizeRelativePath(relativePath);
  if (!identity) return null;
  return {
    identity,
    hash: crypto.createHash("sha256").update(identity, "utf8").digest("hex"),
  };
}

function canonicalHashes(values, requesterWorkspaceDir, api, options = {}) {
  const hashes = [];
  for (const value of values) {
    const canonical = canonicalArtifactIdentity(value, requesterWorkspaceDir, api, options);
    if (canonical && !hashes.includes(canonical.hash)) hashes.push(canonical.hash);
  }
  return hashes;
}

async function requesterCanAccessArtifact(event, relativePath) {
  const requesterWorkspaceDir = asTrimmedString(event?.requesterWorkspaceDir);
  if (!requesterWorkspaceDir) return false;

  const candidatePath = path.resolve(requesterWorkspaceDir, relativePath);
  if (!isPathInsideBase(candidatePath, requesterWorkspaceDir)) return false;
  try {
    const [workspaceRealPath, candidateRealPath, linkStat, stat] = await Promise.all([
      fs.realpath(requesterWorkspaceDir),
      fs.realpath(candidatePath),
      fs.lstat(candidatePath),
      fs.stat(candidatePath),
    ]);
    return (
      !linkStat.isSymbolicLink() &&
      stat.isFile() &&
      stat.size > 0 &&
      isPathInsideBase(candidateRealPath, workspaceRealPath)
    );
  } catch {
    return false;
  }
}

module.exports = {
  canonicalArtifactIdentity,
  canonicalHashes,
  requesterCanAccessArtifact,
};
