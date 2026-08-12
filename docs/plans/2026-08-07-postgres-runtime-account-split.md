# Implementation Plan: PostgreSQL 运行账号第一阶段拆分

## Overview

第一阶段只新增两个 PostgreSQL 运行登录账号：

- `oc_agent_memory_runtime`：仅服务 OpenClaw PostgreSQL memory store。
- `oc_skill_reader`：仅服务 DepMap、TCGA/CPTAC 等 `skill_database` 查询脚本。

OpenClaw 侧使用三个职责明确的完整 PostgreSQL DSN：

- `MEMORY_DB_URL` 指向 `oc_agent_memory_runtime`。
- `SKILL_DB_URL` 指向 `oc_skill_reader`。
- `OPENCLAW_MEMORY_MIGRATION_URL` 只在显式迁移命令中临时指向现有管理员账号。

第一阶段删除 `POSTGRES__*` 和 `DEPMAP_DB_URL` 的运行期读取与回退逻辑。专用变量缺失时对应功能必须失败，禁止回退到其他数据库账号。

同时修改 PostgreSQL memory backend，彻底移除 Gateway 启动和运行期间的自动 DDL。结构迁移只能通过显式 CLI 执行，CLI 使用调用时临时传入的现有管理员凭据。迁移凭据不写入 Gateway 的 `.env`，不新增第三个持久运行账号。

第一阶段不实现 migration advisory lock，不创建 migration 记录表，也不记录 migration version 和 checksum。迁移 CLI 依靠幂等 DDL、数据条件和迁移后的严格结构验证判断结果。迁移必须由运维侧串行执行，不支持多个迁移进程并发运行。

该阶段先消除 `guo_jiao -> otr_admin` 带来的跨数据库写入和转授权风险。DepMap 与 TCGA/CPTAC 仍共享 `skill_database` 只读账号，schema 内部的数据域隔离留到下一阶段。

## Requirements

- Memory store 可以正常检索和同步。
- Gateway 启动和运行期间不得执行 DDL 或一次性数据迁移。
- Schema 不兼容时 Gateway 必须失败并输出明确的 CLI 迁移提示。
- PostgreSQL migration 只能通过显式 CLI 执行。
- Gateway 不得读取 `OPENCLAW_MEMORY_MIGRATION_URL`。
- `OPENCLAW_MEMORY_MIGRATION_URL` 不得写入部署 `.env`。
- Memory 只能通过 `MEMORY_DB_URL` 获取运行期数据库凭据。
- Skill 查询只能通过 `SKILL_DB_URL` 获取运行期数据库凭据。
- 运行期代码不得读取或兼容任何 `POSTGRES__*`。
- Skill 代码不得读取或兼容 `DEPMAP_DB_URL`。
- Skill 查询只能读取 `skill_database`。
- Memory 账号不能读取 `skill_database` 和 `public` 业务表。
- Skill 账号不能读取或修改 `agent_memory`。
- 两个账号均不得继承 `otr_admin`、`read_only`、`ctti`。
- 两个账号均不得拥有超级用户、建库、建角色、复制、绕过 RLS 权限。
- 不修改现有表数据。
- 当前设计阶段不执行 OpenClaw build。
- Gateway 重启必须单独获得用户确认。

## Current Constraints

### Memory 当前运行期包含自动迁移

`src/memory/postgres-schema.ts` 会在 manager 初始化时执行：

