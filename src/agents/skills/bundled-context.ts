import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBundledSkillsDir, type BundledSkillsResolveOptions } from "./bundled-dir.js";

const log = createSubsystemLogger("skills");

let cachedBundledContext: { dir: string; names: Set<string> } | null = null;
let warnedMissingBundledSkills = false;
let warnedEmptyBundledSkills = false;

export type BundledSkillsContext = {
  dir?: string;
  names: Set<string>;
};

export type BundledSkillsContextOptions = BundledSkillsResolveOptions & {
  warn?: (message: string) => void;
};

function warnMissingBundledSkillsOnce(opts: BundledSkillsContextOptions): void {
  if (warnedMissingBundledSkills) {
    return;
  }
  warnedMissingBundledSkills = true;
  const message =
    "Bundled skills directory could not be resolved; bundled skill prompt metadata and skills.status entries will be unavailable.";
  if (opts.warn) {
    opts.warn(message);
    return;
  }
  log.warn(message);
}

function warnEmptyBundledSkillsOnce(dir: string, opts: BundledSkillsContextOptions): void {
  if (warnedEmptyBundledSkills) {
    return;
  }
  warnedEmptyBundledSkills = true;
  const message = `Bundled skills directory resolved but no valid skills were loaded from ${dir}; bundled skill prompt metadata and skills.status entries will be unavailable.`;
  if (opts.warn) {
    opts.warn(message);
    return;
  }
  log.warn(message);
}

export function resolveBundledSkillsContext(
  opts: BundledSkillsContextOptions = {},
): BundledSkillsContext {
  const dir = resolveBundledSkillsDir(opts);
  const names = new Set<string>();
  if (!dir) {
    warnMissingBundledSkillsOnce(opts);
    return { dir, names };
  }

  if (cachedBundledContext?.dir === dir) {
    if (cachedBundledContext.names.size === 0) {
      warnEmptyBundledSkillsOnce(dir, opts);
    }
    return { dir, names: new Set(cachedBundledContext.names) };
  }
  const result = loadSkillsFromDir({ dir, source: "openclaw-bundled" });
  for (const skill of result.skills) {
    if (skill.name.trim()) {
      names.add(skill.name);
    }
  }
  if (names.size === 0) {
    warnEmptyBundledSkillsOnce(dir, opts);
  }
  cachedBundledContext = { dir, names: new Set(names) };
  return { dir, names };
}

export function resetBundledSkillsContextForTest(): void {
  cachedBundledContext = null;
  warnedMissingBundledSkills = false;
  warnedEmptyBundledSkills = false;
}
