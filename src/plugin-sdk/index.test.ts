import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("plugin-sdk exports", () => {
  it("exports parent WebChat session predicates for bundled plugins", () => {
    expect(sdk.isParentWebchatSessionKey("agent:main:webchat:default:session-1")).toBe(true);
    expect(
      sdk.isParentWebchatSessionContext({
        channel: "internal",
        sessionKey: "agent:main:webchat:default:session-1",
      }),
    ).toBe(true);
  });

  it("exports safe file access for bundled plugins", () => {
    expect(sdk.SafeOpenError).toBeTypeOf("function");
    expect(sdk.openFileWithinRoot).toBeTypeOf("function");
  });

  it("does not expose runtime modules", () => {
    const forbidden = [
      "chunkMarkdownText",
      "chunkText",
      "resolveTextChunkLimit",
      "hasControlCommand",
      "isControlCommandMessage",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
      "buildMentionRegexes",
      "matchesMentionPatterns",
      "resolveStateDir",
      "loadConfig",
      "writeConfigFile",
      "runCommandWithTimeout",
      "enqueueSystemEvent",
      "fetchRemoteMedia",
      "saveMediaBuffer",
      "formatAgentEnvelope",
      "buildPairingReply",
      "resolveAgentRoute",
      "dispatchReplyFromConfig",
      "createReplyDispatcherWithTyping",
      "dispatchReplyWithBufferedBlockDispatcher",
      "resolveCommandAuthorizedFromAuthorizers",
      "monitorSlackProvider",
      "monitorTelegramProvider",
      "monitorIMessageProvider",
      "monitorSignalProvider",
      "sendMessageSlack",
      "sendMessageTelegram",
      "sendMessageIMessage",
      "sendMessageSignal",
      "sendMessageWhatsApp",
      "probeSlack",
      "probeTelegram",
      "probeIMessage",
      "probeSignal",
    ];

    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(sdk, key)).toBe(false);
    }
  });
});
