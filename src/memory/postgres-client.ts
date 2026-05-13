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
  const { host, database, user, password, schema, port, ssl, poolMax, echo } =
    config.store.postgres;
  if (!host.trim()) {
    throw new Error("PostgreSQL memory store host is required.");
  }
  if (!database.trim()) {
    throw new Error("PostgreSQL memory store database is required.");
  }
  if (!user.trim()) {
    throw new Error("PostgreSQL memory store user is required.");
  }
  if (!password.trim()) {
    throw new Error("PostgreSQL memory store password is required.");
  }
  if (!schema.trim()) {
    throw new Error("PostgreSQL memory store schema is required.");
  }
  return { host, database, user, password, schema, port, ssl, poolMax, echo };
}

export function createPostgresMemoryClient(
  config: PostgresMemoryStoreConfig,
): PostgresMemoryClient {
  return postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    max: config.poolMax,
    ssl: config.ssl ? "require" : undefined,
    debug: config.echo,
    onnotice: config.echo ? undefined : () => {},
    prepare: false,
  });
}
