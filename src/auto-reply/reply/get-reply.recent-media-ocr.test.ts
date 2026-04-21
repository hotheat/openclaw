import path from "node:path";
import "../reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../../test/helpers/temp-home.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { getReplyFromConfig } from "./get-reply.js";

let blockedMediaUnderstandingMessageId: string | undefined;
let blockedMediaUnderstandingStarted: (() => void) | undefined;
let blockedMediaUnderstandingPromise: Promise<void> | undefined;

vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: vi.fn(async ({ ctx }) => {
    const messageId =
      typeof ctx.MessageSidFull === "string"
        ? ctx.MessageSidFull
        : typeof ctx.MessageSid === "string"
          ? ctx.MessageSid
          : undefined;
    const mediaPath =
      (Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0
        ? ctx.MediaPaths[0]
        : undefined) ?? ctx.MediaPath;
    if (
      mediaPath &&
      messageId &&
      blockedMediaUnderstandingMessageId &&
      messageId === blockedMediaUnderstandingMessageId &&
      blockedMediaUnderstandingPromise
    ) {
      blockedMediaUnderstandingStarted?.();
      blockedMediaUnderstandingStarted = undefined;
      blockedMediaUnderstandingMessageId = undefined;
      await blockedMediaUnderstandingPromise;
    }
    if (!mediaPath) {
      return {
        outputs: [],
        decisions: [],
        appliedImage: false,
        appliedAudio: false,
        appliedVideo: false,
        appliedFile: false,
      };
    }

    const rawUserText =
      (ctx.CommandBody ?? ctx.RawBody ?? ctx.BodyForCommands ?? ctx.Body ?? "")
        .replace(/^<media:[^>]+>(\s*\([^)]*\))?\s*/i, "")
        .trim() || undefined;
    const fileName = path.basename(mediaPath);
    const body = rawUserText
      ? `[Image]\nUser text:\n${rawUserText}\nDescription:\nOCR for ${fileName}`
      : `[Image]\nDescription:\nOCR for ${fileName}`;

    ctx.Body = body;
    ctx.BodyForAgent = body;
    ctx.MediaUnderstanding = [
      {
        kind: "image.description",
        attachmentIndex: 0,
        text: `OCR for ${fileName}`,
        provider: "mock",
        model: "mock-image-model",
      },
    ];
    if (rawUserText) {
      ctx.CommandBody = rawUserText;
      ctx.RawBody = rawUserText;
      ctx.BodyForCommands = rawUserText;
    }

    return {
      outputs: ctx.MediaUnderstanding,
      decisions: [
        {
          capability: "image",
          outcome: "success",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  provider: "mock",
                  model: "mock-image-model",
                  type: "provider",
                  outcome: "success",
                },
              ],
              chosen: {
                provider: "mock",
                model: "mock-image-model",
                type: "provider",
                outcome: "success",
              },
            },
          ],
        },
      ],
      appliedImage: true,
      appliedAudio: false,
      appliedVideo: false,
      appliedFile: false,
    };
  }),
}));

function makeResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockClear();
      vi.mocked(applyMediaUnderstanding).mockClear();
      blockedMediaUnderstandingMessageId = undefined;
      blockedMediaUnderstandingStarted = undefined;
      blockedMediaUnderstandingPromise = undefined;
      return await fn(home);
    },
    {
      env: {
        OPENCLAW_BUNDLED_SKILLS_DIR: (home) => path.join(home, "bundled-skills"),
        OPENCLAW_TEST_FAST: undefined,
      },
      prefix: "openclaw-recent-media-ocr-",
    },
  );
}

function makeCfg(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: path.join(home, "sessions.json") },
  } as unknown as OpenClawConfig;
}

