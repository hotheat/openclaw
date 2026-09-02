# Implementation Plan: OpenClaw WebChat 聊天记录时间

## Overview

为 agent-frontend 的 OpenClaw WebChat 中每条用户、助手和系统消息增加可见时间。
时间沿用 OpenClaw transcript 已有数据，不在 agent-server 重复持久化。
OpenClaw Gateway 负责把 JSONL 记录时间规范化为 Unix 毫秒，agent-server BFF 继续完成作用域隔离、标识翻译和透明转发，agent-frontend 负责实时状态合并、assistant-ui 适配及浏览器本地时区展示。

本方案针对 `agent-frontend/src/pages/OpenClawChatPage.tsx` 挂载的 BFF WebChat。
OpenClaw 自带 Control UI 的 `ui/src/ui/views/chat.ts` 已消费 `message.timestamp` 并展示消息组时间，不属于本次主要改造面。

## Design Summary

- 线上协议继续使用现有字段名 `timestamp`，语义固定为 UTC Unix epoch milliseconds。
- agent-frontend 领域模型使用 `createdAt?: number`，进入 assistant-ui 时转换为 `Date`。
- BFF 不格式化时间、不调用 `DatetimeFormatterContextMiddleware` 生成展示字符串、不新增数据库列。
- 有效 JSONL 消息优先使用内层 `message.timestamp`，缺失时由 Gateway 从顶层记录 `record.timestamp` 解析补齐。
- 实时用户消息先使用前端发起时间，实时助手消息先使用首个可见 `chat` 事件时间；历史对账成功后由持久化消息替换临时时间。
- 时间不参与消息 identity、分页 cursor、终态对账或文本匹配，避免时间精度差异破坏现有收敛逻辑。
- 无法从旧记录或 oversized raw placeholder 取得可信时间时显示“时间未知”，不使用 `Date.now()` 伪造历史时间。
- 可见格式采用混合规则：不足 1 分钟显示 `just now`，1 分钟至不足 30 分钟显示 `N minute(s) ago`，达到 30 分钟后显示浏览器本地时区的 `YYYY-MM-DD HH:mm`。
- `title` 和 `aria-label` 始终提供含秒与时区的完整绝对时间。

## Requirements

### Functional requirements

- 每条用户、助手和系统消息均有独立时间区域。
- 纯工具调用形成的 assistant-ui 消息也显示该工具组开始时间。
- 同一个流式助手消息在增量更新期间时间保持稳定，不随每个 delta 跳动。
- 历史分页加载、断线重连、终态对账和 session 切换后仍显示持久化时间。
- 一条 JSONL 消息拆成多个文本块时，各块继承同一条持久化记录时间。
- tool call 与 tool result 跨页合并后，开始时间取 call 时间，更新时间取 result 时间。
- 不可信或缺失的旧数据明确显示“时间未知”。
- 相对时间在 1 分钟和 30 分钟边界自动刷新，不要求用户交互或整页重渲染。

### Consistency requirements

- JSONL transcript 是历史消息时间的 source of truth。
- Gateway `chat` event 是实时助手消息时间的首选数据源。
- 前端 `SEND_STARTED.now` 和事件接收时间只用于持久化记录出现前的临时展示。
- `historyEntryId`、`messageId` 和现有 run window 继续承担 identity 与对账职责。
- 时间字段变化不得导致重复气泡、丢失 optimistic user message 或错误移除 live overlay。

### Display requirements

- `0 <= age < 1 minute` 显示 `just now`。
- `1 minute <= age < 30 minutes` 显示向下取整的 `N minute(s) ago`，其中 1 分钟使用单数 `1 minute ago`。
- `age >= 30 minutes` 显示绝对时间 `YYYY-MM-DD HH:mm`。
- 刚好 30 分钟时立即切换为绝对时间。
- 浏览器时间比消息时间最多落后 1 分钟时按轻微时钟偏差处理并显示 `just now`；消息时间领先超过 1 分钟时直接显示绝对时间。
- 使用浏览器时区，不由服务器假设 `Asia/Shanghai` 或用户所在地。
- 用户消息时间右对齐，助手消息时间与 provider/model 元数据位于同一辅助信息区，系统消息时间位于系统卡片底部。
- 时间文本使用现有 `text-otr-text-muted` 视觉层级，不抢占正文注意力。
- 时间节点使用 `<time dateTime="...">`，`title` 和 `aria-label` 始终提供完整绝对时间，避免相对文案丢失精确信息。

## Non-Goals

