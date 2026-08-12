import { describe, expect, it } from "vitest";
import {
  inspectPostgresMemorySchema,
  isCompatiblePostgresMemoryHnswIndex,
  migratePostgresMemorySchema,
  verifyPostgresMemorySchema,
} from "./postgres-schema.js";

function createFakeSql(params?: {
  failCreateVector?: boolean;
  failCreateTrgm?: boolean;
  installedExtensions?: string[];
}) {
  const queries: string[] = [];
  const installed = new Set(params?.installedExtensions ?? []);

  const sql = Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("CREATE EXTENSION IF NOT EXISTS vector")) {
        if (params?.failCreateVector) {
          throw new Error("permission denied to create extension vector");
        }
        installed.add("vector");
        return Promise.resolve([]);
      }
      if (query.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm")) {
        if (params?.failCreateTrgm) {
          throw new Error("permission denied to create extension pg_trgm");
        }
        installed.add("pg_trgm");
        return Promise.resolve([]);
      }
      if (query.includes("FROM pg_extension")) {
        const extname = _values.find((value) => value === "vector" || value === "pg_trgm");
        if (extname) {
          return Promise.resolve([{ available: installed.has(extname) }]);
        }
        if (query.includes("extname = 'vector'")) {
          return Promise.resolve([{ available: installed.has("vector") }]);
        }
        if (query.includes("extname = 'pg_trgm'")) {
          return Promise.resolve([{ available: installed.has("pg_trgm") }]);
        }
      }
      return Promise.resolve([]);
    },
    {
      unsafe: (query: string) => {
        queries.push(query);
        if (query.includes("CREATE EXTENSION IF NOT EXISTS vector")) {
          if (params?.failCreateVector) {
            throw new Error("permission denied to create extension vector");
          }
          installed.add("vector");
          return Promise.resolve([]);
        }
        if (query.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm")) {
          if (params?.failCreateTrgm) {
            throw new Error("permission denied to create extension pg_trgm");
          }
          installed.add("pg_trgm");
          return Promise.resolve([]);
        }
        if (query.includes("gin_trgm_ops") && !installed.has("pg_trgm")) {
          throw new Error("operator class gin_trgm_ops does not exist");
        }
        return Promise.resolve([]);
      },
      queries,
    },
  );

  return sql;
}

