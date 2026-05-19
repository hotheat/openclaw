# Implementation Plan: Memory PostgreSQL Backend

## Overview

为 OpenClaw builtin memory 增加 PostgreSQL 存储后端，同时保留现有 SQLite 路径。全局 `memory.backend` 继续只负责 `"builtin"` 与 `"qmd"` 的选择；当后端为 `"builtin"` 时，再通过 `agents.*.memorySearch.store.driver` 在 `"sqlite"` 与 `"postgres"` 间切换。

PostgreSQL 方案优先支持：

- 共享集中式存储
- `pgvector` 语义检索
- `pg_trgm` + 应用侧中文 token 化的关键词检索
- 与现有 memory 召回、混合排序、同步语义尽量对齐
- 继续复用现有 `agent_server` 数据库，而不是额外拆独立库

## Requirements

- 支持在 `~/.openclaw/.env` 中声明 PostgreSQL 连接变量，并在 `openclaw.json` 中通过 `${VAR}` 引用。
- 支持 `sqlite` 与 `postgres` 双驱动切换，不破坏现有 `qmd` 路径。
- PostgreSQL 支持 memory 文件索引、session 文件索引、embedding cache、元数据、混合检索。
- 中文关键词检索不能依赖 PostgreSQL 默认 parser；需使用应用侧 token 化。
- 现有查询融合逻辑继续复用，避免 builtin 检索行为大幅漂移。
- 原始数据源明确为 `MEMORY.md` / `memory/*.md` / 可选 sessions，而不是从 SQLite 导入。
- 删除一次性升级命令 `openclaw memory prepare-upgrade`，改用通用 lifecycle CLI。

## Configuration Design

### Backend Selection

- `memory.backend`
  - `"builtin"`: 使用 OpenClaw 内建 memory
  - `"qmd"`: 使用现有 QMD sidecar
- `agents.*.memorySearch.store.driver`
  - `"sqlite"`: 使用当前 SQLite 存储
  - `"postgres"`: 使用新的 PostgreSQL 存储

### `.env`

使用现有 `~/.openclaw/.env`，例如：

```dotenv
POSTGRES__HOST=localhost
POSTGRES__PORT=5432
POSTGRES__DATABASE=agent_server
POSTGRES__USERNAME=postgres
POSTGRES__PASSWORD=0HObSLhrOa1vFB
POSTGRES__ECHO=false
```

### `openclaw.json`

启用 builtin + PostgreSQL：

```json5
{
  memory: {
    backend: "builtin",
  },
  agents: {
    defaults: {
      memorySearch: {
        enabled: true,
        sources: ["memory"],
        provider: "openai",
        remote: {
          baseUrl: "https://api.jina.ai/v1",
          apiKey: "${JINA_API_KEY}",
        },
        model: "jina-embeddings-v5-text-small",
        store: {
          driver: "postgres",
          postgres: {
            host: "${POSTGRES__HOST}",
            port: "${POSTGRES__PORT}",
            database: "${POSTGRES__DATABASE}",
            user: "${POSTGRES__USERNAME}",
            password: "${POSTGRES__PASSWORD}",
            schema: "agent_memory",
            ssl: false,
            poolMax: 10,
            echo: "${POSTGRES__ECHO}",
          },
          vector: {
            enabled: true,
          },
          cache: {
            enabled: true,
            maxEntries: 50000,
          },
        },
      },
    },
  },
}
```

回退到 SQLite：

```json5
{
  memory: {
    backend: "builtin",
  },
  agents: {
    defaults: {
      memorySearch: {
        store: {
          driver: "sqlite",
          path: "~/.openclaw/memory/{agentId}.sqlite",
          vector: {
            enabled: true,
          },
        },
      },
    },
  },
}
```

说明：

- PostgreSQL 继续使用现有数据库 `agent_server`
- memory 表统一落在 schema `agent_memory`
- 不新增独立 `memory` 数据库，先采用“共库分 schema”策略

## Schema Design

使用单数据库 `agent_server`，单 schema `agent_memory`。不做“一 agent 一库”，而是共享表并用 `agent_id` 隔离。