- `CREATE SCHEMA IF NOT EXISTS`
- `CREATE EXTENSION IF NOT EXISTS`
- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE`
- `CREATE INDEX IF NOT EXISTS`

`src/memory/postgres-manager.ts` 还会在运行期维护向量索引。

这些操作必须从 `PostgresMemoryManager` 初始化链路移出。运行期只允许：

- 读取扩展、表、列、约束和索引状态。
- 对四张业务表执行 `SELECT`、`INSERT`、`UPDATE`、`DELETE`。
- 获取现有 PostgreSQL advisory transaction lock，仅用于串行化同一 agent 的数据同步。

以下一次性操作也必须迁入 CLI：

- `backfillVectorColumns()`。
- `backfillVectorMetadata()`。
- `ensureVectorIndexForDims()` 中的 `CREATE INDEX`。

运行期发现 schema、数据状态或向量索引不兼容时，不做自动修复。

### 当前通用数据库变量造成凭据串用

当前 Memory 通过 `openclaw.json` 中的 `${POSTGRES__*}` 获取连接参数。以下 Skill 脚本也会读取同一组 `POSTGRES__*`：

- `workspace/skills/depmap-query/scripts/query_depmap_pg.py`
- `workspace/skills/tcga-cptac-query/scripts/query_tcga_cptac_pg.py`
- `workspace/skills/depmap-query/scripts/plot_mutation_oncoprint_final_matplotlib.py`

当前 Skill 连接配置优先级为：

1. CLI `--db-url`。
2. `DEPMAP_DB_URL`。
3. 通用 `POSTGRES__*`。
4. Skill YAML 中的连接配置。

当前部署没有设置 `DEPMAP_DB_URL`，因此 Skill 与 Memory 实际共用同一个数据库账号。该回退会让 Skill 进程获得 Memory 凭据，配置缺失时也不会立即失败。

目标状态删除上述兼容链：

```text
Memory
  └── MEMORY_DB_URL
        └── 缺失时启动失败

Skill
  ├── CLI --db-url
  └── SKILL_DB_URL
        └── 缺失时查询失败
```

Skill YAML 只保留 schema、表名和查询布局，不再承载数据库账号或密码。Skill schema 使用配置中的固定值 `skill_database`，不再读取 `POSTGRES__SKILL_SCHEMA`。

## Authorization Matrix

```text
┌─────────────────────────┬────────────────┬─────────────────────┬─────────────────┐
│ Login role              │ Database       │ Schema              │ Effective access│
├─────────────────────────┼────────────────┼─────────────────────┼─────────────────┤
│ oc_agent_memory_runtime │ agent          │ agent_memory        │ SELECT/I/U/D    │
│ oc_agent_memory_runtime │ agent          │ skill_database      │ none            │
│ oc_agent_memory_runtime │ agent          │ public business     │ none            │
│ oc_skill_reader         │ agent          │ skill_database      │ SELECT          │
│ oc_skill_reader         │ agent          │ agent_memory        │ none            │
│ oc_skill_reader         │ agent          │ public business     │ none            │
└─────────────────────────┴────────────────┴─────────────────────┴─────────────────┘
```

`agent_memory` schema 和对象继续由现有 owner 管理。`oc_agent_memory_runtime` 不成为 owner，不获得 `CREATE`、`ALTER`、`DROP`、`TRUNCATE`、`REFERENCES`、`TRIGGER` 或 `GRANT OPTION`。

## Architecture Changes

### Environment Variable Decision

第一阶段使用三种凭据入口，但只有两个运行期入口持久存在：

```text
┌───────────────────────────────────┬─────────────────────────┬──────────────────────────┐
│ Variable                          │ Credential identity     │ Lifetime                 │
├───────────────────────────────────┼─────────────────────────┼──────────────────────────┤
│ MEMORY_DB_URL                     │ oc_agent_memory_runtime │ Gateway runtime          │
│ SKILL_DB_URL                      │ oc_skill_reader         │ Skill runtime            │
│ OPENCLAW_MEMORY_MIGRATION_URL     │ existing administrator  │ Single migration command │
└───────────────────────────────────┴─────────────────────────┴──────────────────────────┘
```

`MEMORY_DB_URL` 和 `SKILL_DB_URL` 持久存在于部署 `.env`。`OPENCLAW_MEMORY_MIGRATION_URL` 不持久化。

完整 DSN 只承载 host、port、database、username、password 和连接传输参数。Schema、连接池大小、日志开关等非凭据配置继续保留在应用配置中。

### Dedicated Memory DSN

修改 PostgreSQL memory 配置：

- `src/config/zod-schema.memory-search.ts`：`store.postgres` 使用敏感字段 `url`，删除 `host`、`port`、`database`、`user` 和 `password`。
- `src/agents/memory-search.ts`：resolved config 保存 `url`，删除 `POSTGRES__MEMORY_SCHEMA` 环境变量回退。
- `src/memory/postgres-client.ts`：使用 `postgres(config.url, options)` 创建连接。
- `src/config/schema.help.ts`、`src/config/schema.labels.ts`：删除旧连接字段说明，增加 `url` 说明。
- 相关配置和 memory tests 改为完整 DSN。

目标配置：

```json5
{
  driver: "postgres",
  postgres: {
    url: "${MEMORY_DB_URL}",
    schema: "agent_memory",
    poolMax: 10,
    echo: false,
  },
}
```

不保留旧分字段连接配置兼容。缺少或无法解析 `MEMORY_DB_URL` 时，PostgreSQL memory 初始化必须失败并输出明确错误。

### Dedicated Skill DSN

修改 DepMap 和 TCGA/CPTAC 查询路径：

- 连接优先级只保留 CLI `--db-url` 和 `SKILL_DB_URL`。
- 删除 `DEPMAP_DB_URL`、全部 `POSTGRES__*` 和 YAML credential fallback。
- 删除 `POSTGRES__SKILL_SCHEMA`，schema 使用 Skill 配置中的固定值，默认 `skill_database`。
- `.env.depmap` 和 `.env.tcga_cptac` 只允许覆盖 `SKILL_DB_URL`。
- 同步更新 Skill `SKILL.md`、README、YAML 注释、错误信息和相关测试。

`SKILL_DB_URL` 缺失时查询脚本必须退出，不得尝试使用 Memory 或 migration 凭据。

### Runtime Validation

新增 PostgreSQL memory schema 只读验证模块，供 Gateway 和普通 memory CLI 使用：

- 检查 `vector`、`pg_trgm` 扩展是否存在。
- 检查四张表和必要列是否存在。
- 检查必要列的类型、默认值和非空约束是否符合当前代码要求。
- 检查当前 embedding 维度是否存在兼容 HNSW 索引。
- 缺失或不兼容时返回稳定错误码和迁移命令。

第一阶段不读取 migration version 或 checksum。运行期只根据数据库实际结构判断是否兼容，不得调用迁移实现。

### Explicit Migration CLI

建议命令：

```bash
OPENCLAW_MEMORY_MIGRATION_URL='<admin-dsn>' \
openclaw memory postgres migrate --schema agent_memory --vector-dims 1024
```

辅助命令：

```bash
openclaw memory postgres status --schema agent_memory

