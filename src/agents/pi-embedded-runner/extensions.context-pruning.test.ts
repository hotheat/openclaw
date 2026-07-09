import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { markContextPruningAutoEnabled } from "../../config/context-pruning-default-marker.js";
import { getContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

describe("buildEmbeddedExtensionFactories context pruning", () => {
  it("registers context pruning for explicit cache-ttl mode without provider allowlist", () => {
    const sessionManager = SessionManager.inMemory();
    const cfg = {
      agents: {
        defaults: {
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "deepseek",
      modelId: "deepseek-chat",
      model: { id: "deepseek-chat", name: "DeepSeek", contextWindow: 65_536 } as never,
    });

    expect(factories).toHaveLength(1);
    expect(getContextPruningRuntime(sessionManager)?.contextWindowTokens).toBe(65_536);
  });

  it("does not register auto-enabled cache-ttl pruning for ineligible providers", () => {
    const sessionManager = SessionManager.inMemory();
    const cfg = {
      agents: {
        defaults: {
          contextPruning: markContextPruningAutoEnabled({ mode: "cache-ttl", ttl: "5m" }),
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "deepseek",
      modelId: "deepseek-chat",
      model: { id: "deepseek-chat", name: "DeepSeek", contextWindow: 65_536 } as never,
    });

    expect(factories).toHaveLength(0);
    expect(getContextPruningRuntime(sessionManager)).toBeNull();
  });

  it("registers auto-enabled cache-ttl pruning for Anthropic-compatible providers", () => {
    const sessionManager = SessionManager.inMemory();
    const cfg = {
      agents: {
        defaults: {
          contextPruning: markContextPruningAutoEnabled({ mode: "cache-ttl", ttl: "5m" }),
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
      model: {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet",
        contextWindow: 200_000,
      } as never,
    });

    expect(factories).toHaveLength(1);
    expect(getContextPruningRuntime(sessionManager)?.contextWindowTokens).toBe(200_000);
  });

  it("does not register context pruning when mode is off", () => {
    const sessionManager = SessionManager.inMemory();
    const cfg = {
      agents: {
        defaults: {
          contextPruning: { mode: "off" },
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "deepseek",
      modelId: "deepseek-chat",
      model: { id: "deepseek-chat", name: "DeepSeek", contextWindow: 65_536 } as never,
    });

    expect(factories).toHaveLength(0);
    expect(getContextPruningRuntime(sessionManager)).toBeNull();
  });
});
