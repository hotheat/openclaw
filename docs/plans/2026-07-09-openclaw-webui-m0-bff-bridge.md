# Implementation Plan: OpenClaw WebUI M0 BFF Bridge

> 本计划取代 `docs/research/openclaw-frontend-integration/webui_integration_milestones.md`
> 早期版本中"浏览器直连 Gateway 的前端 SDK"M0 方案（已确认架构转向，见 ADR-0002）。
> 决策记录：`docs/adr/0002-webui-bff-bridge-over-direct-gateway-connection.md`。

> **2026-07-09 重大修订（interview 后，逐条对照代码核实）**：M0 设备鉴权由原"Ed25519
> 签名设备 + Phase 0 程序化自配对"改为 **shared-token bootstrap**。agent-server 持
> Gateway shared token + Ed25519 签名设备身份（绑定 scopes）连接，命中 Gateway 既有
> `skipPairingForOperatorSharedAuth` 直接跳过 pairing——**永不配对、不持 deviceToken、
> 无需 Phase 0、Gateway 零改动**。原 Phase 0（三情况 auth gate 改造、"已配对成为信任
> 锚点"语义变更、远程手动配对 smoke）整体砍掉。封禁粒度为全局 shared-token 轮换。
> namespace 由 user-scoped 改为 **target-scoped**（含 targetKind+targetId）。agentId
> 解析 honor openclaw.json `bindings[].agentId` 覆盖（经 workspace-api HTTP）。bridge
> 协议改为 `bridge.connect` 握手（target 走消息体，不依赖 WS header）。
>
> **凭据类型（2026-07-09 二次核实）**：现网 Gateway 是 `auth.mode=password`（`openclaw.json:3530`），
> 而 `auth.mode` 单选——password 模式下 `auth.token` 被直接忽略（现网 `${OPENCLAW_GATEWAY_TOKEN}`
> 是死配置）。故 agent-server 的 shared secret = **token 或 password 二选一**（`gateway_token`/
> `gateway_password` 恰一非空）；password 模式 connect 帧只带 `auth.password`，签名 payload 的 token
> 段为空串（Gateway 侧 payload 取 `auth.token ?? auth.deviceToken ?? null`）。生产直接用
> `OPENCLAW__GATEWAY_PASSWORD`，Gateway 配置零改动。

## Overview

M0 由 `agent-server` 承接 OpenClaw Gateway WebSocket。浏览器只连接
`agent-server /api/v1/openclaw/ws`，不直接连接 Gateway，也不持有 OpenClaw
shared token、Ed25519 私钥或 Gateway 级凭据。

`agent-server` 在 Gateway 侧表现为一个 **shared-token operator client**：每次连接携带
Gateway shared secret（token 或 password，见上方"凭据类型"注）+ Ed25519 签名设备身份（持久 keypair，绑定
`operator.read,operator.write` scopes）。Gateway 校验 shared secret → `authOk=true` →
`skipPairingForOperatorSharedAuth` 跳过整个 pairing 分支 → 连接直通，获得 read+write
方法权限。**agent-server 永不配对、永拿不到 deviceToken**（`ensureDeviceToken` 因设备不
在 paired store 返回 null，`helloOk.auth` 为 undefined）。

部署事实：`agent-server` 仓库以两个 FastAPI 实例部署——`agent-api`（`main:app`，
Traefik 路由 `/api/v1`，生产 `replicas: 2`）与 `workspace-api`（`workspace_api.main:app`，
挂载 openclaw.json 与 workspace 文件）。**bridge 落在 agent-api**；双副本共享
`agent-server-data` volume，各自持一条 upstream 连接、各自一份 Ed25519 keypair
（不配对，deviceId 无需跨副本一致）。shared token 由 env 注入双副本共享。

用户级身份仍来自 `agent-server` 当前认证体系：

- 飞书 session cookie：正式 WebUI 登录态（浏览器 WS 唯一自然鉴权通道）。
- `X-API-Key`：仅非浏览器客户端（`wscat -H "X-API-Key: ..."`）调试用；浏览器 WS
  无法设自定义 header。

OpenClaw agent 身份对齐 `~/github/openclaw-workspace` 中的 Feishu-routed agents，但
agentId 解析 **honor openclaw.json `bindings[].agentId` 覆盖**（经 workspace-api HTTP）：

- 默认派生：DM → `feishu-<open_id>`（`feishu-ou_xxx`）；private group →
  `feishu-group-<group_id>`（`feishu-group-oc_xxx`）。
- 若 binding 显式 `agentId`，用覆盖值。

会话语义（已确认的产品决策）：**webui 会话独立于飞书会话**。同一个 agent（同 workspace、
同记忆文件、同模型配置），但 WebUI 对话在独立的 `webui` namespace 下建档，与飞书 DM 会话
（`agent:<agentId>:main`）/飞书群会话互不可见；`chat.send` 不带 `deliver`，网页对话不会
投递回飞书。"在网页接续飞书对话上下文"是未来独立需求（见 Deferred）。

核心链路：

```text
agent-frontend
-> /api/v1/auth/feishu/me 获取 feishuOpenId
-> workspace-api /api/v1/workspaces/me 获取 privateGroups[]（仅前端展示用）
-> agent-server(agent-api) /api/v1/openclaw/ws（cookie 鉴权，无 target）
-> WebSocket auth 解析 Principal（cookie / X-API-Key）
-> 浏览器发 bridge.connect{targetKind, targetId, clientSessionId}
-> OpenClawBridgeService 校验 target（DB owner / 存在性）、解析 agentId（workspace-api
   bindings + 默认派生，30-60s 缓存）、校验 agentId 已配置（agents.list 全量快照，60s TTL，
   fail-closed）、推导 target-scoped namespace、绑定连接
-> 进程级共享 OpenClaw Gateway chat client（shared-token + 签名设备）
-> OpenClaw Gateway WS
```

M0 的关键边界：Gateway 只识别 `agent-server` 的 shared-token operator client；用户、service、
target、session 的隔离全部由 BFF 层强制执行。Gateway 零改动。

## Code Facts（已逐条对照代码验证）

Gateway（本仓库）：

- **shared token 直接跳过 pairing（M0 鉴权基石）**：`message-handler.ts:558-565`——
  `skipPairingForOperatorSharedAuth = role === "operator" && sharedAuthOk && !isControlUi &&
!isWebchat`；为 true 时 `if (device && devicePublicKey && !skipPairing)` 整个 pairing
  块被跳过。**不检查 `isLocalClient`**，容器化（非 loopback）同样适用。`auth.mode=token`
  且 `connectAuth.token` 匹配时 `authOk=true`（`auth.ts:434-448`），`sharedAuthOk=true`
  （`auth-context.ts:124-138`）。已有测试固化：`server.auth.test.ts:1101-1167`（"skips
  pairing for operator scope upgrades when shared token auth is valid"——connect.ok、无
  pending、`getPairedDevice` 为 null）。
- **shared token 路径无 deviceToken 下发**：`message-handler.ts:715-717` `ensureDeviceToken`
  对未配对设备返回 null；`:797-804` `helloOk.auth` 仅在 deviceToken 非空时设置 → shared-token
  连接 `helloOk.auth` 为 undefined。**无任何程序化方式获取 deviceToken**（无
  `device.pair.request` 方法；`device.token.rotate` 也要求已配对）。M0 不依赖 deviceToken。
