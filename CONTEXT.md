# OpenClaw

OpenClaw is a local-first AI gateway for routing work across agents, sessions, tools, and channels. This glossary defines project-specific language for agent task state and the WebUI BFF bridge (agent-server / agent-frontend integration).

## Language

**TaskFlow**:
A durable task checklist owned by an agent session for work that needs planning, progress tracking, or recovery across context loss.
_Avoid_: TodoList, plan, checklist

**active TaskFlow**:
The single unfinished TaskFlow selected for an owner session. A session cannot have more than one active TaskFlow at the same time.
_Avoid_: current todo, active plan

**owner session**:
The agent session that created and controls a TaskFlow by default.
_Avoid_: parent session, creator

**local TaskFlow**:
A TaskFlow visible and writable only within its owner session boundary unless explicitly delivered as progress to a channel.
_Avoid_: private plan, internal todo

**shared TaskFlow**:
A TaskFlow whose access is explicitly granted to more than one agent session for coordinated work.
_Avoid_: global todo, inherited plan

### Bridge & device

**Gateway device client**:
A trusted software client that connects to the OpenClaw Gateway as a paired device and receives Gateway-scoped access. It is not an end user and does not define user-level data ownership.
_Avoid_: user session, browser identity

**Gateway scope profile**:
A named set of Gateway role and scope permissions held by a Gateway device client for one class of operations, such as chat, approvals, or admin work.
_Avoid_: user role, frontend permission

**Feishu target**:
The Feishu conversation subject a user is acting through, either a direct-message user target or a group target.
_Avoid_: raw agentId, browser-selected workspace

**Feishu-routed OpenClaw agent**:
An OpenClaw agent identity derived from a Feishu target so chat state stays aligned with the Feishu-backed workspace topology.
_Avoid_: arbitrary UI agent, frontend route id

**OpenClaw bridge**:
The agent-server boundary that authenticates a browser user, resolves their Feishu target, and enforces target, session, and event isolation between the WebUI and the Gateway. It is an authorization boundary, not a forwarder.
_Avoid_: transparent proxy, gateway passthrough

### WebUI 桥接

**WebChat Session（webchat 隔离会话）**:
BFF 为浏览器聊天绑定的 Gateway 会话，key 形如 `agent:{agentId}:webchat:{clientInstanceId}:{clientSessionId}`；transcript 独立于其他渠道会话。
_Avoid_: main 会话（有歧义，见下）

**Agent Main Session（渠道主会话）**:
OpenClaw 的 `agent:{agentId}:main`；`dmScope=main`（默认）时飞书私聊落在这条会话。与 WebChat Session 的固定 ID `main` 同名不同物（ADR-0002 的混淆根源）。

**Client Session ID**:
浏览器可见的短会话 ID（Phase 1 固定为 `main`），由 BFF 重写为内部 sessionKey；浏览器永不接触原始 Gateway sessionKey。

**Front Run ID**:
浏览器生成的 run 标识（`run_<uuid>`），BFF 映射为 Gateway `idempotencyKey`（`bff-{namespace}-{frontRunId}`）并在事件中翻译回来。
_Avoid_: 裸用 runId 而不区分前端/Gateway 侧

**Foreign Run**:
同一 WebChat Session 中由其他 Tab（或其他入口）发起的 run。流式内容照常渲染，但不接管本 Tab 的 composer 控制权。

**Degraded**:
BFF 在 Gateway 上游断开时为 active run 合成的 chat 事件状态（非 OpenClaw 原生状态），含义是"本轮结果未知"。无 seq，不参与 seq 比较；恢复靠前端 health 轮询。

**Reconcile（对账）**:
任一 run 到达终态后，以 `chat.history` 全量替换本地流式状态。Gateway 历史是唯一事实源。

**Target / Binding**:
principal 与 direct/group target 的授权绑定关系，决定 agentId 与 namespace；`bridge.connect` 首帧完成绑定。

**Child Session（子会话）**:
父 WebUI 会话经 spawn 产生的子 agent 会话，可能归属其他 agent；WebUI 只读观察其消息与工具活动，不可发送、中止或接管。
_Avoid_: 嵌套会话、子线程

**Front Child Session ID**:
BFF 为已授权子会话生成的不可猜测前端 opaque id，随连接生命周期失效；原始 childSessionKey/runId 永不下发浏览器。
_Avoid_: 裸 childSessionKey

**WebUI Artifact（工件交付）**:
父 WebUI 会话的 agent 把 workspace 文件显式发布给当前浏览器会话的交付物，经私有存储与登录态鉴权下载。是"交付物发布"，不是渠道消息投递。
_Avoid_: 文件消息、webchat 附件、media 中转

**技能回显（Skill Invocation Display）**:
从既有工具调用参数或 SKILL.md 路径派生的展示值（"使用技能：<name>"），纯展示层推断，无独立技能协议事件。
_Avoid_: skill event、技能生命周期
