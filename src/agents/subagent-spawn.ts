import crypto from "node:crypto";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveAgentDir } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSubagentAllowlist } from "./subagent-allowlist.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import { dispatchTaskFlowCommitHook } from "./taskflow/store-hook.js";
import { createTaskFlowStore } from "./taskflow/store.js";
import type { TaskFlowAccess } from "./taskflow/types.js";
import { readStringParam } from "./tools/common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";
import {
  getCurrentAgentTraceParent,
  getCurrentToolTraceParent,
  recordSubagentLifecycleTraceEvent,
} from "./tracing/context.js";

export const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];
export const SUBAGENT_COMPLETION_DELIVERIES = ["auto", "parent", "direct"] as const;
export type SubagentCompletionDelivery = (typeof SUBAGENT_COMPLETION_DELIVERIES)[number];
export const SUBAGENT_TASKFLOW_TRACKING_MODES = ["auto", "current", "none"] as const;
export type SubagentTaskFlowTrackingMode = (typeof SUBAGENT_TASKFLOW_TRACKING_MODES)[number];

const SHARED_TASKFLOW_RUN_GRANT_TTL_BUFFER_MS = 5 * 60_000;
const SHARED_TASKFLOW_RUN_GRANT_DEFAULT_TTL_MS = 24 * 60 * 60_000;

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  completionDelivery?: SubagentCompletionDelivery;
  taskFlowId?: string;
  taskFlowAccess?: TaskFlowAccess;
  taskFlowScope?: "shared";
  taskFlowTracking?: SubagentTaskFlowTrackingMode;
  toolCallId?: string;
};

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  requesterAgentIdOverride?: string;
  inheritedModel?: string;
};

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "auto-announces on completion, do not poll/sleep. Completion may be delivered directly to the bound channel instead of appearing as a parent user message.";
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  note?: string;
  modelApplied?: boolean;
  error?: string;
};

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnSubagentMode;
  threadRequested: boolean;
}): SpawnSubagentMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveSubagentSessionLabel(params: {
  displayLabel: string;
  childSessionKey: string;
}): string | undefined {
  const displayLabel = params.displayLabel.trim();
  if (!displayLabel) {
    return undefined;
  }

  const rawSuffix = params.childSessionKey.split(":").pop()?.trim() || crypto.randomUUID();
  const suffix =
    rawSuffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8) || crypto.randomUUID().slice(0, 8);
  const maxDisplayLength = Math.max(1, SESSION_LABEL_MAX_LENGTH - suffix.length - 1);
  const safeDisplayLabel =
    displayLabel.length > maxDisplayLength
      ? displayLabel.slice(0, maxDisplayLength).trimEnd()
      : displayLabel;

  return `${safeDisplayLabel || "subagent"}:${suffix}`;
}

