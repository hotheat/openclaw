# OpenClaw × agent-frontend：多 Chat WebUI 技术调研报告

- 日期：2026-07-06（2026-07-15 增补：§5.3 子 agent 协议边界、§5.5 exec 直接执行现状与 M2 范围；M2 以 [最新执行计划](../../plans/2026-07-15-openclaw-m2-multi-session-subagent-skills.md) 为准）
- 范围：以 `openclaw-integration`（本仓库）为后端，在 `../agent-frontend`（已有 React SPA）中实现类似 OpenWork / AionUi 的多 chat 交互，覆盖本地文件操作、代码执行、产物上传下载、子代理展示、会话管理、定时任务管理。
- 结论先行：**不需要自研协议，也不建议引入第三方开源协议作为主通道。OpenClaw Gateway 的原生 WebSocket 协议本身就是一份"已经写好的自研协议"——强类型（TypeBox）、带文档、带浏览器参考实现，且是唯一覆盖全部需求原语（会话/流式/工具事件/审批/cron）的通道。前端工作量的本质是"移植一个 ~600 行的 WS 客户端 + 搭 React 状态层"，而不是协议开发。**

---

## 1. 第一性原理：把需求还原成原语

"Web 前端操控本地 Agent"这件事，剥掉交互皮肤后只剩 7 个原语。任何框架/协议选型，都应先问：这 7 个原语它覆盖几个？

| #   | 原语       | 具体含义                                             | OpenClaw 网关对应物                                                        | 状态    |
| --- | ---------- | ---------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| P1  | 会话       | 创建/列出/切换/改名/删除/压缩对话                    | `sessions.list/preview/patch/reset/delete/compact`                         | ✅ 原生 |
| P2  | 消息       | 发送（含附件）、流式接收、中断                       | `chat.send/history/abort` + `chat` 事件（delta/final/aborted/error）       | ✅ 原生 |
| P3  | 过程可观测 | 文本增量、思考、工具调用（名/参/果）、生命周期、用量 | `agent` 事件（stream = `lifecycle/assistant/tool/error`，含 `sessionKey`） | ✅ 原生 |
| P4  | 人工干预   | 危险命令审批、注入消息                               | `exec.approval.requested` 事件 + `exec.approval.resolve`；`chat.inject`    | ✅ 原生 |
| P5  | 产物       | 上传（入）、下载（出）、浏览                         | 上传=chat 附件（base64）；下载=`/media/:id`（一次性）；**浏览=缺口**       | ⚠️ 部分 |
| P6  | 调度       | 定时任务 CRUD + 运行历史                             | `cron.list/status/add/update/remove/run/runs` + `cron` 事件                | ✅ 原生 |
| P7  | 身份安全   | 认证、授权分级、设备身份                             | token/password → deviceToken；scope 四档；设备配对                         | ✅ 原生 |

关键事实（决定可行性的三条）：

1. **多 chat 天然成立**。`chat.send` 的 `sessionKey` 会被规范化后按需建会话：任意非 `agent:` 前缀的 key 会补全为 `agent:<agentId>:<key>`（`src/routing/session-key.ts:46` `toAgentStoreSessionKey`），会话存储"删了会按需重建"（`docs/concepts/session.md`）。前端每开一个新 chat 就铸造一个 key（如 `agent:main:webchat-<uuid>`）即可，与 WhatsApp/Telegram 等渠道会话同存同管。
2. **工具事件是按 run 定向推送**。agent 事件带 `runId/seq/sessionKey`，客户端需声明 `caps:["tool-events"]`；Gateway 只向 `toolEventRecipients` 中已登记的连接发送工具流。`chat.history` 不会登记进行中 run，刷新恢复必须重新注册或通过 history 对账，不能假定工具事件天然全局可见。
3. **子 agent 是带血缘的独立会话，但现有会话列表不足以直接下钻**。`sessions_spawn` 产出 `childSessionKey + runId`，subagent registry 持久化 requester/child/status；child 可能属于另一个 agent。`sessions.list` 虽可按 `spawnedBy` 过滤，但返回行不包含稳定的血缘/深度 DTO，BFF 的父 agentId/namespace 过滤也会排除跨 agent child。M2 需新增窄 `subagents.list`。

---

## 2. 后端对接面盘点（本仓库实测）

### 2.1 传输与握手

- WebSocket 单端口，JSON 文本帧，三种帧型：`req` / `res` / `event`（`src/gateway/protocol/schema/frames.ts`）。协议版本 v3，TypeBox schema 全量定义，可 `pnpm protocol:gen` 生成模型（`docs/gateway/protocol.md`）。
- 握手：服务端先发 `connect.challenge`（nonce），客户端首帧必须是 `connect`，携带 `client{id,version,platform,mode}`、`role`（operator/node）、`scopes`、`auth{token|password|deviceToken}`、`device{id,publicKey,signature,...}`（ed25519 对 nonce 签名）。成功返回 `hello-ok`：方法/事件清单、状态快照、`canvasHostUrl`、可持久化的 `deviceToken`。
- 浏览器参考实现已存在：`ui/src/ui/gateway.ts`（`GatewayBrowserClient`：challenge 签名、请求-响应 pending 表、seq 缺口检测、指数退避重连）+ `ui/src/ui/device-identity.ts`（`@noble/ed25519` 生成/持久化设备身份）。**这两个文件就是 React 版 SDK 的蓝本。**

### 2.2 方法面与权限分级

方法全集见 `src/gateway/server-methods-list.ts`，scope 映射见 `src/gateway/method-scopes.ts`：

