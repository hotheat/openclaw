import postgres from "postgres";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";

export type PostgresMemoryClient = ReturnType<typeof postgres>;

export type PostgresMemoryStoreConfig = NonNullable<
  NonNullable<ResolvedMemorySearchConfig["store"]["postgres"]>
>;

export function requirePostgresStoreConfig(
  config: ResolvedMemorySearchConfig,
): PostgresMemoryStoreConfig {
  if (config.store.driver !== "postgres" || !config.store.postgres) {
    throw new Error("PostgreSQL memory store is not configured.");
  }
  const { url, schema, poolMax, echo } = config.store.postgres;
  if (!url.trim()) {
    throw new Error(
      "PostgreSQL memory store URL is required. Set MEMORY_DB_URL and reference it from store.postgres.url.",
    );
  }
  if (!schema.trim()) {
    throw new Error("PostgreSQL memory store schema is required.");
  }
  return { url, schema, poolMax, echo };
}

export function createPostgresMemoryClient(
  config: PostgresMemoryStoreConfig,
): PostgresMemoryClient {
  type ConnectionOptions = {
    max: number;
    debug: boolean;
    onnotice: (() => void) | undefined;
    prepare: boolean;
  };
  const connectionOptions: ConnectionOptions = {
    max: config.poolMax,
    debug: config.echo,
    onnotice: config.echo ? undefined : () => {},
    prepare: false,
  };
  const createClient = postgres as unknown as (
    url: string,
    options: ConnectionOptions,
  ) => PostgresMemoryClient;
  return createClient(config.url, connectionOptions);
}

export function formatPostgresMemoryLocation(config: PostgresMemoryStoreConfig): string {
  try {
    const parsed = new URL(config.url);
    const port = parsed.port || "5432";
    const database = parsed.pathname.replace(/^\/+/, "") || "(default)";
    return `${parsed.hostname}:${port}/${database}/${config.schema}`;
  } catch {
    return `postgres/${config.schema}`;
  }
}
