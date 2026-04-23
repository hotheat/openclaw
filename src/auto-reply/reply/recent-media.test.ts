import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  attachRecentImageSnapshot,
  buildRecentImageSnapshot,
  shouldAttachRecentImageSnapshot,
} from "./recent-media.js";

describe("recent media helpers", () => {
  it("builds a recent image snapshot from inbound image media", () => {
    const snapshot = buildRecentImageSnapshot({
      MessageSid: "msg-image",
      SenderId: "user-1",
      AccountId: "default",
      MessageThreadId: "thread-1",
      MediaPath: "/tmp/input.png",
      MediaType: "image/png",
    });

    expect(snapshot).toEqual({
      kind: "image",
      messageId: "msg-image",
      messageIdFull: undefined,
      senderId: "user-1",
      accountId: "default",
      threadId: "thread-1",
      capturedAt: expect.any(Number),
      paths: ["/tmp/input.png"],
      urls: undefined,
      types: ["image/png"],
      pendingFollowup: true,
    });
  });

  it("ignores non-image media when building a recent snapshot", () => {
    const snapshot = buildRecentImageSnapshot({
      MediaPath: "/tmp/audio.ogg",
      MediaType: "audio/ogg",
    });

    expect(snapshot).toBeUndefined();
  });

  it("attaches the pending recent image to the next text-only message", () => {
    const ctx: MsgContext = {
      MessageSid: "msg-text",
      SenderId: "user-1",
      AccountId: "default",
      MessageThreadId: "thread-1",
      BodyForCommands: "解释这个图片",
    };
    const snapshot = {
      kind: "image" as const,
      messageId: "msg-image",
      senderId: "user-1",
      accountId: "default",
      threadId: "thread-1",
      capturedAt: Date.now(),
      paths: ["/tmp/input.png"],
      types: ["image/png"],
      pendingFollowup: true,
    };

    expect(shouldAttachRecentImageSnapshot({ ctx, snapshot })).toBe(true);

    const nextSnapshot = attachRecentImageSnapshot({ ctx, snapshot });

    expect(ctx.MediaPath).toBe("/tmp/input.png");
    expect(ctx.MediaType).toBe("image/png");
    expect(nextSnapshot.pendingFollowup).toBe(false);
  });

  it("requires an explicit image reference after the first follow-up is consumed", () => {
    const snapshot = {
      kind: "image" as const,
      messageId: "msg-image",
      senderId: "user-1",
      accountId: "default",
      threadId: "thread-1",
      capturedAt: Date.now(),
      paths: ["/tmp/input.png"],
      types: ["image/png"],
      pendingFollowup: false,
    };

    expect(
      shouldAttachRecentImageSnapshot({
        ctx: {
          MessageSid: "msg-text-1",
          SenderId: "user-1",
          AccountId: "default",
          MessageThreadId: "thread-1",
          BodyForCommands: "继续讲一下这个图",
        },
        snapshot,
      }),
    ).toBe(true);

    expect(
      shouldAttachRecentImageSnapshot({
        ctx: {
          MessageSid: "msg-text-2",
          SenderId: "user-1",
          AccountId: "default",
          MessageThreadId: "thread-1",
          BodyForCommands: "顺便查一下别的事情",
        },
        snapshot,
      }),
    ).toBe(false);
  });

  it("does not attach recent image snapshots across different senders", () => {
    expect(
      shouldAttachRecentImageSnapshot({
        ctx: {
          MessageSid: "msg-text",
          SenderId: "user-2",
          AccountId: "default",
          MessageThreadId: "thread-1",
          BodyForCommands: "解释这个图片",
        },
        snapshot: {
          kind: "image",
          messageId: "msg-image",
          senderId: "user-1",
          accountId: "default",
          threadId: "thread-1",
          capturedAt: Date.now(),
          paths: ["/tmp/input.png"],
          pendingFollowup: true,
        },
      }),
    ).toBe(false);
  });
});
