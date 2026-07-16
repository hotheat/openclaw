import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_RESET_TRIGGERS,
  deriveSessionMetaPatch,
  evaluateSessionFreshness,
  type GroupKeyResolution,
  loadSessionStore,
  mergeSessionEntry,
  resolveAndPersistSessionFile,
  resolveChannelResetConfig,
  resolveDailyResetAtMs,
  resolveThreadFlag,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveGroupSessionKey,
  resolveSessionFilePath,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
  updateSessionStore,
} from "../../config/sessions.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { archiveSessionTranscripts } from "../../gateway/session-utils.fs.js";
import { captureSessionToMemory } from "../../hooks/bundled/session-memory/handler.js";
import { resolveHookConfig } from "../../hooks/config.js";
import { deliverSessionMaintenanceWarning } from "../../infra/session-maintenance-warning.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import {
  CONTROL_UI_MESSAGE_CHANNEL,
  INTERNAL_MESSAGE_CHANNEL,
  WEBCHAT_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  attachRecentImageSnapshot,
  buildRecentImageSnapshot,
  shouldAttachRecentImageSnapshot,
} from "./recent-media.js";

const log = createSubsystemLogger("session-init");
const DAILY_MEMORY_CAPTURE_PENDING_TTL_MS = 10 * 60 * 1000;

type ResolvedSessionStoreTarget = {
  sessionCtxForState: MsgContext;
  sessionScope: SessionScope;
  agentId: string;
  groupResolution?: GroupKeyResolution;
  storePath: string;
  sessionKey: string;
};

function resolveSessionStoreTarget(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): ResolvedSessionStoreTarget {
  const { ctx, cfg } = params;
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  return {
    sessionCtxForState,
    sessionScope,
    agentId,
    groupResolution,
    storePath,
    sessionKey,
  };
}

function isPendingRecentMediaSnapshotInit(entry?: SessionEntry): boolean {
  return entry?.pendingRecentMediaSnapshotInit === true;
}

function hasFreshDailyMemoryCapturePending(params: {
  entry: SessionEntry;
  sourceSessionId: string;
  now: number;
}): boolean {
  if (params.entry.dailyMemoryCapturePendingSessionId !== params.sourceSessionId) {
    return false;
  }
  const pendingAt = params.entry.dailyMemoryCapturePendingAt;
  return (
    typeof pendingAt === "number" &&
    Number.isFinite(pendingAt) &&
    params.now - pendingAt < DAILY_MEMORY_CAPTURE_PENDING_TTL_MS
  );
}

async function markDailyMemoryCapturePending(params: {
  storePath: string;
  sessionKey: string;
  sourceSessionId: string;
  targetSessionId: string;
}): Promise<boolean> {
  const now = Date.now();
  try {
    return await updateSessionStore(
      params.storePath,
      (store) => {
        const current = store[params.sessionKey];
        if (!current) {
          return false;
        }
        if (current.sessionId !== params.targetSessionId) {
          return false;
        }
        if (current.dailyMemoryCaptureSessionId === params.sourceSessionId) {
          return false;
        }
        if (
          hasFreshDailyMemoryCapturePending({
            entry: current,
            sourceSessionId: params.sourceSessionId,
            now,
          })
        ) {
          return false;
        }

        store[params.sessionKey] = {
          ...current,
          dailyMemoryCapturePendingAt: now,
          dailyMemoryCapturePendingSessionId: params.sourceSessionId,
        };
        return true;
      },
      { activeSessionKey: params.sessionKey },
    );
  } catch (err) {
    log.warn(`failed to persist daily memory capture pending marker: ${String(err)}`);
    return false;
  }
}

