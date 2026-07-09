import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  truncateToolResultText,
  truncateToolResultMessage,
  calculateMaxToolResultChars,
  getToolResultTextLength,
  truncateOversizedToolResultsInMessages,
  isOversizedToolResult,
  sessionLikelyHasOversizedToolResults,
  HARD_MAX_TOOL_RESULT_CHARS,
} from "./tool-result-truncation.js";

function makeToolResult(text: string, toolCallId = "call_1", toolName = "read"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

describe("truncateToolResultText", () => {
  it("returns text unchanged when under limit", () => {
    const text = "hello world";
    expect(truncateToolResultText(text, 1000)).toBe(text);
  });

  it("truncates text that exceeds limit", () => {
    const text = "a".repeat(10_000);
    const result = truncateToolResultText(text, 5_000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("truncated");
  });

  it("preserves at least MIN_KEEP_CHARS (2000) when the limit allows it", () => {
    const text = "x".repeat(50_000);
    const result = truncateToolResultText(text, 3_000);
    expect(result.length).toBeGreaterThan(2000);
  });

  it("tries to break at newline boundary", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n");
    const result = truncateToolResultText(lines, 3000);
    // Should contain truncation notice
    expect(result).toContain("truncated");
    // The truncated content should be shorter than the original
    expect(result.length).toBeLessThan(lines.length);
    // Extract the kept content (before the truncation suffix marker)
    const suffixIndex = result.indexOf("\n\n⚠️");
    if (suffixIndex > 0) {
      const keptContent = result.slice(0, suffixIndex);
      // Should end at a newline boundary (i.e., the last char before suffix is a complete line)
      const lastNewline = keptContent.lastIndexOf("\n");
      // The last newline should be near the end (within the last line)
      expect(lastNewline).toBeGreaterThan(keptContent.length - 100);
    }
  });

  it("supports custom suffix and min keep chars", () => {
    const text = "x".repeat(5_000);
    const result = truncateToolResultText(text, 300, {
      suffix: "\n\n[custom-truncated]",
      minKeepChars: 250,
    });
    expect(result).toContain("[custom-truncated]");
    expect(result.length).toBeGreaterThan(250);
  });
});

describe("getToolResultTextLength", () => {
  it("sums all text blocks in tool results", () => {
    const msg = {
      role: "toolResult",
      content: [
        { type: "text", text: "abc" },
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "x" } },
        { type: "text", text: "12345" },
      ],
    } as unknown as AgentMessage;

    expect(getToolResultTextLength(msg)).toBe(8);
  });

  it("returns zero for non-toolResult messages", () => {
    expect(getToolResultTextLength(makeAssistantMessage("hello"))).toBe(0);
  });
});

describe("truncateToolResultMessage", () => {
  it("truncates with a custom suffix", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(50_000) }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const result = truncateToolResultMessage(msg, 10_000, {
      suffix: "\n\n[persist-truncated]",
      minKeepChars: 2_000,
    }) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0]?.text).toContain("[persist-truncated]");
  });

  it("keeps head and tail content and records truncation metadata", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: [
        { type: "text", text: `${"h".repeat(20_000)}${"m".repeat(10_000)}${"t".repeat(20_000)}` },
      ],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const result = truncateToolResultMessage(msg, 10_000, { toolName: "exec" }) as {
      content: Array<{ type: string; text: string }>;
      openclawToolResultTruncation?: {
        toolName?: string;
        originalChars: number;
        keptHeadChars: number;
        keptTailChars: number;
        truncatedAt: string;
      };
    };

    expect(result.content[0]?.text.startsWith("h".repeat(100))).toBe(true);
    expect(result.content[0]?.text.endsWith("t".repeat(100))).toBe(true);
    expect(result.openclawToolResultTruncation).toMatchObject({
      toolName: "exec",
      originalChars: 50_000,
    });
    expect(result.openclawToolResultTruncation?.keptHeadChars).toBeGreaterThan(0);
    expect(result.openclawToolResultTruncation?.keptTailChars).toBeGreaterThan(0);
    expect(Date.parse(result.openclawToolResultTruncation?.truncatedAt ?? "")).not.toBeNaN();
  });

  it("does not count image blocks toward text truncation", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "x".repeat(100_000) },
        },
        { type: "text", text: "small text" },
      ],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(truncateToolResultMessage(msg, 1_000)).toBe(msg);
  });
});

