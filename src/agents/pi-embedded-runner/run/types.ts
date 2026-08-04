import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { PluginHookBeforeAgentStartResult } from "../../../plugins/types.js";
import type { ContextWindowSource } from "../../context-window-guard.js";
import type { MessagingToolSend } from "../../pi-embedded-messaging.js";
import type { AuthStorage, ModelRegistry } from "../../pi-model-discovery.js";
import type { PendingToolCall } from "../../session-tool-result-guard.js";
import type { NormalizedUsage } from "../../usage.js";
import type { ToolWaitStatus } from "../wait-for-idle-before-flush.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedPiAgentParams,
  "provider" | "model" | "authProfileId" | "authProfileIdSource" | "thinkLevel" | "enqueue"
>;

export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  provider: string;
  modelId: string;
  model: Model<Api>;
  effectiveContextWindowTokens: number;
  effectiveContextWindowSource: ContextWindowSource;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
  suppressLifecycleTerminal?: boolean;
  /** Restrict automatic recovery attempts to read-only tool calls. */
  recoveryToolPolicy?: "normal" | "read_only";
};

export type EmbeddedRunAttemptTermination =
  | { kind: "completed" }
  | {
      kind: "incomplete_tool_loop";
      cause: "awaiting_final_response" | "missing_tool_results";
      lastStopReason?: string;
      unresolvedToolCalls: PendingToolCall[];
      syntheticToolResultsWritten: boolean;
      toolWaitStatus: ToolWaitStatus;
    };

export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  timedOut: boolean;
  /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean;
  promptError: unknown;
  sessionIdUsed: string;
  systemPromptReport?: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: AssistantMessage | undefined;
  assistantErrors: AssistantMessage[];
  termination: EmbeddedRunAttemptTermination;
  lastToolError?: {
    toolName: string;
    meta?: string;
    error?: string;
    mutatingAction?: boolean;
    actionFingerprint?: string;
  };
  didSendViaMessagingTool: boolean;
  didDeliverUserFacingToolResult: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  compactionCount?: number;
  sdkAutoCompactionCount?: number;
  /** Client tool call detected (OpenResponses hosted tools). */
  clientToolCall?: { name: string; params: Record<string, unknown> };
};