选择该方案的原因：

- 现有环境已提供 `agent_server` 连接信息，部署成本最低
- 便于复用当前运维、备份、监控和权限体系
- 通过独立 schema 可以避免 memory 表污染 `public`
- 后续若需要拆库，可按 schema 迁移，不影响第一阶段落地

### Extensions

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### Tables

#### `agent_memory.index_meta`

- `agent_id text primary key`
- `provider text not null`
- `model text not null`
- `provider_key text not null`
- `sources jsonb not null`
- `chunk_tokens integer not null`
- `chunk_overlap integer not null`
- `vector_dims integer`
- `updated_at timestamptz not null default now()`

#### `agent_memory.files`

- `agent_id text not null`
- `path text not null`
- `source text not null`
- `hash text not null`
- `mtime bigint not null`
- `size bigint not null`
- `primary key (agent_id, path)`

#### `agent_memory.chunks`

- `agent_id text not null`
- `id text not null`
- `path text not null`
- `source text not null`
- `start_line integer not null`
- `end_line integer not null`
- `hash text not null`
- `model text not null`
- `text text not null`
- `search_tokens text not null`
- `embedding vector(1024)`
- `updated_at timestamptz not null default now()`
- `primary key (agent_id, id)`

说明：

- `embedding` 第一版固定按当前主模型 `1024` 维落地。
- 若后续要混用不同维度模型，再升级为按模型分表或按模型建部分索引。
- `search_tokens` 是应用侧生成的检索 token 串，例如 `今天 讨论 中文 分词 中文分词`。

#### `agent_memory.embedding_cache`

- `provider text not null`
- `model text not null`
- `provider_key text not null`
- `hash text not null`
- `embedding_json jsonb not null`
- `dims integer`
- `updated_at timestamptz not null default now()`
- `primary key (provider, model, provider_key, hash)`

说明：

- cache 不做向量 ANN 查询，因此保留 `jsonb` 最稳，兼容不同维度模型。

### Indexes

```sql
CREATE INDEX files_agent_source_idx
  ON agent_memory.files (agent_id, source);

CREATE INDEX chunks_agent_model_idx
  ON agent_memory.chunks (agent_id, model);

CREATE INDEX chunks_agent_path_idx
  ON agent_memory.chunks (agent_id, path);

CREATE INDEX chunks_tokens_trgm_idx
  ON agent_memory.chunks
  USING gin (search_tokens gin_trgm_ops);

CREATE INDEX chunks_embedding_hnsw_idx
  ON agent_memory.chunks
  USING hnsw (embedding vector_cosine_ops);
```

说明：

- 第一版即使不建 HNSW 也能工作；在 chunk 数较小时可先精确检索。
- 若主模型固定，也可改成按 `model` 建部分 HNSW 索引。

## Query Strategy

### Vector Retrieval

- 生成 query embedding
- 使用 PostgreSQL `ORDER BY embedding <=> $1 LIMIT k`
- 默认加过滤条件：
  - `agent_id = $agentId`
  - `model = $providerModel`
  - `source IN (...)`

### Keyword Retrieval

- 不依赖 PostgreSQL 默认中文 parser
- 应用侧先把 chunk 文本生成 `search_tokens`
- 查询侧也使用相同 token 化逻辑生成 `query_tokens`
- 用两种方式召回：
  - `ILIKE` / `pg_trgm` 相似度兜底
  - 可选 `to_tsvector('simple', search_tokens)` + `plainto_tsquery('simple', query_tokens)`

### Hybrid Merge

- 继续复用现有 `mergeHybridResults`
- PostgreSQL 只负责各自候选集召回
- 最终排序、MMR、时间衰减仍在应用层完成

## Chinese Search Strategy

不要依赖 PostgreSQL 默认 FTS parser 处理中文。直接复用现有逻辑思路：

- 检测 Han script
- 提取关键词
- 对连续中文生成单字和双字 token
- 丢弃过短、噪声大的 token

参考现有实现：

- `src/memory/qmd-manager.ts` 中 Han BM25 归一化
- `src/memory/query-expansion.ts` 中中文 unigram/bigram 提取

