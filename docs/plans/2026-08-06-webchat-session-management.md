# Implementation Plan: WebChat 会话管理

## Overview

在现有 WebChat 多会话能力上增加分组、分组颜色、会话重命名、会话移动和会话删除。方案保持现有三层边界：OpenClaw Gateway 继续拥有运行时会话、活动任务、队列和 transcript；agent-server BFF 继续负责浏览器身份、租户/用户/目标隔离，并新增用户侧分组元数据与删除状态；agent-frontend 只消费脱敏后的 `clientSessionId` 和管理协议。

本方案不把用户分组写入 OpenClaw `sessions.json`，也不向浏览器开放 `operator.admin`。OpenClaw 侧新增两个仅供可信 backend client 使用的窄方法，复用已有 `sessions.patch` 和 `sessions.delete` 的底层实现。会话标题写入新增的 `SessionEntry.title` 字段，不占用 `label`：label 是全局唯一的 CLI 寻址别名（参与 `sessions.resolve`、`sessions_send(label=...)` 和 search），其唯一性与解析语义保持不变（见 ADR-0007）。

## Human-approved Amendments

- 2026-08-10：用户明确要求新建分组默认显示在分组列表最上方，未分组区域固定显示在所有分组之后；该要求覆盖本计划原有的“未分组置顶”规则。

## Interview Decisions (2026-08-07)

以下决策来自 2026-08-07 计划访谈，已并入正文相应章节：

1. **跨 tab/设备同步**：首版仅刷新感知，不做 BFF 主动推送或前端轮询。其他 tab 通过刷新列表或 send 报 `SESSION_DELETED` 感知变更。
2. **catalog 失败降级**：catalog 全量拉取超时/失败时复用未过期缓存；无可用缓存时返回 groups 但 count 字段为 null，前端不显示计数；catalog 失败不得阻塞会话主列表。
3. **rename 作用于未持久化会话**：与 move 一致，服务端拒绝并返回 `SESSION_NOT_PERSISTED`；只有 Gateway 已有 entry 的父会话可 rename/move。
4. **上游能力探测**：hello.methods 的管理方法声明是静态 flag（`gateway_session_management_enabled`），不探测上游 Gateway 方法；靠发布顺序（先 Gateway 后 agent-server）保证，乱序部署时 rename/delete 调用会失败属已接受边界。
5. **tombstone 检查**：`chat.send` 热路径每次查 `openclaw_managed_sessions` 表（索引查询），不做连接级缓存或 TTL 缓存，保证拦截语义的强一致。
6. **deleting 呈现**：`deleting`/`deleted` 会话在 list enrichment 时直接过滤，不出现在会话列表，也不计入 group counts 和 `ungroupedCount`。
7. **reconciliation 竞态防护**：catalog 快照带时间戳；只物理删除 `create_time` 早于快照时间且不在快照中的 active 行，防止刚 move 的归属被过期快照误删。
8. **错误码契约**：新错误码常量集中定义在 `agent-server/app/common/constants/openclaw_session.py`；前端 `types.ts` 镜像 code 集合，展示文案由前端按 code 映射。
9. **Foreign Run 收尾**：删除会话停止 active run 时，共享 delete helper 广播 `chat { state: "aborted", stopReason: "session_deleted" }`（复用 `abortChatRunsForSessionKey` 的广播机制），admin delete 与窄 delete 统一生效；BFF 原样过滤翻译，Foreign Run 所在 tab 走现有 aborted 处理收尾。注意：现有 `sessions.delete` 走 `abortEmbeddedPiRun` 并不广播 chat 事件，该广播是新增行为，需确认 Control UI 的 aborted 处理兼容并由测试锁定。`Degraded` 仅表示上游断连结果未知，不复用；不新增事件类型。

推断假设（未单独确认，实现时按此执行）：

- 同 scope 并发 move/rename 采用 last-write-wins，不做乐观锁。
- 分组内会话按 `updatedAt` 排序；move 不修改 Gateway entry，不会导致会话在列表中冒泡。

## Current State And Evidence

### Existing end-to-end path

```text
agent-frontend
  -> BFF WebSocket bridge.connect(targetKind, targetId, clientSessionId)
  -> agent-server OpenClawScopeResolver
  -> namespace = hash(tenant + effective user + target)
  -> Gateway session key = agent:<agentId>:webchat:<namespace>:<clientSessionId>
  -> OpenClaw sessions.json entry + <sessionId>.jsonl transcript
```

- `agent-frontend/src/features/openclaw-bff/hooks/useOpenClawSessions.ts` 已支持会话列表、分页、本地新会话和切换。
- `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawSessionSidebar.tsx` 当前只渲染平铺列表，没有管理动作。
- `agent-server/app/services/openclaw_scope_resolver.py` 已按租户、用户和 target 构造 namespace，并验证 direct/group target 权限。
- `agent-server/app/services/openclaw_protocol_translator.py` 已将 `sessions.list` 限定到当前 `agentId + keyPrefix`，并把真实 Gateway key 翻译回 `clientSessionId`。
- `agent-server/app/common/constants/openclaw_gateway.py` 的浏览器方法 allowlist 当前不包含任何 session 写方法。
- `agent-server/app/infra/openclaw/gateway_client_adapter.py` 当前只申请 `operator.read` 和 `operator.write`。
- `openclaw-integration/src/gateway/server-methods/sessions.ts` 已实现 `sessions.patch`、`sessions.reset` 和 `sessions.delete`。
- `openclaw-integration/src/gateway/method-scopes.ts` 将 `sessions.patch/delete` 归入 `operator.admin`。
- `sessions.delete` 已负责清理队列、停止 active run、归档 transcript 和解除生命周期绑定；计划必须复用该语义。其行为已核实：active run 15 秒内无法停止时返回 `UNAVAILABLE` 且不删 store/transcript；重复删除返回 `deleted=false`；transcript 归档 reason 为 `deleted`；main session 被拒绝。
- `applySessionsPatchToStore()`（`src/gateway/sessions-patch.ts:140`）对 label 执行全 store 唯一性检查（重复即 `label already in use`）；label 同时被 `sessions.resolve`、`sessions_send(label=...)` 用作寻址并参与 search。label 是全局唯一 CLI 别名，不能承载可重复的用户标题。
- `SessionEntry` 当前没有 title 字段；`displayName` 是 channel 群组元数据派生值（`buildGroupDisplayName`），不可挪用为用户标题。
- Gateway `sessions.list` 已支持 `limit/offset/keyPrefix/agentId/includeDerivedTitles/includeLastMessage` 等参数；不传 `limit` 返回全量；`include*` 关闭时不读 transcript（catalog 方案的前提成立）。
- WebChat parent key 形状谓词 `isParentWebchatSessionKey()` 已存在（`src/agents/session-surface.ts`，ADR-0005），五段 `agent:{agentId}:webchat:{namespace}:{clientSessionId}` 判定。
- Gateway 端存在 `GATEWAY_CLIENT_MODES.BACKEND`（`src/gateway/protocol/client-info.ts:26`）；agent-server 已以 `mode=backend`、`role=operator`、`scopes=(operator.read, operator.write)` 连接（`OPENCLAW_GATEWAY_CLIENT_MODE='backend'`）。
- agent-server 已有能力开关先例：`bff_subagents_enabled` 是 `OpenClawSettings` 上的 bool flag，经 `OpenClawProtocolTranslator.allowed_methods(subagents_enabled=...)` 条件合并进 `binding.methods`，再由 `_send_bridge_hello()` 序列化。注：attachment 方法虽也走 `allowed_methods(artifacts_enabled=...)`，但 `artifacts_enabled` 是 `OpenClawBridgeBinding` 上由存储可用性驱动的运行时字段，非 settings 配置项；本计划的 kill-switch 对齐前者（settings flag）而非后者。
- scope namespace = `sha256(tenant_key:principal_id:target_kind:target_id)[:16]`，16 个 hex 字符（`app/common/utils/openclaw_scope.py`），`VARCHAR(16)` 精确匹配；namespace 含 effective user，group target 下不同成员的分组数据天然隔离。
- BFF `gateway_request_timeout_seconds` 默认 30 秒，大于 Gateway 删除路径 15 秒 active-run 等待。
- agent-server migrations 当前最新为 `013_add_openclaw_input_artifacts.py`，新建 014 编号正确。

