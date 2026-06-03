import { reapPlaywrightSessions } from "../cli/browser-playwright-recovery.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { HealthSummary } from "../commands/health.js";
import { cleanOldMedia } from "../media/store.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import type { DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";

const MEDIA_CLEANUP_INTERVAL_MS = 60 * 60_000;

type MaintenanceLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export type PlaywrightRecoveryMaintenanceConfig = {
  enabled: boolean;
  intervalMs: number;
  staleAfterMs: number;
};

export function resolvePlaywrightRecoveryMaintenanceConfig(
  config:
    | {
        enabled?: boolean;
        interval?: string;
        staleAfter?: string;
      }
    | undefined,
  deps: {
    platform?: NodeJS.Platform;
    log?: MaintenanceLogger;
  } = {},
): PlaywrightRecoveryMaintenanceConfig {
  const intervalMs = parseDurationMs(config?.interval ?? "30m");
  const staleAfterMs = parseDurationMs(config?.staleAfter ?? "2h");
  const requestedEnabled = config?.enabled === true;
  const platform = deps.platform ?? process.platform;
  const enabled = requestedEnabled && platform === "linux";
  if (requestedEnabled && !enabled) {
    deps.log?.warn("playwright recovery disabled on unsupported platform", {
      platform,
    });
  }
  return {
    enabled,
    intervalMs,
    staleAfterMs,
  };
}

export function startGatewayMaintenanceTimers(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  getPresenceVersion: () => number;
  getHealthVersion: () => number;
  refreshGatewayHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  logHealth: { error: (msg: string) => void };
  logMediaCleanup?: MaintenanceLogger;
  logPlaywrightRecovery?: MaintenanceLogger;
  mediaCleanupTtlMs?: number;
  playwrightRecovery?: PlaywrightRecoveryMaintenanceConfig;
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: { abortedRuns: Map<string, number> };
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  playwrightRecoveryInterval: ReturnType<typeof setInterval> | null;
} {
  setBroadcastHealthUpdate((snap: HealthSummary) => {
    params.broadcast("health", snap, {
      stateVersion: {
        presence: params.getPresenceVersion(),
        health: params.getHealthVersion(),
      },
    });
    params.nodeSendToAllSubscribed("health", snap);
  });

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    params.broadcast("tick", payload, { dropIfSlow: true });
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void params
      .refreshGatewayHealthSnapshot({ probe: true })
      .catch((err) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void params
    .refreshGatewayHealthSnapshot({ probe: true })
    .catch((err) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = Date.now();
    for (const [k, v] of params.dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) {
        params.dedupe.delete(k);
      }
    }
    if (params.dedupe.size > DEDUPE_MAX) {
      const entries = [...params.dedupe.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < params.dedupe.size - DEDUPE_MAX; i++) {
        params.dedupe.delete(entries[i][0]);
      }
    }

    if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
      const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
      let removed = 0;
      for (const runId of params.agentRunSeq.keys()) {
        params.agentRunSeq.delete(runId);
        removed += 1;
        if (removed >= excess) {
          break;
        }
      }
    }

    for (const [runId, entry] of params.chatAbortControllers) {
      if (now <= entry.expiresAtMs) {
        continue;
      }
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunBuffers: params.chatRunBuffers,
          chatDeltaSentAt: params.chatDeltaSentAt,
          chatAbortedRuns: params.chatRunState.abortedRuns,
          removeChatRun: params.removeChatRun,
          agentRunSeq: params.agentRunSeq,
          broadcast: params.broadcast,
          nodeSendToSession: params.nodeSendToSession,
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "timeout" },
      );
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortedAt] of params.chatRunState.abortedRuns) {
      if (now - abortedAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.abortedRuns.delete(runId);
      params.chatRunBuffers.delete(runId);
      params.chatDeltaSentAt.delete(runId);
    }
  }, 60_000);

  let mediaCleanupRunning = false;
  const runMediaCleanup = () => {
    if (!params.mediaCleanupTtlMs || mediaCleanupRunning) {
      return;
    }
    mediaCleanupRunning = true;
    void cleanOldMedia(params.mediaCleanupTtlMs, {
      recursive: true,
      pruneEmptyDirs: true,
    })
      .catch((err) => {
        params.logMediaCleanup?.warn("media cleanup failed", {
          error: formatError(err),
        });
      })
      .finally(() => {
        mediaCleanupRunning = false;
      });
  };
  const mediaCleanup =
    typeof params.mediaCleanupTtlMs === "number" && params.mediaCleanupTtlMs > 0
      ? setInterval(runMediaCleanup, MEDIA_CLEANUP_INTERVAL_MS)
      : null;
  runMediaCleanup();

  let playwrightRecoveryRunning = false;
  const runPlaywrightRecovery = () => {
    const config = params.playwrightRecovery;
    if (!config?.enabled || playwrightRecoveryRunning) {
      return;
    }
    playwrightRecoveryRunning = true;
    void reapPlaywrightSessions({
      staleAfterMs: config.staleAfterMs,
      dryRun: false,
      force: true,
    })
      .then((result) => {
        params.logPlaywrightRecovery?.info("playwright recovery completed", {
          staleAfterMs: result.staleAfterMs,
          eligibleCount: result.eligibleCount,
          targetCount: result.targets.length,
          reapedCount: result.targets.filter((target) => target.remainingPids.length === 0).length,
          targetedChromeCount: result.targetedChromeCount,
          targetedCrashpadCount: result.targetedCrashpadCount,
          ok: result.ok,
        });
      })
      .catch((err) => {
        params.logPlaywrightRecovery?.warn("playwright recovery failed", {
          error: formatError(err),
        });
      })
      .finally(() => {
        playwrightRecoveryRunning = false;
      });
  };
  const playwrightRecoveryInterval =
    params.playwrightRecovery?.enabled && params.playwrightRecovery.intervalMs > 0
      ? setInterval(runPlaywrightRecovery, params.playwrightRecovery.intervalMs)
      : null;

  return {
    tickInterval,
    healthInterval,
    dedupeCleanup,
    mediaCleanup,
    playwrightRecoveryInterval,
  };
}
