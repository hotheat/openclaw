import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveAgentDir, resolveSessionAgentId } from "../agent-scope.js";

export type TaskFlowToolContextOptions = {
  agentId?: string;
  agentSessionKey?: string;
  agentDir?: string;
  stateDir?: string;
  config?: OpenClawConfig;
};

export function resolveTaskFlowToolContext(options: TaskFlowToolContextOptions) {
  const cfg = options.config ?? {};
  const agentId =
    options.agentId ??
    resolveSessionAgentId({
      sessionKey: options.agentSessionKey,
      config: cfg,
    });
  return {
    agentId,
    sessionKey: options.agentSessionKey,
    agentDir: options.agentDir?.trim() || resolveAgentDir(cfg, agentId),
    stateDir: options.stateDir?.trim() || resolveStateDir(process.env),
  };
}
