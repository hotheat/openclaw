import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("@larksuiteoapi/node-sdk", () => ({
  adaptDefault: vi.fn(
    () => (_req: unknown, res: { statusCode?: number; end: (s: string) => void }) => {
      res.statusCode = 200;
      res.end("ok");
    },
  ),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
}));

import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";

const mockHandleFeishuMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTryRecordMessagePersistent = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockHasControlCommand = vi.hoisted(() => vi.fn(() => false));

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  return {
    ...actual,
    handleFeishuMessage: mockHandleFeishuMessage,
  };
});

vi.mock("./dedup.js", () => ({
  tryRecordMessagePersistent: mockTryRecordMessagePersistent,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: vi.fn(() => ({
    channel: {
      debounce: {
        createInboundDebouncer: (params: {
          debounceMs: number;
          buildKey: (item: unknown) => string | null | undefined;
          shouldDebounce?: (item: unknown) => boolean;
          onFlush: (items: unknown[]) => Promise<void>;
        }) => {
          const buffers = new Map<
            string,
            { items: unknown[]; timer?: ReturnType<typeof setTimeout> }
          >();
          const flush = async (key: string) => {
            const buffer = buffers.get(key);
            if (!buffer) {
              return;
            }
            if (buffer.timer) {
              clearTimeout(buffer.timer);
            }
            buffers.delete(key);
            await params.onFlush(buffer.items);
          };
          return {
            enqueue: async (item: unknown) => {
              const key = params.buildKey(item);
              const canDebounce =
                params.debounceMs > 0 && key && (params.shouldDebounce?.(item) ?? true);
              if (!canDebounce || !key) {
                await params.onFlush([item]);
                return;
              }
              const buffer = buffers.get(key) ?? { items: [] };
              buffer.items.push(item);
              if (buffer.timer) {
                clearTimeout(buffer.timer);
              }
              buffer.timer = setTimeout(() => {
                void flush(key);
              }, params.debounceMs);
              buffers.set(key, buffer);
            },
            flushKey: async (key: string) => {
              await flush(key);
            },
          };
        },
        resolveInboundDebounceMs: vi.fn(() => 1500),
      },
      text: {
        hasControlCommand: mockHasControlCommand,
      },
    },
  })),
}));

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntilServerReady(url: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`server did not start: ${url}`);
}

function buildConfig(params: {
  accountId: string;
  path: string;
  port: number;
  verificationToken?: string;
}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          [params.accountId]: {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test",
            connectionMode: "webhook",
            webhookHost: "127.0.0.1",
            webhookPort: params.port,
            webhookPath: params.path,
            verificationToken: params.verificationToken,
          },
        },
      },
    },
  } as ClawdbotConfig;
}

async function withRunningWebhookMonitor(
  params: {
    accountId: string;
    path: string;
    verificationToken: string;
  },
  run: (url: string) => Promise<void>,
) {
  const port = await getFreePort();
  const cfg = buildConfig({
    accountId: params.accountId,
    path: params.path,
    port,
    verificationToken: params.verificationToken,
  });

  const abortController = new AbortController();
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const monitorPromise = monitorFeishuProvider({
    config: cfg,
    runtime,
    abortSignal: abortController.signal,
  });

  const url = `http://127.0.0.1:${port}${params.path}`;
  await waitUntilServerReady(url);

  try {
    await run(url);
  } finally {
    abortController.abort();
    await monitorPromise;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  stopFeishuMonitor();
});

describe("Feishu webhook security hardening", () => {
  it("rejects webhook mode without verificationToken", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildConfig({
      accountId: "missing-token",
      path: "/hook-missing-token",
      port: await getFreePort(),
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(
      /requires verificationToken/i,
    );
  });

  it("returns 415 for POST requests without json content type", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "content-type",
        path: "/hook-content-type",
        verificationToken: "verify_token",
      },
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });

        expect(response.status).toBe(415);
        expect(await response.text()).toBe("Unsupported Media Type");
      },
    );
  });

  it("rate limits webhook burst traffic with 429", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "rate-limit",
        path: "/hook-rate-limit",
        verificationToken: "verify_token",
      },
      async (url) => {
        let saw429 = false;
        for (let i = 0; i < 130; i += 1) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          });
          if (response.status === 429) {
            saw429 = true;
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }
        }

        expect(saw429).toBe(true);
      },
    );
  });
});

describe("Feishu inbound debounce", () => {
  it("coalesces rapid group text messages from the same sender", async () => {
    vi.useFakeTimers();
    const { createFeishuInboundMessageHandler } = await import("./monitor.js");
    const handler = createFeishuInboundMessageHandler({
      cfg: {
        messages: { inbound: { byChannel: { feishu: 1500 } } },
      } as ClawdbotConfig,
      accountId: "default",
      botOpenId: "ou-bot",
      runtime: { log: vi.fn(), error: vi.fn() } as any,
      chatHistories: new Map(),
    });

    const baseEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou-bot" } }],
      },
    };

    await handler({
      ...baseEvent,
      message: {
        ...baseEvent.message,
        message_id: "msg-1",
        content: JSON.stringify({ text: "@Bot first" }),
      },
    } as FeishuMessageEvent);
    await handler({
      ...baseEvent,
      message: {
        ...baseEvent.message,
        message_id: "msg-2",
        content: JSON.stringify({ text: "@Bot second" }),
      },
    } as FeishuMessageEvent);

    await vi.advanceTimersByTimeAsync(1500);

    expect(mockTryRecordMessagePersistent).toHaveBeenCalledTimes(2);
    expect(mockHandleFeishuMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDedup: true,
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: JSON.stringify({ text: "first\nsecond" }),
          }),
        }),
      }),
    );
    vi.useRealTimers();
  });

  it("does not debounce control commands or reply messages", async () => {
    const { createFeishuInboundMessageHandler } = await import("./monitor.js");
    const handler = createFeishuInboundMessageHandler({
      cfg: {
        messages: { inbound: { byChannel: { feishu: 1500 } } },
      } as ClawdbotConfig,
      accountId: "default",
      botOpenId: "ou-bot",
      runtime: { log: vi.fn(), error: vi.fn() } as any,
      chatHistories: new Map(),
    });
    mockHasControlCommand.mockReturnValueOnce(true);

    await handler({
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-command",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    } as FeishuMessageEvent);
    await handler({
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-reply",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        parent_id: "parent-1",
        content: JSON.stringify({ text: "reply" }),
      },
    } as FeishuMessageEvent);

    expect(mockHandleFeishuMessage).toHaveBeenCalledTimes(2);
    expect(mockHandleFeishuMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({ message_id: "msg-command" }),
        }),
      }),
    );
    expect(mockHandleFeishuMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({ message_id: "msg-reply" }),
        }),
      }),
    );
  });
});
