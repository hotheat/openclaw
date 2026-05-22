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
});