OPENCLAW_MEMORY_MIGRATION_URL='<admin-dsn>' \
openclaw memory postgres migrate --schema agent_memory --vector-dims 1024 --dry-run
```

约束：

- `OPENCLAW_MEMORY_MIGRATION_URL` 必须显式存在。
- 禁止回退到运行期 `MEMORY_DB_URL`。
- 禁止回退到 `SKILL_DB_URL`。
- 禁止读取旧 `POSTGRES__*` 或 `DEPMAP_DB_URL`。
- 密码不作为 CLI 参数传入。
- 启用 vector 的空库必须通过 `--vector-dims <number>` 显式提供预期 embedding 维度，以便首次同步前创建对应 HNSW 索引。
- 单次 CLI 进程内按 host、database、schema 去重，只执行一次。
- 第一阶段不获取 migration advisory lock。
- 第一阶段不创建 migration 记录表，不记录 migration version 和 checksum。
- 同一 host、database、schema 的 migration 必须由运维侧串行执行。
- 可事务化步骤必须在事务中执行。
- HNSW 索引创建失败时 CLI 必须失败，迁移后的结构验证不得通过。
- 重复执行同一 migration 必须安全。
- migration 完成后必须执行严格结构验证。
- Gateway 不读取 `OPENCLAW_MEMORY_MIGRATION_URL`。

现有管理员账号只在执行 CLI 时临时提供凭据。它不属于 OpenClaw 的两个运行账号。

## Database Changes

以下 SQL 由现有数据库管理员账号执行。密码必须通过可信密码生成器产生，不写入脚本、Git 或命令历史。

### Phase 1: Preflight

```sql
SELECT extname
FROM pg_extension
WHERE extname IN ('vector', 'pg_trgm');

SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname IN ('agent_memory', 'skill_database');

SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('agent_memory', 'skill_database')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY n.nspname, c.relname;
```

前置条件：

- `vector` 已安装。当前实查版本为 `0.8.3`。
- `pg_trgm` 已安装。当前实查版本为 `1.6`。
- `agent_memory` 已存在。
- `index_meta`、`files`、`chunks`、`embedding_cache` 已存在。
- Memory 所需的普通索引、trigram 索引和 HNSW 索引已存在。

### Phase 2: Create Login Roles

```sql
CREATE ROLE oc_agent_memory_runtime
  LOGIN
  PASSWORD '<generated-secret>'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  INHERIT;

