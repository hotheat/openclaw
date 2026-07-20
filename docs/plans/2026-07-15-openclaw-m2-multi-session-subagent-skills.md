# M2 执行计划：多会话 + 子 agent 活动 + 技能回显 + WebUI 文件交付

- 日期：2026-07-15
- 状态：已完成。Phase A-H、定向测试、migration、三仓测试环境部署与最终真机验收均已完成；测试期间暴露的扩展专用 API key 已轮换，对象存储 AccessKey 的云侧轮换仍由基础设施所有者执行。
  - 第一轮 2026-07-15 grill-with-docs 定案 8 条（artifact 属 M2、D7 宿主机拓扑、D8 默认值、M1 遗留分流、归档 60 分钟、OSS 复用 bucket + `openclaw-artifacts/` 前缀、子面板右侧面板、`bridge.hello.features`）。
  - 第二轮 2026-07-15 `/interview`（逐行核对 agent-server / agent-frontend 源码后）修正/收敛 7 条：
    1. **内部鉴权改用现有 `x-api-key`→`api_keys` 机制**：新建非管理员 SERVICE 身份 `openclaw-artifact-extension`（`is_admin:false`）+ 精确 `service_id` 校验。取消原"单 service token / 两处存放 / 专用 header"方案；raw key 只存扩展侧（env/secret 注入，或 `openclaw.json` 插件段标 sensitive），BFF 不存 raw key、不读 openclaw.json 凭据，仅按 DB HMAC hash 校验 `X-API-Key`；轮换走 `auth rotate-api-key` 只更新扩展侧、BFF 零改动。
    2. **迟到发布引入 Redis session binding + 有界 TTL 宽限**（复用 BFF 已有 Redis client，非新基建）；`complete/abort` 不再依赖 binding（init 已建的 pending 在 pending TTL 内允许完成）；Redis 不可用→该连接 `features.artifacts=false`、聊天不受影响；list/download 永远按当前登录人重鉴。
    3. **assistant-ui 按 greenfield 集成**（非 spike+回退）：D5 改为集成验证任务；右侧面板改为**显式安装 `@radix-ui/react-dialog` 建 Sheet**（仓库无现成 Drawer/Sheet 可复用）；新增 `jsdom + @testing-library/react` 独立组件测试配置（不迁移现有 `node --test`）；`ChatMessageList/ToolCallGroup` 作迁移期基线、验收后删除（非回退路线）。
    4. **多会话并行 = 后台 run + 页面级 session activity registry**（稳定 `clientInstanceId`；`sessions.list` **无**活跃 run 字段，不可用于探测运行状态）；跨刷新全局运行状态进 backlog。
    5. **OSS presigned PUT 协议层无法钉死 body size**：改"init 签入 Content-MD5 + Content-Type + `x-oss-meta-sha256`（OSS 上传时即校验内容）+ complete HEAD 强校验 size/ETag-MD5/sha256"（单段 PutObject，ETag 即内容 MD5）。
    6. **配额 `init` 硬拦** `409 ARTIFACT_SESSION_LIMIT_REACHED`：`pending+ready` 计数、原子锁（禁无锁 count-then-insert）、`(sessionRef, sourceToolCallId)` 唯一约束、不 FIFO。
    7. **归档配置键实为 `agents.defaults.subagents.archiveAfterMinutes`**（默认 60）。运行时代码把 `<=0` 视为禁用，但当前 Zod schema 要求正整数，因此 M2 不把“设 0 禁用”作为可配置能力或验收条件。
  - 架构决策另见 [ADR-0003](../adr/0003-webui-file-delivery-as-artifact-publish.md)
- 取代：[2026-07-14-openclaw-m2-multi-session-tools-approvals.md](./2026-07-14-openclaw-m2-multi-session-tools-approvals.md)
- 上游文档：[webui_integration_milestones.md](../research/openclaw-frontend-integration/webui_integration_milestones.md) M2、[agent_frontend_webui_research.md](../research/openclaw-frontend-integration/agent_frontend_webui_research.md) §5
- 涉及仓库：当前 `openclaw-integration` + `~/github/agent-server` + `~/github/agent-frontend`
- 预估：1 名熟悉三仓链路的工程师，13.5~18.5 个工作日

## 0. 目标与非目标

### 目标

1. WebUI 支持私聊和当前用户有权访问、机器人可用的 private group；不支持公开群、未托管群或任意 group id。
2. 每个 target 支持多个独立 WebUI 会话，可新建、切换；会话按“私聊 / private group”分组。
3. 父会话调用 `sessions_spawn` 后，WebUI 展示子 agent 的状态、消息和工具活动；刷新后可恢复，子会话只读。
4. 父会话和子会话的工具卡片都能回显技能名称，例如“使用技能：planner”。
5. 父 WebUI 会话中的 agent 可把当前 workspace 内的本地文件发布为 artifact；浏览器展示可下载文件卡，刷新后可恢复。
6. 保留 M1 的隔离、重连、history 对账、foreign run、工具卡片和 Streamdown 行为。

### 非目标

- 不做 exec 审批。现网 `~/github/openclaw-workspace/openclaw.json` 已核实为 `tools.exec.security="full"`、`tools.exec.ask="off"`，M2 不申请 `operator.approvals`、不放行 `exec.approval.*`、不实现审批注册表或审批 UI。
- 不做群聊产品形态。M2 的 `targetKind="group"` 只表示用户自己的 private group 工作区入口。
- 不允许从 WebUI 向子会话发送消息、abort、steer、kill 或继续会话。
- 不做嵌套子 agent 树。当前部署未配置 `maxSpawnDepth`，按 OpenClaw 默认深度 1 验收。
- 不做会话搜索、改名/删除、每会话模型/思考等级、用户上传图片/文件、usage、Files 管理页、Cron、HTML 预览。
- 不允许子 agent 直接向 WebUI 发布 artifact；M2 只开放当前父 WebUI 会话。子 agent 产物需先回到父 agent，再由父 agent 显式发布。
- 不把 `webchat` 注册为可投递消息渠道，不把 `gateway-client` 解释为消息接收 target，也不改变飞书等外部渠道的 `message` 投递语义。
- 不新增“技能生命周期”协议。M2 只从已有工具调用中识别技能名称。
- 不做跨刷新的全局/跨会话运行状态。多会话的"并行"仅指 Gateway 后台 run 同时存在；运行态角标由**页面级 session activity registry** 维护（会话组件外存 `{target, sessionId, clientInstanceId, frontRunId, phase}`），刷新即丢失。`sessions.list` 无活跃 run 字段，不用于探测运行状态。跨刷新、跨 Tab 的全局活跃会话状态进 backlog（后续需在共享 Gateway/BFF 事件入口集中维护，不依赖 `sessions.list`、不在每个浏览器 binding 重复计数）。
- 不做前端可观测性埋点（delta 丢弃数/折叠触发/探测分布/收敛耗时）。该 M1 遗留项显式推迟为 M2 后独立小任务并记录于 milestones；S1 idempotencyKey 确认与 OBS-001 复核并入 Phase A，真机冒烟清单在 Phase H 固化。

## 1. 代码基线

