import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import type { SkillSnapshot } from "./types.js";

type SkillsChangeEvent = {
  workspaceDir?: string;
  reason: "watch" | "manual" | "remote-node";
  changedPath?: string;
};

type SkillsWatchState = {
  watcher: FSWatcher;
  pathsKey: string;
  debounceMs: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
};

const log = createSubsystemLogger("gateway/skills");
const listeners = new Set<(event: SkillsChangeEvent) => void>();
const workspaceVersions = new Map<string, number>();
const watchers = new Map<string, SkillsWatchState>();
let globalVersion = 0;

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

function bumpVersion(current: number): number {
  const now = Date.now();
  return now <= current ? current + 1 : now;
}

function emit(event: SkillsChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn(`skills change listener failed: ${String(err)}`);
    }
  }
}

function resolveWatchPaths(workspaceDir: string, config?: OpenClawConfig): string[] {
  const paths: string[] = [];
  if (workspaceDir.trim()) {
    paths.push(path.join(workspaceDir, "skills"));
  }
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  paths.push(...extraDirs);
  const pluginSkillDirs = resolvePluginSkillDirs({ workspaceDir, config });
  paths.push(...pluginSkillDirs);
  return paths;
}

function toWatchGlobRoot(raw: string): string {
  // Chokidar treats globs as POSIX-ish patterns. Normalize Windows separators
  // so `*` works consistently across platforms.
  return raw.replaceAll("\\", "/").replace(/\/+$/, "");
}

function resolveWatchTargets(workspaceDir: string, config?: OpenClawConfig): string[] {
  // Skills are defined by SKILL.md; watch only those files to avoid traversing
  // or watching unrelated large trees (e.g. datasets) that can exhaust FDs.
  const targets = new Set<string>();
  for (const root of resolveWatchPaths(workspaceDir, config)) {
    const globRoot = toWatchGlobRoot(root);
    // Some configs point directly at a skill folder.
    targets.add(`${globRoot}/SKILL.md`);
    // Standard layout: <skillsRoot>/<skillName>/SKILL.md
    targets.add(`${globRoot}/*/SKILL.md`);
  }
  return Array.from(targets).toSorted();
}

export function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
  changedPath?: string;
}): number {
  const reason = params?.reason ?? "manual";
  const changedPath = params?.changedPath;
  if (params?.workspaceDir) {
    const current = workspaceVersions.get(params.workspaceDir) ?? 0;
    const next = bumpVersion(current);
    workspaceVersions.set(params.workspaceDir, next);
    emit({ workspaceDir: params.workspaceDir, reason, changedPath });
    return next;
  }
  globalVersion = bumpVersion(globalVersion);
  emit({ reason, changedPath });
  return globalVersion;
}

export function getSkillsSnapshotVersion(workspaceDir?: string): number {
  if (!workspaceDir) {
    return globalVersion;
  }
  const local = workspaceVersions.get(workspaceDir) ?? 0;
  return Math.max(globalVersion, local);
}

/**
 * Detect snapshots whose resolved skill files no longer exist on disk.
 *
 * The in-memory snapshot version resets to 0 on every process restart, so a
 * rename or deletion that happened outside the file watcher (watcher down,
 * missed event, or changes applied while the service was stopped) cannot be
 * detected through version comparison alone: a stale version-0 snapshot keeps
 * being reused indefinitely. Checking that the snapshot's resolved files still
 * exist closes that gap without a full workspace rescan per turn.
 */
export function skillsSnapshotHasMissingFiles(snapshot: SkillSnapshot | undefined): boolean {
  if (!snapshot?.resolvedSkills?.length) {
    return false;
  }
  for (const skill of snapshot.resolvedSkills) {
    if (!skill.filePath) {
      continue;
    }
    try {
      if (!fs.existsSync(skill.filePath)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function ensureSkillsWatcher(params: { workspaceDir: string; config?: OpenClawConfig }) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const debounceMsRaw = params.config?.skills?.load?.watchDebounceMs;
  const debounceMs =
    typeof debounceMsRaw === "number" && Number.isFinite(debounceMsRaw)
      ? Math.max(0, debounceMsRaw)
      : 250;

  const existing = watchers.get(workspaceDir);
  if (!watchEnabled) {
    if (existing) {
      watchers.delete(workspaceDir);
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      void existing.watcher.close().catch(() => {});
    }
    return;
  }

  const watchTargets = resolveWatchTargets(workspaceDir, params.config);
  const pathsKey = watchTargets.join("|");
  if (existing && existing.pathsKey === pathsKey && existing.debounceMs === debounceMs) {
    return;
  }
  if (existing) {
    watchers.delete(workspaceDir);
    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    void existing.watcher.close().catch(() => {});
  }

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    // Avoid FD exhaustion on macOS when a workspace contains huge trees.
    // This watcher only needs to react to SKILL.md changes.
    ignored: DEFAULT_SKILLS_WATCH_IGNORED,
  });

  const state: SkillsWatchState = { watcher, pathsKey, debounceMs };

  const schedule = (changedPath?: string) => {
    state.pendingPath = changedPath ?? state.pendingPath;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      const pendingPath = state.pendingPath;
      state.pendingPath = undefined;
      state.timer = undefined;
      bumpSkillsSnapshotVersion({
        workspaceDir,
        reason: "watch",
        changedPath: pendingPath,
      });
    }, debounceMs);
  };

  watcher.on("add", (p) => schedule(p));
  watcher.on("change", (p) => schedule(p));
  watcher.on("unlink", (p) => schedule(p));
  watcher.on("error", (err) => {
    log.warn(`skills watcher error (${workspaceDir}): ${String(err)}`);
  });

  watchers.set(workspaceDir, state);
}