describe("calculateMaxToolResultChars", () => {
  it("scales with context window size", () => {
    const small = calculateMaxToolResultChars(32_000, "read");
    const large = calculateMaxToolResultChars(200_000, "read");
    expect(large).toBeGreaterThan(small);
  });

  it("caps at HARD_MAX_TOOL_RESULT_CHARS for very large windows", () => {
    const result = calculateMaxToolResultChars(2_000_000, "read"); // 2M token window
    expect(result).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS);
  });

  it("uses a 4% text cap for read/file tools", () => {
    expect(calculateMaxToolResultChars(128_000, "read")).toBe(20_480);
    expect(calculateMaxToolResultChars(2_000_000, "read_file")).toBe(40_000);
  });

  it("uses a stricter 3% cap for web, exec, and unknown tools", () => {
    expect(calculateMaxToolResultChars(128_000, "web_fetch")).toBe(15_360);
    expect(calculateMaxToolResultChars(2_000_000, "exec")).toBe(20_000);
    expect(calculateMaxToolResultChars(2_000_000)).toBe(20_000);
  });
});

describe("isOversizedToolResult", () => {
  it("returns false for small tool results", () => {
    const msg = makeToolResult("small content");
    expect(isOversizedToolResult(msg, 200_000)).toBe(false);
  });

  it("returns true for oversized tool results", () => {
    const msg = makeToolResult("x".repeat(50_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(true);
  });

  it("returns false for non-toolResult messages", () => {
    const msg = makeUserMessage("x".repeat(500_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(false);
  });
});

describe("truncateOversizedToolResultsInMessages", () => {
  it("returns unchanged messages when nothing is oversized", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("using tool"),
      makeToolResult("small result"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
    );
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("truncates oversized tool results", () => {
    const bigContent = "x".repeat(50_000);
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult(bigContent),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(1);
    const toolResult = result[2] as { content: Array<{ text: string }> };
    expect(toolResult.content[0].text.length).toBeLessThan(bigContent.length);
    expect(toolResult.content[0].text.length).toBeLessThanOrEqual(20_480);
    expect(toolResult.content[0].text).toContain("truncated");
  });

  it("preserves non-toolResult messages", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult("x".repeat(50_000)),
    ];
    const { messages: result } = truncateOversizedToolResultsInMessages(messages, 128_000);
    expect(result[0]).toBe(messages[0]); // Same reference
    expect(result[1]).toBe(messages[1]); // Same reference
  });

  it("handles multiple oversized tool results", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading files"),
      makeToolResult("x".repeat(50_000), "call_1"),
      makeToolResult("y".repeat(50_000), "call_2"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(2);
    for (const msg of result.slice(2)) {
      const tr = msg as { content: Array<{ text: string }> };
      expect(tr.content[0].text.length).toBeLessThan(50_000);
    }
  });

  it("uses tool-specific caps when truncating in-memory messages", () => {
    const messages = [makeToolResult("x".repeat(50_000), "call_1", "web_fetch")];
    const { messages: result } = truncateOversizedToolResultsInMessages(messages, 2_000_000);
    const toolResult = result[0] as { content: Array<{ text: string }> };

    expect(toolResult.content[0]?.text.length).toBeLessThanOrEqual(20_000);
  });
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it("returns false when no tool results are oversized", () => {
    const messages = [makeUserMessage("hello"), makeToolResult("small result")];
    expect(
      sessionLikelyHasOversizedToolResults({
        messages,
        contextWindowTokens: 200_000,
      }),
    ).toBe(false);
  });

  it("returns true when a tool result is oversized", () => {
    const messages = [makeUserMessage("hello"), makeToolResult("x".repeat(50_000))];
    expect(
      sessionLikelyHasOversizedToolResults({
        messages,
        contextWindowTokens: 128_000,
      }),
    ).toBe(true);
  });

  it("returns false for empty messages", () => {
    expect(
      sessionLikelyHasOversizedToolResults({
        messages: [],
        contextWindowTokens: 200_000,
      }),
    ).toBe(false);
  });
});
