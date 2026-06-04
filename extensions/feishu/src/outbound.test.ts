import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const chunkMarkdownTextMock = vi.hoisted(() => vi.fn((text: string) => [text]));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: chunkMarkdownTextMock,
      },
    },
  }),
}));

import { FeishuMediaLimitError } from "./media-limits.js";
import { feishuOutbound } from "./outbound.js";

describe("feishuOutbound.sendMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({
      messageId: "om_text_1",
      chatId: "oc_1",
    });
  });

  it("throws when media upload fails instead of falling back to a path text message", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await expect(
      feishuOutbound.sendMedia?.({
        cfg: {} as never,
        to: "chat:oc_1",
        text: "",
        mediaUrl: "/tmp/demo.zip",
        accountId: undefined,
      } as never),
    ).rejects.toThrow("Feishu media send failed");

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/tmp/demo.zip",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: "📎 /tmp/demo.zip",
      }),
    );
  });

  it("preserves media limit errors so users can see the exact limit", async () => {
    const limitError = new FeishuMediaLimitError({
      direction: "outbound",
      kind: "file",
      limitMb: 30,
      actualMb: 31,
    });
    sendMediaFeishuMock.mockRejectedValueOnce(limitError);

    await expect(
      feishuOutbound.sendMedia?.({
        cfg: {} as never,
        to: "chat:oc_1",
        text: "",
        mediaUrl: "/tmp/large.pptx",
        accountId: undefined,
      } as never),
    ).rejects.toBe(limitError);
  });
});
