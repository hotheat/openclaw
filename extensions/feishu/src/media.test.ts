import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());

const fileCreateMock = vi.hoisted(() => vi.fn());
const imageCreateMock = vi.hoisted(() => vi.fn());
const imageGetMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());
const messageResourceGetMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    media: {
      loadWebMedia: loadWebMediaMock,
    },
  }),
}));

import { FeishuMediaLimitError } from "./media-limits.js";
import { downloadImageFeishu, downloadMessageResourceFeishu, sendMediaFeishu } from "./media.js";

function expectPathIsolatedToTmpRoot(pathValue: string, key: string): void {
  expect(pathValue).not.toContain(key);
  expect(pathValue).not.toContain("..");

  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(pathValue);
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
}

describe("sendMediaFeishu msg_type routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    resolveFeishuAccountMock.mockReturnValue({
      configured: true,
      accountId: "main",
      config: {},
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");

    createFeishuClientMock.mockReturnValue({
      im: {
        file: {
          create: fileCreateMock,
        },
        image: {
          create: imageCreateMock,
          get: imageGetMock,
        },
        message: {
          create: messageCreateMock,
          reply: messageReplyMock,
        },
        messageResource: {
          get: messageResourceGetMock,
        },
      },
    });

    fileCreateMock.mockResolvedValue({
      code: 0,
      data: { file_key: "file_key_1" },
    });

    imageCreateMock.mockResolvedValue({
      code: 0,
      data: { image_key: "image_key_1" },
    });

    messageCreateMock.mockResolvedValue({
      code: 0,
      data: { message_id: "msg_1" },
    });

    messageReplyMock.mockResolvedValue({
      code: 0,
      data: { message_id: "reply_1" },
    });

    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("remote-audio"),
      fileName: "remote.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    imageGetMock.mockResolvedValue(Buffer.from("image-bytes"));
    messageResourceGetMock.mockResolvedValue(Buffer.from("resource-bytes"));
  });

  it("uses msg_type=media for mp4", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
    });

    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "mp4" }),
      }),
    );

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );
  });

  it("uses msg_type=media for opus", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("audio"),
      fileName: "voice.opus",
    });

    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "opus" }),
      }),
    );

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );
  });

  it("uses msg_type=file for documents", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "paper.pdf",
    });

    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "pdf" }),
      }),
    );

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "file" }),
      }),
    );
  });

  it("rejects outbound files above Feishu's 30MB upload limit", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      configured: true,
      accountId: "main",
      config: { outboundFileMaxMb: 30 },
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    await expect(
      sendMediaFeishu({
        cfg: {} as any,
        to: "user:ou_target",
        mediaBuffer: Buffer.alloc(31 * 1024 * 1024),
        fileName: "large.pptx",
      }),
    ).rejects.toMatchObject({
      name: "FeishuMediaLimitError",
      message: "文件超过飞书发送上限 30MB，当前约 31MB，请压缩后再发送。",
    } satisfies Partial<FeishuMediaLimitError>);

    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("rejects outbound images above Feishu's 10MB upload limit", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      configured: true,
      accountId: "main",
      config: { outboundImageMaxMb: 10 },
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    await expect(
      sendMediaFeishu({
        cfg: {} as any,
        to: "user:ou_target",
        mediaBuffer: Buffer.alloc(11 * 1024 * 1024),
        fileName: "large.png",
      }),
    ).rejects.toMatchObject({
      name: "FeishuMediaLimitError",
      message: "图片超过飞书发送上限 10MB，当前约 11MB，请压缩后再发送。",
    } satisfies Partial<FeishuMediaLimitError>);

    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("passes outboundFileMaxMb to remote media loading", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      configured: true,
      accountId: "main",
      config: { outboundFileMaxMb: 30 },
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "https://example.com/report.pdf",
      fileName: "report.pdf",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/report.pdf",
      expect.objectContaining({
        maxBytes: 30 * 1024 * 1024,
      }),
    );
  });

  it("passes outboundImageMaxMb to remote image loading", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      configured: true,
      accountId: "main",
      config: { outboundFileMaxMb: 30, outboundImageMaxMb: 10 },
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "https://example.com/photo.png",
      fileName: "photo.png",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({
        maxBytes: 10 * 1024 * 1024,
      }),
    );
  });

  it("uses the file cap for remote media with unknown type before response metadata is known", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      configured: true,
      accountId: "main",
      config: { outboundFileMaxMb: 30, outboundImageMaxMb: 10 },
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "https://example.com/download",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/download",
      expect.objectContaining({
        maxBytes: 30 * 1024 * 1024,
      }),
    );
  });

  it("allows extensionless remote documents above the image cap and below the file cap", async () => {
    const document = Buffer.alloc(11 * 1024 * 1024);
    loadWebMediaMock.mockImplementationOnce(async (_url, options?: { maxBytes?: number }) => {
      if (options?.maxBytes !== undefined && document.byteLength > options.maxBytes) {
        throw Object.assign(new Error(`payload exceeds maxBytes ${options.maxBytes}`), {
          code: "max_bytes",
        });
      }
      return {
        buffer: document,
        fileName: "download.pdf",
        kind: "document",
        contentType: "application/pdf",
      };
    });
    resolveFeishuAccountMock.mockReturnValueOnce({
      configured: true,
      accountId: "main",
      config: { outboundFileMaxMb: 30, outboundImageMaxMb: 10 },
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "https://example.com/download?id=report",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/download?id=report",
      expect.objectContaining({
        maxBytes: 30 * 1024 * 1024,
      }),
    );
    expect(fileCreateMock).toHaveBeenCalledTimes(1);
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: "file",
        }),
      }),
    );
  });

  it("wraps remote image fetch size failures as Feishu image limit errors", async () => {
    const err = Object.assign(new Error("payload exceeds maxBytes 10485760"), {
      code: "max_bytes",
    });
    loadWebMediaMock.mockRejectedValueOnce(err);

    await expect(
      sendMediaFeishu({
        cfg: {} as any,
        to: "user:ou_target",
        mediaUrl: "https://example.com/large.png",
        fileName: "large.png",
      }),
    ).rejects.toMatchObject({
      name: "FeishuMediaLimitError",
      message: "图片超过飞书发送上限 10MB，请压缩后再发送。",
    } satisfies Partial<FeishuMediaLimitError>);

    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("uses msg_type=media when replying with mp4", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
    });

    expect(messageReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "om_parent" },
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );

    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when media URL fetch is blocked", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    await expect(
      sendMediaFeishu({
        cfg: {} as any,
        to: "user:ou_target",
        mediaUrl: "https://x/img",
        fileName: "voice.opus",
      }),
    ).rejects.toThrow(/private\/internal/i);

    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
    expect(messageReplyMock).not.toHaveBeenCalled();
  });

  it("uses isolated temp paths for image downloads", async () => {
    const imageKey = "img_v3_01abc123";
    let capturedPath: string | undefined;

    imageGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, Buffer.from("image-data"));
      },
    });

    const result = await downloadImageFeishu({
      cfg: {} as any,
      imageKey,
    });

    expect(result.buffer).toEqual(Buffer.from("image-data"));
    expect(capturedPath).toBeDefined();
    expectPathIsolatedToTmpRoot(capturedPath as string, imageKey);
  });

  it("uses isolated temp paths for message resource downloads", async () => {
    const fileKey = "file_v3_01abc123";
    let capturedPath: string | undefined;

    messageResourceGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, Buffer.from("resource-data"));
      },
    });

    const result = await downloadMessageResourceFeishu({
      cfg: {} as any,
      messageId: "om_123",
      fileKey,
      type: "image",
    });

    expect(result.buffer).toEqual(Buffer.from("resource-data"));
    expect(capturedPath).toBeDefined();
    expectPathIsolatedToTmpRoot(capturedPath as string, fileKey);
  });

  it("rejects invalid image keys before calling feishu api", async () => {
    await expect(
      downloadImageFeishu({
        cfg: {} as any,
        imageKey: "a/../../bad",
      }),
    ).rejects.toThrow("invalid image_key");

    expect(imageGetMock).not.toHaveBeenCalled();
  });

  it("rejects invalid file keys before calling feishu api", async () => {
    await expect(
      downloadMessageResourceFeishu({
        cfg: {} as any,
        messageId: "om_123",
        fileKey: "x/../../bad",
        type: "file",
      }),
    ).rejects.toThrow("invalid file_key");

    expect(messageResourceGetMock).not.toHaveBeenCalled();
  });
});