- **纯 shared token（无 device 身份）会清空 scopes**：`message-handler.ts:423-425`
  `clearUnboundScopes()` → scopes=`[]`，只能调 `health`（`server-methods.ts:39,47,54`）。
  故 agent-server **必须**带签名设备身份才能 self-declare scopes 获得 read+write 权限
  （`server.auth.test.ts:399-403` "operator + valid shared token => connected with zero
  scopes"）。scopes 由签名绑定，不可篡改。
- **同 deviceId 多并发连接：允许，不驱逐**：连接注册是 `Set<GatewayWsClient>`
  （`server-runtime-state.ts:102`），非 per-deviceId Map；`setClient` 直接 add
  （`ws-connection.ts:290-293`），close 仅 delete 自身（`:169-183`）。全仓 grep
  `evict`/`duplicate device`/`kick` 等零命中。两副本共享 token + 各自 keypair 各持一条
  upstream 共存无冲突。
- **tool/agent 事件按 connId 路由（非 deviceId）**：`server-methods/chat.ts:896-902`
  `registerToolEventRecipient(runId, connId)`；`server-chat.ts:439-441` 仅发给注册 connIds。
  chat delta/final/error 是广播（`server-chat.ts:315,355,366,444` `broadcast(...)`）发给
  所有连接。**后果**：upstream 重连换新 connId，重连前 in-flight run 的 tool 事件丢失
  （delta/final/error 仍可达）。M0 接受此损失，标记 run degraded。
- **idempotencyKey == runId，全局 dedupe**：`chat.ts:743` `clientRunId = p.idempotencyKey`，
  用于 ack（`:799-802`）、dedupe（`:773` key=`chat:<idempotencyKey>`，TTL 5min
  `server-constants.ts:35`、max 1000 `:36`）、final/error（`:955,980`）、abort
  （`:792 chatAbortControllers.set`）。**响应/事件里的 runId 就是 idempotencyKey 原值**。
  BFF 重写 idempotencyKey 后，事件回传的 runId 是重写值——必须双向翻译回前端原 key。
- **请求 envelope `id` 被原样回显**：`message-handler.ts:904-910` `respond` 发
  `{type:"res", id: req.id, ...}`；`id` 仅约束 `NonEmptyString`（`frames.ts:128`），无唯一性
  校验。BFF 可用自有 correlation id 路由响应。
- **chat 事件 payload**：`{runId, sessionKey, seq, state, message?, errorMessage?, usage?,
stopReason?}`（`logs-chat.ts:64-81`）。`state ∈ {delta,final,aborted,error}`（无
  "streaming"）。`seq` 按 runId 计（`chat.ts:487-491` `agentRunSeq` map），非 per-session。
  chat 事件必含 sessionKey；**agent 事件可能缺 sessionKey**（`server-chat.ts:404`
  `sessionKey ? {...eventForClients, sessionKey} : eventForClients`）——无 sessionKey 的
  agent 事件默认拒绝。
- **签名设备 v2 payload 字段顺序**：`v2|deviceId|clientId|clientMode|role|scopes(逗号连接)|
signedAtMs|token|nonce`（`device-auth.ts:12-26`）。`clientId`/`clientMode` 客户端自选
  （默认 `gateway-client`/`backend`，`client.ts:272-281`），签名绑定但不校验值合法集。
  `token` = `connectParams.auth?.token ?? connectParams.auth?.deviceToken ?? null`——M0
  签名 over shared token。`nonce` 取自 `connect.challenge` 事件（per-connection
  `randomUUID()`，`ws-connection.ts:162`），等值校验（`message-handler.ts:502-510`），非全局
  单次消费。签名时效 ±2 分钟（`DEVICE_SIGNATURE_SKEW_MS`，`message-handler.ts:84,494-501`）。
- **deviceId 派生**：`sha256(raw ed25519 公钥 32 字节).hex()`，Gateway 强制
  `deriveDeviceIdFromPublicKey(publicKey) === device.id`（`device-identity.ts:143-152`、
  `message-handler.ts:489-492`）。公钥传 raw base64url，签名 base64url(ed25519.sign(utf8 payload))。
- **Gateway 对 sessionKey 里 agentId 无存在性校验**：未配置 agentId 用默认模型/配置照常运行
  并自动新建 `workspace-<id>` 目录（`agent-scope.ts:84-102,224-240`，`sandbox/workspace.ts:20`
  `mkdir recursive`）。sessionKey 规范 `agent:<agentId>:<多段rest>`，全小写；agentId 合法形态
  `^[a-z0-9][a-z0-9_-]{0,63}$`（`routing/session-key.ts:24,81-99`，normalize 而非 reject）。
- **M0 allowlist 8 方法均在 operator.read/operator.write 内**（`method-scopes.ts`）：
  health/status/models.list/sessions.list/sessions.preview = operator.read，
  chat.send/chat.abort = operator.write，chat.history = operator.read。`agents.list` =
  operator.read（BFF 内部用，不透传）。read scope 由 read 或 write 满足
  （`method-scopes.ts:184-188`）。`authorizeGatewayMethod`（`server-methods.ts:35-62`）按连接
  scopes 兜底拒绝越权方法（双层防护）。chat.send 不在 control-plane rate limiter 内。
- **sessions.list 可按 agentId 服务端过滤**（`session-utils.ts:744-768`），但无法按
  principal/namespace 过滤——BFF 必须按 namespace 二次过滤。`sessions.preview` 需 `keys`
  （session key 数组，`sessions.ts:28-35`）。`chat.history` 需 `sessionKey`（`logs-chat.ts:26-32`）。
  `chat.abort` 需 `runId`（`chat.ts:611-614,630`）。

agent-server：

- 以 `agent-api`（`main:app`，8000，生产 replicas=2，`uvicorn --workers 1`）+ `workspace-api`
  （`workspace_api.main:app`，dev 8002）双实例部署，共享 `agent-server-data` volume（挂载
  `/app/data`，`docker-compose.yml:65-68,116`）与 PostgreSQL；agent-api 无 openclaw.json 挂载
  （`docker-compose.yml:38-103`），仅经 `OPENCLAW__WORKSPACE_API_BASE_URL`/`_API_KEY`
  （`:52-53`）走 workspace-api HTTP 读 openclaw config。
- **已有 `WorkspaceOpenClawConfigClient`**（`app/infra/clients/workspace_openclaw_config_client.py`，
  httpx）调 workspace-api `/api/v1/internal/openclaw/config`、`.../targets/groups`、
  `.../targets/users/{open_id}`；已注入 agent-api（`clients.py:222`，`services.py:416,423,533`）。
  BFF 解析 binding agentId 复用它。
- 已有同构常量：`OPENCLAW_FEISHU_DIRECT_AGENT_ID_PREFIX='feishu-'`、
  `OPENCLAW_FEISHU_GROUP_AGENT_ID_PREFIX='feishu-group-'`（`constants/openclaw.py:81-82`）；
  peer kind 常量 `OPENCLAW_FEISHU_DIRECT_PEER_KIND='direct'`、
  `OPENCLAW_FEISHU_GROUP_PEER_KIND='group'`、channel `OPENCLAW_FEISHU_CHANNEL='feishu'`。
