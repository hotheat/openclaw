import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  normalizeSilentAssistantCompletionMessage,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers.js";

function makeToolCallResultPairInput(): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_123|fc_456",
          name: "read",
          arguments: { path: "package.json" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_123|fc_456",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
  ] as AgentMessage[];
}

function expectToolCallAndResultIds(out: AgentMessage[], expectedId: string) {
  const assistant = out[0] as unknown as { role?: string; content?: unknown };
  expect(assistant.role).toBe("assistant");
  expect(Array.isArray(assistant.content)).toBe(true);
  const toolCall = (assistant.content as Array<{ type?: string; id?: string }>).find(
    (block) => block.type === "toolCall",
  );
  expect(toolCall?.id).toBe(expectedId);

  const toolResult = out[1] as unknown as {
    role?: string;
    toolCallId?: string;
  };
  expect(toolResult.role).toBe("toolResult");
  expect(toolResult.toolCallId).toBe(expectedId);
}

function expectSingleAssistantContentEntry(
  out: AgentMessage[],
  expectEntry: (entry: { type?: string; text?: string }) => void,
) {
  expect(out).toHaveLength(1);
  const content = (out[0] as { content?: unknown }).content;
  expect(Array.isArray(content)).toBe(true);
  expect(content).toHaveLength(1);
  expectEntry((content as Array<{ type?: string; text?: string }>)[0] ?? {});
}

describe("sanitizeSessionMessagesImages", () => {
  it("keeps tool call + tool result IDs unchanged by default", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectToolCallAndResultIds(out, "call_123|fc_456");
  });

  it("sanitizes tool call + tool result IDs in strict mode (alphanumeric only)", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    expectToolCallAndResultIds(out, "call123fc456");
  });

  it("does not synthesize tool call input when missing", async () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");
    const assistant = out[0] as { content?: Array<Record<string, unknown>> };
    const toolCall = assistant.content?.find((b) => b.type === "toolCall");
    expect(toolCall).toBeTruthy();
    expect("input" in (toolCall ?? {})).toBe(false);
    expect((toolCall as { arguments?: unknown } | undefined)?.arguments).toBeUndefined();
  });

  it("removes empty assistant text blocks but preserves tool calls", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectSingleAssistantContentEntry(out, (entry) => {
      expect(entry.type).toBe("toolCall");
    });
  });

  it("sanitizes tool ids in strict mode (alphanumeric only)", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_abc|item:123", name: "test", input: {} },
          {
            type: "toolCall",
            id: "call_abc|item:456",
            name: "exec",
            arguments: {},
          },
        ],
      },
      {
        role: "toolResult",
        toolUseId: "call_abc|item:123",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    const assistant = out[0] as { content?: Array<{ id?: string }> };
    expect(assistant.content?.[0]?.id).toBe("callabcitem123");
    expect(assistant.content?.[1]?.id).toBe("callabcitem456");

    const toolResult = out[1] as { toolUseId?: string };
    expect(toolResult.toolUseId).toBe("callabcitem123");
  });

  it("does not sanitize tool IDs in images-only mode", async () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_123|fc_456", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    const assistant = out[0] as unknown as { content?: Array<{ type?: string; id?: string }> };
    const toolCall = assistant.content?.find((b) => b.type === "toolCall");
    expect(toolCall?.id).toBe("call_123|fc_456");

    const toolResult = out[1] as unknown as { toolCallId?: string };
    expect(toolResult.toolCallId).toBe("call_123|fc_456");
  });
  it("filters whitespace-only assistant text blocks", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "ok" },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectSingleAssistantContentEntry(out, (entry) => {
      expect(entry.text).toBe("ok");
    });
  });
  it("drops assistant messages that only contain empty text", async () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });
  it("preserves delivery-mirror assistant transcript messages", async () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        stopReason: "stop",
        content: [{ type: "text", text: "file-name.pptx" }],
      },
      { role: "assistant", content: [{ type: "text", text: "real reply" }] },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toEqual(input);
  });
  it("materializes empty assistant error messages into text", async () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "400 Request failed",
        content: [],
      },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "",
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
    expect(out[2]?.role).toBe("assistant");
    expect((out[1] as { content?: Array<{ type?: string; text?: string }> }).content).toEqual([
      { type: "text", text: "HTTP 400: Request failed" },
    ]);
    expect((out[2] as { content?: Array<{ type?: string; text?: string }> }).content).toEqual([
      { type: "text", text: "LLM request failed with an unknown error." },
    ]);
  });
  it("preserves silent openai-responses completions as materialized errors during sanitize", async () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 0,
        content: [],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
    expect((out[1] as { stopReason?: string }).stopReason).toBe("error");
    expect((out[1] as { errorMessage?: string }).errorMessage).toContain(
      "without response.completed or assistant output",
    );
    expect((out[1] as { content?: Array<{ type?: string; text?: string }> }).content).toEqual([
      {
        type: "text",
        text: "OpenAI Responses stream ended without response.completed or assistant output.",
      },
    ]);
  });
  it("converts empty openai-responses stop messages with zero usage into errors", () => {
    const out = normalizeSilentAssistantCompletionMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 0,
      content: [],
    });

    expect(out.stopReason).toBe("error");
    expect(out.errorMessage).toContain("without response.completed or assistant output");
  });
  it("keeps empty openai-responses stop messages when usage is nonzero", () => {
    const out = normalizeSilentAssistantCompletionMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      stopReason: "stop",
      usage: {
        input: 10,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 0,
      content: [],
    });

    expect(out.stopReason).toBe("stop");
    expect(out.errorMessage).toBeUndefined();
  });
  it("leaves non-assistant messages unchanged", async () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "result" }],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("toolResult");
  });

  describe("thought_signature stripping", () => {
    it("strips msg_-prefixed thought_signature from assistant message content blocks", async () => {
      const input = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "hello", thought_signature: "msg_abc123" },
            {
              type: "thinking",
              thinking: "reasoning",
              thought_signature: "AQID",
            },
          ],
        },
      ] as unknown as AgentMessage[];

      const out = await sanitizeSessionMessagesImages(input, "test");

      expect(out).toHaveLength(1);
      const content = (out[0] as { content?: unknown[] }).content;
      expect(content).toHaveLength(2);
      expect("thought_signature" in ((content?.[0] ?? {}) as object)).toBe(false);
      expect((content?.[1] as { thought_signature?: unknown })?.thought_signature).toBe("AQID");
    });
  });
});

describe("sanitizeGoogleTurnOrdering", () => {
  it("prepends a synthetic user turn when history starts with assistant", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeGoogleTurnOrdering(input);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });
  it("is a no-op when history starts with user", () => {
    const input = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
    const out = sanitizeGoogleTurnOrdering(input);
    expect(out).toBe(input);
  });
});
