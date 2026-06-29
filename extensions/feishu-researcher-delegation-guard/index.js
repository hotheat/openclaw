const crypto = require("node:crypto");

const SESSIONS_SPAWN_TOOL_NAME = "sessions_spawn";
const RESEARCHER_AGENT_ID = "researcher";
const DEFAULT_ALLOWED_HANDOFF = "inline | hybrid | export-file";
const DEFAULT_PREFERRED_HANDOFF = "auto";
const DEFAULT_EXPORT_PREFIX = "artifacts/exports/feishu";
const DEFAULT_DISABLE_TOKEN = "Feishu researcher delegation guard: disable";
const DEFAULT_COMPLETION_DELIVERY = "parent";

function isFeishuContext(ctx) {
  return typeof ctx?.agentId === "string" && ctx.agentId.startsWith("feishu-");
}

function extractPeerId(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/\b(ou_[A-Za-z0-9]+|oc_[A-Za-z0-9]+)\b/);
  return match ? match[1] : null;
}

function resolvePeerFromAgentId(agentId) {
  if (typeof agentId !== "string") return null;
  const trimmed = agentId.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("feishu-group-")) {
    const id = extractPeerId(trimmed.slice("feishu-group-".length));
    return id ? `group ${id}` : null;
  }
  if (trimmed.startsWith("feishu-ou_")) {
    const id = extractPeerId(trimmed.slice("feishu-".length));
    return id ? `direct ${id}` : null;
  }
  if (trimmed.startsWith("feishu-")) {
    const id = extractPeerId(trimmed.slice("feishu-".length));
    if (!id) return null;
    return id.startsWith("oc_") ? `group ${id}` : `direct ${id}`;
  }
  return null;
}

function readField(task, label) {
  if (typeof task !== "string") return null;
  const pattern = new RegExp(`^${escapeRegex(label)}:\\s*(.*)$`, "im");
  const match = task.match(pattern);
  return match ? match[1].trim() : null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertField(task, label, value) {
  const normalized = typeof task === "string" ? task.replace(/\r\n/g, "\n") : "";
  const pattern = new RegExp(`^${escapeRegex(label)}:\\s*.*$`, "im");
  if (pattern.test(normalized)) {
    return normalized.replace(pattern, `${label}: ${value}`);
  }

  const trimmedEnd = normalized.replace(/\s+$/, "");
  const separator = trimmedEnd ? "\n" : "";
  return `${trimmedEnd}${separator}${label}: ${value}\n`;
}

function ensureDisableTokenMention(task, disableToken) {
  if (typeof task !== "string") return false;
  const pattern = new RegExp(`^${escapeRegex(disableToken)}\\s*$`, "im");
  return pattern.test(task);
}

function makeHandoffId() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    crypto.randomBytes(4).toString("hex"),
  ];
  return `researcher-${parts.join("")}`;
}

function isMissingOrLegacy(task, label, legacyValues) {
  const current = readField(task, label);
  if (!current) return true;
  return legacyValues.some((value) => current.toLowerCase() === value.toLowerCase());
}

function resolveExportPrefix(pluginConfig) {
  const configured =
    typeof pluginConfig?.exportPrefix === "string"
      ? pluginConfig.exportPrefix
      : typeof pluginConfig?.exportBaseDir === "string"
        ? pluginConfig.exportBaseDir
        : "";
  const normalized = configured.trim();
  return normalized || DEFAULT_EXPORT_PREFIX;
}

function normalizeCompletionDelivery(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "parent" || normalized === "direct" ? normalized : "";
}

module.exports = function register(api) {
  api.on("before_tool_call", async (event, ctx) => {
    if (!event || event.toolName !== SESSIONS_SPAWN_TOOL_NAME) return;
    if (!isFeishuContext(ctx)) return;

    const params = event.params && typeof event.params === "object" ? event.params : {};
    if (params.agentId !== RESEARCHER_AGENT_ID) return;
    if (typeof params.task !== "string" || !params.task.trim()) return;

    const disableToken = String(api.pluginConfig?.disableToken || DEFAULT_DISABLE_TOKEN).trim();
    if (disableToken && ensureDisableTokenMention(params.task, disableToken)) {
      api.logger.info?.("feishu-researcher-delegation-guard: skip patch (explicit disable token)");
      return;
    }

    const peer = resolvePeerFromAgentId(ctx.agentId);
    if (!peer) {
      api.logger.warn?.(
        "feishu-researcher-delegation-guard: unable to derive Feishu delivery peer from ctx.agentId",
      );
      return;
    }

    const exportPrefix = resolveExportPrefix(api.pluginConfig);
    const patchValues = {};
    const nextParams = {};
    const currentCompletionDelivery = normalizeCompletionDelivery(params.completionDelivery);
    const completionDelivery =
      normalizeCompletionDelivery(api.pluginConfig?.defaultCompletionDelivery) ||
      DEFAULT_COMPLETION_DELIVERY;
    if (!currentCompletionDelivery && completionDelivery) {
      nextParams.completionDelivery = completionDelivery;
    }

    if (isMissingOrLegacy(params.task, "Allowed handoff", ["inline", "none"])) {
      patchValues["Allowed handoff"] = String(
        api.pluginConfig?.defaultAllowedHandoff || DEFAULT_ALLOWED_HANDOFF,
      ).trim();
    }
    if (isMissingOrLegacy(params.task, "Preferred handoff", ["inline", "none"])) {
      patchValues["Preferred handoff"] = String(
        api.pluginConfig?.defaultPreferredHandoff || DEFAULT_PREFERRED_HANDOFF,
      ).trim();
    }
    if (isMissingOrLegacy(params.task, "Delivery channel", ["none"])) {
      patchValues["Delivery channel"] = "feishu";
    }
    if (isMissingOrLegacy(params.task, "Delivery peer", ["none"])) {
      patchValues["Delivery peer"] = peer;
    }
    if (isMissingOrLegacy(params.task, "Export location", ["none"])) {
      patchValues["Export location"] = `${exportPrefix}/${makeHandoffId()}/`;
    }

    const patchKeys = Object.keys(patchValues);
    const paramPatchKeys = Object.keys(nextParams);
    if (patchKeys.length === 0 && paramPatchKeys.length === 0) return;

    if (patchKeys.length > 0) {
      let nextTask = params.task;
      for (const key of patchKeys) {
        nextTask = upsertField(nextTask, key, patchValues[key]);
      }
      nextParams.task = nextTask;
    }

    api.logger.info?.(
      `feishu-researcher-delegation-guard: patched researcher spawn fields: ${patchKeys.concat(paramPatchKeys).join(", ")}`,
    );
    return {
      params: nextParams,
    };
  });
};