- 已有 agentId 默认派生：`OpenClawModelConfigService._default_feishu_agent_id`
  （`openclaw_model_config_service.py:1076-1083`）= prefix + target_id；`_bound_agent_id`
  （`:1038-1042`）先查 `bindings[].agentId` 覆盖再回退默认。BFF 经 workspace-api HTTP 复用此
  语义（agent-api 无 openclaw.json，不能直接实例化该 service 读本地文件）。
- 已有飞书 OAuth login/callback/session cookie；`authentication_resolver.py` 解析
  `X-API-Key`（`X_API_KEY_HEADER='x-api-key'`，`constants/auth.py:32`）与 session cookie
  （`cookie_name` 默认 `'feishu_session'`，`settings/client.py:489`）；`X-Target-Type`/
  `X-Target-Id` header（`auth.py:33-34`）与 `TargetSubject`/`TargetType(USER|GROUP)` 已存在。
  **但 resolver 签名绑死 `fastapi.Request` 且抛 `HTTPException`**（`authentication_resolver.py:20-25`），
  不能直接用于 WebSocket。
- `Principal`（`core/entities/auth/models.py:202-223`）含 `feishu_open_id`、`user_id`、
  `service_id`、`tenant_key`、`effective_user_id`（property = `user_id or principal_id`，跨登录
  稳定，DB PK 支撑）。service principal 无 `feishu_open_id`（`identity_service.py:132-147`）。
- `/api/v1/workspaces/me`（`workspace_controller.py:53-65`）→ `WorkspaceService.list_current_user_private_groups`
  （`workspace_service.py:207-222`）→ `GroupAdminQueryRepository.list_private_group_displays_for_owner`
  （`auth_repository.py:635-666`）。**纯 DB 查询**（join ManagedGroupPO + GroupPO，过滤
  provider/tenant_key/enabled/is_private/owner_id），不依赖 openclaw.json。**签名需
  `(session, provider, tenant_key, owner_open_id)`**，返回 `list[ManagedGroupDisplayItem]`
  （非 `OpenClawGroupTargetItem`——计划早期混淆，已修正）。owner 查询需 USER open_id，service
  principal 不可直接复用。
- DB 实体可复用：`UserIdentityPO`（`auth_po.py:35-46`，unique provider/tenant_key/open_id）+
  `UserIdentityRepository.find_by_provider_tenant_open_id`（`auth_repository.py:161-175`）；
  `ManagedGroupPO`（`auth_po.py:154-173`，`enabled` 字段 `:163`）+ `ManagedGroupRepository.get_managed_group`
  （`auth_repository.py:772-786`）。均以 `providers.Singleton` 注入 agent-api
  （`repositories.py:82-116`）。DB 在 agent-api 与 workspace-api 间共享（`DatabaseContainer`）。
- **DI = dependency-injector**（`containers/container.py:24`）。长连资源模板：
  `ACCTRepository`（Singleton + `aclose()`，cleanup 调，`repositories.py:70`）、
  `TemporalClientFactory`（lazy connect + `asyncio.Lock` + retry + keepalive + `close()`，
  `infra/temporal/client.py:25-101`）。cleanup 在 `containers/cleanup.py:19-63`，由
  `api/factory.py:58` lifespan shutdown 调。**无 eager-start lifespan 模式**——Gateway manager
  是首个（lazy 或 eager 由 `OPENCLAW__GATEWAY_UPSTREAM_REQUIRED` 控制）。
- **无任何 `@router.websocket` 先例**（全 `app/` 仅 `api_utils.py` 类型检查引用 `WebSocketRoute`）。
  BFF 需自建 WS 鉴权与生命周期模式。
- `websockets` v16.0 已是 `lark-oapi` 的传递依赖（`uv.lock:4206`），但仍应在 `pyproject.toml`
  显式声明直接依赖以防 lark-oapi 变更。

agent-frontend：

- `/api` Vite proxy（→ localhost:8000，agent-api，`vite.config.ts:27-30`）缺 `ws: true`，无
  rewrite；`/api/v1/workspaces` 单独代理 workspace-api（8002，`:23-26`）；`/static`（`:31-34`）。
  `/api/v1/openclaw/ws` 落 `/api` 兜底规则，补 `ws: true` 即可路由，无 shadowing 风险。
  **生产无 Vite proxy**——需 Traefik/nginx 路由（见 Deployment）。
- 测试 = `tsc -p tsconfig.tests.json && node --test`（`package.json:13-14`，Node 内置 test
  runner，非 vitest）。`.test.ts` 经 tsc 编译到 `.tmp-test-build/` 后跑，import 用相对 `.js`
  路径；新 `.test.ts` **必须**加入 `tsconfig.tests.json` include（`:13-38`）才会编译。无
  `test:openclaw-bff`，按 `test:schemas`/`test:workspace` 同构新增。`type-check` 用
  `tsconfig.app.json`（`:18`）。
- **鉴权纯 cookie**：`api_client.ts:20-22` `basePath=''`（同源）；axios `withCredentials:true`
  遍布各 feature API；登录走 `/api/v1/auth/feishu/login` 服务端重定向设 cookie
  （`useAuth.ts:6,47`）。`src/` 无任何 `X-API-Key`/`Authorization` header。浏览器 WS 自动带
  同源 cookie → WS 鉴权可用，无需 subprotocol hack。`/me` 经 `authControllerGetMe`
  （`useAuth.ts:29`）取当前用户（含 feishuOpenId，实现时核实字段）。
- 无任何现有 WebSocket/EventSource/SSE 客户端（`src/` grep 零命中）——BFF client 是首个，
  自建 reconnect/backoff 约定。
- `src/utils/` 为扁平单文件（无子目录、无 barrel `index.ts`）。`src/utils/openclawBff/` 子目录
  可用但偏离扁平约定；计划保留子目录 + barrel（与 `src/features/*/` 一致），实现时知悉。
- `.env.example`（`:1-10`）仅 `VITE_WORKSPACE_API_URL` 一个 URL var；无 openclaw var。

## Requirements

- 前端不直接连接 OpenClaw Gateway，不持有 shared token、Ed25519 私钥或 Gateway auth。
- `agent-server` 实现 Ed25519 签名设备身份（绑定 scopes）与 **shared token** 鉴权；**不实现
  pairing、不持久化 deviceToken**（shared-token 路径永不配对、永无 deviceToken）。
- **M0 仅 chat 语义**：声明 `operator.read,operator.write`，不声明 `operator.admin`/
  `operator.approvals`/`operator.pairing`。keypair 持久化（`/app/data/openclaw/gateway-device-key.json`，
  0600，含 deviceId/publicKey/privateKey/createdAt，**不写 deviceToken**），副本各自一份。
- **dev 与生产走同一 shared-token 链路**：每次连接带 shared token + 签名设备 + read+write
  scopes → skipPairing 直通。无 pairing、无人工批准、无 Phase 0。
- 不使用 deviceToken / pairing 作为鉴权路径（与原计划反转：原计划"不使用 shared token 捷径"
  已废弃，M0 正是以 shared token 为唯一设备鉴权）。
