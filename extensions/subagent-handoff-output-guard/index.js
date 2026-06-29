const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_ENABLED_CHANNELS = ["feishu"];
const DEFAULT_PROMPT_TEMPLATE =
  "研究已完成并已生成文件《{title}》。如果需要我现在发送文件，请回复“**发送文件**”。";
const DEFAULT_FALLBACK_TITLE = "研究结果文件";
const DEFAULT_PENDING_STATE_PATH = path.join(
  ".artifacts",
  "state",
  "pending-researcher-export.json",
);
const DEFAULT_EXPORT_PREFIX = path.join("artifacts", "exports", "feishu");
const HANDOFF_TAG_NAME = "SUBAGENT_HANDOFF";
const HANDOFF_OPEN_TAG = `<${HANDOFF_TAG_NAME}>`;
const HANDOFF_CLOSE_TAG = `</${HANDOFF_TAG_NAME}>`;
const EXPORT_PATH_REGEX = /`?artifacts\/exports\/feishu\/[^\s`]+`?/g;
const MEDIA_KEYS = ["media", "path", "filePath"];
const MEDIA_ARRAY_KEYS = ["mediaUrls"];
const RETRYABLE_DELIVERY_STATES = new Set(["pending", "sending", "failed_retryable"]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandUser(input) {
  const trimmed = asTrimmedString(input);
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
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
  if (expanded) return path.resolve(expanded);
  return "";
}

function deriveWorkspaceDir(ctx, api) {
  const explicit = deriveExplicitWorkspaceDir(ctx);
  if (explicit) return explicit;

  const agentId = asTrimmedString(ctx?.agentId);
  return deriveWorkspaceDirForAgentId(agentId, api);
}

function isPathInsideBase(candidatePath, basePath) {
  const candidate = path.normalize(candidatePath);
  const base = path.normalize(basePath);
  if (candidate === base) return true;
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePendingStatePath(workspaceDir, api) {
  if (!workspaceDir) return "";
  const configured =
    asTrimmedString(api.pluginConfig?.pendingStatePath) || DEFAULT_PENDING_STATE_PATH;
  const relative = configured.replace(/\\/g, "/");
  if (!relative || path.isAbsolute(relative) || relative.split("/").includes("..")) return "";
  const statePath = path.resolve(workspaceDir, relative);
  if (!isPathInsideBase(statePath, workspaceDir)) return "";
  return statePath;
}

function normalizeExportPath(exportPath, api) {
  const raw = asTrimmedString(exportPath).replace(/\\/g, "/");
  if (!raw || path.isAbsolute(raw)) return "";
  const exportPrefix = asTrimmedString(api.pluginConfig?.exportPrefix) || DEFAULT_EXPORT_PREFIX;
  const normalizedPrefix = exportPrefix.replace(/\\/g, "/");
  if (!isPathInsideBase(raw, normalizedPrefix)) return "";
  return path.normalize(raw).replace(/\\/g, "/");
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
  if (trimmed.startsWith("feishu-ou_")) {
    return peerFromId(extractPeerId(trimmed.slice("feishu-".length)));
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

function deriveWorkspaceDirForPeer(peer, api) {
  return deriveWorkspaceDirForAgentId(agentIdFromPeer(peer), api);
}

function readConfiguredWorkspaceDirForPeer(peer, api) {
  return readConfiguredAgentWorkspace(agentIdFromPeer(peer), api);
}

function resolvePeerFromEvent(event, ctx) {
  const candidates = [
    event?.to,
    event?.target,
    event?.channelId,
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
  return resolvePeerFromAgentId(ctx?.agentId);
}

function formatPeer(peer) {
  return peer ? `${peer.kind} ${peer.id}` : "";
}

function hasExportFileHandoff(handoff) {
  return shouldSuggestSend(handoff);
}

function normalizeHandoffExportEntry(entry, api) {
  if (!entry || typeof entry !== "object") return null;
  const exportPath = normalizeExportPath(entry.path, api);
  if (!exportPath) return null;
  return {
    path: exportPath,
    title: asTrimmedString(entry.title),
    mime: asTrimmedString(entry.mime),
  };
}

function extractHandoffExports(handoff, api) {
  const exportEntries = [];
  if (Array.isArray(handoff?.exports)) {
    for (const entry of handoff.exports) {
      const normalized = normalizeHandoffExportEntry(entry, api);
      if (!normalized || exportEntries.some((item) => item.path === normalized.path)) continue;
      exportEntries.push(normalized);
    }
  }

  const primary = normalizeHandoffExportEntry(handoff?.export, api);
  if (primary && !exportEntries.some((item) => item.path === primary.path)) {
    exportEntries.unshift(primary);
  }

  return exportEntries;
}

function listStateExportPaths(state, api) {
  const paths = [];
  if (Array.isArray(state?.exportPaths)) {
    for (const item of state.exportPaths) {
      const normalized = normalizeExportPath(item, api);
      if (normalized && !paths.includes(normalized)) paths.push(normalized);
    }
  }

  const legacyPath = normalizeExportPath(state?.exportPath, api);
  if (legacyPath && !paths.includes(legacyPath)) paths.unshift(legacyPath);
  return paths;
}

function listStagedPaths(state) {
  const stagedPaths = [];
  if (Array.isArray(state?.stagedPaths)) {
    for (const item of state.stagedPaths) {
      const normalized = asTrimmedString(item).replace(/\\/g, "/");
      if (normalized && !stagedPaths.includes(normalized)) stagedPaths.push(normalized);
    }
  }

  const stagedPath = asTrimmedString(state?.stagedPath).replace(/\\/g, "/");
  if (stagedPath && !stagedPaths.includes(stagedPath)) stagedPaths.unshift(stagedPath);
  return stagedPaths;
}

function buildPendingState(handoff, event, ctx, api, peerOverride) {
  const exportEntries = extractHandoffExports(handoff, api);
  if (!hasExportFileHandoff(handoff, api) || exportEntries.length === 0) return null;

  const peer = peerOverride || resolvePeerFromEvent(event, ctx);
  const primaryExport = exportEntries[0];
  const exportPath = primaryExport.path;
  const exportPaths = exportEntries.map((entry) => entry.path);
  const title = asTrimmedString(primaryExport.title) || DEFAULT_FALLBACK_TITLE;
  const mime = asTrimmedString(primaryExport.mime);
  const mode = asTrimmedString(handoff?.mode).toLowerCase() || "export-file";

  return {
    peer: formatPeer(peer),
    exportPath,
    exportPaths,
    exports: exportEntries,
    mirroredWorkspacePath: "",
    title,
    mime,
    mode,
    deliveryState: "pending",
    lastMirrorStatus: "",
    lastMirrorReason: "",
    lastMirrorError: "",
    updatedAt: Date.now(),
    lastTarget: peer?.id || "",
    lastToolCallId: "",
    stagedPath: "",
    stagedPaths: [],
    messageId: "",
    lastError: "",
    source: "subagent-handoff-output-guard",
  };
}

async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function persistPendingState(handoff, event, ctx, api) {
  const peer = resolvePeerFromEvent(event, ctx);
  const explicitWorkspaceDir = deriveExplicitWorkspaceDir(ctx);
  const peerConfiguredWorkspaceDir = readConfiguredWorkspaceDirForPeer(peer, api);
  const peerFallbackWorkspaceDir = explicitWorkspaceDir ? "" : deriveWorkspaceDirForPeer(peer, api);
  const workspaceDir =
    peerConfiguredWorkspaceDir ||
    peerFallbackWorkspaceDir ||
    explicitWorkspaceDir ||
    deriveWorkspaceDir(ctx, api);
  const statePath = resolvePendingStatePath(workspaceDir, api);
  if (!statePath) return;
  const state = buildPendingState(handoff, event, ctx, api, peer);
  if (!state) return;

  try {
    await writeJsonAtomic(statePath, state);
    api.logger.info?.(
      `subagent-handoff-output-guard: persisted pending researcher export ${state.exportPath}`,
    );
  } catch (err) {
    api.logger.warn?.(
      `subagent-handoff-output-guard: failed to persist pending researcher export: ${String(err)}`,
    );
  }
}

function pushUnique(values, value) {
  if (!value || values.includes(value)) return;
  values.push(value);
}

async function readPendingStateFromWorkspace(workspaceDir, api) {
  const statePath = resolvePendingStatePath(workspaceDir, api);
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const exportPaths = listStateExportPaths(parsed, api);
    if (exportPaths.length === 0) return null;
    return {
      ...parsed,
      exportPath: exportPaths[0],
      exportPaths,
      __statePath: statePath,
    };
  } catch {
    return null;
  }
}

async function readPendingState(ctx, api, options = {}) {
  const candidates = [];
  const explicitWorkspaceDir = deriveExplicitWorkspaceDir(ctx);
  pushUnique(candidates, readConfiguredWorkspaceDirForPeer(options.peer, api));
  pushUnique(candidates, explicitWorkspaceDir);
  if (!explicitWorkspaceDir) {
    pushUnique(candidates, deriveWorkspaceDirForPeer(options.peer, api));
  }
  pushUnique(candidates, deriveWorkspaceDir(ctx, api));
  for (const workspaceDir of candidates) {
    const state = await readPendingStateFromWorkspace(workspaceDir, api);
    if (state) return state;
  }
  return null;
}

async function writePendingStatePatch(current, api, patch) {
  if (!current?.__statePath) return;
  const { __statePath, ...state } = current;
  const next = {
    ...state,
    ...patch,
    updatedAt: Date.now(),
  };
  try {
    await writeJsonAtomic(__statePath, next);
  } catch (err) {
    api.logger.warn?.(
      `subagent-handoff-output-guard: failed to update pending researcher export: ${String(err)}`,
    );
  }
}

function createHandoffBlockRegex() {
  return new RegExp(
    `${escapeRegex(HANDOFF_OPEN_TAG)}\\s*([\\s\\S]*?)\\s*${escapeRegex(HANDOFF_CLOSE_TAG)}`,
    "gi",
  );
}

function normalizeChannels(configValue) {
  if (!Array.isArray(configValue) || configValue.length === 0) return DEFAULT_ENABLED_CHANNELS;
  return configValue
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(Boolean);
}

function isEnabledForContext(ctx, enabledChannels) {
  const channel = typeof ctx?.channelId === "string" ? ctx.channelId.trim().toLowerCase() : "";
  if (channel) return enabledChannels.includes(channel);
  const agentId = typeof ctx?.agentId === "string" ? ctx.agentId.trim() : "";
  return enabledChannels.includes("feishu") && agentId.startsWith("feishu-");
}

function extractAndStripHandoff(text) {
  if (typeof text !== "string") return null;

  const regex = createHandoffBlockRegex();
  let parsedPayload = null;
  let matched = false;

  const stripped = text.replace(regex, (_block, payload) => {
    matched = true;
    if (parsedPayload === null && typeof payload === "string") {
      parsedPayload = payload.trim();
    }
    return "";
  });

  if (!matched) return null;

  return {
    stripped: stripped
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    payload: parsedPayload,
  };
}

function parseHandoff(payload) {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function analyzeHandoffText(text) {
  const extracted = extractAndStripHandoff(text);
  if (!extracted) {
    return {
      handoff: null,
      strippedText: "",
      didExtractHandoff: false,
    };
  }

  return {
    handoff: parseHandoff(extracted.payload),
    strippedText: extracted.stripped || "",
    didExtractHandoff: true,
  };
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizePathMentions(text, exportPath, title) {
  if (typeof text !== "string" || !text) return text;

  const safeTitle = title || DEFAULT_FALLBACK_TITLE;
  let next = text;

  if (typeof exportPath === "string" && exportPath.trim()) {
    const escapedPath = escapeRegex(exportPath.trim());
    next = next
      .replace(new RegExp("`" + escapedPath + "`", "g"), `《${safeTitle}》`)
      .replace(new RegExp(escapedPath, "g"), `《${safeTitle}》`);
  }

  return next
    .replace(EXPORT_PATH_REGEX, `《${safeTitle}》`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildConfirmationPrompt(template, title) {
  const safeTitle = title || DEFAULT_FALLBACK_TITLE;
  const raw = typeof template === "string" && template.trim() ? template : DEFAULT_PROMPT_TEMPLATE;
  return raw.replace(/\{title\}/g, safeTitle);
}

function shouldSuggestSend(handoff, api) {
  if (!handoff || typeof handoff !== "object") return false;
  const mode = typeof handoff.mode === "string" ? handoff.mode.trim().toLowerCase() : "";
  if (mode !== "export-file" && mode !== "hybrid") return false;
  if (api) return extractHandoffExports(handoff, api).length > 0;
  if (
    Array.isArray(handoff.exports) &&
    handoff.exports.some((entry) => asTrimmedString(entry?.path))
  ) {
    return true;
  }
  return Boolean(
    handoff.export &&
    typeof handoff.export === "object" &&
    typeof handoff.export.path === "string" &&
    handoff.export.path.trim(),
  );
}

function hasOutgoingAttachment(event) {
  return [event, event?.params, event?.metadata].some((record) => {
    if (!record || typeof record !== "object") return false;
    for (const key of MEDIA_KEYS) {
      if (asTrimmedString(record[key])) return true;
    }
    for (const key of MEDIA_ARRAY_KEYS) {
      const values = record[key];
      if (!Array.isArray(values)) continue;
      if (values.some((item) => asTrimmedString(item))) return true;
    }
    return false;
  });
}

async function shouldAppendConfirmationPrompt(handoff, event, api) {
  if (!shouldSuggestSend(handoff, api)) return false;
  if (hasOutgoingAttachment(event)) return false;
  return true;
}

function buildPendingPromptContext(state) {
  const deliveryState = asTrimmedString(state?.deliveryState);
  if (!RETRYABLE_DELIVERY_STATES.has(deliveryState)) return "";

  const target = asTrimmedString(state?.lastTarget);
  const exportPaths =
    Array.isArray(state?.exportPaths) && state.exportPaths.length > 0
      ? state.exportPaths
      : state?.exportPath
        ? [state.exportPath]
        : [];
  const title = asTrimmedString(state?.title) || DEFAULT_FALLBACK_TITLE;
  const mime = asTrimmedString(state?.mime) || "unknown";
  const lastError = asTrimmedString(state?.lastError);
  const lines = [
    "[Pending Researcher Export]",
    "A researcher export is pending for this Feishu conversation.",
    "If the user asks to send or resend the file, call the `message` tool instead of using `sessions_history`.",
    exportPaths.length > 1
      ? "Use action=send, channel=feishu, the explicit target below, and mediaUrls exactly as provided."
      : "Use action=send, channel=feishu, the explicit target below, and filePath exactly as provided.",
    "Do not read the file before forwarding it, and do not expose any server path in chat.",
    `target: ${target || "<current Feishu peer>"}`,
    `title: ${title}`,
    `mime: ${mime}`,
    `deliveryState: ${deliveryState}`,
  ];
  if (exportPaths.length > 1) {
    lines.splice(6, 0, `mediaUrls: ${JSON.stringify(exportPaths)}`);
  } else if (exportPaths[0]) {
    lines.splice(6, 0, `filePath: ${exportPaths[0]}`);
  }
  if (lastError) lines.push(`lastError: ${lastError}`);
  return lines.join("\n");
}

function isErrorLikeStatus(status) {
  const normalized = asTrimmedString(status).toLowerCase();
  if (!normalized) return false;
  if (["0", "ok", "success", "completed", "running"].includes(normalized)) return false;
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
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

function pathReferencesExport(value, state, options = {}) {
  const raw = asTrimmedString(value).replace(/\\/g, "/");
  if (!raw) return false;
  const allowBasenameFallback = options.allowBasenameFallback === true;
  const exportPaths =
    Array.isArray(state?.exportPaths) && state.exportPaths.length > 0
      ? state.exportPaths
      : state?.exportPath
        ? [state.exportPath]
        : [];
  for (const exportPath of exportPaths) {
    const normalizedExportPath = asTrimmedString(exportPath).replace(/\\/g, "/");
    if (!normalizedExportPath) continue;
    if (raw === normalizedExportPath || raw.endsWith(`/${normalizedExportPath}`)) return true;
    if (allowBasenameFallback) {
      const exportBase = path.basename(normalizedExportPath);
      if (exportBase && path.basename(raw) === exportBase) return true;
      if (exportBase && raw.endsWith(exportBase)) return true;
    }
  }

  return listStagedPaths(state).some((stagedPath) => {
    if (raw === stagedPath) return true;
    return allowBasenameFallback && path.basename(raw) === path.basename(stagedPath);
  });
}

function paramsReferencePendingExport(params, state, options = {}) {
  return listRawMediaPaths(params).some((value) => pathReferencesExport(value, state, options));
}

function deliveryDetailsReferencePendingExport(details, state, options = {}) {
  if (!details || typeof details !== "object") return false;
  if (pathReferencesExport(details.mediaUrl, state, options)) return true;
  if (
    Array.isArray(details.mediaUrls) &&
    details.mediaUrls.some((item) => pathReferencesExport(item, state, options))
  ) {
    return true;
  }
  if (
    Array.isArray(details.mirroredFileNames) &&
    details.mirroredFileNames.some((item) => pathReferencesExport(item, state, options))
  ) {
    return true;
  }
  return false;
}

function readJsonTextFromToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => asTrimmedString(block.text))
    .find(Boolean);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDeliveryDetails(event) {
  const result = event?.result;
  if (!result || typeof result !== "object") return {};
  if (result.details && typeof result.details === "object") return result.details;
  const fromText = readJsonTextFromToolResult(result);
  if (fromText && typeof fromText === "object") return fromText;
  return result;
}

function resolvePeerFromMessageToolEvent(event, ctx, details) {
  return (
    resolvePeerFromEvent(event?.params || {}, ctx) ||
    resolvePeerFromEvent(details || {}, ctx) ||
    resolvePeerFromEvent(event || {}, ctx)
  );
}

function extractMessageId(details) {
  return (
    asTrimmedString(details?.result?.messageId) ||
    asTrimmedString(details?.messageId) ||
    asTrimmedString(details?.result?.id)
  );
}

function extractToolError(event) {
  const explicit = asTrimmedString(event?.error);
  if (explicit) return explicit;
  const result = event?.result;
  if (!result || typeof result !== "object") return "";
  if (result.isError === true) return "toolResult.isError=true";
  if (asTrimmedString(result.error)) return asTrimmedString(result.error);
  if (asTrimmedString(result.message)) return asTrimmedString(result.message);
  const details = result.details && typeof result.details === "object" ? result.details : null;
  if (details) {
    if (asTrimmedString(details.error)) return asTrimmedString(details.error);
    if (asTrimmedString(details.message)) return asTrimmedString(details.message);
    if (isErrorLikeStatus(details.status)) return asTrimmedString(details.status);
  }
  if (isErrorLikeStatus(result.status)) return asTrimmedString(result.status);
  return "";
}

function hasDeliveryAttachment(details) {
  if (asTrimmedString(details?.mediaUrl)) return true;
  if (Array.isArray(details?.mediaUrls) && details.mediaUrls.some((item) => asTrimmedString(item)))
    return true;
  if (Array.isArray(details?.mirroredFileNames) && details.mirroredFileNames.length > 0)
    return true;
  return false;
}

async function updateStateFromMessageToolResult(event, ctx, api) {
  const details = extractDeliveryDetails(event);
  const peer = resolvePeerFromMessageToolEvent(event, ctx, details);
  const state = await readPendingState(ctx, api, { peer });
  if (!state) return;

  const paramsMatch = paramsReferencePendingExport(event.params, state);
  const sameCall =
    asTrimmedString(event.toolCallId) &&
    asTrimmedString(event.toolCallId) === asTrimmedString(state.lastToolCallId);
  const detailsMatch = deliveryDetailsReferencePendingExport(details, state, {
    allowBasenameFallback: sameCall,
  });
  if (!paramsMatch && !sameCall && !detailsMatch) return;

  const error = extractToolError(event);
  if (error) {
    await writePendingStatePatch(state, api, {
      deliveryState: "failed_retryable",
      lastError: error,
    });
    return;
  }

  const messageId = extractMessageId(details);
  if (!messageId || !hasDeliveryAttachment(details)) return;
  await writePendingStatePatch(state, api, {
    deliveryState: "sent",
    messageId,
    lastError: "",
    stagedPath: asTrimmedString(details?.mediaUrl) || state.stagedPath || "",
    stagedPaths: Array.isArray(details?.mediaUrls)
      ? details.mediaUrls.filter((item) => asTrimmedString(item))
      : listStagedPaths(state),
  });
}

async function sanitizeTextForDelivery(text, event, ctx, api) {
  if (typeof text !== "string" || !text.trim()) return null;

  const analyzed = analyzeHandoffText(text);
  if (!analyzed.didExtractHandoff) return null;

  const handoff = analyzed.handoff;
  const exportEntries = extractHandoffExports(handoff, api);
  const exportTitle = asTrimmedString(exportEntries[0]?.title) || DEFAULT_FALLBACK_TITLE;
  const exportPath = exportEntries[0]?.path || "";

  const removePathMentions = api.pluginConfig?.removeExportPathFromBody !== false;
  let nextContent =
    analyzed.strippedText || asTrimmedString(handoff?.summary) || "研究任务已完成。";
  if (removePathMentions) {
    nextContent = sanitizePathMentions(nextContent, exportPath, exportTitle);
  }

  if (await shouldAppendConfirmationPrompt(handoff, event, api)) {
    await persistPendingState(handoff, event, ctx, api);
    const prompt = buildConfirmationPrompt(
      api.pluginConfig?.confirmationPromptTemplate,
      exportTitle,
    );
    if (!nextContent.includes(prompt)) {
      nextContent = nextContent ? `${nextContent}\n\n${prompt}` : prompt;
    }
  }

  if (!nextContent || nextContent === text) return null;
  api.logger.info?.(
    "subagent-handoff-output-guard: sanitized SUBAGENT_HANDOFF from outgoing message",
  );
  return nextContent;
}

module.exports = function register(api) {
  api.on("message_sending", async (event, ctx) => {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForContext(ctx, enabledChannels)) return;
    if (!event || typeof event.content !== "string") return;

    const nextContent = await sanitizeTextForDelivery(event.content, event, ctx, api);
    if (!nextContent) return;
    return { content: nextContent };
  });

  api.on("before_prompt_build", async (_event, ctx) => {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForContext(ctx, enabledChannels)) return;
    const state = await readPendingState(ctx, api);
    const prependContext = buildPendingPromptContext(state);
    if (!prependContext) return;
    return { prependContext };
  });

  api.on("before_tool_call", async (event, ctx) => {
    if (!event || event.toolName !== "message") return;
    const peer = resolvePeerFromEvent(event.params || {}, ctx);
    const state = await readPendingState(ctx, api, { peer });
    if (!state || !paramsReferencePendingExport(event.params, state)) return;

    const rawMediaPaths = listRawMediaPaths(event.params);
    const stagedPaths = rawMediaPaths.filter((value) => !pathReferencesExport(value, state));
    const stagedPath = stagedPaths[0] || "";
    await writePendingStatePatch(state, api, {
      deliveryState: "sending",
      lastToolCallId: asTrimmedString(event.toolCallId),
      lastTarget: peer?.id || state.lastTarget || "",
      stagedPath: asTrimmedString(stagedPath) || state.stagedPath || "",
      stagedPaths: stagedPaths.length > 0 ? stagedPaths : listStagedPaths(state),
      lastError: "",
    });
  });

  api.on("after_tool_call", async (event, ctx) => {
    if (!event || event.toolName !== "message") return;
    await updateStateFromMessageToolResult(event, ctx, api);
  });
};