async function ensureThreadBindingForSubagentSpawn(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<{ status: "ok" } | { status: "error"; error: string }> {
  const hookRunner = params.hookRunner;
  if (!hookRunner?.hasHooks("subagent_spawning")) {
    return {
      status: "error",
      error:
        "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.",
    };
  }

  try {
    const result = await hookRunner.runSubagentSpawning(
      {
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        label: params.label,
        mode: params.mode,
        requester: params.requester,
        threadRequested: true,
      },
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    if (result?.status === "error") {
      const error = result.error.trim();
      return {
        status: "error",
        error: error || "Failed to prepare thread binding for this subagent session.",
      };
    }
    if (result?.status !== "ok" || !result.threadBindingReady) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      error: `Thread bind failed: ${summarizeError(err)}`,
    };
  }
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId;
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const requestThreadBinding = params.thread === true;
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return {
      status: "error",
      error: 'mode="session" requires thread=true so the subagent can stay bound to a thread.',
    };
  }
  const cleanup =
    spawnMode === "session"
      ? "keep"
      : params.cleanup === "keep" || params.cleanup === "delete"
        ? params.cleanup
        : "keep";
  const expectsCompletionMessage = params.expectsCompletionMessage !== false;
  const completionDelivery =
    params.completionDelivery === "parent" || params.completionDelivery === "direct"
      ? params.completionDelivery
      : undefined;
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  const hookRunner = getGlobalHookRunner();
  const runTimeoutSeconds =
    typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.runTimeoutSeconds))
      : 0;
  let modelApplied = false;
  let threadBindingReady = false;

  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const requesterIsWebChatSession =
    requesterInternalKey.includes(":webchat:") ||
    requesterOrigin?.channel?.trim().toLowerCase() === "webchat";
  if (
    completionDelivery === "direct" &&
    callerDepth < 1 &&
    !requesterIsWebChatSession &&
    (!requesterOrigin?.channel ||
      !isDeliverableMessageChannel(requesterOrigin.channel) ||
      !requesterOrigin.to)
  ) {
    return {
      status: "error",
      error:
        'completionDelivery="direct" requires a deliverable agentChannel and agentTo in the current tool context.',
    };
  }
  const maxSpawnDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  if (targetAgentId !== requesterAgentId) {
    const { allowAny, allowSet } = resolveSubagentAllowlist(cfg, requesterAgentId);
    const normalizedTargetId = targetAgentId.toLowerCase();
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      const allowedText = allowSet.size > 0 ? Array.from(allowSet).join(", ") : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const sessionLabel = resolveSubagentSessionLabel({
    displayLabel: label,
    childSessionKey,
  });
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const normalizedTaskFlowId = params.taskFlowId?.trim();
  const hasSharedTaskFlowParams = Boolean(
    normalizedTaskFlowId || params.taskFlowScope || params.taskFlowAccess,
  );
  if (hasSharedTaskFlowParams && (!normalizedTaskFlowId || params.taskFlowScope !== "shared")) {
    return {
      status: "error",
      error: 'Shared TaskFlow access requires taskFlowId and taskFlowScope="shared".',
    };
  }
  const sharedTaskFlowId = normalizedTaskFlowId;
  const requestedTaskFlowTracking =
    params.taskFlowTracking === "auto" ||
    params.taskFlowTracking === "current" ||
    params.taskFlowTracking === "none"
      ? params.taskFlowTracking
      : undefined;
  if (
    requestedTaskFlowTracking &&
    requestedTaskFlowTracking !== "none" &&
    hasSharedTaskFlowParams
  ) {
    return {
      status: "error",
      error: "taskFlowTracking cannot be combined with shared TaskFlow parameters.",
    };
  }
  const taskFlowTracking =
    requestedTaskFlowTracking ??
    (spawnMode === "run" && !hasSharedTaskFlowParams ? "auto" : "none");
  const shouldTrackCurrentTaskFlow =
    taskFlowTracking === "current" || (taskFlowTracking === "auto" && spawnMode === "run");
  const sharedTaskFlowAccess = params.taskFlowAccess ?? "write_assigned";
  const sharedTaskFlowGrantExpiresAt =
    sharedTaskFlowId && spawnMode !== "session"
      ? new Date(
          Date.now() +
            (runTimeoutSeconds > 0
              ? runTimeoutSeconds * 1000 + SHARED_TASKFLOW_RUN_GRANT_TTL_BUFFER_MS
              : SHARED_TASKFLOW_RUN_GRANT_DEFAULT_TTL_MS),
        ).toISOString()
      : undefined;
  const ownerAgentDir =
    sharedTaskFlowId || shouldTrackCurrentTaskFlow
      ? resolveAgentDir(cfg, requesterAgentId)
      : undefined;
  const ownerTaskFlowStore = ownerAgentDir
    ? createTaskFlowStore({ agentDir: ownerAgentDir, onCommitted: dispatchTaskFlowCommitHook })
    : undefined;
  let trackingTaskFlowId: string | undefined;
  if (shouldTrackCurrentTaskFlow) {
    const tracked = await ownerTaskFlowStore?.readTaskFlow({
      agentId: requesterAgentId,
      sessionKey: requesterInternalKey,
    });
    if (tracked?.status === "success") {
      trackingTaskFlowId = tracked.snapshot.id;
    } else if (taskFlowTracking === "current") {
      return {
        status: "error",
        error: 'taskFlowTracking="current" requires an active or blocked foreground TaskFlow.',
      };
    } else if (tracked && tracked.code !== "not_found") {
      return {
        status: "error",
        error: `Unable to resolve the current TaskFlow: ${tracked.message}`,
      };
    }
  }
  let sharedTaskFlowGrantCreated = false;
  let lifecycleStarted = false;
  let lifecycleEnded = false;
  const emitLifecycleSpawning = async () => {
    if (lifecycleStarted) {
      return;
    }
    lifecycleStarted = true;
    await recordSubagentLifecycleTraceEvent({
      phase: "spawning",
      childSessionKey,
      requesterSessionKey: requesterInternalKey,
      agentId: targetAgentId,
      label: label || undefined,
      mode: spawnMode,
    });
  };
  const emitLifecycleEndedError = async (params: { runId?: string; error: string }) => {
    if (!lifecycleStarted || lifecycleEnded) {
      return;
    }
    lifecycleEnded = true;
    await recordSubagentLifecycleTraceEvent({
      phase: "ended",
      runId: params.runId,
      childSessionKey,
      requesterSessionKey: requesterInternalKey,
      agentId: targetAgentId,
      label: label || undefined,
      mode: spawnMode,
      outcome: "error",
      error: params.error,
    });
  };
  const deleteProvisionalChildSession = async (emitLifecycleHooks: boolean) => {
    try {
      await callGateway({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort cleanup only.
    }
  };
  const revokeSharedTaskFlowGrant = async () => {
    if (!sharedTaskFlowId || !sharedTaskFlowGrantCreated || !ownerTaskFlowStore) {
      return;
    }
    try {
      await ownerTaskFlowStore.revokeAccessForSession({
        taskFlowId: sharedTaskFlowId,
        targetSessionKey: childSessionKey,
        requesterSessionKey: requesterInternalKey,
        revokeReason: "subagent_ended",
      });
    } catch {
      // Best-effort cleanup only.
    }
  };
  await emitLifecycleSpawning();
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg,
    agentId: targetAgentId,
    modelOverride,
    inheritedModel: targetAgentId === requesterAgentId ? ctx.inheritedModel : undefined,
  });

  const resolvedThinkingDefaultRaw =
    readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
    readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

  let thinkingOverride: string | undefined;
  const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (thinkingCandidateRaw) {
    const normalized = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalized) {
      const { provider, model } = splitModelRef(resolvedModel);
      const hint = formatThinkingLevels(provider, model);
      const error = `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`;
      await emitLifecycleEndedError({ error });
      return {
        status: "error",
        error,
      };
    }
    thinkingOverride = normalized;
  }
  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, spawnDepth: childDepth },
      timeoutMs: 10_000,
    });
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    await emitLifecycleEndedError({ error: messageText });
    return {
      status: "error",
      error: messageText,
      childSessionKey,
    };
  }

  if (resolvedModel) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model: resolvedModel },
        timeoutMs: 10_000,
      });
      modelApplied = true;
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      await emitLifecycleEndedError({ error: messageText });
      return {
        status: "error",
        error: messageText,
        childSessionKey,
      };
    }
  }
  if (thinkingOverride !== undefined) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: {
          key: childSessionKey,
          thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
        },
        timeoutMs: 10_000,
      });
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      await emitLifecycleEndedError({ error: messageText });
      return {
        status: "error",
        error: messageText,
        childSessionKey,
      };
    }
  }
  if (requestThreadBinding) {
    const bindResult = await ensureThreadBindingForSubagentSpawn({
      hookRunner,
      childSessionKey,
      agentId: targetAgentId,
      label: label || undefined,
      mode: spawnMode,
      requesterSessionKey: requesterInternalKey,
      requester: {
        channel: requesterOrigin?.channel,
        accountId: requesterOrigin?.accountId,
        to: requesterOrigin?.to,
        threadId: requesterOrigin?.threadId,
      },
    });
    if (bindResult.status === "error") {
      await deleteProvisionalChildSession(false);
      await emitLifecycleEndedError({ error: bindResult.error });
      return {
        status: "error",
        error: bindResult.error,
        childSessionKey,
      };
    }
    threadBindingReady = true;
  }
  if (sharedTaskFlowId) {
    const grantResult = await ownerTaskFlowStore?.grantAccess({
      agentId: requesterAgentId,
      sessionKey: requesterInternalKey,
      taskFlowId: sharedTaskFlowId,
      targetSessionKey: childSessionKey,
      access: sharedTaskFlowAccess,
      expiresAt: sharedTaskFlowGrantExpiresAt,
    });
    if (grantResult?.status !== "success") {
      const error =
        grantResult?.status === "error"
          ? grantResult.message
          : `Unable to grant shared TaskFlow access: ${grantResult?.code ?? "error"}`;
      await deleteProvisionalChildSession(false);
      await emitLifecycleEndedError({ error });
      return {
        status: "error",
        error,
        childSessionKey,
      };
    }
    sharedTaskFlowGrantCreated = true;
  }
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    childDepth,
    maxSpawnDepth,
  });
  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    spawnMode === "session"
      ? "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages."
      : undefined,
    sharedTaskFlowId
      ? `[TaskFlow Context]\ntaskFlowId=${sharedTaskFlowId}\naccess=${sharedTaskFlowAccess}\nUse taskflow_read before modifying shared state.\nUse taskflow_update with expectedRevision when status changes.`
      : undefined,
    `[Subagent Task]: ${task}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: childTaskMessage,
        sessionKey: childSessionKey,
        channel: requesterOrigin?.channel,
        to: requesterOrigin?.to ?? undefined,
        accountId: requesterOrigin?.accountId ?? undefined,
        threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: requesterInternalKey,
          sourceChannel: requesterOrigin?.channel,
          sourceTool: "sessions_spawn",
        },
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: sessionLabel,
        spawnedBy: spawnedByKey,
        groupId: ctx.agentGroupId ?? undefined,
        groupChannel: ctx.agentGroupChannel ?? undefined,
        groupSpace: ctx.agentGroupSpace ?? undefined,
        traceParent: getCurrentToolTraceParent() ?? getCurrentAgentTraceParent(),
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch (err) {
    await emitLifecycleEndedError({ runId: childRunId, error: "Session failed to start" });
    await revokeSharedTaskFlowGrant();
    if (threadBindingReady) {
      const hasEndedHook = hookRunner?.hasHooks("subagent_ended") === true;
      let endedHookEmitted = false;
      if (hasEndedHook) {
        try {
          await hookRunner?.runSubagentEnded(
            {
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              reason: "spawn-failed",
              sendFarewell: true,
              accountId: requesterOrigin?.accountId,
              runId: childRunId,
              outcome: "error",
              error: "Session failed to start",
            },
            {
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
            },
          );
          endedHookEmitted = true;
        } catch {
          // Spawn should still return an actionable error even if cleanup hooks fail.
        }
      }
      // Always delete the provisional child session after a failed spawn attempt.
      // If we already emitted subagent_ended above, suppress a duplicate lifecycle hook.
      await deleteProvisionalChildSession(!endedHookEmitted);
    } else {
      await deleteProvisionalChildSession(true);
    }
    const messageText = summarizeError(err);
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      runId: childRunId,
    };
  }

  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    requesterDisplayKey,
    task,
    cleanup,
    label: label || undefined,
    sessionLabel,
    model: resolvedModel,
    runTimeoutSeconds,
    expectsCompletionMessage,
    completionDelivery,
    spawnMode,
    taskFlowId: sharedTaskFlowId,
    trackingTaskFlowId,
    sourceToolCallId: params.toolCallId,
  });

  if (hookRunner?.hasHooks("subagent_spawned")) {
    try {
      await hookRunner.runSubagentSpawned(
        {
          runId: childRunId,
          childSessionKey,
          agentId: targetAgentId,
          label: label || undefined,
          requester: {
            channel: requesterOrigin?.channel,
            accountId: requesterOrigin?.accountId,
            to: requesterOrigin?.to,
            threadId: requesterOrigin?.threadId,
          },
          threadRequested: requestThreadBinding,
          mode: spawnMode,
        },
        {
          runId: childRunId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
        },
      );
    } catch {
      // Spawn should still return accepted if spawn lifecycle hooks fail.
    }
  }
  await recordSubagentLifecycleTraceEvent({
    phase: "spawned",
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    agentId: targetAgentId,
    label: label || undefined,
    mode: spawnMode,
  });

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    mode: spawnMode,
    note:
      spawnMode === "session" ? SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE : SUBAGENT_SPAWN_ACCEPTED_NOTE,
    modelApplied: resolvedModel ? modelApplied : undefined,
  };
}