- `agent-server` 到 Gateway 的 upstream WS 按进程共享，不按浏览器用户创建。生产 agent-api 双
  副本：各自 keypair、各自一条 upstream、共享 shared token（env）。state 写入原子
  （tempfile+rename）；upstream 生命周期由 `OPENCLAW__GATEWAY_UPSTREAM_REQUIRED` 控制
  （false=lazy 首个浏览器 WS 触发 `ensure_started()`；true=eager+required，lifespan 失败则
  agent-api 不 ready）。
- shared token 视为长驻 secret：env 注入、不入日志、不进 crash dump。封禁 = 轮换 shared token
  - 滚动重启 Gateway 与 agent-api（全局粒度，接受）。
- 浏览器按 Feishu target 建模（`targetKind`+`targetId`），不按 raw `agentId` 建模，不让前端
  传 agentId 给 Gateway。
- 飞书登录用户可用自己的 DM（`targetKind=direct, targetId=feishuOpenId`）和
  `/workspaces/me` 返回的 private groups（`targetKind=group, targetId=groupId`）。
- API Key 调试入口保留（非浏览器客户端经 `X-API-Key` header），必须显式指定 target 或使用
  服务端 dev 默认 target。
- BFF 必须解析 agentId（honor `bindings[].agentId` 覆盖，经 workspace-api HTTP，30-60s 缓存；
  workspace-api 不可用不回退默认 id）并校验已配置（agents.list 全量快照 60s TTL，fail-closed）；
  未配置/校验失败拒绝，不让 Gateway 静默创建野 agent。
- BFF method allowlist 默认拒绝，未列入方法不转发到 Gateway。
- BFF 必须重写和校验 sessionKey，普通用户和 service principal 不能访问彼此 session。
- BFF 必须过滤 upstream event，只下发当前连接 target + namespace 内的 `chat`/`agent` event。
- BFF 必须做 runId 双向翻译（前端 frontRunId ↔ Gateway gatewayRunId）与 sessionKey↔clientSessionId
  映射；`chat.send`/`chat.history`/`chat.abort`/`sessions.*` 的 sessionKey/runId 全部由 BFF 重写。
- webui 会话独立于飞书会话（不读写 `agent:<id>:main` 或飞书渠道 session）。
- M0 不实现最终 chat UI，只交付可被 M1 使用的轻量前端 BFF WS client（含完整 session 往返能力，
  测试覆盖）。

## Target Model

### Browser targets

前端选择 `target`（`targetKind`+`targetId`），不选择 `agent`。`targetKind` 对齐 openclaw.json
`binding.match.peer.kind`。

DM target：

```ts
{ targetKind: "direct", targetId: "<feishuOpenId>" }   // ou_xxx
```

Private group target：

```ts
{ targetKind: "group", targetId: "<groupId>" }          // oc_xxx
```

前端数据源：

- `feishuOpenId` ← `/api/v1/auth/feishu/me`（`authControllerGetMe`）。
- `privateGroups[].groupId` ← `/api/v1/workspaces/me`（`WorkspacePrivateGroupData`）。

### Target authorization

飞书 session principal：

- `targetKind=direct`：`targetId` 必须等于当前 `Principal.feishu_open_id`（BFF 校验，不信任
  前端值）。无需 DB 查询。
- `targetKind=group`：`targetId` 必须存在于当前用户 owner 的 private group——复用
  `GroupAdminQueryRepository.list_private_group_displays_for_owner(session, provider='feishu',
tenant_key=principal.tenant_key, owner_open_id=principal.feishu_open_id)`（DB 查询，与
  `/workspaces/me` 同源），不依赖 openclaw.json、不经 workspace-api HTTP。

API key service principal：

- 不默认映射到用户 DM。
- 必须显式 `targetKind`+`targetId` 或服务端 dev 默认 target
  （`gateway_default_target_kind`/`gateway_default_target_id`，同样过验证）。
- target 验证 = **DB 存在性**：`direct` → `UserIdentityRepository.find_by_provider_tenant_open_id
('feishu', principal.tenant_key, targetId)` 存在；`group` → `ManagedGroupRepository.get_managed_group
('feishu', principal.tenant_key, targetId)` 存在且 enabled（不要求 private、不要求 owner；
  越权防护由 service 独立 namespace 承担）。
- namespace 使用 service 维度（`service_id`），不能混入 user namespace。

### Agent id 解析与存在性校验

```text
BFF 经 workspace-api HTTP 查 bindings[]（channel=feishu, peer.kind=targetKind, peer.id=targetId）
  -> 有 binding.agentId  -> agentId = binding.agentId（honor 覆盖）
  -> 无 binding          -> agentId = 默认派生（direct: feishu-<targetId>, group: feishu-group-<targetId>）
BFF 校验 agentId 全小写、落在 ^[a-z0-9][a-z0-9_-]{0,63}$
BFF 校验 agentId ∈ agents.list 全量快照（60s TTL，fail-closed）——未配置返回 TARGET_AGENT_NOT_PROVISIONED
```

- agentId 解析缓存 30-60s（按 target 或 configHash）。**workspace-api 不可用时 fail-closed，
  不回退默认 id**（否则会悄悄打到错误 agent）。
- agents.list 快照缓存 60s；拉取失败/过期重拉失败时拒绝该 target（4003/503），不放行。
- BFF 不接受前端传入 raw `agentId`。调试面板可显示解析后的 `agentId`，但不能作为授权输入。
- 复用 `OPENCLAW_FEISHU_*_AGENT_ID_PREFIX` 与 `_bound_agent_id` 语义（经 HTTP），不重写派生逻辑。

## Bridge Protocol

浏览器不发送 Gateway `connect`。BFF WebSocket 用现有 cookie 或 API key 鉴权（WS connect 阶段），
**target 不在 WS URL**，而在浏览器首个消息体（浏览器无法设 WS 自定义 header）。

握手流程：

```text
1. 浏览器 open /api/v1/openclaw/ws（同源 cookie 自动带）
2. BFF WS auth 解析 Principal（失败 close 4001）
3. 浏览器发 bridge.connect{targetKind, targetId, clientSessionId}
4. BFF: 校验 target、解析 agentId（workspace-api）、校验 agents.list、构造 namespace、绑定连接
   （失败 close 4003 / 4008）
5. BFF 发 bridge.hello{principalId, target, agentId, methods, clientSessionId}
6. 浏览器发 {type:"req", id, method, params}（chat.send 带 frontRunId；不带 target/sessionKey）
7. BFF 重写 sessionKey/runId 转发 upstream；响应/事件翻译回前端
```

浏览器到 `agent-server`：

```json
{ "type": "req", "id": "uuid", "method": "bridge.connect", "params": { "targetKind": "direct", "targetId": "ou_xxx", "clientSessionId": "..." } }
{ "type": "req", "id": "uuid", "method": "chat.send", "params": { "frontRunId": "abc123", "message": "..." } }
```

`agent-server` 到浏览器：

```json
{ "type": "event", "event": "bridge.hello", "payload": { "principalId": "...", "target": { "targetKind": "direct", "targetId": "..." }, "agentId": "feishu-ou_xxx", "methods": [], "clientSessionId": "..." } }
{ "type": "res", "id": "uuid", "ok": true, "payload": { "runId": "abc123", "status": "started" } }
{ "type": "event", "event": "chat", "payload": { "runId": "abc123", "sessionKey": "<clientSessionId>", "seq": 12, "state": "delta", "message": "..." } }
```

