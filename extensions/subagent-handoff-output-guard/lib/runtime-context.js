const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_ENABLED_CHANNELS = ["feishu", "webchat", "internal"];
const DEFAULT_PENDING_STATE_PATH = path.join(
  ".artifacts",
  "state",
  "pending-artifact-handoff.json",
);
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function expandUser(input) {
  const trimmed = asTrimmedString(input);
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveOpenClawRoot(api) {
  return path.resolve(
    expandUser(api.pluginConfig?.openclawRoot || path.join(os.homedir(), ".openclaw")),
  );
}

function resolveConfiguredAgentWorkspaceFromConfig(agentId, config) {
  const normalizedAgentId = asTrimmedString(agentId);
  if (!normalizedAgentId) return "";
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agent = agents.find((entry) => asTrimmedString(entry?.id) === normalizedAgentId);
  const workspace = expandUser(agent?.workspace || agent?.workspaceDir);
  return workspace ? path.resolve(workspace) : "";
}

function readConfiguredAgentWorkspace(agentId, api) {
  const fromApiConfig = resolveConfiguredAgentWorkspaceFromConfig(agentId, api.config);
  if (fromApiConfig) return fromApiConfig;

  const configPath = path.join(resolveOpenClawRoot(api), "openclaw.json");
  try {
    const config = JSON.parse(fsSync.readFileSync(configPath, "utf8"));
    return resolveConfiguredAgentWorkspaceFromConfig(agentId, config);
  } catch {
    return "";
  }
}

function deriveWorkspaceDirForAgentId(agentId, api) {
  const normalizedAgentId = asTrimmedString(agentId);
  if (!normalizedAgentId) return "";
  return (
    readConfiguredAgentWorkspace(normalizedAgentId, api) ||
    path.join(resolveOpenClawRoot(api), `workspace-${normalizedAgentId}`)
  );
}

function deriveExplicitWorkspaceDir(ctx) {
  const raw =
    typeof ctx?.workspaceDir === "string"
      ? ctx.workspaceDir
      : typeof ctx?.cwd === "string"
        ? ctx.cwd
        : "";
  const expanded = expandUser(raw);
  return expanded ? path.resolve(expanded) : "";
}

function deriveWorkspaceDir(ctx, api) {
  return (
    deriveExplicitWorkspaceDir(ctx) ||
    deriveWorkspaceDirForAgentId(asTrimmedString(ctx?.agentId), api)
  );
}

function isPathInsideBase(candidatePath, basePath) {
  const candidate = path.normalize(candidatePath);
  const base = path.normalize(basePath);
  if (candidate === base) return true;
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveStatePath(workspaceDir, relativePath) {
  if (!workspaceDir) return "";
  const normalized = asTrimmedString(relativePath).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return "";
  }
  const statePath = path.resolve(workspaceDir, normalized);
  return isPathInsideBase(statePath, workspaceDir) ? statePath : "";
}

function resolvePendingStatePath(workspaceDir, api) {
  return resolveStatePath(
    workspaceDir,
    asTrimmedString(api.pluginConfig?.pendingStatePath) || DEFAULT_PENDING_STATE_PATH,
  );
}

function normalizeChannels(configValue) {
  if (!Array.isArray(configValue) || configValue.length === 0) return DEFAULT_ENABLED_CHANNELS;
  return configValue.map((item) => asTrimmedString(item).toLowerCase()).filter(Boolean);
}

function parseAgentIdFromSessionKey(sessionKey) {
  const matched = asTrimmedString(sessionKey).match(/^agent:([^:]+)/);
  return matched ? matched[1] : "";
}

function isEnabledForContext(ctx, enabledChannels) {
  const channel = asTrimmedString(ctx?.channelId).toLowerCase();
  if (channel) return enabledChannels.includes(channel);
  return (
    enabledChannels.includes("feishu") &&
    asTrimmedString(ctx?.agentId).toLowerCase().startsWith("feishu-")
  );
}

function isEnabledForStagingEvent(event, enabledChannels) {
  const channel = asTrimmedString(event?.requesterOrigin?.channel).toLowerCase();
  if (channel && enabledChannels.includes(channel)) return true;
  const requesterIsFeishu =
    enabledChannels.includes("feishu") &&
    parseAgentIdFromSessionKey(event?.requesterSessionKey).toLowerCase().startsWith("feishu-");
  if (!channel) return requesterIsFeishu;
  return requesterIsFeishu && (channel === "webchat" || channel === "internal");
}

function shouldPersistFeishuState(event) {
  const channel = asTrimmedString(event?.requesterOrigin?.channel).toLowerCase();
  if (channel) return channel === "feishu";
  const sessionParts = asTrimmedString(event?.requesterSessionKey).split(":");
  return (
    parseAgentIdFromSessionKey(event?.requesterSessionKey).toLowerCase().startsWith("feishu-") &&
    sessionParts[2] !== "webchat"
  );
}

function extractPeerId(raw) {
  const match = asTrimmedString(raw).match(/\b(ou_[A-Za-z0-9]+|oc_[A-Za-z0-9]+)\b/);
  return match ? match[1] : "";
}

function peerFromId(id) {
  const normalized = asTrimmedString(id);
  if (!normalized) return null;
  return {
    id: normalized,
    kind: normalized.startsWith("oc_") ? "group" : "direct",
  };
}

function resolvePeerFromAgentId(agentId) {
  const trimmed = asTrimmedString(agentId);
  if (!trimmed) return null;
  if (trimmed.startsWith("feishu-group-")) {
    return peerFromId(extractPeerId(trimmed.slice("feishu-group-".length)));
  }
  if (trimmed.startsWith("feishu-")) {
    return peerFromId(extractPeerId(trimmed.slice("feishu-".length)));
  }
  return null;
}

function agentIdFromPeer(peer) {
  if (!peer?.id) return "";
  return peer.kind === "group" ? `feishu-group-${peer.id}` : `feishu-${peer.id}`;
}

function resolvePeerFromEvent(event, ctx) {
  const candidates = [
    event?.to,
    event?.target,
    event?.channelId,
    event?.requesterOrigin?.to,
    event?.metadata?.to,
    event?.metadata?.target,
    event?.metadata?.conversationId,
    event?.metadata?.channelId,
    ctx?.conversationId,
    ctx?.channelId,
  ];
  for (const candidate of candidates) {
    const peer = peerFromId(extractPeerId(candidate));
    if (peer) return peer;
  }
  return (
    resolvePeerFromAgentId(parseAgentIdFromSessionKey(event?.requesterSessionKey)) ||
    resolvePeerFromAgentId(ctx?.agentId)
  );
}

function formatPeer(peer) {
  return peer ? `${peer.kind} ${peer.id}` : "";
}

function resolvePendingTtlMs(api) {
  const configured = Number(api.pluginConfig?.pendingTtlMs);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_PENDING_TTL_MS;
  return Math.floor(configured);
}

module.exports = {
  agentIdFromPeer,
  asTrimmedString,
  deriveExplicitWorkspaceDir,
  deriveWorkspaceDir,
  deriveWorkspaceDirForAgentId,
  escapeRegex,
  formatPeer,
  isEnabledForContext,
  isEnabledForStagingEvent,
  isPathInsideBase,
  normalizeChannels,
  parseAgentIdFromSessionKey,
  readConfiguredAgentWorkspace,
  resolvePeerFromEvent,
  resolvePendingStatePath,
  resolvePendingTtlMs,
  shouldPersistFeishuState,
};
