import type { PropagateAttributesParams } from "@langfuse/tracing";
import type {
  AgentTraceSubagentLifecycleEvent,
  AgentTraceGenerationEndEvent,
  AgentTraceRunEndEvent,
  AgentTraceRunHandle,
  AgentTraceRunStartEvent,
  AgentTraceSink,
  AgentTraceToolEndEvent,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import {
  captureGenerationEnd,
  captureGenerationStart,
  captureRunEnd,
  captureSpan,
  captureToolEnd,
  captureToolStart,
} from "./capture.js";
import {
  createDefaultLangfuseClient,
  type LangfuseClientFactory,
  type LangfuseTraceClient,
} from "./client.js";
import { resolveLangfuseConfig, type ResolvedLangfuseConfig } from "./config.js";

type DiagnosticsLangfuseRuntimeOptions = {
  clientFactory?: LangfuseClientFactory;
};

type RuntimeState = {
  config?: ResolvedLangfuseConfig;
  client?: LangfuseTraceClient;
};

type TraceSearchMetadata = Record<string, unknown> & {
  subagentIds?: string[];
  subagentSessionKeys?: string[];
  searchTerms?: string[];
};

const PROPAGATED_ATTRIBUTE_MAX_LENGTH = 200;
const PROPAGATED_SEARCH_TERM_LIMIT = 20;

function dateFromMs(value: number | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}

function normalizeSpanId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{16}$/.test(normalized) ? normalized : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function appendUnique(list: string[] | undefined, value: string | undefined): string[] | undefined {
  if (!value) {
    return list;
  }
  const next = list ? [...list] : [];
  if (!next.includes(value)) {
    next.push(value);
  }
  return next;
}

function compactMetadata(metadata: TraceSearchMetadata): TraceSearchMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => {
      if (value == null) {
        return false;
      }
      return !(Array.isArray(value) && value.length === 0);
    }),
  ) as TraceSearchMetadata;
}

function truncatePropagatedString(
  value: string,
  maxLength = PROPAGATED_ATTRIBUTE_MAX_LENGTH,
): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function propagatedString(
  value: unknown,
  maxLength = PROPAGATED_ATTRIBUTE_MAX_LENGTH,
): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeString(value);
    return normalized ? truncatePropagatedString(normalized, maxLength) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => normalizeString(item))
      .filter((item): item is string => Boolean(item))
      .join(" ");
    return joined ? truncatePropagatedString(joined, maxLength) : undefined;
  }
  return undefined;
}

function joinPropagatedTerms(terms: string[]): string | undefined {
  const output: string[] = [];
  let length = 0;
  for (const term of terms) {
    const nextLength = length + term.length + (output.length > 0 ? 1 : 0);
    if (nextLength > PROPAGATED_ATTRIBUTE_MAX_LENGTH) {
      continue;
    }
    output.push(term);
    length = nextLength;
  }
  return output.length > 0 ? output.join(" ") : undefined;
}

function propagatedMetadata(metadata: TraceSearchMetadata): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(compactMetadata(metadata))) {
    if (key === "searchTerms" && Array.isArray(value)) {
      const terms = value
        .map((item) => normalizeString(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, PROPAGATED_SEARCH_TERM_LIMIT);
      const propagated = joinPropagatedTerms(terms);
      if (propagated) {
        output[key] = propagated;
      }
      terms.forEach((term, index) => {
        const propagatedTerm = propagatedString(term);
        if (propagatedTerm) {
          output[`searchTerm${index}`] = propagatedTerm;
        }
      });
      continue;
    }
    const propagated = propagatedString(value);
    if (propagated) {
      output[key] = propagated;
    }
  }
  return output;
}

function isHeartbeatRun(event: AgentTraceRunStartEvent): boolean {
  return event.channel === "heartbeat" || event.messageProvider === "heartbeat";
}

