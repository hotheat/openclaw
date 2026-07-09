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

import {
  SummaryCallBudgetExhaustedError,
  createSummaryCallBudget,
  summarizeInStages,
} from "./compaction.js";

const stagedMessages: AgentMessage[] = [
  { role: "user", content: "one", timestamp: 1 },
  { role: "assistant", content: "two", timestamp: 2 } as unknown as AgentMessage,
  { role: "user", content: "three", timestamp: 3 },
  { role: "assistant", content: "four", timestamp: 4 } as unknown as AgentMessage,
];

describe("summary call budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes a staged summary when the per-phase budget is adequate", async () => {
    // No summaryBudget passed: summarizeInStages self-budgets (parts + 1) * maxChunks = 6,
    // which comfortably covers the staged path's 2 partial summaries + 1 merge (3 calls).
    // Previously a shared budget(2) deterministically exhausted here and fell back to
    // truncation, defeating context preservation.
    const result = await summarizeInStages({
      messages: stagedMessages,
      model: { id: "mock", name: "mock", contextWindow: 1000, maxTokens: 100 } as never,
      apiKey: "test",
      signal: new AbortController().signal,
      reserveTokens: 100,
      maxChunkTokens: 300,
      contextWindow: 100_000,
      parts: 2,
      minMessagesForSplit: 2,
    });

    expect(typeof result).toBe("string");
    // Two partial summaries + one merge of the partials.
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(3);
  });

  it("throws a recognizable error when an explicit budget is genuinely too small", async () => {
    // An explicitly tiny budget still trips the safety valve: the second partial chunk
    // cannot consume a slot, so summarizeInStages throws and the caller can fall back.
    const budget = createSummaryCallBudget(1);

    await expect(
      summarizeInStages({
        messages: stagedMessages,
        model: { id: "mock", name: "mock", contextWindow: 1000, maxTokens: 100 } as never,
        apiKey: "test",
        signal: new AbortController().signal,
        reserveTokens: 100,
        maxChunkTokens: 300,
        contextWindow: 100_000,
        parts: 2,
        minMessagesForSplit: 2,
        summaryBudget: budget,
      }),
    ).rejects.toBeInstanceOf(SummaryCallBudgetExhaustedError);

    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(1);
    expect(budget.usedCalls).toBe(1);
  });
});
