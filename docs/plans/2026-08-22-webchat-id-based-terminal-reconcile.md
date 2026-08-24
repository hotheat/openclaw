# Implementation Plan: WebChat 终态对账改为按消息 id

## Overview

把业务前端"run 结束后实时草稿何时切换为 `chat.history` 正式内容"的判定，从"最后一段实时文本 == 某条历史 assistant 文本"改为"final 事件携带的持久化消息 id 出现在历史里"。`chat.history` 已经通过 `historyEntryId` 暴露转录条目 id（PR #127），本计划补齐另外两半：Gateway 只在能够证明当前 leaf 就是本次最后 assistant 时，在 lifecycle `end` 和 chat `final` 上携带该 id；前端优先按 id 对账，id 缺失时退回现有文本对账。不做 `session.message` 推送，不改 agent-server。

本计划是 PR #136 / agent-frontend #69（路线 A+）的增量，落在同一对 PR 分支上。

## Requirements

- 可见文本 `chat` `final` 事件在能够证明 leaf 属于本次最后 assistant 时携带 `messageId`，它等于该消息在转录中的条目 id，与 `chat.history` 同一条消息的 `historyEntryId` 严格相等。
- 前端收到带 `messageId` 的 final 后，历史窗口中出现 `historyEntryId === messageId` 的 message 条目即 `historyConfirmed = true`；不依赖前端投影后的 role，也不再比较文本。
- 工具后 final 的顺序约束保留：该 id 条目必须位于 run 内最后一个已确认工具记录之后。
- `messageId` 缺失（旧 Gateway、completion-contract 路径、leaf 无法证明属于本次最后 assistant、不可见空 final、abort/error 终态）时，行为与当前 A+ 完全一致。
- `messageId` 存在但历史未命中时禁止回退文本；重试耗尽后保留 live overlay、展示既有恢复提示并记录可区分的诊断信息。
- 新字段只增不改：旧前端、Control UI、agent-server 收到 `messageId` 必须忽略而不是拒绝。
- 两个仓库可以任意顺序发布，任一侧未升级时退回文本对账。

## Constraints

- 不新增 Gateway 方法或事件类型；不做 `session.message` 推送。
- agent-server 零改动（验证透传即可）。
- 不修改 `chat.history` 响应结构（`historyEntryId` 已存在）。
- 不运行 `make build` / `make test` / Gateway 重启；只跑触及文件的聚焦测试、typecheck、lint。
- 文档和代码使用仓库相对路径。

## Ownership Map

- Executor: Codex
  - `[openclaw-integration] src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`
  - `[openclaw-integration] src/agents/pi-embedded-runner/run.ts`
  - `[openclaw-integration] src/agents/pi-embedded-subscribe.handlers.lifecycle.test.ts`
  - `[openclaw-integration] src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts`
  - `[openclaw-integration] src/gateway/server-chat.ts`
  - `[openclaw-integration] src/gateway/server-chat.agent-events.test.ts`
  - `[openclaw-integration] src/gateway/protocol/schema/logs-chat.ts`
  - `[openclaw-integration] src/gateway/protocol/index.test.ts`
  - `[openclaw-integration] dist/protocol.schema.json`（生成）
  - `[openclaw-integration] apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`（生成）
  - `[openclaw-integration] apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`（生成）
  - `[openclaw-integration] docs/plans/2026-08-20-webchat-streaming-consistency-and-tool-density.md`
  - `[openclaw-integration] docs/plans/2026-08-22-webchat-id-based-terminal-reconcile.md`
  - `[agent-frontend] src/utils/openclawBff/types.ts`
  - `[agent-frontend] src/features/openclaw-bff/types/chat.ts`
  - `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.ts`
  - `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.ts`
  - `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.test.ts`
  - `[agent-frontend] tests/openclaw-chat-reducer.test.ts`
  - `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx`
- `agent-server` is read-only verification scope. No path is assigned for modification.
- Existing changes under `[agent-frontend] packages/client-collections` and `.claude/` are user-owned and excluded from staging.