| 能力                  | 已核实事实                                                                                                                                                                                                                                                                                                                                                                      | M2 影响                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target 入口           | `agent-frontend/src/features/openclaw-bff/screen/OpenClawChatScreen.tsx` 已从 query 读取 `targetKind/targetId`；`src/features/my-workspace/api.ts` 已通过 `/api/v1/workspaces/me` 取得 `privateGroups`                                                                                                                                                                          | 复用现有 workspace 数据，不在独立 BFF 进程新增 workspace HTTP 路由                                                                                                                                                         |
| 单会话常量            | `OPENCLAW_CHAT_SESSION_ID='main'` 在 4 处硬编码：`types/chat.ts:1` 常量、`api/chat-event-guards.ts` 两个守卫（`payload.sessionKey === 'main'`）、`hooks/useOpenClawChat.ts`（history 请求体 + `client.connect` + `validateHello` 拒绝非 `main`）；URL 无 session、无 target selector、chat 状态为本地 `useReducer`（非 Zustand）                                                | 把 session id 变成 hook 和事件守卫的显式参数，打通 4 处；session 进 URL query，切换通过 key 重建                                                                                                                           |
| BFF 隔离              | `agent-server/app/services/openclaw_bridge_service.py` 按 target namespace 拼父会话 key；`sessions.list` 强制父 agentId 并过滤 namespace                                                                                                                                                                                                                                        | 父会话列表沿用；子会话需单独授权，不能放宽 namespace 前缀                                                                                                                                                                  |
| 子 agent 创建         | `src/agents/subagent-spawn.ts` 生成 `agent:<targetAgentId>:subagent:<uuid>`；`src/agents/subagent-registry.ts` 持久化 requester/child/run/status/outcome                                                                                                                                                                                                                        | 子 agent 可能属于 `researcher` 等其他 agent，不能依赖父 agentId 或父 namespace 枚举                                                                                                                                        |
| 子 agent 工具事件     | tool event 只发给 `toolEventRecipients`；当前只在发起 `chat.send`/`agent` 的连接注册，`chat.history` 不注册                                                                                                                                                                                                                                                                     | BFF 连接看不到内部 `agent` 调用创建的子 run 工具事件，必须补 Gateway 只读发现接口和订阅注册                                                                                                                                |
| 子 agent 普通事件     | `agent` 事件全局广播，但 BFF `filter_event` 只接受 `payload.sessionKey == binding.session_key`                                                                                                                                                                                                                                                                                  | BFF 仅对已授权 child session/run 放行，禁止按 key 形状猜测                                                                                                                                                                 |
| 技能调用              | `src/agents/system-prompt.ts` 要求模型用 read 工具读取 `<skillsRoot>/<skill>/SKILL.md`；原生 skill command 也可能把 `skillName` 放入工具参数；没有独立 skill event                                                                                                                                                                                                              | 先做纯函数识别器，不改 Gateway 协议                                                                                                                                                                                        |
| `webchat` 语义        | `src/utils/message-channel.ts` 把 `webchat` 定义为 `INTERNAL_MESSAGE_CHANNEL`，但 `listDeliverableMessageChannels()` 只返回真实 channel；`src/auto-reply/reply/route-reply.ts` 明确拒绝把 queued reply 路由到 WebChat                                                                                                                                                           | 文件交付不能复用 `message(channel="webchat")`，否则会把客户端 surface 和外部投递 channel 混为一层                                                                                                                          |
| BFF 客户端身份        | `src/gateway/protocol/client-info.ts` 把 `gateway-client` 定义为 Gateway client id；它用于连接握手、设备身份和能力声明，不是 Feishu `user:openId` / `chat:chatId`                                                                                                                                                                                                               | `gateway-client` 继续只表示 BFF 上游连接身份；WebUI 接收者由 BFF session binding 决定                                                                                                                                      |
| Feishu 文件 outbox    | `~/github/openclaw-workspace/extensions/feishu-file-outbox-router/index.js` 只拦截 `before_tool_call(message)`，媒体键包含 `media/path/filePath/mediaUrls`；但 `isFeishuContext(ctx)` 仅按 `ctx.agentId.startsWith("feishu-")` 判断，未区分 `messageChannel` 或 WebUI session                                                                                                   | WebChat 绑定 Feishu agent 时，`message(filePath)` 可能被误分流到 Feishu outbox；M2 必须把 WebChat 文件交付限定到 `webui_artifact_publish`，并修正/测试 Feishu outbox 的 WebChat 跳过规则                                   |
| WebChat 纯媒体        | `src/gateway/server-methods/chat.ts` 的 WebChat final dispatcher 只收集非空文本，纯媒体 payload 不会形成可供浏览器恢复的文件记录                                                                                                                                                                                                                                                | 新增独立 artifact 合同，不把文件塞进 chat 文本或临时 media URL                                                                                                                                                             |
| 临时媒体存储          | `src/media/store.ts` 默认上限 5 MB、TTL 2 分钟                                                                                                                                                                                                                                                                                                                                  | 只适合短期媒体中转，不满足大文件、刷新恢复和权限下载                                                                                                                                                                       |
| agent-server OSS      | `app/common/ports/storage_port.py` 的 `IResourceStorage` 只有预签名 GET（`get_download_url`）和整文件 `upload(data: bytes)`；`app/infra/storage/oss_v2_storage.py` 用 `alibabacloud-oss-v2>=1.2.1`，已 `import models.PutObjectRequest`，`presign()` 是通用方法（现仅喂 `GetObjectRequest`，可喂 `PutObjectRequest` 生成上传 URL，已确认支持把 `Content-MD5` 纳入签名 headers） | 复用同一私有 OSS 配置；artifact 上传用 `PutObjectRequest` presign（签 Content-MD5/Content-Type/`x-oss-meta-sha256`）。⚠️ presigned PUT 协议层无法钉死 body size，size 由 complete HEAD 事后校验；不复用整文件 `bytes` 接口 |
| BFF 运行时            | reduced runtime 不加载 storage（`bff_server/container.py` 无 StorageContainer）；`docker-compose.yml` 中 `bff-server` 单副本、只挂载 OpenClaw 配置、无 workspace volume；bff 经 `OpenClawConfigFileAdapter` 读 openclaw.json（非 env 注入 artifact 凭据）；`OpenClawBridgeBinding` 与 `OpenClawGatewayClientManager` fan-out 均**内存**、单副本，无 Redis binding、无跨副本事件 | BFF 增加最小 artifact storage/元数据/鉴权依赖；新增**窄 Redis session binding repository**（复用已有 Redis client factory）；文件数据由 OpenClaw 扩展直传 OSS，BFF 不读 workspace 文件；多副本 fan-out 留 backlog          |
| agent-server 内部鉴权 | 无独立"内部 service token"；跨组件鉴权只有 `x-api-key`→`api_keys` 表（HMAC hash）→ SERVICE principal（`identity_service.build_principal_from_api_key`，Redis 缓存 60s）；签发/轮换/吊销走 `cli.main auth sync-services` / `create-api-key` / `rotate-api-key`                                                                                                                   | artifact init/complete/abort 复用该签发机制，新建非管理员 SERVICE `openclaw-artifact-extension`；BFF 仅按 DB hash 校验 + 精确 `service_id` 校验，不引入共享 token/专用 header                                              |
| 子 agent 归档         | `src/agents/subagent-registry.ts` 已有 sweeper（`setInterval` 每分钟）、`archiveAtMs`、默认 60 分钟、run-mode 才归档、归档连带 `sessions.delete(deleteTranscript:true)`；配置键为 `agents.defaults.subagents.archiveAfterMinutes`。运行时代码把 `<=0` 视为禁用，但当前 Zod schema 要求正整数                                                                                    | 60 分钟降级文案是**真实现状**，M2 接受不改；“设 0 禁用”的 schema/doc 漂移不纳入本次实现                                                                                                                                    |
| openclaw 净化         | `src/gateway/server-methods/chat.ts` 的 `CHAT_HISTORY_TEXT_MAX_CHARS=12_000` 为**逐字段**截断（text/partialJson/arguments/thinking 各自 12K），历史另有 `slice(-max)` 条数上限                                                                                                                                                                                                  | 父/子会话沿用同一净化，**不做子会话特例**                                                                                                                                                                                  |
| usage                 | `chat.history` 明确删除 `usage/cost`，live final 的 message 也没有稳定、独立的 usage 合同                                                                                                                                                                                                                                                                                       | M2 不做 usage 展示                                                                                                                                                                                                         |
| 前端测试与依赖        | `agent-frontend` 实际命令 `npm test`（`scripts/run-tests.mjs` 跑 `node --test`，编译自 `tsconfig.tests.json`，**非 Vitest**）、`npm run lint`、`npm run type-check`；`@assistant-ui/react` 与 `@radix-ui/react-dialog` 均**未安装**（仓库仅 `dropdown-menu`+`popover`，`Dialog` 是手写居中款，无 Sheet/Drawer）；无 jsdom/RTL 组件测试基建                                      | 不用 `pnpm test:openclaw-bff`；assistant-ui/Radix dialog 按 greenfield 新增依赖；组件测试需新增独立 `jsdom + @testing-library/react` 配置，现有 reducer/mapper 测试维持 `node --test`                                      |

## 2. 关键裁决

### D1：target 与连接模型

- target 仅含 direct 和 `/api/v1/workspaces/me` 返回的 private groups。
- 会话标识继续使用浏览器可见的短 `clientSessionId`；Gateway 原始 sessionKey 不下发。
- 一个浏览器 WS 连接绑定一个 `{targetKind, targetId, clientSessionId}`。任意时刻只订阅当前会话的实时流；切换 target 或 session 时销毁旧 client、连接新 binding 并拉 history。M2 不维持多个后台 WS。
- **并行语义（2026-07-15 定案）**：指多个会话的任务可在 Gateway 后台同时运行，**不是**浏览器同时持有多个 WS。A 发起长任务后切到 B，B 不得收到 A 的 message/toolCallId/runId；旧连接上的工具事件**不补发**，由切回后的终态对账补齐。
- **页面级 session activity registry（取代"sessions.list 探测"方案）**：`sessions.list` **没有**活跃 run 字段，不能用于探测运行状态。改在会话组件外维护本页面发起任务的状态：`{target, sessionId, clientInstanceId, frontRunId, phase}`。切换会话时保持稳定 `clientInstanceId`（与 bridge 的 `client_instance_namespace` 对齐，使后台 run 仍可映射回本页）；切回后先恢复运行态，通过 history/probe/reconcile 收敛，确认终态后清除角标。
- 运行角标语义限定为"本页面发起的任务仍可能运行"；**刷新即丢失**（registry 不持久化）。跨刷新、跨 Tab 的全局活跃会话状态进 backlog。
- `bridge.hello` 增加可选 `features` 字段（`{subagents, artifacts}`），由 BFF settings 控制；前端以 hello 为准渲染子 agent 面板与 artifact 文件卡，无该字段（老 BFF）视为全关。features 属 BFF 帧协议（agent-server 自有），不违反 Gateway 协议零改动；回滚=改 BFF 配置重启，无需重发前端。

### D2：子 agent 数据源采用 `subagents.list`

在 OpenClaw Gateway 新增只读方法：

```text
subagents.list({ requesterSessionKey })
  -> { runs: [{ runId, childSessionKey, label, sessionLabel, model,
                spawnMode, createdAt, startedAt, endedAt, status }] }
```

- scope 为 `operator.read`，不提供 task、requesterOrigin、cleanup 内部字段或管理动作。
- handler 从 `listSubagentRunsForRequester(requesterSessionKey)` 读取持久 registry。
- 当调用方声明 `caps:["tool-events"]` 时，handler 为返回结果中的 active run 调用 `context.registerToolEventRecipient(runId, connId)`。
- 该接口同时承担“发现子 run”和“刷新后恢复 active tool 订阅”。不依赖易丢失的瞬时 lifecycle event。
- 前端看到父会话 `sessions_spawn` running 卡片后短轮询 `subagents.list`；发现 child 后拉其 `chat.history`，再靠 live event 追加。发现前漏掉的早期事件由 history 对账补齐。

### D3：BFF 以发现结果建立子会话能力表

`OpenClawBridgeBinding` 新增双向映射：

```text
frontChildSessionId <-> gatewayChildSessionKey
frontChildRunId     <-> gatewayChildRunId
```

- `subagents.list` 请求只接受父级短 `clientSessionId`，BFF 重写为当前 target namespace 内的父 sessionKey。
- BFF 对 Gateway 返回的每条记录生成 `child_<random>` 形式、不可猜测的前端 opaque id，并写入 binding 能力表；原始 childSessionKey、child runId、target agentId 和 outcome error 均不下发。
- 只有能力表中的 child 才能调用 `chat.history`；子会话拒绝 `chat.send`、`chat.abort`、`sessions.preview` 和所有管理方法。
- `filter_event` 允许父 session，或能力表中 child session/run 的 `agent`/`chat` 事件；其他 session 一律丢弃。
- 连接关闭即丢弃能力表；重连必须重新执行 `subagents.list` 建权。

### D4：技能名称为展示派生值

新增 `resolveSkillInvocation(tool)` 纯函数，优先级：

1. 工具参数存在非空 `skillName`，直接使用；
2. tool name 为 `read`/`read_file`，参数中的 `path`/`file_path`/`filePath` 匹配 `.../skills/<name>/SKILL.md`，提取 `<name>`；
3. 不匹配则返回空，继续使用 `tool-display` 的普通工具摘要。

约束：

- 只显示技能名，不显示宿主机绝对路径。
- 同一 run 重复读取同一 `SKILL.md` 时，每个真实 tool call 仍保留，但摘要一致；M2 不虚构单独的 skill start/end 事件。
- live tool event 与 history mapper 共用同一识别函数，父/子会话共用同一展示组件。
- WebUI 工具行只渲染状态图标和工具/技能名称；多工具组保留“工具调用 · N 步”。不提供展开按钮，不渲染参数、结果或原始错误内容。
- `ChatToolCall.args/result` 继续保留在 reducer state，用于 `resolveSkillInvocation`、history/live 对账和终态收敛；展示组件只能消费派生名称、状态和分组信息。
- 这是展示层约束，不是传输层脱敏。若后续要求参数不得到达浏览器，需把技能识别移到 BFF/OpenClaw 上游，再从 BFF event/history DTO 中删除原始参数；不在 M2 本次 UI 改动中混做。

