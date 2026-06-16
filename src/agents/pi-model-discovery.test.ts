import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, discoverModels } from "./pi-model-discovery.js";

function makeAgentDir() {
  return mkdtempSync(path.join(tmpdir(), "openclaw-pi-model-discovery-"));
}

function writeModelsJson(agentDir: string, config: unknown): void {
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(config));
}

const ENV_KEYS = [
  "RAW_MODEL_LITERAL_KEY",
  "RAW_MODEL_TEMPLATE_KEY",
  "RAW_MODEL_HEADER_LITERAL",
  "RAW_MODEL_HEADER_TEMPLATE",
];

describe("pi model discovery", () => {
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnv = {};
    for (const key of ENV_KEYS) {
      previousEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("find returns raw models.json overlay when it overrides a built-in model", () => {
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        minimax: {
          baseUrl: "https://proxy.example.test/v1",
          api: "anthropic-messages",
          models: [
            {
              id: "MiniMax-M2.1",
              name: "MiniMax M2.1 via proxy",
              contextWindow: 999_999,
              maxTokens: 12_345,
            },
          ],
        },
      },
    });

    const authStorage = AuthStorage.inMemory({
      minimax: { type: "api_key", key: "sk-test" },
    });
    const registry = discoverModels(authStorage, agentDir);

    const listed = registry
      .getAll()
      .find((model) => model.provider === "minimax" && model.id === "MiniMax-M2.1");
    const found = registry.find("minimax", "MiniMax-M2.1");

    expect(listed?.baseUrl).toBe("https://proxy.example.test/v1");
    expect(found?.baseUrl).toBe("https://proxy.example.test/v1");
    expect(found?.contextWindow).toBe(999_999);
  });

  it("layers sparse raw overrides onto built-in model capabilities", () => {
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        minimax: {
          baseUrl: "https://proxy.example.test/v1",
          models: [
            {
              id: "MiniMax-M2.1",
              contextWindow: 999_999,
              maxTokens: 12_345,
            },
          ],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);
    const found = registry.find("minimax", "MiniMax-M2.1");
    const listed = registry
      .getAll()
      .find((model) => model.provider === "minimax" && model.id === "MiniMax-M2.1");

    expect(found?.baseUrl).toBe("https://proxy.example.test/v1");
    expect(found?.contextWindow).toBe(999_999);
    expect(found?.maxTokens).toBe(12_345);
    expect(found?.reasoning).toBe(true);
    expect(found?.input).toEqual(["text"]);
    expect(listed?.reasoning).toBe(true);
    expect(listed?.input).toEqual(["text"]);
  });

  it("preserves maxImagesPerPrompt from raw model definitions", () => {
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "qwen-openai": {
          baseUrl: "http://127.0.0.1:8000/v1",
          api: "openai-completions",
          models: [
            {
              id: "qwen/qwen3.6-27b",
              name: "Qwen 3.6 27B",
              input: ["text", "image"],
              maxImagesPerPrompt: 2,
            },
          ],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);
    const found = registry.find("qwen-openai", "qwen/qwen3.6-27b") as
      | { maxImagesPerPrompt?: number }
      | undefined;

    expect(found?.maxImagesPerPrompt).toBe(2);
  });

  it("drops stale dynamic apiKey when a provider is re-registered without one", async () => {
    const registry = discoverModels(AuthStorage.inMemory(), makeAgentDir());

    registry.registerProvider("dynamic-proxy", {
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "DYNAMIC_PROXY_KEY",
    });
    expect(await registry.getApiKeyForProvider("dynamic-proxy")).toBe("DYNAMIC_PROXY_KEY");

    registry.registerProvider("dynamic-proxy", {
      baseUrl: "https://proxy.example.test/v2",
    });

    expect(await registry.getApiKeyForProvider("dynamic-proxy")).toBeUndefined();
  });

  it("keeps unauthenticated raw models in getAll but excludes them from getAvailable", () => {
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "unauth-proxy": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          models: [
            {
              id: "custom-model",
              name: "Custom Model",
            },
          ],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);

    expect(
      registry
        .getAll()
        .some((model) => model.provider === "unauth-proxy" && model.id === "custom-model"),
    ).toBe(true);
    expect(
      registry
        .getAvailable()
        .some((model) => model.provider === "unauth-proxy" && model.id === "custom-model"),
    ).toBe(false);
  });

  it("preserves literal raw apiKey strings even when an env var has the same name", async () => {
    process.env.RAW_MODEL_LITERAL_KEY = "env-secret";
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "literal-proxy": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          apiKey: "RAW_MODEL_LITERAL_KEY",
          models: [{ id: "custom-model" }],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);

    await expect(registry.getApiKeyForProvider("literal-proxy")).resolves.toBe(
      "RAW_MODEL_LITERAL_KEY",
    );
  });

  it("resolves raw apiKey env templates with ${VAR} syntax", async () => {
    process.env.RAW_MODEL_TEMPLATE_KEY = "env-secret";
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "template-proxy": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          apiKey: "${RAW_MODEL_TEMPLATE_KEY}",
          models: [{ id: "custom-model" }],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);

    await expect(registry.getApiKeyForProvider("template-proxy")).resolves.toBe("env-secret");
  });

  it("does not execute raw apiKey command strings", async () => {
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "command-proxy": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          apiKey: "!printf executed",
          models: [{ id: "custom-model" }],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);

    await expect(registry.getApiKeyForProvider("command-proxy")).resolves.toBe("!printf executed");
  });

  it("resolves raw headers without treating plain strings as env var names", () => {
    process.env.RAW_MODEL_HEADER_LITERAL = "env-header";
    process.env.RAW_MODEL_HEADER_TEMPLATE = "template-header";
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "header-proxy": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          headers: {
            "X-Literal": "RAW_MODEL_HEADER_LITERAL",
            "X-Template": "${RAW_MODEL_HEADER_TEMPLATE}",
            "X-Command": "!printf header",
          },
          models: [{ id: "custom-model" }],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);
    const model = registry.find("header-proxy", "custom-model");

    expect(model?.headers).toEqual({
      "X-Literal": "RAW_MODEL_HEADER_LITERAL",
      "X-Template": "template-header",
      "X-Command": "!printf header",
    });
  });

  it("does not inject provider apiKey into model headers when authHeader is true", () => {
    const agentDir = makeAgentDir();
    writeModelsJson(agentDir, {
      providers: {
        "auth-header-proxy": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          apiKey: "raw-key",
          authHeader: true,
          headers: { "X-Tenant": "tenant" },
          models: [{ id: "custom-model" }],
        },
      },
    });

    const registry = discoverModels(AuthStorage.inMemory(), agentDir);
    const model = registry.find("auth-header-proxy", "custom-model");

    expect(model?.headers).toEqual({ "X-Tenant": "tenant" });
  });
});
