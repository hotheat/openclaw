import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir } from "../config/paths.js";

const execFileAsync = promisify(execFile);

const PLAYWRIGHT_DAEMON_MARKER = "playwright-core/lib/tools/cli-daemon/program.js";
const PLAYWRIGHT_PROFILE_MARKER = "/tmp/playwright_chromiumdev_profile-";
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const CLOSE_WAIT_MS = 10_000;
const TERM_WAIT_MS = 5_000;
const CRASHPAD_TERM_WAIT_MS = 500;
const GENERIC_SESSION_NAMES = new Set(["default", "browser", "main", "test", "session1"]);
const OPENCLAW_PLAYWRIGHT_SESSION_OWNER = "openclaw";
function defaultKeepOpenLeaseDir(): string {
  return (
    process.env.OPENCLAW_PLAYWRIGHT_LEASE_DIR ||
    path.join(resolveStateDir(), "playwright-cli", "leases")
  );
}

export type PlaywrightSessionClassification = "class1" | "class2" | "class3" | "skipped";

export type PlaywrightProcEntry = {
  pid: number;
  ppid: number;
  cmdline: string[];
  cwd?: string;
  env?: Record<string, string>;
  startTimeMs?: number;
};

export type PlaywrightKeepOpenLease = {
  session: string;
  path: string;
  expiresAtMs: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  workspace?: string;
  reason?: string;
};

export type PlaywrightSessionKeepOpenLeaseReport = {
  path: string;
  expiresAtMs: number;
  expired: boolean;
  workspace?: string;
  reason?: string;
};

export type PlaywrightSessionReport = {
  session: string;
  pid: number;
  cwd?: string;
  ageMs: number | null;
  chromeChildCount: number;
  crashpadCount: number;
  classification: PlaywrightSessionClassification;
  classificationReason: string;
  eligible: boolean;
  skipReason?: string;
  policyViolation?: string;
  keepOpenLease?: PlaywrightSessionKeepOpenLeaseReport;
  chromePids: number[];
  crashpadPids: number[];
};

export type PlaywrightRecoveryReport = {
  scannedAtMs: number;
  staleAfterMs: number;
  totalDaemonSessions: number;
  eligibleCount: number;
  targetedChromeCount: number;
  targetedCrashpadCount: number;
  sessions: PlaywrightSessionReport[];
  skipped: Array<{ session: string; pid: number; reason: string }>;
};

export type ReapTargetResult = PlaywrightSessionReport & {
  closeAttempted: boolean;
  closeError?: string;
  termPids: number[];
  killPids: number[];
  crashpadTermPids: number[];
  remainingPids: number[];
};

export type ReapPlaywrightResult = PlaywrightRecoveryReport & {
  dryRun: boolean;
  targets: ReapTargetResult[];
  ok: boolean;
};

export type PlaywrightRecoveryDeps = {
  scan?: () => Promise<PlaywrightProcEntry[]>;
  keepOpenLeases?: PlaywrightKeepOpenLease[];
  loadKeepOpenLeases?: () => Promise<PlaywrightKeepOpenLease[]>;
  closeSession?: (session: string) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: number | (() => number);
};

export type ScanProcPlaywrightOptions = {
  clockTicksPerSecond?: () => Promise<number | null>;
  nowMs?: number | (() => number);
};

function joinedCmdline(proc: PlaywrightProcEntry): string {
  return proc.cmdline.join(" ");
}

function isPlaywrightDaemon(proc: PlaywrightProcEntry): boolean {
  return joinedCmdline(proc).includes(PLAYWRIGHT_DAEMON_MARKER);
}

