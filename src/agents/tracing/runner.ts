import type { PluginRegistry } from "../../plugins/registry.js";
import type {
  AgentTraceGenerationStartEvent,
  AgentTraceObservationHandle,
  AgentTraceRunEndEvent,
  AgentTraceRunHandle,
  AgentTraceRunStartEvent,
  AgentTraceSpanEvent,
  AgentTraceSubagentLifecycleEvent,
  AgentTraceToolStartEvent,
} from "./types.js";

type TraceRunnerLogger = {
  warn?: (message: string) => void;
};

const noopObservationHandle: AgentTraceObservationHandle = {
  end: async () => {},
};

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function createAgentTraceRunEndOnce(traceRun: AgentTraceRunHandle | undefined) {
  let ended = false;
  return async (event: AgentTraceRunEndEvent) => {
    if (ended) {
      return;
    }
    ended = true;
    await traceRun?.end?.(event);
  };
}

function warn(logger: TraceRunnerLogger | undefined, message: string, err: unknown) {
  const suffix = err instanceof Error ? err.message : String(err);
  logger?.warn?.(`${message}: ${suffix}`);
}

function createCompositeObservationHandle(
  handles: Array<{ pluginId: string; handle: AgentTraceObservationHandle }>,
  logger?: TraceRunnerLogger,
): AgentTraceObservationHandle {
  if (handles.length === 0) {
    return noopObservationHandle;
  }
  const traceParent = handles.map((entry) => entry.handle.traceParent).find(Boolean);
  return {
    traceParent,
    async end(event) {
      await Promise.all(
        handles.map(async ({ pluginId, handle }) => {
          try {
            await handle.end(event);
          } catch (err) {
            warn(logger, `agent trace sink failed during observation end (${pluginId})`, err);
          }
        }),
      );
    },
  };
}

function createCompositeRunHandle(
  handles: Array<{ pluginId: string; handle: AgentTraceRunHandle }>,
  logger?: TraceRunnerLogger,
): AgentTraceRunHandle {
  const traceParent = handles.map((entry) => entry.handle.traceParent).find(Boolean);
  return {
    traceParent,
    async startGeneration(event: AgentTraceGenerationStartEvent) {
      const observations = (
        await Promise.all(
          handles.map(async ({ pluginId, handle }) => {
            if (!handle.startGeneration) {
              return undefined;
            }
            try {
              const observation = await handle.startGeneration(event);
              return observation ? { pluginId, handle: observation } : undefined;
            } catch (err) {
              warn(logger, `agent trace sink failed during generation start (${pluginId})`, err);
              return undefined;
            }
          }),
        )
      ).filter(isDefined);
      return createCompositeObservationHandle(observations, logger);
    },
    async startTool(event: AgentTraceToolStartEvent) {
      const observations = (
        await Promise.all(
          handles.map(async ({ pluginId, handle }) => {
            if (!handle.startTool) {
              return undefined;
            }
            try {
              const observation = await handle.startTool(event);
              return observation ? { pluginId, handle: observation } : undefined;
            } catch (err) {
              warn(logger, `agent trace sink failed during tool start (${pluginId})`, err);
              return undefined;
            }
          }),
        )
      ).filter(isDefined);
      return createCompositeObservationHandle(observations, logger);
    },
    async recordSpan(event: AgentTraceSpanEvent) {
      await Promise.all(
        handles.map(async ({ pluginId, handle }) => {
          if (!handle.recordSpan) {
            return;
          }
          try {
            await handle.recordSpan(event);
          } catch (err) {
            warn(logger, `agent trace sink failed during span event (${pluginId})`, err);
          }
        }),
      );
    },
    async recordSubagentLifecycle(event: AgentTraceSubagentLifecycleEvent) {
      await Promise.all(
        handles.map(async ({ pluginId, handle }) => {
          if (!handle.recordSubagentLifecycle) {
            return;
          }
          try {
            await handle.recordSubagentLifecycle(event);
          } catch (err) {
            warn(logger, `agent trace sink failed during subagent event (${pluginId})`, err);
          }
        }),
      );
    },
    async end(event: AgentTraceRunEndEvent) {
      await Promise.all(
        handles.map(async ({ pluginId, handle }) => {
          if (!handle.end) {
            return;
          }
          try {
            await handle.end(event);
          } catch (err) {
            warn(logger, `agent trace sink failed during run end (${pluginId})`, err);
          }
        }),
      );
    },
  };
}

export function createAgentTraceRunner(registry: PluginRegistry, logger?: TraceRunnerLogger) {
  return {
    async startRun(event: AgentTraceRunStartEvent): Promise<AgentTraceRunHandle> {
      const handles = (
        await Promise.all(
          registry.agentTraceSinks.map(async ({ pluginId, sink }) => {
            try {
              const handle = await sink.startRun(event);
              return handle ? { pluginId, handle } : undefined;
            } catch (err) {
              warn(logger, `agent trace sink failed during run start (${pluginId})`, err);
              return undefined;
            }
          }),
        )
      ).filter(isDefined);
      return createCompositeRunHandle(handles, logger);
    },
  };
}
