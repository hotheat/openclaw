import { describe, expect, it } from "vitest";
import {
  extractMessagingToolSend,
  extractToolErrorMessage,
} from "./pi-embedded-subscribe.tools.js";

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });
});

describe("extractMessagingToolSend", () => {
  it("preserves threadId for message sends", () => {
    expect(
      extractMessagingToolSend("message", {
        action: "send",
        provider: "telegram",
        to: "123",
        threadId: 42,
      }),
    ).toEqual({
      tool: "message",
      provider: "telegram",
      to: "123",
      threadId: 42,
    });
  });
});
