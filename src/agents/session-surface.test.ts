import { describe, expect, it } from "vitest";
import { isParentWebchatSessionContext, isParentWebchatSessionKey } from "./session-surface.js";

describe("isParentWebchatSessionKey", () => {
  it.each([
    ["agent:main:webchat:namespace:chat_1", true],
    ["agent::webchat:namespace:chat_1", false],
    ["agent:main:webchat::chat_1", false],
    ["agent:main:webchat:namespace:", false],
    ["agent:main:webchat:chat_1", false],
    ["agent:main:webchat:namespace:chat_1:extra", false],
    ["agent:main:subagent:child_1", false],
  ])("classifies %s as %s", (sessionKey, expected) => {
    expect(isParentWebchatSessionKey(sessionKey)).toBe(expected);
  });
});

describe("isParentWebchatSessionContext", () => {
  const sessionKey = "agent:main:webchat:namespace:chat_1";

  it.each([
    ["webchat", sessionKey, true],
    ["internal", sessionKey, true],
    [" WebChat ", sessionKey, true],
    ["feishu", sessionKey, false],
    ["control-ui", sessionKey, false],
    [undefined, sessionKey, false],
    ["internal", "agent:main:main", false],
    ["internal", "agent:main:subagent:child_1", false],
  ])("classifies channel=%s sessionKey=%s as %s", (channel, key, expected) => {
    expect(isParentWebchatSessionContext({ channel, sessionKey: key })).toBe(expected);
  });
});
