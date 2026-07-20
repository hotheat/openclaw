# OpenClaw × agent-frontend：WebUI 集成里程碑方案

- 日期：2026-07-09（已吸收第二轮 review：**架构转向 BFF 桥接**，取代第一轮的浏览器直连方案）
- 架构决策：[ADR-0002](../../adr/0002-webui-bff-bridge-over-direct-gateway-connection.md)——浏览器不直连 Gateway，`agent-server` 作为 BFF 持有设备身份并强制用户/target/session 隔离。
- 上游文档：
  - [agent_frontend_webui_research.md](./agent_frontend_webui_research.md)（技术调研主报告；其 §6.2 直连路线已被 BFF 架构取代，协议/事件流分析仍有效）
  - [openclaw-frontend-integration-research.md](./openclaw-frontend-integration-research.md)（早期全景调研）
- 范围：以 openclaw-integration 网关为后端、`~/github/agent-server`（FastAPI，agent-api 实例）为 BFF，在 `~/github/agent-frontend`（React 19 + Vite 7 + Tailwind 4 + zustand + react-query）中实现多 chat Agent 工作台。
- 状态（2026-07-16 更新）：**M0、M1、M2 已交付**。M0 按 [2026-07-09-openclaw-webui-m0-bff-bridge.md](../../plans/2026-07-09-openclaw-webui-m0-bff-bridge.md) 落地；M1 按 [2026-07-13-openclaw-phase-1-single-chat.md](../../plans/2026-07-13-openclaw-phase-1-single-chat.md) 落地。M2 执行计划与最终差异见 [2026-07-15-openclaw-m2-multi-session-subagent-skills.md](../../plans/2026-07-15-openclaw-m2-multi-session-subagent-skills.md)，真机记录见 [OpenClaw M2 真机冒烟清单](./openclaw-m2-smoke-checklist.md)。

---

## 0. 总原则

1. **主通道 = agent-server BFF WebSocket 桥**（`/api/v1/openclaw/ws`）。浏览器不直连 Gateway、不持有 deviceToken/Ed25519 私钥；Gateway 原生 WS 协议只存在于 `agent-server → Gateway` 一段。不自研端到端协议、不引入 AG-UI/ACP。
2. **设备身份与 shared secret 归 agent-server**：agent-server 持 Gateway shared secret（token 或 password，现网=password）+ 单一持久 Ed25519 keypair，连接命中 `skipPairingForOperatorSharedAuth` 直通——**永不配对、不持 deviceToken**。M2 仍只声明 `operator.read/operator.write`；审批不进入当前 WebUI 路径。前端只有 target 概念（direct/private group），没有 scope 概念。
3. **前端以独立 feature 模块进 agent-frontend**，不动现有业务模块；新路由天然隔离，每个里程碑可独立上线。前端到 BFF 的 client 为轻量 req/res/event 封装（`src/utils/openclawBff/*`）。
4. **浏览器按 Feishu target 建模**：私聊=`{targetKind:"direct", targetId}`、private group=`{targetKind:"group", targetId}`；group 只来自当前用户的 `/api/v1/workspaces/me.privateGroups`。target 授权、agentId 推导和 session namespace 全部由 BFF 强制。
5. **BFF method allowlist 默认拒绝**：每个里程碑按需扩 allowlist（并按需声明对应 scopes），不存在"全权连接"。注：shared-auth 客户端的 scopes 是自声明自签名、Gateway 不约束，全权隔离靠 BFF allowlist 兜底。
6. **webchat 会话独立于飞书会话**（已确认的产品语义）：同 agent 共享 workspace/记忆/模型配置，但网页对话与飞书对话互不可见；"网页接续飞书上下文"是未来独立需求。

## 1. 里程碑总览