- `bridge.hello` 包含 BFF 解析后的 `target`、`agentId`、可用 method 列表（M0 allowlist 静态表）、
  `clientSessionId`。`bridge.connect` 是浏览器→BFF 的唯一握手请求；之后 chat.send 等不再带 target。
- `clientSessionId` 规范 `^[a-z0-9][a-z0-9_-]{0,47}$`（小写；预留 namespace 长度余量），由 BFF
  规范化/拒绝。前端生成（新对话时生成，localStorage 持久化跨重载）。
- **runId 双向翻译**：前端传 `frontRunId`（短 id）；BFF 重写为
  `bff-<namespace>-<frontRunId>`（不透传原值）作为 Gateway idempotencyKey/runId；响应/事件回传
  时把 runId 翻译回 `frontRunId`。`chat.abort` 入站 runId（即 frontRunId）同样重写为
  `bff-<namespace>-<frontRunId>`。前端始终只看到自己的 frontRunId。
- **sessionKey 映射**：BFF 内部用 `agent:<agentId>:webchat:<clientInstanceId>:<clientSessionId>`；返回
  前端时映射回 `clientSessionId`，前端不依赖内部格式。`chat.history`/`sessions.preview` 入站用
  `clientSessionId`，BFF 重写为内部 sessionKey。
- close code：4001 未认证、4003 target 越权/agent 未配置、4008 协议违规、1011 upstream 不可用
  （常量模块统一定义）。

## Authorization Model

### M0 allowlist

M0 只允许转发：`health`、`status`、`models.list`、`chat.send`、`chat.history`、`chat.abort`、
`sessions.list`、`sessions.preview`（均在 chat profile 的 `operator.read/write` 范围内，Gateway
侧按连接 scopes 兜底拒绝，双层防护）。

M0 不向浏览器透传：`agents.list`（Gateway 全局 agent 表，非当前用户可用 Feishu target 列表；
BFF 内部调用做存在性校验）。

明确拒绝：`connect`、`config.*`、`cron.*`、`sessions.patch/reset/delete/compact`、`chat.inject`、
`exec.approval.*`、`device.*`、`node.*`、未分类方法。

### Session namespace（target-scoped）

BFF 内部传给 Gateway 的 sessionKey（全小写）：

```text
agent:<agentId>:webchat:<clientInstanceId>:<clientSessionId>
```

其中 `namespace = hash16("<tenant_key>:<identityId>:<targetKind>:<targetId>")`（16 字符确定性
指纹，sha256 截断即可满足隔离；若需不可猜测可加服务端 secret 做 hmac——namespace 进 sessionKey
对 Gateway 可见，无保密必要）。

- `identityId` = `principal.effective_user_id`（用户 = user_id；service = service_id/principal_id）。
- `tenant_key` 取自 `Principal.tenant_key`（用户与 service 均有）。
- namespace 含 targetKind+targetId，故不同 target 自然隔离；agentId 由 target 派生，冗余但
  Gateway sessionKey 格式要求保留 `agent:<agentId>:` 前缀以正确路由 agent。
- `clientSessionId` 只允许短 id（见 Bridge Protocol 正则），由 BFF 规范化。
- 前端若传完整 `sessionKey`，BFF 必须拒绝或严格校验属于当前 namespace。
- `chat.send`/`chat.history`/`chat.abort` 必须重写 `sessionKey`；`chat.abort` 还需重写 `runId`。
- `sessions.list`/`sessions.preview` 结果必须过滤当前 `agentId + namespace`（可先按 agentId
  服务端过滤再按 namespace 二次过滤）。
- webui namespace 不与飞书会话（`agent:<id>:main`、`agent:<id>:feishu:*`）重叠；namespace 校验
  天然拒绝对它们的访问。
- **不用登录 sessionId** 作 namespace 基底（登录会话非业务目标身份）；用 target 身份
  （tenantKey:identityId:targetKind:targetId）。

### Event filtering

- `chat`/`agent` event 必须读取 `payload.sessionKey`，解析出 namespace，只有当前连接的
  `namespace`（等价 agentId + target）匹配时才下发。
- 无 `sessionKey` 的 chat/agent event 默认拒绝（仅 agent 事件可能缺 sessionKey，chat 事件必含）。
- `health`、`tick` 这类无敏感 session payload 的基础事件可单独白名单。
- 两副本 upstream 均收到全部广播事件，各自按本地连接 namespace 过滤（无跨连接串话，因 namespace
  含 identityId+target 唯一）。

## Architecture Changes

- **Gateway（本仓库）：无任何改动**。shared-token skipPairing、并发连接、idempotencyKey/runId、
  method scopes 均为既有行为（`server.auth.test.ts:1101-1167` 已覆盖 skipPairing 语义）。原 Phase 0
  砍掉。
- `agent-server:app/common/settings/openclaw.py`
  - 增加：`gateway_url`、`gateway_token`（optional secret）、`gateway_password`（optional secret）、
    `gateway_client_id`（默认 `gateway-client`）、`gateway_request_timeout_seconds`、
    `gateway_connect_timeout_seconds`、`gateway_device_key_path`（默认
    `/app/data/openclaw/gateway-device-key.json`）、`gateway_environment`、
    `gateway_default_target_kind`、`gateway_default_target_id`、`gateway_upstream_required`（bool，默认 false）。
  - **`gateway_token`/`gateway_password` 恰一非空校验**（`model_validator`：都空或都设 → 启动报错）。
    对齐 Gateway `auth.mode` 单选：mode=token 用 `gateway_token`、mode=password 用 `gateway_password`。
    现网为 password 模式，配 `OPENCLAW__GATEWAY_PASSWORD`，`gateway_token` 留空。
  - 删除原 `gateway_device_state_path`（per-profile store 不再需要）。
- `agent-server:app/common/constants/openclaw_gateway.py`
  - 定义：protocol version、chat profile scopes（`operator.read,operator.write`）、clientMode
    （`backend`）、allowlist、denied prefixes、targetKind（direct/group）、namespace 片段、
    clientSessionId 正则、runId 前缀（`bff-`）、bridge event 名称（`bridge.connect`/`bridge.hello`）、
    close code。
- `agent-server:app/common/ports/openclaw_gateway_port.py`
  - 新增 Gateway upstream port：`connect()`、`request()`、`events()`、`close()`、`ensure_started()`。
- `agent-server:app/infra/openclaw/gateway_device_auth.py`
  - 实现 v2 payload（字段顺序逐项一致）、raw 公钥 base64url、deviceId=sha256(raw 公钥).hex()、
    Ed25519 签名 base64url；nonce 取自 `connect.challenge`；`signedAtMs` 当前时间（±2min 时效）。
    **payload 的 `token` 段**：token 模式 = shared token；password 模式 = 空串（Gateway 侧 payload
    取 `auth.token ?? auth.deviceToken ?? null`，password 模式不传 token → 空串）。推荐
    `cryptography` 库 Ed25519（`public_bytes(Encoding.Raw, PublicFormat.Raw)` 取 32 字节）。
- `agent-server:app/infra/openclaw/gateway_device_key_store.py`
  - 持久化单一 Ed25519 keypair：`{deviceId, publicKey, privateKey, createdAt}`，0600 JSON，
    tempfile+原子 rename；惰性生成；**不写 deviceToken**。副本各自一份（path 可含 replica 标识
    或按副本 volume 分离；不配对故 deviceId 无需跨副本一致）。
