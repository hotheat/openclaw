import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

describe("getSubagentDepthFromSessionStore", () => {
  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: 2 },
      },
    });
    expect(depth).toBe(2);
  });

  it("derives depth from spawnedBy ancestry when spawnDepth is missing", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore(key3, {
      store: {
        [key1]: { spawnedBy: "agent:main:main" },
        [key2]: { spawnedBy: key1 },
        [key3]: { spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves depth when caller is identified by sessionId", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const prefixedKey = "agent:main:subagent:flat";
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [prefixedKey]: {
            sessionId: "subagent-flat",
            updatedAt: Date.now(),
            spawnDepth: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(2_147_000_000);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(2_147_000_000);
  });

  it("uses provider timeout before the global agent default", () => {
    const cfg = {
      agents: {
        defaults: {
          timeoutSeconds: 60,
        },
      },
      models: {
        providers: {
          "qwen-openai": {
            baseUrl: "http://127.0.0.1:8000/v1",
            timeoutSeconds: 900,
            models: [],
          },
        },
      },
    };

    expect(resolveAgentTimeoutMs({ cfg, provider: "qwen-openai" })).toBe(900_000);
  });

  it("resolves provider timeout through normalized provider aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          timeoutSeconds: 60,
        },
      },
      models: {
        providers: {
          "qwen-portal": {
            baseUrl: "http://127.0.0.1:8000/v1",
            timeoutSeconds: 900,
            models: [],
          },
        },
      },
    };

    expect(resolveAgentTimeoutMs({ cfg, provider: "qwen" })).toBe(900_000);
  });

  it("keeps explicit timeout overrides above provider defaults", () => {
    const cfg = {
      models: {
        providers: {
          "qwen-openai": {
            baseUrl: "http://127.0.0.1:8000/v1",
            timeoutSeconds: 900,
            models: [],
          },
        },
      },
    };

    expect(resolveAgentTimeoutMs({ cfg, provider: "qwen-openai", overrideSeconds: 30 })).toBe(
      30_000,
    );
  });
});