| 里程碑                                                  | 交付物                                                                                                                                            | 仓库                                                             | 预估                      | 依赖               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- | ------------------ |
| **M0** BFF 桥 + 连接打通 ✅已交付                       | agent-server shared-secret + 签名设备连 Gateway（零改动）+ bridge（target 授权/namespace/allowlist/事件过滤/runId 双向翻译）+ 前端轻量 BFF client | **agent-server + agent-frontend**（openclaw-integration 无改动） | 1~1.5 周                  | 无                 |
| **M1** 单会话聊天 MVP ✅已交付（见下"交付状态"）        | 实际交付 `/agent/chat` 路由：发送/流式/中断/历史 + 基础工具卡片（部分 M2 范围提前）                                                               | agent-frontend                                                   | 4~6 天                    | M0                 |
| **M2** 多会话 + 子 agent + 技能回显 + 文件交付 ✅已交付 | 私聊/private group 会话侧边栏、工具摘要、子 agent 只读活动面板、技能名称回显、`webui_artifact_publish` 文件交付（私有 OSS + BFF 鉴权下载）        | openclaw-integration + agent-server + agent-frontend             | 13.5~18.5 天              | M1                 |
| **M3** Cron 管理页                                      | 定时任务 CRUD + 运行历史 + 实时刷新                                                                                                               | agent-frontend + agent-server（admin profile + cron allowlist）  | 1 周                      | M0（可与 M2 并行） |
| **M4** 产物 Files 面板                                  | `workspace-files` 后端插件 + 上传/下载/预览面板                                                                                                   | openclaw-integration + agent-frontend（+BFF files.\* allowlist） | 1~1.5 周（含后端 2~3 天） | M2                 |
| **M5** 多 agent + 富预览                                | agent 切换、每会话模型/思考等级、HTML iframe 预览                                                                                                 | agent-frontend + agent-server                                    | 1~1.5 周                  | M2                 |

里程碑间关系：M0 → M1 → M2 → {M4, M5}；M3 只依赖 M0，默认排在 M2 后。M2 结束即达到"能用的多 chat agent 工作台"。

## 2. 里程碑详情

### M0 — BFF 桥 + 连接打通（纯基础设施，无 UI）

**执行计划已定稿**：[2026-07-09-openclaw-webui-m0-bff-bridge.md](../../plans/2026-07-09-openclaw-webui-m0-bff-bridge.md)，要点：

- **openclaw-integration：零改动**。shared-secret + 签名设备命中既有 `skipPairingForOperatorSharedAuth`（不检查 loopback，dev=prod 同链路）。无 Phase 0、无 pairing、不持 deviceToken。
- **agent-server**：单一持久 Ed25519 keypair + shared secret（`gateway_token`/`gateway_password` 恰一非空，现网=password）、upstream WS adapter/manager（进程级共享、双副本各持 keypair+连接）、bridge service（target 授权 DB 查询、agentId honor workspace-api `bindings` 覆盖 + `agents.list` 存在性校验、target-scoped namespace `agent:<agentId>:webchat:<hash16(tenant:identity:targetKind:targetId)>:<clientSessionId>`、method allowlist、runId 双向翻译 `bff-<namespace>-<frontRunId>`、chat/agent 事件按 sessionKey 过滤）、`/api/v1/openclaw/ws` endpoint（cookie/X-API-Key 鉴权，target 走 `bridge.connect` 握手不进 WS URL/header）。
- **agent-frontend**：`src/utils/openclawBff/*` 轻量 client（`bridge.connect` 握手、req/res pending、event dispatch、只见 frontRunId/clientSessionId）；vite `/api` proxy 补 `ws: true`。
- M0 allowlist：`health`/`status`/`models.list`/`chat.send`/`chat.history`/`chat.abort`/`sessions.list`/`sessions.preview`。

**验收**：见执行计划 Success Criteria（浏览器零 Gateway 凭据、shared-secret 直通无 pairing、token/password 两凭据路径、namespace 隔离、targeted tests 全过）。

### M1 — 单会话聊天 MVP

**落点**：feature 模块 `src/features/agent-chat/`（沿用 qa 模块的 api/hooks/components/screen 结构）；路由 `/agent/chats` 挂 `ProtectedRoute`（`src/app/router/AppRouter.tsx` 现有模式）。

**范围**：

- `useBridge`（BFF 连接生命周期，Zustand store；target 选择：DM / private group，group 列表来自 `/api/v1/workspaces/me`）。
- `useChatStream`：`chat.send/history/abort`；chat 事件 delta 累积 → final 落定 → aborted/error 分支；流式 Markdown 渲染。
- 会话铸造：`clientSessionId`（短 id，BFF 拼 namespace，前端不感知内部 sessionKey）。
- 输入框 + 消息列表 + 中断按钮 + 连接状态指示（含 `bridge.hello` 回读的 target/agentId 展示）。