CREATE ROLE oc_skill_reader
  LOGIN
  PASSWORD '<generated-secret>'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  INHERIT;
```

不要把两个账号加入任何现有业务角色。

### Phase 3: Configure Memory Runtime Access

```sql
GRANT CONNECT ON DATABASE agent TO oc_agent_memory_runtime;
GRANT USAGE ON SCHEMA agent_memory TO oc_agent_memory_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA agent_memory
  TO oc_agent_memory_runtime;

ALTER ROLE oc_agent_memory_runtime
  IN DATABASE agent
  SET search_path = agent_memory, pg_catalog;

ALTER ROLE oc_agent_memory_runtime
  IN DATABASE agent
  SET statement_timeout = '120s';

ALTER ROLE oc_agent_memory_runtime
  IN DATABASE agent
  SET idle_in_transaction_session_timeout = '60s';
```

不要向该账号授予：

- `skill_database` 的 `USAGE`。
- `public` 业务表权限。
- 数据库级 `CREATE`。
- 其他数据库对象权限。
- 任何 schema 或表的 owner 身份。
- `CREATE`、`ALTER`、`DROP`、`TRUNCATE`、`REFERENCES`、`TRIGGER`。
- 任何 `GRANT OPTION`。

### Phase 4: Configure Skill Read-Only Access

```sql
GRANT CONNECT ON DATABASE agent TO oc_skill_reader;
GRANT USAGE ON SCHEMA skill_database TO oc_skill_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA skill_database TO oc_skill_reader;

ALTER DEFAULT PRIVILEGES
FOR ROLE otr_admin
IN SCHEMA skill_database
GRANT SELECT ON TABLES TO oc_skill_reader;

ALTER ROLE oc_skill_reader
  IN DATABASE agent
  SET search_path = skill_database, pg_catalog;

ALTER ROLE oc_skill_reader
  IN DATABASE agent
  SET default_transaction_read_only = on;

ALTER ROLE oc_skill_reader
  IN DATABASE agent
  SET statement_timeout = '120s';

ALTER ROLE oc_skill_reader
  IN DATABASE agent
  SET idle_in_transaction_session_timeout = '30s';
```

如果未来由 `otr_admin` 之外的角色创建 skill 表，必须为每个实际 owner 配置相同的 `ALTER DEFAULT PRIVILEGES`。

## Environment Split

数据库授权验证通过后，修改部署本地文件 `~/.openclaw/.env`：

```dotenv
MEMORY_DB_URL=postgresql://oc_agent_memory_runtime:<url-encoded-memory-secret>@<existing-host>:<existing-port>/agent
SKILL_DB_URL=postgresql://oc_skill_reader:<url-encoded-skill-secret>@<existing-host>:<existing-port>/agent
```

密码包含 `@`、`:`、`/`、`#`、`%` 等字符时，两个 DSN 中都必须进行 URL 编码。

两个运行账号直接作为用户名包含在各自 DSN 中，不新增独立的 username 或 password 变量。

删除 `.env` 中全部 `POSTGRES__*` 和 `DEPMAP_DB_URL`。部署检查必须确认这些旧变量没有通过 systemd、shell profile、workspace `.env.*` 或其他启动脚本重新注入。

同步修改 `openclaw.json`：

```json5
{
  driver: "postgres",
  postgres: {
    url: "${MEMORY_DB_URL}",
    schema: "agent_memory",
    poolMax: 10,
    echo: false,
  },
}
```

`OPENCLAW_MEMORY_MIGRATION_URL` 不得写入 `.env` 或 `openclaw.json`。

## Validation

### Role Metadata

两个账号都应满足：

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname IN ('oc_agent_memory_runtime', 'oc_skill_reader');

SELECT parent.rolname AS inherited_role, child.rolname AS login_role
FROM pg_auth_members m
JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles child ON child.oid = m.member
WHERE child.rolname IN ('oc_agent_memory_runtime', 'oc_skill_reader');
```

第二条查询应返回空集。

### Memory Account

预期成功：

```sql
SELECT count(*) FROM agent_memory.index_meta;
SELECT count(*) FROM agent_memory.files;
SELECT count(*) FROM agent_memory.chunks;
SELECT count(*) FROM agent_memory.embedding_cache;

