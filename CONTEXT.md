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
BFF 为浏览器聊天绑定的 Gateway 会话，key 形如 `agent:{agentId}:webchat:{namespace}:{clientSessionId}`，第四段是 scope namespace（tenant + effective user + target 的 hash）；transcript 独立于其他渠道会话。
_Avoid_: main 会话（有歧义，见下）、clientInstanceId（namespace 的旧称）

**交付界面（Delivery Surface）**:
一次运行实际面向的交付形态，由 channel 与会话身份**共同**决定，与单一 channel 值不等价。同一个 channel 值可以对应不同交付界面（后台运行与浏览器聊天都可能以 `internal` 执行），同一个交付界面也可能以多个 channel 值出现。决定该次运行加载哪些工具、以及提示词描述哪些能力。
_Avoid_: 把 channel 直接当作界面、surface 与 channel 混用

**父 WebChat 会话（Parent WebChat Session）**:
浏览器用户直接驱动的 WebChat Session 本体，是 WebUI Artifact 的唯一发布主体。区别于由它 spawn 出的 Child Session——子会话不构成父 WebChat 会话，其产物需回到父会话再发布。
_Avoid_: 泛指的 webchat 会话（无法区分父子）

**Control UI 会话**:
内置控制台（`ui/`）驱动的会话，与 WebChat Session 属于**不同交付界面**，不享有 WebUI Artifact 发布能力。两者曾共用同一 client mode，现已明确分离。
_Avoid_: 把 Control UI 归入 WebChat

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
任一 run 到达终态后，以 `chat.history` 最新窗口按稳定历史条目标识与本地状态尾部对齐合并；已加载的更早历史页保留，窗口与已加载历史无重叠时按游标重置处理。Gateway 历史仍是唯一事实源。
_Avoid_: 全量替换本地状态（旧语义）、把 reconcile 响应当完整 transcript snapshot

**历史页（History Page）**:
`chat.history` 一次返回的按时间正序展示历史窗口，用 opaque 游标（`before`/`nextBefore`）向更早方向翻页；只覆盖当前活跃 transcript。
_Avoid_: 完整历史、跨 reset 文件的合并视图

**游标重置（Cursor Reset）**:
游标所指 transcript 被替换、截断或会话切换后，服务端改答最新页并显式标记；客户端必须清空已加载历史与旧游标再采用最新页。对账窗口与已加载历史无重叠（缺口）时走同一路径。
_Avoid_: 静默回退、把 stale cursor 当请求错误

**历史条目标识（History Entry ID）**:
Gateway 为每条展示消息附加的稳定公开标识，源自 transcript record 身份，缺失时由服务端按文件内位置合成；供展示层跨页去重与合并使用。
_Avoid_: 页内下标 ID、临时 key

**有界 Transcript 扫描（Bounded Transcript Scan）**:
按反向 chunk traversal 读取活跃 JSONL transcript，在完整行上统一执行单行字节、扫描字节和原始 record 数量上限，并把每行解码为 decoded、malformed 或 oversized 结果；历史页与 post-compaction audit 共用该读取语义。
_Avoid_: 同步全文件读取、调用方自行拆行或复制 JSON record decode

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

**Input Artifact（输入工件）**:
用户在 Composer 上传、随消息发给 agent 的附件（图片或文件），持久化为与 WebUI Artifact 同一存储与 ID 空间的 `direction=INPUT` artifact；`attachmentId` 即 `artifactId`，共用登录态 download 端点与 retention。Gateway 在发送时把有序私有引用写入对应 user transcript，历史回放优先读取结构化引用，缺失或不合法时再从 media marker 恢复；BFF 始终按现有 artifact 表校验会话归属并补全公开元数据。
_Avoid_: 独立于 artifact 的 attachment、webchat 附件、临时 media

