import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentDir } from "../agent-scope.js";
import { renderParkedTaskFlowSummary, renderTaskFlowMarkdown } from "./markdown.js";
import { createTaskFlowStore } from "./store.js";

export type BuildTaskFlowPromptContextParams = {
  config?: OpenClawConfig;
  agentDir?: string;
  stateDir?: string;
  agentId: string;
  sessionKey?: string;
  maxChars?: number;
};

export async function buildTaskFlowPromptContext(
  params: BuildTaskFlowPromptContextParams,
): Promise<string | undefined> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentDir = params.agentDir?.trim() || resolveAgentDir(params.config ?? {}, params.agentId);
  const store = createTaskFlowStore({
    agentDir,
    stateDir: params.stateDir,
  });

  const parts: string[] = [];
  const foreground = await store.readTaskFlow({
    agentId: params.agentId,
    sessionKey,
  });
  if (foreground.status === "success") {
    parts.push(renderTaskFlowMarkdown(foreground.snapshot, { maxChars: params.maxChars ?? 4000 }));
  }

  const parked = await store.listParkedTaskFlows(sessionKey);
  const parkedSummary = renderParkedTaskFlowSummary(parked);
  if (parkedSummary) {
    parts.push(parkedSummary);
  }

  const context = parts.join("\n\n").trim();
  return context || undefined;
}
