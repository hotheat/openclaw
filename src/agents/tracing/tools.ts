import type { AnyAgentTool } from "../pi-tools.types.js";
import { runWithToolTraceParent } from "./context.js";
import type { AgentTraceObservationHandle, AgentTraceRunHandle } from "./types.js";

type ToolExecute = (toolCallId: string, params: unknown, ...rest: unknown[]) => Promise<unknown>;

function traceParamsFromToolArgs(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return { value: params };
}

async function startToolTrace(params: {
  traceRun: AgentTraceRunHandle | undefined;
  toolName: string;
  toolCallId: string;
  toolParams: Record<string, unknown>;
  startedAt: number;
}): Promise<AgentTraceObservationHandle | undefined> {
  try {
    return (
      (await params.traceRun?.startTool?.({
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        params: params.toolParams,
        startedAt: params.startedAt,
      })) ?? undefined
    );
  } catch {
    return undefined;
  }
}

async function endToolTrace(
  trace: AgentTraceObservationHandle | undefined,
  event: {
    result?: unknown;
    error?: string;
    durationMs: number;
    endedAt: number;
  },
): Promise<void> {
  try {
    await trace?.end(event);
  } catch {
    // Tracing must not affect tool execution.
  }
}

export function wrapToolsWithAgentTracing(params: {
  tools: AnyAgentTool[];
  traceRun: AgentTraceRunHandle | undefined;
}): AnyAgentTool[] {
  if (!params.traceRun?.startTool) {
    return params.tools;
  }

  return params.tools.map((tool) => {
    const originalExecute = tool.execute.bind(tool) as ToolExecute;
    return {
      ...tool,
      async execute(toolCallId: string, toolParams: unknown, ...rest: unknown[]) {
        const callId = String(toolCallId);
        const startedAt = Date.now();
        const trace = await startToolTrace({
          traceRun: params.traceRun,
          toolName: String(tool.name || "tool"),
          toolCallId: callId,
          toolParams: traceParamsFromToolArgs(toolParams),
          startedAt,
        });
        let result: unknown;
        let error: string | undefined;

        try {
          result = await runWithToolTraceParent(trace?.traceParent, async () => {
            return await originalExecute(callId, toolParams, ...rest);
          });
          return result;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          await endToolTrace(trace, {
            result,
            error,
            durationMs: Date.now() - startedAt,
            endedAt: Date.now(),
          });
        }
      },
    } as AnyAgentTool;
  });
}