### Confirmed gaps

1. 浏览器无法重命名或删除会话，BFF 也没有受限写协议。
2. OpenClaw 没有用户自定义会话分组、颜色和排序模型。
3. 当前前端标题优先级为 `derivedTitle -> title -> label -> displayName`；写入 OpenClaw `label` 后仍可能显示旧 derived title。
4. 当前会话列表分页只返回已加载页，无法仅凭前端已加载行计算准确分组计数。
5. 会话删除与 agent-server 分组元数据之间没有跨存储一致性状态。
6. 删除 transcript 不等于删除 agent-server artifact 元数据或 OSS 对象，确认文案必须区分“文件引用”和“文件本体”。
7. OpenClaw 没有独立于 label 的用户标题字段；直接写 label 会与其全局唯一别名语义冲突（跨用户重名失败并泄露标题存在性）。本计划以新增 `SessionEntry.title` 消除该冲突。

## Requirements

### Functional requirements

- 会话行 hover 或聚焦时显示上下文菜单。
- 已持久化会话支持重命名、移动到分组和删除。
- 支持创建分组，并可在创建时把当前会话移入新分组。
- 支持分组改名、修改颜色和删除。
- 删除分组时将其会话移动到“未分组”，不得删除会话。
- 分组可展开/收起，并显示准确会话数。
- 分组顺序、名称、颜色和会话归属在刷新、重新登录和切换设备后保留。
- 删除会话时停止活动任务、清理队列、归档 transcript，并从会话列表消失。
- 删除当前会话成功后自动创建并切换到新的本地会话。
- 删除、重命名和移动操作必须具有幂等结果或可安全重试语义。
- direct target 与每个 group target 的分组数据完全隔离。

### Security requirements

- 浏览器只能提交 `clientSessionId`，不得提交真实 Gateway session key、agent id 或 namespace。
- BFF 必须从已授权 binding 重新计算目标 Gateway key。
- 管理操作只能作用于当前 binding 的同一 namespace 下的父 WebChat 会话。
- 子会话、Feishu、cron、main、heartbeat 和其他 channel session 必须被拒绝。
- 浏览器不获得 `operator.admin`，agent-server 上游 client 也不扩大为通用 admin client。
- 日志和 trace 不记录真实 session key、namespace、principal id、文件名或 artifact id。

### Consistency requirements

- OpenClaw 是会话是否存在、活动运行和 transcript 的 source of truth。
- agent-server 是分组、颜色、顺序和删除协调状态的 source of truth。
- `sessions.list` 的 Gateway 结果必须先完成 namespace 过滤，再与 agent-server 元数据合并。
- Gateway 请求超时视为结果不确定；不能立即把 `deleting` 回滚为 `active`。
- 对结果不确定的删除，通过 `sessions.list` 重新确认目标会话是否仍存在。

## Non-Goals

- 不把会话分组同步到 OpenClaw Control UI、CLI、macOS、iOS 或 Android 客户端。
- 不允许管理 Feishu 或其他 channel 的会话。
- 不实现跨 target 的分组或会话移动。
- 不实现拖拽排序；首版使用明确的 `sortOrder`，UI 可后续增加拖拽入口。
- 不永久删除 READY INPUT artifact、OUTPUT artifact 或 OSS 对象。
- 不改变现有附件上传、历史 enrichment、云盘和下载授权协议。
- 不在本计划中执行 Gateway 重启、数据库迁移或生产发布。
- 不做跨 tab/设备的实时变更推送；其他 tab 通过刷新列表或 send 报 `SESSION_DELETED` 感知（首版仅刷新感知）。
- 不在 hello 阶段探测上游 Gateway 方法能力；管理方法声明是静态 flag，乱序部署时调用失败属已接受边界。
- 不在 v1 引入 backend client id 白名单配置；`webchat.sessions.rename/delete` 只校验 `client.mode=backend`，client id 白名单推迟到后续安全强化。
- 不引入后台删除对账 sweeper；`deleting` 状态只由下一次同 scope `sessions.list` 懒对账收敛。

## Interview Resolved Decisions

- **Kill-switch 与 capability 声明位置**：在 `OpenClawSettings` 增加 `gateway_session_management_enabled: bool = True`（对齐 `bff_subagents_enabled` 的 settings flag 先例，**不**沿用 `artifacts_enabled`——后者是 `OpenClawBridgeBinding` 上由存储可用性驱动的运行时字段，非 settings 配置项）。通过 container 注入 `OpenClawBridgeService`；`bind()` 在 flag 为 true 时把管理方法并入 `binding.methods`；`OpenClawBridgeRequestService.execute()` 对本地管理方法校验其存在于 `binding.methods`（声明即授权，避免声明态与执行态分叉）；`_send_bridge_hello()` 只序列化 `binding.methods`，不自行补充能力。不新增 binding bool、不做双开关。
- **Catalog 缓存与计数一致性**：`sessionGroups.create/patch/delete`、`sessions.move/delete/rename` 成功后立即失效或后台刷新 scope catalog 缓存，使下一次 `sessions.list` 返回准确计数；不依赖 TTL 自然过期。
- **Reset 的 title 保留**：`sessions.reset` 必须把 `title` 加入重建 `SessionEntry` 的保留字段列表，重命名后的会话 reset 不丢标题（覆盖 ADR-0007 接受的边界）。
- **前端标题优先级**：新顺序为 `title -> derivedTitle -> label -> displayName`，只把用户新设的 `title` 提到首位；`derivedTitle` 与 `label` 的原有相对顺序不变，避免现有设过 label 的会话展示突变。
- **DropdownMenu 原语缺口**：`src/components/ui/dropdown-menu.tsx` 当前只导出 `Trigger/Content/RadioGroup/RadioItem`，会话行菜单需要的 `Item/Separator` 在共享 barrel 内补齐后再复用。
- **删除对账策略**：仅懒对账（下次 `sessions.list`），无后台 sweeper；`deleting` tombstone 在用户不再触发 list 时会暂时保留，仅造成 DB 行计数压力，不影响正确性。
- **并发建组 sortOrder**：允许并发 `sessionGroups.create` 拿到相同 `sort_order`（唯一约束只在 `normalized_name`）；list 按 `(sort_order, create_time)` 二级排序稳定输出。
- **backend client 授权**：v1 只校验 `client.mode=backend`（复用 `normalizeGatewayClientMode(...) === GATEWAY_CLIENT_MODES.BACKEND`），不新增白名单配置。

## Architecture Decisions

### 1. Data ownership