async function finishDailyMemoryCapture(params: {
  storePath: string;
  sessionKey: string;
  sourceSessionId: string;
  targetSessionId: string;
  completed: boolean;
}): Promise<void> {
  try {
    await updateSessionStore(
      params.storePath,
      (store) => {
        const current = store[params.sessionKey];
        if (
          !current ||
          current.sessionId !== params.targetSessionId ||
          current.dailyMemoryCapturePendingSessionId !== params.sourceSessionId
        ) {
          return;
        }
        store[params.sessionKey] = {
          ...current,
          dailyMemoryCapturePendingAt: undefined,
          dailyMemoryCapturePendingSessionId: undefined,
          ...(params.completed
            ? {
                dailyMemoryCaptureAt: Date.now(),
                dailyMemoryCaptureSessionId: params.sourceSessionId,
              }
            : {}),
        };
      },
      { activeSessionKey: params.sessionKey },
    );
  } catch (err) {
    log.warn(`failed to persist daily memory capture metadata: ${String(err)}`);
  }
}

export async function persistRecentMediaSnapshotEarly(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<void> {
  const snapshot = buildRecentImageSnapshot(params.ctx);
  if (!snapshot) {
    return;
  }

  const { storePath, sessionKey } = resolveSessionStoreTarget(params);
  await updateSessionStore(
    storePath,
    (store) => {
      const existing = store[sessionKey];
      const patch: Partial<SessionEntry> = {
        recentMediaSnapshot: snapshot,
      };

      if (!existing || isPendingRecentMediaSnapshotInit(existing)) {
        patch.pendingRecentMediaSnapshotInit = true;
      }

      store[sessionKey] = mergeSessionEntry(existing, patch);
    },
    { activeSessionKey: sessionKey },
  );
}

function resolveSessionKeyChannelHint(sessionKey?: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return undefined;
  }
  const head = parsed.rest.split(":")[0]?.trim().toLowerCase();
  if (!head || head === "main" || head === "cron" || head === "subagent" || head === "acp") {
    return undefined;
  }
  return normalizeMessageChannel(head);
}

function resolveLastChannelRaw(params: {
  originatingChannelRaw?: string;
  persistedLastChannel?: string;
  sessionKey?: string;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
  let resolved = params.originatingChannelRaw || params.persistedLastChannel;
  // Non-delivery turns should not overwrite previously known external
  // delivery routes (or explicit channel hints encoded in the session key).
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL ||
    originatingChannel === CONTROL_UI_MESSAGE_CHANNEL
  ) {
    if (
      persistedChannel &&
      persistedChannel !== INTERNAL_MESSAGE_CHANNEL &&
      persistedChannel !== CONTROL_UI_MESSAGE_CHANNEL &&
      persistedChannel !== WEBCHAT_MESSAGE_CHANNEL
    ) {
      resolved = persistedChannel;
    } else if (
      sessionKeyChannelHint &&
      sessionKeyChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
      isDeliverableMessageChannel(sessionKeyChannelHint)
    ) {
      resolved = sessionKeyChannelHint;
    } else {
      resolved = undefined;
    }
  }
  return resolved;
}

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};

