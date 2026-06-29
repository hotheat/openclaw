const fs = require("node:fs/promises");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const { createReadStream, existsSync, readFileSync } = require("node:fs");

const DEFAULT_EXPORT_PREFIX = path.join("artifacts", "exports", "feishu");
const DEFAULT_RESEARCHER_AGENT_ID = "researcher";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function expandUser(input) {
  const trimmed = asString(input);
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function isPathInsideBase(candidatePath, basePath) {
  const candidate = path.normalize(candidatePath);
  const base = path.normalize(basePath);
  if (candidate === base) return true;
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function deriveWorkspaceDir(ctx = {}, api) {
  const raw =
    typeof ctx.workspaceDir === "string"
      ? ctx.workspaceDir.trim()
      : typeof ctx.cwd === "string"
        ? ctx.cwd.trim()
        : "";
  if (raw) return path.resolve(expandUser(raw));

  const agentId = asString(ctx.agentId);
  if (!agentId) return "";
  return deriveWorkspaceDirForAgentId(agentId, api);
}

function isFeishuContext(ctx = {}) {
  const agentId = asString(ctx.agentId).toLowerCase();
  return agentId.startsWith("feishu-");
}

function isFeishuAgentId(agentId) {
  return asString(agentId).toLowerCase().startsWith("feishu-");
}

function parseAgentIdFromSessionKey(sessionKey) {
  const matched = asString(sessionKey).match(/^agent:([^:]+)/);
  return matched ? matched[1] : "";
}

function normalizeAgentId(agentId) {
  return asString(agentId) || "main";
}

function resolveOpenClawRoot(api) {
  return path.resolve(
    expandUser(api.pluginConfig?.openclawRoot || path.join(os.homedir(), ".openclaw")),
  );
}

function resolveConfiguredAgentWorkspaceFromConfig(agentId, config) {
  const normalizedAgentId = asString(agentId);
  if (!normalizedAgentId) return "";
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agent = agents.find((entry) => asString(entry?.id) === normalizedAgentId);
  const workspace = expandUser(agent?.workspace || agent?.workspaceDir);
  return workspace ? path.resolve(workspace) : "";
}

function readConfiguredAgentWorkspace(agentId, api) {
  const fromApiConfig = resolveConfiguredAgentWorkspaceFromConfig(agentId, api.config);
  if (fromApiConfig) return fromApiConfig;

  const configPath = path.join(resolveOpenClawRoot(api), "openclaw.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return resolveConfiguredAgentWorkspaceFromConfig(agentId, config);
  } catch {
    return "";
  }
}

function deriveWorkspaceDirForAgentId(agentId, api) {
  const normalizedAgentId = asString(agentId);
  if (!normalizedAgentId) return "";
  return (
    readConfiguredAgentWorkspace(normalizedAgentId, api) ||
    path.join(resolveOpenClawRoot(api), `workspace-${normalizedAgentId}`)
  );
}

function defaultSessionStorePath(agentId, api) {
  return path.join(
    resolveOpenClawRoot(api),
    "agents",
    normalizeAgentId(agentId),
    "sessions",
    "sessions.json",
  );
}

function resolveSessionStorePath(agentId, api) {
  if (typeof api.runtime?.channel?.session?.resolveStorePath === "function") {
    return api.runtime.channel.session.resolveStorePath(api.config?.session?.store, {
      agentId: normalizeAgentId(agentId),
    });
  }

  const store = asString(api.config?.session?.store);
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!store) return defaultSessionStorePath(normalizedAgentId, api);

  let expanded = store.includes("{agentId}")
    ? store.replaceAll("{agentId}", normalizedAgentId)
    : store;
  expanded = expandUser(expanded);
  return path.resolve(expanded);
}

function isSafeSessionId(sessionId) {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(asString(sessionId));
}

function defaultTranscriptPath(sessionId, storePath) {
  if (!isSafeSessionId(sessionId)) return "";
  return path.resolve(path.dirname(storePath), `${asString(sessionId)}.jsonl`);
}

function resolveSessionFilePath(sessionId, storePath, sessionFile, agentId, api) {
  const safeSessionId = asString(sessionId);
  if (!isSafeSessionId(safeSessionId)) return "";

  const trimmedSessionFile = asString(sessionFile);
  if (!trimmedSessionFile) return defaultTranscriptPath(safeSessionId, storePath);

  const sessionsDir = path.dirname(path.resolve(storePath));
  const resolvedSessionFile = path.isAbsolute(trimmedSessionFile)
    ? path.resolve(trimmedSessionFile)
    : path.resolve(sessionsDir, trimmedSessionFile);

  if (isPathInsideBase(resolvedSessionFile, sessionsDir)) return resolvedSessionFile;

  const agentSessionsDir = path.join(
    resolveOpenClawRoot(api),
    "agents",
    normalizeAgentId(agentId),
    "sessions",
  );
  if (isPathInsideBase(resolvedSessionFile, agentSessionsDir)) return resolvedSessionFile;

  return "";
}

function resolveTranscriptCandidates(sessionId, storePath, sessionFile, agentId, api) {
  if (typeof api.runtime?.channel?.session?.resolveTranscriptCandidates === "function") {
    return api.runtime.channel.session.resolveTranscriptCandidates(
      sessionId,
      storePath,
      sessionFile,
      agentId,
    );
  }

  const fallback = resolveSessionFilePath(sessionId, storePath, sessionFile, agentId, api);
  return fallback ? [fallback] : [];
}

function resolveResearcherAgentId(api) {
  return asString(api.pluginConfig?.researcherAgentId) || DEFAULT_RESEARCHER_AGENT_ID;
}

function defaultResearcherWorkspaceRoot(api) {
  return path.join(resolveOpenClawRoot(api), `workspace-${resolveResearcherAgentId(api)}`);
}

function resolveResearcherWorkspaceRoot(api) {
  const explicit = expandUser(api.pluginConfig?.researcherWorkspaceRoot);
  if (explicit) return path.resolve(explicit);

  const configured = readConfiguredAgentWorkspace(resolveResearcherAgentId(api), api);
  if (configured) return configured;

  return defaultResearcherWorkspaceRoot(api);
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

function resolveResearcherExportSource(exportPath, api) {
  const normalized = asString(exportPath);
  const exportPrefix = resolveExportPrefix(api.pluginConfig);
  if (!normalized || !isPathInsideBase(normalized, exportPrefix)) return "";

  const researcherWorkspaceRoot = resolveResearcherWorkspaceRoot(api);
  const sourcePath = path.resolve(researcherWorkspaceRoot, normalized);
  if (!isPathInsideBase(sourcePath, researcherWorkspaceRoot)) return "";
  return sourcePath;
}

function extractAndStripHandoff(text) {
  if (typeof text !== "string") return null;

  const regex = /<SUBAGENT_HANDOFF>\s*([\s\S]*?)\s*<\/SUBAGENT_HANDOFF>/i;
  const matched = text.match(regex);
  if (!matched || typeof matched[1] !== "string") return null;
  return matched[1].trim();
}

function parseHandoff(text) {
  const payload = extractAndStripHandoff(text);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractExportPathsFromHandoff(text) {
  const handoff = parseHandoff(text);
  if (!handoff || typeof handoff !== "object") return [];

  const exportPaths = [];
  if (
    handoff.export &&
    typeof handoff.export === "object" &&
    typeof handoff.export.path === "string"
  ) {
    exportPaths.push(handoff.export.path.trim());
  }

  if (Array.isArray(handoff.exports)) {
    for (const entry of handoff.exports) {
      if (!entry || typeof entry !== "object" || typeof entry.path !== "string") continue;
      exportPaths.push(entry.path.trim());
    }
  }

  return Array.from(new Set(exportPaths.filter(Boolean)));
}

function extractExportPathsFromText(text, api) {
  return extractExportPathsFromHandoff(text)
    .map((exportPath) => normalizeRelativeExportPath(exportPath, api))
    .filter(Boolean);
}

function normalizeRelativeExportPath(exportPath, api) {
  const exportPrefix = resolveExportPrefix(api.pluginConfig);
  if (!exportPath || !isPathInsideBase(exportPath, exportPrefix)) return "";
  return path.normalize(exportPath);
}

function normalizeExportPath(text, api) {
  return normalizeRelativeExportPath(extractExportPathsFromHandoff(text)[0] || "", api);
}

function extractReadPath(params) {
  if (!params || typeof params !== "object") return "";
  if (typeof params.path === "string") return params.path.trim();
  if (typeof params.file_path === "string") return params.file_path.trim();
  return "";
}

function normalizeReadExportPath(filePath, workspaceDir, api) {
  const rawPath = asString(filePath);
  if (!rawPath) return "";

  if (!path.isAbsolute(rawPath)) {
    return normalizeRelativeExportPath(rawPath, api);
  }

  if (!workspaceDir) return "";
  const absolutePath = path.resolve(rawPath);
  if (!isPathInsideBase(absolutePath, workspaceDir)) return "";

  const relativePath = path.relative(workspaceDir, absolutePath);
  if (!relativePath) return "";
  return normalizeRelativeExportPath(relativePath, api);
}

async function statIfFile(candidatePath) {
  try {
    const stat = await fs.stat(candidatePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function resolveSessionTranscriptPath(sessionKey, api) {
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  if (!agentId) return "";

  const sessionsIndexPath = resolveSessionStorePath(agentId, api);
  let sessionsIndex;
  try {
    sessionsIndex = JSON.parse(await fs.readFile(sessionsIndexPath, "utf8"));
  } catch {
    return "";
  }

  const record =
    sessionsIndex && typeof sessionsIndex === "object" ? sessionsIndex[sessionKey] : null;
  const sessionId = record && typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) return "";

  const candidates = resolveTranscriptCandidates(
    sessionId,
    sessionsIndexPath,
    record?.sessionFile,
    agentId,
    api,
  );
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || "";
}

function textBlocksFromMessageRecord(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
}

async function extractExportPathsFromTranscript(transcriptPath, api) {
  const exportPaths = [];
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line || !line.includes("<SUBAGENT_HANDOFF>")) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    for (const text of textBlocksFromMessageRecord(record)) {
      exportPaths.push(...extractExportPathsFromText(text, api));
    }
  }

  return Array.from(new Set(exportPaths));
}

async function mirrorExportIntoWorkspace(exportPath, workspaceDir, api) {
  const normalizedExportPath = normalizeRelativeExportPath(exportPath, api);
  if (!normalizedExportPath || !workspaceDir) return false;

  const sourcePath = resolveResearcherExportSource(normalizedExportPath, api);
  if (!sourcePath) return false;
  const sourceStat = await statIfFile(sourcePath);
  if (!sourceStat) return false;

  const destinationPath = path.resolve(workspaceDir, normalizedExportPath);
  if (!isPathInsideBase(destinationPath, workspaceDir)) return false;

  const destinationStat = await statIfFile(destinationPath);
  if (
    destinationStat &&
    destinationStat.size === sourceStat.size &&
    Number(destinationStat.mtimeMs || 0) >= Number(sourceStat.mtimeMs || 0)
  ) {
    return false;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  api.logger.info?.(
    `feishu-researcher-export-mirror: mirrored ${sourcePath} -> ${destinationPath}`,
  );
  return true;
}

async function mirrorResearcherExportsForEndedSubagent(event, ctx, api) {
  const researcherAgentId =
    asString(api.pluginConfig?.researcherAgentId) || DEFAULT_RESEARCHER_AGENT_ID;
  const targetAgentId = parseAgentIdFromSessionKey(event?.targetSessionKey);
  if (targetAgentId !== researcherAgentId) return;

  const requesterSessionKey = asString(ctx?.requesterSessionKey);
  const requesterAgentId = parseAgentIdFromSessionKey(requesterSessionKey);
  if (!isFeishuAgentId(requesterAgentId)) return;

  const workspaceDir = deriveWorkspaceDirForAgentId(requesterAgentId, api);
  if (!workspaceDir) return;

  const transcriptPath = await resolveSessionTranscriptPath(event.targetSessionKey, api);
  if (!transcriptPath) return;

  const exportPaths = await extractExportPathsFromTranscript(transcriptPath, api);
  for (const exportPath of exportPaths) {
    await mirrorExportIntoWorkspace(exportPath, workspaceDir, api);
  }
}

module.exports = function register(api) {
  api.on("subagent_ended", async (event, ctx) => {
    await mirrorResearcherExportsForEndedSubagent(event, ctx, api);
  });

  api.on(
    "message_sending",
    async (event, ctx) => {
      if (!isFeishuContext(ctx)) return;
      if (!event || typeof event.content !== "string" || !event.content.trim()) return;
      const exportPaths = extractExportPathsFromText(event.content, api);
      if (exportPaths.length === 0) return;
      const workspaceDir = deriveWorkspaceDir(ctx, api);
      if (!workspaceDir) return;
      for (const exportPath of exportPaths) {
        await mirrorExportIntoWorkspace(exportPath, workspaceDir, api);
      }
    },
    { priority: 100 },
  );

  api.on("before_tool_call", async (event, ctx) => {
    if (!event || event.toolName !== "read") return;

    const workspaceDir = deriveWorkspaceDir(ctx, api);
    if (!workspaceDir) return;

    const exportPath = normalizeReadExportPath(extractReadPath(event.params), workspaceDir, api);
    if (!exportPath) return;

    await mirrorExportIntoWorkspace(exportPath, workspaceDir, api);
  });
};
