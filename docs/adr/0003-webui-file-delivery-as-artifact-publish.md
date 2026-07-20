# WebUI 文件交付走 artifact 发布 + 私有 OSS 直传，而非 channel 投递或临时 media

Status: accepted (2026-07-15)

M2 需要让父 WebUI 会话中的 agent 把 workspace 内的本地文件交给当前网页用户，且刷新后可恢复下载。我们决定新增独立工具 `webui_artifact_publish`（由 `extensions/webui-artifacts` 提供）+ 三段式协议：扩展凭 `X-API-Key`（新建非管理员 SERVICE `openclaw-artifact-extension`，BFF 按 `api_keys` 表 HMAC hash + 精确 `service_id` 校验）向 BFF `init` 换取短时预签名 PUT URL（签 `Content-MD5`/`Content-Type`/`x-oss-meta-sha256`）→ 从宿主机流式直传私有 OSS → `complete` 时 BFF HEAD 强校验 size/ETag-MD5/sha256；浏览器只收到 opaque artifact DTO，经 BFF 登录态 HTTP `artifacts.list`/`download`（302 到短时预签名 GET）取回。文件内容不经过 Gateway WebSocket、chat transcript 或 BFF Python 内存；`artifacts.list` + DB 状态是恢复真相源，`artifact.available` 事件只负责即时性。细节（授权绑定、默认限额、宿主机拓扑、Redis binding、size 校验）见 [2026-07-15 M2 执行计划](../plans/2026-07-15-openclaw-m2-multi-session-subagent-skills.md) D6/D7/D8。

> 2026-07-15 二轮 `/interview`（核对 agent-server / agent-frontend 源码后）修正：内部鉴权由"单 service token / 两处存放"改为**复用 `x-api-key`→`api_keys` 签发机制**（新建 `openclaw-artifact-extension`，BFF 不存 raw key、轮换零改动）；session binding 由内存改为**窄 Redis binding + 有界 TTL 宽限**；presigned PUT **协议层无法钉死 body size**，改"签名 Content-MD5 上传校验 + complete HEAD 强校验 size/ETag-MD5/sha256"；配额 `init` 硬拦 `409`。

## Considered Options

1. **扩展 `message(channel="webchat", target=...)` 复用消息投递（被否决）**：`webchat` 在 `src/utils/message-channel.ts` 中是 `INTERNAL_MESSAGE_CHANNEL`，`listDeliverableMessageChannels()` 刻意不含它，`route-reply` 明确拒绝把 queued reply 路由到 WebChat；`gateway-client` 是 Gateway 连接身份而非接收者。走这条路要把"浏览器 surface"塞进外部投递 channel 模型，污染 outbound resolver 语义，且 WebChat final dispatcher 只收集非空文本，纯文件 payload 无法形成可恢复记录。
2. **复用临时 media store 中转（被否决）**：`src/media/store.ts` 默认 5 MB 上限、TTL 2 分钟，URL 无按用户鉴权——满足不了大文件、刷新恢复和权限下载。
3. **文件经 Gateway WS / BFF 内存中转（被否决）**：现成 `IResourceStorage.upload(data: bytes)` 整文件入内存；bff-server 是 reduced runtime 单副本、不挂 workspace volume，大文件会同时压垮共享 WS 连接和 Python 进程。
4. **提前 M4 的 workspace-files 浏览面板代替（被否决）**：浏览面板解决"用户去拉文件"，不解决"agent 主动交付 + 会话时间线内出现可恢复文件卡"；两者是不同产品动作，M4 后续收窄为浏览/上传定位。

## Consequences

- `webchat` 维持非可投递渠道；WebUI 接收者由 BFF **Redis session binding**（不可逆摘要 key，存 `{principal, targetKind, targetId, clientSessionId, agentId}`，有界 TTL 宽限支持迟到发布；`complete/abort` 不依赖 binding）定义，channel 模型零改动。
- 新增持久面：artifact DB 表（bff/agent-server Postgres + alembic）、OSS `openclaw-artifacts/` 前缀（复用现有私有 bucket）、`extensions/webui-artifacts`、bff-server artifact 路由（浏览器侧走 Traefik 新增 `/api/v1/openclaw/artifacts` 路由；internal init/complete 只在宿主机 `127.0.0.1:8303`，因为 Gateway 跑在宿主机而非容器）。
- M2 只允许父 WebUI 会话发布；子 agent、外部 channel、CLI default deny——子 agent 产物需回到父 agent 再显式发布。
- 鉴权复用 `x-api-key`→`api_keys` 签发机制：新建非管理员 SERVICE `openclaw-artifact-extension`，raw key 只存扩展侧，BFF 仅按 DB HMAC hash + `service_id` 校验；轮换走 `auth rotate-api-key`、BFF 零改动。凭据、object key、预签名 URL 不进 WS 事件、history、日志和前端持久状态。
- presigned PUT 协议层无法钉死 body size：用签名 `Content-MD5`（OSS 上传时校验内容）+ 扩展字节计数器 + complete HEAD 强校验 size/ETag-MD5/sha256 收口（单段 PutObject，ETag 即内容 MD5）；配额 `init` 硬拦 `409 ARTIFACT_SESSION_LIMIT_REACHED`（`pending+ready` 原子计数、`(sessionRef, sourceToolCallId)` 唯一约束）。
- 未来若做"飞书同款文件发送"或 M4 下载鉴权，应评估复用本 artifact 通道，而不是给 `message` 工具加 WebUI 分支。
