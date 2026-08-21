# Implementation Plan: WebChat JSONL 历史游标分页与 Provider 展示

## Overview

本方案取消 OpenClaw 全局自动 session reset，继续使用当前活跃 Pi JSONL transcript 作为聊天历史事实源。Gateway 为 `chat.history` 增加向前游标分页，并改用异步反向分块读取；WebChat 首次加载最新一页，用户向上滚动时继续加载更早消息。

模型上下文仍由 Pi compaction 管理。WebChat 展示读取完整 transcript，二者不共享同一裁剪窗口。本方案不引入 PostgreSQL 消息表，不兼容已有 `.jsonl.reset.*` 历史文件，也不修改 agent-server 的每日审计导入职责。

## Requirements

### Functional Requirements

- 删除全局 `session.reset`，飞书、WebChat 和其他渠道不再按 weekly 策略自动切换 session UUID。
- 保留用户主动执行 `/new`、`/reset` 或会话删除产生新 session 的现有语义。
- `chat.history` 支持 `before + limit` 向更早历史分页。
- 未传 `before` 的调用继续返回当前活跃 transcript 的最新消息。
- WebChat 初始加载与 terminal reconcile 使用 1000 条窗口；向上翻页每页 100 条，两者为独立常量。
- Gateway 读取历史时不再同步读取整个 JSONL。
- WebChat 首次加载最新一页，滚动到顶部附近时自动加载更早一页。
- 消息列表按稳定 message ID 渲染（keyed），prepend 不产生整列表重挂载或局部状态错位。
- 加载旧页后保持当前视觉锚点，页面不能跳到顶部或底部。
- 新消息到达、terminal reconcile 和断线恢复不能清除已加载的旧页。
- assistant 历史消息和 terminal 实时消息展示实际 `provider` 与 `model`。
- provider 信息按 assistant 消息保存和展示；同一会话允许出现多个 provider/model。
- 保持当前附件引用重建、消息脱敏、工具调用展示、compaction 分隔标记和响应体积保护。

### Compatibility Requirements

- 现有只传 `{sessionKey, limit}` 的客户端继续工作。
- `limit` 继续保持 `1..1000` 协议范围；WebChat 初始页/对账窗口保持 1000，旧页翻页使用 100。
- agent-server 继续只重写授权后的 `sessionKey`，透传 `before`、`nextBefore`、`hasMore` 和消息元数据。
- 子任务历史查看首版继续使用现有一次性读取方式，可以忽略 `nextBefore`。
- `chat.history` 仍只读取当前 `sessions.json` entry 指向的活跃 `.jsonl`。
- 分页仅支持 v3 transcript；reader 遇到非 v3 header 按 `cursorReset` 处理，不做分页读取。
- 当前每日 `chat_session_import` 继续只导入轮次、token 和子任务审计数据。

### Performance Requirements

- 历史页读取使用异步文件 API，避免阻塞 Gateway event loop。
- 首次加载和后续翻页只读取满足当前页所需的文件尾部区间。
- 普通 100 条消息页面不得读取完整长期 transcript。
- 继续执行单消息 128 KiB 展示上限和单响应 6 MiB 上限。
- 游标分页不能因响应体积裁剪产生消息永久跳过。

## Non-Goals

- 不读取、合并或迁移 `.jsonl.reset.*`、`.jsonl.deleted.*`、`.jsonl.bak.*`。
- 不把聊天消息同步到 PostgreSQL。
- 不改变 Pi compaction 算法、摘要格式、上下文窗口或 memory flush。
- 不让模型读取 WebChat 已加载的完整展示历史。
- 不为飞书增加历史回放页面。
- 不增加跨会话全文搜索、历史导出或 provider 聚合统计。
- 不把 provider/model 写入会话列表或侧边栏。
- 不修改现有每日 chat session import 表结构和调度时间。
- 不引入完整虚拟化（以 1000→3000 条浏览器性能门槛触发后续项，抽象已预留）。
- 不在本计划中执行 Gateway 重启或生产配置变更。

## Current State

### Gateway

- `src/gateway/server-methods/chat.ts` 的 `chat.history` 当前调用 `readSessionMessages()`，先同步读取完整 transcript，再截取最后 `min(limit, 1000)` 条（`limit` 缺省时默认 200）。
- `src/gateway/session-utils.fs.ts` 的 `readSessionMessages()` 使用 `fs.readFileSync()` 和逐行 `JSON.parse()`；收录判定是宽松的"存在 truthy `message` 字段"（不检查 `type`），跳过的 operational record 包括 `session` header、`thinking_level_change`、`model_change`、`custom`、`custom_message`、`label`、`session_info`、`branch_summary`。
- toolResult 是独立顶层 record（`role:"toolResult"`、自有 `toolCallId`）；tool call 是 assistant record content 内的 `toolCall` block。compaction divider 是现存唯一保留外层 record id 的输出（`__openclaw.id`）。
- `src/gateway/protocol/schema/logs-chat.ts` 的 `ChatHistoryParamsSchema` 只接受 `sessionKey` 和 `limit`。
- `src/gateway/server-constants.ts` 将单次历史消息响应限制为 6 MiB。响应预算是两级裁剪：`capArrayByJsonBytes()` 从数组头端丢弃后，`enforceChatHistoryFinalBudget()` 还可能把响应塌缩为最后一条或 placeholder。
- `chat.history` 只有 params 校验、无 result schema；仓内 10+ 个 RPC 客户端只传 `{sessionKey, limit}` 且只读 `.messages`，附加字段安全。
- `sanitizeChatHistoryMessage()` 会删除 `usage`、`cost` 和 `details`，但保留 `provider` 与 `model`。
- transcript 外层 record 已有稳定 `id`、`parentId` 和字节顺序；当前 `chat.history` 返回时丢弃了外层 `id`。
- 普通自动 compaction 追加 compaction record，压缩前消息继续保留在当前 JSONL。
- `src/auto-reply/reply/post-compaction-audit.ts` 的审计路径当前同步全量读取 transcript 后截取最后 100 行再过滤 `type==="message"`（行数而非消息数；`agent-runner.ts` 调用）；其 `extractReadPaths()` 只匹配 `"tool_use"` + `input` 字段，与 Pi 实际 `toolCall` + `arguments` 格式不符，审计从未提取到读路径。
- `sessions.preview` 已是有界尾读（单次窗口最大 1 MiB），不存在全量读取问题；agent-frontend 不调用它。

### agent-server

- `app/services/openclaw_protocol_translator.py` 的 `chat.history` 重写逻辑复制浏览器参数，只覆盖授权后的 `sessionKey`。
- `app/services/openclaw_bridge_request_service.py` 对 history payload 执行附件 enrichment，并透传其他字段。
- `app/services/openclaw_protocol_translator.py` 只移除 `__openclaw` 私有字段，不会移除公开的 provider/model 或分页字段。
- 现有每日 `chat_session_import` 已能读取 provider/model，但只落到 token usage 审计数据。