function makeCtx(params: {
  body: string;
  sessionKey: string;
  senderId: string;
  messageSid?: string;
  mediaPath?: string;
  mediaType?: string;
}) {
  return {
    Body: params.body,
    BodyForAgent: params.body,
    RawBody: params.body,
    CommandBody: params.body,
    SessionKey: params.sessionKey,
    SenderId: params.senderId,
    AccountId: "default",
    MessageSid: params.messageSid,
    From: params.senderId,
    To: "whatsapp:+2000",
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp" as const,
    OriginatingTo: "whatsapp:+2000",
    MediaPath: params.mediaPath,
    MediaType: params.mediaType,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("getReplyFromConfig recent image OCR rehydration", () => {
  it("persists the recent image before OCR so a concurrent follow-up can rehydrate it", async () => {
    await withTempHome(async (home) => {
      const seenPrompts: string[] = [];
      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        seenPrompts.push(params.prompt);
        return makeResult("ok");
      });

      const cfg = makeCfg(home);
      const sessionKey = "agent:main:whatsapp:direct:user-1";
      let releaseBlockedMediaUnderstanding: (() => void) | undefined;
      blockedMediaUnderstandingMessageId = "msg-image-slow";
      blockedMediaUnderstandingPromise = new Promise<void>((resolve) => {
        releaseBlockedMediaUnderstanding = resolve;
      });
      const firstMediaUnderstandingStarted = new Promise<void>((resolve) => {
        blockedMediaUnderstandingStarted = resolve;
      });

      const firstReplyPromise = getReplyFromConfig(
        makeCtx({
          body: "<media:image>",
          sessionKey,
          senderId: "user-1",
          messageSid: "msg-image-slow",
          mediaPath: "/tmp/inbound-image.jpg",
          mediaType: "image/jpeg",
        }),
        {},
        cfg,
      );

      try {
        await withTimeout(
          firstMediaUnderstandingStarted,
          1_500,
          "timed out waiting for the first image OCR run to start",
        );

        const secondReply = await withTimeout(
          getReplyFromConfig(
            makeCtx({
              body: "解释这个图片",
              sessionKey,
              senderId: "user-1",
              messageSid: "msg-text-followup",
            }),
            {},
            cfg,
          ),
          1_500,
          "concurrent text follow-up did not finish while first image OCR was still running",
        );

        const text = Array.isArray(secondReply) ? secondReply[0]?.text : secondReply?.text;
        expect(text).toBe("ok");
        expect(vi.mocked(applyMediaUnderstanding)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(applyMediaUnderstanding).mock.calls[2]?.[0].ctx.MediaPath).toBe(
          "/tmp/inbound-image.jpg",
        );

        const finalPrompt = seenPrompts.at(-1) ?? "";
        expect(finalPrompt).toContain("[Image]");
        expect(finalPrompt).toContain("User text:\n解释这个图片");
        expect(finalPrompt).toContain("Description:\nOCR for inbound-image.jpg");
      } finally {
        releaseBlockedMediaUnderstanding?.();
        await withTimeout(
          firstReplyPromise,
          1_500,
          "timed out waiting for the blocked first image message to finish",
        );
      }
    });
  });

  it("reruns media understanding after a recent image is reattached", async () => {
    await withTempHome(async (home) => {
      const seenPrompts: string[] = [];
      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        seenPrompts.push(params.prompt);
        return makeResult("ok");
      });

      const cfg = makeCfg(home);
      const sessionKey = "agent:main:whatsapp:direct:user-1";

      await getReplyFromConfig(
        makeCtx({
          body: "<media:image>",
          sessionKey,
          senderId: "user-1",
          messageSid: "msg-image",
          mediaPath: "/tmp/inbound-image.jpg",
          mediaType: "image/jpeg",
        }),
        {},
        cfg,
      );

      const res = await getReplyFromConfig(
        makeCtx({
          body: "解释这个图片",
          sessionKey,
          senderId: "user-1",
          messageSid: "msg-text",
        }),
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(vi.mocked(applyMediaUnderstanding)).toHaveBeenCalledTimes(3);
      expect(vi.mocked(applyMediaUnderstanding).mock.calls[2]?.[0].ctx.MediaPath).toBe(
        "/tmp/inbound-image.jpg",
      );

      const finalPrompt = seenPrompts.at(-1) ?? "";
      expect(finalPrompt).toContain("[Image]");
      expect(finalPrompt).toContain("User text:\n解释这个图片");
      expect(finalPrompt).toContain("Description:\nOCR for inbound-image.jpg");
    });
  });
});
