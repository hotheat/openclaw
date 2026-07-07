import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveDefaultAgentId, resolveAgentDir } from "../agent-scope.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { dispatchTaskFlowCommitHook } from "./store-hook.js";
import { createTaskFlowStore } from "./store.js";
import type { TaskFlowPermission } from "./types.js";

type RevokeReason = NonNullable<TaskFlowPermission["revokedReason"]>;

export async function revokeTaskFlowAccessForSessionKey(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  taskFlowId?: string;
  targetSessionKey: string;
  requesterSessionKey?: string;
  revokeReason: RevokeReason;
}): Promise<{ revokedTaskFlowIds: string[] }> {
  const cfg = params.cfg ?? loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const result = await createTaskFlowStore({
    agentDir,
    stateDir: params.stateDir,
    onCommitted: dispatchTaskFlowCommitHook,
  }).revokeAccessForSession({
    taskFlowId: params.taskFlowId,
    targetSessionKey: params.targetSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    revokeReason: params.revokeReason,
  });
  return {
    revokedTaskFlowIds: result.status === "success" ? result.revokedTaskFlowIds : [],
  };
}

export async function revokeTaskFlowAccessForSubagentRun(entry: SubagentRunRecord): Promise<void> {
  if (!entry.taskFlowId || entry.spawnMode === "session") {
    return;
  }
  await revokeTaskFlowAccessForSessionKey({
    taskFlowId: entry.taskFlowId,
    targetSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    revokeReason: "subagent_ended",
  });
}
