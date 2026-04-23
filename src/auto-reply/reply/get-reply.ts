import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { applyLinkUnderstanding } from "../../link-understanding/apply.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { initSessionState, persistRecentMediaSnapshotEarly } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return list.map((entry) => String(entry).trim()).filter(Boolean);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

function mergeAgentDefaults(
  cfg: OpenClawConfig,
  agentId: string,
): NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined {
  const defaults = cfg.agents?.defaults;
  const overrides = resolveAgentConfig(cfg, agentId);
  if (!defaults && !overrides) {
    return undefined;
  }
  const merged = Object.assign({}, defaults, overrides) as NonNullable<
    NonNullable<OpenClawConfig["agents"]>["defaults"]
  >;
  if (defaults?.heartbeat || overrides?.heartbeat) {
    merged.heartbeat = { ...defaults?.heartbeat, ...overrides?.heartbeat };
  }
  return merged;
}

function hasInboundMedia(ctx: MsgContext): boolean {
  return Boolean(
    (Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0) ||
    (typeof ctx.MediaPath === "string" && ctx.MediaPath.trim().length > 0),
  );
}

function buildSessionBodyStripped(ctx: MsgContext): string {
  return normalizeInboundTextNewlines(
    ctx.BodyForAgent ?? ctx.Body ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.BodyForCommands ?? "",
  );
}

function syncSessionContextFromInbound(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
}): TemplateContext {
  return {
    ...params.sessionCtx,
    ...params.ctx,
    BodyStripped: buildSessionBodyStripped(params.ctx),
  };
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = configOverride ?? loadConfig();
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const agentCfg = mergeAgentDefaults(cfg, agentId);
  const heartbeatThinkingOverride =
    opts?.isHeartbeat && opts.heartbeatThinkingOverride === undefined
      ? agentCfg?.heartbeat?.thinking
      : opts?.heartbeatThinkingOverride;
  const resolvedOpts =
    mergedSkillFilter !== undefined || heartbeatThinkingOverride !== undefined
      ? {
          ...opts,
          ...(mergedSkillFilter !== undefined ? { skillFilter: mergedSkillFilter } : {}),
          ...(heartbeatThinkingOverride !== undefined ? { heartbeatThinkingOverride } : {}),
        }
      : opts;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      opts.heartbeatModelOverride?.trim() ?? agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContext(ctx);
  await persistRecentMediaSnapshotEarly({
    ctx: finalized,
    cfg,
  });
  const hadInboundMediaBeforeSessionInit = hasInboundMedia(finalized);

  if (!isFastTestEnv) {
    await applyMediaUnderstanding({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: { provider, model },
    });
    await applyLinkUnderstanding({
      ctx: finalized,
      cfg,
    });
  }

  const commandAuthorized = finalized.CommandAuthorized;
  resolveCommandAuthorization({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  const sessionState = await initSessionState({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;

  if (!isFastTestEnv && !hadInboundMediaBeforeSessionInit && hasInboundMedia(finalized)) {
    await applyMediaUnderstanding({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: { provider, model },
    });
    sessionCtx = syncSessionContextFromInbound({
      ctx: finalized,
      sessionCtx,
    });
  }

  await applyResetModelOverride({
    cfg,
    resetTriggered,
    bodyStripped,
    sessionCtx,
    ctx: finalized,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
    aliasIndex,
  });

  const channelModelOverride = resolveChannelModelOverride({
    cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry.channel ??
      sessionEntry.origin?.provider ??
      (typeof finalized.OriginatingChannel === "string"
        ? finalized.OriginatingChannel
        : undefined) ??
      finalized.Provider,
    groupId: groupResolution?.id ?? sessionEntry.groupId,
    groupChannel: sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
    groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
    parentSessionKey: sessionCtx.ParentSessionKey,
  });
  const hasSessionModelOverride = Boolean(
    sessionEntry.modelOverride?.trim() || sessionEntry.providerOverride?.trim(),
  );
  if (!hasResolvedHeartbeatModelOverride && !hasSessionModelOverride && channelModelOverride) {
    const resolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      provider = resolved.ref.provider;
      model = resolved.ref.model;
    }
  }

  const directiveResult = await resolveReplyDirectives({
    ctx: finalized,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    aliasIndex,
    provider,
    model,
    hasResolvedHeartbeatModelOverride,
    typing,
    opts: resolvedOpts,
    skillFilter: mergedSkillFilter,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const inlineActionResult = await handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts: resolvedOpts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
    skillFilter: mergedSkillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    return inlineActionResult.reply;
  }
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  await stageSandboxMedia({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    sessionKey,
    workspaceDir,
  });

  return runPreparedReply({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts: resolvedOpts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    abortedLastRun,
  });
}