function extractSession(proc: PlaywrightProcEntry): string | null {
  const args = proc.cmdline;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-s" || arg === "--session") {
      return args[i + 1]?.trim() || null;
    }
    if (arg.startsWith("-s=")) {
      return arg.slice(3).trim() || null;
    }
    if (arg.startsWith("--session=")) {
      return arg.slice("--session=".length).trim() || null;
    }
  }
  const markerIndex = args.findIndex((arg) => arg.includes(PLAYWRIGHT_DAEMON_MARKER));
  if (markerIndex >= 0) {
    for (const arg of args.slice(markerIndex + 1)) {
      const trimmed = arg.trim();
      if (trimmed && !trimmed.startsWith("-")) {
        return trimmed;
      }
    }
  }
  return null;
}

function isOpenClawSessionName(session: string): boolean {
  return /^(feishu-group-oc_|feishu-ou_|group-oc_)/.test(session);
}

function isOpenClawWorkspaceCwd(cwd: string | undefined): boolean {
  if (!cwd) {
    return false;
  }
  const stateDir = resolveStateDir();
  const relative = path.relative(stateDir, cwd);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const workspaceSegment = relative.split(path.sep)[0] ?? "";
  return workspaceSegment === "workspace" || workspaceSegment.startsWith("workspace-");
}

function hasOpenClawOwnershipEvidence(proc: PlaywrightProcEntry, session: string): boolean {
  if (GENERIC_SESSION_NAMES.has(session)) {
    return false;
  }
  const env = proc.env ?? {};
  return (
    env.OPENCLAW_PLAYWRIGHT_SESSION_OWNER === OPENCLAW_PLAYWRIGHT_SESSION_OWNER &&
    env.PW_SESSION === session
  );
}

function policyViolationForSession(session: string): string | undefined {
  if (session === "default") {
    return "implicit-default-session";
  }
  if (GENERIC_SESSION_NAMES.has(session)) {
    return "generic-session-name";
  }
  return undefined;
}

function classifyDaemon(
  proc: PlaywrightProcEntry,
  session: string,
): {
  classification: PlaywrightSessionClassification;
  reason: string;
} {
  if (isOpenClawSessionName(session)) {
    return {
      classification: "class1",
      reason: "session name matches OpenClaw routing scope",
    };
  }
  if (hasOpenClawOwnershipEvidence(proc, session)) {
    return {
      classification: "class2",
      reason: "non-standard session has OpenClaw ownership evidence",
    };
  }
  if (isOpenClawWorkspaceCwd(proc.cwd)) {
    return {
      classification: "class3",
      reason: "daemon cwd is under OpenClaw workspace",
    };
  }
  return {
    classification: "skipped",
    reason: "daemon has no OpenClaw ownership evidence",
  };
}

function buildChildrenByParent(
  processes: PlaywrightProcEntry[],
): Map<number, PlaywrightProcEntry[]> {
  const children = new Map<number, PlaywrightProcEntry[]>();
  for (const proc of processes) {
    const existing = children.get(proc.ppid) ?? [];
    existing.push(proc);
    children.set(proc.ppid, existing);
  }
  return children;
}

function collectDescendants(
  rootPid: number,
  childrenByParent: Map<number, PlaywrightProcEntry[]>,
): PlaywrightProcEntry[] {
  const out: PlaywrightProcEntry[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const proc = queue.shift();
    if (!proc || seen.has(proc.pid)) {
      continue;
    }
    seen.add(proc.pid);
    out.push(proc);
    queue.push(...(childrenByParent.get(proc.pid) ?? []));
  }
  return out;
}

function isPlaywrightProfileChrome(proc: PlaywrightProcEntry): boolean {
  return joinedCmdline(proc).includes(PLAYWRIGHT_PROFILE_MARKER);
}

function isCrashpadHandler(proc: PlaywrightProcEntry): boolean {
  const cmd = joinedCmdline(proc);
  return cmd.includes("crashpad") || cmd.includes("--type=crashpad-handler");
}

function ageMs(proc: PlaywrightProcEntry, nowMs: number): number | null {
  if (typeof proc.startTimeMs !== "number" || !Number.isFinite(proc.startTimeMs)) {
    return null;
  }
  return Math.max(0, nowMs - proc.startTimeMs);
}

