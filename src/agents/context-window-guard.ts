import type { OpenClawConfig } from "../config/config.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource =
  | "model"
  | "modelsConfig"
  | "configDefault"
  | "agentContextTokens"
  | "default";

export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function findConfiguredProvider(
  cfg: OpenClawConfig | undefined,
  provider: string,
): { models?: Array<{ id?: string; contextWindow?: number }> } | undefined {
  const providers = cfg?.models?.providers as
    | Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>
    | undefined;
  if (!providers) {
    return undefined;
  }
  const exact = providers[provider];
  if (exact) {
    return exact;
  }
  const normalizedProvider = normalizeProviderKey(provider);
  const matched = Object.entries(providers).find(
    ([providerId]) => normalizeProviderKey(providerId) === normalizedProvider,
  );
  return matched?.[1];
}

export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromModelsConfig = (() => {
    const providerEntry = findConfiguredProvider(params.cfg, params.provider);
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextWindow);
  })();
  const fromConfigDefault = normalizePositiveInt(params.cfg?.models?.defaultContextWindow);
  const fromModel = normalizePositiveInt(params.modelContextWindow);
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : fromConfigDefault
        ? { tokens: fromConfigDefault, source: "configDefault" as const }
        : { tokens: Math.floor(params.defaultTokens), source: "default" as const };

  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
  blockReason?: "too_small" | "default_required";
};

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
  requireExplicitContextWindow?: boolean;
  defaultTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  const shouldBlockDefault = Boolean(params.requireExplicitContextWindow);
  const shouldBlockTooSmall = tokens > 0 && tokens < hardMin;
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: shouldBlockTooSmall || shouldBlockDefault,
    blockReason: shouldBlockDefault
      ? "default_required"
      : shouldBlockTooSmall
        ? "too_small"
        : undefined,
  };
}
