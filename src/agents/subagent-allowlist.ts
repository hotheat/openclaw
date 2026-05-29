import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ResolvedSubagentAllowlist = {
  allowAgents: string[];
  allowAny: boolean;
  allowSet: Set<string>;
};

export function resolveSubagentAllowAgents(
  cfg: OpenClawConfig,
  requesterAgentId: string,
): string[] {
  const defaults = cfg.agents?.defaults?.subagents?.allowAgents ?? [];
  const agent = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...defaults, ...agent]) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed === "*" ? "*" : normalizeAgentId(trimmed);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

export function resolveSubagentAllowlist(
  cfg: OpenClawConfig,
  requesterAgentId: string,
): ResolvedSubagentAllowlist {
  const allowAgents = resolveSubagentAllowAgents(cfg, requesterAgentId);
  const allowAny = allowAgents.some((value) => value.trim() === "*");
  const allowSet = new Set(
    allowAgents
      .filter((value) => value.trim() && value.trim() !== "*")
      .map((value) => normalizeAgentId(value).toLowerCase()),
  );
  return { allowAgents, allowAny, allowSet };
}
