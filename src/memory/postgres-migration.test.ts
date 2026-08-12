import { beforeEach, describe, expect, it, vi } from "vitest";

const migratePostgresMemorySchema = vi.hoisted(() => vi.fn(async () => {}));
const verifyPostgresMemorySchema = vi.hoisted(() => vi.fn(async () => {}));
const queries = vi.hoisted(() => [] as string[]);
const sqlEnd = vi.hoisted(() => vi.fn(async () => {}));
const storedVectorDims = vi.hoisted(() => ({ value: [3] as number[] }));

const sql = vi.hoisted(() => {
  const tag = Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT DISTINCT vector_dims")) {
        return Promise.resolve(storedVectorDims.value.map((vector_dims) => ({ vector_dims })));
      }
      return Promise.resolve([]);
    },
    {
      unsafe: (query: string) => {
        queries.push(query);
        return Promise.resolve([]);
      },
      begin: async (run: (transactionSql: unknown) => Promise<void>) => {
        await run(tag);
      },
      end: sqlEnd,
    },
  );
  return tag;
});

const createPostgresMemoryClient = vi.hoisted(() => vi.fn(() => sql));

vi.mock("./postgres-client.js", () => ({
  createPostgresMemoryClient,
}));

vi.mock("./postgres-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./postgres-schema.js")>();
  return {
    ...actual,
    migratePostgresMemorySchema,
    verifyPostgresMemorySchema,
  };
});

import { runPostgresMemoryMigration } from "./postgres-migration.js";

describe("runPostgresMemoryMigration", () => {
  beforeEach(() => {
    queries.length = 0;
    sqlEnd.mockClear();
    createPostgresMemoryClient.mockClear();
    migratePostgresMemorySchema.mockClear();
    verifyPostgresMemorySchema.mockClear();
    storedVectorDims.value = [3];
  });

  it("requires an explicit migration URL", async () => {
    await expect(
      runPostgresMemoryMigration({
        url: "",
        schema: "agent_memory",
      }),
    ).rejects.toThrow("OPENCLAW_MEMORY_MIGRATION_URL is required");
    expect(createPostgresMemoryClient).not.toHaveBeenCalled();
  });

  it("runs DDL, vector backfills, HNSW creation, and final verification", async () => {
    const result = await runPostgresMemoryMigration({
      url: "postgresql://admin:secret@localhost:5432/agent",
      schema: "agent_memory",
    });

    expect(createPostgresMemoryClient).toHaveBeenCalledWith({
      url: "postgresql://admin:secret@localhost:5432/agent",
      schema: "agent_memory",
      poolMax: 1,
      echo: false,
    });
    expect(migratePostgresMemorySchema).toHaveBeenCalledTimes(1);
    expect(queries.some((query) => query.includes("SET embedding_vec = embedding::vector"))).toBe(
      true,
    );
    expect(queries.some((query) => query.includes("SET vector_dims = dims.vector_dims"))).toBe(
      true,
    );
    expect(
      queries.some(
        (query) =>
          query.includes("CREATE INDEX IF NOT EXISTS") &&
          query.includes("chunks_embedding_vec_3_hnsw_idx"),
      ),
    ).toBe(true);
    expect(verifyPostgresMemorySchema).toHaveBeenCalledTimes(1);
    expect(sqlEnd).toHaveBeenCalled();
    expect(result).toEqual({
      schema: "agent_memory",
      vectorDims: [3],
    });
  });

  it("requires expected vector dimensions when migrating an empty vector store", async () => {
    storedVectorDims.value = [];

    await expect(
      runPostgresMemoryMigration({
        url: "postgresql://admin:secret@localhost:5432/agent",
        schema: "agent_memory",
      }),
    ).rejects.toThrow("--vector-dims");
    expect(verifyPostgresMemorySchema).not.toHaveBeenCalled();
    expect(sqlEnd).toHaveBeenCalled();
  });

  it("creates the initial HNSW index from expected vector dimensions", async () => {
    storedVectorDims.value = [];

    const result = await runPostgresMemoryMigration({
      url: "postgresql://admin:secret@localhost:5432/agent",
      schema: "agent_memory",
      expectedVectorDims: 1024,
    });

    expect(
      queries.some(
        (query) =>
          query.includes("CREATE INDEX IF NOT EXISTS") &&
          query.includes("chunks_embedding_vec_1024_hnsw_idx"),
      ),
    ).toBe(true);
    expect(result.vectorDims).toEqual([1024]);
  });
});
