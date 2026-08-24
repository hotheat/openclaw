import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import { MEDIA_DEFAULT_TTL_MS } from "../media/store.js";
import {
  resolvePlaywrightRecoveryMaintenanceConfig,
  startGatewayMaintenanceTimers,
} from "./server-maintenance.js";

const mocks = vi.hoisted(() => ({
  cleanOldMedia: vi.fn(async () => {}),
}));

vi.mock("../media/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/store.js")>()),
  cleanOldMedia: mocks.cleanOldMedia,
}));

const healthSummary: HealthSummary = {
  ok: true,
  ts: 1,
  durationMs: 0,
  channels: {},
  channelOrder: [],
  channelLabels: {},
  heartbeatSeconds: 0,
  defaultAgentId: "default",
  agents: [],
  sessions: {
    path: "/tmp/openclaw-sessions.json",
    count: 0,
    recent: [],
  },
};

describe("gateway maintenance timers", () => {
  beforeEach(() => {
    mocks.cleanOldMedia.mockClear();
  });

  function startTimers(
    overrides: Partial<Parameters<typeof startGatewayMaintenanceTimers>[0]> = {},
  ): ReturnType<typeof startGatewayMaintenanceTimers> {
    return startGatewayMaintenanceTimers({
      broadcast: vi.fn(),
      nodeSendToAllSubscribed: vi.fn(),
      getPresenceVersion: () => 1,
      getHealthVersion: () => 1,
      refreshGatewayHealthSnapshot: vi.fn(async () => healthSummary),
      logHealth: { error: vi.fn() },
      mediaCleanupTtlMs: MEDIA_DEFAULT_TTL_MS,
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState: {
        abortedRuns: new Map(),
        deltaRevisions: new Map(),
        deltaSeqs: new Map(),
        deltaLastBroadcastRevisions: new Map(),
        deltaLastNodeRevisions: new Map(),
      },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      nodeSendToSession: vi.fn(),
      ...overrides,
    });
  }

  function clearTimers(timers: ReturnType<typeof startGatewayMaintenanceTimers>): void {
    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);
    if (timers.mediaCleanup) {
      clearInterval(timers.mediaCleanup);
    }
    if (timers.playwrightRecoveryInterval) {
      clearInterval(timers.playwrightRecoveryInterval);
    }
  }

  it("runs hosted media cleanup recursively with the configured TTL", () => {
    const timers = startTimers();

    try {
      expect(mocks.cleanOldMedia).toHaveBeenCalledWith(MEDIA_DEFAULT_TTL_MS, {
        recursive: true,
        pruneEmptyDirs: true,
      });
    } finally {
      clearTimers(timers);
    }
  });

  it("logs hosted media cleanup failures without leaving a rejected cleanup promise", async () => {
    const logMediaCleanup = { info: vi.fn(), warn: vi.fn() };
    mocks.cleanOldMedia.mockRejectedValueOnce(new Error("mkdir denied"));
    const timers = startTimers({ logMediaCleanup });

    try {
      await vi.waitFor(() => {
        expect(logMediaCleanup.warn).toHaveBeenCalledWith("media cleanup failed", {
          error: "mkdir denied",
        });
      });
    } finally {
      clearTimers(timers);
    }
  });

  it("disables playwright recovery on unsupported platforms before registering timers", () => {
    const logPlaywrightRecovery = { info: vi.fn(), warn: vi.fn() };
    const playwrightRecovery = resolvePlaywrightRecoveryMaintenanceConfig(
      {
        enabled: true,
        interval: "5m",
        staleAfter: "1h",
      },
      {
        platform: "darwin",
        log: logPlaywrightRecovery,
      },
    );

    const timers = startTimers({ playwrightRecovery, logPlaywrightRecovery });

    try {
      expect(playwrightRecovery).toMatchObject({
        enabled: false,
        intervalMs: 5 * 60_000,
        staleAfterMs: 60 * 60_000,
      });
      expect(timers.playwrightRecoveryInterval).toBeNull();
      expect(logPlaywrightRecovery.warn).toHaveBeenCalledWith(
        "playwright recovery disabled on unsupported platform",
        { platform: "darwin" },
      );
    } finally {
      clearTimers(timers);
    }
  });
});
