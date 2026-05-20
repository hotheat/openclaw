import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { buildDeepseekProvider, resolveImplicitProviders } from "./models-config.providers.js";

describe("DeepSeek provider", () => {
  it("includes deepseek when DEEPSEEK_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ DEEPSEEK_API_KEY: "test-key" }, async () => {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.deepseek).toBeDefined();
      expect(providers?.deepseek?.apiKey).toBe("DEEPSEEK_API_KEY");
      expect(providers?.deepseek?.baseUrl).toBe("https://api.deepseek.com");
      expect(providers?.deepseek?.api).toBe("openai-completions");
    });
  });

  it("resolves the deepseek api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ DEEPSEEK_API_KEY: "deepseek-test-api-key" }, async () => {
      const auth = await resolveApiKeyForProvider({
        provider: "deepseek",
        agentDir,
      });

      expect(auth.apiKey).toBe("deepseek-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("DEEPSEEK_API_KEY");
    });
  });

  it("builds reasoning-capable DeepSeek V4 models", () => {
    const provider = buildDeepseekProvider();
    const modelIds = provider.models.map((model) => model.id);

    expect(modelIds).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(provider.models.every((model) => model.reasoning)).toBe(true);
  });
});
