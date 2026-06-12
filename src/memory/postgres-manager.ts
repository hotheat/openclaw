import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { isFileMissingError } from "./fs-utils.js";
import { mergeHybridResults } from "./hybrid.js";
import {
  buildFileEntry,
  chunkMarkdown,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  matchesMemoryExcludeGlob,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  remapChunkLines,
} from "./internal.js";
import { cosineSimilarity, runWithConcurrency } from "./internal.js";
import {
  createPostgresMemoryClient,
  requirePostgresStoreConfig,
  type PostgresMemoryClient,
  type PostgresMemoryStoreConfig,
} from "./postgres-client.js";
import { ensurePostgresMemorySchema, qualifyTable } from "./postgres-schema.js";
import {
  buildKeywordQueryTokens,
  buildSearchTokens,
  serializeSearchTokens,
} from "./search-lexemes.js";
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryRepairProgressUpdate,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
  MemoryVectorMigrationProgressUpdate,
  MemoryVectorMigrationResult,
} from "./types.js";

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey: string;
  sources: MemorySource[];
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
  excludeGlobs?: string[];
};

type SqlExecutor = PostgresMemoryClient;

const log = createSubsystemLogger("memory");
const INDEX_CACHE = new Map<string, PostgresMemoryManager>();
const SNIPPET_MAX_CHARS = 700;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_MIGRATION_BATCH_SIZE = 64;
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const POSTGRES_HNSW_MAX_VECTOR_DIMS = 2000;
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

function serializePgvector(values: number[]): string {
  return `[${values.map((value) => Number(value)).join(",")}]`;
}

function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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

function isCompatibleHnswIndexDefinition(indexDef: string, dims: number): boolean {
  const normalized = normalizePgIndexDef(indexDef);
  const vectorDimsPattern = new RegExp(
    `vector_dims\\s*\\(\\s*embedding_vec\\s*\\)\\s*=\\s*${dims}\\b`,
  );
  return (
    normalized.includes("using hnsw") &&
    normalized.includes("embedding_vec") &&
    normalized.includes(`vector(${dims})`) &&
    normalized.includes("vector_cosine_ops") &&
    normalized.includes("embedding_vec is not null") &&
    vectorDimsPattern.test(normalized)
  );
}