## Current State（调研结论）

- 转录每条消息自带稳定 id：`node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js` `appendMessage()` 生成 `entry.id` 并写入 JSONL 行。
- `src/gateway/session-history-page.ts` `resolveHistoryEntryId()`：有 `record.id` 用它，否则 `off-<startOffset>`；`attachHistoryEntryId()` 把它放到消息顶层 `historyEntryId`。`ChatHistoryMessageSchema` 已要求该字段。
- pi 持久化时序：`agent-session.js` 在 `message_end` 的 extension 与 listener 之后调用 `sessionManager.appendMessage()`；`pi-agent-core` 同步调用 listener 且不等待 async handler。正常路径通常先 append 再处理 `agent_end`，但慢 extension 会打破该顺序。因此 `getLeafEntry()` 只能作为候选，必须同时验证 `leaf.message === ctx.state.lastAssistant`，无法证明时缺省 id。
- `src/gateway/server-chat.ts` `emitChatFinal()` 目前只从 `chatRunState.buffers` 取文本，不知道 id。
- agent-frontend：`src/features/openclaw-bff/api/chat-mappers.ts` 已按 `historyEntryId` 生成 `history-<id>` 条目并设置 `ChatHistoryItem.historyEntryId`；`src/features/openclaw-bff/state/chat-reducer.ts` `matchRunWindow()` 的 `assistantCheck` 仍走 `lastAssistantMessageMatches()` 文本比较。
- agent-server：`openclaw_protocol_translator.py` 对 `chat.history` 只剥 `__openclaw`；事件 payload `SessionScopedEventPayload` 为 `extra='allow'`，`_translate_value` 原样保留未知键。

## Architecture Changes

- `[openclaw-integration] src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`：lifecycle `end` 事件 `data` 新增可选 `assistantMessageId`。
- `[openclaw-integration] src/gateway/server-chat.ts`：`emitChatFinal()` 接收并在 `final` payload 顶层输出可选 `messageId`。
- `[openclaw-integration] src/gateway/protocol/schema/logs-chat.ts`（若存在 chat 事件 payload schema）：`messageId` 可选字段；否则只更新 `docs/` 协议说明。
- `[agent-frontend] src/utils/openclawBff/types.ts`：`OpenClawChatEventPayload.messageId?: string`。
- `[agent-frontend] src/features/openclaw-bff/types/chat.ts`：`ChatLiveRun.terminalMessageId?: string`；`CHAT_EVENT` action 增加 `messageId?`。
- `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.ts`：终态 dispatch 透传 `payload.messageId`。
- `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.ts`：`applyChatEvent` 记录 `terminalMessageId`；`matchRunWindow` 新增 id 路径，文本路径降级为 fallback。

## Data Flow

```text
pi message_end → sessionManager.appendMessage(entry.id)
    → pi agent_end
    → subscribe lifecycle handler: leaf = getLeafEntry()
        leaf.type === "message"
        && leaf.message.role === "assistant"
        && leaf.message === ctx.state.lastAssistant
        → emitAgentEvent(lifecycle end, data.assistantMessageId = leaf.id)
    → Gateway handler: emitChatFinal(..., assistantMessageId)
        → chat final payload { ..., messageId }
    → agent-server 透传
    → 前端 CHAT_EVENT(final, messageId) → run.terminalMessageId
    → HISTORY_RECONCILED: window 内存在 message item.historyEntryId === terminalMessageId
        且位于最后已确认工具之后 → historyConfirmed = true
    → 无 terminalMessageId 或历史无稳定 id → 现有文本路径
```

## Implementation Steps

### Phase 1: Gateway 产出 messageId

