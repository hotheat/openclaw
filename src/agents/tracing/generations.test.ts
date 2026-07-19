import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentTraceGenerationStream } from "./generations.js";
import type {
  AgentTraceGenerationStartEvent,
  AgentTraceObservationHandle,
  AgentTraceRunHandle,
} from "./types.js";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 0,
  totalTokens: 15,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistantMessage(params: {
  text?: string;
  stopReason: AssistantMessage["stopReason"];
}): AssistantMessage {
  return {
    role: "assistant",
    content:
      params.stopReason === "toolUse"
        ? [
            ...(params.text ? [{ type: "text" as const, text: params.text }] : []),
            {
              type: "toolCall",
              id: "tool-1",
              name: "web_search",
              arguments: { query: "test" },
            },
          ]
        : [{ type: "text", text: params.text ?? "" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage,
    stopReason: params.stopReason,
    timestamp: Date.now(),
  };
}

describe("agent generation stream tracing", () => {
  it("creates one generation per model round and marks the final answer", async () => {
    const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
    const inner = vi.fn<StreamFn>(() => streams.shift()!);
    const ends = [vi.fn(), vi.fn()];
    let handleIndex = 0;
    const startGeneration = vi.fn(async (_event: AgentTraceGenerationStartEvent) => {
      const end = ends[handleIndex];
      handleIndex += 1;
      return { end } satisfies AgentTraceObservationHandle;
    });
    const baselineMessages = [{ role: "system", content: "prior turn", timestamp: 0 }];
    const tracing = createAgentTraceGenerationStream({
      streamFn: inner,
      traceRun: { startGeneration } satisfies AgentTraceRunHandle,
    });
    tracing.prepareInitialGeneration({
      prompt: "hello, what is 1+1?",
      baselineMessageCount: baselineMessages.length,
    });
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses",
    } as Parameters<StreamFn>[0];
    const firstContext = {
      systemPrompt: "system",
      messages: [
        ...baselineMessages,
        { role: "user", content: "hello, what is 1+1?", timestamp: 1 },
      ],
    } as Parameters<StreamFn>[1];

    const first = await tracing.streamFn(model, firstContext);
    const firstMessage = assistantMessage({ text: "checking", stopReason: "toolUse" });
    first.push({ type: "done", reason: "toolUse", message: firstMessage });
    await first.result();

    const toolResult = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "web_search",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 2,
    };
    const secondContext = {
      systemPrompt: "system",
      messages: [...firstContext.messages, firstMessage, toolResult],
    } as Parameters<StreamFn>[1];
    const second = await tracing.streamFn(model, secondContext);
    const finalMessage = assistantMessage({ text: "final answer", stopReason: "stop" });
    second.push({ type: "done", reason: "stop", message: finalMessage });
    await second.result();
    await tracing.finish();

    expect(startGeneration).toHaveBeenCalledTimes(2);
    expect(startGeneration.mock.calls[0]?.[0]).toMatchObject({
      roundIndex: 1,
      prompt: "hello, what is 1+1?",
      historyIncludesPrompt: true,
      inputMessages: [{ role: "user", content: "hello, what is 1+1?", timestamp: 1 }],
    });
    expect(startGeneration.mock.calls[1]?.[0]).toMatchObject({
      roundIndex: 2,
      prompt: undefined,
      inputMessages: [firstMessage, toolResult],
    });
    expect(ends[0]).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantTexts: ["checking"],
        finishReason: "toolUse",
        isFinal: false,
        responseKind: "tool_call",
        roundIndex: 1,
        usage: {
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 0,
          total: 15,
        },
      }),
    );
    expect(ends[1]).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantTexts: ["final answer"],
        finishReason: "stop",
        isFinal: true,
        responseKind: "final",
        roundIndex: 2,
      }),
    );
  });

  it("uses the prompt-time baseline after history replacement", async () => {
    const stream = createAssistantMessageEventStream();
    const startGeneration = vi.fn(async (_event: AgentTraceGenerationStartEvent) => undefined);
    const tracing = createAgentTraceGenerationStream({
      streamFn: vi.fn<StreamFn>(() => stream),
      traceRun: { startGeneration } satisfies AgentTraceRunHandle,
    });
    const compactedHistory = [{ role: "assistant", content: "summary", timestamp: 1 }];
    tracing.prepareInitialGeneration({
      prompt: "effective prompt",
      baselineMessageCount: compactedHistory.length,
    });
    const promptMessage = { role: "user", content: "effective prompt", timestamp: 2 };
    const steeringMessages = [
      { role: "user", content: "steering one", timestamp: 3 },
      { role: "user", content: "steering two", timestamp: 4 },
    ];
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses",
    } as Parameters<StreamFn>[0];
    const response = await tracing.streamFn(model, {
      messages: [...compactedHistory, promptMessage, ...steeringMessages],
    } as Parameters<StreamFn>[1]);
    const finalMessage = assistantMessage({ text: "done", stopReason: "stop" });
    response.push({ type: "done", reason: "stop", message: finalMessage });
    await response.result();
    await tracing.finish();

    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "effective prompt",
        historyIncludesPrompt: true,
        inputMessages: [promptMessage, ...steeringMessages],
      }),
    );
  });

  it("closes a generation when the provider fails before returning a stream", async () => {
    const end = vi.fn();
    const tracing = createAgentTraceGenerationStream({
      streamFn: vi.fn<StreamFn>(async () => {
        throw new Error("provider unavailable");
      }),
      traceRun: {
        startGeneration: vi.fn(async () => ({ end })),
      },
    });
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses",
    } as Parameters<StreamFn>[0];
    const context = {
      messages: [{ role: "user", content: "question", timestamp: 1 }],
    } as Parameters<StreamFn>[1];

    await expect(tracing.streamFn(model, context)).rejects.toThrow("provider unavailable");
    await tracing.finish({ error: "provider unavailable" });

    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "provider unavailable",
        finishReason: "error",
        isFinal: false,
        responseKind: "error",
      }),
    );
  });

  it("waits for a normal provider completion before closing the generation", async () => {
    const stream = createAssistantMessageEventStream();
    const end = vi.fn();
    const tracing = createAgentTraceGenerationStream({
      streamFn: vi.fn<StreamFn>(() => stream),
      traceRun: {
        startGeneration: vi.fn(async () => ({ end })),
      },
    });
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses",
    } as Parameters<StreamFn>[0];
    const context = {
      messages: [{ role: "user", content: "question", timestamp: 1 }],
    } as Parameters<StreamFn>[1];

    await tracing.streamFn(model, context);
    const finishPromise = tracing.finish();
    await Promise.resolve();
    expect(end).not.toHaveBeenCalled();

    const finalMessage = assistantMessage({ text: "done", stopReason: "stop" });
    stream.push({ type: "done", reason: "stop", message: finalMessage });
    await finishPromise;

    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantTexts: ["done"],
        finishReason: "stop",
        isFinal: true,
      }),
    );
  });

  it("closes a hanging generation on error and ignores a late completion", async () => {
    const stream = createAssistantMessageEventStream();
    const end = vi.fn();
    const tracing = createAgentTraceGenerationStream({
      streamFn: vi.fn<StreamFn>(() => stream),
      traceRun: {
        startGeneration: vi.fn(async () => ({ end })),
      },
    });
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses",
    } as Parameters<StreamFn>[0];
    const context = {
      messages: [{ role: "user", content: "question", timestamp: 1 }],
    } as Parameters<StreamFn>[1];

    const response = await tracing.streamFn(model, context);
    await tracing.finish({ error: "request timed out" });

    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "request timed out",
        finishReason: "error",
        isFinal: false,
        responseKind: "error",
      }),
    );

    const lateMessage = assistantMessage({ text: "late answer", stopReason: "stop" });
    stream.push({ type: "done", reason: "stop", message: lateMessage });
    await response.result();
    await tracing.finish({ error: "request timed out" });

    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0]?.[0]).not.toMatchObject({
      assistantTexts: ["late answer"],
    });
  });

  it("shares one close operation across concurrent finish calls", async () => {
    const stream = createAssistantMessageEventStream();
    let releaseEnd: (() => void) | undefined;
    const end = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve;
        }),
    );
    const tracing = createAgentTraceGenerationStream({
      streamFn: vi.fn<StreamFn>(() => stream),
      traceRun: {
        startGeneration: vi.fn(async () => ({ end })),
      },
    });
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses",
    } as Parameters<StreamFn>[0];
    const context = {
      messages: [{ role: "user", content: "question", timestamp: 1 }],
    } as Parameters<StreamFn>[1];

    await tracing.streamFn(model, context);
    const firstFinish = tracing.finish({ error: "aborted" });
    const secondFinish = tracing.finish({ error: "aborted" });

    expect(end).toHaveBeenCalledTimes(1);
    releaseEnd?.();
    await Promise.all([firstFinish, secondFinish]);
    await tracing.finish({ error: "aborted" });

    expect(end).toHaveBeenCalledTimes(1);
  });
});