function runMetadata(event: AgentTraceRunStartEvent, config: ResolvedLangfuseConfig) {
  if (config.captureMode === "safe") {
    return {
      serviceName: config.serviceName,
      channel: event.channel,
      messageProvider: event.messageProvider,
      lane: event.lane,
      provider: event.provider,
      model: event.model,
      inputProvenanceKind: event.inputProvenance?.kind,
      inputProvenanceSourceChannel: event.inputProvenance?.sourceChannel,
      inputProvenanceSourceTool: event.inputProvenance?.sourceTool,
    };
  }
  return {
    serviceName: config.serviceName,
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    agentId: event.agentId,
    channel: event.channel,
    messageProvider: event.messageProvider,
    lane: event.lane,
    provider: event.provider,
    model: event.model,
    workspaceDir: event.workspaceDir,
    spawnedBy: event.spawnedBy,
    senderId: event.senderId,
    inputProvenanceKind: event.inputProvenance?.kind,
    inputProvenanceSourceSessionKey: event.inputProvenance?.sourceSessionKey,
    inputProvenanceSourceChannel: event.inputProvenance?.sourceChannel,
    inputProvenanceSourceTool: event.inputProvenance?.sourceTool,
    parentRunId: event.traceParent?.parentRunId,
    parentTraceId: event.traceParent?.parentTraceId,
    parentSessionKey: event.traceParent?.parentSessionKey,
    ...event.metadata,
  };
}

function resolveTraceUserId(event: AgentTraceRunStartEvent): string | undefined {
  return (
    normalizeString(event.senderId) ??
    normalizeString(event.metadata?.senderId) ??
    normalizeString(event.metadata?.userId)
  );
}

function buildTraceName(event: AgentTraceRunStartEvent, config: ResolvedLangfuseConfig): string {
  if (config.captureMode === "safe") {
    return "openclaw.agent.run";
  }
  const parts = [
    "openclaw.agent.run",
    normalizeString(event.agentId),
    normalizeString(event.channel ?? event.messageProvider),
  ];
  return parts.filter(Boolean).join(" ");
}

function buildTraceMetadata(event: AgentTraceRunStartEvent, config: ResolvedLangfuseConfig) {
  if (config.captureMode === "safe") {
    return compactMetadata(runMetadata(event, config) as TraceSearchMetadata);
  }
  const metadata: TraceSearchMetadata = {
    serviceName: config.serviceName,
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    agentId: event.agentId,
    channel: event.channel,
    messageProvider: event.messageProvider,
    lane: event.lane,
    provider: event.provider,
    model: event.model,
    senderId: resolveTraceUserId(event),
    parentRunId: event.traceParent?.parentRunId,
    parentTraceId: event.traceParent?.parentTraceId,
    parentSessionKey: event.traceParent?.parentSessionKey,
  };
  const searchTerms: string[] = [];
  for (const value of [
    metadata.runId,
    metadata.sessionId,
    metadata.sessionKey,
    metadata.agentId,
    metadata.channel,
    metadata.messageProvider,
    metadata.senderId,
    metadata.parentRunId,
    metadata.parentTraceId,
    metadata.parentSessionKey,
  ]) {
    const normalized = normalizeString(value);
    if (normalized && !searchTerms.includes(normalized)) {
      searchTerms.push(normalized);
    }
  }
  return compactMetadata({
    ...metadata,
    searchTerms,
  });
}

function buildRunPropagation(
  event: AgentTraceRunStartEvent,
  config: ResolvedLangfuseConfig,
  metadata: TraceSearchMetadata,
  options: { inheritedTrace?: boolean } = {},
): PropagateAttributesParams {
  const traceName = propagatedString(buildTraceName(event, config)) ?? "openclaw.agent.run";
  if (options.inheritedTrace) {
    return {
      traceName: "openclaw.agent.run",
    };
  }
  const propagation: PropagateAttributesParams = {
    traceName,
    metadata: propagatedMetadata(metadata),
  };
  if (config.captureMode === "safe") {
    return propagation;
  }
  const userId = propagatedString(resolveTraceUserId(event));
  if (userId) {
    propagation.userId = userId;
  }
  const sessionId = propagatedString(event.sessionId);
  if (sessionId) {
    propagation.sessionId = sessionId;
  }
  return propagation;
}

function buildRootObservationName(
  event: AgentTraceRunStartEvent,
  config: ResolvedLangfuseConfig,
  options: { inheritedTrace?: boolean } = {},
): string {
  if (options.inheritedTrace) {
    return "openclaw.agent.run";
  }
  return propagatedString(buildTraceName(event, config)) ?? "openclaw.agent.run";
}

