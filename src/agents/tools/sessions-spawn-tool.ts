import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  SUBAGENT_COMPLETION_DELIVERIES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String({
    description:
      "Full task prompt for the sub-agent. Include deliverables, constraints, output paths, and what it should report back on completion.",
  }),
  label: Type.Optional(
    Type.String({
      description: "Short human-readable label for logs and status displays.",
    }),
  ),
  agentId: Type.Optional(
    Type.String({
      description:
        'Target agent id. Defaults to the current agent. Other agent ids require allowlist permission; prefer agentId="researcher" for research-heavy tasks when allowed.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional model override for this subagent run.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description: "Optional thinking level override for this sub-agent run.",
    }),
  ),
  runTimeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Timeout for the sub-agent run in seconds. Use 0 only when an unlimited background run is explicitly needed.",
    }),
  ),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Deprecated alias for runTimeoutSeconds. Prefer runTimeoutSeconds for new calls.",
    }),
  ),
  thread: Type.Optional(
    Type.Boolean({
      description:
        "Bind the sub-agent to a requester thread. Only use when the channel supports sub-agent thread binding.",
    }),
  ),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES, {
    description:
      "run = one-shot background sub-agent that reports back on completion. session = persistent thread-bound sub-agent for follow-up interaction; requires thread=true and channel support.",
  }),
  cleanup: optionalStringEnum(["delete", "keep"] as const, {
    description:
      'keep preserves the sub-agent session and artifacts for review. delete removes the session after completion/announce. Default is "keep".',
  }),
  completionDelivery: optionalStringEnum(SUBAGENT_COMPLETION_DELIVERIES, {
    description:
      "auto may deliver the completion directly to the bound channel. direct requires direct completion delivery when a target is available. parent forces completion through the requester session so the parent can run post-completion checks or tool-mediated delivery.",
  }),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a sub-agent in its own isolated session for complex, long-running, parallelizable, or multi-step work. Use it for tasks with multiple deliverables, long runtimes, or delegated background execution.",
    parameters: SessionsSpawnToolSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const completionDelivery =
        params.completionDelivery === "parent" ||
        params.completionDelivery === "auto" ||
        params.completionDelivery === "direct"
          ? params.completionDelivery
          : undefined;
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          expectsCompletionMessage: true,
          completionDelivery,
          toolCallId,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );

      return jsonResult(result);
    },
  };
}