### D5：assistant-ui 按 greenfield 集成（集成验证任务，非 spike+回退）

**选型依据（2026-07-15 源码核对修正）**

- `agent-frontend/package.json` 已使用 React 19、Vite 7、Tailwind 4、Lucide 和 Streamdown；**但 `@assistant-ui/react` 当前未安装（greenfield 新增依赖）**，Radix 仅 `dropdown-menu`+`popover`（**无 `@radix-ui/react-dialog`**，仓库只有一个手写居中 `Dialog`，无 Sheet/Drawer）。assistant-ui 的 headless primitive 模型与现有 reducer/hook 可对接，但右侧活动面板需**显式新增 `@radix-ui/react-dialog`** 建 Sheet，不复用任何"现有 Radix Drawer"（不存在）。
- `state/chat-reducer.ts` 已管理 own/foreign run、streaming、terminal、seq gap、abort 和 history reconcile；`hooks/useOpenClawChat.ts` 已管理 WebSocket、重连、健康检查、delta 合并和 history reconcile；`ChatMessageList.tsx` 当前自行实现消息/工具分组与自动滚动。
- assistant-ui 官方把 [External Store Runtime](https://www.assistant-ui.com/docs/api-reference/external-store/runtime) 定义为“外部状态拥有者”接入方式；[Thread Primitive](https://www.assistant-ui.com/docs/primitives/thread) 提供无样式消息容器和自动滚动。M2 不采用 LocalRuntime，也不替换 BFF/Gateway 协议。

**固定技术链路**

```text
OpenClaw WebSocket frames
  -> OpenClawBffClient
  -> useOpenClawChat + openClawChatReducer
       唯一状态真相：连接、run、消息、tool、seq、reconcile
  -> OpenClawAssistantAdapter
       ChatRenderedItem -> ThreadMessageLike
  -> assistant-ui ExternalStoreRuntime
  -> Thread / Message / Composer primitives
  -> Streamdown + ToolCallGroup + ArtifactCard + OTR Tailwind tokens
```

assistant-ui 只负责无头 UI 状态投影、键盘/Composer 行为和 viewport 自动滚动。它不得建立第二份 message/run store，不得直接读写 WebSocket，不得自行合并 delta、判定 terminal、修复 seq gap 或发起 history reconcile。

**ExternalStoreRuntime 映射合同**

| Runtime 字段/动作 | M2 映射                                                                                         | 约束                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `messages`        | `selectRenderedChatItems(state)` 经 `OpenClawAssistantAdapter` 转为 `ThreadMessageLike[]`       | 保留稳定 message id；设置 `joinStrategy="none"`，禁止合并相邻 assistant 消息；同一 reducer state 必须产生确定性结果，不在 adapter 内缓存/补写消息                        |
| `onNew`           | 只提取单条文本并调用现有 `sendMessage`                                                          | M2 无用户附件、消息队列和 steer；`sendMessage=false` 时保持输入并展示现有错误/禁用状态                                                                                   |
| `onCancel`        | 调用现有 `abortActiveRun`                                                                       | 只允许取消 `activeOwnRunId`；foreign/child run 不产生 cancel 能力                                                                                                        |
| `isRunning`       | `activeOwnRunId` 存在且对应 run 未 terminal                                                     | `sending/streaming/stalled/unknown` 都视为仍占用父 thread；只有 reducer 清除 active own run 后变为 false                                                                 |
| `isSendDisabled`  | `connectionPhase !== "ready"`，或存在 active own run，或当前 target/session 无发送权限          | 保持输入框可编辑但禁止 send；不得只靠按钮 disabled，Runtime 也必须短路发送                                                                                               |
| tool-call part    | `ChatToolCall.toolCallId` 作为 assistant-ui `toolCallId`，统一交给只读 `ToolCallGroup` renderer | history/live 共用相同 id；工具 args/result 仍由 reducer 更新，但 renderer 只接收状态和派生名称；不提供 `onAddToolResult`，不启用 assistant-ui 默认详情/fallback renderer |
| message/tool 归属 | `ChatMessageItem.runId` / `ChatToolItem.runId`                                                  | `runId` 是聚合和 foreign-run 边界，不替代 `toolCallId`；不同 run 的同名工具不得合并                                                                                      |
| thread id         | 当前 `clientSessionId`                                                                          | target/session 切换先销毁旧 binding，再用新 reducer snapshot 初始化；禁止组件本地维护第二个 currentThreadId                                                              |

**禁用能力**

- 不提供 `onEdit`、`onReload`、`setMessages`、`onAddToolResult` 或 queue adapter，因此不渲染编辑、重新生成、分支切换、客户端工具回填和排队发送入口。
- 不注册 attachment adapter，不渲染 Composer 上传入口。Phase G 的 agent 产物通过 `webui_artifact_publish` + `ArtifactCard` 展示，与用户附件能力分离。
- assistant-ui custom tool-call part 必须复用同一个只读 `ToolCallGroup` renderer；不得另行 `JSON.stringify` 或通过默认 fallback 展示 tool args、result、error。
- 子 agent panel 使用只读 Runtime/primitive composition：只传 messages/tool parts，不提供 `onNew`、`onCancel`，并设置 disabled；child streaming 不得改变父 thread 的 `isRunning` 或 Composer。

**集成验证清单（非回退闸门）**

D5 已定案按 greenfield 集成，**不存在"spike 失败回退 ChatMessageList"路线**；本清单是上线前必须全部通过的集成验证项，并覆盖子 agent 只读 panel 硬案例（消息、工具 part 和技能摘要不得占用父 thread Composer/`isRunning`）：

1. 相同 reducer fixture 经 adapter 后保留消息顺序、stable id、runId、toolCallId、streaming/terminal 状态；相邻 assistant/foreign run 不合并，`isRunning` 不生成重复 optimistic assistant 消息；
2. foreign run、seq gap、重连和 history reconcile 仍只由现有 Hook/Reducer 驱动；
3. 自动滚动在用户上滑后不抢焦点，切回底部后能继续跟随 streaming；
4. 未配置的 edit/reload/branch/attachment/queue UI 不可见且无法通过 Runtime API 绕过；
5. 父/子 thread 的 tool-call part 都只显示状态图标和工具/技能名称，DOM 中不存在参数、结果、原始错误或详情展开控件；
6. 子 agent 只读 Runtime 与父 Runtime 隔离。

本 M2 不设 assistant-ui 回退路线：`ChatMessageList`/`ToolCallGroup` 作为迁移期实现基线保留，待上述清单全部通过、生产接线验收后再删除。协议、Hook、Reducer 与后续功能方案不变。前端估算上调，覆盖新增依赖、`OpenClawAssistantAdapter`、右侧 Sheet 与 `jsdom + @testing-library/react` 组件测试基建。

### D6：WebUI 文件是 artifact 交付，不是 channel 投递

- 新增 `webui_artifact_publish` 工具作为唯一规范入口，参数为当前 workspace 内的 `filePath`，可选 `filename`、`caption`。不扩展 `message` 工具的 `channel/target` 语义。
- 工具由通用扩展 `extensions/webui-artifacts` 提供，仅在 `messageChannel="webchat"`、存在有效父 sessionKey 且 BFF artifact endpoint 已配置时暴露。
- `gateway-client` 仍只用于 Gateway 握手和设备身份。浏览器接收者是 BFF 已鉴权的 `{principal, targetKind, targetId, clientSessionId}` binding，不存在名为 `gateway-client` 的 Feishu target。
- WebChat 上下文中，带 `filePath/media/path/mediaUrls` 的 `message` 调用默认拒绝，错误提示 agent 使用 `webui_artifact_publish`；只有显式 `channel="feishu"` 且 `target` 为真实 `user:openId` / `chat:chatId` 时，才允许走 Feishu 发送语义。
- Feishu outbox 插件必须识别并跳过 WebChat session，同时校验 `ctx.messageChannel === "webchat"` 和 sessionKey 中的 `:webchat:`，避免仅凭 `feishu-*` agentId 把 WebChat 文件误分流到 Feishu outbox。
- 工具使用 safe-open 校验真实路径位于当前 workspace/允许的 outbox 内，拒绝符号链接逃逸、目录、设备文件和执行期间发生替换的文件。
- M2 只允许父 WebUI 会话发布。外部 channel、CLI、子 agent 和未绑定 session 调用均 default deny。
- OpenClaw 的 WebUI system prompt/tool description 明确：给当前网页用户交付文件时调用 `webui_artifact_publish`；给飞书等外部渠道发文件时继续调用 `message` 并使用真实 channel target。

### D7：上传直达私有 OSS，下载经 BFF 鉴权

采用三段式协议，避免让文件内容经过 Gateway WebSocket 或 BFF Python 内存：

1. `POST /api/v1/openclaw/internal/artifacts/init`：扩展使用 `X-API-Key`（`openclaw-artifact-extension` 的 SERVICE key）提交内部 sessionKey、toolCallId、文件名、MIME、declared size、sha256、MD5(base64)。BFF 按 `api_keys` 表 HMAC hash 校验 key 并**精确校验 `service_id==openclaw-artifact-extension`**（`is_admin:false`，不复用 `OPENCLAW__WORKSPACE_API_KEY`）；解析 sessionKey，校验 Redis binding 未过期 + target namespace + 父会话限制 + **配额（`pending+ready` 计数、原子锁，满 50 返回 `409 ARTIFACT_SESSION_LIMIT_REACHED`，不建记录/不签 URL）** + 文件策略，创建 `pending` artifact，返回单段 `PutObject` 预签名 PUT URL（固定 object key + TTL，签入 `Content-MD5`+`Content-Type`+`x-oss-meta-sha256`）与 opaque artifactId。
2. 扩展以文件流直接 PUT 到 OSS（携带签名 headers，并用字节计数器在超过 declared size 或 100MB 时主动中止——第一方防 bug 措施；OSS 同时按签名 `Content-MD5` 校验内容，不匹配即拒），再调用 `POST .../{artifactId}/complete`。BFF HEAD **强制对账三项**——`Content-Length==declared size`、`ETag==declared MD5 hex`（单段 PutObject 的 ETag 即内容 MD5，比较时去引号统一大小写）、`x-oss-meta-sha256==declared sha256`——任一不一致即转 `failed`、不发布 `artifact.available`、立即删 OSS 对象（删失败标 `delete_pending` 由 pending 清理任务重试+告警）。
3. 浏览器只收到 `artifact.available` 的 opaque DTO。点击下载调用登录态接口 `GET /api/v1/openclaw/artifacts/{artifactId}/download`；BFF 重新校验 principal、target 和 session 后返回 302 到 5~10 分钟的预签名 GET URL。

约束：

- OSS bucket 保持 private；WS 事件、chat transcript、日志和前端状态都不保存 object key、api key、PUT URL 或 GET URL。
- OSS 落位（2026-07-15 定案）：复用 agent-server 现有私有 bucket，新增专用 `openclaw-artifacts/` 前缀（objectKey = 前缀 + 服务端随机值），不新建 bucket；retention 清理由 BFF 定时任务按 DB 状态驱动，不依赖 bucket 级 lifecycle 规则。
- artifact 元数据至少记录 `artifactId/sessionRef/principalId/targetKind/targetId/sourceToolCallId/objectKey/filename/contentType/size/sha256/md5Base64/status/createdAt/expiresAt`；objectKey 只能由服务端生成；`(sessionRef, sourceToolCallId)` 建唯一约束，同 tool call 重试 `init` 返回已有 artifact、不重复占额。
- `init`/`complete`/`abort` 为内部接口，只接受 `X-API-Key` 并校验 `service_id==openclaw-artifact-extension`（非管理员 SERVICE）；浏览器不能取得上传凭据，BFF 不存 raw key、不读 openclaw.json 凭据。网络面（2026-07-15 访谈修正，取代早稿“容器网段”表述）：Gateway 与 `webui-artifacts` 扩展运行在**宿主机**（compose 无 gateway 服务，runbook 拓扑为 `host.docker.internal`），internal 路由不进 Traefik；`bff-server` 宿主端口从 `8303:8000` 改绑 `127.0.0.1:8303`，扩展经 `http://127.0.0.1:8303` 直调。前提：生产 Gateway 与 Docker 栈同宿主机（Phase A 闸门核对）；若未来分机部署，改用内网地址 + 防火墙白名单，鉴权语义不变。
- 当前 `bff-server` 为单副本，`complete` 可通过现有 subscriber manager 发布本地 synthetic event。可靠恢复依赖 `artifacts.list(clientSessionId)`，不依赖事件重放；未来扩容多副本时再把 fan-out 切到 Redis Pub/Sub。
- 复用 agent-server 的 OSS SDK/配置，但新增窄 `OpenClawArtifactStoragePort`；不把 reduced BFF runtime 接回完整 workflow/workspace 容器，也不复用整文件 `IResourceStorage.upload(data: bytes)`。
- **size 强制策略（2026-07-15 纠正）**：presigned PUT 协议层**无法钉死 body size**（客户端控制 Content-Length）；M2 用"上传阶段签名 `Content-MD5` 内容校验 + 扩展字节计数器主动中止 + complete HEAD 强校验 size/ETag-MD5/sha256"收口，不在协议层声称固定 size。残余风险（受信扩展故障或宿主机失陷时仍可能在 complete 前耗 OSS 带宽/容量）接受为 M2 已知边界，由 10 分钟 PUT TTL、30 分钟 pending 清理、bucket 配额与异常流量告警控制。

### D8：artifact 授权绑定 target 会话

- BFF 在 bridge connect 成功后，把内部 sessionKey 的**不可逆摘要**作为 Redis key，写入 `{principalId, targetKind, targetId, clientSessionId, agentId/namespace, connected, lastSeenAt}` binding，TTL 随会话活跃刷新；disconnect 不立即删除，转入 disconnected 并保留**有界宽限期**（可配置且有硬上限，覆盖最长后台 run + 上传缓冲，不无限续期）。日志禁出 raw sessionKey。复用 BFF 已有 Redis client factory（新增窄 binding repository，非新基建）。
- `init` 只接受 Redis binding 中未过期的父 sessionKey，过期即 default deny（不建 DB 记录、不签 URL）。private group 必须再次校验当前用户成员关系和机器人可用状态；撤销权限后 list/download 立即拒绝。
- **`complete`/`abort` 不依赖 binding**：init 已创建的 pending artifact 在 pending TTL 内允许完成，避免大文件上传中途 binding 过期导致误失败。Redis 不可用时**只关闭 artifact 发布**（该连接 `features.artifacts=false`），聊天连接不受影响。`artifacts.list`/download 始终按当前登录人 + target 权限重新鉴权，不因旧 binding 存在而放宽。
- 浏览器侧 `artifacts.list` 与 download 是登录态 **HTTP** 接口（不是 WS 方法），由 Traefik 新增 `/api/v1/openclaw/artifacts` 路由到 `bff-server` 承接（现有规则会把该路径落到 agent-api，必须显式加路由）。`artifacts.list` 只接受短 `clientSessionId`，BFF 结合当前登录人和 target 查询，永不接受原始 sessionKey。
- `pending` 超时任务删除孤儿对象/元数据；`ready` artifact 按独立 retention 清理。短时下载 URL 到期后可在 retention 内重新签发。
- 文件大小、MIME allow/deny、单会话数量和 retention 均由配置限制。首版默认值（2026-07-15 访谈定案，均可配置）：
  - 单文件 ≤ 100 MB；单会话 artifact ≤ 50 个（配额计 `pending+ready`，`failed/aborted/expired/deleted` 不计；满额 `init` 返回 `409 ARTIFACT_SESSION_LIMIT_REACHED`，**必须原子锁**统计，禁无锁 count-then-insert；不 FIFO，不静默删已交付文件；`abort`/pending 超时/retention 清理释放配额）。
  - MIME 默认放行 + 拒绝可执行类（如 `application/x-executable`、`application/x-msdownload`、`application/x-sh`）；下载一律强制 `Content-Disposition: attachment`，M2 不做内联预览（规避 XSS）。
  - ready retention 30 天；pending 超时 30 分钟后清理；presigned PUT TTL 10 分钟、GET TTL 5~10 分钟。
  - 鉴权凭据（2026-07-15 二轮定案，取代"单 service token / 两处存放 / 专用 header"）：新建非管理员 SERVICE `openclaw-artifact-extension`（`is_admin:false`），用 `auth sync-services` + `auth create-api-key` 签发；raw key 只存扩展侧（env/secret 注入，或 `openclaw.json` 插件段标 sensitive），**BFF 不存 raw key、不读 openclaw.json 凭据**，仅按 `api_keys` 表 HMAC hash 校验 `X-API-Key` + 精确 `service_id==openclaw-artifact-extension` 校验。轮换走 `auth rotate-api-key`，只更新扩展侧 raw key，BFF 零改动/零重启。**不复用 `OPENCLAW__WORKSPACE_API_KEY`**（privileged，避免扩大泄露面与生命周期耦合）。
  - 代码不得继承临时 media 的 5 MB/2 分钟默认值。

## 3. 调用链与状态流

### 3.1 多会话

```text
/api/v1/workspaces/me
  -> direct + privateGroups target catalog
  -> 用户选择 target
  -> BFF bridge.connect(target, clientSessionId)
  -> sessions.list(target namespace)
  -> 用户切换 session
  -> 关闭旧 WS，连接新 binding
  -> chat.history + live reconcile
```

target 改变时，agentId、namespace、会话列表和 active connection 一起改变；任何上一个 target 的 reducer/live run 状态都不能复用。

### 3.2 子 agent

```text
父 chat.send
  -> 父 agent tool start: sessions_spawn
  -> OpenClaw spawnSubagentDirect
  -> subagent registry 写入 requesterSessionKey/childSessionKey/runId
  -> 子 run 由内部 Gateway agent 调用启动
  -> WebUI 轮询 subagents.list(parent)
  -> Gateway 返回 registry 记录，并为 BFF conn 注册 active tool-events
  -> BFF 建 child capability map，输出 opaque child ids
  -> WebUI chat.history(child) 补历史
  -> BFF 仅放行该 child 的后续 chat/agent events
  -> SubagentCard/只读 panel 更新 running/final/error
```

父 agent 收到的 completion announcement 仍作为父会话普通消息展示。子 panel 是运行过程视图，不替代父消息。

### 3.3 技能回显

```text
parent/child agent tool event 或 history tool call
  -> toolCallId 聚合
  -> resolveSkillInvocation(args/path)
  -> 命中：摘要“使用技能：<name>”
  -> 未命中：tool-display 普通摘要
  -> ToolCallGroup / assistant-ui tool-call part
```

### 3.4 WebUI artifact 文件交付

```text
父 WebUI agent 调用 webui_artifact_publish(filePath)
  -> 扩展按当前 workspace safe-open，流式计算 size/sha256/md5
  -> BFF internal artifacts.init(X-API-Key + service_id 校验 + internal sessionKey)
  -> Redis session binding + target 权限校验 + 配额原子检查
  -> DB 写 pending artifact，返回短时 presigned PUT（签 Content-MD5）
  -> 扩展从本地文件流直传私有 OSS（携带签名 headers）
  -> BFF artifacts.complete + OSS HEAD 强校验 size/ETag-MD5/sha256
  -> DB 改 ready，向该 session 的浏览器订阅发布 artifact.available
  -> 前端显示文件卡
  -> 用户点击下载
  -> BFF 按登录人、target、session 重新鉴权
  -> 302 到短时 presigned GET
```

刷新或断线时：

```text
bridge.connect(target, clientSessionId)
  -> artifacts.list(clientSessionId)
  -> 与 live artifact.available 按 artifactId 合并
  -> ready artifact 恢复为文件卡；pending/failed 显示稳定状态
```

该链路不进入 `message.channel/message.target`，也不把二进制写入 Gateway WS、chat history 或 BFF 进程内存。

## 4. 实施阶段

### Phase A：基线闸门、assistant-ui 集成验证与 OSS presign PUT 验证（1.5~2d）

**agent-frontend**

- 新增 `src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.ts` 和 `OpenClawAssistantAdapter.test.ts`；以 `ChatRenderedItem[]` 为唯一输入，输出稳定 `ThreadMessageLike[]`，adapter 内不得使用 `useState` 保存消息副本。
- 新增开发 flag 下的 `OpenClawAssistantThread.tsx`，组装 `useExternalStoreRuntime`、Thread/Message/Composer primitives、Streamdown 和现有 `ToolCallGroup`；不接生产路由。
- 把 `sendMessage`、`abortActiveRun`、connection/permission、active own run 映射到 D5 合同；显式断言 `onEdit/onReload/setMessages/onAddToolResult/queue/attachments` 未配置。
- 验证原三个案例：foreign run、工具按 runId 归属、oversized/无文本/aborted partial，并覆盖 seq gap + history reconcile 后 adapter 输出收敛。
- 新增子 agent 案例：父 thread 含 `sessions_spawn`，child panel 含 streaming + tool + skill，父 composer 状态不受 child run 影响。
- 验证 Thread viewport 自动滚动：跟随 streaming、用户上滑暂停、回到底部恢复；不得同时保留 `ChatMessageList` 的滚动 effect 和 Thread primitive 自动滚动。
- 安装并锁定 `@assistant-ui/react`；本阶段为**集成验证任务**（非 spike+回退）：上述清单全部通过即视为可迁移基线，**不设"失败回退 ChatMessageList"路线**（`ChatMessageList`/`ToolCallGroup` 作迁移期基线保留，待 Phase E/F 验收后删除）。
- 新增最小组件测试基建：`jsdom` + `@testing-library/react` + 独立组件测试配置；现有 reducer/mapper 测试维持 `node --test`，**不迁移整个测试体系**。

**闸门**

- 核对 `~/github/openclaw-workspace/openclaw.json` 仍为 `security=full`、`ask=off`；若部署配置已变化，停止实施并重新定审批范围。
- 核对 Gateway `hello-ok.features.methods` 包含 M1 方法；Phase B 完成后必须新增 `subagents.list`。
- 核对生产 Gateway 与 Docker 栈同宿主机（D7 拓扑前提）；不同机则按 D7 分机 fallback 重定 internal 端点方案后再进 Phase G。
- **OSS presign PUT 验证闸门**（2026-07-15 新增）：用现网 `alibabacloud-oss-v2` 对 `PutObjectRequest` 调 `presign()`，确认能签入 `Content-MD5`/`Content-Type`/`x-oss-meta-sha256` 并生成有效上传 URL；扩展(Node)侧实测 PUT 能被 OSS 接受、`Content-MD5` 不匹配被拒。未通过则暂停 Phase G 并回到 D7 size 策略重评。
- 核对归档配置键实为 `agents.defaults.subagents.archiveAfterMinutes`；若现网值非默认 60，按实际值更新 Phase F 降级文案与验收。运行时与 Zod schema 对 `0` 的处理不一致，M2 不以 `0` 作为部署值。
- S1 idempotencyKey 真机确认（M1 遗留②）：真机发一条 `chat.send`，读 sessionFile 的 `role:"user"` 行确认有无顶层 `idempotencyKey`/`sid`；有则乐观消息匹配升级精确匹配，无则维持启发式。不阻塞后续阶段。
- OBS-001 复核（M1 遗留④）：多会话使多 Tab/多实例场景高频化，按 deferred-observation-cases 的重排条件复核一次；未触发则继续观察，不改实现。

### Phase B：OpenClaw Gateway 子 agent 只读协议（2~2.5d）

**新增/修改文件**

- 新增 `src/gateway/protocol/schema/subagents.ts`：params/result DTO，`additionalProperties:false`。
- 修改 `src/gateway/protocol/schema/protocol-schemas.ts`、`src/gateway/protocol/schema/types.ts`、`src/gateway/protocol/index.ts`：导出类型、schema 和 validator。
- 新增 `src/gateway/server-methods/subagents.ts`：校验 requester key、读取 registry、投影窄 DTO、注册 active run tool recipient。
- 修改 `src/gateway/server-methods.ts`：注册 `subagentsHandlers`。
- 修改 `src/gateway/server-methods-list.ts`：暴露 `subagents.list`。
- 修改 `src/gateway/method-scopes.ts`：归类到 `operator.read`。
- 新增 `src/gateway/server-methods/subagents.test.ts`；补 `src/gateway/protocol/index.test.ts`、`src/gateway/method-scopes.test.ts`。

**测试点**

- 只返回 requester 的直接 children；不返回 task、origin、cleanup 等内部字段。
- active/terminal 状态映射稳定；无记录返回空列表。
- 只有具备 connId + `tool-events` cap 的调用方才注册 active run；terminal run 不注册。
- requester A 看不到 requester B；非法参数 default deny。
- 方法出现在 methods feature list 且只需 read scope。

### Phase C：agent-server 子会话授权与脱敏（2~2.5d）

**修改文件**

- `app/common/constants/openclaw_gateway.py`：allowlist 增加 `subagents.list`；scopes 保持 `operator.read/operator.write`；`exec.approval.` 继续显式拒绝。
- `app/services/openclaw_bridge_service.py`：
  - binding 增加 child session/run 双向 capability map；
  - `rewrite_request` 增加 `subagents.list` 和 child `chat.history` 分支；
  - `translate_response` 对 child IDs 做 opaque 映射并剥离未批准字段；
  - `filter_event` 允许 capability map 中的 child `chat/agent` 事件；
  - 父 `sessions.list` 的 `agentId=binding.agent_id` 和 namespace 过滤保持不变，不能用它枚举跨 agent child；
  - `bridge.hello` 组装附加可选 `features` 字段（`subagents` 由 `bff_server/settings.py` 开关控制，`artifacts` 开关随 Phase G 加），含单测。
- 如 DTO 校验需要，新增 `app/core/entities/openclaw_bridge/models.py`；不要把 Gateway 全量 schema 复制进 Python。
- `app/test/unit_test/services/test_openclaw_bridge_service.py`：覆盖授权、映射、拒绝与 reconnect。
- `app/test/unit_test/api/test_openclaw_bridge_controller.py`：覆盖同一订阅队列中的 parent/authorized-child/foreign-child 事件。
- `app/test/unit_test/infra/openclaw/test_gateway_client_adapter.py`：确认 caps 仍含 `tool-events`，scopes 未增加 approvals/admin。

**安全不变量**

- 浏览器传原始 `agent:*:subagent:*` 必须拒绝。
- 未先成功执行 `subagents.list` 的 child history/event 必须拒绝。
- Gateway 响应中的原始 `requesterSessionKey`、`childSessionKey`、runId 和 agentId 不得出现在前端帧。
- front child id 不能跨 binding、target 或重连复用。

### Phase D：agent-frontend target 与多会话（1.5~2d）

**修改文件**

- `src/features/openclaw-bff/types/chat.ts`：移除全局 `OPENCLAW_CHAT_SESSION_ID` 依赖，定义 `OpenClawChatTarget`、session summary、active session 状态。
- `src/features/openclaw-bff/api/chat-event-guards.ts`：守卫接收期望 `clientSessionId`，禁止硬编码 `main`。
- `src/features/openclaw-bff/hooks/useOpenClawChat.ts`：接收 `clientSessionId`；connect/history/hello/reconcile 全链路使用当前 id。
- 新增 `src/features/openclaw-bff/hooks/useOpenClawSessions.ts`：调用 `sessions.list`，只维护当前 target 的会话列表和新建短 id（`sessions.list` **无活跃 run 字段**，不用于探测运行状态）。
- 新增 `src/features/openclaw-bff/hooks/useOpenClawSessionActivity.ts`：会话组件外维护页面级 session activity registry `{target, sessionId, clientInstanceId, frontRunId, phase}`；切换会话保持稳定 `clientInstanceId`（与 bridge `client_instance_namespace` 对齐）；切回后 history/probe/reconcile 收敛到终态后清角标；刷新即丢失、不持久化。
- 复用 `src/features/my-workspace/api.ts` 的 `fetchWorkspaceOverview`；新增 target selector / session sidebar 组件。
- `src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`：URL 持有 target + session；切换时通过 key 重建 session hook/client。

**交互约束**

- direct 固定为当前登录用户；group 只能从 workspace overview 选择，URL 注入陌生 group 时由 BFF 拒绝并回到可选 target。
- 新会话 id 使用 `chat_<nanoid>`；首次 `chat.send` 后进入列表。
- 侧边栏只做新建、切换，不展示搜索、改名或删除入口。
- target 切换清空旧 target 的 history/live/subagent 状态。
- 并行语义（D1）：A 发起长任务后切到 B，B 不得收到 A 的 message/toolCallId/runId；任意时刻只订阅当前会话实时流，旧连接工具事件不补发，由切回后的终态对账补齐。

### Phase E：工具摘要与技能名称回显（1~1.5d）

**修改文件**

- 新增 `src/features/openclaw-bff/api/tool-display.ts`：普通工具/技能展示名称与名称截断规则，不生成参数或结果摘要。
- 新增 `src/features/openclaw-bff/api/skill-invocation.ts`：`resolveSkillInvocation` 纯函数。
- 修改 `src/features/openclaw-bff/api/chat-mappers.ts`、`state/chat-reducer.ts`：history/live 工具继续保存 `args/result` 及结构化摘要所需字段，供技能识别和对账使用；不得因 UI 隐藏而删除状态字段。
- 修改 `src/features/openclaw-bff/components/chat/ToolCallGroup.tsx`：
  - 工具行只显示状态图标和工具/技能名称；技能命中时显示“使用技能：<name>”；
  - 多工具组固定显示“工具调用 · N 步”，下方静态列出各工具行；单工具使用相同只读行样式；
  - 移除组/行展开按钮、Chevron、`aria-expanded` 和本地 open state；
  - 删除 `ToolDetail`、`ToolSection`、`truncateValue`，不渲染参数、结果、原始错误和耗时；
  - 若 `TOOL_ARGS_MAX_CHARS`、`TOOL_RESULT_MAX_CHARS` 无其他消费者，从 `types/chat.ts` 删除这两个仅展示用常量，但保留 `ChatToolCall.args/result`。
- 若 Phase A 通过，同一 resolver 和同一个只读 `ToolCallGroup` renderer 接入 assistant-ui custom tool-call part；禁止使用 assistant-ui 默认 tool fallback 重新暴露详情。[External Store Runtime](https://www.assistant-ui.com/docs/api-reference/external-store/runtime) 继续只消费外部 reducer 投影。

**测试点**

- Unix/macOS/Windows 分隔符、managed/workspace/bundled skill 根均能从 `SKILL.md` 路径提取名称。
- `skillName` 优先于路径推断；空值、非 SKILL.md、伪后缀和普通 read 不误报。
- UI 不显示绝对路径、tool args、result 或原始 error；超长/控制字符 skill name 拒绝或截断。
- history 与 live 对同一 tool call 得到相同摘要。
- `ToolCallGroup` 单工具/多工具、running/success/error、普通工具/技能名称均有组件测试；断言无 Chevron、展开按钮、“参数”“结果”、JSON 内容和原始错误文本。
- reducer/mapper 测试断言 `args/result` 在 live、history 和 reconcile 后仍保留，且能继续驱动技能名称识别；UI 隐藏不得改变状态对账。
- assistant-ui adapter 测试断言父/子 custom tool-call part 复用只读 renderer，默认 fallback 未注册。

### Phase F：子 agent 卡片与只读活动面板（2~2.5d）

**修改文件**

- 扩展 `src/utils/openclawBff/types.ts`：仅加入 BFF 对外的 opaque subagent DTO。
- 新增 `src/features/openclaw-bff/hooks/useOpenClawSubagents.ts`：
  - 父 history/事件出现 `sessions_spawn` 后开始 500ms 短轮询；发现后改 2s 状态轮询，全部 terminal 后停止；
  - connect/reconnect 后立即 `subagents.list`；
  - 按 child id 拉 `chat.history`，live event 用独立 child reducer 分桶。
- 新增 `src/features/openclaw-bff/components/chat/SubagentCard.tsx`：pending/running/success/error、label/model/耗时、展开入口。
- 新增 `src/features/openclaw-bff/components/chat/SubagentActivityPanel.tsx`：右侧滑出 **Sheet**（2026-07-15 二轮定案：桌面约 40% 宽、移动端全屏；**显式新增 `@radix-ui/react-dialog`**，基于 Dialog Primitive 实现，不复用不存在的 Radix Drawer、也不复用手写居中 `Dialog`），只读消息、工具卡、技能摘要；不渲染 composer/abort/steer/kill；同时只允许展开一个 child，切换即关旧开新（降低并发 history 拉取与 reducer 分桶复杂度）。
- `sessions_spawn` 工具行仍只显示状态和名称；对应 `SubagentCard` 作为独立的类型化业务卡片渲染在工具组之后，未发现 registry 记录时显示“正在发现子任务”。打开 child Drawer 属于子任务导航，不得复用或恢复工具参数详情展开。
- 前端门控：子任务卡/Drawer 仅在 `hello.features.subagents === true` 时启用；否则 `sessions_spawn` 保持普通工具卡。

**状态规则**

- `sessions_spawn` tool success 仅表示 spawn 请求被接受；最终状态以 `subagents.list` 的 registry 记录为准。
- child terminal 后执行最后一次 history reconcile，再冻结 panel。
- child error 与父 completion announcement 可同时存在；前端按来源展示，不去重语义不同的两条记录。
- reconnect 时先重建 child capability，再拉 history，最后接受 live event；不能先用缓存 child id 请求。
- 归档窗口（2026-07-15 定案，接受不改）：run-mode 子任务记录默认 **spawn 后 60 分钟** 归档（配置键 `agents.defaults.subagents.archiveAfterMinutes`，默认 60；从 spawn 起算；sweeper 每分钟扫，归档连带 `sessions.delete(deleteTranscript:true)` 删子会话历史；session-mode 不归档；cleanup 默认 keep）。已归档 child 的 panel 显示“子任务记录已过保留期”降级文案，不报错；父会话 `sessions_spawn` 工具卡与 completion announcement 不受影响。不改 Gateway、不改部署配置。
- child `chat.history` 与父会话走同一 Gateway 净化（`CHAT_HISTORY_TEXT_MAX_CHARS=12_000` **逐字段**截断 text/partialJson/arguments/thinking + `slice(-max)` 条数上限、图片 data 剥离）；长条目沿用 M1 oversized 占位展示，**不做子会话特例**。

### Phase G：WebUI artifact + 私有 OSS 文件交付（3~5d）

**OpenClaw 扩展**

- 新增 `extensions/webui-artifacts/`，包含 manifest、package、`webui_artifact_publish` tool factory、BFF artifact client 和定向测试。
- tool factory 只在 `ctx.messageChannel === "webchat"`、父 session 且 BFF endpoint + service api key 已配置时返回工具；其他上下文不注册。
- 修正 `feishu-file-outbox-router` 的上下文判定：`messageChannel="webchat"` 或 WebUI sessionKey 一律不进入 outbox staging；继续只在真实 Feishu channel 上处理 `message(filePath/media/...)`。该改动属于现有 Feishu glue 插件保护，不改变 Feishu 外部发送路径。
- 从 `ctx.workspaceDir` 解析相对路径，使用 safe-open 获取稳定 file handle；先 `fstat`，**同一次流式扫描计算 actual size / SHA-256 hex / MD5 hex / MD5 base64**，再次 `fstat` 防止计算期间替换；上传时用字节计数器在超过 declared size 或 100MB 时主动中止（第一方防 bug）。
- 实现 `init -> presigned PUT -> complete`：init 用 `X-API-Key`（`openclaw-artifact-extension`）提交 size/sha256/md5，处理 `409 ARTIFACT_SESSION_LIMIT_REACHED`（向 agent 回显稳定文案"本会话最多交付 50 个文件，请新建会话后继续"）；PUT 携带签名 headers（含 `Content-MD5`）；complete 由 BFF HEAD 强校验。失败时调用 abort/标记 failed，错误消息只回显 artifactId 和阶段，不泄露 api key、object key 或本地绝对路径。
- 更新 WebUI agent 的工具说明，明确与外部 channel `message` 的边界；增加 `message(channel="webchat")`、`target="gateway-client"`、WebChat `message(filePath)` 和显式 Feishu target 的错误/放行测试，防止再次误用。

**agent-server / bff-server**

- 新增 `app/common/ports/openclaw_artifact_storage_port.py`、`app/infra/storage/openclaw_artifact_oss_storage.py`：只提供 presign PUT（签 `Content-MD5`/`Content-Type`/`x-oss-meta-sha256`）、HEAD 校验（size/ETag-MD5/sha256）、presign GET、delete，不接受整文件 `bytes`。
- 新增 artifact entity/repository/PO 和 migration；object key 使用服务端随机值，状态机限定 `pending -> ready|failed|expired`；`(sessionRef, sourceToolCallId)` 唯一约束；配额统计 `pending+ready` 用**原子锁**（行锁/`SELECT … FOR UPDATE` 或 Redis incr），满 50 拒绝，禁无锁 count-then-insert。
- 新增 `app/services/openclaw_artifact_service.py`、`app/api/v1/controllers/openclaw_artifact_controller.py`、`app/api/v1/schemas/openclaw_artifact_schema.py`：实现 internal init/complete/abort 与 browser list/download。
- 新增窄 Redis session binding repository（不可逆摘要 key，存 principalId/targetKind/targetId/clientSessionId/agentId/connected/lastSeenAt，有界 TTL 宽限 + 硬上限）；在 `OpenClawBridgeService.bind` 成功后写入、WS 活跃期间刷新。artifact service 复用同一 session-key 解析与 target 授权函数，禁止复制一套宽松规则；`complete`/`abort` 不依赖 binding（pending 在 pending TTL 内允许完成）。
- 扩展 `OpenClawGatewayClientManager` 的本地订阅发布入口；`complete` 发送 synthetic `artifact.available`，由 bridge controller 按 binding 过滤。
- `bff_server/container.py` 只接入数据库、Redis、artifact service 和窄 OSS adapter；`bff_server/app_factory.py` 挂 artifact router。不得加载 workflow、LLM 或 workspace/filebrowser 容器。
- 用 `auth sync-services` + `auth create-api-key` 新建非管理员 SERVICE `openclaw-artifact-extension`；init/complete/abort 校验 `X-API-Key` 的 DB HMAC hash + 精确 `service_id==openclaw-artifact-extension`。`bff_server/settings.py` 增加 size/count/retention、PUT/GET TTL、binding 宽限期上限（默认值见 D8；**不再有 service token 配置**）。Compose：`bff-server` 宿主端口改绑 `127.0.0.1:8303`；Traefik 新增 `/api/v1/openclaw/artifacts` 路由到 `bff-server` 承接 browser list/download；internal init/complete/abort 不进 Traefik，仅经宿主机 `127.0.0.1:8303` 访问并强制 `X-API-Key` + service_id 校验（Gateway 在宿主机上，无“容器网段”可用）。
- 增加 pending 清理任务和运维指标：init/complete/failed、上传字节、校验失败、孤儿清理、download denied；更新 BFF runbook。

**agent-frontend**

- 扩展 `src/utils/openclawBff/types.ts`：增加 opaque artifact DTO 与 `artifact.available` event guard。
- 新增 `src/features/openclaw-bff/hooks/useOpenClawArtifacts.ts`：connect/reconnect 后 list，与 live event 按 artifactId 合并，target/session 切换时清空旧状态。
- 新增 `src/features/openclaw-bff/components/chat/ArtifactCard.tsx`：显示文件名、类型、大小、ready/failed 状态和下载动作；不缓存预签名 URL。
- 通过 `sourceToolCallId` 把文件卡挂到对应 `webui_artifact_publish` 工具卡下；找不到工具记录时按 `createdAt` 放入当前会话时间线，禁止静默丢弃。
- `OpenClawChatScreen.tsx` 按当前 session 渲染 artifact 卡。M2 不增加 Files 页、上传按钮或文件浏览器。
- 前端门控：artifact 文件卡仅在 `hello.features.artifacts === true` 时启用；老 BFF（hello 无 features）视为关闭。

**测试点**

- 开工前验证扩展工具执行上下文可取得 `toolCallId`（供 `sourceToolCallId`）；取不到则该字段置空并走前端 `createdAt` 时间线降级路径，不阻塞发布。
- 文本为空的纯文件也能生成 artifact 卡；不依赖 chat final text。
- 路径穿越、符号链接逃逸、目录、设备文件、超限文件、MIME 禁止项、文件替换均被拒绝。
- PUT URL 短时有效且只允许指定 object key + 签名 headers（`Content-MD5`/`Content-Type`/`x-oss-meta-sha256`）；OSS 按 `Content-MD5` 校验内容（不匹配被拒）；complete 对 size/ETag-MD5/sha256 任一不一致 default deny（转 failed + 删对象）。
- WebChat 绑定 `feishu-*` agent 时，`message(filePath)` 不写入 Feishu outbox、不调用 Feishu sender，并返回使用 `webui_artifact_publish` 的稳定提示；显式 `channel="feishu"` + 真实 Feishu `target` 的发送保持原行为。
- 同一登录人只能 list/download 当前有权 target/session 的 artifact；direct 与 private group、跨用户、跨 group、raw sessionKey 均覆盖。
- 配额边界：第 50 个允许、第 51 个返回 `409 ARTIFACT_SESSION_LIMIT_REACHED`；并发 init 不突破 50（原子锁）；`(sessionRef, sourceToolCallId)` 重复 init 返回同一 artifact；非 `openclaw-artifact-extension` 的 SERVICE key 即便 `is_admin=false` 也被拒；`abort`/pending 超时/retention 清理后配额释放。
- 迟到发布：WS 断开后宽限期内 binding 仍有效→后台 publish 可成功，下次 `artifacts.list` 恢复；binding 过期→init default deny（无 DB 记录/无 URL）；Redis 不可用→`features.artifacts=false`、聊天不受影响。
- 刷新漏掉 `artifact.available` 后可由 list 恢复；重复 complete/event/list 幂等。
- WS、history、API DTO 和日志不包含本地绝对路径、object key、api key、预签名 URL。

### Phase H：联调、定向测试与文档回写（1d）

- 三仓使用兼容分支部署到同一测试环境；先 Gateway 与 `webui-artifacts` 扩展，再 agent-server artifact migration/BFF，最后 frontend。
- 跑第 5 节定向测试，不主动跑全量 `pnpm test`/`pnpm check`。
- 真机验证 direct + private group、双会话并行、跨 agent child（例如 `researcher`）、刷新恢复、技能回显、文件发布/下载和越权拒绝；并把端到端真机冒烟清单固化成文档（M1 遗留③）。
- 回写本计划实际差异、[webui_integration_milestones.md](../research/openclaw-frontend-integration/webui_integration_milestones.md) 状态和必要 runbook。

### 实施记录（2026-07-15）

- 三仓代码已落地并通过定向测试。OpenClaw 覆盖 `subagents.list`、artifact 扩展、message 边界和 safe-open；agent-server 覆盖 bridge capability、artifact 状态机/OSS/Redis/鉴权/migration；前端覆盖多 target/session、ExternalStoreRuntime、child panel、技能与 artifact。
- 模型工具协议要求函数名匹配 `^[a-zA-Z0-9_-]+$`。原设计名 `webui_artifact.publish` 在真机 provider fallback 时被拒绝，实际工具名统一改为 `webui_artifact_publish`；插件 id 和 HTTP 路径不变。
- 测试环境前端通过 Vite 直连 BFF，因此补充 `/api/v1/openclaw/artifacts` 的 BFF 优先代理；否则文件卡可恢复但下载会落到通用 API 并返回 404。生产 compose 的 Traefik artifact 路由仍是正式入口。
- artifact SERVICE 在数据库 principal 中使用内部 UUID；鉴权后再精确核对 service name 与 `is_admin=false`，语义等价于本计划的专用 service identity，但不把 service name 当数据库主键。
- Redis binding 默认值落为 active TTL 120 秒、60 秒刷新、断连宽限 3600 秒、硬上限 7200 秒。测试环境因浏览器直连要求临时监听测试网端口；生产 compose 继续只绑定宿主机回环地址。
- 跨仓收口审查补齐两处连接可靠性：synthetic artifact event 遇到满队列时先投递关闭信号，避免订阅已移除但 WebSocket 永久等待；活跃连接的 Redis binding 刷新失败后继续重试并在 key 丢失时重建，避免一次瞬时故障永久关闭该连接的 artifact 能力。
- 完成度审计发现测试环境原先只启用了 artifact，未启用 `OPENCLAW__BFF_SUBAGENTS_ENABLED`。Compose 已显式透传该 feature flag，测试服务器 `.env` 已设为 `true`；为避免旧 Gateway 进程收到未支持的方法，当前 BFF 容器仍保持关闭，待 Gateway 获准重启后一起重建 BFF 生效。
- 页面级 session activity registry 改为跨 target 保留页内 activity 与稳定 `clientInstanceId`；target 切换仍通过 keyed workspace 清空 history/live/subagent，但返回原 target 后可继续对账后台 run。刷新页面仍按既定边界丢失 activity。
- 完成度审计发现 assistant-ui 仅有组件与测试，生产父会话仍渲染旧 `ChatMessageList`/`ChatComposer`。现已把父/子消息、只读工具组、技能摘要、`SubagentCard`、`ArtifactCard`、欢迎提示和 Composer 全部接入 ExternalStoreRuntime；旧列表、旧输入框和旧消息组件已删除，长流式 Markdown 的暂停渲染与 URL 安全策略同步迁移。前端常规测试 142 项、组件测试 73 项、定向 typecheck、Biome 和生产构建均通过，测试环境静态资源已更新。
- Gateway 的 `subagents.list` DTO 没有 `sourceToolCallId`。前端在单连接 generation 内按 `sessions_spawn` 顺序确定性关联 child；超过可关联数量的记录归入“其他子任务”。这是 M2 展示边界，不扩大 BFF child capability。
- chat history 没有可靠消息时间戳。无法关联 `sourceToolCallId` 的 artifact 按 `createdAt` 排序放入会话末尾“文件”区；可关联 artifact 仍挂在对应工具卡下。
- 真机已验证 authenticated WebSocket、direct 新会话、artifact init → 私有 OSS PUT → complete、live 文件卡、下载与刷新恢复。首次完整 agent 任务暴露非法工具名并已修复；新构建加载仍需获准重启 Gateway，之后继续验证 child、技能、父工具发布和 private group。
- 测试环境旧配置含当前 schema 已拒绝的 `agents.defaults.memorySearch.lexicon`。配置热更新触发 systemd 自动重试后，只删除该废弃键并保留整份备份，Gateway 随既有 restart policy 恢复；未执行手工 restart。
- 部署排查期间测试环境对象存储凭据曾进入内部工具输出。完成验收后必须轮换该凭据，扩展专用 API key 按独立流程轮换。

### 最终验收记录（2026-07-16）

- 经用户授权重启测试 Gateway，systemd 状态为 `active/running`、RPC probe 正常、`NeedDaemonReload=no`；重建 BFF 后 `/health` 正常且 `OPENCLAW__BFF_SUBAGENTS_ENABLED=true`。Gateway 重启后的 BFF upstream 曾经历一次 57 秒自动重连，随后收敛且未再复现请求超时。
- 本地 `~/github/agent-frontend` 以 `VITE_OPENCLAW_BFF_URL=http://172.16.120.245:8004` 和测试 workspace API `http://172.16.120.245:8002` 运行。指定 direct `main` URL 实际发送算术请求并收到 `585987`，冷启动、刷新和 Gateway 再次重启后均可继续对话，新增期间浏览器无错误。
- private group 目录返回 3 个当前用户可见工作区；进入 `Qwen3.6-鹿崽子` 的独立 WebUI session 后实际收发得到 `437`。手工提交陌生 group id 会被前端纠正回授权的 direct `main`。
- 新建 session A 启动跨 agent `researcher` child；切到 session B 后 A 保持“任务运行中”，B 未出现 A 的消息或工具。`sessions_spawn` 后子任务卡出现，child 面板持续收到工具活动且没有发送/中止入口；child 最终返回 `CHILD_SMOKE_OK`，刷新后恢复为“已完成”。实际 researcher 环境把所读规划技能回显为 `taskflow`，父会话回显 `researcher-delegation`；技能名称与普通工具均未显示绝对路径或原始参数/结果。
- 父 WebUI session 两次创建 14 B 文本并调用 `webui_artifact_publish`，live 文件卡、下载跳转和刷新后的 `artifacts.list` 恢复均成功。完成验收后轮换 `openclaw-artifact-extension` API key、原子更新扩展配置并再次重启 Gateway；第二次 artifact 发布验证新 key 生效。对象存储 AccessKey 仍需云侧权限执行轮换。
- 真机冷启动暴露 assistant-ui 对非 assistant 消息携带 `status` 的异常；adapter 改为仅 assistant/tool message 设置 `status`，并补混合 user/assistant/system 生产 Runtime 回归测试。Node 22 远端测试同时暴露滚动用例未模拟 `scrollHeight` 增长，测试基建已改为显式触发 ResizeObserver 并使用递增高度，生产代码未改。
- 最终结果：agent-frontend 常规测试 `142/142`、组件测试 `73/73`、全项目 type-check、OpenClaw 目录 Biome 和生产构建通过；远端新增定向组件测试 `8/8` 通过。静态产物已同步到 `172.16.120.239`，关键文件 SHA-256 与本地一致。

## 5. 测试命令

### openclaw-integration

```bash
pnpm vitest run \
  src/gateway/server-methods/subagents.test.ts \
  src/gateway/method-scopes.test.ts \
  src/gateway/protocol/index.test.ts

pnpm vitest run --config vitest.extensions.config.ts \
  extensions/webui-artifacts/**/*.test.ts
```

### agent-server

> 前置：测试用 DB fixtures 直接构造 `openclaw-artifact-extension` SERVICE principal 与 `api_keys` 行，不依赖真机 key；真机部署用 `uv run python -m cli.main auth sync-services` + `auth create-api-key --service-name openclaw-artifact-extension` 签发（`is_admin:false`）。

```bash
uv run pytest \
  app/test/unit_test/services/test_openclaw_bridge_service.py \
  app/test/unit_test/services/test_openclaw_artifact_service.py \
  app/test/unit_test/api/test_openclaw_bridge_controller.py \
  app/test/unit_test/api/test_openclaw_artifact_controller.py \
  app/test/unit_test/infra/storage/test_openclaw_artifact_oss_storage.py \
  app/test/unit_test/infra/openclaw/test_gateway_client_adapter.py
```

### agent-frontend

```bash
npm test
npx tsc -p tsconfig.openclaw-chat.json --noEmit
npm run lint -- src/features/openclaw-bff src/utils/openclawBff
```

前端测试需包含 `ToolCallGroup` 只读展示、assistant-ui custom tool renderer、reducer 中 `args/result` 保留、`useOpenClawArtifacts`、artifact event guard、`ArtifactCard`、刷新恢复与 target/session 隔离。若 Biome 的脚本不接受路径参数，执行 `npx biome check src/features/openclaw-bff src/utils/openclawBff`。全项目 `npm run type-check` 仅在定向 typecheck 通过后按改动影响决定。

## 6. 验收标准

- [ ] 私聊与 `/api/v1/workspaces/me` 返回的 private group 都能进入；公开/陌生 group id 被拒绝。
- [ ] 同一 target 可创建、切换至少两个会话；两个会话并行运行时消息、toolCallId、runId 不串。
- [ ] 切换 target 或 session 后旧 WS 关闭，新 hello 的 target/clientSessionId 与 URL 一致。
- [ ] 父会话调用 `sessions_spawn` 后 2 秒内出现子任务卡；跨 agent child 也能发现。
- [ ] 子 panel 可看到历史消息、后续流式消息和工具活动；刷新后能恢复 active child 的状态与后续 tool events；已归档 child（默认 spawn 后 60 分钟）降级为“子任务记录已过保留期”文案，不报错。
- [ ] 子 panel 没有发送、中止、steer、kill 或继续对话入口。
- [ ] 父/子会话读取 `.../skills/planner/SKILL.md` 时显示“使用技能：planner”，不泄露绝对路径；普通 read 不误报。
- [ ] 父/子 WebUI 的工具行只显示状态图标和工具/技能名称；多工具组显示“工具调用 · N 步”，没有详情展开按钮、参数、结果、原始错误或耗时。
- [ ] `ChatToolCall.args/result` 在 live、history 和 reconcile 后仍保留于 reducer state，可继续完成技能识别和对账，但不会进入 `ToolCallGroup` 或 assistant-ui custom tool renderer 的 DOM。
- [ ] `sessions_spawn` 的 `SubagentCard` 与 `webui_artifact_publish` 的 `ArtifactCard` 作为类型化业务卡片展示，不开放对应 tool 的原始参数/结果。
- [ ] assistant-ui 接线后，`useOpenClawChat + openClawChatReducer` 仍是唯一消息/run 状态源；Runtime 不直接处理 WS、delta、seq gap、terminal 或 history reconcile。
- [ ] `onNew/onCancel/isRunning/isSendDisabled/toolCallId/runId/thread id` 均符合 D5 映射；foreign/child run 不占用或取消父 own run。
- [ ] 编辑、重新生成、分支、用户附件、客户端工具回填和排队发送入口均不可见、不可通过 Runtime API 调用；用户上滑时自动滚动不抢回底部。
- [ ] 父 WebUI agent 调用 `webui_artifact_publish` 后，即使没有文本回复，当前 session 也能出现文件卡并下载原始文件。
- [ ] 文件发布不要求 `message.channel` 或 `message.target`；`webchat` 不进入 deliverable channel 列表，`gateway-client` 不被当作 Feishu target。
- [ ] WebChat 上下文的 `message(filePath/media/...)` 不触发 `feishu-file-outbox-router`；agent 收到稳定提示并改用 `webui_artifact_publish`。显式 Feishu channel + 真实 Feishu target 的文件发送不受影响。
- [ ] artifact 只对创建时的 direct/private group session 可见；其他用户、target、session、raw sessionKey 请求 list/download 均被拒绝。
- [ ] 刷新或断线漏掉 live event 后，`artifacts.list` 可恢复 ready 文件卡；下载 URL 过期后可在 retention 内重新生成。
- [ ] 大文件上传不整文件进入 Gateway WS 或 BFF 内存；失败/超时 pending 可清理，不遗留无限期 OSS 对象。
- [ ] 配额：第 51 个 `webui_artifact_publish` 返回 `409 ARTIFACT_SESSION_LIMIT_REACHED`，agent 收到稳定文案；并发 publish 不突破 50；`(sessionRef, sourceToolCallId)` 重复 init 幂等。
- [ ] size 校验：presigned PUT 签入 `Content-MD5`，OSS 拒绝内容不匹配的上传；complete HEAD 对 size/ETag-MD5/sha256 任一不一致转 failed + 删对象；扩展字节计数器超限中止。
- [ ] 鉴权：非 `openclaw-artifact-extension` 的 SERVICE key（即便 `is_admin=false`）无法 init/complete；轮换 api key 后 BFF 零改动仍可校验。
- [ ] Redis binding：WS 断开后宽限期内迟到 publish 成功并由 list 恢复；binding 过期 init default deny；Redis 不可用时该连接 `features.artifacts=false`、聊天正常。
- [ ] 多会话：A 长任务运行中切到 B，B 无 A 的 message/toolCallId/runId；切回 A 由 history/reconcile 收敛；运行角标仅本页生效、刷新丢失。
- [ ] WS、chat history、浏览器持久状态与普通日志均不包含 object key、api key、预签名 PUT/GET URL 或宿主机绝对路径。
- [ ] 子 agent、Feishu 等外部 channel 和未绑定的 WebUI session 无法调用 `webui_artifact_publish`；原有 Feishu 文件发送行为不变。
- [ ] 浏览器直接提交 raw childSessionKey、未授权 child id 或其他用户/target 的 child id 均被 BFF 拒绝。
- [ ] BFF Gateway 连接 scopes 仍为 `operator.read/operator.write`，allowlist 不含 `exec.approval.*`。
- [ ] M1 的发送、history、abort、断线重连、foreign run、Markdown 和工具卡片回归通过。

## 7. 风险与回退

| 风险                                                                                     | 缓解/回退                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents.list` 同时读取和注册 tool recipient，语义带副作用                             | 副作用仅为当前只读连接订阅已授权 active run；在协议注释与测试中固化。后续若引入 lifecycle event，可拆成 subscribe 方法                                                                                                      |
| 轮询发现前的早期 child event 丢失                                                        | `sessions_spawn` 后 500ms 轮询；发现即拉 history；tool recipient 注册后只接后续事件                                                                                                                                         |
| BFF child capability map 错放导致跨 agent 泄露                                           | 授权来源只接受 Gateway registry 对当前父 session 的结果；opaque id；连接级生命周期；default deny 测试                                                                                                                       |
| 子 agent registry terminal 记录已归档，刷新后缺失                                        | 保留期已具体化：run-mode 默认 spawn 后 60 分钟归档（从 spawn 起算，连带删子会话 transcript；session-mode 不归档）。M2 接受该窗口：panel 降级文案；父 completion announcement 永久留在父 history。不改 Gateway、不改部署配置 |
| assistant-ui 无法干净表达 child panel/foreign run                                        | D5 已定案 greenfield 集成、**无回退路线**；Phase A 集成验证清单必须全部通过才上线，迁移期保留 `ChatMessageList` 基线；Gateway/BFF/reducer 方案不受影响                                                                      |
| ExternalStoreRuntime 形成第二状态源、合并相邻消息或补出重复 optimistic assistant         | Runtime 只接收 reducer 投影，adapter 无本地 message state；固定 `joinStrategy="none"`；fixture 比对 stable id/runId/toolCallId 和消息数量                                                                                   |
| 配置 handler 后意外开放 edit/reload/branch/attachment/queue                              | 只配置 D5 白名单字段；测试同时检查按钮不可见和 Runtime action 不可调用                                                                                                                                                      |
| 自研 `ToolCallGroup` 已隐藏详情，但 assistant-ui 默认 tool fallback 再次显示 args/result | 父/子 tool-call part 强制注册同一个只读 renderer，不注册默认详情 renderer；DOM 测试注入敏感 marker 并断言不可见                                                                                                             |
| 为隐藏 UI 提前删除 `ChatToolCall.args/result`，导致技能识别或 history/live 对账退化      | 仅删除展示函数和仅展示用截断常量；reducer/mapper 保留结构化字段并增加回归测试                                                                                                                                               |
| skill 识别属于推断，工具路径形态变化会漏报                                               | resolver 集中、fixture 覆盖多路径；漏报降级为普通 read 卡，不影响执行正确性                                                                                                                                                 |
| 一个连接一个会话导致切换时短暂断流                                                       | Gateway run 不受浏览器连接影响；切回用 history/reconcile 恢复。多连接后台订阅留后续版本                                                                                                                                     |
| 继续复用 `message(channel/target)` 会污染 channel 模型                                   | 独立 `webui_artifact_publish`；prompt、schema 和错误提示同时约束，`webchat/gateway-client` 不进入 outbound resolver                                                                                                         |
| WebChat 绑定 `feishu-*` agent 时，现有 Feishu outbox 按 agentId 误判 context             | outbox 增加 `messageChannel/sessionKey` 判定，WebChat `message(filePath)` 拒绝并提示使用 `webui_artifact_publish`；显式 Feishu target 仍走原 Feishu 发送路径                                                                |
| 现有 `IResourceStorage.upload(data: bytes)` 导致大文件内存峰值                           | artifact 使用窄 storage port + presigned PUT，OpenClaw 扩展直接流式上传 OSS                                                                                                                                                 |
| 预签名 PUT 泄露或被重放                                                                  | api key 只在扩展侧；PUT URL 短 TTL、固定 object key + 签名 headers（`Content-MD5`/`Content-Type`/`x-oss-meta-sha256`）、一次性 pending 状态；日志脱敏                                                                       |
| OSS ETag 被误当内容 hash                                                                 | M2 固定单段 PutObject，ETag 即内容 MD5；complete 同时强校验 size、ETag-MD5、`x-oss-meta-sha256` 与签名 `Content-MD5`；分片/供应商 ETag 不参与判断                                                                           |
| presigned PUT 协议层无法钉死 body size                                                   | 上传阶段签名 `Content-MD5` 内容校验 + 扩展字节计数器超限中止 + complete HEAD 强校验；残余风险（受信扩展失陷前耗带宽）由 PUT TTL/pending 清理/bucket 配额/流量告警兜底                                                       |
| 配额并发竞争突破 50                                                                      | init 用原子锁（行锁/Redis incr）统计 `pending+ready`；`(sessionRef, sourceToolCallId)` 唯一约束；满额 `409` 不建记录                                                                                                        |
| Redis binding 宽限期内迟到发布 vs 过期                                                   | `complete/abort` 不依赖 binding，pending 在 TTL 内可完成；binding 过期 init default deny；Redis 不可用仅关 artifact 发布                                                                                                    |
| 上传完成但 complete 失败产生孤儿对象                                                     | pending TTL + 定时清理；abort/失败尽力删除；按 pending age 和 orphan delete 失败告警                                                                                                                                        |
| BFF 本地 synthetic event 在重启或断线时丢失                                              | event 只负责即时性；DB artifact row + `artifacts.list` 是恢复真相源                                                                                                                                                         |
| private group 权限在 artifact 创建后被撤销                                               | 每次 list/download 重新校验 principal 与 target 权限，不把创建时授权视为永久授权                                                                                                                                            |
| 文件计算 hash/上传期间被替换                                                             | safe-open 固定文件描述符，前后 `fstat` 对账；替换、截断或 size 变化立即失败                                                                                                                                                 |
| 生产 Gateway 与 Docker 栈分机部署，`127.0.0.1:8303` 直调不可达                           | Phase A 闸门核对同宿主机前提；分机时改内网地址 + 防火墙白名单，三段式协议与鉴权语义不变                                                                                                                                     |

### 最小回退顺序

1. 关闭 BFF `features.subagents`（hello 下发 false，改配置重启即可，无需重发前端），前端自动回到父会话 `sessions_spawn` 普通工具卡。
2. assistant-ui 无运行期 feature flag；迁移期可临时切回 `ChatMessageList` 基线，验收删除后改为 revert/hotfix 提交。
3. 保留多会话与技能 resolver；二者不依赖 Gateway 子 agent 协议。
4. 若 Gateway `subagents.list` 未能同步部署，agent-server 不加入 allowlist，前端不发该方法，M1 行为保持不变。
5. 若 artifact 链路未完成，关闭 `webui-artifacts` 扩展和 BFF `features.artifacts`；不回退或改写 `message` channel 语义，OSS pending 由清理任务回收。