function subagentSearchMetadata(event: AgentTraceSubagentLifecycleEvent): TraceSearchMetadata {
  const subagentId = normalizeString(event.agentId);
  const childSessionKey = normalizeString(event.childSessionKey);
  const searchTerms: string[] = [];
  for (const value of [subagentId, childSessionKey]) {
    if (value && !searchTerms.includes(value)) {
      searchTerms.push(value);
    }
  }
  return compactMetadata({
    subagentId,
    subagentSessionKey: childSessionKey,
    subagentIds: subagentId ? [subagentId] : undefined,
    subagentSessionKeys: childSessionKey ? [childSessionKey] : undefined,
    searchTerms,
  });
}

function subagentLifecycleMetadata(
  event: AgentTraceSubagentLifecycleEvent,
  config: ResolvedLangfuseConfig,
): Record<string, unknown> {
  if (config.captureMode === "safe") {
    return {
      phase: event.phase,
      label: event.label,
      mode: event.mode,
      outcome: event.outcome,
      error: event.error,
    };
  }
  return {
    ...event,
    ...subagentSearchMetadata(event),
  };
}

function createLangfuseSink(state: RuntimeState): AgentTraceSink {
  return {
    async startRun(event): Promise<AgentTraceRunHandle | void> {
      const config = state.config;
      const client = state.client;
      if (!config || !client) {
        return undefined;
      }
      if (isHeartbeatRun(event)) {
        return undefined;
      }
      const parentTraceId = event.traceParent?.parentTraceId;
      const parentSpanId = normalizeSpanId(event.traceParent?.parentObservationId);
      const parentSpanContext =
        parentTraceId && parentSpanId
          ? { traceId: parentTraceId, spanId: parentSpanId, traceFlags: 1 }
          : undefined;
      const traceId = parentSpanContext?.traceId ?? (await client.createTraceId(event.runId));
      const traceMetadata = buildTraceMetadata(event, config);
      const currentRunPropagation = () =>
        buildRunPropagation(event, config, traceMetadata, {
          inheritedTrace: Boolean(parentSpanContext),
        });
      const rootObservationName = buildRootObservationName(event, config, {
        inheritedTrace: Boolean(parentSpanContext),
      });
      const root = client.propagateAttributes(currentRunPropagation(), () =>
        client.startObservation(
          rootObservationName,
          {
            metadata: runMetadata(event, config),
          },
          {
            asType: "agent",
            startTime: dateFromMs(event.startedAt),
            ...(parentSpanContext ? { parentSpanContext } : {}),
          },
        ),
      );
      const actualTraceId = root.traceId ?? traceId;

      return {
        traceParent: {
          parentTraceId: actualTraceId,
          parentRunId: event.runId,
          parentSessionKey: event.sessionKey,
          parentObservationId: root.id,
        },
        startGeneration(generationEvent) {
          const generation = client.propagateAttributes(currentRunPropagation(), () =>
            root.startObservation?.(
              "openclaw.llm.generation",
              captureGenerationStart(generationEvent, config.captureMode) as Record<
                string,
                unknown
              >,
              {
                asType: "generation",
                startTime: dateFromMs(generationEvent.startedAt),
              },
            ),
          );
          if (!generation) {
            return undefined;
          }
          return {
            end(endEvent) {
              generation.update?.(
                captureGenerationEnd(
                  endEvent as AgentTraceGenerationEndEvent,
                  config.captureMode,
                ) as Record<string, unknown>,
              );
              generation.end?.(dateFromMs(endEvent.endedAt));
            },
          };
        },
        startTool(toolEvent) {
          const toolName = toolEvent.toolName.replace(/[^A-Za-z0-9_.-]/g, "_");
          const skillName = toolEvent.skillName?.replace(/[^A-Za-z0-9_.-]/g, "_");
          const observationName = skillName
            ? `openclaw.skill.${skillName}`
            : `openclaw.tool.${toolName}`;
          const tool = client.propagateAttributes(currentRunPropagation(), () =>
            root.startObservation?.(
              observationName,
              captureToolStart(toolEvent, config.captureMode) as Record<string, unknown>,
              {
                asType: "tool",
                startTime: dateFromMs(toolEvent.startedAt),
              },
            ),
          );
          if (!tool) {
            return undefined;
          }
          const toolTraceParent = {
            parentTraceId: actualTraceId,
            parentRunId: event.runId,
            parentSessionKey: event.sessionKey,
            parentObservationId: tool.id ?? root.id,
          };
          return {
            traceParent: toolTraceParent,
            end(endEvent) {
              tool.update?.(
                captureToolEnd(endEvent as AgentTraceToolEndEvent, config.captureMode, {
                  toolName: toolEvent.toolName,
                  toolCallId: toolEvent.toolCallId,
                }) as Record<string, unknown>,
              );
              tool.end?.();
            },
          };
        },
        recordSpan(spanEvent) {
          const span = client.propagateAttributes(currentRunPropagation(), () =>
            root.startObservation?.(
              spanEvent.name,
              captureSpan(spanEvent) as Record<string, unknown>,
              {
                asType: "span",
                startTime: dateFromMs(spanEvent.startedAt),
              },
            ),
          );
          if (spanEvent.endedAt) {
            span?.end?.(dateFromMs(spanEvent.endedAt));
          } else {
            span?.end?.();
          }
        },
        recordSubagentLifecycle(subagentEvent) {
          if (config.captureMode !== "safe") {
            const subagentId = normalizeString(subagentEvent.agentId);
            const childSessionKey = normalizeString(subagentEvent.childSessionKey);
            traceMetadata.subagentIds = appendUnique(traceMetadata.subagentIds, subagentId);
            traceMetadata.subagentSessionKeys = appendUnique(
              traceMetadata.subagentSessionKeys,
              childSessionKey,
            );
            traceMetadata.searchTerms = appendUnique(traceMetadata.searchTerms, subagentId);
            traceMetadata.searchTerms = appendUnique(traceMetadata.searchTerms, childSessionKey);
            root.update?.({
              metadata: compactMetadata(traceMetadata),
            });
          }
          const lifecycleMetadata = subagentLifecycleMetadata(subagentEvent, config);
          const eventObservation = client.propagateAttributes(currentRunPropagation(), () =>
            root.startObservation?.(
              `openclaw.subagent.${subagentEvent.phase}`,
              {
                metadata: lifecycleMetadata,
                level: subagentEvent.error ? "ERROR" : "DEFAULT",
                statusMessage: subagentEvent.error,
              },
              { asType: "event" },
            ),
          );
          eventObservation?.end?.();
        },
        end(endEvent: AgentTraceRunEndEvent) {
          root.update?.(captureRunEnd(endEvent) as Record<string, unknown>);
          root.end?.();
        },
      };
    },
  };
}

