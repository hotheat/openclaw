import { describe, expect, it } from "vitest";
import {
  assessRunCompletion,
  buildCompletionContinuationPrompt,
  isCompletionContractEnabled,
} from "./completion.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed: "session-1",
    systemPromptReport: undefined,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    lastToolError: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    successfulCronAdds: 0,
    cloudCodeAssistFormatError: false,
    attemptUsage: undefined,
    compactionCount: 0,
    clientToolCall: undefined,
    ...overrides,
  };
}

describe("run completion assessment", () => {
  it("returns tool_calls when a client tool call is pending", () => {
    const assessment = assessRunCompletion(
      makeAttemptResult({
        clientToolCall: { name: "web_search", params: { q: "x" } },
      }),
    );

    expect(assessment.classification).toBe("tool_calls");
  });

  it("returns completed when a user-facing reply exists", () => {
    const assessment = assessRunCompletion(
      makeAttemptResult({
        assistantTexts: ["已完成。结论是 A。"],
      }),
    );

    expect(assessment.classification).toBe("completed");
  });

  it("returns empty_result when no user-facing reply exists", () => {
    const assessment = assessRunCompletion(makeAttemptResult());

    expect(assessment.classification).toBe("empty_result");
    expect(assessment.recoveryAction).toBe("retry_same_step");
  });

  it("does not treat finished instructions containing common progress words as incomplete", () => {
    const assessment = assessRunCompletion(
      makeAttemptResult({
        assistantTexts: [
          "Checks are complete. To continue locally, run pnpm test. Retries continued because the provider returned 429, and the final fix is now in place.",
        ],
      }),
    );

    expect(assessment.classification).toBe("completed");
  });

  it("returns failed_but_incomplete when tool failure is followed only by promise text", () => {
    const assessment = assessRunCompletion(
      makeAttemptResult({
        assistantTexts: ["我会继续重试并补充结果。"],
        lastToolError: {
          toolName: "web_fetch",
          error: "403 blocked",
        },
      }),
    );

    expect(assessment.classification).toBe("failed_but_incomplete");
    expect(assessment.recoveryAction).toBe("switch_strategy");
  });

  it("returns non_terminal_text for progress-only commentary", () => {
    const assessment = assessRunCompletion(
      makeAttemptResult({
        assistantTexts: ["正在整理信息，下一步继续分析。"],
      }),
    );

    expect(assessment.classification).toBe("non_terminal_text");
    expect(assessment.recoveryAction).toBe("retry_same_step");
  });

  it("enables the contract only for researcher and subagent runs", () => {
    expect(isCompletionContractEnabled({ sessionKey: "agent:main:subagent:abc" })).toBe(true);
    expect(isCompletionContractEnabled({ agentId: "researcher" })).toBe(true);
    expect(isCompletionContractEnabled({ sessionKey: "agent:main:main", agentId: "main" })).toBe(
      false,
    );
  });

  it("builds a stricter prompt on the last retry", () => {
    const prompt = buildCompletionContinuationPrompt({
      assessment: {
        classification: "failed_but_incomplete",
        recoveryAction: "switch_strategy",
        reason: "tool failed and assistant only promised follow-up work",
      },
      attempt: makeAttemptResult({
        lastToolError: {
          toolName: "web_fetch",
          error: "timeout",
        },
      }),
      retryIndex: 1,
    });

    expect(prompt).toContain("Recent tool failure: web_fetch - timeout.");
    expect(prompt).toContain("This is the last retry.");
  });
});
