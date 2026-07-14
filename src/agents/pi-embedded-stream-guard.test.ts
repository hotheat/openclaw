import { describe, expect, it } from "vitest";
import {
  createAssistantStreamGuardState,
  createAssistantStreamLimitError,
  inspectAssistantStreamChunk,
  type AssistantStreamLimits,
} from "./pi-embedded-stream-guard.js";

const TEST_LIMITS: AssistantStreamLimits = {
  maxTotalChars: 20,
  maxConsecutiveWhitespaceChars: 8,
  maxConsecutiveWhitespaceEvents: 3,
  maxConsecutiveWhitespaceMs: 100,
};

describe("assistant stream guard", () => {
  it("preserves whitespace accounting and resets it after meaningful text", () => {
    const state = createAssistantStreamGuardState();

    expect(
      inspectAssistantStreamChunk({ state, chunk: "\n ", now: 10, limits: TEST_LIMITS }),
    ).toEqual({ whitespaceOnly: true });
    expect(
      inspectAssistantStreamChunk({ state, chunk: "answer", now: 20, limits: TEST_LIMITS }),
    ).toEqual({ whitespaceOnly: false });
    expect(state.consecutiveWhitespaceChars).toBe(0);
    expect(state.consecutiveWhitespaceEvents).toBe(0);
    expect(state.whitespaceStartedAt).toBeUndefined();
  });

  it("aborts after too many consecutive whitespace events", () => {
    const state = createAssistantStreamGuardState();

    for (let index = 0; index < TEST_LIMITS.maxConsecutiveWhitespaceEvents; index += 1) {
      expect(
        inspectAssistantStreamChunk({ state, chunk: " ", now: index, limits: TEST_LIMITS })
          .abortReason,
      ).toBeUndefined();
    }

    expect(
      inspectAssistantStreamChunk({ state, chunk: " ", now: 4, limits: TEST_LIMITS }).abortReason,
    ).toBe("consecutive_whitespace_events");
  });

  it("aborts on whitespace bytes, duration, and total output", () => {
    const whitespaceBytesState = createAssistantStreamGuardState();
    expect(
      inspectAssistantStreamChunk({
        state: whitespaceBytesState,
        chunk: " ".repeat(9),
        limits: TEST_LIMITS,
      }).abortReason,
    ).toBe("consecutive_whitespace_chars");

    const durationState = createAssistantStreamGuardState();
    inspectAssistantStreamChunk({
      state: durationState,
      chunk: " ",
      now: 10,
      limits: TEST_LIMITS,
    });
    expect(
      inspectAssistantStreamChunk({
        state: durationState,
        chunk: " ",
        now: 111,
        limits: TEST_LIMITS,
      }).abortReason,
    ).toBe("consecutive_whitespace_duration");

    const totalState = createAssistantStreamGuardState();
    expect(
      inspectAssistantStreamChunk({
        state: totalState,
        chunk: "x".repeat(21),
        limits: TEST_LIMITS,
      }).abortReason,
    ).toBe("total_chars");
  });

  it("creates a diagnostic abort error", () => {
    const state = createAssistantStreamGuardState();
    state.totalChars = 12;
    state.consecutiveWhitespaceChars = 9;
    state.consecutiveWhitespaceEvents = 4;

    const error = createAssistantStreamLimitError({
      reason: "consecutive_whitespace_events",
      state,
    });

    expect(error.name).toBe("AssistantStreamLimitError");
    expect(error.message).toContain("whitespaceEvents=4");
  });
});
