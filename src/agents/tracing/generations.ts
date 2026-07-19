import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { normalizeUsage } from "../usage.js";
import type {
  AgentTraceGenerationEndEvent,
  AgentTraceObservationHandle,
  AgentTraceRunHandle,
} from "./types.js";

type GenerationRecord = {
  handle?: AgentTraceObservationHandle;
  roundIndex: number;
  startedAt: number;
  completion?: Promise<void>;
  endEvent?: AgentTraceGenerationEndEvent;
  closePromise?: Promise<void>;
  forceClose?: () => void;
  fallbackError?: string;
  markFinal: boolean;
  closed: boolean;
};

export type AgentTraceGenerationStream = {
  streamFn: StreamFn;
  finish: (event?: { error?: string }) => Promise<void>;
  prepareInitialGeneration: (params: {
    prompt: string | undefined;
    baselineMessageCount: number;
  }) => void;
};

function assistantTexts(message: AssistantMessage): string[] {
  return message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
}

function imageCount(messages: unknown[]): number {
  let count = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    count += content.filter(
      (item) => item && typeof item === "object" && (item as { type?: unknown }).type === "image",
    ).length;
  }
  return count;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseKind(
  event: AgentTraceGenerationEndEvent,
  isFinal: boolean,
): AgentTraceGenerationEndEvent["responseKind"] {
  if (event.error || event.finishReason === "error" || event.finishReason === "aborted") {
    return "error";
  }
  if (event.finishReason === "toolUse") {
    return "tool_call";
  }
  return isFinal ? "final" : "assistant";
}

export function createAgentTraceGenerationStream(params: {
  streamFn: StreamFn;
  traceRun?: AgentTraceRunHandle;
}): AgentTraceGenerationStream {
  const startGeneration = params.traceRun?.startGeneration;
  if (!startGeneration) {
    return {
      streamFn: params.streamFn,
      finish: async () => {},
      prepareInitialGeneration: () => {},
    };
  }

  let nextRoundIndex = 1;
  let previousContextMessageCount: number | undefined;
  let initialPrompt: string | undefined;
  let pending: GenerationRecord | undefined;

  const closePending = async (
    markFinal: boolean,
    options?: {
      fallbackError?: string;
      waitForCompletion?: boolean;
    },
  ) => {
    const record = pending;
    if (!record) {
      return;
    }

    record.markFinal ||= markFinal;
    if (options?.fallbackError !== undefined) {
      record.fallbackError ??= options.fallbackError;
    }

    if (!record.closePromise) {
      let forceClose: (() => void) | undefined;
      const forced = new Promise<void>((resolve) => {
        forceClose = resolve;
      });
      record.forceClose = forceClose;
      record.closePromise = (async () => {
        if (options?.waitForCompletion !== false && record.completion) {
          await Promise.race([record.completion, forced]);
        }

        const endedAt = Date.now();
        const endEvent = record.endEvent ?? {
          error: record.fallbackError ?? "generation ended without a model response",
          durationMs: Math.max(0, endedAt - record.startedAt),
          endedAt,
          roundIndex: record.roundIndex,
          finishReason: "error",
        };
        const isFinal =
          record.markFinal &&
          !endEvent.error &&
          endEvent.finishReason !== "toolUse" &&
          endEvent.finishReason !== "error" &&
          endEvent.finishReason !== "aborted";

        record.closed = true;
        if (pending === record) {
          pending = undefined;
        }
        await record.handle?.end({
          ...endEvent,
          roundIndex: record.roundIndex,
          isFinal,
          responseKind: responseKind(endEvent, isFinal),
        });
      })();
    }

    if (options?.waitForCompletion === false) {
      record.forceClose?.();
    }
    await record.closePromise;
  };

  const streamFn: StreamFn = async (model, context, options) => {
    await closePending(false);

    const messages = Array.isArray(context.messages) ? context.messages : [];
    const baseline =
      previousContextMessageCount == null || messages.length < previousContextMessageCount
        ? Math.max(0, messages.length - 1)
        : previousContextMessageCount;
    const inputMessages = messages.slice(baseline);
    previousContextMessageCount = messages.length;

    const roundIndex = nextRoundIndex;
    nextRoundIndex += 1;
    const startedAt = Date.now();
    const handle = await startGeneration({
      provider: model.provider,
      model: model.id,
      systemPrompt: context.systemPrompt,
      prompt: roundIndex === 1 ? initialPrompt : undefined,
      historyMessages: messages,
      historyIncludesPrompt: roundIndex === 1 && initialPrompt !== undefined,
      inputMessages,
      imagesCount: imageCount(inputMessages),
      roundIndex,
      startedAt,
    });
    const record: GenerationRecord = {
      roundIndex,
      startedAt,
      handle: handle ?? undefined,
      markFinal: false,
      closed: false,
    };
    pending = record;

    try {
      const response = await params.streamFn(model, context, options);
      record.completion = response.result().then(
        (message) => {
          if (record.closed) {
            return;
          }
          const endedAt = Date.now();
          record.endEvent = {
            assistantTexts: assistantTexts(message),
            lastAssistant: message,
            usage: normalizeUsage(message.usage),
            error: message.errorMessage,
            durationMs: Math.max(0, endedAt - startedAt),
            endedAt,
            roundIndex,
            finishReason: message.stopReason,
          };
        },
        (error) => {
          if (record.closed) {
            return;
          }
          const endedAt = Date.now();
          record.endEvent = {
            error: describeError(error),
            durationMs: Math.max(0, endedAt - startedAt),
            endedAt,
            roundIndex,
            finishReason: "error",
          };
        },
      );
      return response;
    } catch (error) {
      const endedAt = Date.now();
      record.endEvent = {
        error: describeError(error),
        durationMs: Math.max(0, endedAt - startedAt),
        endedAt,
        roundIndex,
        finishReason: "error",
      };
      throw error;
    }
  };

  return {
    streamFn,
    finish: async (event) => {
      await closePending(true, {
        fallbackError: event?.error,
        waitForCompletion: event?.error === undefined,
      });
    },
    prepareInitialGeneration: (initial) => {
      initialPrompt = initial.prompt;
      previousContextMessageCount = initial.baselineMessageCount;
    },
  };
}
