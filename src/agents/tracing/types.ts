import type { InputProvenance } from "../../sessions/input-provenance.js";

export type AgentTraceCaptureMode = "safe" | "llm_text" | "full";

export type AgentTraceParent = {
  parentTraceId?: string;
  parentRunId?: string;
  parentSessionKey?: string;
  parentObservationId?: string;
};

export type AgentTraceUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type AgentTraceRunStartEvent = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  messageProvider?: string;
  lane?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  spawnedBy?: string | null;
  inputProvenance?: InputProvenance;
  traceParent?: AgentTraceParent;
  startedAt?: number;
  metadata?: Record<string, unknown>;
};

export type AgentTraceGenerationStartEvent = {
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  startedAt?: number;
};

export type AgentTraceGenerationEndEvent = {
  assistantTexts?: string[];
  lastAssistant?: unknown;
  usage?: AgentTraceUsage;
  error?: string;
  durationMs?: number;
  endedAt?: number;
};

export type AgentTraceToolStartEvent = {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  startedAt?: number;
};

export type AgentTraceToolEndEvent = {
  result?: unknown;
  error?: string;
  durationMs?: number;
  endedAt?: number;
};

export type AgentTraceSubagentLifecycleEvent = {
  phase: "spawning" | "spawned" | "ended";
  runId?: string;
  parentRunId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  agentId?: string;
  label?: string;
  mode?: "run" | "session";
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
  metadata?: Record<string, unknown>;
};

export type AgentTraceSpanEvent = {
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "ERROR";
  statusMessage?: string;
  startedAt?: number;
  endedAt?: number;
};

export type AgentTraceRunEndEvent = {
  success: boolean;
  error?: string;
  durationMs?: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
};

export type AgentTraceObservationHandle = {
  traceParent?: AgentTraceParent;
  end: (event: AgentTraceGenerationEndEvent | AgentTraceToolEndEvent) => void | Promise<void>;
};

export type AgentTraceRunHandle = {
  traceParent?: AgentTraceParent;
  startGeneration?: (
    event: AgentTraceGenerationStartEvent,
  ) => AgentTraceObservationHandle | void | Promise<AgentTraceObservationHandle | void>;
  startTool?: (
    event: AgentTraceToolStartEvent,
  ) => AgentTraceObservationHandle | void | Promise<AgentTraceObservationHandle | void>;
  recordSpan?: (event: AgentTraceSpanEvent) => void | Promise<void>;
  recordSubagentLifecycle?: (event: AgentTraceSubagentLifecycleEvent) => void | Promise<void>;
  end?: (event: AgentTraceRunEndEvent) => void | Promise<void>;
};

export type AgentTraceSink = {
  startRun: (
    event: AgentTraceRunStartEvent,
  ) => AgentTraceRunHandle | void | Promise<AgentTraceRunHandle | void>;
};
