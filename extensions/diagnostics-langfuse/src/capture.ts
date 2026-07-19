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
  if (event.prompt && !event.historyIncludesPrompt) {
    messages.push({ role: "user", content: event.prompt });
  }
  return messages;
}

function serializedLength(value: unknown): number | undefined {
  if (typeof value === "string") {
    return value.length;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolCall(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { type: "toolCall", argumentsType: typeof value };
  }
  const record = value as Record<string, unknown>;
  const fn = record.function as Record<string, unknown> | undefined;
  const args = fn?.arguments ?? record.arguments;
  const argsKeys =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args as Record<string, unknown>).sort()
      : undefined;
  return {
    ...(record.type === "toolCall" ? { type: "toolCall" } : {}),
    id: record.id,
    name: fn?.name ?? record.name,
    argumentsType: typeof args,
    argumentsLength: serializedLength(args),
    argumentsKeys: argsKeys,
  };
}

function summarizeContentBlocks(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((block): Record<string, unknown> => {
    if (!block || typeof block !== "object") {
      return { type: typeof block, omitted: true };
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      return {
        type: "text",
        text: typeof record.text === "string" ? record.text : undefined,
      };
    }
    if (record.type === "toolCall") {
      return summarizeToolCall(record);
    }
    if (record.type === "image") {
      return {
        type: "image",
        mimeType: record.mimeType,
        dataLength: textLength(record.data),
      };
    }
    if (record.type === "thinking") {
      return {
        type: "thinking",
        thinkingLength: textLength(record.thinking),
      };
    }
    return {
      type: typeof record.type === "string" ? record.type : "unknown",
      omitted: true,
    };
  });
}

function summarizeToolResultContent(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { contentLength: value.length };
  }
  if (!Array.isArray(value)) {
    return { contentType: typeof value };
  }
  let textChars = 0;
  let imageCount = 0;
  let imageDataChars = 0;
  for (const block of value) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      textChars += textLength(record.text);
    } else if (record.type === "image") {
      imageCount += 1;
      imageDataChars += textLength(record.data);
    }
  }
  return {
    contentItems: value.length,
    textChars,
    imageCount,
    imageDataChars,
  };
}

function summarizeMessageForLlmText(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { role: "unknown", contentType: typeof value };
  }
  const message = value as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role : "unknown";
  if (role === "user") {
    return {
      role,
      content: summarizeContentBlocks(message.content),
    };
  }
  if (role === "assistant") {
    return {
      role,
      content: summarizeContentBlocks(message.content),
      ...(Array.isArray(message.tool_calls)
        ? { tool_calls: message.tool_calls.map(summarizeToolCall) }
        : {}),
    };
  }
  if (role === "toolResult") {
    return {
      role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      ...summarizeToolResultContent(message.content),
      status: message.isError ? "error" : "success",
    };
  }
  if (role === "tool") {
    return {
      role,
      tool_call_id: message.tool_call_id,
      name: message.name,
      ...summarizeToolResultContent(message.content),
      status: message.status,
    };
  }
  return {
    role,
    content: summarizeContentBlocks(message.content),
  };
}

function assistantMessageHasToolCalls(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") {
    return false;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "toolCall",
    )
  );
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
    inputMessages: event.inputMessages?.length ?? 0,
    imagesCount: event.imagesCount,
    roundIndex: event.roundIndex,
  };
  if (mode === "safe") {
    return { metadata, model: event.model };
  }
  if (mode === "full") {
    return {
      input: maskSensitiveData({
        messages: buildReplayMessages(event),
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
      }),
      metadata,
      model: event.model,
    };
  }
  // llm_text: keep user/assistant text intact, but reduce tool_call/tool_result
  // payloads to a name + id + length + status summary so the privacy contract
  // (no full tool payload in llm_text) matches captureToolStart/captureToolEnd.
  const inputMessages = (event.inputMessages ?? []).map(summarizeMessageForLlmText);
  return {
    input: maskSensitiveData({
      messages: buildReplayMessages({
        ...event,
        prompt: undefined,
        historyMessages: inputMessages,
      }),
      systemPrompt: event.systemPrompt,
      prompt: event.inputMessages?.length ? undefined : event.prompt,
      historyMessages: undefined,
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
    roundIndex: event.roundIndex,
    finishReason: event.finishReason,
    responseKind: event.responseKind,
    isFinal: event.isFinal,
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
    if (assistantMessageHasToolCalls(event.lastAssistant)) {
      attrs.output = maskSensitiveData(
        mode === "full" ? event.lastAssistant : summarizeMessageForLlmText(event.lastAssistant),
      );
    } else {
      attrs.output = maskSensitiveData(event.assistantTexts ?? []);
    }
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
