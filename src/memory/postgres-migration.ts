import {
  createPostgresMemoryClient,
  type PostgresMemoryClient,
  type PostgresMemoryStoreConfig,
} from "./postgres-client.js";
import {
  migratePostgresMemorySchema,
  POSTGRES_HNSW_MAX_VECTOR_DIMS,
  qualifyTable,
  verifyPostgresMemorySchema,
} from "./postgres-schema.js";

export type PostgresMemoryMigrationResult = {
  schema: string;
  vectorDims: number[];
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function backfillPostgresMemoryVectors(params: {
  sql: PostgresMemoryClient;
  config: PostgresMemoryStoreConfig;
  requireVector: boolean;
}): Promise<number[]> {
  const chunksTable = qualifyTable(params.config.schema, "chunks");
  const metaTable = qualifyTable(params.config.schema, "index_meta");

  if (params.requireVector) {
    await params.sql.unsafe(`
      UPDATE ${chunksTable}
         SET embedding_vec = embedding::vector
       WHERE embedding_vec IS NULL
         AND array_length(embedding, 1) > 0
    `);
  }

  await params.sql.unsafe(`
    UPDATE ${metaTable} AS m
       SET vector_dims = dims.vector_dims,
           updated_at = NOW()
      FROM (
        SELECT agent_id, MIN(array_length(embedding, 1)) AS vector_dims
        FROM ${chunksTable}
        WHERE array_length(embedding, 1) IS NOT NULL
        GROUP BY agent_id
        HAVING MIN(array_length(embedding, 1)) = MAX(array_length(embedding, 1))
      ) AS dims
     WHERE m.agent_id = dims.agent_id
       AND (m.vector_dims IS NULL OR m.vector_dims <> dims.vector_dims)
  `);

  const rows = await params.sql<Array<{ vector_dims: number }>>`
    SELECT DISTINCT vector_dims
    FROM ${params.sql.unsafe(metaTable)}
    WHERE vector_dims IS NOT NULL
    ORDER BY vector_dims
  `;
  return rows
    .map((row) => Number(row.vector_dims))
    .filter((dims) => Number.isInteger(dims) && dims > 0);
}

async function createPostgresMemoryVectorIndexes(params: {
  sql: PostgresMemoryClient;
  config: PostgresMemoryStoreConfig;
  vectorDims: number[];
}): Promise<void> {
  const chunksTable = qualifyTable(params.config.schema, "chunks");
  for (const dims of params.vectorDims) {
    if (dims > POSTGRES_HNSW_MAX_VECTOR_DIMS) {
      continue;
    }
    const indexName = quoteIdentifier(`chunks_embedding_vec_${dims}_hnsw_idx`);
    await params.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${chunksTable}
        USING hnsw ((embedding_vec::vector(${dims})) vector_cosine_ops)
        WHERE embedding_vec IS NOT NULL AND vector_dims(embedding_vec) = ${dims}
    `);
  }
}

export async function runPostgresMemoryMigration(params: {
  url: string;
  schema: string;
  requireVector?: boolean;
  expectedVectorDims?: number;
  echo?: boolean;
}): Promise<PostgresMemoryMigrationResult> {
  const url = params.url.trim();
  if (!url) {
    throw new Error("OPENCLAW_MEMORY_MIGRATION_URL is required.");
  }
  if (
    params.expectedVectorDims !== undefined &&
    (!Number.isSafeInteger(params.expectedVectorDims) || params.expectedVectorDims <= 0)
  ) {
    throw new Error("expectedVectorDims must be a positive integer.");
  }
  const config: PostgresMemoryStoreConfig = {
    url,
    schema: params.schema.trim() || "agent_memory",
    poolMax: 1,
    echo: params.echo ?? false,
  };
  const requireVector = params.requireVector ?? true;
  const sql = createPostgresMemoryClient(config);
  try {
    await migratePostgresMemorySchema({
      sql,
      config,
      requireVector,
    });
    let vectorDims: number[] = [];
    await sql.begin(async (transactionSql) => {
      const tx = transactionSql as unknown as PostgresMemoryClient;
      vectorDims = await backfillPostgresMemoryVectors({
        sql: tx,
        config,
        requireVector,
      });
      if (requireVector) {
        if (params.expectedVectorDims !== undefined) {
          vectorDims = Array.from(new Set([...vectorDims, params.expectedVectorDims])).toSorted(
            (left, right) => left - right,
          );
        }
        if (vectorDims.length === 0) {
          throw new Error(
            "PostgreSQL memory migration cannot infer vector dimensions from an empty store. Pass --vector-dims <number>.",
          );
        }
        await createPostgresMemoryVectorIndexes({
          sql: tx,
          config,
          vectorDims,
        });
      }
    });
    await verifyPostgresMemorySchema({
      sql,
      config,
      requireVector,
    });
    return {
      schema: config.schema,
      vectorDims,
    };
  } finally {
    await sql.end({ timeout: 0 });
  }
}