- `agent-server:app/infra/openclaw/gateway_client_adapter.py`
  - 实现 Gateway WS client：`connect.challenge` → signed `connect`（`auth` 用配置的 token 或 password
    - device + read+write scopes）→ `helloOk`（无 deviceToken，忽略 auth）→ 跳过 pairing；
      pending req/res（自有 correlation id 路由）、event queue、close cleanup；shared secret
      失效/连接失败指数退避重连。**无 PAIRING_REQUIRED 处理、无 token reload**。
- `agent-server:app/infra/openclaw/gateway_client_manager.py`
  - 进程级共享 chat upstream 连接 + 事件 fan-out；`ensure_started()` lazy 或 eager（按
    `gateway_upstream_required`）；断线统一重连；每副本进程独立连接，不跨副本协调；upstream
    close/reconnect 时把本副本 in-flight run 标 degraded（tool 事件丢失，delta/final/error 仍转）。
    注册为 `providers.Singleton`，`close()` 加入 `cleanup_container`。
- `agent-server:app/services/openclaw_bridge_service.py`
  - target 授权（session=DB owner 查询；service=DB 存在性）、agentId 解析（workspace-api bindings
    - 默认派生，30-60s 缓存，fail-closed 不回退）、agents.list 全量快照存在性校验（60s TTL，
      fail-closed）、target-scoped namespace、method policy、runId 双向翻译、sessionKey↔clientSessionId
      映射、idempotencyKey 重写、响应过滤、event 过滤。
- `agent-server:app/api/dependencies/authentication.py` + 新增 `websocket_authentication.py`
  - 抽纯核心 `resolve_principal_from_auth_context(headers, cookies, path, auth_service,
identity_service, settings) -> Principal`；HTTP wrapper（现有，失败 HTTPException）+
    WS wrapper（失败 `close(4001)`）复用核心。WS 不依赖 X-Target-\* header（浏览器设不了）。
- `agent-server:app/api/v1/controllers/openclaw_bridge_controller.py`
  - 新增 `/api/v1/openclaw/ws` WebSocket endpoint：认证（4001）、`bridge.connect` 握手（4003/4008）、
    取共享 chat client、`bridge.hello`、处理 browser request（重写 sessionKey/runId）与 filtered
    upstream event（翻译回前端）。
- `agent-server:app/api/v1/router.py` + `app/api/factory.py`
  - include bridge router；wire controller dependencies；`cleanup_container` 加 gateway manager
    close。
- `agent-server:app/common/containers/clients.py` + `services.py`
  - 注册 Gateway manager、adapter、device key store、bridge service provider。
- `agent-server:pyproject.toml`
  - 显式声明直接依赖 `websockets`（已是传递依赖，显式 pin）。
- `agent-frontend:src/utils/openclawBff/*`（types.ts / client.ts / index.ts）
  - 轻量 BFF WS client：WS URL `/api/v1/openclaw/ws`（无 target query）；先发 `bridge.connect`；
    维护 pending request；dispatch event；runId/sessionKey 用 BFF 返回值（前端只见 frontRunId/
    clientSessionId）；close cleanup。
- `agent-frontend:vite.config.ts`：`/api` proxy 显式 `ws: true`。
- `agent-frontend:.env.example`：增 `VITE_OPENCLAW_BFF_WS_PATH=/api/v1/openclaw/ws`。
- `agent-frontend:tsconfig.tests.json`：include 增 `src/utils/openclawBff/*` 与测试文件。
- **生产部署**：agent-server env `OPENCLAW__GATEWAY_PASSWORD`（secret，不入日志，对齐现网
  `auth.mode=password`）；Gateway **配置零改动**（现网 password 模式 + `OPENCLAW_GATEWAY_PASSWORD`
  已在用）；Traefik 现有 `PathPrefix(/api/v1)` 覆盖 `/api/v1/openclaw/ws` 且 v2 默认 WS upgrade——
  列为 M0 验收项（确认无更高优先级 router 抢占 + `Upgrade: websocket` 到达 agent-api）；双副本共享
  同一 password。

## Implementation Steps

### Phase 0: Gateway —— 无改动

shared-token skipPairing、并发连接、method scopes 均为既有行为，`server.auth.test.ts:1101-1167`
已覆盖。**不实现任何 Gateway 改动、不新增 Phase 0 测试**。原"三情况 auth gate 改造"、"已配对
信任锚点"语义、"远程手动配对 smoke"全部砍掉。

### Phase 1: agent-server 配置与常量

1. **增加 Gateway 配置** — `app/common/settings/openclaw.py`：`gateway_url`、`gateway_token`/
   `gateway_password`（恰一非空校验）、`gateway_client_id`、timeout、`gateway_device_key_path`、
   `gateway_environment`、dev default target、`gateway_upstream_required`。Risk: Low。
2. **定义 Bridge 常量** — `app/common/constants/openclaw_gateway.py`：protocol version、scopes、
   allowlist、denied prefixes、targetKind、namespace 片段、clientSessionId 正则、`bff-` 前缀、
   bridge event、close codes。Risk: Low。
3. **补 settings 测试** — `app/test/unit_test/common/settings/test_openclaw_settings.py`：覆盖
   默认值与 env 解析（`OPENCLAW__GATEWAY_*`）。Risk: Low。

### Phase 2: Gateway shared-token client

1. **定义 upstream port** — `app/common/ports/openclaw_gateway_port.py`：frame DTO、connect
   options、request error。Risk: Low。
2. **实现 Ed25519 device auth** — `app/infra/openclaw/gateway_device_auth.py`：v2 payload 字段
   顺序逐项一致、raw 公钥 base64url、deviceId=sha256(raw).hex()、签名 base64url、nonce、payload
   token 段（token 模式=shared token / password 模式=空串）。Risk: High。
3. **实现 device key store** — `app/infra/openclaw/gateway_device_key_store.py`：单一 keypair
   0600 JSON、tempfile+rename、惰性生成、**不写 deviceToken**。Risk: Low。
4. **实现 upstream WS adapter** — `app/infra/openclaw/gateway_client_adapter.py`：
   `connect.challenge`→signed connect（配置的 token/password+device+read+write）→`helloOk`（无
   deviceToken）→跳过 pairing；pending req/res（correlation id 路由）；event queue；close cleanup；
   shared secret 失效退避重连。**无 pairing/token reload 逻辑**。Risk: High。
5. **实现进程级 client manager** — `app/infra/openclaw/gateway_client_manager.py`：共享 chat
   upstream、`ensure_started()` lazy/eager、断线重连、event fan-out、in-flight run 标 degraded。
   Risk: High。
6. **增加 adapter/manager 单测** — `app/test/unit_test/infra/openclaw/test_gateway_client_adapter.py`：
   fake ws server 覆盖 challenge、payload 字段顺序快照、deviceId 派生、shared-token connect、
   request resolve、event queue、close cleanup、reconnect。Risk: Medium。

### Phase 3: Bridge target and authorization service

1. **实现 target resolver** — `app/services/openclaw_bridge_service.py`：session principal（direct
   校验 targetId==feishu_open_id；group 走 owner DB 查询）；service principal（显式/默认 target；
   direct→UserIdentity 存在性，group→ManagedGroup enabled）。Risk: High。
