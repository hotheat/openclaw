import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type PersistedSubagentRegistryVersion = 1 | 2;

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const REGISTRY_VERSION = 2 as const;
const DEFAULT_REGISTRY_WRITE_COALESCE_MS = 150;
const log = createSubsystemLogger("subagent-registry/store");

type PersistedSubagentRunRecord = SubagentRunRecord;

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

type RegistryWriteQueue = {
  pending?: PersistedSubagentRegistry;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
  lastError?: unknown;
};

const REGISTRY_WRITE_QUEUES = new Map<string, RegistryWriteQueue>();

function resolveRegistryWriteCoalesceMs(): number {
  const raw = process.env.OPENCLAW_SUBAGENT_WRITE_COALESCE_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return process.env.VITEST || process.env.NODE_ENV === "test"
    ? 5
    : DEFAULT_REGISTRY_WRITE_COALESCE_MS;
}

async function writeSubagentRegistryAtomic(
  pathname: string,
  value: PersistedSubagentRegistry,
): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const dir = path.dirname(pathname);
  const tmp = path.join(
    dir,
    `${path.basename(pathname)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tmp, json, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, pathname);
    await fs.chmod(pathname, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function scheduleRegistryWrite(pathname: string, queue: RegistryWriteQueue): void {
  if (queue.timer || queue.inFlight || !queue.pending) {
    return;
  }
  queue.timer = setTimeout(() => {
    queue.timer = undefined;
    void startRegistryWrite(pathname);
  }, resolveRegistryWriteCoalesceMs());
}

function startRegistryWrite(pathname: string): Promise<void> {
  const queue = REGISTRY_WRITE_QUEUES.get(pathname);
  if (!queue) {
    return Promise.resolve();
  }
  if (queue.inFlight) {
    return queue.inFlight;
  }
  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
  }
  const pending = queue.pending;
  queue.pending = undefined;
  if (!pending) {
    REGISTRY_WRITE_QUEUES.delete(pathname);
    return Promise.resolve();
  }

  const inFlight = writeSubagentRegistryAtomic(pathname, pending)
    .then(() => {
      queue.lastError = undefined;
    })
    .catch((err) => {
      queue.lastError = err;
      log.warn("failed to persist subagent registry", {
        path: pathname,
        error: String(err),
      });
    })
    .finally(() => {
      queue.inFlight = undefined;
      if (queue.pending) {
        scheduleRegistryWrite(pathname, queue);
      } else if (!queue.lastError) {
        REGISTRY_WRITE_QUEUES.delete(pathname);
      }
    });
  queue.inFlight = inFlight;
  return inFlight;
}

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveSubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, SubagentRunRecord>();
  const isLegacy = record.version === 1;
  let shouldRewrite = false;
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const persistedCleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const interruptedCleanup = persistedCleanupHandled === true && cleanupCompletedAt == null;
    const cleanupHandled = interruptedCleanup ? false : persistedCleanupHandled;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: typeof typed.requesterChannel === "string" ? typed.requesterChannel : undefined,
        accountId:
          typeof typed.requesterAccountId === "string" ? typed.requesterAccountId : undefined,
      },
    );
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      spawnMode: typed.spawnMode === "session" ? "session" : "run",
    });
    if (isLegacy) {
      shouldRewrite = true;
    }
    if (interruptedCleanup) {
      shouldRewrite = true;
    }
  }
  if (shouldRewrite) {
    try {
      saveSubagentRegistryToDisk(out);
    } catch {
      // ignore migration write failures
    }
  }
  return out;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>): void {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  const queue = REGISTRY_WRITE_QUEUES.get(pathname) ?? {};
  queue.pending = out;
  REGISTRY_WRITE_QUEUES.set(pathname, queue);
  scheduleRegistryWrite(pathname, queue);
}

export async function flushSubagentRegistryWrites(pathname?: string): Promise<void> {
  const paths = pathname ? [pathname] : [...REGISTRY_WRITE_QUEUES.keys()];
  for (const currentPath of paths) {
    while (true) {
      const queue = REGISTRY_WRITE_QUEUES.get(currentPath);
      if (!queue) {
        break;
      }
      if (queue.pending && !queue.inFlight) {
        void startRegistryWrite(currentPath);
      }
      if (queue.inFlight) {
        await queue.inFlight;
        continue;
      }
      if (queue.lastError) {
        const error = queue.lastError;
        REGISTRY_WRITE_QUEUES.delete(currentPath);
        throw error;
      }
      break;
    }
  }
}
