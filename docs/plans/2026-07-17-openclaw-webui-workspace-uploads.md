# Implementation Plan: OpenClaw WebUI Workspace Uploads

## Overview

将 WebUI 入站附件从 Base64 WebSocket 内联改为浏览器直传私有 OSS。BFF 负责会话归属、对象元数据和上传授权，OpenClaw Gateway 根据受信 sessionKey 将对象流式校验后原子写入对应 Agent workspace，再把受限的 workspace 相对路径加入 `chat.send`。

## Requirements

- 前端支持图片、PDF、Office、文本与常用数据文件，默认单文件上限 100 MiB。
- 文件字节不经过 BFF WebSocket 和 OpenClaw transcript。
- 上传对象必须绑定当前 principal、target 和 client session，浏览器不能指定 sessionKey、object key 或 workspace path。
- Gateway 必须自行解析 Agent workspace，并校验文件大小、SHA-256、路径边界和下载超时。
- Agent 收到稳定的 workspace 相对路径，可用 `read`、`exec`、图片理解等能力处理。
- 现有 Base64 `chat.send` 客户端和 WebUI 输出 Artifact 下载保持兼容。

## Architecture Changes

- `agent-server/app/core/entities/openclaw/artifacts.py`：为 OSS 文件行增加 `input/output` 方向、可选 MD5 和 workspace 相对路径。
- `agent-server/app/services/openclaw_artifact_service.py`：增加浏览器入站附件 init/complete/abort/resolve，复用现有 PUT、HEAD、quota 和 binding。
- `agent-server/app/api/v1/controllers/openclaw_bridge_controller.py`：在现有 WebSocket bridge 内处理 `attachments.init|complete|abort`，并在 `chat.send` 前把附件 ID 解析为受信 workspace descriptor。
- `openclaw-integration/src/gateway/server-methods/chat.ts`：增加 `chat.attachment.materialize`，流式下载 OSS 对象并写入 session 对应 Agent workspace。
- `openclaw-integration/src/gateway/chat-attachments.ts`：接受 BFF 解析后的 workspace 文件描述符，并向 Agent 正文追加可信路径说明；保留 Base64 图片兼容路径。
- `agent-frontend/src/features/openclaw-bff/`：增加 OSS 上传 adapter、100 MiB 前端预检、通用附件 UI 和 attachment ID 发送。

## Implementation Steps

### Phase 1: OpenClaw Workspace Boundary

1. **新增 Gateway 物化实现**（Files: `src/gateway/chat-attachment-materialize.ts`, `src/gateway/server-methods/chat.ts`）
   - Action: 校验 WebUI session key、解析 Agent workspace、SSR​​F-safe 下载、流式限制 100 MiB、SHA-256 校验、临时文件原子 rename。
   - Why: workspace 归属必须由 OpenClaw 配置决定，不能由 BFF 拼路径。
   - Dependencies: None.
   - Risk: High；涉及网络输入和文件系统边界。

2. **扩展 chat attachment descriptor**（Files: `src/gateway/chat-attachments.ts`, `src/gateway/server-methods/attachment-normalize.ts`）
   - Action: 支持 `workspace_file`，只允许 `uploads/webchat/` 下的相对路径，并将文件信息加入 Agent 输入。
   - Why: 防止浏览器或 BFF 注入任意宿主路径。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **补协议、scope 与测试**（Files: `src/gateway/protocol/schema/logs-chat.ts`, `src/gateway/method-scopes.ts`, `src/gateway/server-methods-list.ts`, colocated tests）
   - Action: 为物化方法增加 schema、write scope、方法清单和失败场景测试。
   - Why: Gateway method 必须 schema-first、默认拒绝且可定向验证。
   - Dependencies: Steps 1-2.
   - Risk: Low.

### Phase 2: BFF Ownership and OSS Lifecycle

1. **扩展 Artifact 数据模型**（Files: `app/core/entities/openclaw/artifacts.py`, PO/repository/port, `migrations/versions/013_*.py`）
   - Action: 增加 direction、workspace_path，MD5 改为可选；输出列表仅返回 output。
   - Why: 输入上传需要持久化归属和重连恢复，且不能混入输出产物列表。
   - Dependencies: None.
   - Risk: High；涉及数据库迁移与现有 M2 兼容。