### agent-frontend

- `src/features/openclaw-bff/types/chat.ts` 将 `OPENCLAW_CHAT_HISTORY_LIMIT` 固定为 1000。
- `useOpenClawChat.performHistoryReconcile()` 每次请求最近 1000 条；触发点约 20 处（初次加载、可见性恢复、seq gap、steer accepted/cleared/discarded、三条 abort 路径、degraded→health 恢复、run 首现 300ms 去抖、terminal 事件、retry 等），仅有 timer 去抖、无 in-flight 去重。
- reducer 端 `reconcileHistory()`：`findHistoryOverlapBoundary()` 假定新窗口是 `historyBase` 的超集扩展（previous 尾部对 next 头部），`isRegressiveHistorySnapshot()` 丢弃前缀子集快照；两条提交分支（`canCommitHistory` 为 true 或 false）都是**整窗替换** `historyBase`（`action.items` 或 `action.items.slice(0, historyBoundary)`）。整窗替换与分页 prepend 直接冲突，需重写为"旧页前缀 + 最新窗口按 `historyEntryId` 尾部对齐"的统一合并。
- `windowContainsAssistantText()`、`lastAssistantSegmentText()`、`matchRunWindow()` 依赖 `^history-(\d+)-` ID 正则给同一 assistant 消息的多个 block 分组并定位 live run 提交边界；`historyFence` 是 `historyBase` 的数字下标，`getRunResumeMetadata()` 用 `historyBase.slice(0, fence)` 做跨刷新 run 恢复快照。
- `mapOpenClawHistory()` 使用页内数组下标生成消息 ID，无法支持跨页稳定去重；主会话与子会话历史（`useOpenClawSubagents.loadChildHistory()`，一次性读取）共用该 mapper 与同一 reducer。
- `OpenClawChatState.historyBase` 没有历史游标、加载状态或旧页错误状态。
- `ThreadPrimitive.Viewport` 已支持用户滚动后暂停自动滚底，但没有向上加载逻辑；`ThreadPrimitive.Messages` 以数组下标作 React key 且无虚拟化，prepend 后各 index 对应的消息整体改变（O(N) 更新 + 局部状态错位）。组件测试已有 `TestResizeObserver`/`notifyResizeObservers()` 滚动测试设施；`OpenClawAssistantThread` 还被 `SubagentActivityPanel` 以 readOnly 复用。
- `ChatMessageItem` 和 assistant-ui metadata 当前没有 provider/model。

## Architecture Decisions

### 1. Source Of Truth

```text
Pi active JSONL transcript
    ├── Pi SessionManager → compaction summary + recent tail → model
    └── chat.history      → cursor pages of full display history → WebChat
```

- 当前活跃 JSONL 是唯一聊天历史事实源。
- Gateway 负责 transcript 解析、展示脱敏、附件引用重建和分页。
- agent-server 只负责授权范围重写与 payload enrichment。
- agent-frontend 只保存当前页面生命周期内已加载的历史页。

### 2. Pagination Contract

请求：

```json
{
  "sessionKey": "chat_xxx",
  "limit": 100,
  "before": "opaque-cursor"
}
```

首次请求省略 `before`。

页大小约定（前端两个独立常量）：

- 初始加载与 terminal reconcile：`limit=1000`（沿用 `OPENCLAW_CHAT_HISTORY_LIMIT`）。
- `loadOlderHistory()` 向上翻页：`limit=100`（新增 `OPENCLAW_CHAT_OLDER_PAGE_LIMIT`）。
- 稳定运行后再评估把初始窗口降到 100（见 Rollout）。

响应：

```json
{
  "sessionKey": "chat_xxx",
  "sessionId": "physical-session-uuid",
  "messages": [],
  "nextBefore": "opaque-cursor",
  "hasMore": true,
  "cursorReset": false,
  "thinkingLevel": "high",
  "verboseLevel": "off"
}
```

字段语义：

- `messages`：按时间正序排列，仅包含当前页。
- `nextBefore`：读取更早一页时使用；`hasMore=false` 时省略。
- `hasMore`：当前活跃 transcript 中是否还有更早的可展示记录。
- `cursorReset`：游标所属文件已被替换、截断或切换到新 session；响应改为当前 transcript 最新页，前端必须清空旧页。
- `historyEntryId`：Gateway 在每个返回 message 的展示副本上增加的稳定公开字段，来源为 transcript record ID；record 缺少外层 `id` 时由 Gateway 以 `off-${startOffset}` 合成（同一 file token 内稳定且唯一），保证新 Gateway 响应恒有该字段；不写回 JSONL。

兼容规则：

- 老客户端不传 `before` 时，行为仍是读取最新 `limit` 条。
- 新字段均为附加字段，老客户端可以忽略。
- malformed cursor 返回 `INVALID_REQUEST`。
- 格式正确但已过期的 cursor 返回最新页，并设置 `cursorReset=true`。

### 3. Opaque Cursor

游标使用 versioned base64url payload：

```json
{
  "v": 2,
  "sessionId": "uuid",
  "fileToken": "sha256-derived-token",
  "beforeOffset": 123456,
  "anchorStart": 121408,
  "anchorLength": 4096,
  "anchorHash": "sha256-derived-anchor"
}
```

- `beforeOffset` 表示下一页读取的文件结束位置，不包含该位置之后的数据。
- `fileToken` 由 resolved transcript path、`stat.dev` 和 `stat.ino` 生成短哈希，不暴露真实路径。
- 文件正常追加时旧 offset 保持有效。
- 文件替换或手动 reset 导致 file token/session ID 不匹配，触发 `cursorReset`。
- `anchorHash` 绑定游标边界前后最多各 2 KiB 内容，用于识别影响边界的同 inode truncate、rewrite 和 regrow；正常 append 不改变既有锚点，旧游标继续有效。
- page 读取和游标生成之间必须保持相同的 `dev`、`ino`、size、mtime 和 ctime；期间发生 append 或 rewrite 时本次请求显式失败并由客户端重试，禁止把旧页内容与新文件游标组合。
- Gateway 重启后，只要当前文件身份不变，游标继续有效。
- cursor 解码后必须校验版本、字段类型、session ID、file token 和 offset 范围；`beforeOffset` 大于当前文件大小视为过期游标，返回最新页并 `cursorReset=true`。
- 前置条件：分页仅支持 v3 transcript（首行 `session` header `version:3`）；reader 遇到非 v3 header 直接按 `cursorReset` 处理，不做分页读取。v1/v2 遗留文件被 `SessionManager.open()` 原地改写（inode 不变、offset 位移）的盲区因此不成立（线上活跃 transcript 均为 v3）。
- `session-file-repair.ts` 用 tmp+rename 重写会改变 inode，现有 file token 即可检测；其 `.bak-<pid>-<ts>` 备份文件不会被读取（reader 只按 sessions.json entry 解析出的活跃路径读取，不做目录扫描），无需加入忽略清单。
- 不支持绕过 OpenClaw 写入路径、同时保持游标边界内容不变的任意局部覆写；游标不承担全文件哈希或外部文件完整性证明职责。