**验收**：发消息看到流式回复；刷新页面后 `chat.history` 恢复上下文；中断保留部分输出；断网自动重连后可继续对话。

**交付状态（2026-07-14）**：已交付。实际按 [2026-07-13-openclaw-phase-1-single-chat.md](../../plans/2026-07-13-openclaw-phase-1-single-chat.md) 落地（该计划吸收三轮访谈修订，**取代本节草案**）。与草案的差异，M2 方案设计时以下述实际状态为基线：

- 路由为 `/agent/chat`（单数），固定 direct target（登录态 `feishuOpenId`）+ 固定 `clientSessionId=main`，**无 target 选择器**（DM/群选择推迟至 M2/M5）。webchat 会话与飞书隔离语义见 [ADR 0002-webui-isolated-session-over-channel-main](../../adr/0002-webui-isolated-session-over-channel-main.md)。
- feature 目录为 `src/features/openclaw-bff/`（沿用 M0 模块，未建 `agent-chat/`）。
- 状态层为**纯 `useReducer` 两层状态**（`historyBase` + `liveRuns[runId]`，historyFence 防乐观消息重复）+ `useOpenClawChat` hook（重连退避、post-ack 看门狗 + 幂等 `chat.send` 探测、delta 250ms 合并、history 对账、Page Visibility 收敛），**未用 Zustand**——瞬时聊天态按 agent-frontend 规约留在 feature 内。
- 流式 Markdown 已定型：`streamdown@2.5` + `@streamdown/cjk` + `@streamdown/code`（>12K 字符折叠并停止解析、代码围栏闭合/终态才高亮、raw HTML 禁用、链接 scheme 白名单）。
- 提前交付了部分原 M2 范围：`agent` 工具事件基础卡片 + 连续工具调用分组折叠卡（`ToolCallGroup`，按 `runId+toolCallId` 聚合）；另有 `bridge.upstream` 连接级断开事件、stalled/unknown 状态机、`IsolationNotice` 隔离提示。
- 遗留缺口（2026-07-15 访谈分流）：S1 idempotencyKey 真机确认与 OBS-001 复核并入 M2 Phase A 闸门；端到端真机冒烟清单在 M2 Phase H 固化；前端可观测性埋点（delta 丢弃数/折叠触发/探测分布/收敛耗时）**显式推迟**为 M2 后独立小任务，不随 M2 交付。

### M2 — 多会话 + 子 agent 活动 + 技能回显 + WebUI 文件交付

**执行计划**：[2026-07-15-openclaw-m2-multi-session-subagent-skills.md](../../plans/2026-07-15-openclaw-m2-multi-session-subagent-skills.md)

**范围**：

- target 只支持当前登录用户的私聊和 `/api/v1/workspaces/me` 返回的 private group；不支持公开群、未托管群或任意 group id。
- 会话侧边栏：每个 target 调用 `sessions.list`，支持新建/切换；M2 不做搜索；连接模型保持“一连接一会话”。
- 工具事件卡片：在 M1 基础上补 `tool-display` 摘要、截断策略和历史/live 一致映射。
- 技能回显：从工具参数 `skillName` 或 `read/read_file(.../skills/<name>/SKILL.md)` 派生“使用技能：<name>”；父、子会话共用 resolver，不新增 skill event。
- 子 agent：Gateway 新增只读 `subagents.list`，从持久 registry 返回当前父会话 children，并为 active child 注册当前连接的 `tool-events`；BFF 以发现结果建立 child capability map；前端展示只读状态、消息和工具活动。
- WebUI 文件交付：独立扩展 `webui-artifacts` 提供 `webui_artifact_publish`，父 WebUI 会话把 workspace 文件经私有 OSS 直传发布为 artifact；浏览器经 BFF 鉴权 list/download，刷新可恢复。不复用 `message` channel 语义，`webchat` 不进入可投递渠道。
- M2 不做审批、图片附件、usage、会话搜索/改名/删除或对子 agent 的 send/abort/steer/kill。

**前端 UI 基座**：已接入 `@assistant-ui/react` ExternalStoreRuntime；现有 reducer/hook 保持唯一状态真相，Runtime 只做确定性投影。完整论证见调研报告 §5.8。