- 不修改 OpenClaw transcript 存储格式。
- 不在 agent-server PostgreSQL、Redis 或 artifact 表中保存消息时间副本。
- 不新增 BFF REST API、WebSocket event 类型或浏览器请求方法。
- 不修改 session 列表的 `updatedAt` 语义。
- 不给每个 token、delta 或 tool update 单独显示时间。
- 不实现用户自选时区或时间格式设置。
- 不修改 OpenClaw Control UI 的现有消息分组时间样式。
- 不借此重构 chat reducer、分页或终态对账架构。

## Current State And Evidence

### Existing data path

```text
OpenClaw JSONL transcript
  record.timestamp: ISO-8601
  record.message.timestamp: Unix milliseconds, commonly present
        |
        v
openclaw-integration/src/gateway/session-history-page.ts
  readSessionHistoryPage()
  toHistoryPageRecord()
  attaches historyEntryId, currently does not backfill record.timestamp
        |
        v
openclaw-integration/src/gateway/server-methods/chat.ts
  chat.history response
        |
        v
agent-server/app/services/openclaw_bridge_request_service.py
  target-scoped request + attachment enrichment
        |
        v
agent-server/app/services/openclaw_protocol_translator.py
  identifier translation + private-field stripping
  JsonValue and extra='allow' retain numeric timestamp
        |
        v
agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts
  mapOpenClawHistory()
  currently drops timestamp
        |
        v
agent-frontend ChatMessageItem -> OpenClawAssistantAdapter -> assistant-ui
  currently omits ThreadMessageLike.createdAt
```

### Confirmed existing behavior

- `openclaw-integration/src/gateway/server-chat.ts` 的 `createChatDeltaPayload()` 已在 `message.timestamp` 中发送毫秒值。
- `openclaw-integration/src/gateway/server-chat.ts` 的 final chat payload 已在可见 `message` 中发送毫秒值。
- `openclaw-integration/src/gateway/server-methods/chat.ts` 的非标准完成路径会复用已持久化 message，或生成带 `timestamp` 的 fallback message。
- `openclaw-integration/src/gateway/session-history-page.ts` 直接返回 JSONL 的 `record.message`，所以内层已有 `timestamp` 时可到达 BFF。
- 同文件只对 compaction 顶层 ISO 时间做显式解析；普通 message 缺少内层时间时没有使用顶层 `record.timestamp`。
- `openclaw-integration/src/gateway/protocol/schema/logs-chat.ts` 的 `ChatHistoryMessageSchema` 只声明 `historyEntryId`，`timestamp` 目前仅依赖 `additionalProperties` 偶然保留。
- `agent-server/app/common/ports/openclaw_gateway_port.py` 的 `GatewayEventFrame` 和 `SessionScopedEventPayload` 均允许额外字段。
- `OpenClawProtocolTranslator._translate_parent_event()` 使用 `model_dump(by_alias=True, exclude_unset=True)`，嵌套 `message.timestamp` 会被保留。
- `OpenClawProtocolTranslator.translate_response()` 对 `chat.history` 做标识翻译、spawn 脱敏和 `__openclaw` 清理，没有时间格式转换。
- `agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts` 构造 `ChatMessageItem` 时未读取 `message.timestamp`。
- `agent-frontend/src/features/openclaw-bff/types/chat.ts` 的 `ChatMessageItem` 没有消息时间字段。
- `agent-frontend/src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.ts` 没有设置 `ThreadMessageLike.createdAt`。
- assistant-ui 当前版本的 `ThreadMessageLike` 原生支持 `createdAt?: Date`；缺失时运行时会用 `new Date()`，这会把历史记录错误显示为当前时间。

### Root gap

主要缺口位于 agent-frontend 的 history mapper、live reducer 和 assistant-ui adapter。
Gateway 还需要补一个协议稳定性改动：从 JSONL 顶层时间回填缺失的内层时间，并把 `timestamp` 写入公开 schema 与测试，避免前端依赖未声明的透传字段。
BFF 生产代码当前已经满足透明透传要求，只需增加回归测试锁定该行为。

## Timestamp Semantics

### Wire contract

```ts
type OpenClawPublicChatMessage = {
  historyEntryId?: string;
  role: string;
  content: unknown;
  timestamp?: number; // UTC Unix epoch milliseconds
};
```

`timestamp` 保持可选，用于兼容旧 transcript、损坏记录和无法解码的 oversized raw record。
Gateway 对正常可解码记录应尽最大努力补齐，前端不得因为缺失时间而丢弃消息。

### Gateway normalization order

普通 JSONL message 通过 `resolveHistoryTimestamp(record, message)` 解析：