async function shutdownFailedStartupClient(
  client: LangfuseTraceClient,
  ctx: OpenClawPluginServiceContext,
): Promise<void> {
  try {
    await client.shutdown?.();
  } catch (err) {
    ctx.logger.warn(
      `diagnostics-langfuse: failed to clean up after startup auth failure (${String(err)})`,
    );
  }
}

export function createDiagnosticsLangfuseRuntime(options: DiagnosticsLangfuseRuntimeOptions = {}) {
  const state: RuntimeState = {};
  const clientFactory = options.clientFactory ?? createDefaultLangfuseClient;
  const service: OpenClawPluginService = {
    id: "diagnostics-langfuse",
    async start(ctx: OpenClawPluginServiceContext) {
      const config = resolveLangfuseConfig(ctx.config);
      state.config = config ?? undefined;
      state.client = undefined;
      if (!config) {
        return;
      }
      ctx.logger.info("diagnostics-langfuse: starting Langfuse trace exporter");
      const client = await clientFactory(config);
      let authOk: boolean | undefined;
      try {
        authOk = await client.authCheck?.();
      } catch (err) {
        ctx.logger.warn(
          `diagnostics-langfuse: Langfuse auth check failed; exporter will keep running (${String(err)})`,
        );
      }
      if (authOk === false) {
        await shutdownFailedStartupClient(client, ctx);
        throw new Error("diagnostics-langfuse: Langfuse auth check failed");
      }
      state.client = client;
      ctx.logger.info("diagnostics-langfuse: Langfuse trace exporter ready");
    },
    async stop() {
      await state.client?.flush?.();
      await state.client?.shutdown?.();
      state.client = undefined;
      state.config = undefined;
    },
  };
  return {
    service,
    sink: createLangfuseSink(state),
  };
}
