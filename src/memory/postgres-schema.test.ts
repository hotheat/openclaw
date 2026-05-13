import { describe, expect, it } from "vitest";
import { ensurePostgresMemorySchema } from "./postgres-schema.js";

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

describe("ensurePostgresMemorySchema", () => {
  const config = {
    host: "localhost",
    port: 5432,
    database: "agent_server",
    user: "postgres",
    password: "secret",
    schema: "openclaw_memory",
    ssl: false,
    poolMax: 10,
    echo: false,
  } as const;

  it("creates optional extension-backed indexes when extensions are available", async () => {
    const sql = createFakeSql();

    await expect(
      ensurePostgresMemorySchema({
        sql: sql as unknown as Parameters<typeof ensurePostgresMemorySchema>[0]["sql"],
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
  });

  it("continues when optional extensions cannot be created", async () => {
    const sql = createFakeSql({
      failCreateVector: true,
      failCreateTrgm: true,
    });

    await expect(
      ensurePostgresMemorySchema({
        sql: sql as unknown as Parameters<typeof ensurePostgresMemorySchema>[0]["sql"],
        config,
      }),
    ).resolves.toBeUndefined();

    expect(
      sql.queries.some((query) =>
        query.includes('CREATE TABLE IF NOT EXISTS "openclaw_memory"."chunks"'),
      ),
    ).toBe(true);
    expect(sql.queries.some((query) => query.includes("gin_trgm_ops"))).toBe(false);
  });
});
