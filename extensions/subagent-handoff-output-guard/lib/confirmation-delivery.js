const path = require("node:path");
const {
  HANDOFF_DELIVERY_STATUSES,
  HANDOFF_VERIFICATION_STATUSES,
} = require("./artifact-handoff-contract.js");
const { canonicalHashes } = require("./artifact-identity.js");
const {
  DEFAULT_FALLBACK_TITLE,
  RETRYABLE_DELIVERY_STATES,
  TOMBSTONE_DELIVERY_STATES,
  listStateArtifactHashes,
  listStateExportPaths,
  listStateSupersededArtifactHashes,
} = require("./handoff-state-store.js");
const { asTrimmedString, resolvePeerFromEvent } = require("./runtime-context.js");

const MEDIA_KEYS = ["media", "path", "filePath"];
const MEDIA_ARRAY_KEYS = ["mediaUrls"];

function buildPendingPromptContext(state) {
  if (
    !state ||
    state.__expired ||
    !RETRYABLE_DELIVERY_STATES.has(asTrimmedString(state.deliveryState))
  ) {
    return "";
  }

  const exportPaths = listStateExportPaths(state);
  const lines = [
    "[Pending Subagent Artifact]",
    "A subagent artifact is pending for this Feishu conversation.",
    "If the user asks to send or resend it, call the `message` tool.",
    exportPaths.length > 1
      ? "Use action=send, channel=feishu, the target below, and mediaUrls exactly as provided."
      : "Use action=send, channel=feishu, the target below, and filePath exactly as provided.",
    "Do not read the file before forwarding it, and do not expose any server path in chat.",
    `target: ${asTrimmedString(state.lastTarget) || "<current Feishu peer>"}`,
    exportPaths.length > 1
      ? `mediaUrls: ${JSON.stringify(exportPaths)}`
      : `filePath: ${exportPaths[0] || ""}`,
    `title: ${asTrimmedString(state.title) || DEFAULT_FALLBACK_TITLE}`,
    `mime: ${asTrimmedString(state.mime) || "unknown"}`,
    `verificationStatus: ${
      asTrimmedString(state.verificationStatus) || HANDOFF_VERIFICATION_STATUSES.UNKNOWN
    }`,
    `deliveryStatus: ${
      asTrimmedString(state.deliveryStatus) || HANDOFF_DELIVERY_STATUSES.UNMANAGED
    }`,
    `deliveryState: ${asTrimmedString(state.deliveryState)}`,
    `runId: ${asTrimmedString(state.runId)}`,
  ];
  if (asTrimmedString(state.verificationSummary)) {
    lines.push(`verificationSummary: ${asTrimmedString(state.verificationSummary)}`);
  }
  if (state.deliveryStatus === HANDOFF_DELIVERY_STATUSES.WARNING) {
    lines.push(
      "Tell the user that verification failed and include verificationSummary when sending.",
    );
  }
  if (asTrimmedString(state.lastError)) {
    lines.push(`lastError: ${asTrimmedString(state.lastError)}`);
  }
  return lines.join("\n");
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
  const caption = typeof params?.caption === "string" ? params.caption : "";
  let message = typeof params?.message === "string" ? params.message : "";
  if (message.includes("\\n")) {
    message = message.replaceAll("\\n", "\n");
  }
  if (!message.trim() && caption.trim()) {
    message = caption;
  }
  for (const line of message.split("\n")) {
    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith("MEDIA:")) continue;
    const match = trimmedStart.match(/^MEDIA:\s*(.+)$/);
    if (!match) continue;
    const payload = match[1].trim().replace(/^`|`$/g, "");
    const first = payload[0];
    const last = payload[payload.length - 1];
    if (payload.length >= 2 && first === last && ['"', "'", "`"].includes(first)) {
      values.push(payload.slice(1, -1).trim());
      continue;
    }
    if (/\s/.test(payload) && /[\/\\]/.test(payload)) {
      values.push(payload);
    }
    for (const item of payload.split(/\s+/)) {
      const cleaned = item.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
      if (cleaned) values.push(cleaned);
    }
  }
  return values;
}

function attachmentHashesFromParams(params, state, api) {
  return canonicalHashes(listRawMediaPaths(params), state.__workspaceDir, api);
}

function hashesReferenceAllArtifacts(hashes, state) {
  const expected = listStateArtifactHashes(state);
  return expected.length > 0 && expected.every((hash) => hashes.includes(hash));
}

function hashesReferenceTombstone(hashes, state) {
  const blocked = new Set([
    ...listStateArtifactHashes(state),
    ...listStateSupersededArtifactHashes(state),
  ]);
  return hashes.some((hash) => blocked.has(hash));
}

function hashesReferenceSupersededArtifacts(hashes, state) {
  const superseded = new Set(listStateSupersededArtifactHashes(state));
  return hashes.some((hash) => superseded.has(hash));
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
  return fromText && typeof fromText === "object" ? fromText : result;
}

