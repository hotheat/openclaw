import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { runWithToolTraceParent } from "./context.js";
import type { AgentTraceObservationHandle, AgentTraceRunHandle } from "./types.js";

type ToolExecute = (toolCallId: string, params: unknown, ...rest: unknown[]) => Promise<unknown>;
type TraceSkillFile = {
  name: string;
  filePath: string;
};

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
  skillName?: string;
  startedAt: number;
}): Promise<AgentTraceObservationHandle | undefined> {
  try {
    return (
      (await params.traceRun?.startTool?.({
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        params: params.toolParams,
        ...(params.skillName ? { skillName: params.skillName } : {}),
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

function normalizeTraceFilePath(filePath: string, workspaceDir: string): string {
  const expanded = filePath.startsWith("~") ? resolveUserPath(filePath) : filePath;
  return path.normalize(path.resolve(workspaceDir, expanded));
}

function resolveInvokedSkillName(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  workspaceDir: string;
  skillFiles: TraceSkillFile[];
}): string | undefined {
  if (params.toolName !== "read" || params.skillFiles.length === 0) {
    return undefined;
  }
  const rawPath =
    typeof params.toolParams.path === "string"
      ? params.toolParams.path
      : typeof params.toolParams.file_path === "string"
        ? params.toolParams.file_path
        : undefined;
  if (!rawPath?.trim()) {
    return undefined;
  }
  const requestedPath = normalizeTraceFilePath(rawPath.trim(), params.workspaceDir);
  return params.skillFiles.find(
    (skill) => normalizeTraceFilePath(skill.filePath, params.workspaceDir) === requestedPath,
  )?.name;
}

export function wrapToolsWithAgentTracing(params: {
  tools: AnyAgentTool[];
  traceRun: AgentTraceRunHandle | undefined;
  workspaceDir?: string;
  skillFiles?: TraceSkillFile[];
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
        const normalizedToolParams = traceParamsFromToolArgs(toolParams);
        const trace = await startToolTrace({
          traceRun: params.traceRun,
          toolName: String(tool.name || "tool"),
          toolCallId: callId,
          toolParams: normalizedToolParams,
          skillName: resolveInvokedSkillName({
            toolName: String(tool.name || "tool"),
            toolParams: normalizedToolParams,
            workspaceDir: params.workspaceDir ?? process.cwd(),
            skillFiles: params.skillFiles ?? [],
          }),
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
