import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentTraceParent,
  AgentTraceRunHandle,
  AgentTraceSubagentLifecycleEvent,
} from "./types.js";

const traceParentStore = new AsyncLocalStorage<AgentTraceParent>();
const traceRunStore = new AsyncLocalStorage<AgentTraceRunHandle>();
const toolTraceParentStore = new AsyncLocalStorage<AgentTraceParent>();
const subagentLifecycleTraceRuns = new Map<string, AgentTraceRunHandle>();

export function getCurrentAgentTraceParent(): AgentTraceParent | undefined {
  return traceParentStore.getStore();
}

export function getCurrentToolTraceParent(): AgentTraceParent | undefined {
  return toolTraceParentStore.getStore();
}

export function getCurrentAgentTraceRun(): AgentTraceRunHandle | undefined {
  return traceRunStore.getStore();
}

export async function runWithAgentTraceParent<T>(
  traceParent: AgentTraceParent | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!traceParent) {
    return await fn();
  }
  return await traceParentStore.run(traceParent, fn);
}

export async function runWithToolTraceParent<T>(
  traceParent: AgentTraceParent | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!traceParent) {
    return await fn();
  }
  return await toolTraceParentStore.run(traceParent, fn);
}

export async function runWithAgentTraceRun<T>(
  traceRun: AgentTraceRunHandle | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!traceRun) {
    return await fn();
  }
  return await traceRunStore.run(traceRun, fn);
}

export async function recordSubagentLifecycleTraceEvent(
  event: AgentTraceSubagentLifecycleEvent,
): Promise<void> {
  const traceRun =
    getCurrentAgentTraceRun() ??
    (event.runId ? subagentLifecycleTraceRuns.get(event.runId) : undefined);
  try {
    await traceRun?.recordSubagentLifecycle?.(event);
  } catch {
    // Tracing must not affect subagent lifecycle state transitions.
  } finally {
    if (event.phase === "spawned" && event.runId && traceRun) {
      subagentLifecycleTraceRuns.set(event.runId, traceRun);
    }
    if (event.phase === "ended" && event.runId) {
      subagentLifecycleTraceRuns.delete(event.runId);
    }
  }
}

export function createChildTraceParent(params: {
  currentRunId: string;
  currentSessionKey?: string;
  inheritedParent?: AgentTraceParent;
  parentObservationId?: string;
}): AgentTraceParent {
  return {
    parentTraceId: params.inheritedParent?.parentTraceId,
    parentRunId: params.currentRunId,
    parentSessionKey: params.currentSessionKey,
    parentObservationId: params.parentObservationId,
  };
}

export function resolveCurrentAgentTraceParent(params: {
  traceRun?: AgentTraceRunHandle;
  currentRunId: string;
  currentSessionKey?: string;
  inheritedParent?: AgentTraceParent;
}): AgentTraceParent | undefined {
  if (params.traceRun?.traceParent?.parentTraceId) {
    return params.traceRun.traceParent;
  }
  if (!params.inheritedParent?.parentTraceId) {
    return undefined;
  }
  return createChildTraceParent({
    currentRunId: params.currentRunId,
    currentSessionKey: params.currentSessionKey,
    inheritedParent: params.inheritedParent,
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeAgentTraceParent(value: unknown): AgentTraceParent | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const parentRunId = normalizeOptionalString(record.parentRunId);
  const parentTraceId = normalizeOptionalString(record.parentTraceId);
  const parentSessionKey = normalizeOptionalString(record.parentSessionKey);
  const parentObservationId = normalizeOptionalString(record.parentObservationId);
  if (!parentRunId && !parentTraceId && !parentSessionKey && !parentObservationId) {
    return undefined;
  }
  return {
    parentTraceId,
    parentRunId,
    parentSessionKey,
    parentObservationId,
  };
}
