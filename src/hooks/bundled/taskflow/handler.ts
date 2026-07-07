import { buildTaskFlowPromptContext } from "../../../agents/taskflow/prompt.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
} from "../../../plugins/types.js";

export async function taskFlowBeforePromptBuildHandler(
  _event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { agentDir?: string; stateDir?: string },
) {
  const agentId = ctx.agentId?.trim();
  if (!agentId) {
    return undefined;
  }
  const prependContext = await buildTaskFlowPromptContext({
    agentId,
    sessionKey: ctx.sessionKey,
    agentDir: ctx.agentDir,
    stateDir: ctx.stateDir,
  });
  return prependContext ? { prependContext } : undefined;
}

export default taskFlowBeforePromptBuildHandler;
