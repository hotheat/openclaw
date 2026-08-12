import type { PostgresMemoryClient, PostgresMemoryStoreConfig } from "./postgres-client.js";

export const POSTGRES_HNSW_MAX_VECTOR_DIMS = 2000;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function qualifyTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function normalizePgIndexDef(indexDef: string): string {
  return indexDef
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

export function isCompatiblePostgresMemoryHnswIndex(
  indexDef: string,
  dims: number,
  indexVectorDims?: number | null,
): boolean {
  const normalized = normalizePgIndexDef(indexDef);
  const vectorDimsPattern = new RegExp(
    `vector_dims\\s*\\(\\s*embedding_vec\\s*\\)\\s*=\\s*${dims}\\b`,
  );
  return (
    normalized.includes("using hnsw") &&
    normalized.includes("embedding_vec") &&
    (indexVectorDims === dims || normalized.includes(`vector(${dims})`)) &&
    normalized.includes("vector_cosine_ops") &&
    normalized.includes("embedding_vec is not null") &&
    vectorDimsPattern.test(normalized)
  );
}

async function tryEnsureExtension(
  sql: PostgresMemoryClient,
  name: "vector" | "pg_trgm",
): Promise<boolean> {
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${name}`);
  } catch {
    // Extension creation can fail when the server does not have the package
    // installed or the current role does not have privileges. The caller
    // decides whether that extension is required.
  }

  try {
    const rows = await sql<{ available: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = ${name}
      ) AS available
    `;
    return Boolean(rows[0]?.available);
  } catch {
    return false;
  }
}

export async function migratePostgresMemorySchema(params: {
  sql: PostgresMemoryClient;
  config: PostgresMemoryStoreConfig;
  requireVector?: boolean;
}): Promise<void> {
  const requireVector = params.requireVector ?? true;
  const schema = quoteIdentifier(params.config.schema);
  await params.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  if (requireVector) {
    const vectorAvailable = await tryEnsureExtension(params.sql, "vector");
    if (!vectorAvailable) {
      throw new Error(
        "PostgreSQL memory store requires pgvector. Install pgvector and enable the vector extension for this database.",
      );
    }
  }
  const trigramAvailable = await tryEnsureExtension(params.sql, "pg_trgm");
  const indexMetaTable = qualifyTable(params.config.schema, "index_meta");

  await params.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${indexMetaTable} (
      agent_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      sources JSONB NOT NULL,
      exclude_globs JSONB NOT NULL DEFAULT '[]'::jsonb,
      chunk_tokens INTEGER NOT NULL,
      chunk_overlap INTEGER NOT NULL,
      vector_dims INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await params.sql.unsafe(`
    ALTER TABLE ${indexMetaTable}
      ADD COLUMN IF NOT EXISTS exclude_globs JSONB
  `);
  await params.sql.unsafe(`
    UPDATE ${indexMetaTable}
      SET exclude_globs = '[]'::jsonb
      WHERE exclude_globs IS NULL
  `);
  await params.sql.unsafe(`
    ALTER TABLE ${indexMetaTable}
      ALTER COLUMN exclude_globs SET DEFAULT '[]'::jsonb
  `);
  await params.sql.unsafe(`
    ALTER TABLE ${indexMetaTable}
      ALTER COLUMN exclude_globs SET NOT NULL
  `);

  await params.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${qualifyTable(params.config.schema, "files")} (
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      hash TEXT NOT NULL,
      mtime BIGINT NOT NULL,
      size BIGINT NOT NULL,
      PRIMARY KEY (agent_id, path)
    )
  `);

  await params.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${qualifyTable(params.config.schema, "chunks")} (
      agent_id TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      search_tokens TEXT NOT NULL,
      embedding DOUBLE PRECISION[] NOT NULL,
      ${requireVector ? "embedding_vec VECTOR," : ""}
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, id)
    )
  `);
  if (requireVector) {
    await params.sql.unsafe(`
      ALTER TABLE ${qualifyTable(params.config.schema, "chunks")}
        ADD COLUMN IF NOT EXISTS embedding_vec VECTOR
    `);
  }

  await params.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${qualifyTable(params.config.schema, "embedding_cache")} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding_json JSONB NOT NULL,
      dims INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, model, provider_key, hash)
    )
  `);

  await params.sql.unsafe(`
    CREATE INDEX IF NOT EXISTS files_agent_source_idx
      ON ${qualifyTable(params.config.schema, "files")} (agent_id, source)
  `);
  await params.sql.unsafe(`
    CREATE INDEX IF NOT EXISTS chunks_agent_model_idx
      ON ${qualifyTable(params.config.schema, "chunks")} (agent_id, model)
  `);
  await params.sql.unsafe(`
    CREATE INDEX IF NOT EXISTS chunks_agent_path_idx
      ON ${qualifyTable(params.config.schema, "chunks")} (agent_id, path)
  `);
  if (trigramAvailable) {
    await params.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS chunks_tokens_trgm_idx
        ON ${qualifyTable(params.config.schema, "chunks")}
        USING gin (search_tokens gin_trgm_ops)
    `);
  }
  await params.sql.unsafe(`
    CREATE INDEX IF NOT EXISTS embedding_cache_updated_at_idx
      ON ${qualifyTable(params.config.schema, "embedding_cache")} (updated_at)
  `);
}