1. `message.timestamp` 是有限且大于零的 number 时直接使用；兼容旧记录中的严格 RFC3339 字符串并转换为毫秒；`0` 视为未知占位值并继续尝试顶层时间回填。
2. `record.timestamp` 先通过严格 RFC3339 结构与日历值校验，再使用 `Date.parse(record.timestamp)` 转为毫秒。
3. 两者都无效时返回 `undefined`。

不接受 numeric string，不自动猜测秒级 epoch，不用文件 mtime 或读取时刻补值。
现有 OpenClaw 消息协议已经使用毫秒值，增加启发式转换会掩盖上游错误。

### Frontend domain semantics

- `ChatMessageItem.createdAt` 表示当前气泡的创建时间，单位为毫秒。
- `ChatLiveRunUserMessage.acceptedAt` 继续作为 optimistic user message 的临时时间。
- `ChatLiveRenderBlock` 的 text block 增加 `createdAt`，首次创建 block 时写入，累计 delta 只更新 text。
- tools block 增加 `createdAt`，取该组首个 tool start 时间。
- `ChatToolCall.startedAt` 和 `updatedAt` 继续使用现有字段，不另建重复时间属性。
- 历史消息的 `createdAt` 来自 wire `timestamp`。
- 历史 tool call 的 `startedAt` 来自 call 所在消息时间，`updatedAt` 来自 result 所在消息时间。
- 系统 fallback message 使用触发该本地状态的时间；旧历史记录缺失时间时保持 `undefined`。

### Live-to-history convergence

```text
User send
  SEND_STARTED.now
    -> optimistic user ChatMessageItem.createdAt
    -> chat.history returns persisted timestamp
    -> historyEntryId/text window confirms user item
    -> persisted item replaces optimistic item

Assistant stream
  first visible chat delta message.timestamp
    -> text block createdAt
    -> later cumulative deltas preserve createdAt
    -> terminal event closes run
    -> chat.history returns persisted timestamp + messageId/historyEntryId
    -> persisted item replaces live overlay
```

这个过程允许临时时间在对账后收敛到持久化时间。
时间只用于展示，不作为收敛判断输入。

## Architecture Changes

### 1. openclaw-integration: declare and normalize history timestamps

#### `src/gateway/session-history-page.ts`

- 新增窄 helper `resolveHistoryTimestamp(record, message)`。
- 将 `attachHistoryEntryId()` 改为附加公开 history metadata，保留现有内层 `timestamp`，缺失时从顶层记录解析。
- `toHistoryPageRecord()` 对普通 message 使用该 helper。
- compaction 保持现有 ISO 解析逻辑，可复用同一个安全解析 helper。
- `buildOversizedHistoryPlaceholder()` 仅在源 message 自带可信时间时保留；不得用 `Date.now()` 伪造旧消息时间。
- decoded oversized message 继续保留可取得的 metadata。
- raw oversized transcript record 无法可靠读取时间时省略 `timestamp`。

#### `src/gateway/protocol/schema/logs-chat.ts`

- 在 `ChatHistoryMessageSchema` 中显式声明可选 `timestamp` number，最小值为 0。
- 保留 `additionalProperties: true`，因为 provider/model/content/tool 字段仍是开放消息形状。
- 不把字段设为 required，避免旧记录导致整个 `chat.history` 响应校验失败。

#### Gateway tests

- `src/gateway/session-history-page.test.ts`
  - 内层毫秒时间优先于顶层 ISO 时间。
  - 内层缺失时从顶层 ISO 回填。
  - 无效时间保持缺失。
  - 历史分页前后时间不变化。
  - oversized placeholder 不伪造当前时间。
- `src/gateway/server.chat.gateway-server-chat-b.test.ts`
  - `chat.history` WebSocket 响应保留/回填 timestamp。
- `src/gateway/protocol/index.test.ts`
  - history schema 接受有限非负 timestamp。
  - history schema 拒绝负数、字符串和非数值。
- `src/gateway/server-chat.agent-events.test.ts`
  - delta/final 可见 message 继续携带数值 timestamp。

#### Generated protocol artifacts

- 运行 `pnpm protocol:gen` 和 `pnpm protocol:gen:swift`。
- 运行 `pnpm protocol:check` 验证生成物一致。
- 不手工编辑标记为 generated 的文件。

### 2. agent-server BFF: preserve ownership boundary and lock passthrough behavior

#### Production behavior

agent-server 生产代码预计无需修改。
当前 BFF 设计已经满足本功能：

- `OpenClawBridgeRequestService.execute()` 请求 Gateway 后再做附件 enrichment 和协议翻译。
- `OpenClawProtocolTranslator.translate_response()` 对 `chat.history` 递归翻译标识，不改变 number。
- `OpenClawProtocolTranslator._translate_parent_event()` 对实时 chat event 通过 extra-allowed Pydantic model 往返序列化，保留嵌套 message。
- `_forward_gateway_events()` 使用 `model_dump(by_alias=True, exclude_none=True)` 发送事件。

