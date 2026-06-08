import type {
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
  type LangfuseObservation,
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

function dateFromMs(value: number | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}

function normalizeSpanId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{16}$/.test(normalized) ? normalized : undefined;
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
      const hasParentSpanContext = Boolean(parentTraceId && parentSpanId);
      const traceId = hasParentSpanContext
        ? parentTraceId
        : await client.createTraceId(event.runId);
      const root = client.startObservation(
        "openclaw.agent.run",
        {
          metadata: runMetadata(event, config),
        },
        {
          asType: "agent",
          startTime: dateFromMs(event.startedAt),
          ...(hasParentSpanContext
            ? {
                parentSpanContext: {
                  traceId,
                  spanId: parentSpanId,
                  traceFlags: 1,
                },
              }
            : {}),
        },
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
          const generation = root.startObservation?.(
            "openclaw.llm.generation",
            captureGenerationStart(generationEvent, config.captureMode) as Record<string, unknown>,
            {
              asType: "generation",
              startTime: dateFromMs(generationEvent.startedAt),
            },
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
              generation.end?.();
            },
          };
        },
        startTool(toolEvent) {
          const name = toolEvent.toolName.replace(/[^A-Za-z0-9_.-]/g, "_");
          const tool = root.startObservation?.(
            `openclaw.tool.${name}`,
            captureToolStart(toolEvent, config.captureMode) as Record<string, unknown>,
            {
              asType: "tool",
              startTime: dateFromMs(toolEvent.startedAt),
            },
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
          const span = root.startObservation?.(
            spanEvent.name,
            captureSpan(spanEvent) as Record<string, unknown>,
            {
              asType: "span",
              startTime: dateFromMs(spanEvent.startedAt),
            },
          );
          if (spanEvent.endedAt) {
            span?.end?.(dateFromMs(spanEvent.endedAt));
          } else {
            span?.end?.();
          }
        },
        recordSubagentLifecycle(subagentEvent) {
          const eventObservation = root.startObservation?.(
            `openclaw.subagent.${subagentEvent.phase}`,
            {
              metadata: subagentEvent,
              level: subagentEvent.error ? "ERROR" : "DEFAULT",
              statusMessage: subagentEvent.error,
            },
            { asType: "event" },
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