1. **lifecycle end 携带 assistantMessageId**（File: `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`）
   - Action:
     - 在 `agent_end` 非 error 分支、`emitAgentEvent({ stream: "lifecycle", data: { phase: "end", ... } })` 之前，读取 `ctx.params.session.sessionManager.getLeafEntry()`。
     - 同时读取 `ctx.state.lastAssistant`；仅当 `leaf?.type === "message"`、`leaf.message.role === "assistant"`、`leaf.message === lastAssistant`、assistant 非 error/aborted 且 `typeof leaf.id === "string"` 时，把 `assistantMessageId: leaf.id` 放进 `data`。
     - `emitAgentEvent` 与 `onAgentEvent` 两条 lifecycle end 输出使用同一份 data，避免不同消费者看到不一致合同。
     - 整段用 `try/catch` 包住，任何异常只记 debug 日志，不影响 lifecycle 事件发出。
     - error 分支不加（无 assistant 成功消息）。
   - Why: 这是唯一既能拿到落盘 id、又不需要再读文件的位置；对象身份校验阻止慢 extension 或并发 append 让较早 assistant id 冒充本次 final。
   - Dependencies: None.
   - Risk: Low。`AgentSession.sessionManager` 是公开字段；`getLeafEntry()` 是同步内存读取。

2. **completion-contract 路径显式不带 id**（File: `src/agents/pi-embedded-runner/run.ts`）
   - Action: `withCompletionContractTerminal()` 生成的 lifecycle `end` 保持现状，不加 `assistantMessageId`；在该函数注释标明"id 缺失 → 前端退回文本对账"。
   - Why: 该路径的终态不对应一条 assistant 转录消息。
   - Dependencies: Step 1.
   - Risk: Low.

3. **Gateway final 输出 messageId**（File: `src/gateway/server-chat.ts`）
   - Action:
     - 事件处理器在 `lifecyclePhase === "end"` 分支读取 `typeof evt.data?.assistantMessageId === "string" ? evt.data.assistantMessageId : undefined`，作为新参数传给 `emitChatFinal()`。
     - `emitChatFinal()` 只在 `jobState === "done"`、存在可见 `text`、`shouldSuppressSilent === false` 且存在 `assistantMessageId` 时追加 `messageId`。
     - silent reply、heartbeat 和不可见空 final 不带 `messageId`，避免要求前端匹配一个 mapper 不会产出的空消息条目。
     - error / aborted payload 不变。
   - Why: final 是前端唯一会做严格对账的终态。
   - Dependencies: Step 1.
   - Risk: Low。新增顶层可选字段，旧消费者忽略。

4. **协议 schema 与文档**（Files: `src/gateway/protocol/schema/logs-chat.ts`、`src/gateway/protocol/index.test.ts`、`docs/` 对应协议页）
   - Action:
     - 若仓库有 chat 事件 payload 的 TypeBox schema，给 final 形态加 `messageId: Type.Optional(NonEmptyString)`；`index.test.ts` 的 final 样例加该字段。
     - 若 chat 事件 payload 未建模，只在协议文档的 `chat` 事件说明中补一句："`final` 可携带 `messageId`，与 `chat.history` 的 `historyEntryId` 相等。"
   - Dependencies: Step 3.
   - Risk: Low.

5. **Gateway 测试**（Files: `src/agents/pi-embedded-subscribe.handlers.lifecycle.test.ts`、`src/gateway/server-chat.agent-events.test.ts`）
   - Action:
     - lifecycle：leaf.message 与 `lastAssistant` 是同一对象 → 两条 lifecycle 输出的 `assistantMessageId` 等于 leaf id；leaf 是内容相同但对象不同的较早 assistant、toolResult / user / compaction → 字段缺失；`getLeafEntry` 抛错 → 字段缺失且事件仍发出。
     - subscribe 集成：通过真实 `AgentSession` 或等价生产时序覆盖慢 `message_end` extension，证明无法确认落盘时只缺省 id，不会发出较早 assistant id。
     - server-chat：可见 final 且 lifecycle end 带 `assistantMessageId` → final payload 顶层有 `messageId`；不带、空文本、silent reply、error → 无该键；boundary delta 不含该键。
   - Dependencies: Steps 1–3.
   - Risk: Low.

### Phase 2: 前端按 id 对账