2. **实现 agentId 解析与存在性校验** — 同文件：经 `WorkspaceOpenClawConfigClient` 查 bindings
   honor 覆盖、否则默认派生（复用 `_bound_agent_id` 语义）；30-60s 缓存；workspace-api 不可用
   fail-closed 不回退；agents.list 全量快照 60s TTL 校验，未配置 `TARGET_AGENT_NOT_PROVISIONED`。
   Risk: High。
3. **实现 target-scoped namespace helper** — 同文件：`hash16(tenant_key:identityId:targetKind:
targetId)`、sessionKey 构造、ownership 校验、clientSessionId 规范化。Risk: High。
4. **实现 method policy + runId/sessionKey 重写** — 同文件：allowlist；`chat.*`/`sessions.*`
   参数校验/重写（sessionKey 重写、idempotencyKey→`bff-<namespace>-<frontRunId>`、chat.abort
   runId 重写）；双向翻译表（frontRunId↔gatewayRunId、clientSessionId↔sessionKey）；denied
   prefixes。Risk: High。
5. **实现响应和事件过滤** — 同文件：过滤 `sessions.list/preview`；按 sessionKey/namespace 过滤
   `chat/agent` event；映射回前端。Risk: High。
6. **增加 service 单测** — `app/test/unit_test/services/test_openclaw_bridge_service.py`：DM、
   private group（owner 命中/未命中）、API key target（存在/不存在/默认）、binding 覆盖（honor/
   默认/workspace-api 不可用 fail-closed）、agents.list 校验（命中缓存/未配置拒绝/快照失败
   fail-closed）、allow/deny、sessionKey/runId 重写与双向翻译、sessions 过滤、event 过滤。
   Risk: Medium。

### Phase 4: agent-server WebSocket endpoint

1. **重构 WS 鉴权** — `app/api/dependencies/authentication.py` + `websocket_authentication.py`：
   抽 `resolve_principal_from_auth_context(headers, cookies, path, ...)`；HTTP/WS wrapper 复用；
   WS 失败 `close(4001)`。Risk: Medium。
2. **新增 bridge controller** — `app/api/v1/controllers/openclaw_bridge_controller.py`：`/openclaw/ws`；
   认证（4001）；`bridge.connect` 握手（target 校验/agent 解析/存在性校验失败 4003/4008）；取共享
   chat client；发 `bridge.hello`；处理 browser request（重写）与 filtered event（翻译回）。
   Risk: High。
3. **接入 router/DI/cleanup** — `app/api/v1/router.py`、`app/api/factory.py`、
   `app/common/containers/cleanup.py`：include router、wire deps、gateway manager close。Risk: Medium。
4. **注册 container providers** — `clients.py`、`services.py`：gateway manager、adapter、key store、
   bridge service。Risk: Medium。
5. **增加 controller 测试** — `app/test/unit_test/api/test_openclaw_bridge_controller.py`：未登录
   4001、bridge.connect hello、private group 授权、API key target、拒绝方法、filtered event 下发、
   runId/sessionKey 翻译。Risk: Medium。

### Phase 5: agent-frontend BFF client

1. **新增 BFF client 类型** — `src/utils/openclawBff/types.ts`：target、req/res/event、bridge
   connect/hello、client options。Risk: Low。
2. **实现 BFF WS client** — `src/utils/openclawBff/client.ts`：WS URL（无 target query）；先发
   `bridge.connect`；pending request；event dispatch；runId/sessionKey 用 BFF 返回值；close cleanup。
   Risk: Medium。
3. **导出 client** — `src/utils/openclawBff/index.ts`：barrel。Risk: Low。
4. **更新 dev proxy/env/tests include** — `vite.config.ts`（`ws:true`）、`.env.example`、
   `tsconfig.tests.json`。Risk: Low。
5. **增加前端 client 测试** — `tests/openclaw-bff-client-regression.test.ts`：fake WebSocket 覆盖
   bridge.connect、hello、request resolve/reject、event dispatch（runId 翻译）、close cleanup。
   Risk: Low。

## Testing Strategy

- OpenClaw Gateway：**无需新增测试**（shared-token skipPairing 已由 `server.auth.test.ts:1101-1167`
  覆盖）。若要固化 M0 连接形态（shared token+签名设备+read+write→connected, skipPairing, 无
  deviceToken），可在该文件补一条断言用例（可选）。
- agent-server unit：
  - `cd /Users/jiaoguo/github/agent-server && uv run pytest app/test/unit_test/common/settings/test_openclaw_settings.py`
  - `cd /Users/jiaoguo/github/agent-server && uv run pytest app/test/unit_test/infra/openclaw/test_gateway_client_adapter.py`
  - `cd /Users/jiaoguo/github/agent-server && uv run pytest app/test/unit_test/services/test_openclaw_bridge_service.py`
  - `cd /Users/jiaoguo/github/agent-server && uv run pytest app/test/unit_test/api/test_openclaw_bridge_controller.py`
- agent-frontend unit：
  - `cd /Users/jiaoguo/github/agent-frontend && npm run type-check`
  - `cd /Users/jiaoguo/github/agent-frontend && tsc -p tsconfig.tests.json && node --test tests/openclaw-bff-client-regression.test.ts`（并加 `npm run test:openclaw-bff`）
- manual smoke（shared-secret，dev，拓扑无关——容器/宿主均可，skipPairing 不检查 loopback）：
  - Gateway 配 `auth.mode=password`+password（对齐现网）；启动 OpenClaw Gateway 与 `agent-server`
    （`OPENCLAW__GATEWAY_PASSWORD` 同值）。另用 `auth.mode=token`+`OPENCLAW__GATEWAY_TOKEN` 各跑一遍，
    两种凭据路径都要验（payload token 段空串 vs token 值）。
  - 首次连接：shared token + 签名设备 → skipPairing 直通，验证 keypair 落盘
    （`/app/data/openclaw/gateway-device-key.json`，无 deviceToken）、upstream 获得 read+write 权限。
  - 用已登录浏览器连接 `/api/v1/openclaw/ws`，发 `bridge.connect{targetKind:direct, targetId:<feishuOpenId>}`。
  - 验证收到 `bridge.hello`（含 agentId=feishu-<openId>），发 `health`、`chat.send`（frontRunId）
    能得到 response/event（runId 回传为 frontRunId）。
  - 切到 `targetKind=group, targetId=oc_xxx`，验证只能访问当前用户 private group；对未配置 agent
    的 target 返回 `TARGET_AGENT_NOT_PROVISIONED`；对 binding 覆盖的 target 验证 agentId 为覆盖值。
  - API key 调试：`wscat -H "X-API-Key: ..." ws://.../api/v1/openclaw/ws`，显式 target 验证。
- manual smoke（生产协调，部署前验证）：
  - Traefik `PathPrefix(/api/v1)` 覆盖 `/api/v1/openclaw/ws`，确认无更高优先级 router 抢占、
    `Upgrade: websocket` 到达 agent-api。
  - 双副本（replicas=2）共享同一 password，各持一条 upstream，并发浏览器连接分别落到两副本均正常。
  - 验证 password 轮换 + 滚动重启后旧 password 连接被拒、新 password 连接通过（封禁语义）。**注意爆炸半径：
    此 secret 现被 Control UI 人类用户（clawgateway.otr-tx.com）共用，轮换会一并踢掉所有 Control UI 用户，
    轮换需协调控制台用户重新登录。**

