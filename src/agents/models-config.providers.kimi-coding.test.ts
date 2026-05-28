import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  buildKimiCodingProvider,
  buildKimiProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

describe("kimi-coding implicit provider (#22409)", () => {
  it("should include kimi when KIMI_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KIMI_API_KEY"]);
    process.env.KIMI_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.kimi).toBeDefined();
      expect(providers?.kimi?.api).toBe("anthropic-messages");
      expect(providers?.kimi?.baseUrl).toBe("https://api.kimi.com/coding/");
      expect(providers?.kimi?.models?.[0]?.id).toBe("kimi-for-coding");
      expect(providers?.["kimi-coding"]).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build kimi provider with anthropic-messages API", () => {
    const provider = buildKimiProvider();
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models[0].id).toBe("kimi-for-coding");
  });

  it("keeps kimi-coding builder as a compatibility alias", () => {
    expect(buildKimiCodingProvider()).toEqual(buildKimiProvider());
  });

  it("should not include kimi when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KIMI_API_KEY"]);
    delete process.env.KIMI_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.kimi).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
