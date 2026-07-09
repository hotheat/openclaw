import { describe, expect, it } from "vitest";
import { markContextPruningAutoEnabled } from "../../config/context-pruning-default-marker.js";
import {
  isCacheTtlEligibleProvider,
  shouldTrackContextPruningTtl,
  shouldTrackContextPruningTtlForModel,
} from "./cache-ttl.js";

describe("cache ttl helpers", () => {
  it("keeps Anthropic cache eligibility provider-specific", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("deepseek", "deepseek-chat")).toBe(false);
  });

  it("tracks context pruning ttl from explicit pruning config regardless of provider", () => {
    const cfg = {
      agents: { defaults: { contextPruning: { mode: "cache-ttl" } } },
    };
    expect(shouldTrackContextPruningTtl(cfg)).toBe(true);
    expect(shouldTrackContextPruningTtlForModel(cfg, "deepseek", "deepseek-chat")).toBe(true);
    expect(
      shouldTrackContextPruningTtl({
        agents: { defaults: { contextPruning: { mode: "off" } } },
      }),
    ).toBe(false);
  });

  it("limits auto-enabled cache-ttl tracking to Anthropic-compatible providers", () => {
    const cfg = {
      agents: {
        defaults: {
          contextPruning: markContextPruningAutoEnabled({ mode: "cache-ttl" }),
        },
      },
    };

    expect(shouldTrackContextPruningTtlForModel(cfg, "deepseek", "deepseek-chat")).toBe(false);
    expect(shouldTrackContextPruningTtlForModel(cfg, "anthropic", "claude-sonnet-4")).toBe(true);
    expect(
      shouldTrackContextPruningTtlForModel(cfg, "openrouter", "anthropic/claude-sonnet-4"),
    ).toBe(true);
  });
});