BEGIN;
UPDATE agent_memory.index_meta
SET updated_at = updated_at
WHERE false;
ROLLBACK;
```

预期失败：

```sql
CREATE TABLE agent_memory.__permission_probe(id integer);
ALTER TABLE agent_memory.chunks ADD COLUMN __permission_probe integer;
TRUNCATE agent_memory.embedding_cache;

SELECT count(*) FROM skill_database.depmap_2025_Q3_clinical;
SELECT count(*) FROM public.users;
```

### Skill Account

预期成功：

```sql
SELECT count(*) FROM skill_database.depmap_2025_Q3_clinical;
SELECT count(*) FROM skill_database.tcga_sample_meta;
```

预期失败：

```sql
INSERT INTO skill_database.depmap_2025_Q3_clinical DEFAULT VALUES;
UPDATE skill_database.depmap_2025_Q3_clinical SET "ModelID" = "ModelID" WHERE false;
DELETE FROM skill_database.depmap_2025_Q3_clinical WHERE false;

SELECT count(*) FROM agent_memory.chunks;
SELECT count(*) FROM public.users;
```

### Application Verification

源代码和数据库权限验证完成后：

1. 使用现有管理员凭据完成数据库结构和授权 preflight。
2. 如需要，通过临时 `OPENCLAW_MEMORY_MIGRATION_URL` 运行显式 migration CLI。
3. 清除当前 shell 中的 `OPENCLAW_MEMORY_MIGRATION_URL`。
4. 使用 `MEMORY_DB_URL` 运行 schema status，确认连接身份为 `oc_agent_memory_runtime` 且只执行读操作。
5. 使用 `SKILL_DB_URL` 分别执行 DepMap 和 TCGA/CPTAC 查询，确认连接身份为 `oc_skill_reader`。
6. 临时清除 `MEMORY_DB_URL`，确认 PostgreSQL memory 明确失败且不读取其他数据库变量。
7. 临时清除 `SKILL_DB_URL`，确认 Skill 查询明确失败且不读取其他数据库变量。
8. 设置伪造的旧 `POSTGRES__*` 和 `DEPMAP_DB_URL`，确认 Memory 和 Skill 均不读取。
9. 恢复专用 DSN 后获得用户明确确认。
10. 重启 OpenClaw Gateway，使新的 `.env` 和 `openclaw.json` 生效。
11. 检查 `openclaw-gateway.service` 状态。
12. 执行一次 memory search。
13. 触发一次 memory sync，确认四张表可以更新。
14. 再次执行 DepMap 和 TCGA/CPTAC 查询。
15. 复查数据库连接中的 `current_user`，确认 memory 使用 `oc_agent_memory_runtime`，Skill 使用 `oc_skill_reader`。
16. 检查日志中不存在 permission denied、schema validation 或连接错误。

还必须验证 Gateway 启动期间没有执行：

- `CREATE SCHEMA`
- `CREATE EXTENSION`
- `CREATE TABLE`
- `ALTER TABLE`
- `CREATE INDEX`

## Residual Risks

### Skill Schema 内部仍未隔离

`oc_skill_reader` 可以读取 `skill_database` 中全部 41 张表。DepMap 可以读取 TCGA/CPTAC 数据。该问题需要后续拆分为 `skill_depmap`、`skill_tcga_cptac` 等 schema。

### 凭据仍位于同一进程和文件

`MEMORY_DB_URL` 和 `SKILL_DB_URL` 都保存在 `~/.openclaw/.env`。当前 host exec 会继承 Gateway 环境，并且同一 Unix 用户可以读取该文件。本阶段只能防止代码因回退逻辑误用账号，无法抵御主动读取凭据。

后续需要把数据库访问移入独立服务或 sandbox，并停止向 Agent host exec 暴露数据库凭据。

### 数据库服务化留到后续阶段

长期方案应将 Memory 和 Skill 数据操作封装为边界明确的服务接口，使 Agent 只能调用受限查询和写入操作，不能直接获得数据库凭据或执行任意 SQL。

服务化不能只依赖一个共享 API key 加调用方提交的 Open User ID。API key 只能证明调用方持有该密钥，调用参数中的 Open User ID 不能直接作为授权依据。否则调用方可以替换该 ID，读取其他用户的数据。

后续服务必须满足：

- 服务端根据可信身份映射或签名声明确定用户范围。
- 调用方提交的用户 ID 必须与服务端授权范围一致。
- 每次查询都强制附加 owner、tenant 或 agent 范围条件。
- 禁止通过请求参数绕过资源归属检查。
- Memory 和 Skill 分别暴露有限操作，不提供通用 SQL 执行接口。
- 记录调用身份、目标用户、操作类型和结果状态，支持审计。

第一阶段仍由 Gateway 和 Skill 脚本直接连接 PostgreSQL。本计划通过数据库账号分流降低越界范围，不解决同一 Unix 用户主动读取 `.env` 或伪造应用层身份的问题。

### 其他数据库仍有 PUBLIC CONNECT

当前 PostgreSQL 数据库 ACL 向 `PUBLIC` 授予 `CONNECT` 和 `TEMPORARY`。新账号可能仍可建立到其他数据库的连接，但没有对应业务表权限。

严格禁止连接其他数据库需要撤销数据库级 `PUBLIC CONNECT`，再显式为全部合法应用账号授权。该操作影响范围较大，不纳入第一阶段。

### 迁移仍使用现有管理员身份

第一阶段不新增 migrator 登录账号。现有管理员凭据通过 `OPENCLAW_MEMORY_MIGRATION_URL` 临时注入 CLI。必须确保该变量不进入 Gateway service 环境、不写入 `.env`、日志或 Git。

### 迁移并发和历史暂不追踪

第一阶段不使用 migration advisory lock，也不保存 migration version 和 checksum。因此：

- 同一个 host、database、schema 不得并发执行 migration CLI。
- 无法从数据库中查询已执行 migration 的顺序和历史。
- 无法发现已执行 migration 的 SQL 后续被修改。
- 中断恢复依赖幂等 DDL、数据条件和严格结构验证。
- 数据库结构领先于当前代码时，只能通过结构验证发现不兼容，无法通过版本号判断。

当出现第二次独立结构变更、非事务迁移、在线迁移或多实例自动部署时，再引入 schema 级 advisory lock、migration 记录表、version 和 checksum。

## Success Criteria

- [ ] OpenClaw memory 使用 `oc_agent_memory_runtime`。
- [ ] DepMap、TCGA/CPTAC 使用 `oc_skill_reader`。
- [ ] 两个账号均无业务角色继承。
- [ ] Memory 只读取 `MEMORY_DB_URL`。
- [ ] Skill 查询只读取 `SKILL_DB_URL` 或显式 CLI `--db-url`。
- [ ] 运行期代码不读取任何 `POSTGRES__*`。
- [ ] Skill 代码不读取 `DEPMAP_DB_URL`。
- [ ] 缺少专用 DSN 时对应功能失败且不回退。
- [ ] Gateway 启动和运行期间不执行 PostgreSQL DDL。
- [ ] Migration CLI 缺少 `OPENCLAW_MEMORY_MIGRATION_URL` 时失败。
- [ ] Migration CLI 不回退到 `MEMORY_DB_URL` 或 `SKILL_DB_URL`。
- [ ] Migration CLI 不读取旧 `POSTGRES__*` 或 `DEPMAP_DB_URL`。
- [ ] 启用 vector 的空库缺少 `--vector-dims` 时 migration 失败；提供维度时首次 migration 创建对应 HNSW 索引。
- [ ] `OPENCLAW_MEMORY_MIGRATION_URL` 不存在于部署 `.env` 和 Gateway 环境。
- [ ] Memory 检索和同步正常。
- [ ] Skill 查询正常。
- [ ] Memory 账号不能读取 `skill_database` 和 `public` 业务表。
- [ ] Skill 账号不能读取或修改 `agent_memory`。
- [ ] Skill 账号不能修改 `skill_database`。
- [ ] Memory runtime 不能 CREATE、ALTER、DROP 或 TRUNCATE `agent_memory` 对象。
- [ ] `guo_jiao` 不再出现在 OpenClaw PostgreSQL 连接中。