- **adapter 已落地并完成生产接线**：除 foreign run、工具归属、合成条目三个既有案例外，组件测试覆盖“child panel 的 streaming/tool/skill 不占父 composer/isRunning”。
- **工具模型要重构，不是改名**：现状是"扁平 tool item + 渲染层按连续项分组"；assistant-ui 要求"assistant 消息内嵌 tool-call parts（按 runId 归属）"。history mapper 与 selector 的投影逻辑要重写，M2 排期给足量。
- **Streamdown 以自定义 Text part 保留**（不用 assistant-ui 内置 markdown）：12K 折叠停止解析、围栏闭合才高亮、raw HTML 禁用等策略原样带走。`ToolCallGroup`/tool-display 聚合仍是领域组件，tool-call part 只是挂载点。
- **手动集成，不跑 assistant-ui 初始化 CLI**。新依赖原则上只加 `@assistant-ui/react`。
- **不暴露 `onEdit` / `onReload` / `setMessages`**：后端无编辑/重生成/分支能力，前端不提供对应入口。
- **isRunning 映射注意**：thread 级布尔只映射 own run（sending/streaming）；foreign run 的"运行中"表现需自定义 message 组件区分，不能依赖 thread 级状态。
- 自动滚动由 `ThreadPrimitive.Viewport autoScroll` 承接；组件测试覆盖用户上滑暂停跟随、回到底部后继续跟随 streaming。

**三仓配套**：

- OpenClaw：新增 `operator.read` 方法 `subagents.list`；返回窄 DTO，并为 active child run 注册调用连接的 tool recipient。
- agent-server：allowlist 只增 `subagents.list`；child history/event 仅在该 binding 通过 `subagents.list` 建权后放行，原始 child session/run id 不下发。
- agent-frontend：`clientSessionId` 参数化；target/session 切换重建连接；child panel 只读。
- artifact 链路：OpenClaw `extensions/webui-artifacts` 直传私有 OSS；agent-server `bff-server` 增 artifact init/complete/list/download、Redis session binding 与 Traefik `/api/v1/openclaw/artifacts` 路由；前端 `useOpenClawArtifacts` + `ArtifactCard`。拓扑与默认值定案见执行计划 D7/D8。
- upstream connect 已声明 `caps:["tool-events"]`，M2 保持不变；scopes 继续为 `operator.read/operator.write`。

**验收**：direct/private group 多会话互不串流；跨 agent child 可发现并只读查看；刷新后恢复 active child 的消息和后续工具事件；父/子技能名称正确回显；未授权 child 被 BFF 拒绝；父会话可发布文件、无文本回复也出文件卡且刷新可恢复下载，越权 list/download 被拒。

**交付状态（2026-07-16）**：已交付。Gateway/BFF/前端兼容版本已进入测试环境；direct、private group、多 session 隔离、跨 agent child、刷新恢复、技能回显和 artifact 发布/下载完成真机验收。扩展专用 API key 已在验收后轮换并重新验证；对象存储 AccessKey 的云侧轮换为剩余运维动作。实现差异与证据记录在执行计划“最终验收记录”中。

### M3 — Cron 管理页

**落点**：`/agent/cron`；BFF 侧声明 **`operator.admin` scope**（cron 写操作是 admin scope），路由级守卫用 agent-server `principal.is_admin`。

**范围**：

- CRUD 表单：三种 schedule（`at` / `every` / `cron` 表达式+时区）、两种 payload（systemEvent 进主会话 / agentTurn 进隔离会话）、delivery 三选一（none/announce/webhook）。
- `cron.runs` 运行历史（status/时长/摘要）+ `cron` 事件实时刷新 + `cron.run` 手动触发。
- BFF 配套：admin scope 声明 + allowlist 扩 `cron.*` + `cron` 事件放行规则；cron 会话（`cron:<jobId>`）不在 webchat namespace，查看运行过程需要 BFF 放行规则（M3 设计点）。

**验收**：建/改/删/手动触发任务全通；历史时间线正确；任务运行时列表实时变化；非 admin 用户访问被拒并有明确提示。

### M4 — 产物 Files 面板（后端插件 + BFF allowlist，跨仓库）

