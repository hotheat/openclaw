import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const isRetryableFeishuStreamingErrorMock = vi.hoisted(() => vi.fn());
const streamingInstances = vi.hoisted(() => [] as any[]);

vi.mock("./accounts.js", () => ({ resolveFeishuAccount: resolveFeishuAccountMock }));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./streaming-card.js", () => ({
  isRetryableFeishuStreamingError: isRetryableFeishuStreamingErrorMock,
  FeishuStreamingSession: class {
    active = false;
    start = vi.fn(async () => {
      this.active = true;
    });
    update = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.active = false;
    });
    isActive = vi.fn(() => this.active);

    constructor() {
      streamingInstances.push(this);
    }
  },
}));

import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

describe("createFeishuReplyDispatcher streaming behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.length = 0;
    sendMessageFeishuMock.mockReset().mockResolvedValue({});
    sendMarkdownCardFeishuMock.mockReset().mockResolvedValue({});
    isRetryableFeishuStreamingErrorMock.mockReset().mockReturnValue(true);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    createReplyDispatcherWithTypingMock.mockImplementation((opts) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _opts: opts,
    }));

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("enables block streaming by default for Feishu replies", () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    expect(result.replyOptions.disableBlockStreaming).toBe(false);
  });

  it("allows Feishu block streaming to be disabled explicitly", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        blockStreaming: false,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    expect(result.replyOptions.disableBlockStreaming).toBe(true);
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
    options.onIdle();

    expect(streamingInstances[0].close).not.toHaveBeenCalled();

    const finalizeResult = await result.finalize();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(finalizeResult).toEqual({ status: "streamed" });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps split final payloads in one streaming card", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const first =
      "## Common species\n\n| Name | Species |\n|---|---|\n| East Asian | T. matsutake |\n";
    const second = "| Eastern American | T. magnivelare |\n\nReferences";

    await options.deliver({ text: first }, { kind: "final" });
    await options.deliver({ text: second }, { kind: "final" });
    await result.finalize();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(`${first}${second}`);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("preserves independent payloads that repeat historical text", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const first = "Repeated section\n\n| Name | Value |\n|---|---|\n| A | B |\n\nTail";
    const second = "Repeated section";

    await options.deliver({ text: first }, { kind: "final" });
    await options.deliver({ text: second }, { kind: "final" });
    await result.finalize();

    expect(streamingInstances[0].close).toHaveBeenCalledWith(`${first}\n\n${second}`);
  });

  it("keeps independent payloads with matching boundary characters intact", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const first = "| Name | Value |\n|---|---|\n| A | data";
    const second = "analysis";

    await options.deliver({ text: first }, { kind: "final" });
    await options.deliver({ text: second }, { kind: "final" });
    await result.finalize();

    expect(streamingInstances[0].close).toHaveBeenCalledWith(`${first}\n\n${second}`);
  });

  it("uses delivered payload order instead of the latest partial preview", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const first = "## First\n\n| Name | Value |\n|---|---|\n| A | first payload |\n";
    const second = "| B | second payload |";

    await result.replyOptions.onPartialReply?.({ text: second });
    await options.deliver({ text: first }, { kind: "final" });
    await options.deliver({ text: second }, { kind: "final" });
    await result.finalize();

    expect(streamingInstances[0].close).toHaveBeenCalledWith(`${first}${second}`);
  });

  it("logs partial update failures and still closes with delivered text", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: runtime as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const delivered = "| Name | Value |\n|---|---|\n| A | delivered |";
    await options.deliver({ text: delivered }, { kind: "final" });
    streamingInstances[0].update.mockRejectedValueOnce(new Error("update failed"));

    await result.replyOptions.onPartialReply?.({ text: "preview" });
    await result.finalize();

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("streaming update failed: Error: update failed"),
    );
    expect(streamingInstances[0].close).toHaveBeenCalledWith(delivered);
  });

  it("retries transient streaming finalization failures before degrading", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const delivered = "```ts\nconst answer = 42\n```";
    await options.deliver({ text: delivered }, { kind: "final" });
    streamingInstances[0].close
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(async () => {
        streamingInstances[0].active = false;
      });

    await expect(result.finalize()).resolves.toEqual({ status: "streamed" });

    expect(streamingInstances[0].close).toHaveBeenCalledTimes(2);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to a static card after bounded finalization retries are exhausted", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const delivered = "| Name | Value |\n|---|---|\n| A | final |";
    await options.deliver({ text: delivered }, { kind: "final" });
    streamingInstances[0].close.mockRejectedValue(new Error("network unavailable"));

    await expect(result.finalize()).resolves.toEqual({ status: "fallback-card" });

    expect(streamingInstances[0].close).toHaveBeenCalledTimes(3);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: delivered }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to a plain message when static card delivery fails", async () => {
    isRetryableFeishuStreamingErrorMock.mockReturnValue(false);
    sendMarkdownCardFeishuMock.mockRejectedValueOnce(new Error("card send failed"));
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    const delivered = "```ts\nconst answer = 42\n```";
    await options.deliver({ text: delivered }, { kind: "final" });
    streamingInstances[0].close.mockRejectedValueOnce(new Error("invalid sequence"));

    await expect(result.finalize()).resolves.toEqual({ status: "fallback-message" });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: delivered }),
    );
  });

  it("reports final delivery failure when streaming and both fallbacks fail", async () => {
    isRetryableFeishuStreamingErrorMock.mockReturnValue(false);
    sendMarkdownCardFeishuMock.mockRejectedValueOnce(new Error("card send failed"));
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("message send failed"));
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst answer = 42\n```" }, { kind: "final" });
    streamingInstances[0].close.mockRejectedValueOnce(new Error("invalid sequence"));

    await expect(result.finalize()).rejects.toThrow(
      "Feishu streaming reply and fallback delivery failed",
    );
  });

  it("deduplicates concurrent streaming close requests", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    streamingInstances[0].close.mockImplementationOnce(async () => {
      await closeGate;
      streamingInstances[0].active = false;
    });

    const firstClose = result.finalize();
    const secondClose = result.finalize();

    await vi.waitFor(() => {
      expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    });
    releaseClose?.();
    await Promise.all([firstClose, secondClose]);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
  });
});
