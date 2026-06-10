import type { OpenClawConfig } from "../config/config.js";
import { findNormalizedProviderValue } from "./model-selection.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

function resolveProviderTimeoutSeconds(
  cfg: OpenClawConfig | undefined,
  provider: string | null | undefined,
): number | undefined {
  const providerKey = provider?.trim();
  if (!providerKey) {
    return undefined;
  }
  return normalizeNumber(
    findNormalizedProviderValue(cfg?.models?.providers, providerKey)?.timeoutSeconds,
  );
}

export function resolveAgentTimeoutSeconds(
  cfg?: OpenClawConfig,
  opts?: { provider?: string | null },
): number {
  const providerSeconds = resolveProviderTimeoutSeconds(cfg, opts?.provider);
  const raw = providerSeconds ?? normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  provider?: string | null;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const clampTimeoutMs = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
  const defaultMs = clampTimeoutMs(
    resolveAgentTimeoutSeconds(opts.cfg, { provider: opts.provider }) * 1000,
  );
  // Use the maximum timer-safe timeout to represent "no timeout" when explicitly set to 0.
  const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideSeconds * 1000);
  }
  return defaultMs;
}