> 与 M2 的边界（2026-07-15 定案）：agent **主动交付**文件给当前 WebUI 会话已由 M2 的 `webui_artifact_publish`（私有 OSS + BFF 鉴权）承接；M4 定位收窄为 workspace 文件**浏览/上传**面板。M4 设计时评估下载路径是否复用 M2 artifact 通道替代一次性 HTTP 票据。

**后端（openclaw-integration，`extensions/workspace-files/`）**：

- 插件注册网关方法 `files.list/stat/get/put`（`src/plugins/types.ts` 插件缝），大文件走一次性 HTTP 下载票据（复用 media 的 TTL/大小上限思路，指向 workspace）。
- 路径安全复用 `openFileWithinRoot` 根约束（`src/infra/fs-safe.ts`）防穿越。
- extensions 测试套件覆盖（`vitest.extensions.config.ts`）。

**BFF**：allowlist 扩 `files.*`，参数按当前连接 agentId/workspace 约束（防跨 agent 读文件）。

**前端**：

- Files 面板（`react-resizable-panels` 双栏），代码/Markdown/图片预览，不可预览走下载。
- "本会话产物"视图：从 write/edit 工具事件增量收集（零后端依赖，如 M2 后有空窗可提前做）。
- 上传 dropzone → `files.put` → 消息里引用工作区相对路径。

**验收**：上传文件让 agent 读取处理；agent 写的文件实时出现在面板并可下载；路径穿越用例被后端拒绝。

### M5 — 多 agent + 富预览

**范围**：

- 新建 chat 时选 agent：不透传 Gateway `agents.list`，改为 BFF/workspace 提供当前用户可用 target→agent 视图（M5 设计点，与 M0"不透传 agents.list"决策一致）。
- 每会话独立模型/思考级别（`sessions.patch({ model, thinkingLevel })` 需要 admin scope）+ `models.list` 选择器（M0 allowlist 已含）。
- HTML 产物 iframe 沙箱预览（对齐 canvas 模式）。

**验收**：切换 agent 后新会话进入对应隔离工作区；每会话模型/思考等级生效；HTML 预览遵守 iframe 沙箱策略。

## 3. 已定决策

| #   | 决策                          | 结论                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 前端 client 位置              | `src/utils/openclawBff/*`；不进 client-collections（独立 submodule 仓库 + 生成流程边界）；将来抽包目标为顶层 `packages/openclaw-bff-client`                                                                                                                                                                                                              |
| 2   | Scope 建模                    | agent-server 单一持久 keypair + shared secret；M0~M2 保持 `operator.read/operator.write`，M2 不声明 approvals/admin；M3 才按 cron 需要评估 admin。shared-auth 不约束 scopes，暴露面继续由 BFF allowlist 收窄                                                                                                                                             |
| 3   | 协议类型                      | BFF 帧（req/res/event + bridge.hello）为前端唯一协议面；Gateway 窄 DTO 在 agent-server 侧以 Python 常量/DTO 维护；完整 codegen 进 backlog                                                                                                                                                                                                                |
| 4   | **架构转向（第二轮 review）** | 浏览器直连 Gateway 方案作废，改为 agent-server BFF 桥接（[ADR-0002](../../adr/0002-webui-bff-bridge-over-direct-gateway-connection.md)）：用户级隔离必须在 Gateway 之上由 BFF 强制；设备身份/配对/凭据全部服务端化                                                                                                                                       |
| 5   | 凭据/鉴权                     | shared secret = token 或 password 二选一（`gateway_token`/`gateway_password` 恰一非空）；现网 `auth.mode=password`，Gateway 配置零改动；命中 `skipPairingForOperatorSharedAuth` 永不配对/不持 deviceToken；封禁=轮换 secret（此 secret 被 Control UI 用户共用，爆炸半径见风险表）                                                                        |
| 6   | webchat 会话语义              | 独立于飞书会话（同 agent 共享 workspace/记忆）；不读写 `agent:<id>:main`                                                                                                                                                                                                                                                                                 |
| 7   | Chat UI 组件层（2026-07-15）  | `@assistant-ui/react` **ExternalStoreRuntime** 已在 M2 手动接入；Streamdown 作为自定义 Text part 保留，reducer/hook 仍是唯一状态真相，child 使用隔离的只读 Runtime。否决：AI SDK Runtime（绑 Vercel 协议、与 BFF 重叠）、Ant Design X（引入 antd/CSS-in-JS 第二套主题）、AI Elements（绑 Next.js/AI SDK/UIMessage，仅选择性借用视觉）。详见调研报告 §5.8 |