### 4. Reverse JSONL Reader

新增独立模块：

```text
src/gateway/session-history-page.ts
```

职责：

- 定位当前活跃 transcript。
- 解码和验证 `before`。
- 使用 `fs.promises.open()` 从 EOF 或 `beforeOffset` 向前分块读取。
- 使用 Buffer 拼接完整 JSONL 行，避免 UTF-8 多字节字符在 chunk 边界损坏。
- 跳过空行、无法解析的行和与展示无关的 operational record；收录判定复刻现有宽松语义（存在 truthy `message` 字段即为候选，不检查 `type`），跳过清单与 `readSessionMessages()` 一致。
- 校验 transcript 首行为 v3 session header；非 v3 直接走 `cursorReset` 路径。
- 将 `message` record 转换为带 `historyEntryId` 和 source offset 的展示消息。
- 将 `compaction` record 转换为当前已有的 synthetic system divider。
- 读取 `limit` 个可展示 record，并继续做一个可展示 record 的 lookahead 以计算 `hasMore`。
- 返回每个消息的 `startOffset`，供响应体积裁剪后重新计算 `nextBefore`。

建议内部类型：

```ts
type HistoryPageRecord = {
  historyEntryId: string;
  startOffset: number;
  endOffset: number;
  message: unknown;
};

type SessionHistoryPage = {
  records: HistoryPageRecord[];
  nextBefore?: string;
  hasMore: boolean;
  cursorReset: boolean;
};
```

读取边界：

- 默认 chunk 64 KiB。
- 单行内存上限 8 MiB；超过后不再累积或解析正文，返回带稳定 offset ID 的 oversized placeholder。
- 单请求扫描上限 32 MiB、原始记录上限 10,000；到达完整行边界时返回 continuation cursor，不能找到行边界时以 `UNAVAILABLE` 终止请求。
- 不把 arbitrary chunk 直接转换为字符串；完整行拼接完成后再 UTF-8 decode。
- transcript 尾部存在尚未写完的 partial line 时忽略该行，不把它标记为永久损坏。
- 单行异常不能阻止继续读取更早消息。
- 极大单行继续走现有 oversized placeholder 逻辑；reader 不复制整个文件。

### 5. Response Budget And Cursor Correctness

现有响应预算是两级裁剪：`capArrayByJsonBytes()` 从数组头端移除旧消息，`enforceChatHistoryFinalBudget()` 还可能把响应塌缩为最后一条或 placeholder。分页后必须保留 offset 元数据直到两级预算处理全部结束。

处理顺序：

```text
reverse reader records
  → attachment reference rebuild
  → envelope/directive sanitization
  → text truncation
  → oversized message replacement
  → response byte cap
  → based on earliest actually returned record recompute nextBefore
  → strip internal offset metadata
```

规则：

- 因 6 MiB 限制被移除的页首消息不能被游标跨过。
- `nextBefore` 必须指向当前响应中最早实际返回 record 的 `startOffset`，且在两级裁剪（含 `enforceChatHistoryFinalBudget` 塌缩）全部结束后重算。
- 单条消息过大时返回 placeholder，并保留原 record 的 `historyEntryId` 和 offset。
- 如果最终响应为空但 reader 找到消息，返回明确错误并记录日志，避免 `hasMore=true` 的空页死循环。

### 6. Stable Frontend Identity

Gateway 返回：

```json
{
  "historyEntryId": "135efe6a",
  "role": "assistant",
  "provider": "otr",
  "model": "gpt-5.6-sol",
  "content": []
}
```

前端 ID 规则：

- text message：`history-${historyEntryId}-${blockIndex}`。
- tool item：`history-tool-${toolCallId}`。
- synthetic compaction divider：`history-compaction-${historyEntryId}`。
- `legacy-${messageIndex}` fallback 仅保留给"旧 Gateway + 新前端"的发布兼容窗口（响应完全没有 `historyEntryId` 字段时）；旧协议不支持分页，单页内下标即稳定，fallback 不进入长期路径。

结构化分组字段（访谈决议）：

- `ChatMessageItem` 增加可选 `historyEntryId`，同一 transcript record 拆出的多个 text block 共享同一 `historyEntryId`；`item.id` 只承担 React 身份，不承担消息分组语义。
- `windowContainsAssistantText()`、`lastAssistantSegmentText()`、`matchRunWindow()` 改为按 `historyEntryId` 结构化分组，删除 `^history-(\d+)-` 正则依赖（Phase 5.3 显式列出）。

跨页 toolCall/toolResult：

- `mergeHistoryPages()` 使用 `toolCallId` 合并同一工具项。
- older page 提供 tool call 参数和起始位置。
- newer page 提供 tool result、error 和最终状态。
- 合并后的工具项位于 tool call 首次出现的位置。
- 普通消息按稳定 ID 去重。

### 7. Frontend State Model

扩展 `OpenClawChatState`：

```ts
type OpenClawChatState = {
  historyBase: ChatHistoryItem[];
  olderHistoryCursor: string | null;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  olderHistoryError: string | null;
  // existing fields...
};
```

新增 action：

```text
OLDER_HISTORY_STARTED
OLDER_HISTORY_LOADED
OLDER_HISTORY_FAILED
HISTORY_CURSOR_RESET
```

状态规则（访谈决议：统一单路径）：

- 所有 `HISTORY_RECONCILED` 触发来源（terminal、可见性恢复、seq gap、steer、abort、degraded 恢复等约 20 处）统一走同一合并函数：按 `historyEntryId` 查找重叠 → 保留重叠点之前的旧页前缀 → 用最新窗口刷新重叠部分及尾部。触发原因不决定是否保留旧页。
- `canCommitHistory=false` 的中途 reconcile 同样保留旧页前缀，仅对最新窗口执行 `slice(0, historyBoundary)`，不得整窗覆盖 `historyBase`。
- 删除 `isRegressiveHistorySnapshot()`；其防御场景由稳定 ID 尾部对齐 + 无重叠 reset 路径取代。继续用 `reconcileSeq` 丢弃乱序响应（乱序到达时不修改历史与游标）。
- 初次 reconcile 写入最新页和 `nextBefore`。
- `OLDER_HISTORY_LOADED` 将旧页合并到 `historyBase` 前部。
- prepend N 个 item 后，所有 active run 的 `historyFence` 增加 N，保持 `getRunResumeMetadata()` 的 `slice(0, fence)` 恢复快照与乐观去重窗口语义。
- 最新窗口与已加载历史（两个非空窗口）存在稳定 ID 但完全无重叠（缺口，如断线期间同会话被其他入口写入超过一个窗口的消息）时，与 `cursorReset=true` 走同一本地 reset 状态转换：清空已加载旧页、live-run history fence 和旧游标，采用最新窗口；不做缺口标记，也不自动连续翻页补齐。
- 旧 Gateway 缺少分页字段与稳定 ID 时，维持单页整窗 reconcile，不允许加载旧页。
- 已加载过旧页时，最新窗口 reconcile 不覆盖 `olderHistoryCursor`。
- session 切换或 hook unmount 后返回的旧翻页请求必须被 generation guard 丢弃（依赖 screen 层 key remount + `connectionGeneration` 校验；reconcile 的 timer 去抖不提供 in-flight 互斥，分页请求需自带互斥）。
- 同一时刻最多允许一个 older-page 请求。

