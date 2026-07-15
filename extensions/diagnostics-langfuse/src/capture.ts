import type {
  AgentTraceCaptureMode,
  AgentTraceGenerationEndEvent,
  AgentTraceGenerationStartEvent,
  AgentTraceRunEndEvent,
  AgentTraceSpanEvent,
  AgentTraceToolEndEvent,
  AgentTraceToolStartEvent,
} from "openclaw/plugin-sdk";
import { maskSensitiveData } from "./mask.js";

export type LangfuseObservationAttributes = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "ERROR";
  statusMessage?: string;
  model?: string;
  usageDetails?: Record<string, number>;
};

type ToolContext = {
  toolName?: string;
  toolCallId?: string;
};

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function normalizeToolContext(value: string | ToolContext | undefined): ToolContext {
  return typeof value === "string" ? { toolName: value } : (value ?? {});
}

function buildReplayMessages(
  event: AgentTraceGenerationStartEvent,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const systemPrompt = event.systemPrompt?.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: event.systemPrompt });
  }
  for (const message of event.historyMessages) {
    if (message && typeof message === "object") {
      messages.push(message as Record<string, unknown>);
    } else if (typeof message === "string") {
      messages.push({ role: "user", content: message });
    } else {
      messages.push({ role: "unknown", content: message });
    }
  }
  if (event.prompt) {
    messages.push({ role: "user", content: event.prompt });
  }
  return messages;
}

function resultSummary(value: unknown): Record<string, unknown> {
  if (value == null) {
    return { resultType: "null" };
  }
  if (typeof value === "string") {
    return { resultType: "string", resultChars: value.length };
  }
  if (Array.isArray(value)) {
    return { resultType: "array", resultItems: value.length };
  }
  if (typeof value === "object") {
    return { resultType: "object", resultKeys: Object.keys(value as Record<string, unknown>) };
  }
  return { resultType: typeof value };
}

function safeSessionsSpawnOutput(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = ["runId", "childSessionKey", "status", "mode", "label", "targetAgentId"];
  const output: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (record[key] != null) {
      output[key] = record[key];
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function toolMessageContent(value: unknown): unknown {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.content != null) {
      return record.content;
    }
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function buildToolOutputMessage(event: AgentTraceToolEndEvent, tool: ToolContext) {
  if (!tool.toolName && !tool.toolCallId) {
    return undefined;
  }
  return {
    role: "tool",
    tool_call_id: tool.toolCallId,
    name: tool.toolName,
    content: toolMessageContent(event.result),
    status: event.error ? "error" : "success",
  };
}

export function captureGenerationStart(
  event: AgentTraceGenerationStartEvent,
  mode: AgentTraceCaptureMode,
): LangfuseObservationAttributes {
  const metadata = {
    provider: event.provider,
    model: event.model,
    systemPromptChars: textLength(event.systemPrompt),
    promptChars: textLength(event.prompt),
    historyMessages: event.historyMessages.length,
    imagesCount: event.imagesCount,
  };
  if (mode === "safe") {
    return { metadata, model: event.model };
  }
  return {
    input: maskSensitiveData({
      messages: buildReplayMessages({
        ...event,
        historyMessages: mode === "full" ? event.historyMessages : [],
      }),
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      historyMessages: mode === "full" ? event.historyMessages : undefined,
    }),
    metadata,
    model: event.model,
  };
}

export function captureGenerationEnd(
  event: AgentTraceGenerationEndEvent,
  mode: AgentTraceCaptureMode,
): LangfuseObservationAttributes {
  const metadata = {
    assistantTextCount: event.assistantTexts?.length ?? 0,
    assistantTextChars: (event.assistantTexts ?? []).reduce((sum, text) => sum + text.length, 0),
    durationMs: event.durationMs,
    error: event.error,
  };
  const usageDetails = event.usage
    ? Object.fromEntries(
        Object.entries(event.usage).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      )
    : undefined;
  const attrs: LangfuseObservationAttributes = {
    metadata,
    usageDetails,
    level: event.error ? "ERROR" : "DEFAULT",
    statusMessage: event.error,
  };
  if (mode !== "safe") {
    attrs.output = maskSensitiveData(event.assistantTexts ?? []);
  }
  return attrs;
}

export function captureToolStart(
  event: AgentTraceToolStartEvent,
  mode: AgentTraceCaptureMode,
): LangfuseObservationAttributes {
  const metadata = {
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    skillName: event.skillName,
    paramKeys: Object.keys(event.params).sort(),
  };
  if (mode !== "full") {
    return { metadata };
  }
  return {
    input: maskSensitiveData(event.params),
    metadata,
  };
}

export function captureToolEnd(
  event: AgentTraceToolEndEvent,
  mode: AgentTraceCaptureMode,
  toolContext?: string | ToolContext,
): LangfuseObservationAttributes {
  const tool = normalizeToolContext(toolContext);
  const attrs: LangfuseObservationAttributes = {
    metadata: {
      ...resultSummary(event.result),
      durationMs: event.durationMs,
      error: event.error,
    },
    level: event.error ? "ERROR" : "DEFAULT",
    statusMessage: event.error,
  };
  if (mode === "full") {
    attrs.output = maskSensitiveData({
      result: event.result,
      outputMessage: buildToolOutputMessage(event, tool),
    });
  } else if (tool.toolName === "sessions_spawn") {
    attrs.output = maskSensitiveData(safeSessionsSpawnOutput(event.result));
  }
  return attrs;
}

export function captureRunEnd(event: AgentTraceRunEndEvent): LangfuseObservationAttributes {
  return {
    output: {
      success: event.success,
      error: event.error,
    },
    metadata: {
      durationMs: event.durationMs,
      ...event.metadata,
    },
    level: event.success ? "DEFAULT" : "ERROR",
    statusMessage: event.error,
  };
}

export function captureSpan(event: AgentTraceSpanEvent): LangfuseObservationAttributes {
  return {
    input: event.input == null ? undefined : maskSensitiveData(event.input),
    output: event.output == null ? undefined : maskSensitiveData(event.output),
    metadata:
      event.metadata == null
        ? undefined
        : (maskSensitiveData(event.metadata) as Record<string, unknown>),
    level: event.level ?? "DEFAULT",
    statusMessage: event.statusMessage,
  };
}
