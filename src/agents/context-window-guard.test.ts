import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  it("blocks below 16k (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 8000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below 32k but does not block at 16k+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 24_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(24_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at 32k+ (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "tiny",
                name: "tiny",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 12_000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(true);
  });

  it("uses models.defaultContextWindow for provider fallback models", () => {
    const cfg = {
      models: {
        defaultContextWindow: 96_000,
        providers: {
          custom: {
            baseUrl: "http://localhost",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "custom",
      modelId: "dynamic-model",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });

    expect(info.source).toBe("configDefault");
    expect(info.tokens).toBe(96_000);
  });

  it("caps with agents.defaults.contextTokens", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 20_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 200_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("agentContextTokens");
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not override when cap exceeds base window", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 128_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    expect(info.source).toBe("model");
    expect(info.tokens).toBe(64_000);
  });

  it("uses default when nothing else is available", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("blocks default context windows when an explicit window is required", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "otr",
      modelId: "workspace-model",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({
      info,
      requireExplicitContextWindow: true,
      defaultTokens: 200_000,
    });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(true);
    expect(guard.blockReason).toBe("default_required");
  });

  it("allows an explicitly configured 200k context window", () => {
    const cfg = {
      models: {
        providers: {
          otr: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "workspace-model",
                name: "workspace-model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "otr",
      modelId: "workspace-model",
      modelContextWindow: 200_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info, defaultTokens: 200_000 });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(false);
    expect(guard.blockReason).toBeUndefined();
  });

  it("lets a listed model without contextWindow fall back to the default and does not block", () => {
    // A model enumerated in models.providers.*.models[] but missing contextWindow no longer
    // hard-fails: it resolves through models.defaultContextWindow (when set) or the 200k default,
    // and the runtime only warns. Mirrors the provider_config_fallback behavior.
    const providers = {
      otr: {
        baseUrl: "http://localhost",
        apiKey: "x",
        models: [
          {
            id: "workspace-model",
            name: "workspace-model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 8192,
          },
        ],
      },
    };

    const withDefault = resolveContextWindowInfo({
      cfg: { models: { defaultContextWindow: 128_000, providers } } as unknown as OpenClawConfig,
      provider: "otr",
      modelId: "workspace-model",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    expect(withDefault.source).toBe("configDefault");
    expect(withDefault.tokens).toBe(128_000);
    expect(evaluateContextWindowGuard({ info: withDefault }).shouldBlock).toBe(false);

    const withoutDefault = resolveContextWindowInfo({
      cfg: { models: { providers } } as unknown as OpenClawConfig,
      provider: "otr",
      modelId: "workspace-model",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    expect(withoutDefault.source).toBe("default");
    expect(withoutDefault.tokens).toBe(200_000);
    expect(evaluateContextWindowGuard({ info: withoutDefault }).shouldBlock).toBe(false);
  });

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("exports thresholds as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });
});