describe("migratePostgresMemorySchema", () => {
  const config = {
    url: "postgresql://postgres:secret@localhost:5432/agent_server",
    schema: "agent_memory",
    poolMax: 10,
    echo: false,
  } as const;

  it("creates optional extension-backed indexes when extensions are available", async () => {
    const sql = createFakeSql();

    await expect(
      migratePostgresMemorySchema({
        sql: sql as unknown as Parameters<typeof migratePostgresMemorySchema>[0]["sql"],
        config,
      }),
    ).resolves.toBeUndefined();

    expect(
      sql.queries.some((query) => query.includes("CREATE EXTENSION IF NOT EXISTS vector")),
    ).toBe(true);
    expect(
      sql.queries.some((query) => query.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm")),
    ).toBe(true);
    expect(sql.queries.some((query) => query.includes("gin_trgm_ops"))).toBe(true);
    expect(sql.queries.some((query) => query.includes("embedding_vec VECTOR"))).toBe(true);
    expect(sql.queries.some((query) => query.includes("embedding_vec VECTOR(1024)"))).toBe(false);
    expect(sql.queries.some((query) => query.includes("USING hnsw"))).toBe(false);
    expect(sql.queries.some((query) => query.includes("exclude_globs JSONB"))).toBe(true);
    expect(
      sql.queries.some(
        (query) =>
          query.includes("ALTER TABLE") && query.includes("ADD COLUMN IF NOT EXISTS exclude_globs"),
      ),
    ).toBe(true);
  });

  it("fails fast when pgvector cannot be created", async () => {
    const sql = createFakeSql({
      failCreateVector: true,
      failCreateTrgm: true,
    });

    await expect(
      migratePostgresMemorySchema({
        sql: sql as unknown as Parameters<typeof migratePostgresMemorySchema>[0]["sql"],
        config,
      }),
    ).rejects.toThrow("PostgreSQL memory store requires pgvector");

    expect(
      sql.queries.some((query) =>
        query.includes('CREATE TABLE IF NOT EXISTS "agent_memory"."chunks"'),
      ),
    ).toBe(false);
    expect(sql.queries.some((query) => query.includes("USING hnsw"))).toBe(false);
    expect(sql.queries.some((query) => query.includes("gin_trgm_ops"))).toBe(false);
  });

  it("keeps keyword-only schema working when pgvector is disabled", async () => {
    const sql = createFakeSql({
      failCreateVector: true,
      failCreateTrgm: true,
    });

    await expect(
      migratePostgresMemorySchema({
        sql: sql as unknown as Parameters<typeof migratePostgresMemorySchema>[0]["sql"],
        config,
        requireVector: false,
      }),
    ).resolves.toBeUndefined();

    expect(
      sql.queries.some((query) => query.includes("CREATE EXTENSION IF NOT EXISTS vector")),
    ).toBe(false);
    expect(sql.queries.some((query) => query.includes("embedding_vec VECTOR"))).toBe(false);
    expect(
      sql.queries.some((query) =>
        query.includes('CREATE TABLE IF NOT EXISTS "agent_memory"."chunks"'),
      ),
    ).toBe(true);
    expect(sql.queries.some((query) => query.includes("USING hnsw"))).toBe(false);
  });
});

describe("inspectPostgresMemorySchema", () => {
  const config = {
    url: "postgresql://runtime:secret@localhost:5432/agent_server",
    schema: "agent_memory",
    poolMax: 10,
    echo: false,
  } as const;

  function createInspectionSql() {
    const queries: string[] = [];
    const sql = Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        queries.push(query);
        if (query.includes("FROM pg_extension")) {
          return Promise.resolve([{ extname: "vector" }, { extname: "pg_trgm" }]);
        }
        return Promise.resolve([]);
      },
      {
        unsafe: (query: string) => query,
        queries,
      },
    );
    return sql;
  }

  it("reports missing objects using read-only catalog queries", async () => {
    const sql = createInspectionSql();

    const result = await inspectPostgresMemorySchema({
      sql: sql as unknown as Parameters<typeof inspectPostgresMemorySchema>[0]["sql"],
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("required column index_meta.agent_id is missing");
    expect(result.issues).toContain("required index chunks_agent_model_idx is missing");
    expect(
      sql.queries.some((query) =>
        /\b(CREATE|ALTER|DROP|TRUNCATE|UPDATE|INSERT|DELETE)\b/i.test(query),
      ),
    ).toBe(false);
  });

  it("returns an explicit migration command when verification fails", async () => {
    const sql = createInspectionSql();

    await expect(
      verifyPostgresMemorySchema({
        sql: sql as unknown as Parameters<typeof verifyPostgresMemorySchema>[0]["sql"],
        config,
      }),
    ).rejects.toThrow("openclaw memory postgres migrate --schema agent_memory");
  });

  it("uses the index column typmod when PostgreSQL omits the vector cast", () => {
    const indexDef =
      "CREATE INDEX chunks_embedding_vec_1024_hnsw_idx ON agent_memory.chunks " +
      "USING hnsw (embedding_vec vector_cosine_ops) " +
      "WHERE ((embedding_vec IS NOT NULL) AND (vector_dims(embedding_vec) = 1024))";

    expect(isCompatiblePostgresMemoryHnswIndex(indexDef, 1024, 1024)).toBe(true);
    expect(isCompatiblePostgresMemoryHnswIndex(indexDef, 1536, 1024)).toBe(false);
  });
});