| Data                                       | Source of truth    | Reason                                                                       |
| ------------------------------------------ | ------------------ | ---------------------------------------------------------------------------- |
| Gateway session key、session id、updatedAt | OpenClaw           | 运行时路由与 session store 已存在                                            |
| transcript 与 active run                   | OpenClaw           | 删除前必须停止执行并归档 transcript                                          |
| session title（用户标题）                  | OpenClaw           | 新增 `SessionEntry.title`；`label` 保持全局唯一 CLI 别名语义不变（ADR-0007） |
| 分组名称、颜色、排序                       | agent-server       | 属于用户和 target 范围内的 UI 元数据                                         |
| 会话到分组的归属                           | agent-server       | OpenClaw 没有对应领域模型                                                    |
| 删除协调状态                               | agent-server       | 需要跨 PostgreSQL 与 Gateway 处理不确定结果                                  |
| artifact 元数据与 OSS 对象                 | agent-server / OSS | 生命周期独立于 transcript                                                    |

### 2. Agent-server persistence model

新增 migration `agent-server/migrations/versions/014_add_openclaw_session_management.py`。

#### `openclaw_session_groups`

| Column            | Type              | Constraint                         |
| ----------------- | ----------------- | ---------------------------------- |
| `id`              | `VARCHAR(36)`     | primary key，使用现有 `gen_id()`   |
| `principal_id`    | `VARCHAR(36)`     | not null                           |
| `target_kind`     | `VARCHAR(16)`     | not null，`direct/group`           |
| `target_id`       | `VARCHAR(255)`    | not null                           |
| `scope_namespace` | `VARCHAR(16)`     | not null，沿用现有 scope namespace |
| `name`            | `VARCHAR(64)`     | not null，trim 后非空              |
| `normalized_name` | `VARCHAR(64)`     | not null，用于同 scope 唯一性      |
| `color`           | `VARCHAR(16)`     | not null，固定 palette             |
| `sort_order`      | `INTEGER`         | not null，默认 0                   |
| `create_time`     | timezone datetime | not null                           |
| `update_time`     | timezone datetime | not null                           |

约束与索引：

- unique: `(scope_namespace, normalized_name)`。
- index: `(scope_namespace, sort_order, create_time)`。
- palette 常量定义在 `agent-server/app/common/constants/openclaw_session.py`，建议值为 `blue/orange/green/red/indigo/violet/slate`。
- 每个 scope 分组数上限 50，超限 create 返回明确错误。
- 新建分组 `sort_order` = 同 scope 现有最大值 + 10（首个为 10）；`sessionGroups.patch` 可显式覆盖。

#### `openclaw_managed_sessions`

| Column                | Type              | Constraint                                            |
| --------------------- | ----------------- | ----------------------------------------------------- |
| `id`                  | `VARCHAR(36)`     | primary key                                           |
| `principal_id`        | `VARCHAR(36)`     | not null                                              |
| `target_kind`         | `VARCHAR(16)`     | not null                                              |
| `target_id`           | `VARCHAR(255)`    | not null                                              |
| `scope_namespace`     | `VARCHAR(16)`     | not null                                              |
| `client_session_id`   | `VARCHAR(128)`    | not null，对齐 `openclaw_artifacts.client_session_id` |
| `group_id`            | `VARCHAR(36)`     | nullable，FK `ON DELETE SET NULL`                     |
| `status`              | `VARCHAR(16)`     | `active/deleting/deleted`                             |
| `delete_requested_at` | timezone datetime | nullable                                              |
| `deleted_at`          | timezone datetime | nullable                                              |
| `last_seen_at`        | timezone datetime | nullable                                              |
| `create_time`         | timezone datetime | not null                                              |
| `update_time`         | timezone datetime | not null                                              |

约束与索引：

- unique: `(scope_namespace, client_session_id)`。
- index: `(scope_namespace, status, group_id)`。
- service 层必须同时校验 group 与 session 的 `scope_namespace`，不能只依赖全局 UUID。

行生命周期（lazy 模型）：

- 行只在 `sessions.move`（移入分组）或 `sessions.delete`（置 `deleting`）时 upsert 创建；rename 不落 DB。
- 从未被分组或删除过的会话没有行；`ungroupedCount = catalog 活会话总数 - 已分配活会话数`。
- catalog reconciliation 对 `status=active` 但 catalog 中已不存在的行执行物理删除（其分组归属随之消失）；`status=deleted` 的 tombstone 行永久保留、首版不做 GC——tombstone 是拦截旧 tab `chat.send` 防止同 key 重建的安全依据，量级仅为被删除会话数，未来并入统一 retention 再处理。

`openclaw_managed_sessions` 不复制 `title` 和 `updatedAt`。标题继续来自 OpenClaw `title/derivedTitle`，避免双写标题。

### 3. Browser-facing BFF protocol

浏览器 hello 的 `methods` 增加以下能力；未声明时前端隐藏对应入口。

#### `sessionGroups.create`

```json
{
  "name": "PROTAC 系列",
  "color": "green",
  "moveClientSessionId": "chat_xxx"
}
```

`moveClientSessionId` 可选，只允许已持久化父会话。同 scope 分组数达到上限 50 时返回明确错误。

#### `sessionGroups.patch`

```json
{
  "groupId": "uuid",
  "name": "新名称",
  "color": "violet",
  "sortOrder": 20
}
```

按字段是否显式出现执行部分更新，不使用 `None` 推断更新意图。

#### `sessionGroups.delete`

```json
{ "groupId": "uuid" }
```

在同一数据库事务中将关联 session 的 `group_id` 置空，再删除 group。返回被解除关联的会话数量。

#### `sessions.move`

```json
{
  "clientSessionId": "chat_xxx",
  "groupId": "uuid"
}
```

`groupId=null` 表示移动到未分组。

#### `sessions.rename`

```json
{
  "clientSessionId": "chat_xxx",
  "title": "MKN1/2 选择性优化"
}
```

- `title` trim 后长度为 1-64（OpenClaw 侧新增 `SESSION_TITLE_MAX_LENGTH = 64`，与 label 上限同值但为独立常量）。
- title 不要求唯一：不同用户、不同会话可以同名，写入 `SessionEntry.title` 而非 `label`。
- BFF 将该请求改写成上游 `webchat.sessions.rename({key, title})`，浏览器看不到真实 key。
- 只允许已持久化父会话：Gateway 尚无 entry 的本地新会话调用 rename 返回 `SESSION_NOT_PERSISTED`，与 move 的持久化要求一致；前端对本地新会话隐藏 rename/move/delete 入口。
- 首版不提供“清除标题恢复 derived title”入口，schema 要求非空字符串。

#### `sessions.delete`

```json
{ "clientSessionId": "chat_xxx" }
```

- 不向浏览器暴露 `deleteTranscript` 和 `emitLifecycleHooks`。
- 上游始终使用 `deleteTranscript=true` 和标准 lifecycle hooks。

#### Extended `sessions.list` response

```json
{
  "sessions": [
    {
      "key": "chat_xxx",
      "title": "MKN1/2 选择性优化",
      "label": null,
      "derivedTitle": "原始首条消息",
      "updatedAt": 1780000000000,
      "groupId": "uuid"
    }
  ],
  "groups": [
    {
      "groupId": "uuid",
      "name": "PROTAC 系列",
      "color": "green",
      "sortOrder": 20,
      "sessionCount": 2
    }
  ],
  "ungroupedCount": 3,
  "nextOffset": 50,
  "hasMore": true
}
```

前端标题优先级固定为：

```text
title -> derivedTitle -> label -> displayName -> 历史会话
```

只把用户新设的 `title` 提到首位；`derivedTitle` 与 `label` 的相对顺序沿用现状，避免现有设过 label 的会话展示翻转。

前端按 `sortOrder` 降序渲染分组，使 `sort_order = max + 10` 的新建分组默认置顶；相同 `sortOrder` 时按 BFF 返回顺序反向显示较新的分组；未分组区域固定渲染在所有分组之后。

### 4. Exact group counts with pagination