不要在 BFF 增加 `createdAt`、ISO 字符串或本地时区格式化。
否则历史响应与实时事件会出现双字段和时区语义分叉。

#### BFF tests

- `app/test/unit_test/services/test_openclaw_protocol_translator.py`
  - parent `chat.history` 在 session key 翻译和私有字段清理后仍原值保留每条 message 的 `timestamp`。
  - parent `chat` delta/final event 在 run/session id 翻译后仍原值保留 `message.timestamp`。
  - child history/event 如纳入相同 UI，也验证 timestamp 不变。
- `app/test/unit_test/services/test_openclaw_bridge_request_service.py`
  - attachment enrichment 前后 timestamp 不丢失。
- `app/test/unit_test/api/test_openclaw_bridge_controller.py`
  - WebSocket 最终 JSON frame 的 timestamp 仍是 number，不被 datetime middleware 转换。

如果上述测试暴露某个 sanitizer 丢字段，只在对应 translator/enrichment helper 修复。
不要为时间功能引入新的 repository、port、container provider 或 settings。

### 3. agent-frontend: carry time through history, live state and assistant-ui

#### `src/features/openclaw-bff/types/chat.ts`

- `ChatMessageItem` 增加 `createdAt?: number`。
- `ChatLiveRenderBlock` 的 text/tools variant 增加 `createdAt: number`。
- 保留 `ChatLiveRunUserMessage.acceptedAt`，不新增重复 user 时间字段。
- 不把时间加入任何 identity type。

#### `src/features/openclaw-bff/api/chat-mappers.ts`

- 新增 `extractOpenClawMessageTimestamp(value): number | undefined`。
- 只接受有限、非负 number。
- `mapHistoryMessage()` 在处理一条 raw message 时解析一次，并传给该记录产生的所有 message/tool items。
- `buildMessageItem()` 写入 `createdAt`。
- `mapHistoryToolCall()` 用 raw message 时间初始化 `startedAt/updatedAt`。
- `mergeHistoryToolResult()` 保留 call 的 `startedAt`，用 result 时间推进 `updatedAt`。
- legacy string message 保持时间缺失，不使用 mapper 执行时刻。

#### `src/features/openclaw-bff/hooks/useOpenClawChat.ts`

- chat event 到达时从 `payload.message.timestamp` 解析 event time。
- `CHAT_EVENT` action 增加 `createdAt`，优先 event timestamp，缺失时使用当前接收时间。
- `now` 继续表示 reducer 状态更新时间，不能同时承担 message 创建时间。
- tool event 没有公开 message timestamp 时继续使用接收时间作为 tool start/update 时间。

#### `src/features/openclaw-bff/state/chat-reducer.ts`

- `applyAssistantSegment(run, incomingText, createdAt)` 创建 text block 时写入时间。
- cumulative delta 更新已有 block 时保留原 `createdAt`。
- 新 assistant segment 在 tool/user 边界后取得新的首次事件时间。
- `appendToolToRenderBlocks()` 创建 tools block 时记录首个 tool 时间，后续同组 tool 不覆盖。
- `selectRenderedChatItems()`：
  - optimistic user item 使用 `acceptedAt`。
  - live assistant item 使用 text block `createdAt`。
  - empty/system terminal item 使用 terminal `lastEventAt`。
  - tool item继续由 `ChatToolCall.startedAt` 提供时间。
- `HISTORY_RECONCILED` 仍按现有 identity/window 规则替换 live item，不比较时间。

#### `src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.ts`

- message item 有有效 `createdAt` 时设置 `ThreadMessageLike.createdAt = new Date(createdAt)`。
- tool group 使用组内最早的有效 `tool.startedAt`。
- 时间缺失时不要省略后任由 assistant-ui 回填当前时间。
- 对缺失时间写入 custom metadata，例如 `openClawTimestampKnown: false`，并给 assistant-ui 一个稳定 sentinel Date；展示组件根据 metadata 输出“时间未知”。
- 推荐 sentinel 为 `new Date(0)`，只作为 assistant-ui 内部必填兼容值，并由 `openClawTimestampKnown: false` 保证不进入业务展示或线上的 `timestamp` 契约。

assistant-ui 会在 `createdAt` 缺失时自动使用 `new Date()`。
因此缺失时间场景必须显式区分，防止旧历史消息看起来刚刚创建。

#### `src/features/openclaw-bff/components/chat/MessageTimestamp.tsx`

