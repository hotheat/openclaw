import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
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
    expect(sdk.FsSafeError).toBeTypeOf("function");
    expect(sdk.root).toBeTypeOf("function");
  });

  it("keeps legacy safe-open exports compatible for external plugins", async () => {
    await withTempDir("openclaw-plugin-sdk-fs-safe-", async (rootDir) => {
      await fs.writeFile(path.join(rootDir, "fixture.txt"), "fixture", "utf8");

      const opened = await sdk.openFileWithinRoot({
        rootDir,
        relativePath: "fixture.txt",
      });
      try {
        expect(await opened.handle.readFile("utf8")).toBe("fixture");
      } finally {
        await opened.handle.close();
      }

      await expect(
        sdk.openFileWithinRoot({
          rootDir,
          relativePath: "../outside.txt",
        }),
      ).rejects.toMatchObject({
        name: "SafeOpenError",
        code: "invalid-path",
      });
    });
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