| Scope                | 本项目会用到的方法                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`      | `sessions.list/preview`、`chat.history`、`cron.list/status/runs`、`agents.list`、`models.list`、`usage.*`、`health/status` |
| `operator.write`     | `chat.send/abort`、`agent`、`agent.wait`、`send`                                                                           |
| `operator.admin`     | `cron.add/update/remove/run`、`sessions.patch/reset/delete/compact`、`chat.inject`、`config.*`、`agents.files.set`         |
| `operator.approvals` | `exec.approval.request/waitDecision/resolve`                                                                               |

含义：聊天页只需 read+write token；**cron 管理页和会话管理（改名/删除/压缩）需要 admin**；审批面板需要 approvals。设备 token 按角色+scope 签发，可轮转/吊销。

### 2.3 事件面（前端渲染的原料）

| 事件                               | 载荷要点                                                           | UI 用途                                          |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `chat`                             | `runId/sessionKey/seq/state(delta,final,aborted,error)/message`    | 消息气泡流式渲染、终态落定；usage 非稳定展示合同 |
| `agent`                            | `runId/seq/stream(lifecycle,assistant,tool,error)/sessionKey/data` | 工具卡片、思考态、模型 fallback 提示、子代理活动 |
| `exec.approval.requested/resolved` | 命令、来源会话                                                     | 审批弹窗/队列                                    |
| `cron`                             | job 状态变化                                                       | 定时任务页实时刷新                               |
| `presence` / `health` / `tick`     | 设备在线、网关健康                                                 | 顶栏状态、心跳                                   |

Control UI 的工具流聚合器 `ui/src/ui/app-tool-stream.ts`（按 `toolCallId` 聚合、50 条上限、80ms 节流、120K 字符截断）与 `src/agents/tool-display.json`（每个工具的 emoji/标题/摘要字段映射）可直接移植——工具卡片的"显示语义"官方已经整理好了。

### 2.4 会话/多 agent 模型

- 会话由网关全权持有（"Gateway is the source of truth"，`docs/concepts/session.md`），UI 不读本地文件。`sessions.list` 支持 `includeDerivedTitles`（取首条用户消息当标题）、`includeLastMessage`（最近消息预览）、`label/spawnedBy/agentId/search` 过滤——**开箱即用的 chat 列表页数据源**。
- `sessions.patch` 可按会话改 label、模型、thinking 级别、sendPolicy——对应"每个 chat 独立选模型"。
- 多 agent：一个网关可挂多个隔离 agent（独立 workspace/凭据/会话库，`docs/concepts/multi-agent.md`），`agents.list/create/update/delete` 全套管理。UI 的"新建 chat"可先选 agent 再铸 key。
- 系统会话有稳定前缀可分组展示：`cron:<jobId>`、`hook:<uuid>`、子代理会话（`spawnedBy` 非空）。

### 2.5 本地文件与代码执行

- 文件读写、命令执行是 **agent 侧工具**（read/write/edit/exec），工作区 `~/.openclaw/workspace` 是默认 cwd（非硬沙箱；可选 `agents.defaults.sandbox`）。前端"操作本地文件/执行代码"= 通过对话驱动 agent 工具 + 在 UI 上渲染工具事件，而非前端直接碰文件系统——这与 OpenWork/AionUi 的模式一致。
- Gateway 具备 exec 审批协议，但当前 `openclaw-workspace` 部署为 `security="full"`、`ask="off"`。M2 保持直接执行，不接 approvals scope；未来启用 ask 时需另做 pending 恢复和归属隔离设计。

### 2.6 产物通道现状（唯一的真缺口）

- **上传**：`chat.send.attachments` 走 base64（≤5MB，`src/gateway/server-methods/chat.ts:722`），图片会解析成模型可见的 content block（`src/gateway/chat-attachments.ts`）；非图片文件当前没有"上传到工作区"的正式通道。
- **下载**：`GET /media/:id` 是**一次性 + TTL + 大小上限**的临时媒体口（发完即删，`src/media/server.ts:34`），适合聊天内图片/语音，不适合"产物库"。
- **浏览**：`agents.files.*` 只管 AGENTS.md/SOUL.md 等 workspace 引导文件（`src/gateway/server-methods/agents.ts:115`），不是通用文件树。
- **补法（零 fork）**：插件系统允许注册自定义网关方法和 HTTP 路由（`src/plugins/types.ts:245`，`.codex/docs/plugin_system.md`）。写一个 `workspace-files` 插件提供 `files.list/files.stat/files.get`（小文件走 WS base64，大文件发临时 HTTP 下载票据），文件打开复用 `openFileWithinRoot` 的根约束（`src/infra/fs-safe.ts`）防穿越。预估 2~3 天工作量，是整个方案里唯一需要动后端的部分。
- **富展示**：`hello-ok.canvasHostUrl` + canvas 能力（macOS 侧 `docs/platforms/mac/canvas.md`）说明"agent 写 HTML → 面板渲染"的模式在体系内已有先例，Web 端可后续对齐（iframe 沙箱渲染工作区 HTML 产物）。

### 2.7 已有的三个"开源协议出口"（重要：都已存在，但都不该当主通道）

| 出口                             | 位置                                    | 能力                                                                   | 局限                                                     |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| OpenAI Chat Completions          | `src/gateway/openai-http.ts`            | SSE 流式文本，会话可映射                                               | **只有文本 delta**，工具事件/审批/会话管理全丢           |
| OpenResponses `/v1/responses`    | `src/gateway/openresponses-http.ts:344` | 比 completions 富（lifecycle 事件）                                    | 同类局限，面向第三方客户端兼容                           |
| **ACP bridge**（`openclaw acp`） | `src/acp/server.ts`、`docs/cli/acp.md`  | 完整 Agent Client Protocol，stdio 转发到网关 WS，会话映射 `acp:<uuid>` | **stdio 语义**：浏览器无法 spawn 进程，只适合 IDE/桌面壳 |

ACP bridge 的存在有一个直接推论：**AionUi（ACP 客户端，自动检测 Claude Code/Codex/Gemini CLI，也支持自定义 agent）今天就能以零后端改动接上 OpenClaw**，配置方式与 Zed 相同（`docs/cli/acp.md` 有现成配置示例）。这是验证成本最低的"桌面备选方案"；AionUi 虽自带远程 WebUI/IM 接入，但其 agent 通道仍锚定本机 Electron 进程，不满足"融入 agent-frontend 的 Web 模块"这个前提。

---

## 3. 四个参考项目：范式与可复用性

> 核实状态：DeerFlow 为本机源码实测；OpenWork / AionUi / deep-agents-ui 已于 2026-07-06 联网核实（GitHub README）。

| 维度                 | OpenWork (different-ai)                                                                                               | AionUi (iOfficeAI)                                                                                | deep-agents-ui (langchain-ai)                                         | DeerFlow frontend（实测）                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 形态                 | **Tauri** 桌面 app（"Claude Cowork / Codex 的开源替代"），MIT                                                         | Electron + React（UnoCSS）桌面 app，Apache-2.0；另带远程访问出口（WebUI/Telegram/Lark/钉钉/微信） | Next.js + React + Tailwind Web app，MIT；**已于 2026-06-28 存档只读** | Next.js 16 Web app                                                |
| 后端协议             | `opencode serve` 本地服务器，`@opencode-ai/sdk` + SSE 流式；host/client 两种模式（本地全栈 / 连远程 opencode server） | **ACP**（自动检测 Claude Code / Codex / Gemini CLI）+ MCP 工具配置                                | LangGraph API（部署 URL + assistant ID）                              | LangGraph 协议 `/api`（`.env.example` 实测）                      |
| 多 chat              | ✅ 多会话（创建/选择/发送）                                                                                           | ✅ 多会话独立上下文、并行执行                                                                     | ✅ threads                                                            | ✅ `/chats/[thread_id]` 路由（实测）                              |
| 文件/产物            | 本地文件协作；模板保存复用；技能管理器                                                                                | 文件管理（批量重命名/自动分类）+ 预览面板（PDF/Word/Excel/PPT/代码等 10+ 格式）                   | Files 面板（运行时生成的文件，点击查看内容）                          | 报告 artifact 双栏                                                |
| 审批/干预            | ✅ 权限请求 UI（允许一次/始终/拒绝）                                                                                  | ✅（代理工具执行控制）                                                                            | Debug 模式（逐步执行、重跑指定步骤）                                  | —                                                                 |
| 子代理展示           | —（流式执行计划渲染）                                                                                                 | 多 agent 团队模式（Leader-Teammate 架构）                                                         | ✅ 任务进度 + 文件实时状态（读 LangGraph state）                      | 计划/活动流（researcher/coder 节点）                              |
| 定时任务             | —                                                                                                                     | ✅ cron 表达式或固定间隔（24/7）                                                                  | —                                                                     | —                                                                 |
| 对接 OpenClaw 的路径 | 协议不匹配（绑 opencode SDK），移植成本 ≥ 自建                                                                        | **ACP 直连可用**（桌面场景零改动；其远程 WebUI 只是 Electron 宿主的遥控壳，agent 通道仍在本机）   | 协议不匹配（绑 LangGraph server），且项目已停维护                     | 协议不匹配，且 Next.js 全家桶与 agent-frontend 的 Vite SPA 不同构 |

**该抄什么：**

- **deep-agents-ui**：最值得抄的是**信息架构**——左侧 chat、右上 Tasks（TODO/子代理）、右下 Files（产物）三区布局；子代理/任务点击下钻，Files 面板实时反映运行时产物。它证明"子代理 = 可下钻的次级事件流"这个交互是成立的，而 OpenClaw 的 `spawnedBy` 会话树恰好是更强的数据源。（注意：该项目 2026-06-28 已存档只读，只能当范式标本，不能指望跟进维护。）
- **DeerFlow**：多 chat 的路由组织（`/chats/[thread_id]`）、`use-stick-to-bottom` 滚动、流式 markdown（`streamdown`）、双栏 artifact。它的组件生态（Vercel AI Elements + radix + shadcn）与 agent-frontend 的 shadcn 风格同源，**组件可以按文件级摘抄**。
- **AionUi**：多会话 + 文件管理器 + 审批的桌面交互密度；以及"定时任务作为一等 UI 公民"的产品判断。
- **OpenWork**：架构隐喻——"UI 壳 + 本地 agent server + 明确 API"三层分离。OpenClaw 网关在这个隐喻里就是 opencode server 的位置，而且 API 面更宽（渠道/cron/审批）。

**为什么不二开它们**：AionUi（Electron）/OpenWork（Tauri）是桌面工程，起点就不满足"Web UI + 融入现有 agent-frontend"的前提——AionUi 虽带远程 WebUI，但那是 Electron 宿主的遥控壳，agent 全在其本机进程里，无法脱壳复用；deep-agents-ui/DeerFlow 的协议层深绑 LangGraph，且 deep-agents-ui 已停维护。四者的价值都在交互范式，不在代码基座。

---

## 3.5 Codex（app / cli / app-server）可行性专题

> 核实状态：2026-07-07 联网核实（OpenAI 官方文档 + openai/codex 仓库 README + codex-rs/app-server README）。

Codex 与前四个参考项目不同：它**同时是 agent 引擎、是协议、是成品 UI**，三重身份混在一起。下表先拆开，再逐条裁定可行性。

| 形态                                          | 开源       | 技术栈                                          | 角色                                  | 对本项目的相关性                               |
| --------------------------------------------- | ---------- | ----------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| **Codex CLI**（`codex-rs`）                   | Apache-2.0 | Rust，ratatui+crossterm 终端 UI，无内置 Web UI  | 本地 agent 引擎                       | 可作 OpenClaw 的 agent 引擎（经 ACP，见路径①） |
| **Codex app-server**（`codex-rs/app-server`） | Apache-2.0 | JSON-RPC 2.0 双向协议                           | 富客户端协议（驱动官方 VS Code 扩展） | 协议候选 / 设计参考（见路径②）                 |
| **Codex App / Codex Web**                     | 闭源       | 桌面 app（`codex app`）/ chatgpt.com/codex 云端 | 成品 UI                               | 交互范式标本（见路径③）                        |

### app-server 协议实测

它是 Codex 体系里唯一值得认真评估的协议面，事实如下：

- **传输**：stdio（默认 JSONL）/ unix socket / **WebSocket（官方标注 `experimental / unsupported`，原文 "Do not rely on it for production workloads"）** / off。**非回环 WS 在 rollout 期间默认允许未认证连接**。浏览器只能走 WS 这条实验通道。
- **三原语**：`Thread`（会话）/ `Turn`（一轮）/ `Item`（消息/推理/命令/文件编辑/工具调用等持久单元）。`thread/start·resume·fork·list·read`、`turn/start·steer·interrupt`；`turn/steer` 可向进行中 turn 追加输入（对应 OpenClaw `chat.inject`）。
- **流式与工具**：`item/started·completed`、`item/agentMessage/delta`、tool progress 通知——P2/P3 数据面覆盖扎实。
- **审批**：approval policy / approvals reviewer 作为 `turn/start` 一等参数——P4 有原生表达。
- **类型与代码生成**：`codex app-server generate-ts / generate-json-schema`，产物按版本钉死——与 OpenClaw `pnpm protocol:gen` 同路数。
- **能力协商**：`initialize` 携 `clientInfo` + `capabilities`（`experimentalApi` 开关、`optOutNotificationMethods` 按连接静默指定通知）。
- **控制面缺口（关键）**：协议面**没有 cron/调度、没有渠道路由、没有多 agent 工作区隔离**（Codex 的"多代理"是同引擎内的 Ultra reasoning effort，非独立隔离 agent；`multiAgentMode` 已废弃忽略）、**没有设备配对/分级 scope**（仅 per-server token 认证：capability-token / signed-bearer-token）。`clientInfo.name` 还会被上报到 OpenAI 合规日志平台，企业用途需登记 known-clients。

### 三条可行性路径

**① Codex CLI 作 OpenClaw 的 agent 引擎（经 ACP）——✅ 可行，已支持，但正交于本报告。**
Codex CLI 经官方 [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) 适配器讲 ACP，OpenClaw 已有 ACP bridge（见 2.7）。这等于"把 OpenClaw 后端的 agent 换成 Codex 引擎"，**不改变 WebUI 的协议栈**——前端仍走网关原生 WS。它解决的是"用哪家模型/引擎"，不是"前端怎么对接"。与前文 AionUi 检测 Codex CLI 是同一回事，零新增价值。

**② 前端直连 Codex app-server（绕过 OpenClaw 网关）——⚠️ 技术可行（localhost/SSH 转发），不建议作生产主通道。**
数据面它和网关原生 WS 打平（Thread/Turn/Item 不逊于 session/run，流式+审批+代码生成齐全）。但作为本项目主通道有三处硬伤：

1. **传输不达标**：浏览器只能走 experimental/unsupported 的 WS，且非回环默认无认证——直接撞上 P7 安全要求。
2. **丢失整个控制面**：无 cron(P6)、无渠道、无多 agent 工作区、无设备配对/分级 scope(P7)。等于**用 Codex 替换 OpenClaw，而不是集成它**——本报告"控制面 vs 数据面"的论证在此复现：app-server 是又一份"只覆盖一次运行的数据面"协议（见 4.2-5）。
3. **产品面耦合**：绑定 OpenAI 模型层（gpt-5.x）、合规日志平台、企业 client 登记。OpenClaw 网关是中立控制面，app-server 是 OpenAI 自家产品面。

**③ Codex App 作前端交互范式参考——✅ 有价值，但闭源同 AionUi/OpenWork。**
Codex App（桌面）的并行 thread、Git worktree 隔离、approval/steer UX、Computer Use 是值得借鉴的交互密度。但桌面 app 闭源（`codex app` 二进制），只能当范式标本，非代码基座；Codex Web（chatgpt.com/codex）全闭源。

### 该抄什么（即使不把 app-server 当主通道）

- **Thread/Turn/Item 三原语 + `thread/fork` / `parentThreadId` / `ancestorThreadId` 的 spawn-edge 模型**：比 OpenClaw 当前的 `spawnedBy` 字符串过滤更结构化，是 OpenClaw 协议演进可借鉴的子代理树表达。
- **`turn/steer`**：印证 `chat.inject` 这类"向进行中运行追加输入"原语的必要性。
- **`generate-ts` / `generate-json-schema`**：印证"自研协议 + 代码生成"路线（OpenClaw 已有 `protocol:gen`）。
- **`optOutNotificationMethods` 每连接静默、approval policy 作 turn 一等参数**：细节级可借鉴。

### 结论

Codex **不构成对"网关原生 WS 作主通道"这一结论的挑战**：作为引擎它已可经 ACP 接入（路径①，正交）；作为直连主通道它丢了控制面且踩实验性传输（路径②，不建议）；作为交互范式它有借鉴价值但闭源（路径③）。**把它列入"协议/交互参考"档，与 deep-agents-ui 同级；不列入"主通道候选"。**

---

## 3.6 三层架构同构性：OpenClaw 本就是 Codex/opencode 那套

> 一个把 §3 / §3.5 参考项目盘点收束为单一结论的洞察：三者是同一套"引擎 + 协议 server + 前端"三层架构，而 OpenClaw 已身处其中。

把 Codex、OpenWork/opencode、OpenClaw 的分层对齐后发现：**它们是同一个三层模式**（也是当前 agent 工具圈的事实标准——Codex / opencode / WorkBuddy·CodeBuddy / OpenClaw / ACP 生态皆然）。这意味着"参考 Codex/opencode"的本质不是"再造一套"，而是"识别出 OpenClaw 已经身处这套模式、且 server 层更厚"。

### 三层模式对齐

| 层                 | 职责                               | Codex                          | OpenWork + opencode                        | **WorkBuddy (CodeBuddy)**                                | **OpenClaw**                                               |
| ------------------ | ---------------------------------- | ------------------------------ | ------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| **引擎层**         | 干活：模型/sandbox/工具/MCP/状态机 | `codex-core`（库）             | opencode 引擎                              | `codebuddy`（`@genie/runtime`+`@openai/agents`+sandbox） | `src/agents/`                                              |
| **协议 server 层** | 引擎↔线协议翻译、流式事件          | `codex app-server`（JSON-RPC） | `opencode serve`（HTTP/SSE）               | `codebuddy --serve`（HTTP/WS + JSON-RPC + UDS）          | `src/gateway/`（WS 帧/方法/事件）                          |
| **前端层**         | 消费事件流、**全部渲染**           | VS Code 扩展 / TUI / 桌面 app  | OpenWork(Tauri) / opencode TUI·desktop·IDE | Electron + React 19 + 独立 `web-ui`                      | Lit Control UI / Swift app / **目标 React agent-frontend** |
| **控制面**         | 渠道/cron/审批/设备                | ✖                              | ✖                                          | `claw` 渠道（wechatmp…）/ 审批 / artifact-index          | 渠道 + cron + 设备 + 分级 scope                            |

### 两处必须校准的认知

1. **"runtime"与"server"是同一进程，不是两个服务。** 引擎库被静态链接进 server 二进制，引擎就在 server 进程内跑（in-process 调用，非 IPC）。"引擎 + 协议外壳"是**概念分层**，不是进程边界。
2. **server 不"输出 UI"，它输出语义事件。** app-server / opencode serve / OpenClaw gateway 都对 UI 一无所知——吐的是结构化事件（`item/agentMessage/delta`、`tool` 进度、`turn/completed`；OpenClaw 的 `chat`/`agent` 事件）。**渲染 100% 在前端**。这条边界正是协议层存在的意义：把引擎和任何具体 UI 技术（Tauri/React/Lit/Swift）解耦。**对 React agent-frontend 的直接推论：整层渲染都归你，gateway 只喂事件流。**

### OpenClaw gateway 的逐格对应（已存在，无需新建）

- `src/gateway/protocol/`（schema/frames）≡ Codex `app-server-protocol`
- WS 传输 + 握手 ≡ Codex `app-server-transport`
- `src/gateway/server-methods/*` 把客户端请求翻译成 `src/agents/` 调用 ≡ app-server 把 `thread/turn` 翻译成 `codex-core` 调用
- `src/infra/agent-events.ts` 把引擎事件翻译成 `chat`/`agent` WS 事件 ≡ app-server 把 core 事件翻译成 JSON-RPC 通知

### OpenClaw 的 server 层反而更厚

Codex app-server / opencode serve 基本是**单引擎的数据面 server**（opencode serve 与 gateway 更近，都是常驻多客户端；Codex app-server 默认是被客户端拉起的 per-session 子进程）。而 OpenClaw gateway 是常驻、多租户的**控制面**——cron、渠道路由、设备配对、分级 scope 全在 server 层。这也是 §4.2 第 5 点的正面印证：别家协议连控制面都没有，OpenClaw 一条协议同时打通数据面 + 控制面。

### 该借的是打磨，不是模式

模式 OpenClaw 已具备；从 Codex/opencode 借的是**协议设计质量**：

- **原语命名与事件分类法**：Codex `Thread/Turn/Item` + `item/started·completed·agentMessage/delta` 比 `session/run` + `chat/agent` 更清晰、更易渲染（见 §3.5）。
- **protocol / transport 分层洁癖**：OpenClaw 已有 `pnpm protocol:gen`，可对照 Codex 把"协议定义"与"传输实现"彻底解耦的边界。
- **"server 只发语义事件、不懂 UI"的纪律**：写 React 前端时务必守住——别让 gateway 为配合某个组件去改事件形状，事件保持中性，渲染逻辑全在前端。

### 结论

"引擎 + 协议转换 server + 渲染前端"三层是当前 agent 工具圈的事实标准，**OpenClaw 恰好已是这套**。因此本项目定位不是"参考 Codex 造一个三层系统"，而是：**把已有的 gateway 层用好、把前端渲染层做扎实**。这与 §4 的主结论（网关原生 WS 作主通道）互为表里。

---

## 3.7 WorkBuddy（腾讯 CodeBuddy 桌面壳）：最贴近 OpenClaw 的商业印证

> 核实状态：2026-07-07 本机 `/Applications/WorkBuddy.app` bundle 实测（Info.plist / `app.asar.unpacked` / `cli/package.json` / 运行进程 / `~/.workbuddy` 数据目录）。

WorkBuddy 不是又一个"前端范式标本"——它是**腾讯 CodeBuddy 的 Electron 桌面外壳，包裹 `codebuddy` CLI 运行时**，整体形态与 OpenClaw 高度同构。证据来自 bundle 内 `cli/package.json`：

- `"name": "@genie/agent-cli"`，发布名 **`@tencent-ai/codebuddy-code` v2.106.4**
- `"description": "Use CodeBuddy, Tencent's AI assistant, right from your terminal…"`
- homepage `cnb.cool/codebuddy/codebuddy-code`

与 OpenWork 的关系完全平行：**OpenWork = Tauri 壳 × opencode；WorkBuddy = Electron 壳 × codebuddy。**

### 三层落地（本机实测）

| 层              | WorkBuddy 实现         | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **引擎**        | `codebuddy` CLI 运行时 | `@genie/runtime`+`@genie/core`；基于 `@openai/agents` 0.5.2；sandbox = `@anthropic-ai/sandbox-runtime` + `@tencent-ai/sandbox-cli`（运行中的 `sandbox-cli` 进程）；多模型（asar 含 openai/anthropic/gemini）；`e2b` 云沙箱                                                                                                                                                                                                             |
| **协议 server** | `codebuddy --serve`    | scripts `"serve": "node bin/codebuddy --serve"` / `"--serve --port 3000"`；协议 = **JSON-RPC**（`vscode-jsonrpc`+`vscode-languageserver-protocol`，与 Codex app-server / ACP 同族）；server 传输 = express + `ws`；运行中的 `sandbox-cli` 同时监听 **UDS `/tmp/WorkBuddy_<id>.sock`**（即 `ipcAddress`）与 **`127.0.0.1:65054` TCP**；并有 `src/node/remote-gateway/web-ui`（即 `dist/web-ui`）——**协议 server 后面挂一份独立 web-ui** |
| **前端**        | Electron + React 19    | Chromium renderer；React `~19.1.2`；内建 `web-ui`；应用内终端 = **ghostty VT (wasm)** + `devtools-terminal`；`@tencent/smart-doc-editor`（文档/产物渲染）                                                                                                                                                                                                                                                                              |

### `~/.workbuddy` 数据目录 ≈ OpenClaw 布局翻版

```
sessions/ tasks/ plans/ traces/ workspace/ workspace-state.json
skills/ plugins/ connectors/ connectors-marketplace/
memory/ IDENTITY.md SOUL.md USER.md BOOTSTRAP.md     ← 身份文件
audit-log/ mcp-approvals.json                        ← 审批子系统
artifact-index/ workbuddy.db (better-sqlite3)        ← 产物 + 状态
binaries/ shell-snapshots/ logs/ usage-log.json
```

且 `settings.json` 含 **`"claw": { "channels": { "wechatmp": { "connectionMode": "webhook" } } }`**——一个带 webhook 连接器的 **`claw` 渠道子系统**。仅凭 bundle 无法判定 WorkBuddy 的 `claw` 与 OpenClaw 是否有代码级血缘（命名收敛是事实，且本仓库工作树里有 `.workbuddy/` 目录）——**留待人工确认**。但无论是否同源，结构对应无可争议：这是一套**完整的 local-first、多渠道、插件可扩展的 agent 网关**。

### 定位与可借鉴度

1. **最强印证**：一款大型商业产品（腾讯 CodeBuddy）出货的就是 §3.6 那套三层 + local-first 网关形态。OpenClaw 不是异类，而是朝一条已被验证的产品形态收敛。
2. **比 OpenWork/AionUi 更好的交互参考**：(a) Electron + React 19，比 Tauri/Solid 更贴近 agent-frontend 的 React+Vite；(b) 已有 `--serve` 协议 server 与渲染层分离、并挂独立 `web-ui`——正是"server 吐语义事件、renderer 拥有 UI"纪律的活样本；(c) 功能面齐全（渠道/skills/plugins/MCP/sandbox/审批/artifact-index/终端）。
3. **不二开**：与 OpenWork 同理，renderer 紧耦合自家 `codebuddy` 协议，价值在范式不在代码基座。
4. **两条对接路径（与 Codex 同构）**：`codebuddy` 讲 ACP（`@agentclientprotocol/sdk` ^0.25）→ 可作 OpenClaw 的引擎（路径①，经 ACP）；`codebuddy --serve` 是与网关同级的协议 server（路径②，因控制面理由同样不采纳为主通道）。

### 结论

WorkBuddy/CodeBuddy 是迄今**与 OpenClaw 形态最接近的商业参照**，把 §3.6 的"三层同构 + local-first 网关"从开源推论升级为有大厂出货证据的事实。归入"交互/架构参考"档（高于 OpenWork/AionUi），不进"主通道候选"。

---

## 4. 协议选型论证

### 4.1 候选 × 原语覆盖矩阵

| 候选                        | P1 会话                                                        | P2 消息             | P3 过程         | P4 审批            | P5 产物             | P6 cron | P7 安全                  | 前端额外成本     | 后端额外成本                               |
| --------------------------- | -------------------------------------------------------------- | ------------------- | --------------- | ------------------ | ------------------- | ------- | ------------------------ | ---------------- | ------------------------------------------ |
| **A. 网关原生 WS（推荐）**  | ✅                                                             | ✅                  | ✅              | ✅                 | ⚠ 补插件            | ✅      | ✅                       | 移植 SDK ~600 行 | files.\* 插件                              |
| B. OpenAI-compat HTTP       | ✖                                                              | ⚠ 纯文本            | ✖               | ✖                  | ✖                   | ✖       | ⚠                        | 低               | 0                                          |
| C. OpenResponses            | ✖                                                              | ✅                  | ⚠ 部分          | ✖                  | ✖                   | ✖       | ⚠                        | 低               | 0                                          |
| D. AG-UI 适配层             | ✖\*                                                            | ✅                  | ✅              | ⚠ 自定义事件       | ✖\*                 | ✖\*     | ⚠                        | 中（学习+映射）  | **新写 adapter（约等于半个自研）**         |
| E. ACP                      | ⚠                                                              | ✅                  | ✅              | ✅                 | ⚠                   | ✖       | ⚠                        | stdio→WS 桥      | 已有 bridge，但需再造 Web 桥               |
| F. 仿 LangGraph server 协议 | 语义错配（threads/checkpoints 概念在 OpenClaw 不存在），不展开 |                     |                 |                    |                     |         |                          |                  |                                            |
| G. 全新自研                 | ✅                                                             | ✅                  | ✅              | ✅                 | ✅                  | ✅      | ✅                       | 高               | **高，且与 A 重复**                        |
| H. Codex app-server 直连    | ✅ thread+fork                                                 | ✅ turn/delta/steer | ✅ item 流+tool | ✅ approval policy | ⚠ 仅 file-edit item | ✖       | ⚠ token；WS experimental | 中               | 0，但等于换掉 OpenClaw，丢控制面（见 3.5） |

\* AG-UI 是"agent↔UI 事件流"协议（RUN/TEXT/TOOL_CALL/STATE 等事件），设计上不管会话列表、定时任务、审批这类**控制面**操作——这些都得走自定义扩展或另开 API，等于协议只覆盖了一半还引入了双通道。

### 4.2 论证（第一性原理版）

1. **"自研 vs 复用"是个伪二选一。** 网关 WS 协议就是一份已经自研完成的协议：帧格式、幂等键、seq 有序性、断线补偿、权限分级、TypeBox 类型与代码生成（`pnpm protocol:gen`）、两个生产级客户端（Lit Control UI、Swift app）全都存在。选它 = "自研协议"的全部好处，0 的开发成本。
2. **任何开源协议适配层都是降维投影。** AG-UI/ACP/OpenAI-compat 表达的是"一次对话运行"的公共子集；而本项目需求的一半（多会话管理、cron、审批、usage、多 agent）属于**控制面**，在这些协议里没有一等公民表达。硬套的结果必然是"标准协议 + 私有侧信道"的双头怪，比单一原生协议更难维护。
3. **开源协议的真正价值是生态互操作，而不是给自家 UI 用。** 这个价值 OpenClaw 已经兑现了：ACP bridge 服务 IDE/桌面生态，OpenAI-compat/OpenResponses 服务第三方 chat 客户端。自家 Web UI 用全功率的原生协议，与保留这些出口并不冲突。
4. **风险对价。** 选 A 的主要风险是"跟随上游协议演进"（v3→v4）。缓解：SDK 里 pin `PROTOCOL_VERSION`、握手时校验 `hello-ok.features.methods`、对 schema 做快照测试；本仓库本身是集成 fork，协议升级节奏可控。
5. **即便 OpenAI 自家的富 agent 协议也只到数据面。** Codex app-server（Thread/Turn/Item + 审批 + 流式 + 代码生成，见 3.5）是协议设计的一个高水位参照，但它的协议面**没有 cron、渠道、多 agent 工作区、设备配对/分级 scope**——控制面原语一个不沾。这反过来印证了 OpenClaw 网关协议的稀缺性（一条协议同时打通数据面+控制面），而不是削弱 A 的选择。

### 4.3 结论

> 架构定位（见 §3.6）：OpenClaw gateway 就是"引擎 + 协议 server + 前端"三层模式里的 server 层，且比 Codex app-server / opencode serve 多一层控制面（cron/渠道/设备/scope）。以下三条是这一前提下"server 层怎么用"的落地。

- **主通道：网关原生 WS 协议**，从 `ui/src/ui/gateway.ts` + `device-identity.ts` 移植出独立 TS 包（放入 agent-frontend 既有的 `packages/client-collections/` 边界，与 `@bioinfo-ai-otr/agent-frontend-client` 并列，如 `@bioinfo-ai-otr/openclaw-gateway-client`）。
- **不自研新协议；不引入 AG-UI/ACP 作为主通道。** 若未来想用 CopilotKit 生态组件，可在前端内部写"网关事件 → AG-UI 事件"的单向映射（几十行 reducer），届时再议。
- **桌面速验旁路**：用 AionUi + `openclaw acp` 先体验"成品交互"，为自建 UI 校准需求优先级（半小时配置成本，零代码）。

---

## 5. 关键能力设计要点

### 5.1 多 chat 会话管理（P1）

- 新建 chat：`sessionKey = webchat-<nanoid>`（网关自动规范化为 `agent:main:webchat-<nanoid>`），首条 `chat.send` 即建档；用 `sessions.patch` 写 label 当标题（或依赖 `includeDerivedTitles`）。
- 列表页：`sessions.list({ includeDerivedTitles: true, includeLastMessage: true, limit: 50 })`，按 key 前缀分组：我的 chat / 渠道会话 / 定时任务(`cron:`) / 子代理(`spawnedBy`)。
- 切换：切换即换 `sessionKey`，拉 `chat.history`（注意其净化策略：单条 >12K 字符截断、图片 data 置 `omitted`、超大条目占位——**长产物必须走 P5 文件通道，不能依赖 history**）。
- 每会话独立模型/思考级别：`sessions.patch({ model, thinkingLevel })`；`models.list` 供选择器。
- 与 TanStack Query 的融合：req/res 方法天然映射 query/mutation；`chat`/`agent`/`cron` 事件进 Zustand store（或 query cache 失效触发器）。agent-frontend 已有这两个库，无新依赖。
- **[2026-07-17 BFF 修订]** 本节 sessionKey 铸造是直连视角。现行 BFF 架构下前端只铸短 `clientSessionId`（Phase 1 固定 `main`），内部 namespace（`agent:<id>:webchat:<clientInstanceId>:<clientSessionId>`）由 BFF 拼接，浏览器永不见原始 sessionKey；多会话 = 铸新的合法短 id。另：Phase 1 实际落地用纯 `useReducer` 管聊天态（historyBase + liveRuns 两层），未用 Zustand——事件驱动的瞬时态进 store 的建议仅当 M2 出现真正的跨路由共享需求时再评估。

### 5.2 流式渲染与工具卡片（P2/P3）

- 双流合并：`chat` 事件驱动气泡文本（delta 累积 → final 落定），`agent` 事件驱动过程条目（工具卡片/思考/生命周期），按 `runId` 对齐、`seq` 排序、`sessionKey` 分桶。
- 直接移植 `app-tool-stream.ts` 的聚合策略与 `tool-display.json` 的展示映射（exec 显示命令、read/write 显示路径、browser 显示 URL……官方已维护 30+ 工具的摘要规则）。
- Markdown：~~建议 streamdown 或 react-markdown + 增量缓冲~~ **[2026-07-14 已定并落地（Phase 1）]** `streamdown@2.5` + `@streamdown/cjk`（中文流式断词）+ `@streamdown/code`（高亮插件）；策略：>12K 字符折叠并**停止解析**（非 CSS 隐藏）、代码围栏闭合/终态才启用高亮、raw HTML 禁用、链接 scheme 白名单 `http/https/mailto`。M2 迁 assistant-ui 时以自定义 Text part 原样保留（见 §5.8）。
- 中断：Gateway 原生支持 `chat.abort({ sessionKey })`（session 作用域）与 runId 作用域；aborted 分支保留部分输出（网关已持久化 partial 并标记 abort 元数据）。**[2026-07-14 BFF 修订]** 浏览器侧只允许 runId 作用域：BFF 强制 `runId` 必填并校验归属本 binding、拒绝 session 作用域形式，防止同 session 多 Tab 互相中止（[phase-1 计划](../../plans/2026-07-13-openclaw-phase-1-single-chat.md) S3）。M2 设计勿沿用本行原文的 sessionKey 形式。

### 5.3 子代理展示（P3 延伸）

- **[2026-07-15 M2 修订]** 子 agent 展示提前进入 M2，但只做一级、只读活动面板。前端不得依赖 `sessions_spawn` result 中的原始 `childSessionKey`，该 key 可能属于 `researcher` 等其他 agent，且不在父 webui namespace。
- Gateway 新增 `operator.read` 方法 `subagents.list({ requesterSessionKey })`：从持久 subagent registry 返回当前父会话的窄记录；调用方声明 `tool-events` cap 时，同时为 active child run 注册该连接的工具事件接收者。
- BFF 把 `subagents.list` 结果变成 connection-local capability map，只下发 opaque child session/run id；child `chat.history` 和 live `chat/agent` 事件只有命中该 map 才放行。
- 前端在父 `sessions_spawn` 工具卡片出现后轮询发现 child，先拉 history 补早期事件，再接 live event；刷新后重新发现和建权。面板不提供 send/abort/steer/kill。

### 5.4 产物上传/下载（P5）

- 上传（图片）：现成——`chat.send.attachments` base64 ≤5MB。
- 上传（任意文件到工作区）：新增 `workspace-files` 插件方法 `files.put`（或 HTTP `POST /files`），前端 dropzone → 工作区 `uploads/`，随后在消息里引用相对路径即可让 agent 处理。
- 下载/浏览：插件提供 `files.list/stat/get`；大文件走一次性 HTTP 票据（复用 media 的根约束+TTL 思路，但指向 workspace 而非 media 目录）。UI 做右侧 Files 面板（对标 deep-agents-ui），按会话过滤"本次 run 写过的文件"可从 `tool` 事件的 write/edit 参数增量收集——**零后端成本的"本会话产物"视图**。
- HTML/报告类产物：iframe 沙箱预览（对齐 canvas 模式）。

### 5.5 本地文件操作与代码执行（P4）

- 操作本身由 agent 工具完成；M2 前端只负责过程可视化和结果展示。
- **[2026-07-15 当前部署]** `~/github/openclaw-workspace/openclaw.json` 的 exec 配置为 `security="full"`、`ask="off"`。M2 不申请 `operator.approvals`、不放行 `exec.approval.*`、不实现审批 UI。
- 如果部署策略改为 ask 模式，审批必须作为独立里程碑重新设计，不能只加一个弹窗；需要同时解决 pending 恢复、namespace 归属和多副本一致性。

### 5.6 定时任务管理（P6）

- 一个标准 CRUD 页面即可全覆盖：三种 schedule（`at` 一次性 / `every` 间隔 / `cron` 表达式+时区）、payload 两型（systemEvent 进主会话 / agentTurn 进隔离会话 `cron:<jobId>`）、delivery（announce 到渠道 / webhook / none）。
- 运行历史：`cron.runs`（status ok/error/skipped + 时长 + 摘要）；`cron` 事件实时刷新。
- 与 chat 的闭环：cron 任务的隔离会话出现在会话列表的"定时任务"分组，点进去能看每次运行的完整过程——这是 AionUi 类产品没有的差异化体验。
- 注意 scope：cron 写操作是 admin，管理页要用 admin token（见 5.7）。

### 5.7 认证与部署（P7）

- 推荐拓扑：网关与前端同机/同内网，前端直连 WS（`ws://host:18789`）；生产可用 `gateway.auth.mode: "trusted-proxy"` 由反代注入身份（`docs/web/webchat.md`）。
- 首次连接：token（或 password）+ 浏览器生成的 ed25519 设备身份 → 换 `deviceToken` 存 localStorage；新设备默认需配对审批（本机回环可自动批准）。
- Token 分级发放：聊天页 read+write；管理页 admin；审批 approvals——同一前端可按路由懒升级（要求重新 connect）。
- **[2026-07-14 BFF 修订]** 本节为直连拓扑存档。现行架构浏览器不持任何 Gateway 凭据/设备身份/deviceToken，认证 = 同源 Cookie → agent-server BFF（[ADR 0002-webui-bff-bridge](../../adr/0002-webui-bff-bridge-over-direct-gateway-connection.md)）；scope 分级由 BFF allowlist 承担，前端无 scope 概念。

### 5.8 Chat UI 组件层选型：assistant-ui ExternalStoreRuntime（2026-07-14 增补）

> 背景：Phase 1 单会话聊天页已用自研组件交付并运行良好（[phase-1 计划](../../plans/2026-07-13-openclaw-phase-1-single-chat.md)）。本节裁决"M2 起 Chat UI 用什么组件基座"，结论供 M2 方案设计直接引用；里程碑侧实施要点见 [webui_integration_milestones.md](./webui_integration_milestones.md) M2 节。

**现状盘点（自研已交付）**：

- 状态层：纯 `useReducer` 两层状态（`historyBase` + `liveRuns[runId]`，historyFence 防乐观消息重复）+ `useOpenClawChat`（连接生命周期、重连退避、post-ack 看门狗 + 幂等 `chat.send` 探测、delta 250ms 合并、history 对账、Page Visibility 收敛）——`agent-frontend/src/features/openclaw-bff/{state,hooks}`。
- 渲染层：`ChatMessageList`（自动滚动/跳到最新/欢迎态）、`ChatMessageItem`（Streamdown）、`ToolCallGroup`（连续工具调用分组折叠卡，按 `runId+toolCallId` 聚合）、`ChatComposer`（卡片式、单飞行）、`ChatConnectionNotice`、`IsolationNotice`。
- 栈事实（package.json 核实）：React 19.2 + Vite 7 + Tailwind 4.1 + Radix（`@radix-ui/react-popover`、`@radix-ui/react-dropdown-menu`）+ Lucide + `streamdown@2.5`/`@streamdown/cjk`/`@streamdown/code` + cva/clsx/tailwind-merge——与 assistant-ui 的 React/shadcn 生态同源。`@assistant-ui/react` **尚未安装**。

**结论**：M2 开工先验证把"会话表面"（Thread / Message / Composer、自动滚动、a11y）迁到 `@assistant-ui/react` 的 **ExternalStoreRuntime**；现有 reducer/hook 保持**唯一状态真相**。chat 协议不改，M2 另为子 agent 活动新增窄 `subagents.list` 协议。**Phase 1 页面不 retrofit**。adapter spike 不干净即回退继续自研。

**为什么是 ExternalStoreRuntime**：它是 assistant-ui 为"已有状态仓库、自定义消息格式、自定义后端"设计的接入点——通过 adapter 投影外部状态，不要求换 chat 协议、不接管状态所有权；同时提供 Thread/Message/Composer/Action/Tool 无头组件与视口贴底行为。收益兑现点是 M2 的多 thread、流式贴底滚动和消息级无障碍。

**推荐链路**：

```text
OpenClaw WebSocket frames
  → OpenClawBffClient（utils/openclawBff）
  → useOpenClawChat + chat-reducer        ← 唯一状态真相（不变）
  → OpenClawAssistantAdapter              ← 新增：historyBase/liveRuns → ThreadMessageLike
  → assistant-ui ExternalStoreRuntime
  → Thread / Message / Composer primitives
  → 自定义 parts：Streamdown Text part + ToolCallGroup(tool-call part) + OTR Tailwind token
```

**状态映射（adapter 合同）**：

| assistant-ui 合同                                | 映射到现有实现                                          | 备注                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `onNew`                                          | `sendMessage`                                           | 单飞行约束不变                                                                         |
| `onCancel`                                       | `abortActiveRun`                                        | 仅 own run；BFF 强制 runId 归属                                                        |
| `isRunning`                                      | own run 处于 `sending/streaming`                        | **thread 级布尔，foreign run 不计入**；foreign 的"运行中"表现需自定义 message 组件区分 |
| composer disabled                                | 连接非 `ready` ∨ 存在 active own run                    | 禁用原因文案沿用现有 placeholder 逻辑                                                  |
| `messages`                                       | `historyBase` + `liveRuns` 投影为 `ThreadMessageLike[]` | 纯函数投影；工具调用作为 tool-call parts 按 `runId` 归属嵌入 assistant 消息            |
| tool-call part 聚合键                            | `runId + toolCallId`                                    | 与 reducer 现有聚合键一致，跨 run 复用 toolCallId 不得合并                             |
| seq gap / foreign run / historyFence / reconcile | 继续由 reducer 管理                                     | assistant-ui 不感知这些概念                                                            |
| `onEdit` / `onReload` / `setMessages`            | **不提供**                                              | 后端无编辑/重生成/分支能力，前端不制造虚假 affordance                                  |

**三处结构性阻抗（M2 方案设计必须显式处理，这是重构不是改名）**：

1. **工具模型重嵌套（最硬）**：现状是"工具调用 = 独立扁平 item，渲染层按连续项分组"；assistant-ui 要求"工具调用 = assistant 消息内部的 tool-call part"。需把 `user → tools → assistant text` 的分离序列按 `runId` 重新嵌套为单条 assistant 消息的 parts 序列；history mapper（history 无稳定 messageId、无 runId，只有合成 `history-<n>`）的投影逻辑要重写。
2. **foreign run 与 thread 级 `isRunning` 失配**：assistant-ui 假设"单一活跃 run 绑定 composer"。foreign run 内容可作为消息渲染，但挂在末条消息上的运行态 affordance 认 thread 级 isRunning，区分 own/foreign 需自定义 message 组件。
3. **合成条目**：oversized 占位（system notice）、"本轮无文本回复"占位、aborted 保留 partial——需映射为 system 消息或自定义 part。连接态 UI（`ChatConnectionNotice`/`IsolationNotice`）在 Thread 之外，不受影响、不迁。

**保留项（迁移后不变的东西）**：

- **Streamdown 全套渲染策略以自定义 Text part 保留**（不用 assistant-ui 内置 markdown——否则其 react-markdown 机制成为死重量，而 12K 折叠停止解析、围栏闭合才高亮、raw HTML 禁用、scheme 白名单这些策略会丢失）。
- **`ToolCallGroup` 与 tool-display 聚合是领域组件**：`app-tool-stream.ts` 聚合策略（50 条上限、80ms 节流、120K 截断）与 `tool-display.json` 展示映射的移植工作量与 UI 基座选型无关，tool-call part 只是挂载点。
- 已知缺陷顺带修复：现 `ChatMessageList` 自动滚动只依赖 `items.length`，单条消息流式增长时不贴底；assistant-ui 视口原语天然覆盖（若不迁，也应单独修，~10 行）。

**方案对比（判断记录）**：

| 方案                              | 判断       | 原因                                                                                                         |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| assistant-ui ExternalStoreRuntime | **采用**   | 专为外部状态/自定义协议设计；Vite/React 兼容；覆盖滚动、composer、a11y、多 thread、附件等通用行为            |
| 继续完全自研                      | 回退路径   | 当前功能完整、迁移风险最低；长期持续自担 ChatUI 通用行为维护成本；spike 失败时的无损退路                     |
| Vercel AI Elements                | 选择性借用 | 视觉栈同源（radix+shadcn，DeerFlow 实测在用），但官方路径绑 Next.js + AI SDK + UIMessage，不解决外部状态接入 |
| Ant Design X                      | 不采用     | 引入 antd/XProvider/CSS-in-JS 第二套主题系统，与 Tailwind-first + OTR token 冲突                             |
| assistant-ui AI SDK Runtime       | 不采用     | 把前端绑到 Vercel AI SDK 协议，与 OpenClaw BFF 通道重叠                                                      |

**实施边界**：

- **手动集成 `@assistant-ui/react`，不跑初始化 CLI**：项目已有 `@/utils/cn`、OTR token、自有 UI primitives；CLI 模板会引入 `@/lib/utils`、完整 shadcn 主题与多余依赖。
- 新依赖原则上只加 `@assistant-ui/react`；attachment 等子包按 M2 实际需要逐个评估。
- 不暴露 `onEdit`/`onReload`/`setMessages`（同上表）。

**前置 spike（M2 开工第一件事，丢弃式、挂 flag）**：只写 `OpenClawAssistantAdapter`，验收四个硬案例——

1. foreign run 流式 + 工具卡片正确渲染，且不占用本 Tab composer；
2. 工具调用按 `runId` 正确回挂到所属 assistant 消息，跨 run 复用 toolCallId 不串；
3. oversized 占位 / "本轮无文本回复" / aborted 保留 partial 三类合成条目正确映射。
4. child 只读面板中的 streaming、tool 和 skill 摘要不占用父 thread 的 composer/isRunning。

adapter 干净 → 其余 primitive 迁移低风险；adapter 拧巴 → 回退"继续自研"，Phase 1 UI 完整可用，无沉没成本。

---

## 6. 落地方案与路线图

### 6.1 方案对比

| 方案                                               | 说明                                                              | 评价                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **A1（推荐）**：agent-frontend 内新增 feature 模块 | `src/features/agent-chat/`，SDK 进 `packages/client-collections/` | 符合现有 feature-based 结构与 Tailwind-first 约定；React Query/Zustand/shadcn 全部现成；一套登录/导航 |
| A2：独立新 app                                     | 干净但要重建脚手架、登录、部署                                    | 仅当与现有产品用户体系隔离时考虑                                                                      |
| B：二开 AionUi/OpenWork                            | 桌面工程，不满足 Web 前提                                         | 只作速验旁路（ACP 直连）                                                                              |
| C：等上游 openclaw WebChat 演进                    | Control UI 是 Lit 技术栈                                          | 与 React 团队栈不合，且产品目标（OTR 内部工作台）不同                                                 |

### 6.2 分阶段路线（1 名熟悉 React 的工程师）

> **[2026-07-15 状态]** 本表为直连时代估算，仅存档。排期与交付状态以 [webui_integration_milestones.md](./webui_integration_milestones.md) 为准：M0、M1 已交付；M2 已重排为私聊/private group 多会话、子 agent 只读活动、工具摘要与技能名称回显，详见 [M2 执行计划](../../plans/2026-07-15-openclaw-m2-multi-session-subagent-skills.md)。

| 阶段 | 内容                                                                                                                                            | 依赖后端改动                                        | 预估         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| P0   | `openclaw-gateway-client` TS 包（移植 gateway.ts/device-identity.ts/类型）；`/agent/chats` 路由 + 单会话聊天（send/history/abort + delta 渲染） | 无                                                  | 1~1.5 周     |
| P1   | 私聊/private group 多会话；工具事件卡片与 skill 名称；子 agent 只读活动面板；assistant-ui adapter spike                                         | Gateway `subagents.list` + BFF child capability map | 10.5~13.5 天 |
| P2   | cron 管理页（CRUD + 运行日志 + 手动触发 + 实时事件）                                                                                            | 无                                                  | 1 周         |
| P3   | Files 产物面板 + 上传/下载；"本会话产物"视图                                                                                                    | `workspace-files` 插件（2~3 天）                    | 1~1.5 周     |
| P4   | 多 agent 切换；每会话模型/思考等级；HTML 产物 iframe 预览                                                                                       | BFF target→agent 视图                               | 1~1.5 周     |

P0+P1 结束即达到"能用的多 chat agent 工作台"；P2 满足定时任务诉求；P3/P4 补齐产物与多 agent 体验。

### 6.3 风险与开放问题

1. **admin scope 粒度粗**：cron/会话管理与 `config.set` 同档，UI token 权限偏大。缓解：短期用独立 admin token + 路由级守卫；中期可在 fork 内给 cron/sessions 拆细 scope（`method-scopes.ts` 单点改动）。
2. **chat.history 截断**（单条 12K 字符、图片 data 剥离）：长代码/报告必须引导用户走 Files 面板看全文；SDK 层对 `__openclaw.truncated` 做显式"查看完整内容"入口。
3. **非图片附件上传缺口**：P3 插件补齐前，只有图片体验完整。
4. **上游协议演进**：pin PROTOCOL_VERSION + `hello-ok.features` 探测 + schema 快照测试；本仓库是受控 fork，风险可控。
5. ~~**浏览器设备配对 UX**：非回环访问首连需网关侧批准（CLI 或已配对客户端），需要在 onboarding 文档里写清楚。~~ **[已随 BFF 架构失效]** 设备身份服务端化，浏览器不再配对（[ADR 0002-webui-bff-bridge](../../adr/0002-webui-bff-bridge-over-direct-gateway-connection.md)）。
6. ~~外部项目细节未联网复核~~：已于 2026-07-06 联网核实（OpenWork=Tauri+opencode SDK/SSE；AionUi=Electron+ACP，含 cron 定时任务与远程 WebUI；deep-agents-ui=LangGraph API，已存档）。核实结果与原结论一致，AionUi 的 ACP 直连路径成立。

---

## 7. 附录：关键索引

| 主题                                         | 位置                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议文档 / 帧与握手                          | `docs/gateway/protocol.md`；`src/gateway/protocol/schema/frames.ts`                                                                            |
| 方法与事件全集                               | `src/gateway/server-methods-list.ts`                                                                                                           |
| Scope 映射                                   | `src/gateway/method-scopes.ts`                                                                                                                 |
| chat 方法实现（附件/幂等/截断/工具事件注册） | `src/gateway/server-methods/chat.ts`                                                                                                           |
| agent 事件总线（sessionKey 注入）            | `src/infra/agent-events.ts`                                                                                                                    |
| 工具事件发射                                 | `src/agents/pi-embedded-subscribe.handlers.tools.ts`                                                                                           |
| 会话 key 规则                                | `src/routing/session-key.ts`；`docs/concepts/session.md`                                                                                       |
| 子代理                                       | `src/agents/tools/sessions-spawn-tool.ts`；`src/agents/subagent-spawn.ts`；`docs/concepts/multi-agent.md`                                      |
| cron                                         | `src/gateway/protocol/schema/cron.ts`；`docs/automation/cron-jobs.md`                                                                          |
| 媒体/文件安全                                | `src/media/server.ts`；`src/infra/fs-safe.ts`；`docs/concepts/agent-workspace.md`                                                              |
| 浏览器 WS 客户端蓝本                         | `ui/src/ui/gateway.ts`、`ui/src/ui/device-identity.ts`、`ui/src/ui/app-tool-stream.ts`、`src/agents/tool-display.json`                         |
| ACP 桥                                       | `docs/cli/acp.md`；`src/acp/server.ts`                                                                                                         |
| OpenAI 兼容出口                              | `src/gateway/openai-http.ts`；`src/gateway/openresponses-http.ts`                                                                              |
| 插件扩展缝（新增网关方法/HTTP 路由）         | `src/plugins/types.ts`；`.codex/docs/plugin_system.md`                                                                                         |
| 参考项目                                     | github.com/different-ai/openwork；github.com/iOfficeAI/AionUi；github.com/langchain-ai/deep-agents-ui（已存档）；`~/github/deer-flow/frontend` |
| Codex（app/cli/app-server）                  | github.com/openai/codex；developers.openai.com/codex/app-server；github.com/agentclientprotocol/codex-acp                                      |
| WorkBuddy / CodeBuddy（腾讯）                | 本机 `/Applications/WorkBuddy.app`；`cli/package.json`=`@tencent-ai/codebuddy-code`；cnb.cool/codebuddy/codebuddy-code                         |