- 新增 feature-local `MessageTimestamp` 和 `MessageTimeProvider`。
- 通过 `useAuiState` 读取当前 message 的 `createdAt` 和 `metadata.custom.openClawTimestampKnown`。
- 定义具名常量 `JUST_NOW_THRESHOLD_MS = 60_000` 和 `RELATIVE_TIME_WINDOW_MS = 30 * 60_000`，不在条件分支散落 magic number。
- `formatMessageTimestamp(createdAt, now)` 按 `<1 minute`、`1-29 minutes`、`>=30 minutes` 三段规则返回显示文本。
- 相对文案固定为用户指定的英文 `just now`、`1 minute ago` 和 `N minutes ago`。
- 绝对时间使用固定 `zh-CN` 数字格式和浏览器默认时区输出 `YYYY-MM-DD HH:mm`。
- `<time dateTime={createdAt.toISOString()}>` 保存机器可读 UTC 时间。
- `title` 使用包含秒和时区名称的完整本地时间，并通过仅供屏幕阅读器读取的文本提供同等可访问名称。
- 未知时间输出普通 `<span>`“时间未知”，不输出 1970 时间。
- `MessageTimeProvider` 接收当前 thread 的已知 message timestamps，只维护一个共享 `now`。
- provider 计算所有相对时间标签的最近下一次变化点，并使用单个 `setTimeout` 精确唤醒。
- 超远未来边界的单次 timeout 限幅为浏览器支持的 `2^31-1ms`，到期后继续分段调度。
- 所有消息都已达到 30 分钟、时间未知或 thread 为空时不保留 timer。
- 页面从后台恢复可见时监听 `visibilitychange`，立即重新读取 `Date.now()` 并重算下一边界，避免浏览器 timer throttling 后文案过期。

#### `src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`

- `UserMessage` 在气泡下方、复制动作前渲染右对齐时间。
- `AssistantMessage` 把 timestamp 与现有 provider/model 合并到同一 footer，复制动作保持独立按钮。
- `SystemMessage` 在系统卡片内底部渲染时间。
- 从 `props.items` 收集 message `createdAt` 和 tool `startedAt`，传给 thread 级 `MessageTimeProvider`。
- 整个 thread 只创建一个边界 timer，不允许每个 `MessageTimestamp` 各自创建 interval/timeout。
- 不在 `OpenClawMessageList` 外层按 DOM id 查找时间，避免绕过 assistant-ui message context。

## Implementation Steps

### Phase 1: Lock the public timestamp contract

1. **Normalize history timestamp at the transcript boundary**
   - File: `src/gateway/session-history-page.ts`
   - Action: 增加安全解析与顶层 ISO 回填，覆盖普通、compaction 和 placeholder 分支。
   - Why: transcript reader 是最早同时拥有 envelope 和 message 的位置，适合建立唯一规范化边界。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Medium. 错误 fallback 会把历史消息标成当前时间。

2. **Declare timestamp in chat history schema**
   - File: `src/gateway/protocol/schema/logs-chat.ts`
   - Action: 将可选非负 number 加入 `ChatHistoryMessageSchema`。
   - Why: 避免前端长期依赖未声明的 additional property。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Low, provided the field remains optional.

3. **Add Gateway protocol and pagination regression tests**
   - Files: `src/gateway/session-history-page.test.ts`, `src/gateway/server.chat.gateway-server-chat-b.test.ts`, `src/gateway/protocol/index.test.ts`, `src/gateway/server-chat.agent-events.test.ts`
   - Action: 锁定 normalization、分页稳定性、非法输入和 live event contract。
   - Why: history 和 live 两条路径必须返回同一时间单位。
   - Dependencies: Steps 1-2.
   - Complexity: Medium.
   - Risk: Low.

4. **Regenerate and verify protocol outputs**
   - Files: generated protocol artifacts.
   - Action: 运行 protocol generation 与 check。
   - Why: schema 改动必须保持 TypeScript/Swift 产物一致。
   - Dependencies: Step 2.
   - Complexity: Low.
   - Risk: Low.

### Phase 2: Prove BFF transparency

1. **Add history response passthrough tests**
   - File: `../agent-server/app/test/unit_test/services/test_openclaw_protocol_translator.py`
   - Action: 在包含 key/run translation、spawn sanitizer 和 private-field stripping 的 payload 中断言 timestamp 原值保留。
   - Why: 覆盖 BFF 真实职责链，不只测试一个无翻译的字典。
   - Dependencies: Phase 1 contract.
   - Complexity: Low.
   - Risk: Low.

