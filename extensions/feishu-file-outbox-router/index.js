const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const MESSAGE_TOOL_NAME = "message";
const MEDIA_KEYS = ["media", "path", "filePath"];
const MEDIA_ARRAY_KEYS = ["mediaUrls"];
const DEFAULT_EXPORT_PREFIX = path.join("artifacts", "exports", "feishu");
const DEFAULT_RESEARCHER_AGENT_ID = "researcher";

function expandUser(input) {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function defaultOutboxRoot() {
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function resolveOpenClawRoot(api) {
  return path.resolve(
    expandUser(api.pluginConfig?.openclawRoot || path.join(os.homedir(), ".openclaw")),
  );
}

function resolveResearcherAgentId(api) {
  return asString(api.pluginConfig?.researcherAgentId) || DEFAULT_RESEARCHER_AGENT_ID;
}

function resolveConfiguredAgentWorkspaceFromApi(agentId, api) {
  const normalizedAgentId = asString(agentId);
  if (!normalizedAgentId) return "";

  const agents = Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [];
  const configuredAgent = agents.find((entry) => asString(entry?.id) === normalizedAgentId);
  const configuredWorkspace = expandUser(
    configuredAgent?.workspace || configuredAgent?.workspaceDir,
  );
  if (configuredWorkspace) return path.resolve(configuredWorkspace);

  const configPath = path.join(resolveOpenClawRoot(api), "openclaw.json");
  try {
    const config = JSON.parse(fsSync.readFileSync(configPath, "utf8"));
    const configAgents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const fileAgent = configAgents.find((entry) => asString(entry?.id) === normalizedAgentId);
    const fileWorkspace = expandUser(fileAgent?.workspace || fileAgent?.workspaceDir);
    return fileWorkspace ? path.resolve(fileWorkspace) : "";
  } catch {
    return "";
  }
}

function defaultResearcherWorkspaceRoot(api) {
  const explicit = expandUser(api.pluginConfig?.researcherWorkspaceRoot);
  if (explicit) return path.resolve(explicit);

  const configured = resolveConfiguredAgentWorkspaceFromApi(resolveResearcherAgentId(api), api);
  if (configured) return configured;

  return path.join(resolveOpenClawRoot(api), `workspace-${resolveResearcherAgentId(api)}`);
}

function defaultSourcePrefixes(exportPrefix, api) {
  if (!exportPrefix) return [];
  const researcherWorkspaceRoot = defaultResearcherWorkspaceRoot(api);
  return [
    path.join(resolveOpenClawRoot(api), "workspace-feishu-"),
    path.join(researcherWorkspaceRoot, exportPrefix),
  ];
}

function defaultExplicitTargetRequiredPrefixes(exportPrefix, api) {
  if (!exportPrefix) return [];
  return [path.join(defaultResearcherWorkspaceRoot(api), exportPrefix)];
}

function resolveExportPrefix(pluginConfig) {
  const configured =
    typeof pluginConfig?.exportPrefix === "string"
      ? pluginConfig.exportPrefix
      : typeof pluginConfig?.researcherExportRelativePrefix === "string"
        ? pluginConfig.researcherExportRelativePrefix
        : "";
  const normalized = expandUser(configured).trim();
  return normalized || DEFAULT_EXPORT_PREFIX;
}

function normalizeSourcePrefixes(pluginConfig, exportPrefix, api) {
  const fromArray = Array.isArray(pluginConfig?.sourcePrefixes) ? pluginConfig.sourcePrefixes : [];
  const fromSingle =
    typeof pluginConfig?.sourcePrefix === "string" ? [pluginConfig.sourcePrefix] : [];
  const merged = [...fromArray, ...fromSingle]
    .map(expandUser)
    .map((v) => v.trim())
    .filter(Boolean);
  if (merged.length > 0) return merged;
  return defaultSourcePrefixes(exportPrefix, api);
}

function normalizeExplicitTargetRequiredPrefixes(pluginConfig, exportPrefix, api) {
  const values = Array.isArray(pluginConfig?.targetPrefixes)
    ? pluginConfig.targetPrefixes
    : Array.isArray(pluginConfig?.explicitTargetRequiredPrefixes)
      ? pluginConfig.explicitTargetRequiredPrefixes
      : [];
  const normalized = values
    .map(expandUser)
    .map((v) => v.trim())
    .filter(Boolean);
  if (normalized.length > 0) return normalized;
  return defaultExplicitTargetRequiredPrefixes(exportPrefix, api);
}

function isUrlLike(value) {
  return /^(https?:|data:|file:)/i.test(value);
}

function extractPeerId(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/\b(ou_[A-Za-z0-9]+|oc_[A-Za-z0-9]+)\b/);
  return match ? match[1] : null;
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function peerFromId(id) {
  if (!id) return null;
  return {
    id,
    kind: id.startsWith("oc_") ? "group" : "direct",
  };
}

function resolvePeerFromParams(params) {
  const directKeys = ["target", "to", "channelId"];
  for (const key of directKeys) {
    const parsed = peerFromId(extractPeerId(params?.[key]));
    if (parsed) return parsed;
  }
  if (Array.isArray(params?.targets)) {
    for (const item of params.targets) {
      const parsed = peerFromId(extractPeerId(item));
      if (parsed) return parsed;
    }
  }
  return null;
}

function resolvePeerFromAgentId(agentId) {
  if (typeof agentId !== "string") return null;
  const trimmed = agentId.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("feishu-group-")) {
    const id = trimmed.slice("feishu-group-".length);
    const parsed = peerFromId(extractPeerId(id));
    if (parsed) return parsed;
  }
  if (trimmed.startsWith("feishu-ou_")) {
    const id = trimmed.slice("feishu-".length);
    const parsed = peerFromId(extractPeerId(id));
    if (parsed) return parsed;
  }
  if (trimmed.startsWith("feishu-")) {
    const parsed = peerFromId(extractPeerId(trimmed.slice("feishu-".length)));
    if (parsed) return parsed;
  }
  return null;
}

function resolvePeer(params, ctx) {
  return resolvePeerFromParams(params) || resolvePeerFromAgentId(ctx?.agentId) || null;
}

function isFeishuContext(ctx) {
  return typeof ctx?.agentId === "string" && ctx.agentId.startsWith("feishu-");
}

function isEligibleSource(absPath, sourcePrefixes) {
  const candidate = path.resolve(absPath);
  return sourcePrefixes.some((prefix) => {
    const base = path.resolve(prefix);
    if (candidate === base) return true;
    const relative = path.relative(base, candidate);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
    // Backward-compatible support for configured prefix patterns such as
    // "~/.openclaw/workspace-feishu-" matching "workspace-feishu-ou_xxx/...".
    if (base.endsWith("-") && candidate.startsWith(base)) return true;
    return false;
  });
}

function hasExplicitPeerTarget(params) {
  return Boolean(resolvePeerFromParams(params));
}

function isPathInsideBase(candidatePath, basePath) {
  const candidate = path.normalize(candidatePath);
  const base = path.normalize(basePath);
  if (candidate === base) return true;
  const relative = path.relative(base, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function stripTrailingSegments(absPath, trailingSegments) {
  const resolved = path.resolve(absPath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (segments.length < trailingSegments.length) return null;

  const offset = segments.length - trailingSegments.length;
  for (let i = 0; i < trailingSegments.length; i += 1) {
    if (segments[offset + i] !== trailingSegments[i]) return null;
  }
  return path.join(parsed.root, ...segments.slice(0, offset));
}

function collectResearcherWorkspaceRoots(sourcePrefixes, exportPrefix) {
  const roots = new Set();
  for (const prefix of sourcePrefixes) {
    const workspaceRoot = stripTrailingSegments(prefix, exportPrefix.split(path.sep));
    if (workspaceRoot) roots.add(workspaceRoot);
  }
  return [...roots];
}

function collectFeishuWorkspacePrefixes(sourcePrefixes, exportPrefix) {
  return sourcePrefixes.filter(
    (prefix) => !stripTrailingSegments(prefix, exportPrefix.split(path.sep)),
  );
}

function isResearcherExportRelativePath(value, exportPrefix) {
  return isPathInsideBase(value, exportPrefix);
}

function deriveWorkspaceDirFromAgentId(agentId) {
  if (typeof agentId !== "string") return "";
  const trimmed = agentId.trim();
  if (!trimmed) return "";
  return path.join(os.homedir(), ".openclaw", `workspace-${trimmed}`);
}

function resolveConfiguredAgentWorkspace(agentId, config) {
  const normalizedAgentId = asString(agentId);
  if (!normalizedAgentId) return "";
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agent = agents.find((entry) => asString(entry?.id) === normalizedAgentId);
  const workspace = expandUser(agent?.workspace || agent?.workspaceDir);
  return workspace ? path.resolve(workspace) : "";
}

function resolveWorkspaceDir(ctx, api) {
  const raw =
    typeof ctx?.workspaceDir === "string"
      ? ctx.workspaceDir
      : typeof ctx?.cwd === "string"
        ? ctx.cwd
        : "";
  const trimmed = raw.trim();
  if (trimmed) return path.resolve(expandUser(trimmed));
  return (
    resolveConfiguredAgentWorkspace(ctx?.agentId, api?.config) ||
    deriveWorkspaceDirFromAgentId(ctx?.agentId)
  );
}

function normalizeRelativePath(value) {
  return asString(value).replace(/\\/g, "/");
}

function resolveSourcePath(rawPath, state) {
  const expanded = expandUser(rawPath);
  if (!expanded || isUrlLike(expanded) || path.isAbsolute(expanded)) return expanded;
  if (!isPathInsideBase(expanded, state.exportPrefix)) {
    if (!state.workspaceDir) return expanded;
    return path.resolve(state.workspaceDir, expanded);
  }

  if (state.workspaceDir) {
    const workspaceCandidate = path.resolve(state.workspaceDir, expanded);
    if (isEligibleSource(workspaceCandidate, state.sourcePrefixes)) return workspaceCandidate;
  }

  for (const workspaceRoot of state.researcherWorkspaceRoots) {
    const candidate = path.resolve(workspaceRoot, expanded);
    if (isEligibleSource(candidate, state.sourcePrefixes)) return candidate;
  }
  return expanded;
}

function extractResearcherExportRelativePath(candidatePath, exportPrefix) {
  if (typeof candidatePath !== "string" || !candidatePath.trim()) return "";
  const normalizedInput = normalizeRelativePath(candidatePath);
  if (
    !path.isAbsolute(candidatePath) &&
    isResearcherExportRelativePath(normalizedInput, exportPrefix)
  ) {
    return normalizedInput;
  }

  const resolved = path.resolve(candidatePath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const trailingSegments = exportPrefix.split(path.sep);

  for (let start = 0; start <= segments.length - trailingSegments.length; start += 1) {
    let matches = true;
    for (let i = 0; i < trailingSegments.length; i += 1) {
      if (segments[start + i] !== trailingSegments[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return normalizeRelativePath(path.join(...segments.slice(start)));
    }
  }

  return "";
}

function extractTrailingPath(absPath, trailingSegments) {
  const resolved = path.resolve(absPath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (let start = 0; start <= segments.length - trailingSegments.length; start += 1) {
    let matches = true;
    for (let i = 0; i < trailingSegments.length; i += 1) {
      if (segments[start + i] !== trailingSegments[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return path.join(...segments.slice(start));
  }
  return "";
}

async function statIfFile(candidatePath) {
  try {
    const stat = await fs.stat(candidatePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function recoverRewrittenResearcherExportPath(absPath, state) {
  if (!path.isAbsolute(absPath)) return "";
  if (!isEligibleSource(absPath, state.feishuWorkspacePrefixes)) return "";

  const relativeExportPath = extractTrailingPath(absPath, state.exportPrefix.split(path.sep));
  if (!relativeExportPath) return "";

  for (const workspaceRoot of state.researcherWorkspaceRoots) {
    const candidate = path.resolve(workspaceRoot, relativeExportPath);
    if (!isEligibleSource(candidate, state.sourcePrefixes)) continue;
    const stat = await statIfFile(candidate);
    if (!stat) continue;
    state.logger.info?.(
      `feishu-file-outbox-router: recovered rewritten researcher export ${absPath} -> ${candidate}`,
    );
    return candidate;
  }
  return "";
}

function listRawMediaPaths(params) {
  const values = [];
  for (const key of MEDIA_KEYS) {
    if (typeof params?.[key] === "string") values.push(params[key]);
  }
  for (const key of MEDIA_ARRAY_KEYS) {
    if (!Array.isArray(params?.[key])) continue;
    for (const item of params[key]) {
      if (typeof item === "string") values.push(item);
    }
  }
  return values;
}

function listEligibleStagePaths(params, state) {
  return listRawMediaPaths(params)
    .map((value) => resolveSourcePath(value.trim(), state))
    .filter((value) => value && !isUrlLike(value) && path.isAbsolute(value))
    .filter((value) => isEligibleSource(value, state.sourcePrefixes));
}

function buildEffectiveSourcePrefixes(sourcePrefixes, workspaceDir, includeWorkspace) {
  if (!includeWorkspace || !workspaceDir) return sourcePrefixes;
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  if (sourcePrefixes.some((prefix) => path.resolve(prefix) === resolvedWorkspaceDir)) {
    return sourcePrefixes;
  }
  return [resolvedWorkspaceDir, ...sourcePrefixes];
}

function buildOutboxDir(outboxRoot, peer) {
  const safeId = String(peer?.id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const folder = peer?.kind === "group" ? `group-${safeId}.outbox` : `${safeId}.outbox`;
  return path.join(outboxRoot, folder);
}

function makeStagedName(originalPath) {
  const base = path.basename(originalPath).replace(/[^A-Za-z0-9._-]/g, "_");
  const stamp = Date.now();
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${stamp}-${suffix}-${base}`;
}

async function stagePathIfNeeded(rawPath, state) {
  if (typeof rawPath !== "string") return rawPath;
  const trimmed = rawPath.trim();
  if (!trimmed || isUrlLike(trimmed)) return rawPath;

  const expanded = resolveSourcePath(trimmed, state);
  let sourcePath = expanded;
  if (!path.isAbsolute(sourcePath)) return rawPath;
  if (!isEligibleSource(sourcePath, state.sourcePrefixes)) return rawPath;

  if (!(await statIfFile(sourcePath))) {
    const recovered = await recoverRewrittenResearcherExportPath(sourcePath, state);
    if (recovered) sourcePath = recovered;
  }

  if (
    isEligibleSource(sourcePath, state.explicitTargetRequiredPrefixes) &&
    !state.hasExplicitPeerTarget &&
    !state.peer
  ) {
    throw new Error(
      "Feishu message.target/to/channelId is required when staging researcher export files",
    );
  }

  if (!state.peer) {
    throw new Error("Unable to resolve Feishu peer for outbox staging");
  }

  if (!(await statIfFile(sourcePath))) return rawPath;

  const outboxDir = buildOutboxDir(state.outboxRoot, state.peer);
  await fs.mkdir(outboxDir, { recursive: true });
  const stagedPath = path.join(outboxDir, makeStagedName(sourcePath));
  await fs.copyFile(sourcePath, stagedPath);
  state.logger.info?.(`feishu-file-outbox-router: staged media ${sourcePath} -> ${stagedPath}`);
  return stagedPath;
}

function hasAnyKeys(obj) {
  return obj && typeof obj === "object" && Object.keys(obj).length > 0;
}

module.exports = function register(api) {
  api.on("before_tool_call", async (event, ctx) => {
    if (!event || event.toolName !== MESSAGE_TOOL_NAME) return;

    const params = event.params && typeof event.params === "object" ? event.params : {};
    const outboxRoot = path.resolve(
      expandUser(api.pluginConfig?.outboxRoot || defaultOutboxRoot()),
    );
    const exportPrefix = resolveExportPrefix(api.pluginConfig);
    const sourcePrefixes = normalizeSourcePrefixes(api.pluginConfig, exportPrefix, api).map((p) =>
      path.resolve(p),
    );
    const explicitTargetRequiredPrefixes = normalizeExplicitTargetRequiredPrefixes(
      api.pluginConfig,
      exportPrefix,
      api,
    ).map((p) => path.resolve(p));
    const workspaceDir = resolveWorkspaceDir(ctx, api);
    const feishuContext = isFeishuContext(ctx);
    const effectiveSourcePrefixes = buildEffectiveSourcePrefixes(
      sourcePrefixes,
      workspaceDir,
      feishuContext,
    );
    const state = {
      outboxRoot,
      exportPrefix,
      sourcePrefixes: effectiveSourcePrefixes,
      explicitTargetRequiredPrefixes,
      researcherWorkspaceRoots: collectResearcherWorkspaceRoots(
        effectiveSourcePrefixes,
        exportPrefix,
      ),
      feishuWorkspacePrefixes: collectFeishuWorkspacePrefixes(
        effectiveSourcePrefixes,
        exportPrefix,
      ),
      workspaceDir,
      peer: null,
      hasExplicitPeerTarget: hasExplicitPeerTarget(params),
      logger: api.logger,
    };

    const eligibleStagePaths = listEligibleStagePaths(params, state);
    if (eligibleStagePaths.length === 0) return;

    const peer = resolvePeer(params, ctx);
    state.peer = peer;

    const requiresExplicitFeishuTarget = eligibleStagePaths.some((candidate) =>
      isEligibleSource(candidate, explicitTargetRequiredPrefixes),
    );
    if (requiresExplicitFeishuTarget && !feishuContext) {
      throw new Error("Researcher export files can only be staged from a feishu-* agent context");
    }
    if (!feishuContext) return;

    const patch = {};

    for (const key of MEDIA_KEYS) {
      const value = params[key];
      if (typeof value !== "string") continue;
      const staged = await stagePathIfNeeded(value, state);
      if (staged !== value) patch[key] = staged;
    }

    for (const key of MEDIA_ARRAY_KEYS) {
      const value = params[key];
      if (!Array.isArray(value)) continue;
      let changed = false;
      const next = [];
      for (const item of value) {
        if (typeof item !== "string") {
          next.push(item);
          continue;
        }
        const staged = await stagePathIfNeeded(item, state);
        if (staged !== item) changed = true;
        next.push(staged);
      }
      if (changed) patch[key] = next;
    }

    if (!hasAnyKeys(patch)) return;
    return { params: patch };
  });
};