## Risks & Mitigations

- **Risk（高权，已重新评估）**: shared secret（token/password）泄露即获 **operator 全权**——scopes 是自声明、自签名，
  Gateway 对 shared-auth 客户端**不约束 scopes**（`server.auth.test.ts:1152-1164`：同一 shared secret +
  自生成 keypair 声明 `operator.admin` → connect.ok、无 pairing）。read+write 仅是 agent-server 自律。
  泄露面覆盖任意自声明 scopes（含 `config.*`、`chat.inject`、`sessions.delete`、`device.pair.*`）。
  封禁粒度全局，且此 secret 现被 Control UI 人类用户（clawgateway.otr-tx.com）共用，轮换会踢掉所有控制台用户
  （不是纯机器凭据）。
  - Mitigation: secret 视为长驻高权凭据（env/secret manager，不入日志/crash dump/access log）；
    轮换 runbook 写明爆炸半径（Gateway+agent-api 滚动重启 + Control UI 用户重新登录协调）；按 operator
    全权级别定审计与告警（监控 secret 访问、异常 scope 申明、非预期 method 调用）；BFF 层仍强制 per-user
    隔离（secret 泄露不直接暴露用户 session，但暴露 Gateway 级 operator 访问）。
- **Risk**: agentId 解析依赖 workspace-api HTTP；不可用时 BFF 无法 honor binding 覆盖。
  - Mitigation: 30-60s 缓存降低调用；workspace-api 不可用 **fail-closed 不回退默认 id**（避免打
    错 agent）；返回 503 让前端提示暂不可用。
- **Risk**: agents.list 快照过期导致新配置 agent 被误拒，或拉取失败 fail-closed 阻断新 chat。
  - Mitigation: 60s TTL（新 agent 最多 60s 后可见）；快照失败拒绝该 target（非全局）；已缓存命中
    放行。可接受短暂数据一致延迟。
- **Risk**: upstream 重连导致 in-flight run 的 tool/agent 事件丢失（connId 路由）。
  - Mitigation: M0 接受丢失，BFF 标 run degraded（delta/final/error 仍可达）；M1 再做 runId→sessionKey
    映射 + 重连后按新 connId 重新注册 tool event recipient。
- **Risk**: 裸转发导致用户枚举全部 OpenClaw sessions。
  - Mitigation: M0 强制 target-scoped namespace；`sessions.list/history/send/abort` 全部过 service policy。
- **Risk**: upstream event 泄露其他用户 run 状态（两副本均收全部广播）。
  - Mitigation: 所有 `chat`/`agent` event 按 `payload.sessionKey` 解析 namespace 过滤；无 sessionKey
    默认拒绝。namespace 含 identityId+target 唯一，无跨连接串话。
- **Risk**: `chat.send` 的 idempotencyKey 是 Gateway 全局 dedupe key，跨用户碰撞取 cached ack /
  伪造 runId 归属。
  - Mitigation: BFF 重写为 `bff-<namespace>-<frontRunId>`，双向翻译；不透传前端原值。
- **Risk**: DB 里存在但 openclaw.json 未配置的用户/群 → Gateway 静默建野 agent。
  - Mitigation: BFF agents.list 全量快照校验 + binding 解析，未配置 fail-closed 拒绝。
- **Risk**: API key 调试入口绕过用户边界。
  - Mitigation: service principal 独立 namespace（service_id）；必须显式或配置 target；不能默认进
    用户 DM；DB 存在性校验。
- **Risk**: Python Ed25519/device payload 与 OpenClaw TS 实现不一致。
  - Mitigation: 固定 payload 字段顺序单测 + deviceId 派生单测；manual smoke 验证真实 Gateway connect。
- **Risk**: 生产 Traefik 未正确路由 WS upgrade。
  - Mitigation: M0 验收项确认 `PathPrefix(/api/v1)` 覆盖 + 无更高优先级 router + Upgrade 头到达
    agent-api；manual smoke 验证。
- **Risk**: 浏览器 WS 鉴权依赖同源 cookie；生产 WS URL 非同源或 cookie scope 不覆盖则不带 cookie。
  - Mitigation: 生产 WS 走同源（Traefik 前置）；cookie scope 覆盖 agent-api 域。

## Success Criteria

- [ ] 浏览器只连接 `agent-server /api/v1/openclaw/ws`，不读取 shared secret（token/password）或 Ed25519 私钥。
- [ ] `agent-server` 用 shared secret（`gateway_token`/`gateway_password` 恰一非空，现网=password）+
      持久 Ed25519 keypair（read+write scopes）连接 Gateway，`skipPairingForOperatorSharedAuth` 直通，
      永不配对、不持 deviceToken；Gateway 零改动。
- [ ] 重启用持久 keypair + shared secret 直连；封禁 = 轮换 shared secret + 滚动重启（旧凭据连接被拒）。
      runbook 写明此 secret 被 Control UI 用户共用，轮换需协调控制台用户重新登录。
- [ ] 未认证 WebSocket 被 close 4001；已认证连接 `bridge.connect` 后收到 `bridge.hello`。
- [ ] 飞书 session 用户可连接自己的 DM（direct, feishuOpenId）和 `/workspaces/me` 返回的 private
      groups（group, groupId）；service principal 用 service namespace + 显式/default target（DB 验证）。
- [ ] BFF honor `bindings[].agentId` 覆盖（经 workspace-api）；workspace-api 不可用 fail-closed；
      agents.list 校验未配置 target 被 `TARGET_AGENT_NOT_PROVISIONED` 拒绝（fail-closed）。
- [ ] M0 allowlist 外的方法被拒绝，不转发到 OpenClaw。
- [ ] 普通用户只能访问自己 target-scoped namespace 下的 sessionKey；webui 会话与飞书会话互不可见。
- [ ] `sessions.list` 和 `chat`/`agent` event 都经过 target + namespace 过滤。
- [ ] `chat.send/history/abort` 能通过 bridge 往返：runId 经 BFF 双向翻译（前端只见 frontRunId），
      sessionKey 映射 clientSessionId，chat.abort runId 重写。
- [ ] upstream 重连时 in-flight run 标 degraded（tool 事件丢失可接受），delta/final/error 仍转。
- [ ] 生产 Traefik WS upgrade 路由验证通过；双副本共享 shared token 各持 upstream。
- [ ] OpenClaw Gateway（无新增）、agent-server、agent-frontend targeted tests 通过。

## Deferred

- approvals/admin profile：M0 不需要独立 keypair/pairing（无 pairing）；未来若需独立 scope，只需
  声明 `operator.approvals`/`operator.admin` 的连接（仍 shared-token + 签名设备），不必独立身份。
- pairing/admin 管理 UI（M0 无 pairing，不适用）。
- "在网页接续飞书对话上下文"（读写 `agent:<id>:main` / 飞书 session）：需 deliver 语义 + 双端并发
  写 transcript 风险评估，M0/M1 明确不做。
- upstream 重连后 tool event 重新订阅（runId→sessionKey 映射 + 按 connId 重注册）——M1。
- OpenClaw protocol TS/Python codegen。
- 前端 chat UI、Zustand store、React hooks。
- workspace-files plugin 和 Files 面板。
