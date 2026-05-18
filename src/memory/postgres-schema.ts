import type { PostgresMemoryClient, PostgresMemoryStoreConfig } from "./postgres-client.js";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function qualifyTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

async function tryEnsureExtension(
  sql: PostgresMemoryClient,
  name: "vector" | "pg_trgm",
): Promise<boolean> {
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${name}`);
  } catch {
    // Extension creation can fail when the server does not have the package
    // installed or the current role does not have privileges. The backend can
    // still operate with degraded capabilities, so continue.
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

export async function ensurePostgresMemorySchema(params: {
  sql: PostgresMemoryClient;
  config: PostgresMemoryStoreConfig;
}): Promise<void> {
  const schema = quoteIdentifier(params.config.schema);
  await params.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const vectorAvailable = await tryEnsureExtension(params.sql, "vector");
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, id)
    )
  `);

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

  void vectorAvailable;
}