前端已加载页不能作为 group count 数据源。agent-server 在管理功能启用时维护一个短期 scope catalog：

1. 正常 `sessions.list(limit=50, includeDerivedTitles=true)` 获取当前页面。
2. 首次请求或 cache 过期时，额外调用一次同 scope 的 `sessions.list`，不传 `limit`，且 `includeDerivedTitles=false/includeLastMessage=false`。
3. BFF translator 继续强制 `agentId` 和 `keyPrefix`，catalog 只含当前 scope 的会话。
4. 用 catalog 的 live `clientSessionId` 集合更新 `last_seen_at`，并忽略/清理已不存在会话的过期 active assignment。
5. group counts 仅对 catalog 中存在且状态为 active 的 session 计数；`deleting`/`deleted` 会话不计入 group counts 和 `ungroupedCount`；`ungroupedCount = live session total - live assigned total`。
6. catalog 快照带时间戳：reconciliation 只物理删除 `create_time` 早于快照时间且不在快照中的 active 行，防止过期快照把刚 move 创建的归属行误删。

catalog cache 建议 10-30 秒，key 为 `scope_namespace`。记录 count、刷新耗时和 cache hit，不记录 session id。若实际规模或延迟不满足门槛，再单独增加 Gateway 的轻量 catalog 方法；首版不先扩展新 read method。

catalog 拉取超时或失败时的降级路径：优先复用未过期缓存；无可用缓存时正常返回分页会话列表和 groups，但 group `sessionCount` 与 `ungroupedCount` 为 null，前端不显示计数；catalog 失败不得使整个 `sessions.list` 报错。

**Mutation 失效**：`sessionGroups.create/patch/delete`、`sessions.move/delete/rename` 成功后立即标记对应 `scope_namespace` 的 catalog cache stale 或触发一次后台刷新，使下一次 `sessions.list` 拿到准确计数；不依赖 TTL 自然过期，避免移动/删除后前端在 TTL 内看到旧计数。

### 5. Narrow OpenClaw mutation methods

新增两个 Gateway 方法（三段命名与现有 `agents.files.list`、`exec.approval.request`、`node.pair.request` 先例一致）：

```text
webchat.sessions.rename
webchat.sessions.delete
```

授权规则：

- 放入 `operator.write`，不放入 `operator.admin`。
- 仅允许 `client.mode=backend`：使用 `normalizeGatewayClientMode(client?.connect?.client?.mode) === GATEWAY_CLIENT_MODES.BACKEND` 判定（`GATEWAY_CLIENT_MODES.BACKEND` 已存在；agent-server 已以该 mode 连接）。**v1 不引入 backend client id 白名单**；该强化推迟到后续（见 Non-Goals）。不得只依赖浏览器传入字段。
- key 必须是 canonical WebChat parent session key，判定复用 `isParentWebchatSessionKey()`（`src/agents/session-surface.ts`，ADR-0005 的五段形状谓词），不重新实现 key 解析。
- 拒绝 main、subagent（`agent:{agentId}:subagent:{name}`）、cron（`agent:{agentId}:cron:{jobId}:run:{uuid}`）、Feishu 和其他 channel key。heartbeat 不是独立 key 形状（main key + `heartbeatLease` entry 属性），随 main 拒绝天然覆盖；负例测试按此构造。

实现规则：

- `webchat.sessions.rename` 只允许 `{key, title}`。`SessionsPatchParams` 新增可选 `title` 字段，`applySessionsPatchToStore()` 增加 title 分支（trim 后 1-64，不做唯一性检查；label 分支及其全 store 唯一性检查保持不变），admin `sessions.patch` 与窄方法共用同一 store 更新实现。窄方法 schema 不开放 label、model、thinking、exec 或 send policy 字段。
- `webchat.sessions.delete` 只允许 `{key}`，内部固定 `deleteTranscript=true`，复用现有 runtime cleanup、archive 和 lifecycle unbind 流程。
- 将 `sessions.delete` 的主体提取为内部 helper，避免两个 handler 复制停止运行、清队列和归档逻辑。
- **`sessions.reset` 必须保留 `title`**：`sessions.reset` 当前重建 `SessionEntry` 时保留 `model/label/origin/lastChannel/lastTo/skillsSnapshot`，**必须把 `title` 加入该保留字段列表**，使重命名后的会话 reset 不丢标题（覆盖 ADR-0007 接受的"reset 可能丢弃 title"边界）。补一条 reset-keeps-title 回归测试。
- 现有 admin `sessions.patch/delete` 行为保持兼容。

### 6. Delete state machine

```text
active
  -> deleting
     -> Gateway success/deleted=false after absence confirmation -> deleted
     -> definitive validation/forbidden failure                 -> active
     -> timeout/disconnect                                      -> deleting
        -> reconciliation: Gateway row absent                   -> deleted
        -> reconciliation: Gateway row exists                   -> active or retry
```

删除执行顺序：

1. BFF 校验当前 principal、target、scope、父 session id 和 persisted 状态。
2. PostgreSQL 原子 upsert `status=deleting` 和 `delete_requested_at`。
3. 后续同 scope 的 `chat.send`、`sessions.rename`、`sessions.move` 对该 session 返回 `SESSION_DELETING`；`chat.send` 热路径每次查 `openclaw_managed_sessions` 表（`(scope_namespace, client_session_id)` 唯一索引查询），不做连接级或 TTL 缓存。
4. 调用 `webchat.sessions.delete`。
5. Gateway 停止 active run、清理队列、归档 transcript、删除 store entry、发送 lifecycle unbind。
6. 明确成功后，PostgreSQL 更新 `status=deleted`、`group_id=null` 和 `deleted_at`。
7. 当前 session 被删时，前端创建新随机 `clientSessionId` 并切换。

`deleting`/`deleted` 会话在 list enrichment 时被过滤，不出现在会话列表，也不参与分组计数；用户视角即从列表立即消失。

被删会话存在 active run 且该 run 是另一 tab 发起的 Foreign Run 时：共享 delete helper 停止 run 并广播 `chat { state: "aborted", stopReason: "session_deleted" }`（复用 `abortChatRunsForSessionKey` 的广播机制；现有 `sessions.delete` 走 `abortEmbeddedPiRun` 不广播，此广播为新增行为，admin 与窄 delete 统一生效）；BFF 原样过滤翻译，Foreign Run 所在 tab 使用现有 aborted 处理完成流式收尾。`Degraded` 仅表示 Gateway 上游断连、结果未知，不复用于主动删除；不新增事件类型。

`deleted=false` 表示 Gateway 已无该 entry，可按幂等成功处理。Gateway timeout 或连接中断保留 `deleting`，由下一次 list/显式 retry 调和。

**对账策略（v1）**：仅懒对账——`deleting` 行只在下一次同 scope `sessions.list`（catalog 刷新）时与 Gateway live 集合比对收敛。不引入后台 sweeper。已接受边界：用户删除当前会话后切走、不再触发同 scope list 时，`deleting` tombstone 会暂时保留，仅造成 DB 行计数压力，不影响正确性（tombstone 仍拦截旧 tab 的 `chat.send`）。

超时预算已核实：BFF `gateway_request_timeout_seconds` 默认 30 秒，覆盖 Gateway 内部最长 15 秒的 active-run 停止等待；删除调用无需单独超时配置。active run 15 秒内无法停止时 Gateway 返回 `UNAVAILABLE` 且不删除 store/transcript，BFF 将其按 definitive failure 回 `active`。

删除后的旧 tab：