2. **Add live event passthrough tests**
   - Files: `../agent-server/app/test/unit_test/services/test_openclaw_protocol_translator.py`, `../agent-server/app/test/unit_test/api/test_openclaw_bridge_controller.py`
   - Action: 验证 Pydantic 往返和 WebSocket JSON 序列化不会丢失或改写嵌套时间。
   - Why: 实时路径不经过 `chat.history` request service。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

3. **Verify attachment enrichment preserves timestamp**
   - File: `../agent-server/app/test/unit_test/services/test_openclaw_bridge_request_service.py`
   - Action: 在 history attachment enrichment 用例中增加 timestamp 断言。
   - Why: enrichment 位于 Gateway response 和 translator 之间，是历史链路的独立变换点。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

4. **Keep BFF production code unchanged unless tests fail**
   - Action: 仅在测试证明字段被某个 sanitizer/enrichment 丢弃时修改该窄函数。
   - Why: 当前 JsonValue 透明代理设计符合字段所有权边界。
   - Dependencies: Steps 1-3.
   - Complexity: Low.
   - Risk: Low.

### Phase 3: Carry timestamps through frontend state

1. **Extend the frontend domain types**
   - File: `../agent-frontend/src/features/openclaw-bff/types/chat.ts`
   - Action: 增加 message/block 时间字段，保持 wire 与 domain 命名分离。
   - Why: 先建立编译期约束，再修改 mapper/reducer。
   - Dependencies: Phase 1 semantics.
   - Complexity: Low.
   - Risk: Low.

2. **Map persisted history timestamps**
   - Files: `../agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts`, `../agent-frontend/src/features/openclaw-bff/api/chat-mappers.test.ts`
   - Action: 解析 timestamp，传播到文本、附件、compaction、tool call/result 和 oversized placeholder。
   - Why: 当前实际丢字段的位置就在 mapper。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium. 跨页 tool merge 容易覆盖更早的 startedAt。

3. **Separate live event time from reducer update time**
   - Files: `../agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.ts`, `../agent-frontend/src/features/openclaw-bff/state/chat-reducer.ts`
   - Action: `CHAT_EVENT` 同时携带 `createdAt` 与 `now`，text/tools block 首次创建后锁定时间。
   - Why: 每个 delta 都有新 timestamp，只能取首个可见事件作为临时消息创建时间。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: High. reducer 维护 streaming、steer、foreign run 和 terminal reconcile 多种状态。

4. **Preserve timestamps during reconciliation**
   - Files: `../agent-frontend/src/features/openclaw-bff/state/chat-reducer-pagination.test.ts`, `../agent-frontend/src/features/openclaw-bff/state/chat-reducer.test.ts`, `../agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx`
   - Action: 增加 optimistic/live 时间稳定与 persisted replacement 测试。
   - Why: 时间功能不能破坏现有分页和终态收敛。
   - Dependencies: Steps 2-3.
   - Complexity: Medium.
   - Risk: Medium.

### Phase 4: Adapt and render timestamps

1. **Populate assistant-ui createdAt**
   - Files: `../agent-frontend/src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.ts`, `../agent-frontend/src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.test.ts`
   - Action: message/tool group 转换为 `ThreadMessageLike.createdAt`，未知时间设置显式 metadata。
   - Why: assistant-ui 已提供正确的 message context，不需要维护平行时间 store。
   - Dependencies: Phase 3.
   - Complexity: Medium.
   - Risk: Medium. 省略 createdAt 会触发 assistant-ui 当前时间 fallback。

2. **Implement accessible local-time rendering**
   - Files: `../agent-frontend/src/features/openclaw-bff/components/chat/MessageTimestamp.tsx`, `../agent-frontend/src/features/openclaw-bff/components/chat/MessageTimestamp.test.tsx`
   - Action: 增加三段式相对/绝对格式、tooltip、ARIA、未知时间分支及 thread 级边界 scheduler。
   - Why: 把展示规则集中在 feature-local 组件，避免三类 message 复制 formatter。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium. 测试必须固定 timezone，并使用 fake timers 覆盖临界点和后台恢复。

3. **Place timestamps in all message variants**
   - Files: `../agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`, `../agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx`
   - Action: 接入 thread 级 provider 与 user/assistant/system footer，验证 streaming 和 provider/model 共存布局。
   - Why: 每类 message 使用不同组件，必须逐一覆盖。
   - Dependencies: Step 2.
   - Complexity: Medium.
   - Risk: Medium. 元数据 footer 可能增加高度并影响历史 prepend scroll compensation。

