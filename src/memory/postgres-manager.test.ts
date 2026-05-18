import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

const sqlTag = vi.hoisted(() => {
  type ChunkRow = {
    agent_id: string;
    id: string;
    path: string;
    source: "memory" | "sessions";
    start_line: number;
    end_line: number;
    hash: string;
    model: string;
    text: string;
    search_tokens: string;
    embedding: number[];
  };
  type FileRow = {
    agent_id: string;
    path: string;
    source: "memory" | "sessions";
    hash: string;
    mtime: number;
    size: number;
  };
  type MetaRow = {
    agent_id: string;
    provider: string;
    model: string;
    provider_key: string;
    sources: Array<"memory" | "sessions">;
    chunk_tokens: number;
    chunk_overlap: number;
    vector_dims: number | null;
    exclude_globs: string[];
  };
  type CacheRow = {
    provider: string;
    model: string;
    provider_key: string;
    hash: string;
    embedding_json: number[];
    dims: number;
  };

  const calls: string[] = [];
  const extensions = new Map<string, boolean>([
    ["vector", true],
    ["pg_trgm", true],
  ]);
  const files = new Map<string, FileRow>();
  const chunks = new Map<string, ChunkRow>();
  const meta = new Map<string, MetaRow>();
  const cache = new Map<string, CacheRow>();
  const beginCalls: string[] = [];
  const txCalls: string[] = [];

  function projectMetaRow(query: string, row: MetaRow): Partial<MetaRow> {
    const selectClause = query.match(/SELECT\s+([\s\S]*?)\s+FROM \?/i)?.[1];
    if (!selectClause) {
      return row;
    }
    const selectedColumns = selectClause
      .split(",")
      .map((column) => column.trim())
      .filter((column): column is keyof MetaRow => column in row);
    return Object.fromEntries(selectedColumns.map((column) => [column, row[column]]));
  }

  const tag = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      calls.push(query);
      const firstArg = values[0];
      const firstArgText = typeof firstArg === "string" ? firstArg : "";
      if (query.includes("FROM pg_extension")) {
        if (query.includes("extname = 'vector'")) {
          return Promise.resolve([{ available: extensions.get("vector") ?? false }]);
        }
        if (query.includes("extname = 'pg_trgm'")) {
          return Promise.resolve([{ available: extensions.get("pg_trgm") ?? false }]);
        }
        const extname = values.find(
          (value): value is string => typeof value === "string" && extensions.has(value),
        );
        if (extname) {
          return Promise.resolve([{ available: extensions.get(extname) ?? false }]);
        }
        return Promise.resolve([{ available: true }]);
      }
      if (query.startsWith("\n        INSERT INTO ?\n          (agent_id, id, path, source")) {
        const [
          table,
          agentId,
          id,
          pathname,
          source,
          startLine,
          endLine,
          hash,
          model,
          text,
          searchTokens,
          embedding,
        ] = values;
        void table;
        chunks.set(String(id), {
          agent_id: String(agentId),
          id: String(id),
          path: String(pathname),
          source: source as "memory" | "sessions",
          start_line: Number(startLine),
          end_line: Number(endLine),
          hash: String(hash),
          model: String(model),
          text: String(text),
          search_tokens: String(searchTokens),
          embedding: Array.isArray(embedding) ? embedding.map((value) => Number(value)) : [],
        });
        return Promise.resolve([]);
      }
      if (query.startsWith("\n      INSERT INTO ? (agent_id, path, source, hash, mtime, size)")) {
        const [table, agentId, pathname, source, hash, mtime, size] = values;
        const fileKey = `${String(agentId)}:${String(pathname)}`;
        void table;
        files.set(fileKey, {
          agent_id: String(agentId),
          path: String(pathname),
          source: source as "memory" | "sessions",
          hash: String(hash),
          mtime: Number(mtime),
          size: Number(size),
        });
        return Promise.resolve([]);
      }
      if (
        query.startsWith("\n      INSERT INTO ?\n        (agent_id, provider, model, provider_key")
      ) {
        const [
          table,
          agentId,
          provider,
          model,
          providerKey,
          sources,
          excludeGlobs,
          chunkTokens,
          chunkOverlap,
          vectorDims,
        ] = values;
        void table;
        meta.set(String(agentId), {
          agent_id: String(agentId),
          provider: String(provider),
          model: String(model),
          provider_key: String(providerKey),
          sources: Array.isArray(sources) ? (sources as Array<"memory" | "sessions">) : ["memory"],
          chunk_tokens: Number(chunkTokens),
          chunk_overlap: Number(chunkOverlap),
          vector_dims: vectorDims == null ? null : Number(vectorDims),
          exclude_globs: Array.isArray(excludeGlobs)
            ? excludeGlobs.map((pattern) => String(pattern))
            : [],
        });
        return Promise.resolve([]);
      }
      if (
        query.startsWith(
          "\n        INSERT INTO ?\n          (provider, model, provider_key, hash, embedding_json, dims, updated_at)",
        )
      ) {
        const [table, provider, model, providerKey, hash, embeddingJson, dims] = values;
        const cacheKey = `${String(provider)}:${String(model)}:${String(providerKey)}:${String(hash)}`;
        void table;
        cache.set(cacheKey, {
          provider: String(provider),
          model: String(model),
          provider_key: String(providerKey),
          hash: String(hash),
          embedding_json: Array.isArray(embeddingJson)
            ? embeddingJson.map((value) => Number(value))
            : [],
          dims: Number(dims),
        });
        return Promise.resolve([]);
      }
      if (query.startsWith("DELETE FROM ? WHERE agent_id = ?")) {
        const [table, agentId] = values;
        const tableName = String(table);
        if (tableName.includes("files")) {
          for (const [key, row] of files.entries()) {
            if (row.agent_id === String(agentId)) {
              files.delete(key);
            }
          }
        }
        if (tableName.includes("chunks")) {
          for (const [key, row] of chunks.entries()) {
            if (row.agent_id === String(agentId)) {
              chunks.delete(key);
            }
          }
        }
        return Promise.resolve([]);
      }
      if (query.startsWith("\n      DELETE FROM ?\n      WHERE agent_id = ?")) {
        const [table, agentId, pathname, source] = values;
        const tableName = String(table);
        if (tableName.includes("files")) {
          const fileKey = `${String(agentId)}:${String(pathname)}`;
          files.delete(fileKey);
        }
        if (tableName.includes("chunks")) {
          for (const [key, row] of chunks.entries()) {
            if (
              row.agent_id === String(agentId) &&
              row.path === String(pathname) &&
              row.source === source
            ) {
              chunks.delete(key);
            }
          }
        }
        return Promise.resolve([]);
      }
      if (query.includes("FROM ?") && firstArgText.includes("index_meta")) {
        const [, agentId] = values;
        const row = meta.get(String(agentId));
        return Promise.resolve(row ? [projectMetaRow(query, row)] : []);
      }
      if (query.includes("FROM ?") && firstArgText.includes("embedding_cache")) {
        if (query.includes("COUNT(*)::int AS count")) {
          return Promise.resolve([{ count: cache.size }]);
        }
        const [, provider, model, providerKey, hashes] = values;
        const requested = new Set(
          Array.isArray(hashes) ? hashes.map((value) => String(value)) : [],
        );
        return Promise.resolve(
          Array.from(cache.values()).filter(
            (row) =>
              row.provider === String(provider) &&
              row.model === String(model) &&
              row.provider_key === String(providerKey) &&
              requested.has(row.hash),
          ),
        );
      }
      if (query.includes("FROM ?") && firstArgText.includes("files")) {
        if (query.includes("GROUP BY source")) {
          const agentId = values[1];
          const counts = new Map<string, number>();
          for (const row of files.values()) {
            if (row.agent_id !== String(agentId)) {
              continue;
            }
            counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
          }
          return Promise.resolve(
            Array.from(counts.entries()).map(([source, count]) => ({ source, count })),
          );
        }
        if (query.includes("COUNT(*)::int AS count")) {
          const agentId = values[1];
          return Promise.resolve([
            {
              count: Array.from(files.values()).filter((row) => row.agent_id === String(agentId))
                .length,
            },
          ]);
        }
        if (query.includes("SELECT hash")) {
          const [, agentId, pathname] = values;
          const fileKey = `${String(agentId)}:${String(pathname)}`;
          const row = files.get(fileKey);
          return Promise.resolve(row ? [{ hash: row.hash }] : []);
        }
        if (query.includes("source = 'memory'")) {
          const [, agentId] = values;
          return Promise.resolve(
            Array.from(files.values()).filter(
              (row) => row.agent_id === String(agentId) && row.source === "memory",
            ),
          );
        }
        if (query.includes("source = 'sessions'")) {
          const [, agentId] = values;
          return Promise.resolve(
            Array.from(files.values()).filter(
              (row) => row.agent_id === String(agentId) && row.source === "sessions",
            ),
          );
        }
        return Promise.resolve(Array.from(files.values()));
      }
      if (query.includes("FROM ?") && firstArgText.includes("chunks")) {
        if (query.includes("GROUP BY source")) {
          const agentId = values[1];
          const counts = new Map<string, number>();
          for (const row of chunks.values()) {
            if (row.agent_id !== String(agentId)) {
              continue;
            }
            counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
          }
          return Promise.resolve(
            Array.from(counts.entries()).map(([source, count]) => ({ source, count })),
          );
        }
        if (query.includes("COUNT(*)::int AS count")) {
          const agentId = values[1];
          return Promise.resolve([
            {
              count: Array.from(chunks.values()).filter((row) => row.agent_id === String(agentId))
                .length,
            },
          ]);
        }
        if (query.includes("search_tokens ILIKE ANY")) {
          const [, agentId, sources, likeTerms] = values;
          const sourceSet = new Set(
            Array.isArray(sources) ? sources.map((value) => String(value)) : [],
          );
          const terms = Array.isArray(likeTerms)
            ? likeTerms.map((value) => String(value).replaceAll("%", ""))
            : [];
          return Promise.resolve(
            Array.from(chunks.values()).filter(
              (row) =>
                row.agent_id === String(agentId) &&
                sourceSet.has(row.source) &&
                terms.some((term) => row.search_tokens.includes(term)),
            ),
          );
        }
        if (query.includes("ORDER BY embedding::") && query.includes("<=>")) {
          const [, agentId, sources, model] = values;
          const sourceSet = new Set(
            Array.isArray(sources) ? sources.map((value) => String(value)) : [],
          );
          return Promise.resolve(
            Array.from(chunks.values()).filter(
              (row) =>
                row.agent_id === String(agentId) &&
                sourceSet.has(row.source) &&
                row.model === String(model),
            ),
          );
        }
        if (query.includes("AND model = ?")) {
          const [, agentId, sources, model] = values;
          const sourceSet = new Set(
            Array.isArray(sources) ? sources.map((value) => String(value)) : [],
          );
          return Promise.resolve(
            Array.from(chunks.values()).filter(
              (row) =>
                row.agent_id === String(agentId) &&
                sourceSet.has(row.source) &&
                row.model === String(model),
            ),
          );
        }
        return Promise.resolve(Array.from(chunks.values()));
      }
      return Promise.resolve([]);
    },
    {
      unsafe: (value: string) => value,
      array: (value: unknown[]) => value,
      json: (value: unknown) => value,
      begin: vi.fn(async (fn: (tx: typeof tag) => Promise<unknown>) => {
        beginCalls.push("begin");
        const tx = Object.assign(
          (strings: TemplateStringsArray, ...values: unknown[]) => {
            const query = strings.join("?");
            txCalls.push(query);
            return tag(strings, ...values);
          },
          {
            unsafe: tag.unsafe,
            array: tag.array,
            json: tag.json,
          },
        );
        return fn(tx as typeof tag);
      }),
      end: vi.fn(async () => {}),
      reset() {
        calls.length = 0;
        beginCalls.length = 0;
        txCalls.length = 0;
        extensions.clear();
        extensions.set("vector", true);
        extensions.set("pg_trgm", true);
        files.clear();
        chunks.clear();
        meta.clear();
        cache.clear();
      },
      calls,
      extensions,
      files,
      chunks,
      meta,
      cache,
      beginCalls,
      txCalls,
    },
  );

  return tag;
});

