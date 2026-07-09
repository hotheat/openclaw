import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const compactionMocks = vi.hoisted(() => ({
  summarizeInStages: vi.fn(),
}));

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof import("../compaction.js")>("../compaction.js");
  return {
    ...actual,
    summarizeInStages: compactionMocks.summarizeInStages,
  };
});

import { SummaryCallBudgetExhaustedError } from "../compaction.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";

type SessionBeforeCompactHandler = (
  event: {
    preparation: {
      fileOps: { read: Set<string>; edited: Set<string>; written: Set<string> };
      messagesToSummarize: AgentMessage[];
      turnPrefixMessages: AgentMessage[];
      firstKeptEntryId: string;
      tokensBefore: number;
      settings: { reserveTokens: number };
      previousSummary?: string;
      isSplitTurn?: boolean;
    };
    customInstructions?: string;
    signal: AbortSignal;
  },
  ctx: {
    model?: { contextWindow?: number };
    modelRegistry: { getApiKey: (model: unknown) => Promise<string | undefined> };
    sessionManager: object;
  },
) => Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } }>;

function registerHandler(): SessionBeforeCompactHandler {
  let handler: SessionBeforeCompactHandler | undefined;
  compactionSafeguardExtension({
    on: (eventName: string, fn: SessionBeforeCompactHandler) => {
      if (eventName === "session_before_compact") {
        handler = fn;
      }
    },
  } as never);
  if (!handler) {
    throw new Error("handler not registered");
  }
  return handler;
}

describe("compaction-safeguard summary budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates per-phase budgeting to summarizeInStages and falls back on exhaustion", async () => {
    // The safeguard no longer creates a shared budget; each summarizeInStages phase
    // self-budgets. Simulate genuine exhaustion (the safety valve tripping) and verify
    // the handler still degrades to the truncation fallback instead of throwing.
    compactionMocks.summarizeInStages.mockImplementation(() => {
      throw new SummaryCallBudgetExhaustedError("compaction/generateSummary", {
        maxCalls: 0,
        usedCalls: 0,
      });
    });

    const handler = registerHandler();
    const result = await handler(
      {
        preparation: {
          fileOps: { read: new Set(), edited: new Set(), written: new Set() },
          messagesToSummarize: [{ role: "user", content: "old", timestamp: 1 }],
          turnPrefixMessages: [],
          firstKeptEntryId: "kept",
          tokensBefore: 1000,
          settings: { reserveTokens: 100 },
        },
        signal: new AbortController().signal,
      },
      {
        model: { contextWindow: 1000 },
        modelRegistry: { getApiKey: async () => "key" },
        sessionManager: {},
      },
    );

    expect(result.compaction.summary).toContain("Summary unavailable due to context limits");
    expect(result.compaction.firstKeptEntryId).toBe("kept");
    expect(compactionMocks.summarizeInStages).toHaveBeenCalledTimes(1);
    const firstCall = compactionMocks.summarizeInStages.mock.calls[0]?.[0] as
      | { summaryBudget?: unknown }
      | undefined;
    // No shared budget is forwarded — summarizeInStages owns per-phase budgeting now.
    expect(firstCall?.summaryBudget).toBeUndefined();
  });
});
