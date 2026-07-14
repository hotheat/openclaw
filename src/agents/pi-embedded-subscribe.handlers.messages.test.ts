import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantStreamGuardState,
  DEFAULT_ASSISTANT_STREAM_LIMITS,
} from "./pi-embedded-stream-guard.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./pi-embedded-subscribe.e2e-harness.js";
import {
  handleMessageUpdate,
  resolveSilentReplyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });
});

describe("assistant text stream safety", () => {
  it("buffers pure whitespace without rescanning the full assistant buffer", () => {
    const stripBlockTags = vi.fn();
    const ctx = {
      params: {
        runId: "run-whitespace-scan",
        session: {},
      },
      state: {
        assistantStreamGuard: createAssistantStreamGuardState(),
        deltaBuffer: "answer",
        blockBuffer: "answer",
        blockReplyBreak: "message_end",
        streamReasoning: false,
      },
      blockChunker: null,
      noteLastAssistant: vi.fn(),
      stripBlockTags,
      log: { warn: vi.fn(), debug: vi.fn() },
      flushBlockReplyBuffer: vi.fn(),
    } as unknown as EmbeddedPiSubscribeContext;

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "\n" },
    } as never);

    expect(ctx.state.deltaBuffer).toBe("answer\n");
    expect(ctx.state.blockBuffer).toBe("answer\n");
    expect(stripBlockTags).not.toHaveBeenCalled();
  });

  it("preserves whitespace between meaningful chunks without emitting a blank update", () => {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-whitespace",
      onAgentEvent,
    });

    emitAssistantTextDelta({ emit, delta: "hello" });
    emitAssistantTextDelta({ emit, delta: " " });
    emitAssistantTextDelta({ emit, delta: "world" });

    const assistantEvents = onAgentEvent.mock.calls.filter(
      ([event]) => event.stream === "assistant",
    );
    expect(assistantEvents).toHaveLength(2);
    expect(assistantEvents.at(-1)?.[0].data.text).toBe("hello world");
  });

  it("aborts a whitespace flood once and sanitizes the message before completion", () => {
    const abortRun = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-whitespace-flood",
      abortRun,
    });

    for (
      let index = 0;
      index <= DEFAULT_ASSISTANT_STREAM_LIMITS.maxConsecutiveWhitespaceEvents;
      index += 1
    ) {
      emitAssistantTextDelta({ emit, delta: "\n" });
    }
    emitAssistantTextDelta({ emit, delta: "\n" });

    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(abortRun.mock.calls[0]?.[0]).toMatchObject({
      name: "AssistantStreamLimitError",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "\n".repeat(72_000) }],
      stopReason: "aborted",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as unknown as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(assistantMessage.content).toEqual([]);
    expect(assistantMessage.stopReason).toBe("error");
    expect(assistantMessage.errorMessage).toContain("consecutive_whitespace_events");
  });
});