function safeLeaseFileName(session: string): string {
  return `${session.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeKeepOpenLease(
  raw: unknown,
  filePath: string,
): PlaywrightKeepOpenLease | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.keepOpen !== true) {
    return undefined;
  }
  const session = typeof record.session === "string" ? record.session.trim() : "";
  const expiresAtMs = parseTimestampMs(record.expiresAt ?? record.expiresAtMs);
  if (!session || expiresAtMs === undefined) {
    return undefined;
  }
  return {
    session,
    path: filePath,
    expiresAtMs,
    createdAtMs: parseTimestampMs(record.createdAt ?? record.createdAtMs),
    updatedAtMs: parseTimestampMs(record.updatedAt ?? record.updatedAtMs),
    workspace: typeof record.workspace === "string" ? record.workspace : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

function indexKeepOpenLeasesBySession(
  leases: PlaywrightKeepOpenLease[],
): Map<string, PlaywrightKeepOpenLease> {
  const leasesBySession = new Map<string, PlaywrightKeepOpenLease>();
  for (const lease of leases) {
    const existing = leasesBySession.get(lease.session);
    if (!existing || lease.expiresAtMs > existing.expiresAtMs) {
      leasesBySession.set(lease.session, lease);
    }
  }
  return leasesBySession;
}

export function resolvePlaywrightKeepOpenLeasePath(session: string): string {
  return path.join(defaultKeepOpenLeaseDir(), safeLeaseFileName(session));
}

export async function loadPlaywrightKeepOpenLeases(
  dir = defaultKeepOpenLeaseDir(),
): Promise<PlaywrightKeepOpenLease[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const leases: PlaywrightKeepOpenLease[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, entry);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const lease = normalizeKeepOpenLease(parsed, filePath);
      if (lease) {
        leases.push(lease);
      }
    } catch {
      // Malformed lease files are ignored; they must not make recovery unsafe.
    }
  }
  return leases;
}

export function parseDurationMs(
  input: string | undefined,
  fallbackMs = DEFAULT_STALE_AFTER_MS,
): number {
  if (!input?.trim()) {
    return fallbackMs;
  }
  const match = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`Invalid duration: ${input}`);
  }
  const value = Number.parseFloat(match[1] ?? "");
  const unit = match[2] ?? "ms";
  const factor =
    unit === "d"
      ? 24 * 60 * 60 * 1000
      : unit === "h"
        ? 60 * 60 * 1000
        : unit === "m"
          ? 60 * 1000
          : unit === "s"
            ? 1000
            : 1;
  return Math.max(1, Math.floor(value * factor));
}

export function buildPlaywrightRecoveryReport(params: {
  processes: PlaywrightProcEntry[];
  keepOpenLeases?: PlaywrightKeepOpenLease[];
  nowMs?: number;
  staleAfterMs?: number;
}): PlaywrightRecoveryReport {
  const nowMs = params.nowMs ?? Date.now();
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const childrenByParent = buildChildrenByParent(params.processes);
  const leasesBySession = indexKeepOpenLeasesBySession(params.keepOpenLeases ?? []);
  const sessions: PlaywrightSessionReport[] = [];

  for (const proc of params.processes.filter(isPlaywrightDaemon)) {
    const session = extractSession(proc) ?? "(unknown)";
    const descendants = collectDescendants(proc.pid, childrenByParent);
    const chromeChildren = descendants.filter(isPlaywrightProfileChrome);
    const crashpads = descendants.filter(isCrashpadHandler);
    const classification = classifyDaemon(proc, session);
    const computedAgeMs = ageMs(proc, nowMs);
    const keepOpenLease = leasesBySession.get(session);
    const keepOpenLeaseReport = keepOpenLease
      ? {
          path: keepOpenLease.path,
          expiresAtMs: keepOpenLease.expiresAtMs,
          expired: keepOpenLease.expiresAtMs <= nowMs,
          workspace: keepOpenLease.workspace,
          reason: keepOpenLease.reason,
        }
      : undefined;
    const stale = computedAgeMs === null ? false : computedAgeMs >= staleAfterMs;
    const policyViolation = policyViolationForSession(session);
    const keepOpenActive = keepOpenLeaseReport !== undefined && !keepOpenLeaseReport.expired;
    const eligible =
      classification.classification !== "skipped" && stale && !keepOpenActive && !policyViolation;
    const skipReason =
      classification.classification === "skipped"
        ? classification.reason
        : policyViolation
          ? policyViolation
          : keepOpenActive
            ? "keep-open-lease"
            : stale
              ? undefined
              : "session is not stale";

    sessions.push({
      session,
      pid: proc.pid,
      cwd: proc.cwd,
      ageMs: computedAgeMs,
      chromeChildCount: chromeChildren.length,
      crashpadCount: crashpads.length,
      classification: classification.classification,
      classificationReason: classification.reason,
      eligible,
      skipReason,
      policyViolation,
      keepOpenLease: keepOpenLeaseReport,
      chromePids: chromeChildren.map((child) => child.pid),
      crashpadPids: crashpads.map((child) => child.pid),
    });
  }

  const targets = sessions.filter((session) => session.eligible);
  return {
    scannedAtMs: nowMs,
    staleAfterMs,
    totalDaemonSessions: sessions.length,
    eligibleCount: targets.length,
    targetedChromeCount: targets.reduce((sum, session) => sum + session.chromeChildCount, 0),
    targetedCrashpadCount: targets.reduce((sum, session) => sum + session.crashpadCount, 0),
    sessions,
    skipped: sessions
      .filter((session) => !session.eligible)
      .map((session) => ({
        session: session.session,
        pid: session.pid,
        reason: session.skipReason ?? "not eligible",
      })),
  };
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseNullSeparated(value: string | null): string[] {
  return (value ?? "").split("\0").filter(Boolean);
}

function parseEnv(value: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of parseNullSeparated(value)) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      continue;
    }
    out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}

function parseProcStat(value: string | null): { ppid: number; startTicks: number } | null {
  if (!value) {
    return null;
  }
  const end = value.lastIndexOf(")");
  if (end < 0) {
    return null;
  }
  const fields = value
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const startTicks = Number.parseInt(fields[19] ?? "", 10);
  if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) {
    return null;
  }
  return { ppid, startTicks };
}

async function readSystemUptimeMs(procRoot: string): Promise<number | null> {
  const text = await readText(path.join(procRoot, "uptime"));
  const uptimeSec = Number.parseFloat(text?.split(/\s+/)[0] ?? "");
  return Number.isFinite(uptimeSec) ? uptimeSec * 1000 : null;
}

async function resolveClockTicksPerSecond(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("getconf", ["CLK_TCK"], {
      timeout: 5_000,
      windowsHide: true,
    });
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function scanProcPlaywrightEntries(
  procRoot = "/proc",
  options: ScanProcPlaywrightOptions = {},
): Promise<PlaywrightProcEntry[]> {
  if (process.platform !== "linux") {
    throw new Error("Playwright recovery is supported only on Linux hosts because it uses /proc.");
  }
  const uptimeMs = await readSystemUptimeMs(procRoot);
  const clockTicksPerSecond = await (options.clockTicksPerSecond ?? resolveClockTicksPerSecond)();
  const nowSource = options.nowMs;
  const nowMs = typeof nowSource === "function" ? nowSource() : (nowSource ?? Date.now());
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: PlaywrightProcEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number.parseInt(entry.name, 10);
    const root = path.join(procRoot, entry.name);
    const cmdline = parseNullSeparated(await readText(path.join(root, "cmdline")));
    if (cmdline.length === 0) {
      continue;
    }
    const stat = parseProcStat(await readText(path.join(root, "stat")));
    let cwd: string | undefined;
    try {
      cwd = await fs.readlink(path.join(root, "cwd"));
    } catch {
      cwd = undefined;
    }
    const startTimeMs =
      stat && uptimeMs !== null && clockTicksPerSecond !== null
        ? nowMs - (uptimeMs - (stat.startTicks / clockTicksPerSecond) * 1000)
        : undefined;
    out.push({
      pid,
      ppid: stat?.ppid ?? 0,
      cmdline,
      cwd,
      env: parseEnv(await readText(path.join(root, "environ"))),
      startTimeMs,
    });
  }
  return out;
}

async function closePlaywrightSession(session: string): Promise<void> {
  await execFileAsync("playwright-cli", [`-s=${session}`, "close"], {
    timeout: 15_000,
    windowsHide: true,
  });
}

async function sendSignal(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited or is not signalable.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function livePidSet(processes: PlaywrightProcEntry[]): Set<number> {
  return new Set(processes.map((proc) => proc.pid));
}

function targetTreePidsFromReport(report: PlaywrightSessionReport): number[] {
  return [report.pid, ...report.chromePids];
}

function findProcessByPid(
  processes: readonly PlaywrightProcEntry[],
  pid: number,
): PlaywrightProcEntry | undefined {
  return processes.find((proc) => proc.pid === pid);
}

function collectTargetSessionPidsFromProcesses(
  processes: PlaywrightProcEntry[],
  fallback: PlaywrightSessionReport,
): { treePids: number[]; crashpadPids: number[] } {
  const daemon = findProcessByPid(processes, fallback.pid);
  if (!daemon) {
    return {
      treePids: [],
      crashpadPids: fallback.crashpadPids.filter((pid) => findProcessByPid(processes, pid)),
    };
  }
  const childrenByParent = buildChildrenByParent(processes);
  const descendants = collectDescendants(daemon.pid, childrenByParent);
  const treePids = [
    daemon.pid,
    ...descendants.filter(isPlaywrightProfileChrome).map((proc) => proc.pid),
  ];
  const crashpadPids = descendants.filter(isCrashpadHandler).map((proc) => proc.pid);
  return { treePids, crashpadPids };
}

function isChromeProcess(proc: PlaywrightProcEntry): boolean {
  const cmd = joinedCmdline(proc).toLowerCase();
  return cmd.includes("chrome") || cmd.includes("chromium");
}

function crashpadStillReferenced(processes: PlaywrightProcEntry[], crashpadPid: number): boolean {
  const needle = `--crashpad-handler-pid=${crashpadPid}`;
  return processes.some((proc) => isChromeProcess(proc) && joinedCmdline(proc).includes(needle));
}

function errorToString(err: unknown): string {
  return err instanceof Error ? String(err) : String(err);
}

export async function reapPlaywrightSessions(
  params: {
    staleAfterMs?: number;
    dryRun?: boolean;
    force?: boolean;
  } & PlaywrightRecoveryDeps = {},
): Promise<ReapPlaywrightResult> {
  const scan = params.scan ?? scanProcPlaywrightEntries;
  const loadLeases = params.loadKeepOpenLeases ?? loadPlaywrightKeepOpenLeases;
  const closeSession = params.closeSession ?? closePlaywrightSession;
  const kill = params.kill ?? sendSignal;
  const wait = params.sleep ?? sleep;
  const nowMs = typeof params.nowMs === "function" ? params.nowMs() : (params.nowMs ?? Date.now());
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const dryRun = params.dryRun === true || params.force !== true;
  const initialProcesses = await scan();
  const keepOpenLeases = params.keepOpenLeases ?? (await loadLeases());
  const report = buildPlaywrightRecoveryReport({
    processes: initialProcesses,
    keepOpenLeases,
    nowMs,
    staleAfterMs,
  });
  const targets = report.sessions.filter((session) => session.eligible);
  const targetResults: ReapTargetResult[] = [];

  if (dryRun) {
    return {
      ...report,
      dryRun,
      targets: targets.map((target) => ({
        ...target,
        closeAttempted: false,
        termPids: [],
        killPids: [],
        crashpadTermPids: [],
        remainingPids: [],
      })),
      ok: true,
    };
  }

  for (const target of targets) {
    let closeError: string | undefined;
    try {
      await closeSession(target.session);
    } catch (err) {
      closeError = errorToString(err);
    }
    await wait(CLOSE_WAIT_MS);

    let afterClose = await scan();
    let live = livePidSet(afterClose);
    const afterCloseTargets = collectTargetSessionPidsFromProcesses(afterClose, target);
    const targetTreePids = afterCloseTargets.treePids.length
      ? afterCloseTargets.treePids
      : targetTreePidsFromReport(target);
    const termPids = targetTreePids.filter((pid) => live.has(pid));
    for (const pid of termPids) {
      await kill(pid, "SIGTERM");
    }

    await wait(TERM_WAIT_MS);
    afterClose = await scan();
    live = livePidSet(afterClose);
    const killPids = termPids.filter((pid) => live.has(pid));
    for (const pid of killPids) {
      await kill(pid, "SIGKILL");
    }

    let afterKill = await scan();
    live = livePidSet(afterKill);
    const afterKillTargets = collectTargetSessionPidsFromProcesses(afterKill, target);
    const crashpadPids = afterKillTargets.crashpadPids.length
      ? afterKillTargets.crashpadPids
      : target.crashpadPids;
    const crashpadTermPids = crashpadPids.filter(
      (pid) => live.has(pid) && !crashpadStillReferenced(afterKill, pid),
    );
    for (const pid of crashpadTermPids) {
      await kill(pid, "SIGTERM");
    }
    if (crashpadTermPids.length > 0) {
      await wait(CRASHPAD_TERM_WAIT_MS);
      afterKill = await scan();
      live = livePidSet(afterKill);
    }

    const remainingPids = [...targetTreePids, ...crashpadTermPids].filter((pid) => live.has(pid));
    targetResults.push({
      ...target,
      closeAttempted: true,
      closeError,
      termPids,
      killPids,
      crashpadTermPids,
      remainingPids,
    });
  }

  return {
    ...report,
    dryRun,
    targets: targetResults,
    ok: targetResults.every((target) => target.remainingPids.length === 0),
  };
}

export function formatPlaywrightRecoveryText(report: PlaywrightRecoveryReport): string {
  const lines = [
    `daemon sessions: ${report.totalDaemonSessions}`,
    `eligible for reaping: ${report.eligibleCount}`,
    `target chrome descendants: ${report.targetedChromeCount}`,
    `target crashpad handlers: ${report.targetedCrashpadCount}`,
  ];
  for (const session of report.sessions) {
    const age =
      typeof session.ageMs === "number" ? `${Math.floor(session.ageMs / 1000)}s` : "unknown";
    const leaseExpires = session.keepOpenLease?.expiresAtMs
      ? new Date(session.keepOpenLease.expiresAtMs).toISOString()
      : undefined;
    lines.push(
      [
        `${session.eligible ? "target" : "skip"} ${session.session}`,
        `pid=${session.pid}`,
        `class=${session.classification}`,
        `age=${age}`,
        session.cwd ? `cwd=${session.cwd}` : undefined,
        `chrome=${session.chromeChildCount}`,
        `crashpad=${session.crashpadCount}`,
        leaseExpires ? `leaseExpires=${leaseExpires}` : undefined,
        session.keepOpenLease?.expired === true ? "lease=expired" : undefined,
        session.skipReason ? `reason=${session.skipReason}` : undefined,
        session.policyViolation ? `policy=${session.policyViolation}` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return lines.join(os.EOL);
}
