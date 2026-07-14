import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const SNAPSHOT_VERSION = 1 as const;
const RESULT_REF_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type PersistedSubagentResult = {
  version: typeof SNAPSHOT_VERSION;
  resultRef: string;
  sessionKey: string;
  result: string;
  createdAt: number;
};

let lastCleanupAt = 0;

function resolveSubagentResultDir(env: NodeJS.ProcessEnv = process.env): string {
  const hasExplicitStateDir = Boolean(env.OPENCLAW_STATE_DIR?.trim());
  const stateDir =
    hasExplicitStateDir || !(env.VITEST || env.NODE_ENV === "test")
      ? resolveStateDir(env)
      : path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  return path.join(stateDir, "subagents", "results");
}

function resolveSnapshotPath(resultRef: string): string | undefined {
  if (!RESULT_REF_PATTERN.test(resultRef)) {
    return undefined;
  }
  return path.join(resolveSubagentResultDir(), `${resultRef}.json`);
}

async function cleanupExpiredSnapshots(dir: string, now: number): Promise<void> {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanupAt = now;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.allSettled(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const pathname = path.join(dir, entry.name);
        const stat = await fs.stat(pathname);
        if (now - stat.mtimeMs > RESULT_RETENTION_MS) {
          await fs.rm(pathname, { force: true });
        }
      }),
  );
}

export async function persistSubagentResultSnapshot(params: {
  announceId: string;
  sessionKey: string;
  result: string;
}): Promise<string> {
  const resultRef = createHash("sha256")
    .update(params.announceId)
    .update("\0")
    .update(params.sessionKey)
    .update("\0")
    .update(params.result)
    .digest("hex");
  const pathname = resolveSnapshotPath(resultRef);
  if (!pathname) {
    throw new Error("failed to build subagent result reference");
  }
  const dir = path.dirname(pathname);
  const now = Date.now();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanupExpiredSnapshots(dir, now);

  const snapshot: PersistedSubagentResult = {
    version: SNAPSHOT_VERSION,
    resultRef,
    sessionKey: params.sessionKey,
    result: params.result,
    createdAt: now,
  };
  const tmp = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, pathname);
    await fs.chmod(pathname, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  return resultRef;
}

export async function readSubagentResultSnapshot(params: {
  resultRef: string;
  sessionKey: string;
}): Promise<string | undefined> {
  const pathname = resolveSnapshotPath(params.resultRef);
  if (!pathname) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(pathname, "utf8");
    const snapshot = JSON.parse(raw) as Partial<PersistedSubagentResult>;
    if (
      snapshot.version !== SNAPSHOT_VERSION ||
      snapshot.resultRef !== params.resultRef ||
      snapshot.sessionKey !== params.sessionKey ||
      typeof snapshot.result !== "string"
    ) {
      return undefined;
    }
    return snapshot.result;
  } catch {
    return undefined;
  }
}

export function resetSubagentResultStoreForTests(): void {
  lastCleanupAt = 0;
}
