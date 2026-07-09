import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getLatestCompactionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { appendEmergencyCompaction, resolveFirstKeptEntryId } from "./emergency-compaction.js";

function user(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function assistant(content: string): AgentMessage {
  return {
    role: "assistant",
    content,
    provider: "openai",
    model: "gpt-test",
  } as unknown as AgentMessage;
}

function assistantToolCall(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
    provider: "openai",
    model: "gpt-test",
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string, toolName = "exec"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function toolResultWithDetails(
  toolCallId: string,
  text: string,
  toolName: string,
  details: Record<string, unknown>,
): AgentMessage {
  return {
    ...(toolResult(toolCallId, text, toolName) as unknown as Record<string, unknown>),
    details,
  } as unknown as AgentMessage;
}

function getToolResultText(messages: AgentMessage[], toolCallId: string): string {
  const message = messages.find(
    (msg) =>
      msg.role === "toolResult" && (msg as { toolCallId?: string }).toolCallId === toolCallId,
  );
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  return typeof textBlock?.text === "string" ? textBlock.text : "";
}

function appendAgentMessage(sm: SessionManager, message: AgentMessage): string {
  return sm.appendMessage(message as unknown as Message);
}

describe("emergency compaction", () => {
  it("maps kept message boundaries to session entry ids while skipping non-context entries", () => {
    const sm = SessionManager.inMemory();
    const firstUser = appendAgentMessage(sm, user("old"));
    sm.appendModelChange("openai", "gpt-test");
    const secondUser = appendAgentMessage(sm, user("recent"));
    sm.appendThinkingLevelChange("high");
    appendAgentMessage(sm, assistant("answer"));

    expect(resolveFirstKeptEntryId(sm.getBranch(), 0)).toBe(firstUser);
    expect(resolveFirstKeptEntryId(sm.getBranch(), 1)).toBe(secondUser);
  });

  it("appends a local compaction entry without model calls and keeps the latest user turn", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    const recentUser = appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-1",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.appended).toBe(true);
    expect(result.originalFirstKeptEntryId).toBe(recentUser);
    expect(result.firstKeptEntryId).not.toBe(recentUser);
    const latest = getLatestCompactionEntry(sm.getEntries());
    expect(latest?.summary).toContain("Emergency compaction");
    expect(latest?.firstKeptEntryId).toBe(result.firstKeptEntryId);
    expect(result.rebuiltMessages.map((msg) => msg.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
  });

  it("does not append twice when a matching emergency compaction already exists", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));
    const preLeafId = sm.getLeafId();

    const first = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-2",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preLeafId,
      preCompactionCount: 0,
    });
    const entriesAfterFirst = sm.getEntries().length;
    const second = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-2",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preLeafId,
      preCompactionCount: 0,
    });

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(sm.getEntries()).toHaveLength(entriesAfterFirst);
  });

  it("drops orphan tool results for OpenAI-compatible providers without adding synthetic results", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, toolResult("missing-call", "orphaned"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-3",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.rebuiltMessages.some((msg) => msg.role === "toolResult")).toBe(false);
  });

  it("preserves custom message context in the retained emergency tail", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    sm.appendCustomMessageEntry("test:context", "extension context survives", false, {
      source: "test",
    });
    appendAgentMessage(sm, assistant("current answer"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-custom-message",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.appended).toBe(true);
    expect(result.rebuiltMessages.map((msg) => msg.role)).toEqual([
      "compactionSummary",
      "user",
      "custom",
      "assistant",
    ]);
    const custom = result.rebuiltMessages.find((msg) => msg.role === "custom") as
      | (AgentMessage & { customType?: string; content?: unknown; display?: boolean })
      | undefined;
    expect(custom?.customType).toBe("test:context");
    expect(custom?.content).toBe("extension context survives");
    expect(custom?.display).toBe(false);
    expect(
      sm
        .getEntries()
        .some((entry) => entry.type === "custom_message" && entry.customType === "test:context"),
    ).toBe(true);
  });

  it("explicitly replays retained branch summaries instead of filtering them out", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    const currentUser = appendAgentMessage(sm, user("current request"));
    sm.branchWithSummary(currentUser, "summary from another branch", { source: "test" }, true);
    appendAgentMessage(sm, assistant("current answer"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-branch-summary",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.appended).toBe(true);
    expect(result.rebuiltMessages.map((msg) => msg.role)).toEqual([
      "compactionSummary",
      "user",
      "branchSummary",
      "assistant",
    ]);
    const branchSummary = result.rebuiltMessages.find((msg) => msg.role === "branchSummary") as
      | (AgentMessage & { summary?: string })
      | undefined;
    expect(branchSummary?.summary).toBe("summary from another branch");
  });

  it("falls back to the latest user turn when the requested recent-turn slice exceeds tail budget", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("large prior request " + "x".repeat(80_000)));
    appendAgentMessage(sm, assistant("large prior answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-tail-budget",
      reason: "timeout",
      contextWindowTokens: 10_000,
      keepRecentTokens: 50_000,
      keepRecentUserTurns: 2,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.rebuiltMessages.map((msg) => msg.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(result.rebuiltMessages)).not.toContain("large prior request");
  });

  it("truncates tool results inside the latest user turn when that turn exceeds tail budget", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistantToolCall("call_big", "web_fetch"));
    appendAgentMessage(sm, toolResult("call_big", "w".repeat(120_000), "web_fetch"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-truncate-turn",
      reason: "timeout",
      contextWindowTokens: 10_000,
      keepRecentTokens: 50_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    const text = getToolResultText(result.rebuiltMessages, "call_big");
    expect(text.length).toBeLessThan(120_000);
    expect(text.length).toBeLessThanOrEqual(1_200);
    expect(text).toContain("truncated");
    expect(getLatestCompactionEntry(sm.getEntries())?.summary).toContain(
      "Dropped Large Tool Outputs",
    );
  });

  it("does not copy tool result details into prompt-facing emergency summaries", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("large prior request " + "x".repeat(80_000)));
    appendAgentMessage(sm, assistantToolCall("call_secret", "exec"));
    appendAgentMessage(
      sm,
      toolResultWithDetails("call_secret", "s".repeat(120_000), "exec", {
        url: "https://example.invalid/?token=secret-query-token",
        path: "/tmp/secret-output.txt",
        command: "curl -H 'Authorization: Bearer secret-token'",
        status: "success",
        exitCode: 0,
      }),
    );
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));

    await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-secret-details",
      reason: "timeout",
      contextWindowTokens: 10_000,
      keepRecentTokens: 50_000,
      keepRecentUserTurns: 2,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    const summary = getLatestCompactionEntry(sm.getEntries())?.summary ?? "";
    expect(summary).toContain("tool=exec");
    expect(summary).toContain("id=call_secret");
    expect(summary).toContain("originalChars=");
    expect(summary).not.toContain("secret-query-token");
    expect(summary).not.toContain("/tmp/secret-output.txt");
    expect(summary).not.toContain("Authorization");
    expect(summary).not.toContain("status=success");
    expect(summary).not.toContain("exitCode=0");
  });

  it("does not append when a normal SDK compaction landed after the baseline", async () => {
    const sm = SessionManager.inMemory();
    const firstUser = appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));

    // Simulate a late-settling normal SDK compaction committing after our baseline.
    sm.appendCompaction("normal SDK summary", firstUser, 1000, {}, true);

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-late-normal",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.appended).toBe(false);
    expect(result.reason).toBe("already_compacted");
    const compactions = sm.getEntries().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toBe("normal SDK summary");
  });

  it("re-checks the compaction watermark before replaying the emergency tail", async () => {
    const sm = SessionManager.inMemory();
    const firstUser = appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));
    const originalGetEntries = sm.getEntries.bind(sm);
    let getEntriesCalls = 0;
    vi.spyOn(sm, "getEntries").mockImplementation(() => {
      getEntriesCalls += 1;
      if (getEntriesCalls === 2) {
        sm.appendCompaction("late SDK summary", firstUser, 1000, {}, true);
      }
      return originalGetEntries();
    });

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-late-before-replay",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.appended).toBe(false);
    expect(result.reason).toBe("already_compacted");
    const compactions = originalGetEntries().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toBe("late SDK summary");
  });

  it("restores the pre-replay leaf when a compaction lands after replay", async () => {
    const sm = SessionManager.inMemory();
    const firstUser = appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistant("current answer"));
    const preReplayBranchIds = sm.getBranch().map((entry) => entry.id);
    const preLeafId = sm.getLeafId();
    const originalGetEntries = sm.getEntries.bind(sm);
    let getEntriesCalls = 0;
    vi.spyOn(sm, "getEntries").mockImplementation(() => {
      getEntriesCalls += 1;
      if (getEntriesCalls === 3) {
        sm.appendCompaction("late SDK summary", firstUser, 1000, {}, true);
      }
      return originalGetEntries();
    });

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-late-after-replay",
      reason: "timeout",
      contextWindowTokens: 200_000,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    expect(result.appended).toBe(false);
    expect(result.reason).toBe("already_compacted");
    expect(sm.getLeafId()).toBe(preLeafId);
    expect(sm.getBranch().map((entry) => entry.id)).toEqual(preReplayBranchIds);
    const compactions = originalGetEntries().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toBe("late SDK summary");
  });

  it("still truncates the oversized tail when context window metadata is missing", async () => {
    const sm = SessionManager.inMemory();
    appendAgentMessage(sm, user("old request"));
    appendAgentMessage(sm, assistant("old answer"));
    appendAgentMessage(sm, user("current request"));
    appendAgentMessage(sm, assistantToolCall("call_big", "web_fetch"));
    appendAgentMessage(sm, toolResult("call_big", "w".repeat(120_000), "web_fetch"));

    const result = await appendEmergencyCompaction({
      sessionManager: sm,
      runId: "run-missing-window",
      reason: "timeout",
      contextWindowTokens: undefined as unknown as number,
      repairToolUseResultPairing: false,
      preCompactionCount: 0,
    });

    // A missing window must not produce a NaN budget that skips truncation and
    // leaves the oversized tail intact.
    const text = getToolResultText(result.rebuiltMessages, "call_big");
    expect(text.length).toBeLessThan(120_000);
    expect(text).toContain("truncated");
  });
});
