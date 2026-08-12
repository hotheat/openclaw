import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => cfg;

describe("memory search config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function configWithDefaultProvider(
    provider: "openai" | "local" | "gemini" | "mistral",
  ): OpenClawConfig {
    return asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider,
          },
        },
      },
    });
  }

  function expectDefaultRemoteBatch(resolved: ReturnType<typeof resolveMemorySearchConfig>): void {
    expect(resolved?.remote?.batch).toEqual({
      enabled: false,
      wait: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
    });
  }

  it("returns null when disabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: { enabled: false },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("defaults provider to auto when unspecified", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("auto");
    expect(resolved?.fallback).toBe("none");
  });

  it("does not read the legacy POSTGRES__MEMORY_SCHEMA variable", () => {
    vi.stubEnv("POSTGRES__MEMORY_SCHEMA", "custom_memory");

    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            store: {
              driver: "postgres",
              postgres: {
                url: "${MEMORY_DB_URL}",
              },
            },
          },
        },
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.store.postgres?.schema).toBe("agent_memory");
  });

  it("uses an explicit postgres schema", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            store: {
              driver: "postgres",
              postgres: {
                url: "${MEMORY_DB_URL}",
                schema: "custom_memory",
              },
            },
          },
        },
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.store.postgres?.schema).toBe("custom_memory");
  });

  it("merges defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: {
              vector: {
                enabled: false,
                extensionPath: "/opt/sqlite-vec.dylib",
              },
            },
            chunking: { tokens: 500, overlap: 100 },
            query: { maxResults: 4, minScore: 0.2 },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              chunking: { tokens: 320 },
              query: { maxResults: 8 },
              store: {
                vector: {
                  enabled: true,
                },
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.chunking.tokens).toBe(320);
    expect(resolved?.chunking.overlap).toBe(100);
    expect(resolved?.query.maxResults).toBe(8);
    expect(resolved?.query.minScore).toBe(0.2);
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.store.vector.extensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("resolves postgres store config with agent overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            store: {
              driver: "postgres",
              postgres: {
                url: "${MEMORY_DB_URL}",
                schema: "agent_memory",
                poolMax: 10,
                echo: false,
              },
              vector: {
                enabled: true,
              },
              cache: {
                enabled: true,
                maxEntries: 50000,
              },
            },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              store: {
                postgres: {
                  schema: "agent_memory",
                  poolMax: 20,
                },
              },
            },
          },
        ],
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.store.driver).toBe("postgres");
    expect(resolved?.store.postgres).toEqual({
      url: "${MEMORY_DB_URL}",
      schema: "agent_memory",
      poolMax: 20,
      echo: false,
    });
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.cache).toEqual({
      enabled: true,
      maxEntries: 50000,
    });
  });

  it("merges extra memory paths from defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            extraPaths: ["/shared/notes", " docs "],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              extraPaths: ["/shared/notes", "../team-notes"],
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.extraPaths).toEqual(["/shared/notes", "docs", "../team-notes"]);
  });

  it("merges exclude globs from defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            excludeGlobs: ["memory/private/**", " **/*-security-policy.md "],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              excludeGlobs: ["memory/private/**", "memory/tmp/*.md"],
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.excludeGlobs).toEqual([
      "memory/private/**",
      "**/*-security-policy.md",
      "memory/tmp/*.md",
    ]);
  });

  it("loads lexicon paths into resolved terms", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-search-lexicon-"));
    try {
      const lexiconPath = path.join(tempDir, "companies_targets.yaml");
      fs.writeFileSync(
        lexiconPath,
        [
          "companies:",
          "  - name: ORIC Pharmaceuticals",
          "    targets:",
          "      - drug: ORIC-944",
          "        target: EED",
          "        note: 信诺维医药",
        ].join("\n"),
      );
      const cfg = asConfig({
        agents: {
          defaults: {
            memorySearch: {
              lexicon: {
                paths: [lexiconPath],
                terms: ["inline target"],
              },
            },
          },
        },
      });

      const resolved = resolveMemorySearchConfig(cfg, "main");

      expect(resolved?.lexicon.terms).toEqual(
        expect.arrayContaining([
          "inline target",
          "ORIC Pharmaceuticals",
          "ORIC-944",
          "EED",
          "信诺维医药",
        ]),
      );
      expect(resolved?.lexicon).not.toHaveProperty("paths");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads the workspace default lexicon when includeDefaults is not disabled", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-search-defaults-"));
    try {
      fs.mkdirSync(path.join(tempDir, "lexicons"));
      fs.writeFileSync(
        path.join(tempDir, "lexicons", "innovation-drug.yaml"),
        ["terms:", "  - PD-1", "  - 适应症"].join("\n"),
      );
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));

      const withDefaults = resolveMemorySearchConfig(asConfig({}), "main");
      expect(withDefaults?.lexicon.terms).toEqual(expect.arrayContaining(["PD-1", "适应症"]));

      const withoutDefaults = resolveMemorySearchConfig(
        asConfig({
          agents: {
            defaults: { memorySearch: { lexicon: { includeDefaults: false } } },
          },
        }),
        "main",
      );
      expect(withoutDefaults?.lexicon.terms).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads the agent workspace default lexicon", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-memory-search-workspace-defaults-"),
    );
    try {
      const configDir = path.join(tempDir, "config");
      const workspaceDir = path.join(tempDir, "workspace-main");
      fs.mkdirSync(path.join(workspaceDir, "lexicons"), { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "lexicons", "innovation-drug.yaml"),
        ["terms:", "  - PD-1/VEGF", "  - AK112"].join("\n"),
      );
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(configDir, "openclaw.json"));

      const resolved = resolveMemorySearchConfig(
        asConfig({
          agents: {
            list: [
              {
                id: "main",
                default: true,
                workspace: workspaceDir,
              },
            ],
          },
        }),
        "main",
      );

      expect(resolved?.lexicon.terms).toEqual(expect.arrayContaining(["PD-1/VEGF", "AK112"]));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to the shared default workspace lexicon", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-memory-search-shared-workspace-defaults-"),
    );
    try {
      const configDir = path.join(tempDir, "config");
      const sharedWorkspaceDir = path.join(tempDir, "workspace-shared");
      const agentWorkspaceDir = path.join(tempDir, "workspace-agent");
      fs.mkdirSync(path.join(sharedWorkspaceDir, "lexicons"), { recursive: true });
      fs.mkdirSync(agentWorkspaceDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedWorkspaceDir, "lexicons", "innovation-drug.yaml"),
        ["terms:", "  - Synnovation Therapeutics", "  - SNV4818"].join("\n"),
      );
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(configDir, "openclaw.json"));

      const resolved = resolveMemorySearchConfig(
        asConfig({
          agents: {
            defaults: {
              workspace: sharedWorkspaceDir,
            },
            list: [
              {
                id: "feishu-ou_target",
                workspace: agentWorkspaceDir,
              },
            ],
          },
        }),
        "feishu-ou_target",
      );

      expect(resolved?.lexicon.terms).toEqual(
        expect.arrayContaining(["Synnovation Therapeutics", "SNV4818"]),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes batch defaults for openai without remote overrides", () => {
    const cfg = configWithDefaultProvider("openai");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("keeps remote unset for local provider without overrides", () => {
    const cfg = configWithDefaultProvider("local");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toBeUndefined();
  });

  it("includes remote defaults for gemini without overrides", () => {
    const cfg = configWithDefaultProvider("gemini");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("includes remote defaults and model default for mistral without overrides", () => {
    const cfg = configWithDefaultProvider("mistral");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("mistral-embed");
  });

  it("defaults session delta thresholds", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sync.sessions).toEqual({
      deltaBytes: 100000,
      deltaMessages: 50,
    });
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote: {
              baseUrl: "https://default.example/v1",
              apiKey: "default-key",
              headers: { "X-Default": "on" },
            },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              remote: {
                baseUrl: "https://agent.example/v1",
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey: "default-key",
      headers: { "X-Default": "on" },
      batch: {
        enabled: false,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    });
  });

  it("gates session sources behind experimental flag", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              experimental: { sessionMemory: false },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when experimental flag is enabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
            experimental: { sessionMemory: true },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });
});