4. **Verify pagination scroll anchoring**
   - Files: `../agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx`
   - Action: 保留并扩展 prepend/ResizeObserver 用例，确认新增 footer 后锚点不跳动。
   - Why: 时间行改变每条消息高度，历史分页是最直接的布局回归面。
   - Dependencies: Step 3.
   - Complexity: Medium.
   - Risk: Medium.

### Phase 5: Cross-repository acceptance

1. **Validate a persisted-history journey**
   - Action: 打开已有会话，确认首屏和向上分页的每条消息时间与 JSONL epoch 对应。
   - Dependencies: Phases 1-4.
   - Complexity: Medium.
   - Risk: Low.

2. **Validate a live-to-persisted journey**
   - Action: 发送消息，观察 user 时间立即出现、assistant 时间在首个 delta 固定、final/history reconcile 后不重复气泡。
   - Dependencies: Phases 1-4.
   - Complexity: Medium.
   - Risk: Medium.

3. **Validate reconnect and pagination**
   - Action: 响应进行中断开/恢复 WebSocket，再加载更早历史，确认时间与滚动锚点稳定。
   - Dependencies: Phases 1-4.
   - Complexity: High.
   - Risk: Medium.

4. **Validate browser timezone behavior**
   - Action: 使用两个浏览器 timezone 运行同一固定 epoch 的组件/E2E 断言，确认 wire value 不变而展示随本地时区变化。
   - Dependencies: Phase 4.
   - Complexity: Medium.
   - Risk: Low.

5. **Validate relative-time transitions**
   - Action: 保持页面静止，确认 `just now` 自动变为 `1 minute ago`，并在 30 分钟边界自动切换为绝对时间。
   - Dependencies: Phase 4.
   - Complexity: Low.
   - Risk: Low.

## Testing Strategy

### openclaw-integration

Targeted tests:

```bash
pnpm exec vitest run --config vitest.gateway.config.ts \
  src/gateway/session-history-page.test.ts \
  src/gateway/server.chat.gateway-server-chat-b.test.ts \
  src/gateway/server-chat.agent-events.test.ts \
  --maxWorkers=2

pnpm exec vitest run src/gateway/protocol/index.test.ts --maxWorkers=2
pnpm protocol:gen
pnpm protocol:gen:swift
pnpm protocol:check
git diff --check
```

不运行 `pnpm test`、`pnpm test:fast` 或其他 full suite，除非用户在实现阶段明确批准。

### agent-server

Targeted tests:

```bash
uv run pytest \
  app/test/unit_test/services/test_openclaw_protocol_translator.py \
  app/test/unit_test/services/test_openclaw_bridge_request_service.py \
  app/test/unit_test/api/test_openclaw_bridge_controller.py

uv run ruff check \
  app/test/unit_test/services/test_openclaw_protocol_translator.py \
  app/test/unit_test/services/test_openclaw_bridge_request_service.py \
  app/test/unit_test/api/test_openclaw_bridge_controller.py
```

如果 BFF 生产代码没有变化，不扩大到全量 mypy 或全量 pytest。

### agent-frontend

Targeted tests:

```bash
npx vitest run \
  src/features/openclaw-bff/api/chat-mappers.test.ts \
  src/features/openclaw-bff/state/chat-reducer.test.ts \
  src/features/openclaw-bff/state/chat-reducer-pagination.test.ts \
  src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx \
  src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.test.ts \
  src/features/openclaw-bff/components/chat/MessageTimestamp.test.tsx \
  src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx

npm run type-check
```

组件测试应通过 `TZ=UTC` 或测试运行器 timezone 配置固定环境。
格式化函数测试使用固定 epoch，不依赖 `Date.now()`。
使用 fake timers 覆盖 `59_999ms`、`60_000ms`、`29m59s` 和 `30m` 四个边界，并验证单复数。
provider 测试断言整个 thread 只有一个 pending timer、达到绝对时间窗口后清理 timer、`visibilitychange` 后立即校正，并覆盖超长延迟限幅与卸载清理。

### Cross-layer contract fixtures

三仓测试复用以下固定值：

```json
{
  "historyEntryId": "entry-time-1",
  "role": "assistant",
  "content": [{ "type": "text", "text": "done" }],
  "timestamp": 1787875200123
}
```

每层断言数值严格相等。
只有 agent-frontend adapter 将其转换为 `new Date(1787875200123)`。

## Deployment Order

1. 发布 openclaw-integration Gateway，建立历史 timestamp 回填能力。
2. 发布 agent-server BFF 测试锁定版本；若生产代码无变化，可与现有 BFF 版本兼容。
3. 发布 agent-frontend，开始展示时间。

协议改动向后兼容：