function truncateSnippet(text: string, maxChars = SNIPPET_MAX_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized.split(path.sep).map((segment) => segment.trim().toLowerCase());
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

function shouldIgnoreMemoryWatchPathWithConfig(
  workspaceDir: string,
  watchPath: string,
  excludeGlobs?: string[],
): boolean {
  if (shouldIgnoreMemoryWatchPath(watchPath)) {
    return true;
  }
  if (!excludeGlobs?.length) {
    return false;
  }
  const absPath = path.resolve(watchPath);
  const relPath = path.relative(workspaceDir, absPath).replaceAll(path.sep, "/");
  const inWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
  return inWorkspace && matchesMemoryExcludeGlob(relPath, excludeGlobs);
}

function toMemorySource(source: string): MemorySource {
  return source === "sessions" ? "sessions" : "memory";
}

function ensureProgressReporter(progress?: (update: MemorySyncProgressUpdate) => void): {
  tick: (label?: string) => void;
  setTotal: (total: number, label?: string) => void;
} {
  let completed = 0;
  let total = 0;
  return {
    tick(label) {
      completed += 1;
      progress?.({ completed, total, label });
    },
    setTotal(nextTotal, label) {
      total = nextTotal;
      progress?.({ completed, total, label });
    },
  };
}

export class PostgresMemoryManager implements MemorySearchManager {
  private readonly cacheKey: string;
  private readonly cacheable: boolean;
  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly store: PostgresMemoryStoreConfig;
  private readonly sql: PostgresMemoryClient;
  private activeSql: SqlExecutor;
  private readonly purpose?: "default" | "status";
  private readonly requestedProvider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "auto";
  private provider: EmbeddingProvider | null;
  private fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral";
  private fallbackReason?: string;
  private readonly providerUnavailableReason?: string;
  private readonly sources: Set<MemorySource>;
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private readonly vector: {
    enabled: boolean;
    available: boolean;
    indexAvailable: boolean;
    dims?: number;
  };
  private readonly fts: { enabled: boolean; available: boolean; error?: string };
  private providerKey: string;
  private syncPromise: Promise<void> | null = null;
  private dirty = true;
  private sessionsDirty = false;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private sessionWatchTimer: NodeJS.Timeout | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private sessionsDirtyFiles = new Set<string>();
  private sessionPendingFiles = new Set<string>();
  private sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private initialized = false;
  private closed = false;
  private statusSnapshot: {
    files: number;
    chunks: number;
    cacheEntries?: number;
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
  } = {
    files: 0,
    chunks: 0,
    cacheEntries: 0,
    sourceCounts: [],
  };
  private openAi?: OpenAiEmbeddingClient;
  private gemini?: GeminiEmbeddingClient;
  private voyage?: VoyageEmbeddingClient;
  private mistral?: MistralEmbeddingClient;

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<PostgresMemoryManager | null> {
    const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
    if (!settings || settings.store.driver !== "postgres") {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const store = requirePostgresStoreConfig(settings);
    const key = `${params.agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
    const cacheable = params.purpose !== "status";
    if (cacheable) {
      const existing = INDEX_CACHE.get(key);
      if (existing) {
        return existing;
      }
    }
    const providerResult = await createEmbeddingProvider({
      config: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new PostgresMemoryManager({
      cacheKey: key,
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir,
      settings,
      store,
      providerResult,
      cacheable,
      purpose: params.purpose,
    });
    if (cacheable) {
      INDEX_CACHE.set(key, manager);
    }
    return manager;
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    store: PostgresMemoryStoreConfig;
    providerResult: EmbeddingProviderResult;
    cacheable: boolean;
    purpose?: "default" | "status";
  }) {
    this.cacheKey = params.cacheKey;
    this.cacheable = params.cacheable;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.store = params.store;
    this.sql = createPostgresMemoryClient(params.store);
    this.activeSql = this.sql;
    this.purpose = params.purpose;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.providerUnavailableReason = params.providerResult.providerUnavailableReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.voyage = params.providerResult.voyage;
    this.mistral = params.providerResult.mistral;
    this.sources = new Set(params.settings.sources);
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: false,
      indexAvailable: false,
    };
    this.fts = {
      enabled: params.settings.query.hybrid.enabled,
      available: true,
    };
    this.providerKey = this.computeProviderKey();
    const statusOnly = params.purpose === "status";
    if (!statusOnly) {
      this.ensureWatcher();
      this.ensureSessionListener();
      this.ensureIntervalSync();
    }
    this.dirty = this.sources.has("memory");
  }

  async initStore(params?: {
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const reporter = ensureProgressReporter(params?.progress);
    reporter.setTotal(3, "Preparing PostgreSQL memory store...");
    const meta = await this.initializeStoreState();
    reporter.tick("Schema ready");
    this.vector.dims = meta?.vectorDims;
    reporter.tick("Extensions checked");
    await this.refreshStatusSnapshot();
    reporter.tick("Metadata loaded");
  }

  async repairStore(params?: {
    progress?: (update: MemoryRepairProgressUpdate) => void;
  }): Promise<void> {
    const progress = params?.progress;
    progress?.({ completed: 0, total: 4, label: "Preparing PostgreSQL memory repair..." });
    await ensurePostgresMemorySchema({ sql: this.sql, config: this.store });
    progress?.({ completed: 1, total: 4, label: "Schema ready" });
    this.vector.available = await this.detectVectorAvailability();
    progress?.({ completed: 2, total: 4, label: "Vector capability checked" });
    await this.backfillVectorMetadata();
    progress?.({ completed: 3, total: 4, label: "Backfilled pgvector columns and metadata" });
    await this.refreshStatusSnapshot();
    progress?.({ completed: 4, total: 4, label: "Repair complete" });
  }

  async migrateEmbeddings(params?: {
    progress?: (update: MemoryVectorMigrationProgressUpdate) => void;
  }): Promise<MemoryVectorMigrationResult> {
    await this.ensureReady();
    if (!this.provider) {
      throw new Error("Memory embedding migration requires an embedding provider.");
    }
    if (!this.vector.enabled || !this.vector.available) {
      throw new Error("Memory embedding migration requires pgvector to be enabled and available.");
    }

    log.info("Starting PostgreSQL memory embedding migration", {
      agentId: this.agentId,
      provider: this.provider.id,
      model: this.provider.model,
    });
    const result = await this.migrateExistingChunkEmbeddings({
      progress: params?.progress,
    });
    log.info("Completed PostgreSQL memory embedding migration", {
      agentId: this.agentId,
      migrated: result.migrated,
      skipped: result.skipped,
      dims: result.dims,
    });
    return result;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    void this.warmSession(opts?.sessionKey);
    await this.ensureReady();
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`postgres memory sync failed (search): ${String(err)}`);
      });
    }
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];

    let vectorResults: Array<MemorySearchResult & { id: string }> = [];
    if (this.provider) {
      const queryVec = await this.embedQuery(cleaned);
      if (queryVec.some((value) => value !== 0)) {
        vectorResults = await this.searchVector(queryVec, candidates).catch(() => []);
      }
    }

    if (!hybrid.enabled) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }
    if (vectorResults.length === 0 && keywordResults.length > 0) {
      return keywordResults
        .map((entry) => ({ ...entry, score: entry.textScore }))
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults);
    }

    const merged = await mergeHybridResults({
      vector: vectorResults.map((entry) => ({
        id: entry.id,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        source: entry.source,
        snippet: entry.snippet,
        vectorScore: entry.score,
      })),
      keyword: keywordResults.map((entry) => ({
        id: entry.id,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        source: entry.source,
        snippet: entry.snippet,
        textScore: entry.textScore,
      })),
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
      workspaceDir: this.workspaceDir,
    });

    return merged
      .map((entry) => ({
        ...entry,
        source: toMemorySource(entry.source),
      }))
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
          allowedAdditional = true;
          break;
        }
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    let content = "";
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "", path: relPath };
      }
      throw err;
    }
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    return {
      text: lines.slice(start - 1, start - 1 + count).join("\n"),
      path: relPath,
    };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: this.provider?.id ?? "none",
      model: this.provider?.model,
      requestedProvider: this.requestedProvider,
      files: this.statusSnapshot.files,
      chunks: this.statusSnapshot.chunks,
      dirty: this.dirty || this.sessionsDirty,
      workspaceDir: this.workspaceDir,
      dbPath: `${this.store.host}:${this.store.port}/${this.store.database}/${this.store.schema}`,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts: this.statusSnapshot.sourceCounts,
      cache: {
        enabled: this.cache.enabled,
        entries: this.statusSnapshot.cacheEntries,
        maxEntries: this.cache.maxEntries,
      },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.error,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available,
        indexAvailable: this.vector.indexAvailable,
        dims: this.vector.dims,
      },
      custom: {
        driver: "postgres",
        schema: this.store.schema,
        providerUnavailableReason: this.providerUnavailableReason,
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    await this.ensureReady();
    if (this.closed) {
      return;
    }
    if (this.syncPromise) {
      return this.syncPromise;
    }
    this.syncPromise = this.runSync(params).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.provider) {
      return {
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available.",
      };
    }
    try {
      await this.provider.embedBatch(["ping"]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    await this.ensureReady();
    return this.detectVectorAvailability();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    await this.syncPromise?.catch(() => {});
    await this.sql.end({ timeout: 0 });
    if (this.cacheable && INDEX_CACHE.get(this.cacheKey) === this) {
      INDEX_CACHE.delete(this.cacheKey);
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initStore();
    }
  }

  private async initializeStoreState(): Promise<MemoryIndexMeta | null> {
    await ensurePostgresMemorySchema({
      sql: this.sql,
      config: this.store,
      requireVector: this.vector.enabled,
    });
    this.vector.available = await this.detectVectorAvailability();
    this.fts.available = await this.detectTrigramAvailability();
    await this.backfillVectorMetadata();
    try {
      const meta = await this.readMeta();
      if (meta?.vectorDims) {
        await this.ensureVectorIndexForDims(meta.vectorDims);
      }
      this.dirty = this.sources.has("memory") && (this.purpose === "status" ? !meta : true);
      this.initialized = true;
      return meta;
    } catch (err) {
      this.initialized = true;
      throw err;
    }
  }

  private async backfillVectorMetadata(): Promise<void> {
    const chunksTable = qualifyTable(this.store.schema, "chunks");
    const metaTable = qualifyTable(this.store.schema, "index_meta");
    if (this.vector.enabled && this.vector.available) {
      await this.sql.unsafe(`
        UPDATE ${chunksTable}
           SET embedding_vec = embedding::vector
         WHERE embedding_vec IS NULL
           AND array_length(embedding, 1) > 0
      `);
    }
    await this.sql.unsafe(`
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
  }

  private async ensureVectorIndexForDims(dims: number): Promise<void> {
    if (
      !this.vector.available ||
      !Number.isInteger(dims) ||
      dims <= 0 ||
      dims > POSTGRES_HNSW_MAX_VECTOR_DIMS
    ) {
      this.vector.indexAvailable = false;
      return;
    }
    const rows = await this.activeSql<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = ${this.store.schema}
        AND tablename = 'chunks'
    `;
    this.vector.indexAvailable = rows.some((row) =>
      isCompatibleHnswIndexDefinition(String(row.indexdef), dims),
    );
    if (this.vector.indexAvailable) {
      return;
    }
    const chunksTable = qualifyTable(this.store.schema, "chunks");
    const indexName = quotePgIdentifier(`chunks_embedding_vec_${dims}_hnsw_idx`);
    await this.activeSql.unsafe(`
      CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${chunksTable}
        USING hnsw ((embedding_vec::vector(${dims})) vector_cosine_ops)
        WHERE embedding_vec IS NOT NULL AND vector_dims(embedding_vec) = ${dims}
    `);
    this.vector.indexAvailable = true;
  }

  private ensureWatcher(): void {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory", "**", "*.md"),
    ]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          watchPaths.add(path.join(entry, "**", "*.md"));
          continue;
        }
        if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath) =>
        shouldIgnoreMemoryWatchPathWithConfig(
          this.workspaceDir,
          String(watchPath),
          this.settings.excludeGlobs,
        ),
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  private ensureSessionListener(): void {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      if (!this.isSessionFileForAgent(update.sessionFile)) {
        return;
      }
      this.scheduleSessionDirty(update.sessionFile);
    });
  }

  private ensureIntervalSync(): void {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`postgres memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  private async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`postgres memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  private scheduleWatchSync(): void {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`postgres memory sync failed (watch): ${String(err)}`);
      });
    }, this.settings.sync.watchDebounceMs);
  }

  private scheduleSessionDirty(sessionFile: string): void {
    this.sessionPendingFiles.add(sessionFile);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err) => {
        log.warn(`postgres memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles);
    this.sessionPendingFiles.clear();
    let shouldSync = false;
    for (const sessionFile of pending) {
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err) => {
        log.warn(`postgres memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const size = stat.size;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await fs.open(absPath, "r");
    } catch (err) {
      if (isFileMissingError(err)) {
        return 0;
      }
      throw err;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private shouldSyncSessions(
    params?: { reason?: string; force?: boolean },
    needsFullReindex = false,
  ): boolean {
    if (!this.sources.has("sessions")) {
      return false;
    }
    if (params?.force) {
      return true;
    }
    const reason = params?.reason;
    if (reason === "session-start" || reason === "watch") {
      return false;
    }
    if (needsFullReindex) {
      return true;
    }
    return this.sessionsDirty && this.sessionsDirtyFiles.size > 0;
  }

  private async detectVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const rows = await this.sql<{ available: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_extension
          WHERE extname = 'vector'
        ) AS available
      `;
      const available = Boolean(rows[0]?.available);
      this.vector.available = available;
      return available;
    } catch (err) {
      this.vector.available = false;
      this.fts.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private async detectTrigramAvailability(): Promise<boolean> {
    try {
      const rows = await this.sql<{ available: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_extension
          WHERE extname = 'pg_trgm'
        ) AS available
      `;
      const available = Boolean(rows[0]?.available);
      this.fts.available = available;
      this.fts.error = available ? undefined : "PostgreSQL extension pg_trgm is not installed.";
      return available;
    } catch (err) {
      this.fts.available = false;
      this.fts.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private computeProviderKey(): string {
    if (!this.provider) {
      return hashText(JSON.stringify({ provider: "none", model: "fts-only" }));
    }
    if (this.provider.id === "openai" && this.openAi) {
      const headers = Object.entries(this.openAi.headers)
        .filter(([key]) => key.toLowerCase() !== "authorization")
        .toSorted(([a], [b]) => a.localeCompare(b));
      return hashText(
        JSON.stringify({
          provider: "openai",
          baseUrl: this.openAi.baseUrl,
          model: this.openAi.model,
          headers,
        }),
      );
    }
    if (this.provider.id === "gemini" && this.gemini) {
      const headers = Object.entries(this.gemini.headers)
        .filter(([key]) => {
          const lower = key.toLowerCase();
          return lower !== "authorization" && lower !== "x-goog-api-key";
        })
        .toSorted(([a], [b]) => a.localeCompare(b));
      return hashText(
        JSON.stringify({
          provider: "gemini",
          baseUrl: this.gemini.baseUrl,
          model: this.gemini.model,
          headers,
        }),
      );
    }
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const reporter = ensureProgressReporter(params?.progress);
    const configuredSources = this.resolveConfiguredSourcesForMeta();
    const configuredExcludeGlobs = this.resolveConfiguredExcludeGlobsForMeta();
    let shouldSyncMemory = false;
    let shouldSyncSessions = false;

    const memoryFiles = this.sources.has("memory")
      ? await listMemoryFiles(
          this.workspaceDir,
          this.settings.extraPaths,
          this.settings.excludeGlobs,
        )
      : [];
    const sessionFiles = this.sources.has("sessions")
      ? await listSessionFilesForAgent(this.agentId)
      : [];
    reporter.setTotal(memoryFiles.length + sessionFiles.length, "Indexing memory");

    await this.withPostgresIndexLock(async () => {
      const meta = await this.readMeta();
      const needsFullReindex =
        Boolean(params?.force) ||
        !meta ||
        meta.model !== (this.provider?.model ?? "fts-only") ||
        meta.provider !== (this.provider?.id ?? "none") ||
        meta.providerKey !== this.providerKey ||
        meta.chunkTokens !== this.settings.chunking.tokens ||
        meta.chunkOverlap !== this.settings.chunking.overlap ||
        JSON.stringify(meta.sources) !== JSON.stringify(configuredSources) ||
        this.metaExcludeGlobsDiffer(meta, configuredExcludeGlobs);

      if (needsFullReindex) {
        const filesTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "files"));
        const chunksTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "chunks"));
        await this.activeSql`DELETE FROM ${filesTable} WHERE agent_id = ${this.agentId}`;
        await this.activeSql`DELETE FROM ${chunksTable} WHERE agent_id = ${this.agentId}`;
      }

      shouldSyncMemory =
        this.sources.has("memory") && (Boolean(params?.force) || needsFullReindex || this.dirty);
      shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ files: memoryFiles, reporter, needsFullReindex });
      }
      if (shouldSyncSessions) {
        await this.syncSessionFiles({ files: sessionFiles, reporter, needsFullReindex });
      }

      await this.writeMeta({
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey,
        sources: configuredSources,
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        vectorDims: this.vector.dims,
        excludeGlobs: configuredExcludeGlobs,
      });
      await this.pruneEmbeddingCacheIfNeeded();
    });

    await this.refreshStatusSnapshot();
    if (shouldSyncMemory) {
      this.dirty = false;
    }
    if (shouldSyncSessions) {
      this.sessionsDirty = false;
      this.sessionsDirtyFiles.clear();
    } else if (this.sessionsDirtyFiles.size > 0) {
      this.sessionsDirty = true;
    } else {
      this.sessionsDirty = false;
    }
  }

  private async withPostgresIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    return await this.sql.begin(async (tx: PostgresMemoryClient) => {
      const previousSql = this.activeSql;
      this.activeSql = tx as unknown as SqlExecutor;
      try {
        await this.activeSql`
          SELECT pg_advisory_xact_lock(hashtext(${this.store.schema}), hashtext(${this.agentId}))
        `;
        return await fn();
      } finally {
        this.activeSql = previousSql;
      }
    });
  }

  private async syncMemoryFiles(params: {
    files: string[];
    reporter: ReturnType<typeof ensureProgressReporter>;
    needsFullReindex: boolean;
  }): Promise<void> {
    const entries = (
      await Promise.all(params.files.map(async (file) => buildFileEntry(file, this.workspaceDir)))
    ).filter((entry): entry is NonNullable<Awaited<ReturnType<typeof buildFileEntry>>> =>
      Boolean(entry),
    );
    const activePaths = new Set(entries.map((entry) => entry.path));
    const tasks = entries.map((entry) => async () => {
      if (!params.needsFullReindex) {
        const rows = await this.activeSql<{ hash: string }[]>`
          SELECT hash
          FROM ${this.activeSql.unsafe(qualifyTable(this.store.schema, "files"))}
          WHERE agent_id = ${this.agentId}
            AND path = ${entry.path}
        `;
        if (rows[0]?.hash === entry.hash) {
          params.reporter.tick();
          return;
        }
      }
      await this.indexFile(entry, { source: "memory" });
      params.reporter.tick();
    });
    await runWithConcurrency(tasks, EMBEDDING_INDEX_CONCURRENCY);

    const staleRows = await this.activeSql<{ path: string }[]>`
      SELECT path
      FROM ${this.activeSql.unsafe(qualifyTable(this.store.schema, "files"))}
      WHERE agent_id = ${this.agentId}
        AND source = 'memory'
    `;
    for (const row of staleRows) {
      if (activePaths.has(row.path)) {
        continue;
      }
      await this.deletePath(row.path, "memory");
    }
  }

  private async syncSessionFiles(params: {
    files: string[];
    reporter: ReturnType<typeof ensureProgressReporter>;
    needsFullReindex: boolean;
  }): Promise<void> {
    const entries = (
      await Promise.all(params.files.map(async (file) => buildSessionEntry(file)))
    ).filter((entry): entry is NonNullable<Awaited<ReturnType<typeof buildSessionEntry>>> =>
      Boolean(entry),
    );
    const activePaths = new Set(entries.map((entry) => entry.path));
    const indexAll = params.needsFullReindex || this.sessionsDirtyFiles.size === 0;
    const tasks = entries.map((entry) => async () => {
      if (!indexAll && !this.sessionsDirtyFiles.has(entry.absPath)) {
        params.reporter.tick();
        return;
      }
      if (!params.needsFullReindex) {
        const rows = await this.activeSql<{ hash: string }[]>`
          SELECT hash
          FROM ${this.activeSql.unsafe(qualifyTable(this.store.schema, "files"))}
          WHERE agent_id = ${this.agentId}
            AND path = ${entry.path}
        `;
        if (rows[0]?.hash === entry.hash) {
          this.resetSessionDelta(entry.absPath, entry.size);
          params.reporter.tick();
          return;
        }
      }
      await this.indexFile(entry, { source: "sessions", content: entry.content });
      this.resetSessionDelta(entry.absPath, entry.size);
      params.reporter.tick();
    });
    await runWithConcurrency(tasks, EMBEDDING_INDEX_CONCURRENCY);

    const staleRows = await this.activeSql<{ path: string }[]>`
      SELECT path
      FROM ${this.activeSql.unsafe(qualifyTable(this.store.schema, "files"))}
      WHERE agent_id = ${this.agentId}
        AND source = 'sessions'
    `;
    for (const row of staleRows) {
      if (activePaths.has(row.path)) {
        continue;
      }
      await this.deletePath(row.path, "sessions");
    }
  }

  private async indexFile(
    entry:
      | NonNullable<Awaited<ReturnType<typeof buildFileEntry>>>
      | NonNullable<Awaited<ReturnType<typeof buildSessionEntry>>>,
    options: { source: MemorySource; content?: string },
  ): Promise<void> {
    const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
    const chunks = chunkMarkdown(content, this.settings.chunking).filter(
      (chunk) => chunk.text.trim().length > 0,
    );
    if (options.source === "sessions" && "lineMap" in entry) {
      remapChunkLines(chunks, entry.lineMap);
    }

    const limitedChunks = this.provider
      ? enforceEmbeddingMaxInputTokens(this.provider, chunks, EMBEDDING_BATCH_MAX_TOKENS)
      : chunks;
    const embeddings = this.provider
      ? await this.embedChunks(limitedChunks)
      : limitedChunks.map(() => []);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    if (sample) {
      const targetDims = sample.length;
      for (const embedding of embeddings) {
        if (embedding.length > 0 && embedding.length !== targetDims) {
          throw new Error(
            `postgres memory expected ${targetDims}-dim embeddings, got ${embedding.length}`,
          );
        }
      }
      this.vector.dims = targetDims;
      await this.ensureVectorIndexForDims(targetDims);
    }

    await this.deletePath(entry.path, options.source);
    const chunksTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "chunks"));
    for (let i = 0; i < limitedChunks.length; i += 1) {
      const chunk = limitedChunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider?.model ?? "fts-only"}`,
      );
      const searchTokens = serializeSearchTokens(buildSearchTokens(chunk.text));
      if (this.vector.enabled && this.vector.available) {
        await this.activeSql`
          INSERT INTO ${chunksTable}
            (agent_id, id, path, source, start_line, end_line, hash, model, text, search_tokens, embedding, embedding_vec, updated_at)
          VALUES
            (
              ${this.agentId},
              ${id},
              ${entry.path},
              ${options.source},
              ${chunk.startLine},
              ${chunk.endLine},
              ${chunk.hash},
              ${this.provider?.model ?? "fts-only"},
              ${chunk.text},
              ${searchTokens},
              ${this.activeSql.array(embedding, 701)},
              ${
                embedding.length > 0
                  ? this.activeSql.unsafe(`'${serializePgvector(embedding)}'::vector`)
                  : null
              },
              NOW()
            )
        `;
      } else {
        await this.activeSql`
          INSERT INTO ${chunksTable}
            (agent_id, id, path, source, start_line, end_line, hash, model, text, search_tokens, embedding, updated_at)
          VALUES
            (
              ${this.agentId},
              ${id},
              ${entry.path},
              ${options.source},
              ${chunk.startLine},
              ${chunk.endLine},
              ${chunk.hash},
              ${this.provider?.model ?? "fts-only"},
              ${chunk.text},
              ${searchTokens},
              ${this.activeSql.array(embedding, 701)},
              NOW()
            )
        `;
      }
    }

    const filesTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "files"));
    await this.activeSql`
      INSERT INTO ${filesTable} (agent_id, path, source, hash, mtime, size)
      VALUES (${this.agentId}, ${entry.path}, ${options.source}, ${entry.hash}, ${Math.floor(entry.mtimeMs)}, ${entry.size})
      ON CONFLICT (agent_id, path) DO UPDATE SET
        source = EXCLUDED.source,
        hash = EXCLUDED.hash,
        mtime = EXCLUDED.mtime,
        size = EXCLUDED.size
    `;
  }

  private async deletePath(pathname: string, source: MemorySource): Promise<void> {
    const filesTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "files"));
    const chunksTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "chunks"));
    await this.activeSql`
      DELETE FROM ${filesTable}
      WHERE agent_id = ${this.agentId}
        AND path = ${pathname}
        AND source = ${source}
    `;
    await this.activeSql`
      DELETE FROM ${chunksTable}
      WHERE agent_id = ${this.agentId}
        AND path = ${pathname}
        AND source = ${source}
    `;
  }

  private async embedQuery(text: string): Promise<number[]> {
    if (!this.provider) {
      return [];
    }
    return this.provider.embedQuery(text);
  }

  private async embedChunks(chunks: Array<{ text: string; hash: string }>): Promise<number[][]> {
    if (!this.provider) {
      return chunks.map(() => []);
    }
    const cached = await this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: Array<number[] | undefined> = Array.from({ length: chunks.length });
    const missing: Array<{ index: number; hash: string; text: string }> = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = cached.get(chunk.hash);
      if (hit) {
        embeddings[i] = hit;
      } else {
        missing.push({ index: i, hash: chunk.hash, text: chunk.text });
      }
    }
    if (missing.length > 0) {
      const fresh = await this.provider.embedBatch(missing.map((entry) => entry.text));
      const cacheEntries: Array<{ hash: string; embedding: number[] }> = [];
      for (let i = 0; i < missing.length; i += 1) {
        const entry = missing[i];
        const embedding = fresh[i] ?? [];
        embeddings[entry.index] = embedding;
        cacheEntries.push({ hash: entry.hash, embedding });
      }
      await this.upsertEmbeddingCache(cacheEntries);
    }
    return embeddings.map((entry) => entry ?? []);
  }

  private async migrateExistingChunkEmbeddings(params: {
    progress?: (update: MemoryVectorMigrationProgressUpdate) => void;
  }): Promise<MemoryVectorMigrationResult> {
    const provider = this.provider;
    if (!provider) {
      throw new Error("Memory embedding migration requires an embedding provider.");
    }
    const result = await this.withPostgresIndexLock(async () => {
      const chunksTable = this.activeSql.unsafe(qualifyTable(this.store.schema, "chunks"));
      const countRows = await this.activeSql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM ${chunksTable}
        WHERE agent_id = ${this.agentId}
          AND source = ANY(${this.activeSql.array(Array.from(this.sources))})
      `;
      const total = Number(countRows[0]?.count ?? 0);
      params.progress?.({ completed: 0, total, label: "Migrating existing memory embeddings" });
      if (total === 0) {
        await this.writeCurrentMeta(undefined);
        return { migrated: 0, skipped: 0 };
      }

      let migrated = 0;
      let skipped = 0;
      let dims: number | undefined;
      let lastId = "";

      while (true) {
        const rows = await this.activeSql<Array<{ id: string; text: string; hash: string }>>`
          SELECT id, text, hash
          FROM ${chunksTable}
          WHERE agent_id = ${this.agentId}
            AND source = ANY(${this.activeSql.array(Array.from(this.sources))})
            AND id > ${lastId}
          ORDER BY id ASC
          LIMIT ${EMBEDDING_MIGRATION_BATCH_SIZE}
        `;
        if (rows.length === 0) {
          break;
        }
        lastId = rows.at(-1)?.id ?? lastId;
        const embeddings = await this.embedChunks(
          rows.map((row) => ({ text: row.text, hash: row.hash })),
        );
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const embedding = embeddings[i] ?? [];
          if (embedding.length === 0) {
            skipped += 1;
            continue;
          }
          if (dims === undefined) {
            dims = embedding.length;
            await this.ensureVectorIndexForDims(dims);
          } else if (embedding.length !== dims) {
            throw new Error(
              `postgres memory migration expected ${dims}-dim embeddings, got ${embedding.length}`,
            );
          }
          await this.activeSql`
            UPDATE ${chunksTable}
               SET model = ${provider.model},
                   embedding = ${this.activeSql.array(embedding, 701)},
                   embedding_vec = ${this.activeSql.unsafe(`'${serializePgvector(embedding)}'::vector`)},
                   updated_at = NOW()
             WHERE agent_id = ${this.agentId}
               AND id = ${row.id}
          `;
          migrated += 1;
        }
        params.progress?.({
          completed: Math.min(total, migrated + skipped),
          total,
          label: `Migrated ${migrated} memory embeddings`,
        });
      }

      await this.writeCurrentMeta(dims);
      await this.pruneEmbeddingCacheIfNeeded();
      return { migrated, skipped, dims };
    });
    if (result.dims) {
      this.vector.dims = result.dims;
    }
    await this.refreshStatusSnapshot();
    return result;
  }

  private async writeCurrentMeta(vectorDims?: number): Promise<void> {
    await this.writeMeta({
      model: this.provider?.model ?? "fts-only",
      provider: this.provider?.id ?? "none",
      providerKey: this.providerKey,
      sources: this.resolveConfiguredSourcesForMeta(),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      vectorDims: vectorDims ?? this.vector.dims,
      excludeGlobs: this.resolveConfiguredExcludeGlobsForMeta(),
    });
  }

  private async loadEmbeddingCache(hashes: string[]): Promise<Map<string, number[]>> {
    if (!this.cache.enabled || !this.provider || hashes.length === 0) {
      return new Map();
    }
    const unique = Array.from(new Set(hashes.filter(Boolean)));
    if (unique.length === 0) {
      return new Map();
    }
    const table = this.activeSql.unsafe(qualifyTable(this.store.schema, "embedding_cache"));
    const rows = await this.activeSql<{ hash: string; embedding_json: unknown }[]>`
      SELECT hash, embedding_json
      FROM ${table}
      WHERE provider = ${this.provider.id}
        AND model = ${this.provider.model}
        AND provider_key = ${this.providerKey}
        AND hash = ANY(${this.activeSql.array(unique)})
    `;
    return new Map(
      rows.map((row: { hash: string; embedding_json: unknown }) => [
        row.hash,
        Array.isArray(row.embedding_json) ? (row.embedding_json as number[]) : [],
      ]),
    );
  }

  private async upsertEmbeddingCache(
    entries: Array<{ hash: string; embedding: number[] }>,
  ): Promise<void> {
    if (!this.cache.enabled || !this.provider || entries.length === 0) {
      return;
    }
    const table = this.activeSql.unsafe(qualifyTable(this.store.schema, "embedding_cache"));
    for (const entry of entries) {
      await this.activeSql`
        INSERT INTO ${table}
          (provider, model, provider_key, hash, embedding_json, dims, updated_at)
        VALUES
          (
            ${this.provider.id},
            ${this.provider.model},
            ${this.providerKey},
            ${entry.hash},
            ${this.activeSql.json(entry.embedding)},
            ${entry.embedding.length},
            NOW()
          )
        ON CONFLICT (provider, model, provider_key, hash) DO UPDATE SET
          embedding_json = EXCLUDED.embedding_json,
          dims = EXCLUDED.dims,
          updated_at = EXCLUDED.updated_at
      `;
    }
  }

  private async pruneEmbeddingCacheIfNeeded(): Promise<void> {
    if (!this.cache.enabled || !this.cache.maxEntries || this.cache.maxEntries <= 0) {
      return;
    }
    const table = this.activeSql.unsafe(qualifyTable(this.store.schema, "embedding_cache"));
    const rows = await this.activeSql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM ${table}
    `;
    const count = Number(rows[0]?.count ?? 0);
    if (count <= this.cache.maxEntries) {
      return;
    }
    const excess = count - this.cache.maxEntries;
    await this.activeSql.unsafe(`
      DELETE FROM ${qualifyTable(this.store.schema, "embedding_cache")}
      WHERE (provider, model, provider_key, hash) IN (
        SELECT provider, model, provider_key, hash
        FROM ${qualifyTable(this.store.schema, "embedding_cache")}
        ORDER BY updated_at ASC
        LIMIT ${excess}
      )
    `);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled) {
      return [];
    }
    const tokens = buildKeywordQueryTokens(query);
    if (tokens.length === 0) {
      return [];
    }
    const chunksTable = this.sql.unsafe(qualifyTable(this.store.schema, "chunks"));
    const likeTerms = tokens.map((token) => `%${token}%`);
    const rows = this.fts.available
      ? await this.sql<
          {
            id: string;
            path: string;
            source: string;
            start_line: number;
            end_line: number;
            text: string;
            search_tokens: string;
          }[]
        >`
          SELECT id, path, source, start_line, end_line, text, search_tokens
          FROM ${chunksTable}
          WHERE agent_id = ${this.agentId}
            AND source = ANY(${this.sql.array(Array.from(this.sources))})
            AND (
              search_tokens ILIKE ANY(${this.sql.array(likeTerms)})
              OR similarity(search_tokens, ${serializeSearchTokens(tokens)}) > 0
            )
          LIMIT ${limit}
        `
      : await this.sql<
          {
            id: string;
            path: string;
            source: string;
            start_line: number;
            end_line: number;
            text: string;
            search_tokens: string;
          }[]
        >`
          SELECT id, path, source, start_line, end_line, text, search_tokens
          FROM ${chunksTable}
          WHERE agent_id = ${this.agentId}
            AND source = ANY(${this.sql.array(Array.from(this.sources))})
            AND search_tokens ILIKE ANY(${this.sql.array(likeTerms)})
          LIMIT ${limit}
        `;
    return rows.map((row: { search_tokens: string } & Record<string, unknown>) => {
      const haystack = new Set(row.search_tokens.split(/\s+/).filter(Boolean));
      const matched = tokens.filter((token) => haystack.has(token)).length;
      const textScore = matched / Math.max(tokens.length, 1);
      return {
        id: String(row.id),
        path: String(row.path),
        source: toMemorySource(String(row.source)),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        snippet: truncateSnippet(String(row.text)),
        score: textScore,
        textScore,
      };
    });
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    if (this.vector.enabled && this.vector.available) {
      const native = await this.searchVectorWithPgvector(queryVec, limit);
      if (native.length > 0) {
        return native;
      }
    }
    return this.searchVectorWithCosineFallback(queryVec, limit);
  }

  private async searchVectorWithPgvector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    const dims = this.vector.dims ?? queryVec.length;
    if (!Number.isInteger(dims) || dims <= 0 || queryVec.length !== dims) {
      return [];
    }
    const chunksTable = this.sql.unsafe(qualifyTable(this.store.schema, "chunks"));
    const vectorType = this.sql.unsafe(`vector(${dims})`);
    const embeddingExpr = this.sql.unsafe(`embedding_vec::vector(${dims})`);
    await this.ensureVectorIndexForDims(dims);
    const rows = await this.sql<
      {
        id: string;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        score: number;
      }[]
    >`
      SELECT
        id,
        path,
        source,
        start_line,
        end_line,
        text,
        GREATEST(
          0::double precision,
          1 - (${embeddingExpr} <=> ${this.sql.array(queryVec, 701)}::${vectorType})
        ) AS score
      FROM ${chunksTable}
      WHERE agent_id = ${this.agentId}
        AND source = ANY(${this.sql.array(Array.from(this.sources))})
        AND model = ${this.provider?.model ?? "fts-only"}
        AND embedding_vec IS NOT NULL
        AND vector_dims(embedding_vec) = ${dims}
      ORDER BY ${embeddingExpr} <=> ${this.sql.array(queryVec, 701)}::${vectorType}
      LIMIT ${limit}
    `;
    return rows.map(
      (row: {
        id: string;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        score: number;
      }) => {
        const score = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
        return {
          id: row.id,
          path: row.path,
          source: toMemorySource(row.source),
          startLine: row.start_line,
          endLine: row.end_line,
          snippet: truncateSnippet(row.text),
          score,
        };
      },
    );
  }

  private async searchVectorWithCosineFallback(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    const chunksTable = this.sql.unsafe(qualifyTable(this.store.schema, "chunks"));
    const rows = await this.sql<
      {
        id: string;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        embedding: number[] | string;
      }[]
    >`
      SELECT id, path, source, start_line, end_line, text, embedding
      FROM ${chunksTable}
      WHERE agent_id = ${this.agentId}
        AND source = ANY(${this.sql.array(Array.from(this.sources))})
        AND model = ${this.provider?.model ?? "fts-only"}
    `;
    return rows
      .map(
        (row: {
          id: string;
          path: string;
          source: string;
          start_line: number;
          end_line: number;
          text: string;
          embedding: number[] | string;
        }) => {
          const embedding = Array.isArray(row.embedding)
            ? row.embedding.map((value: number) => Number(value))
            : parseEmbedding(String(row.embedding));
          return {
            id: row.id,
            path: row.path,
            source: toMemorySource(row.source),
            startLine: row.start_line,
            endLine: row.end_line,
            snippet: truncateSnippet(row.text),
            score: cosineSimilarity(queryVec, embedding),
          };
        },
      )
      .filter((row: MemorySearchResult & { id: string }) => Number.isFinite(row.score))
      .toSorted(
        (a: MemorySearchResult & { id: string }, b: MemorySearchResult & { id: string }) =>
          b.score - a.score,
      )
      .slice(0, limit);
  }

  private async readMeta(): Promise<MemoryIndexMeta | null> {
    const table = this.activeSql.unsafe(qualifyTable(this.store.schema, "index_meta"));
    const rows = await this.activeSql<
      {
        provider: string;
        model: string;
        provider_key: string;
        sources: unknown;
        exclude_globs: unknown;
        chunk_tokens: number;
        chunk_overlap: number;
        vector_dims: number | null;
      }[]
    >`
      SELECT provider, model, provider_key, sources, exclude_globs, chunk_tokens, chunk_overlap, vector_dims
      FROM ${table}
      WHERE agent_id = ${this.agentId}
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      provider: row.provider,
      model: row.model,
      providerKey: row.provider_key,
      sources: Array.isArray(row.sources)
        ? row.sources.map((source: unknown) => toMemorySource(String(source)))
        : ["memory"],
      excludeGlobs: Array.isArray(row.exclude_globs)
        ? row.exclude_globs.map((pattern: unknown) => String(pattern))
        : [],
      chunkTokens: row.chunk_tokens,
      chunkOverlap: row.chunk_overlap,
      vectorDims: row.vector_dims ?? undefined,
    };
  }

  private async writeMeta(meta: MemoryIndexMeta): Promise<void> {
    const table = this.activeSql.unsafe(qualifyTable(this.store.schema, "index_meta"));
    await this.activeSql`
      INSERT INTO ${table}
        (agent_id, provider, model, provider_key, sources, exclude_globs, chunk_tokens, chunk_overlap, vector_dims, updated_at)
      VALUES
        (
          ${this.agentId},
          ${meta.provider},
          ${meta.model},
          ${meta.providerKey},
          ${this.activeSql.json(meta.sources)},
          ${this.activeSql.json(meta.excludeGlobs ?? [])},
          ${meta.chunkTokens},
          ${meta.chunkOverlap},
          ${meta.vectorDims ?? null},
          NOW()
        )
      ON CONFLICT (agent_id) DO UPDATE SET
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        provider_key = EXCLUDED.provider_key,
        sources = EXCLUDED.sources,
        exclude_globs = EXCLUDED.exclude_globs,
        chunk_tokens = EXCLUDED.chunk_tokens,
        chunk_overlap = EXCLUDED.chunk_overlap,
        vector_dims = EXCLUDED.vector_dims,
        updated_at = EXCLUDED.updated_at
    `;
  }

  private resolveConfiguredSourcesForMeta(): MemorySource[] {
    const normalized = Array.from(this.sources)
      .filter(
        (source: MemorySource): source is MemorySource =>
          source === "memory" || source === "sessions",
      )
      .toSorted();
    return normalized.length > 0 ? normalized : ["memory"];
  }

  private resolveConfiguredExcludeGlobsForMeta(): string[] {
    return Array.from(
      new Set((this.settings.excludeGlobs ?? []).map((pattern) => pattern.trim()).filter(Boolean)),
    ).toSorted();
  }

  private normalizeMetaExcludeGlobs(meta: MemoryIndexMeta): string[] {
    return Array.from(
      new Set((meta.excludeGlobs ?? []).map((pattern) => String(pattern).trim()).filter(Boolean)),
    ).toSorted();
  }

  private metaExcludeGlobsDiffer(meta: MemoryIndexMeta, configuredExcludeGlobs: string[]): boolean {
    const metaExcludeGlobs = this.normalizeMetaExcludeGlobs(meta);
    if (metaExcludeGlobs.length !== configuredExcludeGlobs.length) {
      return true;
    }
    return metaExcludeGlobs.some((pattern, index) => pattern !== configuredExcludeGlobs[index]);
  }

  private async refreshStatusSnapshot(): Promise<void> {
    const filesTable = this.sql.unsafe(qualifyTable(this.store.schema, "files"));
    const chunksTable = this.sql.unsafe(qualifyTable(this.store.schema, "chunks"));
    const filesRows = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM ${filesTable}
      WHERE agent_id = ${this.agentId}
    `;
    const chunksRows = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM ${chunksTable}
      WHERE agent_id = ${this.agentId}
    `;
    const fileCounts = await this.sql<{ source: string; count: number }[]>`
      SELECT source, COUNT(*)::int AS count
      FROM ${filesTable}
      WHERE agent_id = ${this.agentId}
      GROUP BY source
    `;
    const chunkCounts = await this.sql<{ source: string; count: number }[]>`
      SELECT source, COUNT(*)::int AS count
      FROM ${chunksTable}
      WHERE agent_id = ${this.agentId}
      GROUP BY source
    `;
    const bySource = new Map<MemorySource, { files: number; chunks: number }>();
    for (const source of Array.from(this.sources)) {
      bySource.set(source, { files: 0, chunks: 0 });
    }
    for (const row of fileCounts) {
      const source = toMemorySource(row.source);
      const current = bySource.get(source) ?? { files: 0, chunks: 0 };
      current.files = Number(row.count ?? 0);
      bySource.set(source, current);
    }
    for (const row of chunkCounts) {
      const source = toMemorySource(row.source);
      const current = bySource.get(source) ?? { files: 0, chunks: 0 };
      current.chunks = Number(row.count ?? 0);
      bySource.set(source, current);
    }
    let cacheEntries = 0;
    if (this.cache.enabled) {
      const cacheTable = this.sql.unsafe(qualifyTable(this.store.schema, "embedding_cache"));
      const cacheRows = await this.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM ${cacheTable}
      `;
      cacheEntries = Number(cacheRows[0]?.count ?? 0);
    }
    this.statusSnapshot = {
      files: Number(filesRows[0]?.count ?? 0),
      chunks: Number(chunksRows[0]?.count ?? 0),
      cacheEntries,
      sourceCounts: Array.from(bySource.entries()).map(([source, counts]) => ({
        source,
        files: counts.files,
        chunks: counts.chunks,
      })),
    };
  }
}