2. **实现入站上传服务**（File: `app/services/openclaw_artifact_service.py`）
   - Action: init 生成 OSS PUT grant；complete 做 HEAD 对账、请求 Gateway 物化、记录 workspace_path 并删除临时 OSS 对象；resolve 校验当前 binding scope。
   - Why: 所有浏览器输入必须经 BFF 归属校验，浏览器只持附件 ID。
   - Dependencies: Phase 1, Step 1.
   - Risk: High；需保证失败时 OSS 与 DB 状态可清理。

3. **接入 WebSocket bridge**（Files: `app/api/v1/controllers/openclaw_bridge_controller.py`, `app/services/openclaw_bridge_service.py`, constants）
   - Action: 本地处理 `attachments.init|complete|abort`；`chat.send` 前将附件 ID 解析成受信 descriptor；hello 暴露能力和上限。
   - Why: 避免新增旁路 REST 客户端和 OpenAPI 生成链。
   - Dependencies: Phase 2, Steps 1-2.
   - Risk: Medium.

### Phase 3: Frontend Direct Upload

1. **实现 attachment adapter**（Files: `src/features/openclaw-bff/adapters/OpenClawWorkspaceAttachmentAdapter.ts`, chat hook/types）
   - Action: 文件选择后保留本地 File；发送时计算 SHA-256、调用 init、PUT OSS、complete，最终只向 `chat.send` 传 attachment ID。
   - Why: 文件字节不进入 WebSocket 或 transcript。
   - Dependencies: Phase 2, Step 3.
   - Risk: Medium；需处理 CORS、上传失败和取消。私有 OSS 桶必须为前端正式/测试源及本地开发源配置 `PUT/GET/HEAD`，并允许 `Content-Type`、`Content-MD5`、`x-oss-meta-sha256` 请求头。

2. **更新 Composer UI**（File: `OpenClawAssistantThread.tsx`）
   - Action: 接受允许的通用文件类型、显示文件名/大小/错误，前端预检 100 MiB；图片仍可预览。
   - Why: 当前 UI 仅支持单张 Base64 图片。
   - Dependencies: Phase 3, Step 1.
   - Risk: Low.

3. **保持失败恢复**（Files: `useOpenClawChat.ts`, `OpenClawChatScreen.tsx`）
   - Action: retry 保留 attachment ID；连接恢复后从数据库重新解析；明确不可重试错误。
   - Why: 上传完成与 chat.send 是两个阶段，必须允许安全重试。
   - Dependencies: Phase 3, Steps 1-2.
   - Risk: Medium.

## Testing Strategy

- OpenClaw unit：路径穿越、非 WebUI session、超限、HTTP 失败、SHA 不一致、原子落盘、workspace descriptor 注入。
- BFF unit：principal/session scope、input/output 列表隔离、HEAD 不一致、Gateway 失败、重连 resolve、迁移字段。
- Frontend component：大小预检、init/PUT/complete 顺序、chat.send 不含 Base64、失败提示和 retry。
- E2E：上传 PNG、CSV、Markdown/PDF；确认 OSS 临时对象完成后删除、workspace 文件存在、transcript 不含 Base64、Agent 可读取并生成可下载产物。
- 部署验证：确认 OSS CORS 已生效；用浏览器原生文件选择器完成一次真实 PUT，检查 BFF `input/ready` 记录、0600 workspace 文件和 OSS 临时对象删除。

## Risks & Mitigations

- **SSRF 或任意文件写入**：Gateway 使用 SSRF guard，只接受 BFF 签名 URL；目标路径完全由 sessionKey、artifactId 和安全文件名构造。
- **大文件内存放大**：浏览器直传 OSS；Gateway 流式写盘并增量 hash，不在 BFF/Gateway 构造完整 Buffer。
- **孤儿对象/文件**：pending TTL 清理 OSS；complete 失败保留可重试状态；成功物化后删除临时 OSS 对象。
- **历史兼容**：保留 Base64 图片 parser；既有 output artifact 行迁移为 `direction=output`。
- **多副本一致性**：附件归属和 workspace_path 存 PostgreSQL，不依赖 WebSocket 进程内状态。

## Success Criteria

- [x] 100 MiB 以内允许类型可直传，超过上限在前端与 BFF 双重拒绝。
- [x] `chat.send` 和 transcript 不包含文件 Base64。
- [x] 文件只落在当前 Agent workspace 的 `uploads/webchat/<clientSessionId>/`。
- [ ] 浏览器无法引用其他 principal、target、session 或任意 workspace 路径。
- [x] Agent 能读取上传文件；输出 Artifact 下载仍由既有链路处理。
- [x] 现有图片 Base64 客户端和输出 Artifact 回归通过。