建议新增共享函数，例如：

- `src/memory/search-lexemes.ts`
  - `buildSearchTokens(text: string): string[]`
  - `buildKeywordQueryTokens(query: string): string[]`

让 SQLite、QMD、PostgreSQL 共用这一层，减少中文行为分叉。

## Implementation Strategy

### Overall Direction

不要先试图把现有 SQLite manager 完全抽象成数据库无关层。当前实现深度绑定 `node:sqlite`、FTS5、sqlite-vec。第一版更务实的方案是：

- 新增 `PostgresMemoryManager`
- 复用已有文件发现、chunking、embedding provider、结果融合逻辑
- 允许少量同步路径代码重复
- 在跑通后再抽出共用 indexing core

### Phase 1: Config Surface

Files:

- `src/config/types.tools.ts`
- `src/agents/memory-search.ts`
- `src/config/zod-schema.ts`
- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`
- `src/agents/memory-search.test.ts`

Actions:

- 扩展 `memorySearch.store.driver` 为 `"sqlite" | "postgres"`
- 增加 `store.postgres`
  - `host`
  - `port`
  - `database`
  - `user`
  - `password`
  - `schema`
  - `ssl`
  - `poolMax`
  - `echo`
- 保持 `${VAR}` 环境变量替换兼容

### Phase 2: Manager Selection

Files:

- `src/memory/search-manager.ts`
- `src/memory/types.ts`

Actions:

- builtin 分支下根据 `resolved.memorySearch.store.driver`
  - `sqlite` -> `MemoryIndexManager`
  - `postgres` -> `PostgresMemoryManager`
- `memory.backend = qmd` 保持现有逻辑不变

### Phase 3: PostgreSQL Store and Schema

Files:

- `src/memory/postgres-client.ts`
- `src/memory/postgres-schema.ts`
- `src/memory/postgres-types.ts`

Actions:

- 基于 `pg` 建连接池
- 启动时 `CREATE SCHEMA IF NOT EXISTS`
- 校验 `vector` 与 `pg_trgm` 扩展可用性
- 缺扩展时在 `status()` 和 `probe*()` 中给出明确错误

### Phase 4: PostgreSQL Manager

Files:

- `src/memory/postgres-manager.ts`
- `src/memory/postgres-search.ts`
- `src/memory/postgres-sync.ts`

Actions:

- 实现 `MemorySearchManager`
- 支持：
  - `search`
  - `readFile`
  - `sync`
  - `status`
  - `probeEmbeddingAvailability`
  - `probeVectorAvailability`
- 同步时使用事务 + `pg_advisory_lock`

### Phase 5: Shared Tokenization

Files:

- `src/memory/search-lexemes.ts`
- `src/memory/hybrid.ts`
- `src/memory/qmd-manager.ts`
- `src/memory/postgres-manager.ts`

Actions:

- 抽出 Han/CJK token 化
- 统一 query token 行为
- 减少 SQLite、QMD、PostgreSQL 的中文召回偏差

### Phase 6: Migration Tooling

Files:

- `src/cli/memory-cli.ts`
- `src/cli/memory-cli.test.ts`

Actions:

- 删除 `openclaw memory prepare-upgrade`
- 增加 `openclaw memory init-store`
  - 连接 PostgreSQL
  - 检查并创建 schema
  - 检查并创建 `vector` / `pg_trgm` 扩展
  - 检查并创建表和索引
  - 保持幂等，可重复执行
- 保留并复用 `openclaw memory index --force`
  - 直接从 `MEMORY.md` / `memory/*.md` / 可选 sessions 重建索引
  - 不引入“从 sqlite import”语义
- 可选增加 `openclaw memory init-store --index`
  - 初始化存储后立即执行完整索引
- 增加便利命令 `openclaw memory bootstrap-store`
  - 等价于先执行 `openclaw memory init-store`
  - 再执行 `openclaw memory index --force`
  - 主要用于首次启用 PostgreSQL 时的一步式操作
  - 本质上是 operator convenience command，不替代 `init-store` 与 `index` 这两个基础原语
- 后续如确实需要从 SQLite 迁移缓存或历史索引，再单独增加：
  - `openclaw memory migrate-store --from sqlite --to postgres`

## Runtime Behavior

### Connection Source

- PostgreSQL 连接信息只从 `openclaw.json` 读取
- `openclaw.json` 使用 `${POSTGRES__HOST}` 等环境变量占位
- `~/.openclaw/.env` 由现有 config loader 自动加载

### Source of Truth

- memory 原始数据的真相源仍然是 workspace 下的：
  - `MEMORY.md`
  - `memory/*.md`
  - 可选 `sessions`
- PostgreSQL 仅存储索引、元数据和 embedding cache
- 因此第一阶段不需要“导入 SQLite”；只需要：
  - `openclaw memory init-store`
  - `openclaw memory index --force`
- 若希望一步完成初始化与首轮建索引，可使用：
  - `openclaw memory bootstrap-store`

### Error Handling

- PostgreSQL 不可达：manager 初始化失败，返回明确连接错误
- 缺 `vector` 扩展：允许只跑关键词检索，`vector.available=false`
- 缺 `pg_trgm`：允许只跑向量检索，关键词检索退化
- schema 不存在：自动创建

## Testing Strategy

### Unit Tests

- `src/agents/memory-search.test.ts`
  - 解析 `driver=postgres`
  - 解析 env substitution
- `src/memory/search-manager.test.ts`
  - builtin 下选择 postgres manager
- `src/memory/postgres-manager.test.ts`
  - sync
  - vector search
  - keyword search
  - hybrid merge
  - status/probe

### Integration Tests

- 使用 Docker PostgreSQL + `pgvector/pgvector:pg16`
- 启用 `vector`、`pg_trgm`
- 覆盖：
  - 中文 query 命中
  - Jina embeddings 写入与查询
  - SQLite 与 PostgreSQL 结果近似一致

### Regression Tests

- 现有 SQLite tests 保持通过
- `memory.backend = qmd` 不回归
- 删除 `prepare-upgrade` 后，补充 CLI help / 命令集回归测试
- `memory init-store` 在重复执行时保持幂等
- `memory index --force` 在 PostgreSQL 驱动下可直接从 `memory/*.md` 重建

## Risks and Mitigations

### Risk: 现有 SQLite manager 与 `DatabaseSync` 强耦合

Mitigation:

- 第一版单独实现 `PostgresMemoryManager`
- 不强行一步到位抽象底层 DB

### Risk: 中文检索效果不稳定

Mitigation:

- 不依赖 PostgreSQL 默认中文 parser
- 统一应用侧 token 化
- 复用现有 Han bigram 策略

### Risk: 多模型维度不一致

Mitigation:

- 第一版限定主用模型为 1024 维
- embedding cache 仍存 `jsonb`
- 后续按模型分表或部分索引扩展

### Risk: PostgreSQL 检索性能不如预期

Mitigation:

- 小规模先用精确检索
- 达到阈值后启用 HNSW
- 保留 btree 过滤索引

## Success Criteria

- [ ] `memory.backend = builtin` 时，可通过 `memorySearch.store.driver` 在 SQLite 与 PostgreSQL 间切换
- [ ] `~/.openclaw/.env` 中的 `POSTGRES__*` 可在 `openclaw.json` 里通过 `${VAR}` 正常引用
- [ ] PostgreSQL 继续使用 `agent_server` 数据库，并通过 `agent_memory` schema 隔离
- [ ] PostgreSQL 支持 memory 文件索引、embedding cache、混合检索
- [ ] `openclaw memory init-store` 可幂等完成 PostgreSQL 初始化建表
- [ ] `openclaw memory index --force` 可直接从 `memory/*.md` 写入 PostgreSQL
- [ ] `openclaw memory bootstrap-store` 可一条命令完成初始化存储与首轮全量索引
- [ ] 中文 query 在 PostgreSQL 下的关键词召回明显优于当前 SQLite FTS5 默认行为
- [ ] 现有 SQLite builtin 与 QMD 路径不回归