- 新 Gateway + 旧 frontend：额外 timestamp 被忽略。
- 旧 Gateway + 新 frontend：已有内层 timestamp 正常显示，缺失记录显示“时间未知”。
- 新 frontend + 当前 BFF：timestamp 通过 JsonValue 原值透传。

不需要数据库 migration、Redis flush 或 Gateway session reset。
Gateway 进程更新仍按正常发布流程重启，不能在实现任务中未经确认直接执行本地 `openclaw gateway restart`。

## Risks And Mitigations

- **Risk: assistant-ui silently assigns current time to old messages**
  - Mitigation: adapter 对未知时间设置 sentinel Date 和 `openClawTimestampKnown=false`，组件只展示“时间未知”。

- **Risk: every delta changes the displayed assistant time**
  - Mitigation: text block 只在首次创建时记录 createdAt，累计 delta 保留原值。

- **Risk: history timestamp and live timestamp differ by seconds**
  - Mitigation: 接受临时时间在 persisted reconciliation 后收敛；时间不参与 identity。

- **Risk: top-level ISO and inner epoch disagree**
  - Mitigation: 明确 inner message timestamp 优先，并增加冲突测试；该字段最接近实际消息对象。

- **Risk: epoch seconds are mistakenly rendered as 1970**
  - Mitigation: 不启发式猜测单位；Gateway contract 明确毫秒。必要时在开发日志/测试中暴露非法上游数据，而非静默转换。

- **Risk: cross-page tool result overwrites call start time**
  - Mitigation: merge 明确 `startedAt=min known call time`、`updatedAt=max known result time`，增加跨页测试。

- **Risk: extra footer height breaks prepend scroll anchoring**
  - Mitigation: 扩展现有 ResizeObserver 和 visible message anchor 测试，并做真实浏览器分页验证。

- **Risk: server timezone leaks into browser display**
  - Mitigation: wire 只传 epoch number，BFF 不格式化，browser 使用本地 `Intl.DateTimeFormat`。

- **Risk: one timer per message causes large history pages unnecessary wakeups**
  - Mitigation: thread 级 provider 只保留一个指向最近标签变化点的 timeout，绝对时间窗口内不再调度。

- **Risk: background-tab timer throttling leaves stale relative text**
  - Mitigation: provider 在 `visibilitychange` 恢复可见时立即刷新 now 并重排下一边界。

- **Risk: invalid legacy time causes entire history request failure**
  - Mitigation: schema 字段保持 optional，normalizer 对无效值省略，frontend 显示未知。

- **Risk: timestamp accidentally becomes reconciliation key**
  - Mitigation: 保持 `historyEntryId/messageId` 优先和 legacy text matching 逻辑不变，测试重复文本与时间差异场景。

## Success Criteria

- [ ] agent-frontend OpenClaw WebChat 的 user、assistant、system 和 tool-only message 均显示独立时间或“时间未知”。
- [ ] 不足 1 分钟显示 `just now`，1-29 分钟显示正确单复数的 `N minute(s) ago`，达到 30 分钟显示绝对时间。
- [ ] 相对时间无需用户操作即可在 1 分钟和 30 分钟边界自动更新。
- [ ] 每个 thread 最多存在一个时间刷新 timer，所有可见时间进入绝对窗口后 timer 被清理。
- [ ] 有效历史消息显示 JSONL 持久化时间，向上分页后数值与格式不变。
- [ ] 实时 assistant streaming 的时间在首个可见 delta 后保持稳定。
- [ ] terminal history reconcile 后不产生重复消息，live 时间由 persisted 时间收敛。
- [ ] BFF 对 history response 和 live chat event 的 timestamp 原值透传。
- [ ] BFF 没有新增时间存储、timezone 转换或 datetime 字符串 contract。
- [ ] Gateway history schema 显式声明可选 Unix 毫秒 timestamp。
- [ ] 普通 message 缺失内层时间时可从顶层 JSONL ISO 时间回填。
- [ ] 无可信时间的旧记录不会显示为当前时间。
- [ ] 时间不参与 identity、pagination cursor 或 reconciliation matching。
- [ ] targeted Gateway、BFF、frontend tests 通过。
- [ ] `pnpm protocol:check`、frontend type-check 和三个仓库的 `git diff --check` 通过。
- [ ] 真实浏览器验证覆盖历史首屏、历史分页、实时发送、流式响应、终态对账和断线重连。

## Implementation Boundary

本计划包含三个仓库，但生产逻辑改动预期集中在 openclaw-integration 与 agent-frontend。
agent-server 的默认结果是补回归测试，不主动增加生产抽象。
如果实现时发现当前 BFF sanitizer/enrichment 丢失 timestamp，应以失败测试为依据修改最窄的对应函数，并保持 wire 字段名与数值不变。