6. **类型与动作**（Files: `src/utils/openclawBff/types.ts`、`src/features/openclaw-bff/types/chat.ts`）
   - Action:
     - `OpenClawChatEventPayload` 增加 `messageId?: string`。
     - `ChatLiveRun` 增加 `terminalMessageId?: string`（注释：来自 final 的持久化消息 id，仅 final 设置）。
     - `CHAT_EVENT` action 增加 `messageId?: string`。
   - Dependencies: None.
   - Risk: Low.

7. **Hook 透传**（File: `src/features/openclaw-bff/hooks/useOpenClawChat.ts`）
   - Action: 非 delta 分支的 `dispatch({ type: 'CHAT_EVENT', ... })` 增加 `messageId: typeof payload.messageId === 'string' && payload.messageId ? payload.messageId : undefined`。
   - Dependencies: Step 6.
   - Risk: Low.

8. **reducer 记录 terminalMessageId**（File: `src/features/openclaw-bff/state/chat-reducer.ts` `applyChatEvent`）
   - Action:
     - 终态分支：`action.state === 'final' && action.messageId` 时写入 `terminalMessageId`；aborted / error 不写。
     - `canEnrichTerminal` 路径（同 state 更大 seq 补全）把判定显式改为 `Boolean(action.text || action.messageId)`；若只带 `messageId` 也允许补写 `terminalMessageId`，且不得重复追加 assistant 文本。
   - Dependencies: Step 6.
   - Risk: Low.

9. **matchRunWindow 的 id 路径**（File: `src/features/openclaw-bff/state/chat-reducer.ts`）
   - Action:
     - 在现有 `assistantCheck` 计算前加分支：
       ```
       const idCandidate = run.terminalState === 'final' && run.terminalMessageId
         ? findHistoryMessageIndexById(windowItems, run.terminalMessageId)
         : -1
       if (idCandidate >= 0) {
         assistantCheck = !finalAssistantFollowsTools(run)
           || idCandidate > lastRequiredToolIndex(windowItems, toolCallIds)
       } else { /* 现有 lastAssistantMessageMatches 文本路径 */ }
       ```
     - id helper：在 `windowItems` 中找 `kind === 'message' && historyEntryId === id` 的最后一个索引；不检查投影后的 role，允许同一消息拆块和 response-budget oversized assistant 映射成 system placeholder 后仍按原 id 确认。
     - 把 `lastAssistantMessageMatches` 内"最后工具索引"的计算抽成 `lastRequiredToolIndex()` 供两条路径共用。
     - `terminalMessageId` 存在但窗口里找不到该 id → `assistantCheck = false`（继续等历史追上），**不**退回文本路径；只有 `terminalMessageId` 缺失才走文本路径。
   - Why: id 存在却匹配不到，说明历史还没写到或 run 窗口定位错误，文本匹配在这种情况下只会制造误判。
   - Dependencies: Steps 6–8.
   - Risk: Medium。要确认 `windowItems` 切片（`lastUserIndex + 1 .. windowEnd`）包含 final 那条消息；多 user 消息（steer）场景沿用现有切片。

10. **`lastAssistantSegmentText` 的同步**（File: `src/features/openclaw-bff/state/chat-reducer.ts` 约 1285 行）
    - Action: 该函数按 `historyMessageGroupKey` 合成文本供"无 final 文本时"的身份检查；id 路径生效时不需要改它，但在注释中标明它只服务文本 fallback。
    - Dependencies: Step 9.
    - Risk: Low.