function extractMessageId(details) {
  return (
    asTrimmedString(details?.result?.messageId) ||
    asTrimmedString(details?.messageId) ||
    asTrimmedString(details?.result?.id)
  );
}

function isErrorLikeStatus(status) {
  const normalized = asTrimmedString(status).toLowerCase();
  if (!normalized || ["0", "ok", "success", "completed", "running"].includes(normalized)) {
    return false;
  }
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

function extractToolError(event) {
  const explicit = asTrimmedString(event?.error);
  if (explicit) return explicit;
  const result = event?.result;
  if (!result || typeof result !== "object") return "";
  if (asTrimmedString(result.error)) return asTrimmedString(result.error);
  if (asTrimmedString(result.message)) return asTrimmedString(result.message);
  if (result.isError === true) return "toolResult.isError=true";
  const details = result.details && typeof result.details === "object" ? result.details : null;
  if (details) {
    if (asTrimmedString(details.error)) return asTrimmedString(details.error);
    if (asTrimmedString(details.message)) return asTrimmedString(details.message);
    if (isErrorLikeStatus(details.status)) return asTrimmedString(details.status);
  }
  return isErrorLikeStatus(result.status) ? asTrimmedString(result.status) : "";
}

function listDeliveryAttachmentPaths(details) {
  const values = [];
  if (typeof details?.mediaUrl === "string") values.push(details.mediaUrl);
  if (Array.isArray(details?.mediaUrls)) {
    for (const item of details.mediaUrls) {
      if (typeof item === "string") values.push(item);
    }
  }
  return values;
}

function attachmentBasename(value) {
  const raw = asTrimmedString(value);
  if (!raw) return "";
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split(/[?#]/, 1)[0];
  }
  const basename = path.posix.basename(pathname.replaceAll("\\", "/"));
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function listExpectedArtifactFileNames(state) {
  if (!Array.isArray(state?.exports)) return [];
  return state.exports
    .map((entry) => {
      const fileName = asTrimmedString(entry?.fileName);
      return fileName || path.posix.basename(asTrimmedString(entry?.path));
    })
    .filter(Boolean);
}

function resultBasenameMatchesExpected(resultBasename, expectedFileName) {
  return resultBasename === expectedFileName || resultBasename.endsWith(`-${expectedFileName}`);
}

function hasCompleteDeliveryAttachmentSet(details, state) {
  const expectedCount = listStateArtifactHashes(state).length;
  if (expectedCount === 0) return false;
  const attachments = [
    ...listDeliveryAttachmentPaths(details),
    ...(Array.isArray(details?.mirroredFileNames) ? details.mirroredFileNames : []),
  ]
    .map(asTrimmedString)
    .filter(Boolean);
  const expectedFileNames = listExpectedArtifactFileNames(state);
  if (expectedFileNames.length !== expectedCount) return false;
  const resultBasenames = [...new Set(attachments.map(attachmentBasename).filter(Boolean))];
  if (resultBasenames.length < expectedCount) return false;
  if (expectedCount === 1) {
    if (
      resultBasenames.some((resultBasename) =>
        resultBasenameMatchesExpected(resultBasename, expectedFileNames[0]),
      )
    ) {
      return true;
    }
    if (Array.isArray(details?.mirroredFileNames) && details.mirroredFileNames.length > 0) {
      return false;
    }
    const deliveryBasenames = listDeliveryAttachmentPaths(details)
      .map(attachmentBasename)
      .filter(Boolean);
    return (
      deliveryBasenames.length > 0 &&
      deliveryBasenames.every((basename) => path.posix.extname(basename) === "")
    );
  }

  const matchedExpectedByResult = new Map();
  const matchExpected = (expectedIndex, visitedResults) => {
    for (const [resultIndex, resultBasename] of resultBasenames.entries()) {
      if (
        visitedResults.has(resultIndex) ||
        !resultBasenameMatchesExpected(resultBasename, expectedFileNames[expectedIndex])
      ) {
        continue;
      }
      visitedResults.add(resultIndex);
      const previousExpectedIndex = matchedExpectedByResult.get(resultIndex);
      if (
        previousExpectedIndex === undefined ||
        matchExpected(previousExpectedIndex, visitedResults)
      ) {
        matchedExpectedByResult.set(resultIndex, expectedIndex);
        return true;
      }
    }
    return false;
  };

  return expectedFileNames.every((_fileName, index) => matchExpected(index, new Set()));
}

function resolveToolRunId(event, ctx) {
  return asTrimmedString(event?.runId) || asTrimmedString(ctx?.runId);
}

function createConfirmationDelivery(api, stateStore) {
  async function beforePromptBuild(ctx) {
    const state = await stateStore.readPendingState(ctx);
    const prependContext = buildPendingPromptContext(state);
    return prependContext ? { prependContext } : undefined;
  }

  async function beforeToolCall(event, ctx) {
    if (!event || event.toolName !== "message") return;
    const peer = resolvePeerFromEvent(event.params || {}, ctx);
    const state = await stateStore.readPendingState(ctx, { peer });
    if (!state) return;

    const hashes = attachmentHashesFromParams(event.params, state, api);
    if (hashesReferenceSupersededArtifacts(hashes, state)) {
      api.logger.warn?.(
        `subagent-handoff-output-guard: blocked superseded artifact send for ${state.runId}`,
      );
      return {
        block: true,
        blockReason: "This subagent artifact is blocked or superseded and cannot be sent",
      };
    }
    if (
      TOMBSTONE_DELIVERY_STATES.has(asTrimmedString(state.deliveryState)) &&
      hashesReferenceTombstone(hashes, state)
    ) {
      api.logger.warn?.(
        `subagent-handoff-output-guard: blocked tombstoned artifact send for ${state.runId}`,
      );
      return {
        block: true,
        blockReason: "This subagent artifact is blocked or superseded and cannot be sent",
      };
    }
    if (state.__expired) return;
    if (
      !RETRYABLE_DELIVERY_STATES.has(asTrimmedString(state.deliveryState)) ||
      !hashesReferenceAllArtifacts(hashes, state)
    ) {
      return;
    }
    const bestEffort =
      event.params?.bestEffort === true ||
      asTrimmedString(event.params?.bestEffort).toLowerCase() === "true";
    if (listStateArtifactHashes(state).length > 1 && bestEffort) {
      return {
        block: true,
        blockReason: "Multi-artifact handoff delivery cannot use bestEffort",
      };
    }

    const toolCallId = asTrimmedString(event.toolCallId);
    const toolCallRunId = resolveToolRunId(event, ctx);
    if (!toolCallId || !toolCallRunId) return;
    await stateStore.updateStateIfCurrent(
      state,
      (current) => RETRYABLE_DELIVERY_STATES.has(asTrimmedString(current.deliveryState)),
      {
        deliveryState: "sending",
        lastToolCallId: toolCallId,
        lastToolCallRunId: toolCallRunId,
        lastTarget: peer?.id || state.lastTarget || "",
        lastError: "",
      },
    );
  }

  async function afterToolCall(event, ctx) {
    if (!event || event.toolName !== "message") return;
    const peer = resolvePeerFromEvent(event?.params || {}, ctx);
    const state = await stateStore.readPendingState(ctx, { peer });
    if (
      !state ||
      state.__expired ||
      state.deliveryState !== "sending" ||
      asTrimmedString(event.toolCallId) !== asTrimmedString(state.lastToolCallId) ||
      resolveToolRunId(event, ctx) !== asTrimmedString(state.lastToolCallRunId)
    ) {
      return;
    }

    const details = extractDeliveryDetails(event);
    const error = extractToolError(event);
    if (error) {
      await stateStore.updateStateIfCurrent(
        state,
        (current) =>
          current.deliveryState === "sending" &&
          asTrimmedString(current.lastToolCallId) === asTrimmedString(event.toolCallId) &&
          asTrimmedString(current.lastToolCallRunId) === resolveToolRunId(event, ctx),
        {
          deliveryState: "failed_retryable",
          lastError: error,
        },
      );
      return;
    }

    const paramsMatch = hashesReferenceAllArtifacts(
      attachmentHashesFromParams(event.params, state, api),
      state,
    );
    const resultHashes = canonicalHashes(
      listDeliveryAttachmentPaths(details),
      state.__workspaceDir,
      api,
      { audit: false },
    );
    const resultMatch = hashesReferenceAllArtifacts(resultHashes, state);
    const expectedArtifactCount = listStateArtifactHashes(state).length;
    const completeAttachmentSet = hasCompleteDeliveryAttachmentSet(details, state);
    const messageId = extractMessageId(details);
    const deliveryConfirmed =
      expectedArtifactCount > 1
        ? completeAttachmentSet
        : resultMatch || (paramsMatch && completeAttachmentSet);
    if (!messageId || !deliveryConfirmed) {
      return;
    }

    await stateStore.updateStateIfCurrent(
      state,
      (current) =>
        current.deliveryState === "sending" &&
        asTrimmedString(current.lastToolCallId) === asTrimmedString(event.toolCallId) &&
        asTrimmedString(current.lastToolCallRunId) === resolveToolRunId(event, ctx),
      {
        deliveryState: "sent",
        messageId,
        lastError: "",
        stagedPath: asTrimmedString(details?.mediaUrl),
        stagedPaths: Array.isArray(details?.mediaUrls)
          ? details.mediaUrls.filter((item) => asTrimmedString(item))
          : [],
      },
    );
  }

  return {
    afterToolCall,
    beforePromptBuild,
    beforeToolCall,
  };
}

module.exports = {
  createConfirmationDelivery,
};
