import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const piCodingAgentMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((_message: unknown) => 100),
  generateSummary: vi.fn(async () => "summary"),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    estimateTokens: piCodingAgentMocks.estimateTokens,
    generateSummary: piCodingAgentMocks.generateSummary,
  };
});

import { pruneMessagesForSummarizationBudget, summarizeInStages } from "./compaction.js";

function makeUser(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

describe("compaction input budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prunes older messages to the summarization budget and prepends a deterministic note", () => {
    const messages = [
      makeUser("one", 1),
      makeUser("two", 2),
      makeUser("three", 3),
      makeUser("four", 4),
    ];

    const result = pruneMessagesForSummarizationBudget({
      messages,
      contextWindow: 400,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(result.droppedMessages).toBe(2);
    expect(result.budgetTokens).toBe(200);
    expect(result.droppedNote).toContain("Summarization input pruned");
    expect(result.messages[0]?.role).toBe("user");
    expect((result.messages[0] as { content?: string }).content).toBe(result.droppedNote);
  });

  it("limits generated summary chunks and represents omitted chunks deterministically", async () => {
    const messages = Array.from({ length: 8 }, (_, index) => makeUser(`message ${index}`, index));

    await summarizeInStages({
      messages,
      model: { id: "mock", name: "mock", contextWindow: 10_000, maxTokens: 100 } as never,
      apiKey: "test",
      signal: new AbortController().signal,
      reserveTokens: 100,
      maxChunkTokens: 100,
      contextWindow: 10_000,
      parts: 1,
      maxChunks: 2,
    });

    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(2);
    const firstCall = piCodingAgentMocks.generateSummary.mock.calls.at(0) as unknown[] | undefined;
    const firstChunk = firstCall?.[0] as AgentMessage[];
    expect((firstChunk[0] as { content?: string }).content).toContain("Summarization input pruned");
  });
});