11. **前端测试**（Files: `src/features/openclaw-bff/state/chat-reducer.test.ts`、`tests/openclaw-chat-reducer.test.ts`、`src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx`）
    - Action:
      - id 命中：`A → tool → B → final(messageId=m2)` + history `[user, assistant(A+toolCall, id=m1), toolResult, assistant(B, id=m2)]` → `historyConfirmed = true`，liveRuns 清空。
      - id 命中但文本不同：final 文本被 history 投影截断/归一化（如 history 文本多一个尾随换行）→ 仍 `historyConfirmed = true`（证明不再依赖文本）。
      - id 未命中：history 尚无 m2 → `historyConfirmed = false`；下次 reconcile 带 m2 → true。
      - id 在工具之前：m2 条目索引小于最后工具索引 → false。
      - 无 messageId：与现有文本路径测试结果一致（复用现有用例，断言不变）。
    - 历史无稳定 id（`hasStableHistoryIds = false`，legacy ids）但 final 带 messageId → 找不到 → false。
    - 同 id 的 assistant 被 mapper 投影成 system oversized placeholder → 仍命中。
    - 原始超大 JSONL 行只能产生 `off-<offset>`，与 final 的真实 id 不同 → 保持 false，重试耗尽后保留 live overlay 和既有恢复提示。
    - hook：final payload 的 `messageId` 进入 `liveRuns[runId].terminalMessageId`。
    - Dependencies: Steps 6–9.
    - Risk: Low.

### Phase 3: 跨仓验证与文档

12. **agent-server 透传验证（不改代码）**
    - Action: 只读检查 `SessionScopedEventPayload(extra='allow')`、`model_dump(exclude_unset=True)` 和 `_translate_value`，记录 final 事件未知顶层键会原样保留。若缺少长期 contract test，作为 agent-server 后续任务记录，不在本对 PR 中产生第三仓改动。
    - Dependencies: Step 3.
    - Risk: Low.

13. **聚焦验证**
    - `[openclaw-integration]`：`pnpm vitest run src/gateway/server-chat.agent-events.test.ts src/agents/pi-embedded-subscribe.handlers.lifecycle.test.ts src/gateway/protocol/index.test.ts`；typecheck；oxlint / oxfmt。
    - `[agent-frontend]`：`npx vitest run src/features/openclaw-bff/state/chat-reducer.test.ts src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx --config vitest.components.config.ts`；`node --test tests/openclaw-chat-reducer.test.ts`（或仓库既定入口）；`npm run type-check`；Biome。
    - 不运行 `make build` / `make test` / Gateway 重启。
    - Dependencies: Phases 1–2.

14. **更新主计划文档**（File: `docs/plans/2026-08-20-webchat-streaming-consistency-and-tool-density.md`）
    - Action:
      - Overview 新增第 6 条："终态对账优先按 final `messageId` 与 `chat.history` `historyEntryId` 匹配，文本相等降级为 fallback。"
      - Data Flow 末行改为"terminal 后按 messageId 确认历史已写入，无 id 时按文本"。
      - Success Criteria 增加：`[ ] final 携带 messageId 且等于 history 的 historyEntryId`、`[ ] 文本不等但 id 相等时 run 仍能 commit`。
      - Review Amendments 记录：本次事故根因是文本相等对账，id 对账作为根治；`session.message` 推送列为后续可选项。
    - Dependencies: Phase 3 测试通过。

15. **PR 描述**
    - PR #136 标题改为 `feat(gateway): carry persisted assistant messageId on chat final`（或合并进现有 fix 标题），按模板填写目的/现象/思路/实现，修复 `Validate PR description` 失败。agent-frontend #69 同样补齐。

## Testing Strategy

- Unit（Gateway）：lifecycle handler 的 leaf 判定三态；server-chat final payload 形态；schema 样例。
- Unit（前端）：reducer id 命中/未命中/顺序/fallback 五类；mapper 现有 `historyEntryId` 用例不变。
- Integration（前端 hook）：final → `terminalMessageId` → 首次 reconcile 即 commit，不触发 `HISTORY_RECONCILE_EXHAUSTED`。
- Contract（agent-server）：事件未知键透传。
- 手工：部署后观察一次"工具前后都有文本"的 run，确认 final 帧含 `messageId`，业务前端在第一次 `chat.history` 后覆盖层消失；刷新后顺序一致。

## Risks & Mitigations

- **Risk**: `getLeafEntry()` 在 `agent_end` 时不是 assistant 消息（run 以工具错误结束、compaction 紧随其后、enforceFinalTag 重试）。
  - Mitigation: 只有 leaf 是 assistant 且 `leaf.message === ctx.state.lastAssistant` 时附带 id；否则前端走文本 fallback，行为不劣于现状。
