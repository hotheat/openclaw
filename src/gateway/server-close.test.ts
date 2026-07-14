import type { Server as HttpServer } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createGatewayCloseHandler } from "./server-close.js";

const stopGmailWatcherMock = vi.fn(async () => undefined);

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [{ id: "test-channel" }],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: () => stopGmailWatcherMock(),
}));

describe("gateway close handler", () => {
  beforeEach(() => {
    stopGmailWatcherMock.mockClear().mockResolvedValue(undefined);
  });

  it("finishes terminal resource cleanup before reporting aggregated shutdown failures", async () => {
    const channelError = new Error("channel stop failed");
    const pluginError = new Error("plugin stop failed");
    const flushError = new Error("state flush failed");
    const wssError = new Error("wss close failed");
    const firstHttpError = new Error("first http close failed");
    const events: string[] = [];
    const clientClose = vi.fn(() => events.push("client"));
    const wssClose = vi.fn((callback: (err?: Error) => void) => {
      events.push("wss");
      callback(wssError);
    });
    const firstHttpClose = vi.fn((callback: (err?: Error) => void) => {
      events.push("http:first");
      callback(firstHttpError);
    });
    const secondHttpClose = vi.fn((callback: (err?: Error) => void) => {
      events.push("http:second");
      callback();
    });
    const clients = new Set([{ socket: { close: clientClose } }]);
    const tickInterval = setInterval(() => undefined, 60_000);
    const healthInterval = setInterval(() => undefined, 60_000);
    const dedupeCleanup = setInterval(() => undefined, 60_000);

    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => {
        throw channelError;
      }),
      pluginServices: {
        stop: vi.fn(async () => {
          throw pluginError;
        }),
      },
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      flushStateWrites: vi.fn(async () => {
        throw flushError;
      }),
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(() => events.push("broadcast")),
      tickInterval,
      healthInterval,
      dedupeCleanup,
      mediaCleanup: null,
      playwrightRecoveryInterval: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients,
      configReloader: { stop: vi.fn(async () => undefined) },
      browserControl: null,
      wss: { close: wssClose } as unknown as WebSocketServer,
      httpServer: { close: firstHttpClose } as unknown as HttpServer,
      httpServers: [
        { close: firstHttpClose } as unknown as HttpServer,
        { close: secondHttpClose } as unknown as HttpServer,
      ],
    });

    let failure: unknown;
    try {
      await close();
    } catch (err) {
      failure = err;
      events.push("rejected");
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([channelError, pluginError, flushError, wssError, firstHttpError]),
    );
    expect(events).toEqual(["broadcast", "client", "wss", "http:first", "http:second", "rejected"]);
    expect(clientClose).toHaveBeenCalledWith(1012, "service restart");
    expect(clients.size).toBe(0);
  });
});
