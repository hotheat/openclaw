import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockDownloadMessageResourceFeishu,
  mockTryRecordMessagePersistent,
  mockFeishuDispatcher,
  mockFinalizeFeishuDispatcher,
  mockMarkDispatchIdle,
  mockCreateFeishuClient,
} = vi.hoisted(() => ({
  mockFeishuDispatcher: {
    sendFinalReply: vi.fn((_payload?: { text?: string }) => true),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn(),
  },
  mockFinalizeFeishuDispatcher: vi.fn().mockResolvedValue({ status: "not-streaming" }),
  mockMarkDispatchIdle: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: mockFeishuDispatcher,
    replyOptions: {},
    markDispatchIdle: mockMarkDispatchIdle,
    finalize: mockFinalizeFeishuDispatcher,
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockDownloadMessageResourceFeishu: vi.fn().mockResolvedValue({
    buffer: Buffer.from("video"),
    contentType: "video/mp4",
    fileName: "clip.mp4",
  }),
  mockTryRecordMessagePersistent: vi.fn().mockResolvedValue(true),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./dedup.js", () => ({
  tryRecordMessagePersistent: mockTryRecordMessagePersistent,
}));

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as RuntimeEnv;
}

async function dispatchMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  chatHistories?: Map<string, HistoryEntry[]>;
}) {
  const runtime = createRuntimeEnv();
  await handleFeishuMessage({
    cfg: params.cfg,
    event: params.event,
    runtime,
    chatHistories: params.chatHistories,
  });
  return runtime;
}

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchReplyFromConfig.mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    mockFeishuDispatcher.sendFinalReply.mockReturnValue(true);
    mockFeishuDispatcher.waitForIdle.mockResolvedValue(undefined);
    mockFinalizeFeishuDispatcher.mockResolvedValue({ status: "not-streaming" });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    });
    setFeishuRuntime({
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:feishu:dm:ou-attacker",
            matchedBy: "default",
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
          finalizeInboundContext: mockFinalizeInboundContext,
          dispatchReplyFromConfig: mockDispatchReplyFromConfig,
        },
        commands: {
          shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
          resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
        },
        media: {
          saveMediaBuffer: mockSaveMediaBuffer,
        },
        pairing: {
          readAllowFromStore: mockReadAllowFromStore,
          upsertPairingRequest: mockUpsertPairingRequest,
          buildPairingReply: mockBuildPairingReply,
        },
      },
      media: {
        detectMime: vi.fn(async () => "application/octet-stream"),
      },
    } as unknown as PluginRuntime);
  });

  it("uses authorizer resolution instead of hardcoded CommandAuthorized=true", async () => {
    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["ou-admin"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-auth-bypass-regression",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: false,
        SenderId: "ou-attacker",
        Surface: "feishu",
      }),
    );
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-read-store-non-command",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith("feishu");
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("queues a fallback reply when Feishu dispatch produces no final message", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({ queuedFinal: false, counts: { final: 0 } });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-empty-dispatch",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFeishuDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "模型执行中断，请重试。",
      isError: true,
    });
    expect(mockFeishuDispatcher.markComplete).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mockFinalizeFeishuDispatcher).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.markComplete.mock.invocationCallOrder[0]).toBeLessThan(
      mockFeishuDispatcher.waitForIdle.mock.invocationCallOrder[0],
    );
    expect(mockFeishuDispatcher.waitForIdle.mock.invocationCallOrder[0]).toBeLessThan(
      mockFinalizeFeishuDispatcher.mock.invocationCallOrder[0],
    );
  });

  it("does not queue fallback when Feishu dispatch was handled without queued replies", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
      handled: true,
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-handled-empty-dispatch",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "send file" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFeishuDispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: "模型执行中断，请重试。",
      isError: true,
    });
    // Fallback is suppressed, but the dispatcher reservation must still be released
    // so it does not stay permanently registered for idle/restart coordination.
    expect(mockFeishuDispatcher.markComplete).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mockFinalizeFeishuDispatcher).toHaveBeenCalledTimes(1);
  });

  it("completes the dispatcher on the happy path with queued replies", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-happy-dispatch",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFeishuDispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: "模型执行中断，请重试。",
      isError: true,
    });
    expect(mockFeishuDispatcher.markComplete).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mockFinalizeFeishuDispatcher).toHaveBeenCalledTimes(1);
  });

  it("drains replies accepted at completion before finalizing the streaming card", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    });

    const deliveredText: string[] = [];
    let sendChain = Promise.resolve();
    let finalizedText = "";
    const dispatcher = {
      sendFinalReply: vi.fn((payload?: { text?: string }) => {
        sendChain = sendChain.then(async () => {
          await Promise.resolve();
          deliveredText.push(payload?.text ?? "");
        });
        return true;
      }),
      waitForIdle: vi.fn(() => sendChain),
      markComplete: vi.fn(() => {
        dispatcher.sendFinalReply({ text: "late final" });
      }),
    };
    const finalize = vi.fn(async () => {
      finalizedText = deliveredText.join("");
    });
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      finalize,
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-late-final",
        },
      },
      message: {
        message_id: "msg-late-final",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(dispatcher.markComplete).toHaveBeenCalledTimes(1);
    expect(dispatcher.waitForIdle).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalizedText).toBe("late final");
  });

  it("does not report completion when final delivery fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    });
    mockFinalizeFeishuDispatcher.mockRejectedValueOnce(new Error("close failed"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-finalize-error",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const runtime = await dispatchMessage({ cfg, event });

    expect(mockFinalizeFeishuDispatcher).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.markComplete).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mockMarkDispatchIdle).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("reply streaming finalization failed: Error: close failed"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to dispatch message: Error: close failed"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("dispatch complete (queuedFinal=true, replies=1)"),
    );
  });

  it("preserves the dispatch error when streaming finalization also fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockRejectedValueOnce(new Error("dispatch failed"));
    mockFinalizeFeishuDispatcher.mockRejectedValueOnce(new Error("close failed"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-dispatch-error",
        },
      },
      message: {
        message_id: "msg-dispatch-and-finalize-error",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const runtime = await dispatchMessage({ cfg, event });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("reply streaming finalization failed: Error: close failed"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to dispatch message: Error: dispatch failed"),
    );
  });

  it("preserves group history when final delivery fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockFinalizeFeishuDispatcher.mockRejectedValueOnce(new Error("close failed"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-finalize-history": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;
    const chatHistories = new Map<string, HistoryEntry[]>([
      [
        "oc-finalize-history",
        [{ sender: "ou-previous", body: "previous message", timestamp: Date.now() }],
      ],
    ]);

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-group-sender",
        },
      },
      message: {
        message_id: "msg-finalize-history",
        chat_id: "oc-finalize-history",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event, chatHistories });

    expect(chatHistories.get("oc-finalize-history")).toHaveLength(1);
  });

  it("reports degraded delivery and completes after a fallback succeeds", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    });
    mockFinalizeFeishuDispatcher.mockResolvedValueOnce({ status: "fallback-card" });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-fallback-delivery",
        },
      },
      message: {
        message_id: "msg-fallback-delivery",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const runtime = await dispatchMessage({ cfg, event });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("reply delivered via fallback-card"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("dispatch complete (queuedFinal=true, replies=1)"),
    );
  });

  it("continues to the user reply when permission-card finalization fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValueOnce({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied https://open.feishu.cn/app/test",
              },
            },
          }),
        },
      },
    });
    mockFinalizeFeishuDispatcher.mockRejectedValueOnce(new Error("permission close failed"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "permission-test-app",
          appSecret: "permission-test-secret",
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-permission-finalize-error",
        },
      },
      message: {
        message_id: "msg-permission-finalize-error",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const runtime = await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    expect(mockFinalizeFeishuDispatcher).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "permission reply streaming finalization failed: Error: permission close failed",
      ),
    );
  });

  it("does not queue fallback when Feishu dispatch completed silently", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
      handled: true,
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-silent-dispatch",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "NO_REPLY" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFeishuDispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: "模型执行中断，请重试。",
      isError: true,
    });
    expect(mockFeishuDispatcher.markComplete).toHaveBeenCalledTimes(1);
    expect(mockFeishuDispatcher.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mockFinalizeFeishuDispatcher).toHaveBeenCalledTimes(1);
  });

  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
      message: {
        message_id: "msg-pairing-flow",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockBuildPairingReply).toHaveBeenCalledWith({
      channel: "feishu",
      idLine: "Your Feishu user id: ou-unapproved",
      code: "ABCDEFGH",
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou-unapproved",
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-command-auth",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: false, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-admin",
        },
      },
      message: {
        message_id: "msg-group-command-fallback",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: true }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: true,
        SenderId: "ou-admin",
      }),
    );
  });

  it("uses video file_key (not thumbnail image_key) for inbound video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-video-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "video",
        content: JSON.stringify({
          file_key: "file_video_payload",
          image_key: "img_thumb_payload",
          file_name: "clip.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-video-inbound",
        fileKey: "file_video_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("replaces raw image_key payloads with a media placeholder in agent text", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockSaveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound-image.jpg",
      contentType: "image/jpeg",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-image-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_v3_01abc123",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        CommandBody: "<media:image>",
        MediaPath: "/tmp/inbound-image.jpg",
      }),
    );
  });

  it("replies with the configured inbound media limit when an attachment is too large", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockSaveMediaBuffer.mockRejectedValueOnce(new Error("Media exceeds 100MB limit"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          inboundMediaMaxMb: 100,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-large-file-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file_large_payload",
          file_name: "large.pptx",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou-sender",
        text: "文件超过入站上限 100MB，请压缩后重发。",
        replyToMessageId: "msg-large-file-inbound",
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("dispatches post text when all embedded images exceed the inbound media limit", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockSaveMediaBuffer.mockRejectedValueOnce(new Error("Media exceeds 100MB limit"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          mediaMaxMb: 100,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-post-large-image",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "Post title",
          content: [
            [
              { tag: "text", text: "Please analyze this post." },
              { tag: "img", image_key: "img_v3_large_payload" },
            ],
          ],
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou-sender",
        text: "图片超过入站上限 100MB，请压缩后重发。",
        replyToMessageId: "msg-post-large-image",
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "Post title\n\nPlease analyze this post.",
        RawBody: "Post title\n\nPlease analyze this post.",
        CommandBody: "Post title\n\nPlease analyze this post.",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});