const createPostgresMemoryClient = vi.hoisted(() => vi.fn(() => sqlTag));
const ensurePostgresMemorySchema = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./postgres-client.js", () => {
  return {
    createPostgresMemoryClient,
    requirePostgresStoreConfig: (config: {
      store: { driver: string; postgres?: Record<string, unknown> };
    }) => {
      if (config.store.driver !== "postgres" || !config.store.postgres) {
        throw new Error("PostgreSQL memory store is not configured.");
      }
      return config.store.postgres;
    },
  };
});

vi.mock("./postgres-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./postgres-schema.js")>();
  return {
    ...actual,
    ensurePostgresMemorySchema,
  };
});

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    },
  })),
}));

import { PostgresMemoryManager } from "./postgres-manager.js";

function createConfig(): OpenClawConfig {
  return {
    memory: { backend: "builtin" },
    agents: {
      defaults: {
        workspace: "/tmp/workspace",
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: {
            driver: "postgres",
            postgres: {
              host: "localhost",
              port: 5432,
              database: "agent_server",
              user: "postgres",
              password: "secret",
              schema: "openclaw_memory",
              ssl: false,
              poolMax: 10,
              echo: false,
            },
            vector: { enabled: true },
          },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

async function waitForPendingSync(manager: object): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const pending = (manager as { syncPromise?: Promise<void> | null }).syncPromise;
    if (pending) {
      await pending;
      return;
    }
    await Promise.resolve();
  }
  throw new Error("expected pending sync");
}

describe("PostgresMemoryManager", () => {
  let tmpRoot = "";

  beforeEach(() => {
    vi.useFakeTimers();
    sqlTag.reset();
    watchMock.mockClear();
    createPostgresMemoryClient.mockClear();
    ensurePostgresMemorySchema.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it("creates and initializes the postgres manager", async () => {
    const manager = await PostgresMemoryManager.get({
      cfg: createConfig(),
      agentId: "main",
    });

    expect(manager).toBeTruthy();
    await manager?.initStore?.();

    expect(createPostgresMemoryClient).toHaveBeenCalledTimes(1);
    expect(ensurePostgresMemorySchema).toHaveBeenCalledTimes(1);
    expect(manager?.status().custom).toMatchObject({
      driver: "postgres",
      schema: "openclaw_memory",
    });
    expect(manager?.status().vector?.available).toBe(true);
    await manager?.close?.();
  });

  it("syncs memory files and returns search results", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-memory-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "notes.md"),
      "Alpha deployment notes\nChinese 讨论方案\n",
      "utf-8",
    );

    const cfg = createConfig();
    cfg.agents!.defaults!.workspace = workspaceDir;

    const manager = await PostgresMemoryManager.get({
      cfg,
      agentId: "main",
    });
    expect(manager).toBeTruthy();
    await manager?.initStore?.();
    await manager?.sync?.({ force: true });

    const status = manager?.status();
    expect(sqlTag.files.size).toBe(1);
    expect(sqlTag.chunks.size).toBeGreaterThan(0);
    expect(
      sqlTag.calls.filter((query) => query.includes("SELECT COUNT(*)::int AS count")).length,
    ).toBeGreaterThan(0);
    expect(status?.files).toBe(1);
    expect(status?.chunks).toBeGreaterThan(0);
    expect(status?.sourceCounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "memory", files: 1 })]),
    );

    const results = await manager?.search("Alpha");
    expect(results?.length).toBeGreaterThan(0);
    expect(results?.[0]?.path).toBe("memory/notes.md");

    const file = await manager?.readFile({ relPath: "memory/notes.md" });
    expect(file?.text).toContain("Alpha deployment notes");
    await manager?.close?.();
  });

  it("uses pgvector sql retrieval when vector extension is available", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-memory-vector-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "notes.md"),
      "Alpha deployment notes\nBeta integration follow-up\n",
      "utf-8",
    );

    const cfg = createConfig();
    cfg.agents!.defaults!.workspace = workspaceDir;
    sqlTag.extensions.set("vector", true);

    const manager = await PostgresMemoryManager.get({
      cfg,
      agentId: "main",
    });
    await manager?.initStore?.();
    await manager?.sync?.({ force: true });

    sqlTag.calls.length = 0;
    await manager?.search("Alpha", { maxResults: 3 });

    expect(
      sqlTag.calls.some((query) => query.includes("ORDER BY embedding::") && query.includes("<=>")),
    ).toBe(true);

    await manager?.close?.();
  });

  it("degrades keyword search when pg_trgm is unavailable", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-memory-fts-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "notes.md"),
      "Alpha deployment notes\nChinese 讨论方案\n",
      "utf-8",
    );

    const cfg = createConfig();
    cfg.agents!.defaults!.workspace = workspaceDir;
    sqlTag.extensions.set("pg_trgm", false);

    const manager = await PostgresMemoryManager.get({
      cfg,
      agentId: "main",
    });
    await manager?.initStore?.();
    await manager?.sync?.({ force: true });

    expect(manager?.status().fts).toMatchObject({
      enabled: true,
      available: false,
    });

    sqlTag.calls.length = 0;
    const results = await manager?.search("Alpha", { maxResults: 3 });

    expect(results?.length).toBeGreaterThan(0);
    expect(sqlTag.calls.some((query) => query.includes("similarity(search_tokens"))).toBe(false);

    await manager?.close?.();
  });

  it("syncs inside a transaction and acquires a postgres advisory lock", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-memory-lock-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "notes.md"), "Alpha deployment notes\n", "utf-8");

    const cfg = createConfig();
    cfg.agents!.defaults!.workspace = workspaceDir;

    const manager = await PostgresMemoryManager.get({
      cfg,
      agentId: "main",
    });
    await manager?.initStore?.();

    sqlTag.beginCalls.length = 0;
    sqlTag.txCalls.length = 0;
    await manager?.sync?.({ force: true });

    expect(sqlTag.beginCalls.length).toBeGreaterThan(0);
    expect(sqlTag.txCalls.some((query) => query.includes("pg_advisory_"))).toBe(true);

    await manager?.close?.();
  });

  it("rebuilds postgres index when excludeGlobs change and drops excluded files", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-memory-exclude-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "keep.md"), "Alpha keep note\n", "utf-8");
    await fs.writeFile(
      path.join(memoryDir, "agent-security-policy.md"),
      "Alpha should be excluded\n",
      "utf-8",
    );

    const initialCfg = createConfig();
    initialCfg.agents!.defaults!.workspace = workspaceDir;
    const initialManager = await PostgresMemoryManager.get({
      cfg: initialCfg,
      agentId: "main",
    });
    expect(initialManager).toBeTruthy();
    await initialManager?.initStore?.();
    await initialManager?.sync?.({ reason: "test" });
    expect(initialManager?.status().files).toBe(2);
    await initialManager?.close?.();

    const excludedCfg = createConfig();
    excludedCfg.agents!.defaults!.workspace = workspaceDir;
    excludedCfg.agents!.defaults!.memorySearch = {
      ...excludedCfg.agents!.defaults!.memorySearch!,
      excludeGlobs: ["**/*-security-policy.md"],
    };
    const updatedManager = await PostgresMemoryManager.get({
      cfg: excludedCfg,
      agentId: "main",
    });
    expect(updatedManager).toBeTruthy();
    await updatedManager?.initStore?.();
    await updatedManager?.sync?.({ reason: "test" });

    expect(updatedManager?.status().files).toBe(1);
    expect(
      Array.from(sqlTag.files.values()).some((row) => row.path.endsWith("security-policy.md")),
    ).toBe(false);

    sqlTag.txCalls.length = 0;
    await updatedManager?.sync?.({ reason: "test" });

    expect(
      sqlTag.txCalls.some((query) => query.startsWith("DELETE FROM ? WHERE agent_id = ?")),
    ).toBe(false);
    await updatedManager?.close?.();
  });

  it("does not reuse a status-only postgres manager for later default calls", async () => {
    const cfg = createConfig();
    cfg.agents!.defaults!.memorySearch = {
      ...cfg.agents!.defaults!.memorySearch!,
      experimental: { sessionMemory: true },
      sync: {
        watch: true,
        watchDebounceMs: 25,
        onSessionStart: false,
        onSearch: false,
      },
    };

    const statusManager = await PostgresMemoryManager.get({
      cfg,
      agentId: "main",
      purpose: "status",
    });
    expect(statusManager).toBeTruthy();

    const defaultManager = await PostgresMemoryManager.get({
      cfg,
      agentId: "main",
    });
    expect(defaultManager).toBeTruthy();
    expect(defaultManager).not.toBe(statusManager);
    expect(watchMock).toHaveBeenCalledTimes(1);

    await statusManager?.close?.();
    await defaultManager?.close?.();
  });

  it("starts postgres background sync lifecycle in default mode", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-memory-lifecycle-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "notes.md"), "Alpha deployment notes\n", "utf-8");

    const stateDir = path.join(tmpRoot, "state");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "thread.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "hello world" }] },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const cfg = createConfig();
    cfg.agents!.defaults!.workspace = workspaceDir;
    cfg.agents!.defaults!.memorySearch = {
      ...cfg.agents!.defaults!.memorySearch!,
      experimental: { sessionMemory: true },
      sync: {
        watch: true,
        watchDebounceMs: 25,
        onSessionStart: true,
        onSearch: false,
        intervalMinutes: 1,
        sessions: { deltaBytes: 1, deltaMessages: 1 },
      },
      query: { minScore: 0, hybrid: { enabled: false } },
      sources: ["memory", "sessions"],
    };

    try {
      const manager = await PostgresMemoryManager.get({
        cfg,
        agentId: "main",
      });
      expect(manager).toBeTruthy();
      if (!manager) {
        throw new Error("manager missing");
      }
      await manager.initStore?.();

      expect(watchMock).toHaveBeenCalledTimes(1);
      const watcher = watchMock.mock.results[0]?.value as
        | { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
        | undefined;
      expect(watcher).toBeTruthy();

      const searchPromise = manager.search("Alpha", { sessionKey: "agent:main:slack:dm:u123" });
      await vi.advanceTimersByTimeAsync(0);
      await searchPromise;
      await waitForPendingSync(manager);
      expect(sqlTag.beginCalls.length).toBeGreaterThan(0);

      sqlTag.beginCalls.length = 0;
      const watchChange = watcher?.on.mock.calls.find((call) => call[0] === "change")?.[1] as
        | (() => void)
        | undefined;
      expect(watchChange).toBeTypeOf("function");
      watchChange?.();
      await vi.advanceTimersByTimeAsync(25);
      await waitForPendingSync(manager);
      expect(sqlTag.beginCalls.length).toBeGreaterThan(0);

      await fs.appendFile(
        sessionFile,
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "follow up" }] },
        }) + "\n",
        "utf-8",
      );
      const sessionListener = (manager as unknown as { sessionUnsubscribe?: (() => void) | null })
        .sessionUnsubscribe;
      expect(sessionListener).toBeTypeOf("function");

      emitSessionTranscriptUpdate(sessionFile);
      sqlTag.beginCalls.length = 0;
      expect(
        (manager as unknown as { intervalTimer?: NodeJS.Timeout | null }).intervalTimer,
      ).toBeTruthy();

      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});