子会话边界（访谈决议）：

- 只有主会话 `useOpenClawChat` 持有 `nextBefore`、`hasOlderHistory`、`loadOlderHistory` 与加载状态。
- `useOpenClawSubagents.loadChildHistory()` 维持一次性读取，忽略 `nextBefore`；mapper 稳定 ID 与 reducer 统一合并改动天然覆盖子会话，不复制旧 mapper/reducer。
- 分页 props 全部可选；`SubagentActivityPanel` 不传即不触发旧页加载。`readOnly` 只表示禁止发送消息，不兼任"禁止加载历史"语义。

### 8. Upward Scroll Loading

`useOpenClawChat()` 对外返回：

```ts
{
  (hasOlderHistory, loadingOlderHistory, olderHistoryError, loadOlderHistory);
}
```

`OpenClawAssistantThread` 新增相应 props（全部可选，`SubagentActivityPanel` 等只读复用不传即不触发）。

Keyed 消息渲染（访谈决议）：

- `ThreadPrimitive.Messages` 以数组下标作 React key；prepend 后各 index 对应的消息整体改变，产生 O(N) 更新，并使 Streamdown、工具卡片、"展开全文"等局部状态附着到错误消息。
- v1 直接改为按稳定 message ID 渲染：feature 内封装 `OpenClawMessageList` 组件，内部使用 `unstable_useThreadMessageIds()` + `ThreadPrimitive.Unstable_MessageById`（assistant-ui 0.14.26 已提供），实验 API 不扩散到 screen 层。
- 不接受 index key、不设历史加载软上限、暂不引入完整虚拟化。
- 虚拟化发布门槛：以 1000 条初始历史 + 连续 prepend 到 3000 条做浏览器性能测试；keyed 版本仍出现明显长任务、滚动掉帧或内存持续超预算时，在同一 `messageIds + MessageById` 抽象上增加可变高度虚拟化。

Viewport 行为：

- `scrollTop <= 120px`、`hasOlderHistory=true`、未加载中时触发一次 `loadOlderHistory()`。
- 请求前记录 `scrollHeight`、`scrollTop`、首个可见消息的 `data-message-id` 及其相对 viewport 顶部的偏移。
- prepend 渲染完成后 `useLayoutEffect` 先执行差值补偿：

```text
nextScrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight)
```

- 随后开启一次性 ResizeObserver 校正窗口：首次内容高度变化（异步图片、高亮、KaTeX、展开）时按 `data-message-id` 重新查询元素，按 viewport 偏移差二次修正一次，随后立即断开 observer。
- 只保存稳定 ID 与偏移，不保存锚点 DOM 节点引用；锚点元素未找到时退回差值补偿结果，不连续追踪。
- 用户在校正前发生滚轮、触摸或指针滚动时取消待执行校正，避免抢夺滚动位置。
- 不采用持续锚定：与 assistant-ui `autoScroll` 内部 ResizeObserver 同时写 `scrollTop` 会形成滚动竞争；图片更晚加载的小幅漂移作为首版已知限制。
- 加载期间在消息列表顶部显示紧凑 loading indicator。
- 加载失败时显示可重试的顶部状态，不清空现有消息。
- `hasOlderHistory=false` 时不反复触发请求，也不需要永久显示“已到顶部”文案。
- 当前 ThreadPrimitive 自动滚底行为继续生效；用户向上滚动后保持暂停状态。

### 9. Provider And Model Display

数据规则：

- provider/model 只对 assistant message 有意义。
- Gateway history sanitizer 必须明确保留 `provider` 和 `model`。
- Gateway `chat final` 已携带完整 assistant message；前端从 terminal event 同步读取 provider/model。
- streaming delta 没有 provider/model 时保持为空，final 或 reconcile 后补齐。
- fallback 后展示最终成功 assistant message 实际记录的 provider/model。

前端改动：

- `ChatMessageItem` 增加 `provider?: string`、`model?: string`。
- `ChatLiveRun` 增加 `provider?: string`、`model?: string`。
- `mapOpenClawHistory()` 从 assistant message 读取 provider/model。
- `CHAT_EVENT` action 在 final/aborted/error 时携带 provider/model。
- `OpenClawAssistantAdapter` 将其放入 `metadata.custom`。
- `AssistantMessage` 在回答底部显示紧凑元数据：

```text
otr · gpt-5.6-sol
```

展示约束：

- 只显示实际存在的字段。
- 使用小号次级文本，不使用卡片。
- 长 provider/model 使用最大宽度、换行或截断，不能挤压回答正文。
- provider 值代表 OpenClaw provider ID；不推断代理背后的真实上游厂商。
- Gateway 注入消息（`provider="openclaw"`、`model="gateway-injected"`）照实显示，不做魔法值隐藏或文案映射。

### 10. Reset Policy

运行配置移除：

```json
{
  "session": {
    "reset": {
      "mode": "weekly",
      "weekday": 1,
      "atHour": 4
    }
  }
}
```

目标配置：

