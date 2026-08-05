const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_ERROR_PREVIEW_CHARS = 280;
const DEFAULT_DELIVERY_RECOVERY_TOOLS = new Set(["message"]);
const SCOPE_SESSION_PREFIX = "session:";
const SCOPE_SESSION_ID_PREFIX = "session-id:";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nowMs() {
  return Date.now();
}

function getConfig(api) {
  const cfg = api.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  const ttlMs = Number.isFinite(cfg.ttlMs) ? Math.max(1000, Math.floor(cfg.ttlMs)) : DEFAULT_TTL_MS;
  const maxSessions = Number.isFinite(cfg.maxSessions)
    ? Math.max(10, Math.floor(cfg.maxSessions))
    : DEFAULT_MAX_SESSIONS;
  const enabled = cfg.enabled !== false;
  return { ttlMs, maxSessions, enabled };
}

function toScopeSession(sessionKey) {
  return `${SCOPE_SESSION_PREFIX}${sessionKey}`;
}

function toScopeSessionId(sessionId) {
  return `${SCOPE_SESSION_ID_PREFIX}${sessionId}`;
}

function redactSensitiveText(text) {
  let output = text;
  // URL query secrets
  output = output.replace(
    /([?&](?:token|access_token|refresh_token|api[_-]?key|apikey|key|secret|password|passwd|signature|sig)=)[^&\s]+/gi,
    "$1***",
  );
  // key=value style secrets
  output = output.replace(
    /\b(token|access_token|refresh_token|api[_-]?key|apikey|secret|password|passwd|signature|sig)\s*[:=]\s*["']?([^\s"',;]+)/gi,
    (_, key) => `${key}=***`,
  );
  // Authorization bearer
  output = output.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***");
  // Common API key patterns
  output = output.replace(/\bsk-[A-Za-z0-9]{12,}\b/g, "sk-***");
  output = output.replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/gi, "xox-***");
  // Absolute local paths (best-effort)
  output = output.replace(/\/(?:home|Users|root)\/[^\s"'`]+/g, "<path>");
  output = output.replace(/[A-Za-z]:\\(?:[^\\\s"'`]+\\)+[^\\\s"'`]+/g, "<path>");
  return output;
}

function isErrorLikeStatus(status) {
  const normalized = asString(status).toLowerCase();
  if (!normalized) return false;
  if (
    normalized === "0" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "running"
  ) {
    return false;
  }
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

function sanitizePreview(value, maxChars = DEFAULT_ERROR_PREVIEW_CHARS) {
  const raw = asString(value);
  if (!raw) return "";
  const firstLine = redactSensitiveText(raw).split(/\r?\n/)[0] || "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function readErrorCandidate(value) {
  if (typeof value === "string") return sanitizePreview(value);
  if (!value || typeof value !== "object") return "";
  const record = value;
  return (
    sanitizePreview(record.error) ||
    sanitizePreview(record.message) ||
    sanitizePreview(record.reason) ||
    ""
  );
}

function extractErrorFromTextContent(result) {
  if (!result || typeof result !== "object") return "";
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => sanitizePreview(block.text))
    .find(Boolean);
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return readErrorCandidate(parsed);
  } catch {
    return text;
  }
}

function extractError(event) {
  const explicit = sanitizePreview(event?.error);
  if (explicit) return explicit;

  const result = event?.result;
  if (result && typeof result === "object") {
    const direct = readErrorCandidate(result);
    if (direct) return direct;
    const details = result.details && typeof result.details === "object" ? result.details : null;
    if (details) {
      const fromDetails = readErrorCandidate(details);
      if (fromDetails) return fromDetails;
      if (isErrorLikeStatus(details.status)) return sanitizePreview(details.status);
    }
    if (isErrorLikeStatus(result.status)) return sanitizePreview(result.status);
    const fromContent = extractErrorFromTextContent(result);
    if (fromContent) return fromContent;
  }
  return "unknown tool error";
}

function isToolError(event) {
  if (!event || typeof event !== "object") return false;
  if (sanitizePreview(event.error)) return true;

  const result = event.result;
  if (!result || typeof result !== "object") return false;
  if (isErrorLikeStatus(result.status)) return true;
  if (readErrorCandidate(result)) return true;
  const details = result.details && typeof result.details === "object" ? result.details : null;
  if (details && (isErrorLikeStatus(details.status) || Boolean(readErrorCandidate(details)))) {
    return true;
  }
  return false;
}

function isDeliveryRecoveryTool(toolName) {
  return DEFAULT_DELIVERY_RECOVERY_TOOLS.has(asString(toolName));
}

module.exports = function register(api) {
  const state = new Map();
  const sessionIdToKey = new Map();

  function uniqueValues(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function resolveWriteScope(ctx) {
    const sessionKey = asString(ctx?.sessionKey);
    if (sessionKey) return toScopeSession(sessionKey);
    const sessionId = asString(ctx?.sessionId);
    if (sessionId) return toScopeSessionId(sessionId);
    return "";
  }

  function resolveReadScopes(ctx) {
    const sessionKey = asString(ctx?.sessionKey);
    const sessionId = asString(ctx?.sessionId);
    const mappedSessionKey = sessionId ? asString(sessionIdToKey.get(sessionId)?.sessionKey) : "";
    return uniqueValues([
      sessionKey ? toScopeSession(sessionKey) : "",
      mappedSessionKey ? toScopeSession(mappedSessionKey) : "",
      sessionId ? toScopeSessionId(sessionId) : "",
    ]);
  }

  function bindSessionId(sessionId, sessionKey) {
    const sid = asString(sessionId);
    const skey = asString(sessionKey);
    if (!sid || !skey) return;
    sessionIdToKey.set(sid, { sessionKey: skey, updatedAt: nowMs() });
  }

  function cleanupExpired(ttlMs) {
    const cutoff = nowMs() - ttlMs;
    for (const [scopeKey, entry] of state.entries()) {
      if (!entry || typeof entry !== "object" || (entry.updatedAt || 0) < cutoff) {
        state.delete(scopeKey);
      }
    }
    for (const [sessionId, binding] of sessionIdToKey.entries()) {
      if (!binding || typeof binding !== "object" || (binding.updatedAt || 0) < cutoff) {
        sessionIdToKey.delete(sessionId);
      }
    }
  }

  function ensureCapacity(maxSessions) {
    if (state.size <= maxSessions) return;
    const sorted = Array.from(state.entries()).sort((a, b) => {
      const aTs = a[1]?.updatedAt || 0;
      const bTs = b[1]?.updatedAt || 0;
      return aTs - bTs;
    });
    const dropCount = Math.max(0, state.size - maxSessions);
    for (let i = 0; i < dropCount; i += 1) state.delete(sorted[i][0]);
  }

  function clearLatch(scopeKey, reason) {
    if (!scopeKey || !state.has(scopeKey)) return;
    state.delete(scopeKey);
    api.logger.info?.(`tool-error-latch: cleared latch scope=${scopeKey} reason=${reason}`);
  }

  function getLatch(scopeKey, ttlMs) {
    if (!scopeKey) return null;
    const entry = state.get(scopeKey);
    if (!entry) return null;
    if ((entry.updatedAt || 0) + ttlMs < nowMs()) {
      state.delete(scopeKey);
      return null;
    }
    return entry;
  }

  function findLatchForContext(ctx, ttlMs, promoteToSession) {
    const scopes = resolveReadScopes(ctx);
    const sessionKey = asString(ctx?.sessionKey);
    const promoteScope = promoteToSession && sessionKey ? toScopeSession(sessionKey) : "";

    for (const scopeKey of scopes) {
      const entry = getLatch(scopeKey, ttlMs);
      if (!entry) continue;

      if (promoteScope && scopeKey !== promoteScope) {
        const promoted = { ...entry, updatedAt: nowMs() };
        state.set(promoteScope, promoted);
        state.delete(scopeKey);
        api.logger.info?.(
          `tool-error-latch: promoted latch scope=${scopeKey} -> ${promoteScope} tool=${promoted.toolName}`,
        );
        return { scopeKey: promoteScope, entry: promoted };
      }

      return { scopeKey, entry };
    }

    return null;
  }

  function upsertLatch(scopeKey, params) {
    const { toolName, error, toolCallId, reason } = params;
    const previous = state.get(scopeKey);
    const sameCall =
      previous &&
      toolCallId &&
      previous.toolCallId === toolCallId &&
      previous.toolName === toolName &&
      previous.error === error;
    const attempts = sameCall
      ? previous.attempts || 1
      : previous
        ? (previous.attempts || 0) + 1
        : 1;
    state.set(scopeKey, {
      toolName,
      error,
      attempts,
      toolCallId: toolCallId || undefined,
      updatedAt: nowMs(),
    });
    api.logger.warn?.(
      `tool-error-latch: latched failure scope=${scopeKey} tool=${toolName} attempts=${attempts} reason=${reason} error=${error}`,
    );
  }

  function clearMatchingLatches(ctx, ttlMs, reason, toolName) {
    const scopes = resolveReadScopes(ctx);
    for (const scopeKey of scopes) {
      const entry = getLatch(scopeKey, ttlMs);
      if (!entry) continue;
      if (toolName && entry.toolName !== toolName) continue;
      clearLatch(scopeKey, reason);
    }
  }

  api.on("after_tool_call", (event, ctx) => {
    const { enabled, ttlMs, maxSessions } = getConfig(api);
    if (!enabled) return;

    cleanupExpired(ttlMs);
    ensureCapacity(maxSessions);

    const sessionKey = asString(ctx?.sessionKey);
    const sessionId = asString(ctx?.sessionId);
    bindSessionId(sessionId, sessionKey);
    const scopeKey = resolveWriteScope(ctx);
    if (!scopeKey) {
      api.logger.debug?.("tool-error-latch: skip after_tool_call latch (missing session scope)");
      return;
    }

    const toolName = asString(event?.toolName) || "unknown_tool";
    if (isToolError(event)) {
      const error = extractError(event);
      upsertLatch(scopeKey, { toolName, error, reason: "after_tool_call" });
      return;
    }

    const current = findLatchForContext(ctx, ttlMs, true);
    if (!current) return;
    if (isDeliveryRecoveryTool(toolName)) {
      clearMatchingLatches(ctx, ttlMs, `delivery_tool_succeeded:${toolName}`);
      return;
    }
    if (current.entry.toolName === toolName) {
      clearMatchingLatches(ctx, ttlMs, `tool_recovered:${toolName}`, toolName);
    }
  });

  api.on("tool_result_persist", (event, ctx) => {
    const { enabled, ttlMs, maxSessions } = getConfig(api);
    if (!enabled) return;

    cleanupExpired(ttlMs);
    ensureCapacity(maxSessions);

    if (event?.isSynthetic) return;
    const scopeKey = resolveWriteScope(ctx);
    if (!scopeKey) return;

    const message = event?.message;
    if (!message || message.role !== "toolResult") return;

    const syntheticError =
      message && typeof message === "object" && message.isError === true
        ? "toolResult.isError=true"
        : "";
    const pseudoEvent = { result: message, error: syntheticError };
    if (!isToolError(pseudoEvent)) return;

    const toolName = asString(event?.toolName) || asString(message.toolName) || "unknown_tool";
    const error = extractError(pseudoEvent);
    upsertLatch(scopeKey, {
      toolName,
      error,
      toolCallId: asString(event?.toolCallId),
      reason: "tool_result_persist",
    });
  });

  api.on("session_end", (event) => {
    const { enabled } = getConfig(api);
    if (!enabled) return;
    const sessionId = asString(event?.sessionId);
    if (!sessionId) return;
    const mappedSessionKey = asString(sessionIdToKey.get(sessionId)?.sessionKey);
    const sessionScope = mappedSessionKey ? toScopeSession(mappedSessionKey) : "";
    const sessionIdScope = toScopeSessionId(sessionId);
    clearLatch(sessionIdScope, "session_end");
    clearLatch(sessionScope, "session_end");
    sessionIdToKey.delete(sessionId);
  });
};