**History Attachment Reference（历史附件引用）**:
Gateway `chat.history` 从 user transcript 的私有 `__openclaw.attachments` 读取的有序 `attachmentId` 候选；旧消息或结构化字段异常时，从用户消息开头的既有 materialized media marker 回退恢复。它只在 Gateway→BFF 内部使用，不包含 workspace path、文件权威元数据或授权结论；BFF 校验后才生成浏览器可见的 `attachments[]`。
_Avoid_: 把路径、safeName 或 marker MIME 当浏览器契约

**Message-Artifact Link（消息工件关联）**:
【备选，未实施】在 agent-server 持久记录消息/run 与有序 INPUT artifact 的关联。当前方案不需要该表；仅当 Gateway 不再保留可恢复引用、BFF 需要脱离 Gateway history 独立查询消息附件，或产品要求更强的消息级归属完整性时重新评估。
_Avoid_: 把它当作当前 v1 前置迁移

**Preview Rendition（预览态）**:
【可选增强，未实施】从图片 artifact 派生的受限尺寸、安全、静态图，仅用于消息内联展示，区别于原文件下载。当前 v1 称为“原图内联展示”，直接复用登录态 download 端点；只有性能或产品要求成立时才新增 `/preview`。
_Avoid_: 原文件直链、长期签名 URL

**技能回显（Skill Invocation Display）**:
从既有工具调用参数或 SKILL.md 路径派生的展示值（"使用技能：<name>"），纯展示层推断，无独立技能协议事件。
_Avoid_: skill event、技能生命周期

### 会话管理

**会话标题（Session Title）**:
WebChat 用户为自己会话设置的展示名，存于 OpenClaw `SessionEntry.title`；自由字符串，不要求唯一，不参与会话寻址。
_Avoid_: 写入 label、可寻址标题

**会话别名（Session Label）**:
CLI/admin 为会话设置的全局唯一寻址别名（`SessionEntry.label`），被 resolve、按 label 发送与搜索使用。
_Avoid_: 用户标题、显示名

**会话分组（Session Group）**:
agent-server 持有的、按用户与 target 隔离的会话组织元数据（名称、颜色、排序）；OpenClaw 无对应领域模型。删除分组只解除归属，不删除会话。
_Avoid_: OpenClaw 侧分组、跨 target 分组

**删除协调状态（Delete Coordination State）**:
agent-server 为跨存储会话删除维护的 active/deleting/deleted 三态；deleted 是永久 tombstone，拦截旧入口对已删会话的发送。Gateway 超时视为结果不确定，只能由对账收敛。
_Avoid_: 把 Gateway 超时当删除失败

### apply_patch 与文件边界

**workspace-only（工作区限定）**:
`apply_patch` 的文件操作被约束在会话工作区根目录内的模式；边界检查与实际读写由同一可信根约束。
_Avoid_: sandbox mode（另有所指）、只读模式

**路径别名逃逸（path alias escape）**:
通过符号链接、硬链接或父目录别名，把看似位于工作区内的路径解析到工作区外目标的逃逸方式。删除操作只允许作用于最终别名本身。
_Avoid_: 仅说 symlink 逃逸（遗漏硬链接与父目录别名）

**no-op patch**:
应用后文件内容无实际变化的 patch；不写盘、不更新 mtime，并向模型返回明确的无变更文本。
_Avoid_: 空 patch（指无 hunk，是错误而非 no-op）

**完整模型标识（full model ref）**:
`provider/model` 形式的白名单条目（如 `otr/gpt-5.6-sol`）。裸模型 ID 会被任何挂载同名模型的 Provider 命中，白名单只应使用完整标识。
_Avoid_: 裸模型 ID、model name

**活动配置（live config）**:
Gateway 主机上被运行时实际读取的 `~/.openclaw/openclaw.json`。与之相对的是 workspace 仓库中的**仓库副本（repo copy）**，仅作变更记录，两者存在漂移。
_Avoid_: 把仓库副本当作运行时配置