function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
    { agentId: params.agentId, sessionsDir: params.sessionsDir },
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
    return null;
  }
  try {
    const manager = SessionManager.open(parentSessionFile);
    const leafId = manager.getLeafId();
    if (leafId) {
      const branchEntries = manager.getBranch(leafId);
      if (branchEntries.length > 0) {
        const sessionId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const fileTimestamp = timestamp.replace(/[:.]/g, "-");
        const sessionFile = path.join(
          manager.getSessionDir(),
          `${fileTimestamp}_${sessionId}.jsonl`,
        );
        const header = {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp,
          cwd: manager.getCwd(),
          parentSession: parentSessionFile,
        };
        const payload = [header, ...branchEntries].map((entry) => JSON.stringify(entry)).join("\n");
        fs.writeFileSync(sessionFile, `${payload}\n`, "utf-8");
        return { sessionId, sessionFile };
      }
    }
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(manager.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: manager.getCwd(),
      parentSession: parentSessionFile,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  const sessionCfg = cfg.session;
  const { sessionCtxForState, sessionScope, agentId, groupResolution, storePath, sessionKey } =
    resolveSessionStoreTarget({ ctx, cfg });
  const configuredResetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const supportedResetTriggers = configuredResetTriggers.filter(
    (trigger) => trigger.trim().toLowerCase() !== "/reset",
  );
  const resetTriggers =
    supportedResetTriggers.length > 0 ? supportedResetTriggers : DEFAULT_RESET_TRIGGERS;

  // CRITICAL: Skip cache to ensure fresh data when resolving session identity.
  // Stale cache (especially with multiple gateway processes or on Windows where
  // mtime granularity may miss rapid writes) can cause incorrect sessionId
  // generation, leading to orphaned transcript files. See #17971.
  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath, {
    skipCache: true,
  });
  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;
  let resetTriggered = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;
  let persistedReasoning: string | undefined;
  let persistedTtsAuto: TtsAutoMode | undefined;
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;
  let persistedLabel: string | undefined;

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // to Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  // IMPORTANT: do NOT lowercase the entire command body.
  // Users often pass case-sensitive arguments (e.g. filesystem paths on Linux).
  // Command parsing downstream lowercases only the command token for matching.
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();

  // Use CommandBody/RawBody for reset trigger matching (clean message without structural context).
  const rawBody = commandSource;
  const trimmedBody = rawBody.trim();
  const resetAuthorized = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  }).isAuthorizedSender;
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // web inbox before we get here. They prevented reset triggers like "/new"
  // from matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;

  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = trimmedBody.toLowerCase();
  const strippedForResetLower = strippedForReset.toLowerCase();

  for (const trigger of resetTriggers) {
    if (!trigger) {
      continue;
    }
    if (!resetAuthorized) {
      break;
    }
    const triggerLower = trigger.toLowerCase();
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      trimmedBodyLower.startsWith(triggerPrefixLower) ||
      strippedForResetLower.startsWith(triggerPrefixLower)
    ) {
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      break;
    }
  }

  const entry = sessionStore[sessionKey];
  const pendingRecentMediaSnapshotInit = isPendingRecentMediaSnapshotInit(entry);
  const existingSessionEntry = pendingRecentMediaSnapshotInit ? undefined : entry;
  const storedRecentMediaSnapshot = entry?.recentMediaSnapshot;
  const previousSessionEntry =
    resetTriggered && existingSessionEntry ? { ...existingSessionEntry } : undefined;
  const now = Date.now();
  const isThread = resolveThreadFlag({
    sessionKey,
    messageThreadId: ctx.MessageThreadId,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
    parentSessionKey: ctx.ParentSessionKey,
  });
  const resetType = resolveSessionResetType({ sessionKey, isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const freshness = existingSessionEntry
    ? evaluateSessionFreshness({
        updatedAt: existingSessionEntry.updatedAt,
        now,
        policy: resetPolicy,
      })
    : undefined;
  const dailyMemoryResetAt =
    existingSessionEntry != null ? resolveDailyResetAtMs(now, resetPolicy.atHour) : undefined;
  const shouldCaptureDailyMemoryForExistingSession =
    existingSessionEntry != null &&
    dailyMemoryResetAt != null &&
    existingSessionEntry.updatedAt < dailyMemoryResetAt &&
    (existingSessionEntry.dailyMemoryCaptureAt ?? 0) < dailyMemoryResetAt &&
    resolveHookConfig(cfg, "session-memory")?.enabled !== false;
  const resetFreshness =
    !resetPolicy.explicit && freshness?.staleReason === "daily"
      ? { ...freshness, fresh: true, staleReason: undefined }
      : freshness;
  const freshEntry = resetFreshness?.fresh ?? false;
  const endedSessionReason = resetTriggered ? "new" : resetFreshness?.staleReason;

  if (!isNewSession && freshEntry && existingSessionEntry) {
    sessionId = existingSessionEntry.sessionId;
    systemSent = existingSessionEntry.systemSent ?? false;
    abortedLastRun = existingSessionEntry.abortedLastRun ?? false;
    persistedThinking = existingSessionEntry.thinkingLevel;
    persistedVerbose = existingSessionEntry.verboseLevel;
    persistedReasoning = existingSessionEntry.reasoningLevel;
    persistedTtsAuto = existingSessionEntry.ttsAuto;
    persistedModelOverride = existingSessionEntry.modelOverride;
    persistedProviderOverride = existingSessionEntry.providerOverride;
    persistedLabel = existingSessionEntry.label;
  } else {
    sessionId =
      pendingRecentMediaSnapshotInit && entry?.sessionId ? entry.sessionId : crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
    // When an explicit reset trigger starts a new session, carry over
    // user-set behavior overrides (verbose, thinking, reasoning, ttsAuto)
    // so the user doesn't have to re-enable them every time.
    if (resetTriggered && existingSessionEntry) {
      persistedThinking = existingSessionEntry.thinkingLevel;
      persistedVerbose = existingSessionEntry.verboseLevel;
      persistedReasoning = existingSessionEntry.reasoningLevel;
      persistedTtsAuto = existingSessionEntry.ttsAuto;
      persistedModelOverride = existingSessionEntry.modelOverride;
      persistedProviderOverride = existingSessionEntry.providerOverride;
      persistedLabel = existingSessionEntry.label;
    }
  }

  const baseEntry = !isNewSession && freshEntry ? existingSessionEntry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const originatingChannelRaw = ctx.OriginatingChannel as string | undefined;
  const originatingChannel = normalizeMessageChannel(originatingChannelRaw);
  const preservePersistedDeliveryRoute =
    originatingChannel === INTERNAL_MESSAGE_CHANNEL ||
    originatingChannel === CONTROL_UI_MESSAGE_CHANNEL;
  const lastChannelRaw = resolveLastChannelRaw({
    originatingChannelRaw,
    persistedLastChannel: baseEntry?.lastChannel ?? baseEntry?.deliveryContext?.channel,
    sessionKey,
  });
  const lastToRaw = preservePersistedDeliveryRoute
    ? (baseEntry?.lastTo ?? baseEntry?.deliveryContext?.to)
    : ctx.OriginatingTo || ctx.To || baseEntry?.lastTo || baseEntry?.deliveryContext?.to;
  const lastAccountIdRaw = preservePersistedDeliveryRoute
    ? (baseEntry?.lastAccountId ?? baseEntry?.deliveryContext?.accountId)
    : ctx.AccountId || baseEntry?.lastAccountId || baseEntry?.deliveryContext?.accountId;
  // Only fall back to persisted threadId for thread sessions.  Non-thread
  // sessions (e.g. DM without topics) must not inherit a stale threadId from a
  // previous interaction that happened inside a topic/thread.
  // Internal and Control UI turns are not delivery sources, so they preserve
  // the existing route atomically, including a thread target on a main session.
  const lastThreadIdRaw = preservePersistedDeliveryRoute
    ? (baseEntry?.lastThreadId ?? baseEntry?.deliveryContext?.threadId)
    : ctx.MessageThreadId || (isThread ? baseEntry?.lastThreadId : undefined);
  const deliveryFields = normalizeSessionDeliveryFields({
    lastChannel: lastChannelRaw,
    lastTo: lastToRaw,
    lastAccountId: lastAccountIdRaw,
    lastThreadId: lastThreadIdRaw,
    deliveryContext: baseEntry?.deliveryContext
      ? {
          ...baseEntry.deliveryContext,
          threadId:
            preservePersistedDeliveryRoute || isThread
              ? baseEntry.deliveryContext.threadId
              : undefined,
        }
      : undefined,
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
  const lastThreadId = deliveryFields.lastThreadId ?? lastThreadIdRaw;
  sessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    systemSent,
    abortedLastRun,
    // Persist previously stored thinking/verbose levels when present.
    thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
    verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    reasoningLevel: persistedReasoning ?? baseEntry?.reasoningLevel,
    ttsAuto: persistedTtsAuto ?? baseEntry?.ttsAuto,
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
    label: persistedLabel ?? baseEntry?.label,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: baseEntry?.displayName,
    chatType: baseEntry?.chatType,
    channel: baseEntry?.channel,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    deliveryContext: deliveryFields.deliveryContext,
    // Track originating channel for subagent announce routing.
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = ctx.ThreadLabel?.trim();
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = ctx.ParentSessionKey?.trim();
  const alreadyForked = sessionEntry.forkedFromParent === true;
  if (
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey] &&
    !alreadyForked
  ) {
    log.warn(
      `forking from parent session: parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
        `parentTokens=${sessionStore[parentSessionKey].totalTokens ?? "?"}`,
    );
    const forked = forkSessionFromParent({
      parentEntry: sessionStore[parentSessionKey],
      agentId,
      sessionsDir: path.dirname(storePath),
    });
    if (forked) {
      sessionId = forked.sessionId;
      sessionEntry.sessionId = forked.sessionId;
      sessionEntry.sessionFile = forked.sessionFile;
      sessionEntry.forkedFromParent = true;
      log.warn(`forked session created: file=${forked.sessionFile}`);
    }
  }
  const fallbackSessionFile = !sessionEntry.sessionFile
    ? resolveSessionTranscriptPath(sessionEntry.sessionId, agentId, ctx.MessageThreadId)
    : undefined;
  const resolvedSessionFile = await resolveAndPersistSessionFile({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionEntry,
    agentId,
    sessionsDir: path.dirname(storePath),
    fallbackSessionFile,
    activeSessionKey: sessionKey,
  });
  sessionEntry = resolvedSessionFile.sessionEntry;
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
    sessionEntry.recentMediaSnapshot = undefined;
    // Clear transient behavior controls so /new returns to configured defaults.
    sessionEntry.thinkingLevel = undefined;
    sessionEntry.reasoningLevel = undefined;
    sessionEntry.responseUsage = undefined;
    // Clear stale token metrics from previous session so /status doesn't
    // display the old session's context usage after /new.
    sessionEntry.totalTokens = undefined;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.contextTokens = undefined;
  }

  const inboundRecentMediaSnapshot = buildRecentImageSnapshot(ctx);
  if (inboundRecentMediaSnapshot) {
    sessionEntry.recentMediaSnapshot = inboundRecentMediaSnapshot;
  } else {
    const recentMediaSnapshotForAttach =
      sessionEntry.recentMediaSnapshot ?? storedRecentMediaSnapshot;
    if (shouldAttachRecentImageSnapshot({ ctx, snapshot: recentMediaSnapshotForAttach })) {
      sessionEntry.recentMediaSnapshot = attachRecentImageSnapshot({
        ctx,
        snapshot: recentMediaSnapshotForAttach!,
      });
    }
  }
  sessionEntry.pendingRecentMediaSnapshotInit = undefined;

  // Persist the reset session state while keeping stable routing metadata.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(
    storePath,
    (store) => {
      // Persist the reset session state while keeping stable routing metadata.
      store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
    },
    {
      activeSessionKey: sessionKey,
      onWarn: (warning) =>
        deliverSessionMaintenanceWarning({
          cfg,
          sessionKey,
          entry: sessionEntry,
          warning,
        }),
    },
  );
  const endedSessionEntry =
    isNewSession && existingSessionEntry ? { ...existingSessionEntry } : undefined;

  const sessionCtx: TemplateContext = {
    ...ctx,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: normalizeInboundTextNewlines(
      bodyStripped ??
        ctx.BodyForAgent ??
        ctx.Body ??
        ctx.CommandBody ??
        ctx.RawBody ??
        ctx.BodyForCommands ??
        "",
    ),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  const effectiveSessionId = sessionId ?? "";
  const effectiveAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const replacedSessionEntry =
    isNewSession &&
    endedSessionEntry?.sessionId &&
    endedSessionEntry.sessionId !== effectiveSessionId
      ? endedSessionEntry
      : undefined;
  let transcriptArchived = false;

  // Archive old transcript so it doesn't accumulate on disk (#14869).
  if (replacedSessionEntry) {
    const archived = archiveSessionTranscripts({
      sessionId: replacedSessionEntry.sessionId,
      storePath,
      sessionFile: replacedSessionEntry.sessionFile,
      agentId,
      reason: "reset",
    });
    transcriptArchived = archived.length > 0;
  }

  const shouldCaptureDailyRollover =
    !resetTriggered &&
    Boolean(replacedSessionEntry) &&
    shouldCaptureDailyMemoryForExistingSession &&
    replacedSessionEntry?.dailyMemoryCaptureSessionId !== replacedSessionEntry?.sessionId &&
    resolveHookConfig(cfg, "session-memory")?.enabled !== false;

  const markedDailyRolloverCapturePending =
    shouldCaptureDailyRollover && replacedSessionEntry?.sessionId
      ? await markDailyMemoryCapturePending({
          storePath,
          sessionKey,
          sourceSessionId: replacedSessionEntry.sessionId,
          targetSessionId: effectiveSessionId,
        })
      : false;

  if (markedDailyRolloverCapturePending && replacedSessionEntry) {
    const dailyRolloverEntry = replacedSessionEntry;
    void (async () => {
      let completed = false;
      try {
        const result = await captureSessionToMemory({
          cfg,
          sessionKey,
          sessionId: dailyRolloverEntry.sessionId,
          sessionFile: dailyRolloverEntry.sessionFile,
          source: "daily-rollover",
          timestamp: new Date(now),
        });
        completed = Boolean(result && result.status !== "skipped-missing-source");
      } catch (err) {
        log.warn(`failed to capture daily rollover memory: ${String(err)}`);
      } finally {
        await finishDailyMemoryCapture({
          storePath,
          sessionKey,
          sourceSessionId: dailyRolloverEntry.sessionId,
          targetSessionId: effectiveSessionId,
          completed,
        });
      }
    })();
  }

  const shouldCaptureDailyMemoryInPlace =
    !replacedSessionEntry && shouldCaptureDailyMemoryForExistingSession && existingSessionEntry;
  const markedInPlaceDailyCapturePending =
    shouldCaptureDailyMemoryInPlace && existingSessionEntry?.sessionId
      ? await markDailyMemoryCapturePending({
          storePath,
          sessionKey,
          sourceSessionId: existingSessionEntry.sessionId,
          targetSessionId: effectiveSessionId,
        })
      : false;

  if (markedInPlaceDailyCapturePending && existingSessionEntry) {
    const dailyMemoryEntry = {
      ...existingSessionEntry,
      sessionFile: sessionEntry.sessionFile ?? existingSessionEntry.sessionFile,
    };
    void (async () => {
      let completed = false;
      try {
        const result = await captureSessionToMemory({
          cfg,
          sessionKey,
          sessionId: dailyMemoryEntry.sessionId,
          sessionFile: dailyMemoryEntry.sessionFile,
          source: "daily-rollover",
          timestamp: new Date(now),
        });
        completed = Boolean(result && result.status !== "skipped-missing-source");
      } catch (err) {
        log.warn(`failed to capture daily memory: ${String(err)}`);
      } finally {
        await finishDailyMemoryCapture({
          storePath,
          sessionKey,
          sourceSessionId: dailyMemoryEntry.sessionId,
          targetSessionId: effectiveSessionId,
          completed,
        });
      }
    })();
  }

  // Run session plugin hooks (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isNewSession) {
    // If replacing an existing session, fire session_end for the old one
    if (replacedSessionEntry) {
      if (hookRunner.hasHooks("session_end")) {
        void hookRunner
          .runSessionEnd(
            {
              sessionId: replacedSessionEntry.sessionId,
              sessionKey,
              messageCount: 0,
              reason: endedSessionReason,
              sessionFile: replacedSessionEntry.sessionFile,
              transcriptArchived,
              nextSessionId: effectiveSessionId,
            },
            {
              sessionId: replacedSessionEntry.sessionId,
              sessionKey,
              agentId: effectiveAgentId,
            },
          )
          .catch(() => {});
      }
    }

    // Fire session_start for the new session
    if (hookRunner.hasHooks("session_start")) {
      void hookRunner
        .runSessionStart(
          {
            sessionId: effectiveSessionId,
            sessionKey,
            resumedFrom: endedSessionEntry?.sessionId,
          },
          {
            sessionId: effectiveSessionId,
            sessionKey,
            agentId: effectiveAgentId,
          },
        )
        .catch(() => {});
    }
  }

  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionId ?? crypto.randomUUID(),
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
  };
}
