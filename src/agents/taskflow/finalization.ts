import path from "node:path";
import { listDescendantRunsForRequester } from "../subagent-registry.js";
import { dispatchTaskFlowCommitHook } from "./store-hook.js";
import { createTaskFlowStore } from "./store.js";

type FinalizeForegroundTaskFlowParams = {
  agentId: string;
  agentDir: string;
  sessionKey: string;
};

export type FinalizeForegroundTaskFlowResult =
  | {
      status: "skipped";
      reason: "missing_session_key" | "no_foreground_taskflow" | "no_orphaned_in_progress";
    }
  | { status: "exempt"; reason: "active_descendant_run"; taskFlowId: string }
  | { status: "parked"; taskFlowId: string; revision: number };

function resolveStateDirFromAgentDir(agentDir: string): string | null {
  const normalized = path.resolve(agentDir);
  if (path.basename(normalized) !== "agent") {
    return null;
  }
  const agentHome = path.dirname(normalized);
  const agentsRoot = path.dirname(agentHome);
  if (path.basename(agentsRoot) !== "agents") {
    return null;
  }
  return path.dirname(agentsRoot);
}

function hasOrphanedInProgressItems(statuses: string[]): boolean {
  return statuses.includes("in_progress");
}

function hasActiveDescendantRunForTaskFlow(params: {
  sessionKey: string;
  taskFlowId: string;
}): boolean {
  return listDescendantRunsForRequester(params.sessionKey).some(
    (entry) =>
      typeof entry.endedAt !== "number" &&
      (entry.taskFlowId === params.taskFlowId || entry.trackingTaskFlowId === params.taskFlowId),
  );
}

export async function finalizeForegroundTaskFlow(
  params: FinalizeForegroundTaskFlowParams,
): Promise<FinalizeForegroundTaskFlowResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { status: "skipped", reason: "missing_session_key" };
  }

  const stateDir = resolveStateDirFromAgentDir(params.agentDir);
  const store = createTaskFlowStore({
    agentDir: params.agentDir,
    stateDir: stateDir ?? undefined,
    onCommitted: dispatchTaskFlowCommitHook,
  });
  const read = await store.readTaskFlow({
    agentId: params.agentId,
    sessionKey,
  });
  if (read.status === "error") {
    return { status: "skipped", reason: "no_foreground_taskflow" };
  }

  if (!hasOrphanedInProgressItems(read.snapshot.items.map((item) => item.status))) {
    return { status: "skipped", reason: "no_orphaned_in_progress" };
  }

  if (
    hasActiveDescendantRunForTaskFlow({
      sessionKey,
      taskFlowId: read.snapshot.id,
    })
  ) {
    return {
      status: "exempt",
      reason: "active_descendant_run",
      taskFlowId: read.snapshot.id,
    };
  }

  const parked = await store.applyTaskFlowOperation({
    agentId: params.agentId,
    sessionKey,
    taskFlowId: read.snapshot.id,
    expectedRevision: read.snapshot.revision,
    operation: "park_taskflow",
    reason: "finalization_missing",
  });
  if (parked.status !== "success") {
    return { status: "skipped", reason: "no_foreground_taskflow" };
  }
  return {
    status: "parked",
    taskFlowId: parked.taskFlowId,
    revision: parked.revision,
  };
}
