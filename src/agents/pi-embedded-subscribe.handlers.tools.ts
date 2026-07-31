import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  getDiagnosticSessionState,
  type SessionState,
} from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";
import {
  extractMessagingToolSend,
  extractToolErrorMessage,
  extractToolResultMediaPaths,
  extractToolResultText,
  filterToolResultMediaUrls,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { resolveToolLoopDetectionConfig } from "./pi-tools.js";
import {
  detectSchemaValidationErrorLoop,
  extractSchemaValidationOutcomeSignature,
  recordToolCallOutcome,
  shouldEmitLoopWarning,
} from "./tool-loop-detection.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

/** Track tool execution start times and args for after_tool_call hook */
const toolStartData = new Map<string, { startTime: number; args: unknown }>();
const CRITICAL_SCHEMA_VALIDATION_WARNING_KEY_PREFIX = "critical:";

function buildToolStartKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function buildToolLoopSteerMessage(params: { toolName: string; message: string }): string {
  return [
    "OpenClaw tool-loop protection triggered.",
    params.message,
    `Do not call ${params.toolName} again with the same invalid arguments.`,
    "Stop tool execution and respond with the failure reason and the corrected next step.",
  ].join("\n");
}

function resetCriticalSchemaValidationLoopBuckets(sessionState: SessionState): void {
  for (const key of sessionState.toolLoopWarningBuckets?.keys() ?? []) {
    if (key.startsWith(CRITICAL_SCHEMA_VALIDATION_WARNING_KEY_PREFIX)) {
      sessionState.toolLoopWarningBuckets?.delete(key);
    }
  }
}

function recordToolLoopDetectionOutcome(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  toolCallId: string;
  toolArgs: unknown;
  result: unknown;
  isToolError: boolean;
}): void {
  if (!params.isToolError || !params.ctx.params.sessionKey) {
    return;
  }

  const agentId = resolveAgentIdFromSessionKey(params.ctx.params.sessionKey);
  const sessionId =
    (params.ctx.params.session as { id?: string } | undefined)?.id ?? params.ctx.params.sessionKey;
  const loopDetection = resolveToolLoopDetectionConfig({
    cfg: params.ctx.params.config,
    agentId,
  });
  const outcomeSignature = extractSchemaValidationOutcomeSignature({
    toolName: params.toolName,
    result: params.result,
  });
  if (!outcomeSignature) {
    return;
  }

  const sessionState = getDiagnosticSessionState({
    sessionKey: params.ctx.params.sessionKey,
    sessionId,
  });
  recordToolCallOutcome(sessionState, {
    toolName: params.toolName,
    toolParams: params.toolArgs,
    toolCallId: params.toolCallId,
    result: params.result,
    config: loopDetection,
  });
  const loopResult = detectSchemaValidationErrorLoop(sessionState, {
    toolName: params.toolName,
    outcomeSignature,
    config: loopDetection,
  });

  if (!loopResult.stuck || loopResult.detector !== "schema_validation_error_repeat") {
    resetCriticalSchemaValidationLoopBuckets(sessionState);
    return;
  }

  const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${params.toolName}`;
  if (loopResult.level === "critical") {
    const criticalKey = `${CRITICAL_SCHEMA_VALIDATION_WARNING_KEY_PREFIX}${warningKey}`;
    if (!shouldEmitLoopWarning(sessionState, criticalKey, 1)) {
      return;
    }
    logToolLoopAction({
      sessionKey: params.ctx.params.sessionKey,
      sessionId,
      toolName: params.toolName,
      level: "critical",
      action: "block",
      detector: loopResult.detector,
      count: loopResult.count,
      message: loopResult.message,
    });
    params.ctx.params.session
      ?.steer(buildToolLoopSteerMessage({ toolName: params.toolName, message: loopResult.message }))
      .catch((err) => {
        params.ctx.log.warn(
          `tool loop critical steer failed: tool=${params.toolName} error=${String(err)}`,
        );
      });
    const abortReason = new Error(loopResult.message);
    abortReason.name = "ToolLoopAbortError";
    params.ctx.params.abortRun?.(abortReason);
    return;
  }

  resetCriticalSchemaValidationLoopBuckets(sessionState);
  if (!shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
    return;
  }
  logToolLoopAction({
    sessionKey: params.ctx.params.sessionKey,
    sessionId,
    toolName: params.toolName,
    level: "warning",
    action: "warn",
    detector: loopResult.detector,
    count: loopResult.count,
    message: loopResult.message,
  });
  params.ctx.params.session
    ?.steer(buildToolLoopSteerMessage({ toolName: params.toolName, message: loopResult.message }))
    .catch((err) => {
      params.ctx.log.warn(
        `tool loop warning steer failed: tool=${params.toolName} error=${String(err)}`,
      );
    });
}

function isCronAddAction(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const action = (args as Record<string, unknown>).action;
  return typeof action === "string" && action.trim().toLowerCase() === "add";
}

function buildToolCallSummary(toolName: string, args: unknown, meta?: string): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    mutatingAction: mutation.mutatingAction,
    actionFingerprint: mutation.actionFingerprint,
  };
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "exec" && normalized !== "bash") {
    return meta;
  }
  if (!args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) {
    flags.push("pty");
  }
  if (record.elevated === true) {
    flags.push("elevated");
  }
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

function pushUniqueMediaUrl(urls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  urls.push(normalized);
}

function collectMessagingMediaUrlsFromRecord(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  pushUniqueMediaUrl(urls, seen, record.media);
  pushUniqueMediaUrl(urls, seen, record.mediaUrl);
  pushUniqueMediaUrl(urls, seen, record.path);
  pushUniqueMediaUrl(urls, seen, record.filePath);

  const mediaUrls = record.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    for (const mediaUrl of mediaUrls) {
      pushUniqueMediaUrl(urls, seen, mediaUrl);
    }
  }

  return urls;
}

function collectMessagingMediaUrlsFromToolResult(result: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const appendFromRecord = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    const extracted = collectMessagingMediaUrlsFromRecord(value as Record<string, unknown>);
    for (const url of extracted) {
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }
  };

  appendFromRecord(result);
  if (result && typeof result === "object") {
    appendFromRecord((result as Record<string, unknown>).details);
  }

  const outputText = extractToolResultText(result);
  if (outputText) {
    try {
      appendFromRecord(JSON.parse(outputText));
    } catch {
      // Ignore non-JSON tool output.
    }
  }

  return urls;
}

function emitToolResultOutput(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  meta?: string;
  isToolError: boolean;
  result: unknown;
  sanitizedResult: unknown;
}) {
  const { ctx, toolName, meta, isToolError, result, sanitizedResult } = params;
  if (!ctx.params.onToolResult) {
    return;
  }

  if (ctx.shouldEmitToolOutput()) {
    const outputText = extractToolResultText(sanitizedResult);
    if (outputText) {
      ctx.emitToolOutput(toolName, meta, outputText);
    }
    return;
  }

  if (isToolError) {
    return;
  }

  // emitToolOutput() already handles MEDIA: directives when enabled; this path
  // only sends raw media URLs for non-verbose delivery mode.
  const mediaPaths = filterToolResultMediaUrls(toolName, extractToolResultMediaPaths(result));
  if (mediaPaths.length === 0) {
    return;
  }
  try {
    void ctx.params.onToolResult({ mediaUrls: mediaPaths });
  } catch {
    // ignore delivery failures
  }
}

export async function handleToolExecutionStart(
  ctx: ToolHandlerContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
) {
  // Flush pending block replies to preserve message boundaries before tool execution.
  ctx.flushBlockReplyBuffer();
  if (ctx.params.onBlockReplyFlush) {
    void ctx.params.onBlockReplyFlush();
  }

  const rawToolName = String(evt.toolName);
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = String(evt.toolCallId);
  const args = evt.args;

  const startTime = Date.now();
  // Track start time and args for after_tool_call hook
  toolStartData.set(buildToolStartKey(ctx.params.runId, toolCallId), { startTime, args });

  if (toolName === "read") {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const filePathValue =
      typeof record.path === "string"
        ? record.path
        : typeof record.file_path === "string"
          ? record.file_path
          : "";
    const filePath = filePathValue.trim();
    if (!filePath) {
      const argsPreview = typeof args === "string" ? args.slice(0, 200) : undefined;
      ctx.log.warn(
        `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
      );
    }
  }

  const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
  ctx.state.toolMetaById.set(toolCallId, buildToolCallSummary(toolName, args, meta));
  ctx.log.debug(
    `embedded run tool start: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );
  const shouldEmitToolEvents = ctx.shouldEmitToolResult();
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "start",
      name: toolName,
      toolCallId,
      args: args as Record<string, unknown>,
    },
  });
  // Best-effort typing signal; do not block tool summaries on slow emitters.
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: { phase: "start", name: toolName, toolCallId },
  });

  if (
    ctx.params.onToolResult &&
    shouldEmitToolEvents &&
    !ctx.state.toolSummaryById.has(toolCallId)
  ) {
    ctx.state.toolSummaryById.add(toolCallId);
    ctx.emitToolSummary(toolName, meta);
  }

  // Track messaging tool sends (pending until confirmed in tool_execution_end).
  if (isMessagingTool(toolName)) {
    const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
    if (isMessagingSend) {
      const sendTarget = extractMessagingToolSend(toolName, argsRecord);
      if (sendTarget) {
        ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
      }
      // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
      const text = (argsRecord.content as string) ?? (argsRecord.message as string);
      if (text && typeof text === "string") {
        ctx.state.pendingMessagingTexts.set(toolCallId, text);
        ctx.log.debug(`Tracking pending messaging text: tool=${toolName} len=${text.length}`);
      }
      // Track media URLs from messaging tool args (pending until tool_execution_end).
      const mediaUrls = collectMessagingMediaUrlsFromRecord(argsRecord);
      if (mediaUrls.length > 0) {
        ctx.state.pendingMessagingMediaUrls.set(toolCallId, mediaUrls);
      }
    }
  }
}

export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
}

export async function handleToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const isError = Boolean(evt.isError);
  const result = evt.result;
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const toolStartKey = buildToolStartKey(ctx.params.runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
  const callSummary = ctx.state.toolMetaById.get(toolCallId);
  const meta = callSummary?.meta;
  ctx.state.toolMetas.push({ toolName, meta });
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      error: errorMessage,
      mutatingAction: callSummary?.mutatingAction,
      actionFingerprint: callSummary?.actionFingerprint,
    };
    // pi-agent reports argument schema validation failures as tool_execution_end
    // errors before OpenClaw's wrapped tool execute path runs. Record them here
    // so repeated invalid tool calls can be detected and steered out of the loop.
    recordToolLoopDetectionOutcome({
      ctx,
      toolName,
      toolCallId,
      toolArgs: startData?.args ?? {},
      result: sanitizedResult,
      isToolError,
    });
  } else if (ctx.state.lastToolError) {
    // Keep unresolved failures in memory so a run cannot end silently after an
    // earlier tool error. For mutating actions we clear only when the same
    // action fingerprint succeeds.
    if (ctx.state.lastToolError.mutatingAction) {
      if (
        isSameToolMutationAction(ctx.state.lastToolError, {
          toolName,
          meta,
          actionFingerprint: callSummary?.actionFingerprint,
        })
      ) {
        ctx.state.lastToolError = undefined;
      }
    }
  }

  // Commit messaging tool text on success, discard on error.
  const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
  const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
  if (pendingText) {
    ctx.state.pendingMessagingTexts.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTexts.push(pendingText);
      ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(pendingText));
      ctx.log.debug(`Committed messaging text: tool=${toolName} len=${pendingText.length}`);
      ctx.trimMessagingToolSent();
    }
  }
  if (pendingTarget) {
    ctx.state.pendingMessagingTargets.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTargets.push(pendingTarget);
      ctx.trimMessagingToolSent();
    }
  }
  const pendingMediaUrls = ctx.state.pendingMessagingMediaUrls.get(toolCallId) ?? [];
  ctx.state.pendingMessagingMediaUrls.delete(toolCallId);
  const startArgs =
    startData?.args && typeof startData.args === "object"
      ? (startData.args as Record<string, unknown>)
      : {};
  const isMessagingSend =
    pendingMediaUrls.length > 0 ||
    (isMessagingTool(toolName) && isMessagingToolSendAction(toolName, startArgs));
  if (!isToolError && isMessagingSend) {
    const committedMediaUrls = [
      ...pendingMediaUrls,
      ...collectMessagingMediaUrlsFromToolResult(result),
    ];
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
  }

  // Track committed reminders only when cron.add completed successfully.
  if (!isToolError && toolName === "cron" && isCronAddAction(startData?.args)) {
    ctx.state.successfulCronAdds += 1;
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      result: sanitizedResult,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
    },
  });

  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  emitToolResultOutput({ ctx, toolName, meta, isToolError, result, sanitizedResult });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const toolArgs = startData?.args;
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: (toolArgs && typeof toolArgs === "object" ? toolArgs : {}) as Record<string, unknown>,
      toolCallId,
      runId: ctx.params.runId,
      result: sanitizedResult,
      error: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
      durationMs,
    };
    void hookRunnerAfter
      .runAfterToolCall(hookEvent, {
        toolName,
        sessionKey: ctx.params.sessionKey,
        toolCallId,
        runId: ctx.params.runId,
      })
      .catch((err) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
}