- BFF 对 tombstone session 的 `chat.send` 返回 `SESSION_DELETED`，防止旧 WebSocket 重新创建同 key。
- `sessions.list` 仍可用，使前端完成刷新和切换。
- 前端收到 `SESSION_DELETING/SESSION_DELETED` 后停止发送并切到新会话。

### 7. Artifact boundary

- OpenClaw transcript 归档后，会话历史不再返回消息和 transcript 内附件引用。
- agent-server 的 session-scoped artifact list 对 `deleted` session 返回空列表或 `SESSION_DELETED`。
- 不级联删除 `openclaw_artifacts` 行或 OSS 对象；用户云盘仍可按既有所有权规则访问保留文件。
- 删除确认文案使用“会话消息及会话内文件引用将被移除”，不得声称 OSS 文件永久删除。
- 永久删除 artifact 属于独立 retention/云盘功能，不能隐含在本会话删除中。

## Architecture Changes

### openclaw-integration

- `src/config/sessions/types.ts`: `SessionEntry` 增加可选 `title` 字段（JSON 序列化自动携带；旧版本读取时忽略未知字段，无迁移）。
- `src/sessions/session-label.ts`（或新增 `session-title.ts`）: 定义 `SESSION_TITLE_MAX_LENGTH = 64` 与 title parse/trim 函数。
- `src/gateway/session-utils.types.ts` + `src/gateway/session-utils.ts`: `GatewaySessionRow` 增加 `title` 并在 `sessions.list` 序列化返回。
- `src/gateway/protocol/schema/sessions.ts`: 增加 WebChat rename/delete 参数 schema（rename 仅 `{key, title}`）；`SessionsPatchParams` 增加可选 `title`。
- `src/gateway/protocol/schema/types.ts`: 导出新参数类型。
- `src/gateway/protocol/index.ts`: 编译并导出 validator。
- `src/gateway/protocol/schema/protocol-schemas.ts`: 注册协议 schema。
- `src/gateway/server-methods-list.ts`: 注册新方法名。
- `src/gateway/method-scopes.ts`: 将新方法映射为 `operator.write`。
- `src/gateway/server-methods/sessions.ts`: 增加 backend-only guard（`normalizeGatewayClientMode(...) === GATEWAY_CLIENT_MODES.BACKEND`）、`isParentWebchatSessionKey()` key guard 和两个 handler；抽取共享 delete helper。共享 helper 停止 active run 时广播 `chat { state: "aborted", stopReason: "session_deleted" }`（复用 `abortChatRunsForSessionKey` 的广播机制；现有 `abortEmbeddedPiRun` 路径不广播，此为新增行为，admin delete 同步生效）。
- `src/gateway/server-methods/sessions.ts` (`sessions.reset` handler): 把 `title` 加入重建 `SessionEntry` 的保留字段列表（当前保留 `model/label/origin/lastChannel/lastTo/skillsSnapshot`），使重命名后的会话 reset 不丢标题。
- `src/gateway/sessions-patch.ts`: 增加 title 分支（无唯一性检查）；继续作为 label/title patch 的唯一 store 更新实现，label 唯一性检查不变。
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`: 覆盖权限、key 类型、active run、归档和幂等删除；补 admin `sessions.patch` 写 title 用例、**`sessions.reset` 保留 title 回归**与 label 唯一性契约回归。
- `src/gateway/method-scopes.test.ts` 或现有等价测试：锁定新方法只能使用 write scope。

### agent-server

- `migrations/versions/014_add_openclaw_session_management.py`: 新建 group 与 managed session 表。
- `app/common/settings/openclaw.py`: 增加 `gateway_session_management_enabled: bool = True`（对齐 `bff_subagents_enabled` 的 settings-flag 先例；**不**沿用 `artifacts_enabled`——后者是 `OpenClawBridgeBinding` 上由存储可用性驱动的运行时字段，非 settings 配置项）。关闭 flag 时回滚即生效，无需回滚部署。
- `app/common/constants/openclaw_session.py`: 定义方法名、颜色、状态、长度、分组上限（50）、sortOrder 步长（10）常量，以及新错误码常量（`SESSION_DELETING`、`SESSION_DELETED`、`SESSION_NOT_PERSISTED`、`GROUP_LIMIT_EXCEEDED` 等）；前端 `types.ts` 镜像该 code 集合，展示文案由前端按 code 映射。
- `app/core/entities/openclaw/session_management.py`: 定义 group、managed session、DTO 和状态枚举。
- `app/common/ports/repository/db/openclaw_session_management_repository.py`: 定义持久化 port。
- `app/infra/repository/db/pos/openclaw_session_management_po.py`: 定义 SQLAlchemy PO。
- `app/infra/repository/db/openclaw_session_management_repository.py`: 实现 scope-safe CRUD、计数和状态迁移。
- `app/services/openclaw_session_management_service.py`: 编排 group CRUD、move、rename、delete、catalog reconciliation 和 list enrichment；**mutation 成功后立即失效/刷新对应 scope 的 catalog cache**。
- `app/services/openclaw_protocol_translator.py`: 增加前端 session id 到真实 WebChat key 的受限改写；继续过滤完整 Gateway key。
- `app/services/openclaw_bridge_request_service.py`: 分发本地管理方法；在 `sessions.list` 翻译后执行 enrichment；在发送前检查 deleting/deleted；**对本地管理方法校验其存在于 `binding.methods`（声明即授权，关闭 flag 时 dispatch 拒绝）**。
- `app/services/openclaw_bridge_service.py`: `bind()` 在 `gateway_session_management_enabled=True` 时把管理方法并入 `binding.methods`（由 container 注入 settings）；**不**在 service/controller 之外另做 capability 合并。
- `app/api/v1/controllers/openclaw_bridge_controller.py`: `_send_bridge_hello()` 只序列化 `binding.methods`，不自行补充管理能力（与现有 hello 组装位置一致——`methods/features/attachments` 均在此组装）。
- `app/services/openclaw_scope_resolver.py`: 将 scope namespace 作为管理服务稳定 scope key，不重新实现 scope 算法。
- `bff_server/container.py`: 在 standalone BFF 最小容器中绑定 repository 和 service，不导入 root Container。
- `bff_server/app_factory.py`: 仅在需要时暴露 service 到 app state；优先通过 request service 构造注入。
- `app/services/openclaw_artifact_service.py`: 对 deleted session 的 session-scoped list/enrichment 应用引用隐藏规则，不改变云盘 ownership。
- `app/test/unit_test/services/test_openclaw_session_management_service.py`: 覆盖业务状态机。
- `app/test/unit_test/infra/repository/test_openclaw_session_management_repository.py`: 覆盖 scope、事务与唯一约束。
- `app/test/unit_test/services/test_openclaw_protocol_translator.py`: 覆盖 sibling session key rewrite 和跨 scope 拒绝。
- `app/test/unit_test/services/test_openclaw_bridge_request_service.py`: 覆盖管理 dispatch、list enrichment 和 deleted send guard。
- `app/test/unit_test/bff_server/test_app_factory.py`: 证明 standalone BFF 仍不加载 root Container 和无关 provider。

### agent-frontend

- `src/utils/openclawBff/types.ts`: 增加 group、管理方法响应和错误类型。
- `src/features/openclaw-bff/types/chat.ts`: 扩展 `OpenClawChatSessionSummary.groupId` 和 group view model。
- `src/features/openclaw-bff/hooks/useOpenClawChat.ts`: 暴露 rename/delete/move/group 请求函数；依据 hello methods 做 capability gating。
- `src/features/openclaw-bff/hooks/useOpenClawSessions.ts`: 解析 groups，维护 mutation 状态，修正 title 优先级，并在删除后刷新/切换。
- `src/features/openclaw-bff/components/chat/OpenClawSessionSidebar.tsx`: 按 `sortOrder` 降序渲染 group、未分组区域固定置底、接入会话菜单和分组菜单。
- `src/components/ui/dropdown-menu.tsx`: **补齐共享 barrel**——当前只导出 `Trigger/Content/RadioGroup/RadioItem`，新增 `DropdownMenuItem` 和 `DropdownMenuSeparator`（补齐 Radix 已有能力）后会话行菜单复用。
- `src/features/openclaw-bff/components/chat/OpenClawSessionRow.tsx`: 新增 feature-local 会话行、hover/focus 显示的行内 ⋯ trigger + `@/components/ui` DropdownMenu（仓库无 context-menu 原语；右键菜单无法满足移动端与键盘要求）和 inline rename。
- `src/features/openclaw-bff/components/chat/OpenClawSessionGroup.tsx`: 新增分组标题、计数、颜色、折叠状态和分组菜单。
- `src/features/openclaw-bff/components/chat/CreateSessionGroupDialog.tsx`: 新建分组及可选移动当前会话。
- `src/features/openclaw-bff/components/chat/DeleteSessionDialog.tsx`: 不可撤销确认与进行中状态。
- `src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`: 编排当前会话删除后的新 session 切换。
- `src/features/openclaw-bff/components/chat/OpenClawSessionNavigation.test.tsx`: 替换“无管理动作”断言，覆盖菜单、键盘和弹窗。
- `src/features/openclaw-bff/hooks/useOpenClawSessions.test.tsx`: 覆盖 enrichment、并发 mutation、stale request 和 title precedence。
- `src/features/openclaw-bff/screen/OpenClawChatScreen.test.tsx`: 覆盖删除当前会话后的 transport 解绑和新会话绑定。

前端改动仍位于 `src/features/openclaw-bff`，不修改生成 client submodule；项目为 Tailwind-only，共享 primitives 从 `@/components/ui` barrel 导入。

## Implementation Steps

### Phase 1: Freeze contracts and persistence

1. **定义共享业务常量和实体** (`agent-server/app/common/constants/openclaw_session.py`, `agent-server/app/core/entities/openclaw/session_management.py`)
   - Action: 定义颜色、状态、名称长度、分组上限（50）、sortOrder 步长（10）、浏览器方法名、上游方法名和 DTO。
   - Why: 防止方法名和状态散落在 controller/service/repository。
   - Dependencies: None.
   - Complexity: S.
   - Risk: Low.

2. **增加 migration 和 repository port** (`agent-server/migrations/versions/014_add_openclaw_session_management.py`, repository files)
   - Action: 创建两张表、索引、唯一约束、FK `ON DELETE SET NULL` 和 scope-safe repository。
   - Why: 分组需要跨设备持久化，删除需要可调和状态。
   - Dependencies: Step 1.
   - Complexity: M.
   - Risk: Medium; downgrade 必须先删除 FK/索引再删除表。

3. **建立 service contract tests** (`agent-server/app/test/unit_test/services/test_openclaw_session_management_service.py`)
   - Action: 先锁定 create/patch/delete/move、同 scope 校验和 delete state machine。
   - Why: 这是三仓实现的行为合同。
   - Dependencies: Steps 1-2.
   - Complexity: M.
   - Risk: Low.

### Phase 2: Add narrow Gateway mutations

1. **增加协议 schema 和方法注册** (`openclaw-integration/src/gateway/protocol/schema/sessions.ts` and exports)
   - Action: 新增只包含 key/title 的 WebChat rename schema 和只包含 key 的 delete schema；`SessionEntry`/`GatewaySessionRow`/`SessionsPatchParams` 增加可选 title。
   - Why: 阻止浏览器管理链路借机修改 label、model、exec、thinking 或 lifecycle 参数。
   - Dependencies: Phase 1 contract.
   - Complexity: S.
   - Risk: Low.

2. **抽取共享 delete executor** (`openclaw-integration/src/gateway/server-methods/sessions.ts`)
   - Action: 将 existing `sessions.delete` 的 runtime cleanup、store delete、archive 和 lifecycle 代码提取为内部函数。
   - Why: 新旧方法必须共享同一删除语义。
   - Dependencies: Step 1.
   - Complexity: M.
   - Risk: High;不能改变现有 admin API 的 main-session 拒绝、active-run 等待和 hook 行为。

3. **实现 backend-only handlers** (`openclaw-integration/src/gateway/server-methods/sessions.ts`, `method-scopes.ts`)
   - Action: 校验 backend client（`normalizeGatewayClientMode(...) === GATEWAY_CLIENT_MODES.BACKEND`）、write scope、`isParentWebchatSessionKey()` 后执行 title patch 或 delete executor。**同时把 `title` 加入 `sessions.reset` 的重建 `SessionEntry` 保留字段列表**，使重命名后的会话 reset 不丢标题。
   - Why: 提供最小权限能力，避免 agent-server 申请通用 admin；reset 保留 title 覆盖 ADR-0007 接受的边界。
   - Dependencies: Steps 1-2.
   - Complexity: M.
   - Risk: High; key 分类错误会扩大到其他 channel。

4. **锁定安全回归测试** (`openclaw-integration/src/gateway/server.sessions.gateway-server-sessions-a.test.ts`)
   - Action: 测试 backend success、UI reject、non-WebChat reject、subagent reject、active-run timeout、archive、deleted=false 和现有 admin 方法兼容。
   - Why: 权限边界必须由自动测试证明。
   - Dependencies: Steps 1-3.
   - Complexity: M.
   - Risk: Medium.

### Phase 3: Build agent-server management orchestration

1. **实现 group CRUD 和 move** (`agent-server/app/services/openclaw_session_management_service.py`)
   - Action: 使用数据库事务实现 scope-safe create/patch/delete/move；删除 group 自动 ungroup。
   - Why: 这些操作完全属于 agent-server 元数据域。
   - Dependencies: Phase 1.
   - Complexity: M.
   - Risk: Medium;必须区分 group 不存在与跨 scope，外部统一返回 not found。

2. **实现 rename 和 delete orchestration** (`agent-server/app/services/openclaw_session_management_service.py`)
   - Action: 将前端 id 映射为 sibling Gateway key；rename 调用窄 rename；delete 执行状态机和调和。
   - Why: 浏览器不能直接接触真实 key 或上游参数。
   - Dependencies: Phase 2.
   - Complexity: L.
   - Risk: High;Gateway timeout 结果不确定。

3. **扩展 BFF request dispatch** (`agent-server/app/services/openclaw_bridge_request_service.py`)
   - Action: 管理方法走 local service；普通 chat 继续走 translator；list response 翻译后 enrichment。**对本地管理方法校验其存在于 `binding.methods`（声明即授权）**，使 `gateway_session_management_enabled=false` 时 dispatch 拒绝。
   - Why: 不把 agent-server 本地方法伪装成 Gateway 原生方法；声明态与执行态不分叉。
   - Dependencies: Steps 1-2.
   - Complexity: M.
   - Risk: Medium;不能破坏附件解析和 history enrichment 的既有顺序。

4. **实现 kill-switch 与 capability 注入** (`agent-server/app/common/settings/openclaw.py`, `bff_server/container.py`, `app/services/openclaw_bridge_service.py`, `app/api/v1/controllers/openclaw_bridge_controller.py`)
   - Action: `OpenClawSettings` 增加 `gateway_session_management_enabled: bool = True`（对齐 `bff_subagents_enabled` 的 settings-flag 先例，**不**沿用 `artifacts_enabled`）；container 注入 settings 到 `OpenClawBridgeService`；`bind()` 在 flag 为 true 时把管理方法并入 `binding.methods`；`_send_bridge_hello()` 只序列化 `binding.methods`。
   - Why: kill-switch 走 settings → service → binding.methods → controller hello 真实链路，避免在 controller 临时合并 methods 造成声明态与执行态分叉。
   - Dependencies: Steps 1-3.
   - Complexity: S.
   - Risk: Low.

5. **增加 catalog reconciliation 与 mutation 失效** (`agent-server/app/services/openclaw_session_management_service.py`)
   - Action: 获取轻量全量 session catalog，缓存后计算准确 counts，回收 stale assignment。**mutation（create/patch/delete group、move/delete/rename session）成功后立即失效或后台刷新对应 scope 的 catalog cache**，使下一次 list 返回准确计数。
   - Why: 分页前端无法自行计算准确计数；mutation 后 TTL 内的旧计数会让用户困惑。
   - Dependencies: Step 3.
   - Complexity: M.
   - Risk: Medium;需要设置耗时和 session 数量观测门槛。

6. **接入 standalone BFF container** (`agent-server/bff_server/container.py`)
   - Action: 绑定 repository 和 service，保持 constructor injection。
   - Why: BFF 是独立最小运行时，不能依赖 root Container。
   - Dependencies: Steps 1-5.
   - Complexity: S.
   - Risk: Medium;容器依赖错误会使 BFF 启动失败。

7. **处理 artifact 引用边界** (`agent-server/app/services/openclaw_artifact_service.py`)
   - Action: session-scoped list/enrichment 对 deleted session 隐藏引用；不删除 artifact/OSS。
   - Why: 满足确认文案，同时保留既定云盘生命周期。
   - Dependencies: Step 2.
   - Complexity: M.
   - Risk: High;不得影响用户从云盘访问仍有权限的文件。

### Phase 4: Implement frontend management UI

1. **扩展 transport 和 types** (`agent-frontend/src/utils/openclawBff/types.ts`, feature types)
   - Action: 定义 group、mutation payload、响应、错误码和 capability。
   - Why: UI 只依赖稳定浏览器 contract。
   - Dependencies: Phase 3 protocol.
   - Complexity: S.
   - Risk: Low.

2. **扩展 session hook** (`agent-frontend/src/features/openclaw-bff/hooks/useOpenClawSessions.ts`)
   - Action: 解析 groups/groupId，增加 mutation actions、pending/error state，修正 title precedence，延续 request generation 防陈旧响应策略。
   - Why: 现有 hook 已拥有分页、session switch 和 stale request 防护。
   - Dependencies: Step 1.
   - Complexity: L.
   - Risk: High;mutation 完成不能让旧 transport 响应污染新 session。

3. **拆分 feature-local components** (`agent-frontend/src/features/openclaw-bff/components/chat/*`)
   - Action: 抽出 session row、group row、新建 group dialog 和删除确认 dialog；共享 primitives 从 `@/components/ui` barrel 导入。
   - Why: 避免继续扩大现有 Sidebar 组件。
   - Dependencies: Step 2.
   - Complexity: L.
   - Risk: Medium;要保持移动端列表可达和键盘操作。

4. **处理删除当前会话** (`agent-frontend/src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`)
   - Action: 成功后生成新 id、更新 session route/state、卸载旧 chat transport，再刷新列表。
   - Why: 旧 binding 不能继续发送或保留 stale activity。
   - Dependencies: Steps 2-3.
   - Complexity: M.
   - Risk: High;需沿用既有 transport ownership 和 request generation 约束。

5. **补充可访问性和 capability gating**
   - Action: menu 支持 hover、focus、Enter/Space；dialog focus trap；无方法 capability 时隐藏动作；pending 时禁用重复提交。
   - Why: 交互不能只依赖鼠标 hover，也不能在旧 BFF 上显示无效入口。
   - Dependencies: Steps 1-4.
   - Complexity: M.
   - Risk: Low.

### Phase 5: Integration and rollout

1. **完成三仓 contract test**
   - OpenClaw：协议、scope、backend guard、delete executor。
   - agent-server：translator、service、repository、BFF controller/container。
   - frontend：hook、sidebar、screen。

2. **执行定向验证**
   - `openclaw-integration`: 仅运行 sessions/method-scope 定向 Vitest；未获得用户明确批准时不运行全量 `pnpm test`。
   - `agent-server`: 运行新增 unit tests 和相关 bridge/artifact tests。
   - `agent-frontend`: 运行 OpenClaw feature tests、`npm run type-check`，最后按交付要求运行 `make lint`。

3. **浏览器验收**
   - 使用现有登录态验证新建分组、改名、换色、移动、刷新恢复、删除非当前会话、删除当前会话和活动任务删除。
   - 进行 target A/target B 隔离测试。
   - 上传附件后删除会话，验证历史引用消失且云盘对象保留。

4. **兼容发布顺序**
   - 先发布 OpenClaw narrow methods。
   - 再发布 agent-server migration 和 BFF capability。
   - 最后发布 frontend；前端通过 hello methods 自动隐藏旧后端不支持的动作。

5. **回滚顺序**
   - frontend 可先回滚，数据库元数据不影响旧列表。
   - agent-server 关闭 `gateway_session_management_enabled` 即停止声明 management methods 并拒绝 dispatch，无需回滚部署；保留表和数据。
   - OpenClaw narrow methods 可最后移除；不回滚已完成的 transcript archive；已写入的 `SessionEntry.title` 对旧版本是被忽略的未知字段。

## Testing Strategy

### Unit tests

#### OpenClaw

- rename 接受 1-64 字符 title，拒绝空白和超长。
- title 不做唯一性检查：两个会话（含跨 namespace）可同名成功。
- label 分支契约不变：admin `sessions.patch` 写 label 仍执行全 store 唯一性检查；`sessions.resolve`、`sessions_send(label=...)` 与 search 行为不受 title 影响。
- `SessionEntry` 序列化包含 title；旧版本 Gateway 读取含 title 的 `sessions.json` 不报错（忽略未知字段）。
- write backend client 可调用，WebChat UI 和非 backend client 被拒绝。
- 非 WebChat、subagent、main、cron、heartbeat key 被拒绝。
- active run 能停止时删除成功；15 秒内不能停止时返回 unavailable，store/transcript 不删除。
- 重复删除返回 `deleted=false`，不重复发 lifecycle event。
- transcript 归档 reason 为 `deleted`。
- 删除停止 active run 时广播 `chat { state: "aborted", stopReason: "session_deleted" }`（admin 与窄 delete 一致），订阅连接可据此收尾流式。
- 现有 `sessions.patch/delete` admin contract 不变。
- **`sessions.reset` 保留 `title`**：重命名后 reset，新 `SessionEntry` 继承原标题（覆盖 ADR-0007 接受的边界）。

#### agent-server

- 同 scope group 名称大小写/空白归一化唯一；分组数达 50 上限时 create 返回明确错误。
- 新建分组 sortOrder = 同 scope max + 10（首个为 10）；并发 create 允许拿到相同 sortOrder，list 按 `(sort_order, create_time)` 二级排序稳定输出。
- `gateway_session_management_enabled=false` 时 hello 不声明管理方法且 dispatch 拒绝（声明即授权：`binding.methods` 同时是 capability 声明与执行授权依据）。
- 跨 principal、target 或 namespace 的 group/move/rename/delete 表现为 not found。
- delete group 只 ungroup，不删除 managed session。
- 前端 id 正确映射为 sibling Gateway WebChat key。
- 浏览器提交完整 Gateway key、child id 或非法 id 被拒绝。
- active -> deleting -> deleted 状态转换。
- definitive failure 回 active；timeout 保持 deleting；reconciliation 可收敛。
- deleting/deleted session 的 send 被拒绝。
- list enrichment 在分页、stale assignment 和 deleted tombstone 下返回准确 group count。
- **mutation（create/patch/delete group、move/delete/rename session）成功后 catalog cache 被失效或后台刷新**，下一次 list 立即返回新计数，不依赖 TTL 自然过期。
- deleted session 的历史附件引用不可见，云盘 ownership 不变。
- standalone BFF import 不加载 root Container、llms、engine 或无关 storage provider。

#### Frontend

- title 覆盖 derivedTitle；标题优先级为 `title -> derivedTitle -> label -> displayName`（只 title 提到首位，derivedTitle 与 label 相对顺序不变）。
- sessions 按 group `sortOrder` 降序和 session `updatedAt` 降序渲染；新建分组默认置顶，未分组区域固定在所有分组之后。
- collapsed state 以 group id 存 localStorage，不作为服务器业务状态。
- unsaved local session 不显示 rename/move/delete，或明确禁用并给出原因。
- mutation pending 时阻止重复提交。
- 旧 session/target 的迟到 response 不覆盖当前列表。
- 删除当前 session 后旧 transport unbind，新 transport 绑定新 id。
- capability 缺失时不显示管理入口。

### Integration tests

- Browser `sessions.rename` -> BFF rewrite -> Gateway `SessionEntry.title` -> refreshed list title。
- Browser `sessions.delete` -> BFF deleting -> Gateway archive -> DB deleted -> refreshed list absent。
- Gateway timeout 后重新 list，分别覆盖 session absent/present 两个分支。
- 两个浏览器 tab 同时删除同一 session，结果幂等且没有 resurrection。
- 一个 tab 删除后，另一个旧 tab send 获得 `SESSION_DELETED`。
- target/direct/group 切换后没有 group 元数据串线。

### Browser acceptance journeys

1. 新建分组并同时移动当前会话。
2. 分组改名、换色，刷新后保持。
3. 会话在两个分组和未分组之间移动。
4. 会话 inline rename，刷新及重新登录后保持。
5. 删除非当前会话，不影响当前 transport。
6. 删除当前会话，自动切换到新会话且发送正常。
7. 删除有 active run 的会话：等待清理或显示明确不可用错误。
8. 删除带附件会话：历史引用消失，云盘文件仍存在。
9. 切换到另一个 target，看不到前一 target 的 group。
10. 键盘完成菜单、改名、取消和确认操作。

## Observability And Operational Gates

### Structured events

- `openclaw_session_group_created/updated/deleted`
- `openclaw_session_moved`
- `openclaw_session_rename_requested/completed/failed`
- `openclaw_session_delete_requested/completed/uncertain/reconciled`
- `openclaw_session_catalog_refreshed`

字段只允许：target kind、operation、status、duration、session/group count、cache hit、Gateway error code。禁止记录 principal、target id、session id、session key、title、group name、文件名或 artifact id。

### Go/no-go criteria

- 100% 管理写请求都经过 scope-safe front id rewrite。
- 0 个测试路径允许浏览器控制完整 Gateway key。
- 删除测试中 active run、queue、store、transcript 和 lifecycle 行为与现有 admin delete 一致。
- catalog P95 刷新时间满足 BFF 预算；若不满足，停止上线并设计轻量 Gateway catalog 方法。
- Gateway timeout 场景不会把不确定删除误报为成功或立即回滚为 active。
- 旧后端不声明 capability 时，现有会话列表、发送和切换功能无回归。
- 浏览器验证覆盖刷新、重新进入、当前会话删除和跨 target 隔离。

## Risks & Mitigations

- **扩大 Gateway 权限面**
  - Mitigation: 新增 backend-only 窄方法；不将现有 admin 方法降级为 write，不给 BFF 通用 admin scope。

- **WebChat key 判定错误影响其他 channel**
  - Mitigation: 使用 session-key parser 和 channel segment，不使用 agent id 前缀推断 channel；对 main/subagent/cron/Feishu 建负例测试。

- **跨 PostgreSQL/Gateway 删除不一致**
  - Mitigation: 显式 `deleting` 状态；timeout 后通过 list reconciliation 收敛；不执行不可证明安全的自动补偿重建。

- **旧 tab 重新创建已删除 session**
  - Mitigation: deleting/deleted tombstone 在 BFF send 前检查；前端收到错误后切换新随机 id。

- **分组计数随分页不准确**
  - Mitigation: 由 BFF 的轻量全量 scope catalog 计算，不能基于已加载前端页累加。

- **mutation 后 catalog TTL 内显示旧计数**
  - Mitigation: create/patch/delete group、move/delete/rename session 成功后立即失效或后台刷新对应 scope 的 catalog cache，下一次 list 返回准确计数，不依赖 TTL 自然过期。

- **catalog 在大 session store 上成本过高**
  - Mitigation: 短期缓存、关闭 transcript reads、记录 count/latency；超过门槛后新增轻量 read 方法，不能让首屏静默退化。

- **重命名成功但前端仍显示 derived title**
  - Mitigation: 明确将 title 放到前端标题优先级首位并加回归测试。

- **用户标题误入 label 全局唯一别名域**
  - Mitigation: 标题写入独立的 `SessionEntry.title`（ADR-0007）；label 的唯一性、`sessions.resolve`、`sessions_send(label=...)` 与 search 契约不变并有回归测试。`sessions.reset` 已纳入 title 保留字段，重命名后 reset 不丢标题（覆盖 ADR-0007 接受的边界）；剩余边界仅限旧版本 Gateway 在其他重建 entry 路径上可能丢弃 title，不构成协议或 store 冲突。

- **删除确认误导用户认为 OSS 文件已永久删除**
  - Mitigation: 文案只声明消息和会话内文件引用移除；artifact retention 继续按独立策略执行。

- **Sidebar 组件继续膨胀**
  - Mitigation: session row、group row 和 dialogs 保持 feature-local 独立组件；hook 负责工作流，组件只负责交互。

- **session switch 迟到响应污染新 binding**
  - Mitigation: 延续现有 `clientSessionId` transport ownership、request generation 和旧请求失效机制；删除当前会话必须先 unbind 旧 transport。

## Success Criteria

- [ ] 用户可创建、重命名、换色和删除会话分组。
- [ ] 删除分组只将会话移到未分组。
- [ ] 用户可将已持久化会话在分组间移动。
- [ ] 会话重命名写入 OpenClaw `SessionEntry.title` 并在刷新后优先显示（标题优先级 `title -> derivedTitle -> label -> displayName`）；label 的唯一性与解析契约不变。
- [ ] 重命名后的会话执行 `sessions.reset` 不丢标题。
- [ ] 分组名称、颜色、排序和归属跨刷新与设备保留。
- [ ] 分组计数不依赖前端已加载页，且与 scope catalog 一致。
- [ ] 浏览器从未获得或提交真实 Gateway key。
- [ ] agent-server 不申请通用 `operator.admin`。
- [ ] WebChat narrow methods 不能操作其他 channel、main 或 child session。
- [ ] 删除 active session 会清理运行和队列并归档 transcript。
- [ ] Gateway timeout 的删除可以通过 reconciliation 收敛。
- [ ] 删除当前会话后自动切到新 session，旧 transport 不再发送。
- [ ] 已删除会话的历史附件引用不可见，OSS 文件不被本功能级联删除。
- [ ] 旧 BFF/Gateway 未声明能力时，前端现有聊天功能保持可用。
- [ ] 三仓 focused tests、frontend type-check/lint 和浏览器验收通过。
