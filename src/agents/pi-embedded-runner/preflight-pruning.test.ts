import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateAgentMessagesTokens } from "./message-token-estimate.js";
import { pruneMessagesBeforePreflight } from "./preflight-pruning.js";

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeAssistantToolCall(id: string, name = "read"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeToolResult(id: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function getToolResultText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  return typeof textBlock?.text === "string" ? textBlock.text : "";
}

describe("pruneMessagesBeforePreflight", () => {
  it("returns the same messages when history is below the target budget", () => {
    const messages = [makeUser("hello"), makeAssistant("ok")];

    const result = pruneMessagesBeforePreflight({
      messages,
      contextWindowTokens: 10_000,
      repairToolUseResultPairing: false,
    });

    expect(result.pruned).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.metrics.truncatedCount).toBe(0);
  });

  it("soft trims old tool results while protecting recent assistant turns", () => {
    const recentToolText = "r".repeat(50_000);
    const messages = [
      makeAssistantToolCall("old", "read"),
      makeToolResult("old", "read", "x".repeat(50_000)),
      makeUser("next"),
      makeAssistant("done"),
      makeAssistantToolCall("recent", "read"),
      makeToolResult("recent", "read", recentToolText),
    ];

    const result = pruneMessagesBeforePreflight({
      messages,
      contextWindowTokens: 30_000,
      repairToolUseResultPairing: false,
      protectedAssistantTurns: 2,
    });

    expect(result.pruned).toBe(true);
    expect(result.metrics.truncatedCount).toBe(1);
    expect(getToolResultText(result.messages[1]).length).toBeLessThan(50_000);
    expect(getToolResultText(result.messages[5])).toBe(recentToolText);
  });

  it("hard clears older web and exec outputs when soft trimming is not enough", () => {
    const messages = [
      makeAssistantToolCall("web", "web_fetch"),
      {
        ...(makeToolResult("web", "web_fetch", "w".repeat(80_000)) as unknown as Record<
          string,
          unknown
        >),
        details: {
          url: "https://example.invalid/?token=secret",
          command: "curl -H 'Authorization: Bearer secret-token'",
        },
      } as unknown as AgentMessage,
      makeAssistantToolCall("exec", "exec"),
      makeToolResult("exec", "exec", "e".repeat(80_000)),
      makeUser("u".repeat(11_000)),
      makeAssistant("recent"),
      makeUser("tail"),
      makeAssistant("tail done"),
    ];

    const result = pruneMessagesBeforePreflight({
      messages,
      contextWindowTokens: 5_000,
      repairToolUseResultPairing: false,
      protectedAssistantTurns: 2,
    });

    expect(result.metrics.clearedCount).toBeGreaterThan(0);
    expect(result.metrics.toolResultCharsAfter).toBeLessThan(result.metrics.toolResultCharsBefore);
    expect(
      result.messages.some((message) =>
        getToolResultText(message).includes("pruned before prompt"),
      ),
    ).toBe(true);
    const cleared = result.messages.find((message) =>
      getToolResultText(message).includes("pruned before prompt"),
    ) as
      | {
          details?: unknown;
          openclawToolResultPruning?: {
            toolName?: string;
            originalChars?: number;
            keptChars?: number;
            action?: string;
          };
        }
      | undefined;
    expect(cleared?.details).toBeUndefined();
    expect(cleared?.openclawToolResultPruning).toMatchObject({
      action: "hard_clear",
      originalChars: 80_000,
    });
    expect(cleared?.openclawToolResultPruning).not.toHaveProperty("url");
    expect(cleared?.openclawToolResultPruning).not.toHaveProperty("command");
  });

  it("drops old prefixes through transcript repair so orphan tool results do not remain", () => {
    const messages = [
      makeAssistantToolCall("old", "read"),
      makeToolResult("old", "read", "x".repeat(50_000)),
      makeUser("u".repeat(40_000)),
      makeAssistant("older"),
      makeUser("tail"),
      makeAssistant("tail done"),
    ];

    const result = pruneMessagesBeforePreflight({
      messages,
      contextWindowTokens: 100,
      repairToolUseResultPairing: false,
      protectedAssistantTurns: 1,
    });

    expect(result.metrics.droppedCount).toBeGreaterThan(0);
    expect(result.messages[0]?.role).not.toBe("toolResult");
  });

  it("evaluates prefix drops from a stable baseline and keeps the minimum viable history", () => {
    const messages = [
      makeUser("older user " + "u".repeat(6_000)),
      makeAssistant("older assistant " + "a".repeat(6_000)),
      makeUser("middle user " + "m".repeat(4_000)),
      makeAssistant("protected assistant"),
    ];
    const dropOneTokens = estimateAgentMessagesTokens(messages.slice(1));
    const dropTwoTokens = estimateAgentMessagesTokens(messages.slice(2));
    const targetTokens = Math.floor((dropOneTokens + dropTwoTokens) / 2);

    expect(dropOneTokens).toBeGreaterThan(targetTokens);
    expect(dropTwoTokens).toBeLessThanOrEqual(targetTokens);

    const result = pruneMessagesBeforePreflight({
      messages,
      contextWindowTokens: targetTokens,
      repairToolUseResultPairing: false,
      protectedAssistantTurns: 1,
      targetRatio: 1,
    });

    expect(result.metrics.droppedCount).toBe(2);
    expect(result.messages).toEqual(messages.slice(2));
  });

  it("honors an explicit targetHistoryTokens over the default ratio", () => {
    const messages = [
      makeUser("older user " + "u".repeat(6_000)),
      makeAssistant("older assistant " + "a".repeat(6_000)),
      makeUser("middle user " + "m".repeat(4_000)),
      makeAssistant("protected assistant"),
    ];
    const keepFromTwoTokens = estimateAgentMessagesTokens(messages.slice(2));

    // A huge contextWindow would let the ratio path keep everything; the explicit
    // budget forces pruning down to the protected tail.
    const result = pruneMessagesBeforePreflight({
      messages,
      contextWindowTokens: 1_000_000,
      repairToolUseResultPairing: false,
      protectedAssistantTurns: 1,
      targetHistoryTokens: keepFromTwoTokens,
    });

    expect(result.pruned).toBe(true);
    expect(result.metrics.droppedCount).toBe(2);
    expect(result.messages).toEqual(messages.slice(2));
  });
});