- **Risk**: pi-agent-core 不等待 async `AgentSession` listener，慢 `message_end` extension 使 `agent_end` 早于本次 assistant append 完成。
  - Mitigation: 对象身份校验防止较早 id 冒充；生产形态集成测试锁定"无法证明则缺省 id"。
- **Risk**: final 先于转录落盘到达前端（理论上 pi 在 `agent_end` 前已 append，但未来 runner 改动可能打破）。
  - Mitigation: id 未命中只是"继续等"，不会误判；现有重试上限保留，超限仍进入 `historyReconcileExhausted`。
- **Risk**: `chat.history` 对该消息做了 oversized 占位（`off-` id + 占位文本）。
  - Mitigation: response-budget 占位保留真实 id，前端按 id 匹配且不检查投影 role；原始超大 JSONL 行只能产生 `off-` id，属于既有有界扫描限制，重试耗尽后保留 live overlay 和恢复提示。
- **Risk**: steer 场景 run 窗口切片（`lastUserIndex + 1 .. windowEnd`）漏掉 final 消息。
  - Mitigation: id 查找在同一切片上进行，与文本路径一致；补一条 steer + id 的 reducer 测试。
- **Risk**: 前端先于 Gateway 发布，或反之。
  - Mitigation: 两边都对缺失字段容错，任意顺序安全；已在 Requirements 写明。
- **Risk**: 把 id 路径和文本路径混用导致"id 不命中时偷偷用文本匹配"，重新引入脆弱性。
  - Mitigation: Step 9 明确规定 id 存在但未命中时不退回文本路径；用测试锁定。

## Success Criteria

- [x] Gateway lifecycle `end` 只在 leaf 可证明是本次 `lastAssistant` 时携带 `assistantMessageId`，无法证明时不携带错误 id。
- [x] 可见 chat `final` payload 顶层携带 `messageId`，与 `chat.history` 同条消息的 `historyEntryId` 相等；空/silent final 不携带。
- [x] 前端 final 带 `messageId` 时，历史出现该 id 即 `historyConfirmed = true`，文本差异不影响结果。
- [x] 同 id 消息被投影成 system oversized placeholder 时仍能确认；原始超大行 id 不可达时保持 live overlay 并进入明确的耗尽恢复状态。
- [x] `messageId` 缺失时所有现有 reducer 测试结果不变。
- [x] agent-server 零改动，透传合同探针通过。
- [x] 两仓聚焦测试、typecheck、lint 通过。
- [x] 主计划文档与 PR 描述已同步。
- [ ] 部署后人工确认一次工具 run 的 final 帧含 `messageId` 且覆盖层在首次 reconcile 后消失。

## Execution Evidence

- Executor: Codex。
- `[openclaw-integration]`
  - lifecycle 与 subscribe 聚焦测试：2 files，30 tests passed。
  - Gateway chat 与协议聚焦测试：2 files，43 tests passed。
  - `pnpm typecheck`、定向 type-aware oxlint、oxfmt check 和 `git diff --check` 通过。
  - 协议 JSON 与两份 Swift 模型已由生成器更新；提交后在干净工作树复跑 `pnpm protocol:check` 通过。
- `[agent-frontend]`
  - component Vitest：2 files，38 tests passed。
  - reducer Node 测试：40 tests passed。
  - `pnpm type-check`、定向 Biome check 和 `git diff --check` 通过。
- `[agent-server]`
  - 工作树保持干净。
  - `SessionScopedEventPayload.model_validate(...).model_dump(by_alias=True, exclude_unset=True)` 保留 `messageId` 的只读合同探针通过。
- PR metadata：#136 与 agent-frontend #69 的标题和六段中文描述已更新并通过本地 metadata validator。

## Out Of Scope

- `session.message` / `sessions.messages.subscribe` 推送（上游做法），留作后续评估。
- aborted / error 终态携带 id（转录写入与 abort 广播时序不保证，且前端对这两类已是宽松对账）。
- Control UI 改用 id 去重（当前靠 final 后 reload history，已满足一致性）。