## 4. 默认决策（未收到异议，按此执行）

| #   | 事项             | 默认                                                                                                                                                            |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | feature 目录命名 | ~~`src/features/agent-chat/`~~ 实际落地为 `src/features/openclaw-bff/`（M0 client demo 与 Phase 1 聊天页同居一模块，2026-07-14 确认沿用；改名收益不抵迁移噪音） |
| 2   | M3 时机          | 默认在 M2 后；定时任务诉求变急可提前到 M1 后                                                                                                                    |
| 3   | M4 后端插件归属  | 本仓库 `extensions/workspace-files/`，随 fork 演进，纳入 extensions 测试体系                                                                                    |

## 5. 风险登记（BFF 架构下修订）

| 风险                                                                                         | 影响里程碑 | 缓解                                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 上游协议演进（v3→v4）                                                                        | M0         | agent-server pin PROTOCOL_VERSION + `hello-ok.features.methods` 探测；本仓库是受控 fork                             |
| shared secret 泄露即获 operator 全权（scopes 自声明，Gateway 对 shared-auth 客户端不约束）   | M0         | 视为长驻高权凭据，按全权级别审计/告警；轮换爆炸半径含 Control UI 用户（clawgateway.otr-tx.com）                     |
| `chat.history` 截断（单条 12K、图片 data 剥离）                                              | M1/M4      | 长产物引导走 Files 面板；client 对 `__openclaw.truncated` 显式暴露"查看完整内容"入口                                |
| 非图片附件上传缺口                                                                           | M4         | M2 不做附件；M4 统一处理工作区上传                                                                                  |
| `sessions.patch/delete` 等属 admin scope，多会话管理受限                                     | M5         | M2 明确不做改名/删除；后续与每会话模型设置一起裁决                                                                  |
| admin scope 粒度粗（cron 与 `config.set` 同档）                                              | M3         | BFF allowlist 只放 `cron.*` + agent-server is_admin 守卫（BFF 收窄 admin 暴露面；shared-auth 下无法靠独立身份隔离） |
| BFF 成为单点/额外一跳                                                                        | M0+        | agent-api 双副本各持 upstream 连接；WS 断线前端退避重连                                                             |
| 子 agent 会话跨 agent 且不在父 webchat namespace                                             | M2         | Gateway registry 作为唯一授权来源；BFF connection-local capability map + opaque ids；默认拒绝                       |
| assistant-ui adapter 阻抗（工具模型、foreign run、合成条目、child panel 与父 composer 状态） | M2         | 已用 ExternalStoreRuntime 确定性 adapter 与只读 child runtime 落地；组件测试覆盖父子运行态隔离                      |
| WebUI 文件交付跨宿主机/容器拓扑（Gateway 在宿主机、bff-server 在容器）                       | M2         | internal 端点 127.0.0.1 绑定 + service token；presigned URL 短 TTL；`artifacts.list` 为恢复真相源（执行计划 D7/D8） |

（第一轮的"浏览器设备配对 UX"“`crypto.subtle` 需安全上下文"风险随直连方案作废而移除——设备身份已服务端化。）

## 6. 下一步

1. ~~按 M0 执行计划开工~~ **M0 已交付**（[执行计划](../../plans/2026-07-09-openclaw-webui-m0-bff-bridge.md)）。
2. ~~M1 计划在 M0 收尾时再写~~ **M1 已交付**（[Phase 1 单会话聊天计划](../../plans/2026-07-13-openclaw-phase-1-single-chat.md)，差异见 M1 节"交付状态"）。遗留项带入 M2 前置：前端可观测性埋点、端到端真机冒烟、S1 idempotencyKey 真机确认。
3. ~~M2 代码、部署与真机验收~~ **M2 已交付**；测试直连端口按当前本地验收需求保留。剩余运维动作是由基础设施所有者轮换验收期间暴露的对象存储 AccessKey。