type PostgresMemoryColumnRow = {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

type PostgresMemoryIndexRow = {
  indexname: string;
  indexdef: string;
  vector_dims: number | null;
};

export type PostgresMemorySchemaInspection = {
  ok: boolean;
  issues: string[];
  extensions: {
    vector: boolean;
    pgTrgm: boolean;
  };
  vectorDims: number[];
};

const REQUIRED_COLUMNS: Record<
  string,
  Record<string, { type: string; nullable?: boolean; defaultRequired?: boolean }>
> = {
  index_meta: {
    agent_id: { type: "text" },
    provider: { type: "text" },
    model: { type: "text" },
    provider_key: { type: "text" },
    sources: { type: "jsonb" },
    exclude_globs: { type: "jsonb", defaultRequired: true },
    chunk_tokens: { type: "int4" },
    chunk_overlap: { type: "int4" },
    vector_dims: { type: "int4", nullable: true },
    updated_at: { type: "timestamptz", defaultRequired: true },
  },
  files: {
    agent_id: { type: "text" },
    path: { type: "text" },
    source: { type: "text" },
    hash: { type: "text" },
    mtime: { type: "int8" },
    size: { type: "int8" },
  },
  chunks: {
    agent_id: { type: "text" },
    id: { type: "text" },
    path: { type: "text" },
    source: { type: "text" },
    start_line: { type: "int4" },
    end_line: { type: "int4" },
    hash: { type: "text" },
    model: { type: "text" },
    text: { type: "text" },
    search_tokens: { type: "text" },
    embedding: { type: "_float8" },
    updated_at: { type: "timestamptz", defaultRequired: true },
  },
  embedding_cache: {
    provider: { type: "text" },
    model: { type: "text" },
    provider_key: { type: "text" },
    hash: { type: "text" },
    embedding_json: { type: "jsonb" },
    dims: { type: "int4", nullable: true },
    updated_at: { type: "timestamptz", defaultRequired: true },
  },
};

const REQUIRED_INDEXES = [
  "files_agent_source_idx",
  "chunks_agent_model_idx",
  "chunks_agent_path_idx",
  "embedding_cache_updated_at_idx",
] as const;

export async function inspectPostgresMemorySchema(params: {
  sql: PostgresMemoryClient;
  config: PostgresMemoryStoreConfig;
  requireVector?: boolean;
}): Promise<PostgresMemorySchemaInspection> {
  const requireVector = params.requireVector ?? true;
  const issues: string[] = [];
  const extensionRows = await params.sql<Array<{ extname: string }>>`
    SELECT extname
    FROM pg_extension
    WHERE extname IN ('vector', 'pg_trgm')
  `;
  const extensions = new Set(extensionRows.map((row) => row.extname));
  if (requireVector && !extensions.has("vector")) {
    issues.push("required extension vector is missing");
  }

  const columnRows = await params.sql<PostgresMemoryColumnRow[]>`
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ${params.config.schema}
      AND table_name IN ('index_meta', 'files', 'chunks', 'embedding_cache')
  `;
  const columns = new Map<string, PostgresMemoryColumnRow>(
    columnRows.map((row) => [`${row.table_name}.${row.column_name}`, row] as const),
  );

  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const [column, expected] of Object.entries(expectedColumns)) {
      const key = `${table}.${column}`;
      const actual = columns.get(key);
      if (!actual) {
        issues.push(`required column ${key} is missing`);
        continue;
      }
      if (actual.udt_name !== expected.type) {
        issues.push(`column ${key} has type ${actual.udt_name}; expected ${expected.type}`);
      }
      const expectedNullable = expected.nullable ?? false;
      if ((actual.is_nullable === "YES") !== expectedNullable) {
        issues.push(
          `column ${key} nullable=${actual.is_nullable}; expected ${expectedNullable ? "YES" : "NO"}`,
        );
      }
      if (expected.defaultRequired && !actual.column_default) {
        issues.push(`column ${key} is missing its default value`);
      }
    }
  }

  if (requireVector) {
    const embeddingVector = columns.get("chunks.embedding_vec");
    if (!embeddingVector) {
      issues.push("required column chunks.embedding_vec is missing");
    } else if (embeddingVector.udt_name !== "vector") {
      issues.push(
        `column chunks.embedding_vec has type ${embeddingVector.udt_name}; expected vector`,
      );
    }
  }

  const indexRows = await params.sql<PostgresMemoryIndexRow[]>`
    SELECT
      indexes.indexname,
      indexes.indexdef,
      index_column.atttypmod AS vector_dims
    FROM pg_indexes AS indexes
    LEFT JOIN pg_namespace AS index_namespace
      ON index_namespace.nspname = indexes.schemaname
    LEFT JOIN pg_class AS index_relation
      ON index_relation.relnamespace = index_namespace.oid
     AND index_relation.relname = indexes.indexname
    LEFT JOIN pg_attribute AS index_column
      ON index_column.attrelid = index_relation.oid
     AND index_column.attnum = 1
    WHERE indexes.schemaname = ${params.config.schema}
      AND indexes.tablename IN ('files', 'chunks', 'embedding_cache')
  `;
  const indexes = new Map(indexRows.map((row) => [row.indexname, row] as const));
  for (const indexName of REQUIRED_INDEXES) {
    if (!indexes.has(indexName)) {
      issues.push(`required index ${indexName} is missing`);
    }
  }
  if (extensions.has("pg_trgm") && !indexes.has("chunks_tokens_trgm_idx")) {
    issues.push("required index chunks_tokens_trgm_idx is missing");
  }

  let vectorDims: number[] = [];
  if (columns.has("index_meta.vector_dims")) {
    const dimRows = await params.sql<Array<{ vector_dims: number }>>`
      SELECT DISTINCT vector_dims
      FROM ${params.sql.unsafe(qualifyTable(params.config.schema, "index_meta"))}
      WHERE vector_dims IS NOT NULL
      ORDER BY vector_dims
    `;
    vectorDims = dimRows
      .map((row) => Number(row.vector_dims))
      .filter((dims) => Number.isInteger(dims) && dims > 0);
  }
  if (requireVector) {
    for (const dims of vectorDims) {
      if (dims > POSTGRES_HNSW_MAX_VECTOR_DIMS) {
        continue;
      }
      if (
        !Array.from(indexes.values()).some((index) =>
          isCompatiblePostgresMemoryHnswIndex(index.indexdef, dims, index.vector_dims),
        )
      ) {
        issues.push(`compatible HNSW index for ${dims}-dimension vectors is missing`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    extensions: {
      vector: extensions.has("vector"),
      pgTrgm: extensions.has("pg_trgm"),
    },
    vectorDims,
  };
}

export async function verifyPostgresMemorySchema(params: {
  sql: PostgresMemoryClient;
  config: PostgresMemoryStoreConfig;
  requireVector?: boolean;
}): Promise<PostgresMemorySchemaInspection> {
  const inspection = await inspectPostgresMemorySchema(params);
  if (!inspection.ok) {
    throw new Error(
      `PostgreSQL memory schema "${params.config.schema}" is incompatible: ${inspection.issues.join(
        "; ",
      )}. Run: openclaw memory postgres migrate --schema ${params.config.schema}`,
    );
  }
  return inspection;
}