```json
{
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

OpenClaw 当前逻辑会将未显式配置的默认 daily freshness 视为 fresh（`src/config/sessions/reset.ts` 默认 mode=daily 但 `explicit=false`；`src/auto-reply/reply/session.ts` 在 `!explicit && staleReason==="daily"` 时强制 `fresh:true`），因此删除显式 reset 后不会触发自动 daily reset。实现阶段增加回归测试锁定该行为。

删除策略与 Pi 长 transcript 的关系：

- 删除全局 `session.reset` 不以 Pi 长 transcript 优化为前置条件，按计划执行。
- Pi `SessionManager` 上下文构建语义保持不变，不用 WebChat 分页替代。
- 删除后监控 transcript 文件大小、`SessionManager.open()` 与 `buildSessionContext()` 耗时和内存增量。
- 达到阈值后实施 segment rotation 或快照方案；不允许恢复全局 reset。

生产配置命令：

```bash
/home/xiaolu/.local/bin/openclaw config unset session.reset
/home/xiaolu/.local/bin/openclaw config get session
```

执行配置变更和 Gateway 重启需要单独授权。若配置支持热加载，先通过下一条消息和日志验证；只有确认未生效时才申请重启。

## Architecture Changes

### openclaw-integration

- `src/gateway/protocol/schema/logs-chat.ts`
  - `ChatHistoryParamsSchema` 增加可选 `before`。
- `src/gateway/session-history-page.ts`
  - 新增游标编码、文件身份校验、反向分块读取和页结果构建。
- `src/gateway/session-history-page.test.ts`
  - 新增 reader 和 cursor 单元测试。
- `src/gateway/session-utils.fs.ts`
  - 导出 transcript candidate/path 解析所需 helper。
  - 保留现有 title/preview 和其他调用点，不扩大同步读取职责。
- `src/gateway/server-methods/chat.ts`
  - `chat.history` 改用异步 page reader。
  - 将 sanitization/attachment/budget 流程应用到带 offset 的 page records。
  - 返回 `nextBefore`、`hasMore`、`cursorReset`。
  - 明确保留 `historyEntryId`、provider 和 model。
- `src/gateway/server.chat.gateway-server-chat-b.test.ts`
  - 增加分页、provider/model、byte budget 和 cursor reset 集成测试。
- `src/auto-reply/reply/session.test.ts`
  - 增加无显式 reset 时旧 session entry 保持 fresh 的回归测试。
- `src/auto-reply/reply/post-compaction-audit.ts`
  - 改为复用异步反向 reader，只读取最近 100 个原始 record，移除 `readFileSync()` 全量读取；`agent-runner.ts` 调用点同步调整。
  - 增加对应单元测试。
- `dist/protocol.schema.json`
  - 运行 protocol generation 后更新生成产物。

### agent-server

生产代码预计无需修改。

- `app/test/unit_test/services/test_openclaw_bridge_service.py`
  - 验证 `before` 和 `limit` 被透传，真实 Gateway sessionKey 仍由 binding 覆盖。
  - 验证 `nextBefore`、`hasMore`、`cursorReset`、`historyEntryId`、provider/model 在响应翻译后保留。
- `app/test/unit_test/services/test_openclaw_bridge_request_service.py`
  - 验证附件 enrichment 不删除分页字段和 provider/model。
- `app/services/chat_session_import/**`
  - 不修改。

### agent-frontend

- `src/utils/openclawBff/types.ts`
  - 扩展 `OpenClawChatHistoryResponse` 分页字段。
  - 扩展 chat event message 元数据读取类型。
- `src/features/openclaw-bff/types/chat.ts`
  - 增加 page size、provider/model 和 pagination state。
- `src/features/openclaw-bff/api/chat-mappers.ts`
  - 使用 `historyEntryId` 生成稳定 ID；`ChatMessageItem` 增加可选 `historyEntryId` 结构化分组字段。
  - 旧 Gateway 无 `historyEntryId` 时生成 `legacy-${messageIndex}` 单页 fallback。
  - 提取 provider/model。
  - 增加跨页 tool item 合并 helper。
- `src/features/openclaw-bff/state/chat-reducer.ts`
  - 增加 prepend、cursor reset 和统一 reconcile merge action；删除 `isRegressiveHistorySnapshot()`。
  - prepend 时平移 active run history fence。
  - `windowContainsAssistantText()`、`lastAssistantSegmentText()`、`matchRunWindow()` 改为按 `historyEntryId` 结构化分组，删除 `^history-(\d+)-` 正则。
- `src/features/openclaw-bff/hooks/useOpenClawChat.ts`
  - 初次 reconcile 改为最新页请求。
  - 增加 `loadOlderHistory()`。
  - terminal reconcile 合并最新页，不覆盖旧页。
  - 从 final event 提取 provider/model。
- `src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`
  - 把 pagination props 传入 Thread。
- `src/features/openclaw-bff/components/chat/OpenClawMessageList.tsx`
  - 新增 keyed 消息列表封装（`unstable_useThreadMessageIds()` + `ThreadPrimitive.Unstable_MessageById`），替代 `ThreadPrimitive.Messages`。
- `src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
  - 增加顶部滚动触发、加载状态、重试和滚动锚点保持。
  - 增加 assistant provider/model footer。
- 对应 `.test.ts`、`.test.tsx`
  - 增加 mapper、reducer、hook 和组件回归测试。

## Implementation Steps

### Phase 1: Gateway Pagination Contract

1. **扩展 `chat.history` 请求协议**
   - File: `src/gateway/protocol/schema/logs-chat.ts`
   - Action: 增加 `before?: string`，设置合理最大长度，保持 `additionalProperties=false`。
   - Why: 建立向前分页协议，同时保留旧客户端兼容。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

2. **生成并检查协议产物**
   - File: `dist/protocol.schema.json`
   - Action: 运行 `pnpm protocol:gen`，确认只产生预期 schema 变化。
   - Why: 保持 TypeBox 与发布协议一致。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Low.

### Phase 2: Reverse JSONL Reader

1. **实现 versioned cursor codec**
   - File: `src/gateway/session-history-page.ts`
   - Action: 实现 encode/decode、file token、session ID 和 offset 校验。
   - Why: 游标必须跨请求稳定，并能发现文件替换。
   - Dependencies: Phase 1.
   - Complexity: Medium.
   - Risk: Medium.

2. **实现异步反向行读取**
   - File: `src/gateway/session-history-page.ts`
   - Action: 使用文件 handle 和 Buffer 从指定 offset 向前读取完整 JSONL 行。
   - Why: 避免 `readFileSync()` 和全文件扫描。
   - Dependencies: Step 1.
   - Complexity: High.
   - Risk: High; UTF-8、partial line 和大行处理容易产生边界错误。

3. **构建可展示 page records**
   - File: `src/gateway/session-history-page.ts`
   - Action: 解析 message/compaction record，保留 entry ID 和 byte offsets，执行 lookahead。
   - Why: 支持稳定前端 ID、`hasMore` 和无缺口 cursor。
   - Dependencies: Step 2.
   - Complexity: Medium.
   - Risk: Medium.

4. **增加 reader 单元测试**
   - File: `src/gateway/session-history-page.test.ts`
   - Action: 覆盖空文件、多页、中文 chunk 边界、partial line、malformed line、大行、扫描预算 continuation、硬 I/O 错误、compaction、append、stale cursor 和缺外层 `id` 时的 offset 合成 `historyEntryId`。
   - Why: 反向读取属于高风险底层逻辑。
   - Dependencies: Steps 1-3.
   - Complexity: High.
   - Risk: Low.

5. **迁移 post-compaction 审计到异步尾读**
   - Files: `src/auto-reply/reply/post-compaction-audit.ts`、`src/auto-reply/reply/agent-runner.ts`
   - Action: 复用反向 reader 读取最近 100 个 record，替换 `readFileSync()` 全量读取；一并修复 `extractReadPaths()`：工具调用类型按 `transcript-tools.ts` 规则做大小写归一化（`toolCall`/`tool_use`/`tool_call`），参数读取兼容 `arguments` 与 `input`，路径字段兼容 `path`/`file_path`。测试覆盖真实 Pi `toolCall + arguments`、旧格式兼容、非 read 工具与 malformed block。
   - Why: 取消全局 reset 后 transcript 持续增长，审计路径不能保留全量同步读取；且现有 `tool_use + input` 解析与 Pi 实际格式不符，审计从未提取到读路径，迁移时一并修正避免 bug 被固化。
   - Dependencies: Steps 2-3.
   - Complexity: Medium.
   - Risk: Medium.

### Phase 3: Gateway Handler Integration

1. **替换 `chat.history` 全文件读取**
   - File: `src/gateway/server-methods/chat.ts`
   - Action: 调用 async page reader，保留当前 session/model resolution。
   - Why: 把新分页能力接入公开方法。
   - Dependencies: Phase 2.
   - Complexity: Medium.
   - Risk: Medium.

2. **保持 sanitization 与附件契约**
   - File: `src/gateway/server-methods/chat.ts`
   - Action: 对 page records 执行现有附件引用恢复、envelope 清理、directive 清理和 payload 限制。
   - Why: 分页不能回退现有安全和附件能力。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: High; 错误顺序可能泄露路径或丢失附件。

3. **根据实际返回项重算 cursor**
   - File: `src/gateway/server-methods/chat.ts`
   - Action: byte cap 后基于最早保留 record 的 offset 生成 `nextBefore`。
   - Why: 防止响应裁剪造成历史缺口。
   - Dependencies: Step 2.
   - Complexity: Medium.
   - Risk: High.

4. **增加 Gateway 集成测试**
   - File: `src/gateway/server.chat.gateway-server-chat-b.test.ts`
   - Action: 覆盖两页无重叠、无缺口、provider/model 保留、usage 移除、附件 enrichment 前结构、stale cursor 和 6 MiB cap。
   - Why: 锁定端到端协议。
   - Dependencies: Steps 1-3.
   - Complexity: Medium.
   - Risk: Low.

### Phase 4: BFF Compatibility Tests

1. **锁定 history request 透传**
   - File: `agent-server/app/test/unit_test/services/test_openclaw_bridge_service.py`
   - Action: 验证 `before` 和 `limit` 透传，上游 sessionKey 仍由 binding 生成。
   - Why: 防止浏览器绕过 scope，也避免 cursor 被意外丢弃。
   - Dependencies: Phase 1.
   - Complexity: Low.
   - Risk: Low.

2. **锁定分页与 provider response**
   - File: `agent-server/app/test/unit_test/services/test_openclaw_bridge_request_service.py`
   - Action: 验证 history enrichment 和 translation 保留新增字段。
   - Why: agent-server 无需生产改动，但必须有契约证据。
   - Dependencies: Gateway response contract.
   - Complexity: Low.
   - Risk: Low.

### Phase 5: Frontend Pagination State

1. **扩展响应和状态类型**
   - Files:
     - `agent-frontend/src/utils/openclawBff/types.ts`
     - `agent-frontend/src/features/openclaw-bff/types/chat.ts`
   - Action: 增加分页状态、provider/model；保留 `OPENCLAW_CHAT_HISTORY_LIMIT=1000` 作为初始页/对账窗口，新增 `OPENCLAW_CHAT_OLDER_PAGE_LIMIT=100` 用于旧页翻页。
   - Why: 给 hook、reducer 和 UI 建立明确契约。
   - Dependencies: Phase 1.
   - Complexity: Low.
   - Risk: Low.

2. **实现稳定历史 ID 和跨页合并**
   - File: `agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts`
   - Action: 使用 `historyEntryId` 生成稳定 ID（`ChatMessageItem` 增加可选 `historyEntryId` 结构化分组字段），按 toolCallId 合并工具记录；旧 Gateway 无该字段时生成 `legacy-${messageIndex}` 单页 fallback。
   - Why: 消除跨页 key 冲突和 tool call/result 重复；结构化字段供 reducer 分组使用，ID 不再承担分组语义。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: High.

3. **扩展 reducer**
   - File: `agent-frontend/src/features/openclaw-bff/state/chat-reducer.ts`
   - Action: 增加 older page action、统一 reconcile merge（约 20 处触发来源单一合并函数：旧页前缀 + 最新窗口按 `historyEntryId` 尾部对齐，`canCommitHistory=false` 同样保留旧页前缀）、cursor reset 和 history fence 平移；删除 `isRegressiveHistorySnapshot()`；`windowContainsAssistantText()`/`lastAssistantSegmentText()`/`matchRunWindow()` 改为按 `historyEntryId` 结构化分组；最新窗口与已加载历史无重叠时走 `HISTORY_CURSOR_RESET` 清空路径。
   - Why: 现有提交分支整窗替换 `historyBase`，且 run 落点匹配依赖 `^history-(\d+)-` ID 正则，均与分页 prepend 直接冲突。
   - Dependencies: Step 2.
   - Complexity: High.
   - Risk: High; 会影响 run reconcile 和 optimistic user 去重。
   - Tests: hex/非数字 `historyEntryId` 的多 block assistant 消息正确分组；相同文本但不同 `historyEntryId` 不误合并；terminal reconcile 后 optimistic user 消失且 assistant 不重复；旧 Gateway 无 `historyEntryId` 时单页 reconcile 兼容；`canCommitHistory=false` 时旧页前缀保留；两窗口无重叠时清空旧页并采用最新 cursor；较旧 `reconcileSeq` 到达时不修改历史与 cursor；子会话重复 reconcile 不重复、不丢消息。

4. **实现 hook 分页请求**
   - File: `agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.ts`
   - Action: 增加 `loadOlderHistory()`、请求互斥、generation guard 和错误恢复。
   - Why: 管理 cursor 生命周期与并发。
   - Dependencies: Step 3.
   - Complexity: High.
   - Risk: High.

5. **统一 reconcile 触发路径**
   - File: `agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.ts`
   - Action: 约 20 处 `performHistoryReconcile()` 触发点（terminal、可见性恢复、seq gap、steer、abort、degraded 恢复等）全部走统一合并语义（旧页前缀 + 最新窗口尾部对齐），保留 history confirmation 与 `reconcileSeq`；旧 Gateway 单页兼容。
   - Why: 发送消息、断线恢复、可见性恢复、steer、abort 和 foreign run 都依赖 reconcile，任一触发点整窗替换都会丢弃已加载旧页。
   - Dependencies: Step 4.
   - Complexity: High.
   - Risk: High.

### Phase 6: Upward Scroll UX

1. **传递 pagination controls**
   - Files:
     - `agent-frontend/src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`
     - `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
   - Action: 传递 hasMore/loading/error/loadOlder props（全部可选，只读复用方不传即不触发）。
   - Why: 保持数据逻辑在 hook，滚动行为在组件。
   - Dependencies: Phase 5.
   - Complexity: Low.
   - Risk: Low.

2. **实现 keyed 消息渲染**
   - File: `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawMessageList.tsx`
   - Action: 封装 `unstable_useThreadMessageIds()` + `ThreadPrimitive.Unstable_MessageById` 的消息列表，替代 `ThreadPrimitive.Messages`；prepend 保留已有消息的组件与 DOM 身份。
   - Why: 消除 index key 导致的 O(N) 更新与局部状态错位，为后续虚拟化留抽象。
   - Dependencies: Phase 5.
   - Complexity: Medium.
   - Risk: Medium; 依赖 assistant-ui 实验 API，锁定 0.14.26 并集中在单组件内，必要时可退回 `ThreadPrimitive.Messages`。

3. **实现顶部阈值加载**
   - File: `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
   - Action: 监听 viewport scroll，接近顶部时触发单次加载。
   - Why: 完成自然的历史浏览流程。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium.

4. **保持滚动锚点**
   - File: `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
   - Action: prepend 前 `useLayoutEffect` 差值补偿 + 一次性 ResizeObserver 二次校正（按 `data-message-id` 重查、用户滚动取消、锚点缺失退回差值），不持续锚定。
   - Why: 避免加载历史后页面跳动，并覆盖图片/高亮/KaTeX 的异步高度变化。
   - Dependencies: Steps 2-3.
   - Complexity: High.
   - Risk: High; 与 ThreadPrimitive autoScroll/ResizeObserver 存在交互，须避免持续锚定竞争。

5. **增加组件测试**
   - File: `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx`
   - Action: 覆盖阈值触发、请求互斥、首次差值补偿、异步增高二次校正、用户滚动取消、锚点缺失回退、失败重试、到顶停止和 keyed 渲染局部状态保持。
   - Why: 滚动行为依赖 DOM 时序；复用现有 `TestResizeObserver`/`notifyResizeObservers()` 设施。
   - Dependencies: Steps 2-4.
   - Complexity: Medium.
   - Risk: Low.

### Phase 7: Provider/Model Display

1. **映射历史 provider/model**
   - File: `agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts`
   - Action: 从 assistant message 提取 provider/model。
   - Why: 历史页需要显示实际模型来源。
   - Dependencies: Phase 5.
   - Complexity: Low.
   - Risk: Low.

2. **映射实时 terminal provider/model**
   - Files:
     - `agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.ts`
     - `agent-frontend/src/features/openclaw-bff/state/chat-reducer.ts`
   - Action: 从 final message 提取字段并写入 live run。
   - Why: 用户无需等待下一次 history reconcile 才看到 provider。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium.

3. **渲染 assistant footer**
   - Files:
     - `agent-frontend/src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.ts`
     - `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
   - Action: metadata 透传并显示 `provider · model`。
   - Why: 把记录字段转化为用户可见信息。
   - Dependencies: Steps 1-2.
   - Complexity: Low.
   - Risk: Low.

4. **增加 mapper/reducer/UI 测试**
   - Files:
     - `agent-frontend/src/features/openclaw-bff/adapters/OpenClawAssistantAdapter.test.ts`
     - `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx`
     - 对应 reducer/hook tests
   - Action: 覆盖历史、实时、fallback 后 provider 切换和字段缺失。
   - Why: provider 必须按消息展示，不能错误继承会话默认值。
   - Dependencies: Steps 1-3.
   - Complexity: Medium.
   - Risk: Low.

### Phase 8: Reset Policy And Rollout

1. **增加无显式 reset 回归测试**
   - File: `src/auto-reply/reply/session.test.ts`
   - Action: 构造跨默认 daily 边界的旧 entry，确认未显式配置 reset 时复用原 session ID。
   - Why: 删除配置前锁定实际语义。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

2. **移除生产全局 reset**
   - Runtime config: `/home/xiaolu/.openclaw/openclaw.json`
   - Action: 经授权执行 `openclaw config unset session.reset`。
   - Why: 停止所有渠道 weekly 自动切换。
   - Dependencies: Step 1; 建议在分页发布前或同一变更窗口执行。
   - Complexity: Low.
   - Risk: Medium; 长期 transcript 开始持续增长。

3. **灰度验证**
   - Action:
     - 创建超过两页的测试会话。
     - 刷新 WebChat，确认只加载最新页。
     - 向上滚动加载旧页。
     - 发送新消息，确认旧页保留。
     - 触发一次自动 compaction，确认页面历史仍完整，模型上下文已压缩。
     - 确认飞书消息不再 weekly reset。
   - Why: 同时验证运行时配置和跨仓库协议。
   - Dependencies: All implementation phases.
   - Complexity: Medium.
   - Risk: Medium.

## Testing Strategy

### openclaw-integration Focused Tests

```bash
pnpm vitest run \
  src/gateway/session-history-page.test.ts \
  src/gateway/server.chat.gateway-server-chat-b.test.ts \
  src/auto-reply/reply/session.test.ts \
  src/auto-reply/reply/post-compaction-audit.test.ts
```

补充验证：

```bash
pnpm protocol:check
pnpm typecheck
```

不运行 `make test`。构建部署前只有在用户明确要求时运行 `make build`。

### agent-server Focused Tests

```bash
uv run python -m pytest \
  app/test/unit_test/services/test_openclaw_bridge_service.py \
  app/test/unit_test/services/test_openclaw_bridge_request_service.py
```

### agent-frontend Focused Tests

```bash
npm run test:components -- \
  src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx

npm run test:unit
npm run type-check
```

实现阶段根据现有 Vitest 配置补充 mapper、reducer 和 hook 的精确命令。

### E2E Scenarios

1. 1200 条 transcript，首次只返回最新 1000 条。
2. 连续翻页直到第一条，消息无重复、无缺口、顺序稳定。
3. 中文和 emoji 正好跨 64 KiB chunk 边界。
4. toolCall 位于旧页，toolResult 位于新页，页面只显示一个完整工具项。
5. 已加载三页后发送新消息，旧页不丢失，terminal reconcile 正常。
6. 加载旧页时切换会话，旧请求结果不污染新会话。
7. 加载旧页时 transcript 追加消息，cursor 继续有效。
8. 手动 `/new` 后使用旧 cursor，Gateway 返回 `cursorReset=true`，页面只显示新活跃 transcript。
9. assistant 历史和实时 final 均显示 provider/model。
10. 自动 compaction 后旧消息仍可分页回放，模型下一轮使用 compacted context。
11. oversized message 返回 placeholder，后续页仍可继续加载。
12. 附件历史仍显示文件引用，不泄露 workspace 绝对路径。
13. terminal reconcile 最新窗口与已加载历史完全无重叠时，前端清空旧页并采用最新窗口，无缺口展示、无死循环。
14. prepend 后已加载消息的"展开全文"折叠等局部状态不错位（keyed 渲染）。
15. 1000 条初始 + 连续 prepend 到 3000 条的浏览器性能基线（长任务、掉帧、内存），作为虚拟化门槛数据。
16. 子会话历史面板在 run 进行中与终态重复 reconcile，消息不重复、不丢失。

## Risks And Mitigations

- **反向读取出现 UTF-8 或换行边界错误**
  - Mitigation: 全程以 Buffer 查找 newline，完整行后再 decode；增加中文、emoji 和 CRLF 测试。

- **响应体积裁剪造成历史缺口**
  - Mitigation: budget 处理前保留 source offsets，基于最早实际返回消息重新生成 cursor。

- **跨页消息 ID 冲突**
  - Mitigation: Gateway 返回 transcript `historyEntryId`，前端禁止仅依赖 page index。

- **toolCall 与 toolResult 跨页重复**
  - Mitigation: tool item 使用 toolCallId 身份，并在 prepend merge 时合并 call/result。

- **prepend 破坏 active run reconcile**
  - Mitigation: 所有 live run 的 history fence 随 prepend 数量平移；run 落点匹配（`windowContainsAssistantText`/`lastAssistantSegmentText`/`matchRunWindow`）改为按 `historyEntryId` 结构化分组；增加发送中加载旧页测试。

- **reconcile 覆盖旧历史**
  - Mitigation: 全部约 20 处触发来源统一走"旧页前缀 + 最新窗口尾部对齐"单一合并路径，不再把响应视为完整 transcript snapshot。

- **顶部滚动触发请求风暴**
  - Mitigation: loading mutex、cursor 去重、generation guard 和顶部阈值迟滞。

- **滚动锚点与 autoScroll 冲突**
  - Mitigation: 一次性 ResizeObserver 校正窗口 + 用户滚动取消 + 差值补偿兜底，不持续锚定；复用现有 ResizeObserver 测试设施。

- **DOM 随已加载历史无上限增长**
  - Mitigation: keyed 渲染消除 index key 的 O(N) 更新与局部状态错位；单消息成本已有 12,000 字符折叠与 128 KiB placeholder 限制；以 1000→3000 条浏览器性能测试作为虚拟化门槛，必要时在同一 `messageIds + MessageById` 抽象上增加可变高度虚拟化。

- **依赖 assistant-ui 实验 API（unstable_useThreadMessageIds/Unstable_MessageById）**
  - Mitigation: 封装在 `OpenClawMessageList` 单点、锁定 0.14.26、组件回归测试覆盖；必要时可退回 `ThreadPrimitive.Messages`。

- **cursor 在文件替换后读取错误区间**
  - Mitigation: cursor 绑定 session ID 和 file token；stale cursor 返回最新页并明确 `cursorReset`。

- **长期不 reset 导致 JSONL 持续增长**
  - Mitigation: 本方案把 WebChat 读取成本改为按页，post-compaction 审计改为异步尾读；`sessions.preview` 已是有界尾读（≤1 MiB），仅增加同步阻塞观测指标。删除 reset 后监控 transcript 文件大小、`SessionManager.open()`/`buildSessionContext()` 耗时与内存增量；达到阈值实施对 UI 透明的 segment rotation 或快照方案，不回退全局 reset。

- **provider 展示与实际上游厂商认知不一致**
  - Mitigation: UI 原样显示 OpenClaw provider ID 和 model，不推断代理后的 upstream vendor。

- **旧 Gateway 与新前端发布顺序错误**
  - Mitigation: 先发布 Gateway，再发布 agent-frontend；前端对缺少分页字段保留单页兼容。

## Observability

Gateway 增加 debug/metric 字段：

```text
chat.history page_records
chat.history scanned_bytes
chat.history read_chunks
chat.history cursor_reset
chat.history malformed_lines
chat.history oversized_placeholders
chat.history response_bytes
chat.history duration_ms
sessions.preview read_duration_ms
transcript_file_size_bytes
session_manager open_duration_ms / build_context_duration_ms
```

日志不得记录：

- transcript 真实路径。
- cursor 完整值。
- session key、namespace 或 principal ID。
- 消息正文、provider 凭据或附件私有引用。

前端可记录不含身份信息的行为指标：

```text
history_initial_load_ms
history_older_page_load_ms
history_older_page_error
history_cursor_reset
history_loaded_item_count
```

## Rollout Order

1. 合入 Gateway protocol 和 reverse reader。
2. 发布 Gateway，保持旧 WebChat 继续使用单页调用。
3. 合入 agent-server 契约测试，确认无需生产代码修改。
4. 合入 agent-frontend 分页状态和滚动加载。
5. 发布 agent-frontend。
6. 经授权删除全局 `session.reset`。
7. 观察历史读取耗时、cursor reset、Gateway event-loop 延迟和 JSONL 文件增长。
8. 确认稳定后，评估把 WebChat 初始页/对账窗口从 1000 降到 100（旧页翻页自上线起即为 100）。

## Success Criteria

- [ ] `session.reset` 已从生产配置删除，所有渠道不再自动 weekly reset。
- [ ] 不传 `before` 的旧 `chat.history` 调用保持兼容。
- [ ] 新 WebChat 首次请求最新 1000 条窗口，向上翻页每页 100 条。
- [ ] 用户可持续向上滚动直至当前活跃 JSONL 第一条可展示消息。
- [ ] 每页消息无重复、无缺口、顺序正确。
- [ ] Gateway 历史读取不再使用 `fs.readFileSync()` 读取完整 transcript。
- [ ] prepend 后页面视觉位置保持稳定。
- [ ] 已加载旧页不会被任何 reconcile 触发（terminal、可见性恢复、seq gap、steer、abort、degraded 恢复）清除。
- [ ] prepend 后已加载消息的局部状态（"展开全文"折叠等）不错位（keyed 渲染）。
- [ ] 子会话历史与重复 reconcile 无重复、无丢失。
- [ ] 非 v3 transcript 不分页，安全回到最新页（cursorReset）。
- [ ] post-compaction 审计能提取真实 `toolCall` 格式的读路径。
- [ ] compaction 前消息继续完整回放。
- [ ] 每条 assistant 历史和实时 final 可显示其 provider/model。
- [ ] provider/model 缺失时 UI 正常，不显示空占位。
- [ ] toolCall/toolResult 跨页时只显示一个合并工具项。
- [ ] stale cursor 不读取旧 reset 文件，并能安全回到当前 transcript 最新页。
- [ ] reconcile 最新窗口与已加载历史无重叠时，前端按游标重置路径清空收敛。
- [ ] post-compaction 审计不再同步全量读取 transcript。
- [ ] 附件历史脱敏和下载能力无回归。
- [ ] agent-server 每日 chat session import 无代码和表结构变化。
- [ ] 未引入 PostgreSQL 聊天消息存储。
