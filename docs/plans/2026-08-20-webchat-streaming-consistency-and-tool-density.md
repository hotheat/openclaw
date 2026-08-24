# Implementation Plan: WebChat 流式一致性与低延迟 V1

## Overview

V1 只处理 WebChat 流式正确性和相对 Control UI 的额外显示延迟：

1. 业务前端允许同一 `seq` 的 `delta -> final/error/aborted` 状态升级。
2. Gateway 保持“当前 assistant message 累计快照”语义，在 tool start 和 lifecycle final/error 前执行非丢弃补发。
3. 业务前端用 ordered render blocks 表达工具前文本、工具和工具后文本。
4. Control UI 在 own-run final 后回源 `chat.history`，收敛多 assistant message 的最终显示。
5. 业务前端移除固定 250ms delta 等待，直接消费 Gateway 已节流的 chat delta。
6. 终态对账优先按 final `messageId` 与 `chat.history` `historyEntryId` 匹配，缺少 id 时才使用文本 fallback。

工具活动视觉密度、BFF binding 级预过滤和全局消息增量化重构不进入 V1。

## Decision And Approval

- 2026-08-22：选择路线 A+，保持公共 `chat` 协议的按 message 快照语义。
- 2026-08-22：用户批准实施路线 A+、运行聚焦验证并提交推送两个 PR 分支。
- `agent-server` 继续做保序透明转发，不维护流式合并状态。

## Requirements

- 工具卡片出现前，Control UI 和业务前端都已显示完整的工具前助手文本。
- 150ms 节流窗口内完成的短助手文本不能停留在首字或半句。
- Gateway 边界 delta 携带其最新 assistant 事件的 `seq`，可靠补发可与先前的可丢弃 delta 同 seq，terminal 事件保留自身更大的 `seq`；业务前端仍须容忍同 seq `delta -> terminal` 升级。
- 业务前端收到 chat delta 后不再增加固定 250ms 等待。
- run 结束后的实时消息序列必须与 `chat.history` 最终内容一致。
- silent reply、heartbeat、abort、seq gap 和慢消费者保护行为不能回归。

## Constraints

- OpenClaw 修改使用仓库相对路径。
- 业务前端修改使用仓库相对路径。
- `agent-server` 保持透明转发，不增加状态或流式合并。
- 公共 WebSocket 协议只新增向后兼容的 final 可选字段 `messageId`，不改变现有字段语义。
- 不执行 `make build`、`make test` 或 Gateway 服务重启。
- 只运行触及代码的聚焦测试、类型检查和 lint。

## Ownership Map

- Executor: Codex
  - `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.ts`
  - `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.ts`
  - `[agent-frontend] src/features/openclaw-bff/types/chat.ts`
  - `[agent-frontend] src/utils/openclawBff/types.ts`
  - `[agent-frontend] src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx`
  - `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.test.ts`
  - `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx`
  - `[openclaw-integration] src/gateway/server-chat.ts`
  - `[openclaw-integration] src/gateway/server-chat.agent-events.test.ts`
  - `[openclaw-integration] src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`
  - `[openclaw-integration] src/agents/pi-embedded-subscribe.handlers.lifecycle.test.ts`
  - `[openclaw-integration] src/agents/pi-embedded-runner/run.ts`
  - `[openclaw-integration] src/gateway/protocol/schema/logs-chat.ts`
  - `[openclaw-integration] src/gateway/protocol/index.test.ts`
  - `[openclaw-integration] src/gateway/chat-abort.ts`
  - `[openclaw-integration] src/gateway/chat-abort.test.ts`
  - `[openclaw-integration] src/gateway/server-methods/chat.ts`
  - `[openclaw-integration] src/gateway/server-methods/chat.abort-persistence.test.ts`
  - `[openclaw-integration] src/gateway/server-methods/types.ts`
  - `[openclaw-integration] src/gateway/server-maintenance.ts`
  - `[openclaw-integration] src/gateway/server-maintenance.test.ts`
  - `[openclaw-integration] src/gateway/server.impl.ts`
  - `[openclaw-integration] ui/src/ui/chat-event-reload.ts`
  - `[openclaw-integration] ui/src/ui/chat-event-reload.test.ts`
  - `[openclaw-integration] docs/plans/2026-08-20-webchat-streaming-consistency-and-tool-density.md`
  - `[openclaw-integration] docs/plans/2026-08-22-webchat-id-based-terminal-reconcile.md`

No path has overlapping ownership. `agent-server` has no changed path.

## Data Flow

```text
当前 assistant message 的累计文本
    -> Agent assistant event
    -> Gateway 当前 message buffer + revision
    -> 普通 delta 最多每 150ms 广播一次
    -> tool start / lifecycle terminal 前非丢弃 boundary flush
    -> BFF 保序透明转发
    -> 前端直接 dispatch delta
    -> reducer 按 user/text/tools block 顺序更新 optimistic overlay
    -> 同 seq terminal 合法升级
    -> terminal 后优先用 messageId 确认 historyEntryId 已写入
    -> 无 messageId 时按最后 assistant 文本确认完整消息序列
```

## Implementation Steps

### Phase 1: 前端协议兼容

1. **允许同 seq 终态升级**
   - File: `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.ts`
   - Action:
     - `action.seq < lastChatSeq` 始终拒绝。
     - `action.seq === lastChatSeq` 时，只允许未终态 run 接受 `final/error/aborted`。
     - 同 seq delta、重复 terminal 和 terminal 后 delta 继续忽略。
     - 已确认 abort 只允许同为 `aborted`、更大 seq 且带文本的事件补全 partial text。
   - Why: Gateway boundary delta 和紧随其后的 terminal 使用同一 agent `seq`。
   - Dependencies: None.
   - Risk: Medium.

2. **增加 reducer 回归测试**
   - File: `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.test.ts`
   - Action:
     - 覆盖同 seq `delta -> final`。
     - 覆盖同 seq `delta -> error/aborted`。
     - 覆盖重复 terminal 幂等、旧 seq 拒绝和 terminal 后 delta 拒绝。
   - Dependencies: Step 1.
   - Risk: Low.

### Phase 2: 前端低延迟 delta

3. **移除固定 250ms delta coalescing**
   - Files:
     - `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.ts`
     - `[agent-frontend] src/features/openclaw-bff/types/chat.ts`
   - Action:
     - chat delta 到达后立即 dispatch。
     - 删除 `DELTA_COALESCE_MS`、`deltaBuffersRef`、timer 和 `flushDelta()`。
     - terminal 到达时直接 dispatch，不再依赖先 flush timer buffer。
     - 保持 seq 去重由 reducer 负责。
   - Why: Gateway 已将普通 chat delta 限制为最多每 150ms 一次，额外 250ms 等待只会增加可见延迟。
   - Dependencies: Step 1.
   - Risk: Medium. 需要确认现有渲染链能够承受 Gateway 的 150ms 频率。

4. **增加 Hook 时序测试**
   - File: `[agent-frontend] src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx`
   - Action:
     - delta 事件到达后无需推进 timer 即可观察到完整文本。
     - 同 seq final 紧随 delta 时立即进入 terminal。
     - terminal 后 watchdog 不继续发送 probe。
   - Dependencies: Steps 1-3.
   - Risk: Low.

### Phase 3: Gateway 按 message 的非丢弃边界快照

5. **为 chat buffer 增加 revision**
   - Files:
     - `[openclaw-integration] src/gateway/server-chat.ts`
     - `[openclaw-integration] src/gateway/chat-abort.ts`
     - `[openclaw-integration] src/gateway/server-methods/chat.ts`
     - `[openclaw-integration] src/gateway/server-methods/types.ts`
     - `[openclaw-integration] src/gateway/server-maintenance.ts`
     - `[openclaw-integration] src/gateway/server.impl.ts`
   - Action:
     - `ChatRunState` 记录当前 buffer revision、最后非丢弃 WebSocket revision 和最后 node revision。
     - 每个有效 assistant text event 更新 buffer 并推进 revision，包括文本内容相同的新事件。
     - buffer 始终保存当前 assistant message 的累计快照，不跨 message 拼接。
     - `clear()`、主动 abort、超时 abort、abort TTL 和 final 清理全部 revision 状态。
   - Why: 仅比较文本会把内容相同的新助手段落误判为重复。
   - Dependencies: Phase 1 已可接受同 seq terminal。
   - Risk: Low.

6. **抽取可靠 boundary flush**
   - File: `[openclaw-integration] src/gateway/server-chat.ts`
   - Action:
     - 从最新 buffer 生成 chat delta。
     - 复用 inline directive、silent reply、silent prefix 和 heartbeat 过滤。
     - 当前 revision 已完成非丢弃 WebSocket 尝试时跳过 WebSocket 补发。
     - node 已收到当前 revision 时不重复发送；被 150ms 节流的尾部仍在边界补发给 node。
     - boundary delta 不设置 `dropIfSlow: true`。
     - 广播成功后记录最后广播 revision。
   - Dependencies: Step 5.
   - Risk: Medium.

7. **在 tool start 和 terminal 前 flush**
   - File: `[openclaw-integration] src/gateway/server-chat.ts`
   - Action:
     - tool event `phase=start` 广播前执行 boundary flush。
     - lifecycle `end/error` 生成 final/error 前执行 boundary flush。
     - tool update/result 不触发 flush。
     - aborted run 不补发。
     - `agentRunSeq` 保持单调高水位，旧 seq 和重复 seq 不再更新 chat buffer 或触发 boundary flush。
   - Dependencies: Step 6.
   - Risk: Medium. 广播顺序必须保持 `完整 delta -> tool start` 和 `完整 delta -> terminal`。

8. **增加 Gateway 时间线测试**
   - Files:
     - `[openclaw-integration] src/gateway/server-chat.agent-events.test.ts`
     - `[openclaw-integration] src/gateway/chat-abort.test.ts`
     - `[openclaw-integration] src/gateway/server-maintenance.test.ts`
     - `[openclaw-integration] src/gateway/server-methods/chat.abort-persistence.test.ts`
   - Action:
     - 150ms 内短文本尾部在 tool start 前补发。
     - terminal 前补发尾部，随后发送更大 seq 的 final/error。
     - 同一 boundary 后 revision 未变化时不重复补发。
     - 文本相同但 revision 更新时仍可补发。
     - 覆盖 `5 -> 4 -> 5` 乱序/重放，确认高水位不回退。
     - silent reply、heartbeat、abort 不补发。
     - `ChatRunState.clear()` 不残留 revision。
   - Dependencies: Steps 5-7.
   - Risk: Low.

### Phase 4: 前端消息序列一致性

9. **业务前端按事件边界渲染 ordered blocks**
   - Files:
     - `[agent-frontend] src/features/openclaw-bff/types/chat.ts`
     - `[agent-frontend] src/features/openclaw-bff/state/chat-reducer.ts`
   - Action:
     - `userMessages` 和 `assistantText` 继续承担身份与 terminal 对账。
     - `renderBlocks` 独立保存 user、text、tools 的实时顺序。
     - tool start 关闭当前 text block，工具后快照创建新的 text block。
     - terminal 对账只接受最后一个 assistant message，并要求工具后的 final 文本位于已确认工具之后。
   - Risk: Medium。

10. **Control UI terminal 后回源 history**
    - Files:
      - `[openclaw-integration] ui/src/ui/chat-event-reload.ts`
      - `[openclaw-integration] ui/src/ui/chat-event-reload.test.ts`
    - Action:
      - own-run final 无论是否携带 assistant message 都重新加载 history。
      - final payload 继续提供即时显示，history 随后收敛完整多 message 序列。
    - Risk: Low，多一次 terminal 后 history 请求。

### Phase 5: 集成验证

11. **运行聚焦验证**

- `[agent-frontend]`
  - `npx vitest run src/features/openclaw-bff/state/chat-reducer.test.ts src/features/openclaw-bff/hooks/useOpenClawChat.recovery.test.tsx --config vitest.components.config.ts`
  - `npm run type-check`
  - 对修改文件运行 Biome check。
- `[openclaw-integration]`
  - `pnpm vitest run src/gateway/server-chat.agent-events.test.ts src/gateway/chat-abort.test.ts src/gateway/server-maintenance.test.ts src/gateway/server-methods/chat.abort-persistence.test.ts`
  - 对修改文件运行项目现有 lint/typecheck 入口；不运行 `make build` 或 `make test`。
- Dependencies: Phases 1-3.
- Risk: Low.

12. **人工双前端对照**
    - 同时观察 Control UI 和业务前端的同一 session。
    - 记录 WebSocket 帧顺序和浏览器首次可见文本。
    - 验证业务前端相对 Control UI 没有固定 250ms 延迟。
    - Gateway 服务重启需要另行确认，本次不执行。
    - Dependencies: 代码部署后。
    - Risk: Low.

## V1 暂缓

- 历史工具调用聚合和间距调整：与流式响应速度无直接关系。
- BFF binding 级预过滤：存在并发队头阻塞风险，但目前缺少它是实际瓶颈的证据。
- 前端全局消息增量化重构：V1 只为 live run 增加 ordered blocks。
- 完整延迟监控平台：V1 使用 WebSocket 时间戳和 Playwright 测量即可。

## Risks And Mitigations

- **Risk: 同 seq 放宽导致重复终态重复处理**
  - Mitigation: 只允许未终态 run 接受同 seq terminal。

- **Risk: 移除 250ms 合并增加渲染频率**
  - Mitigation: Gateway 已限制普通 delta 为 150ms；聚焦测试和类型检查后再评估是否需要按 animation frame 合并。

- **Risk: boundary delta 与 final 重复文本**
  - Mitigation: delta 更新内容，terminal 只升级状态；revision 防止无变化边界重复发送。

- **Risk: 边界非丢弃广播遇到慢消费者**
  - Mitigation: 沿用 Gateway 慢消费者断开和 history 恢复策略，不能静默丢弃状态边界。

- **Risk: 发布顺序使旧前端吞掉 terminal**
  - Mitigation: boundary delta 已改用最新 assistant 事件的 `seq`，terminal 保留自身更大 `seq`，按 `runId + seq` 严格去重的旧消费者不会吞掉 terminal；仍建议先发布 agent-frontend 获取同 seq 容错。

## Success Criteria

- [x] 同 seq `delta -> final/error/aborted` 正确进入 terminal。
- [x] 业务前端收到 delta 后没有固定 250ms 等待。
- [x] 完整助手文本在 tool start 前广播。
- [x] terminal 前未广播的尾部文本得到可靠补发。
- [x] 跨工具调用的多个 assistant message 按 block 保序渲染，final 与最后一条 history assistant 对账。
- [x] chat delta `seq` 不回退，可靠补发可重复最新 seq，terminal 不与 delta 共用 `seq`。
- [x] final 后 watchdog 停止，`activeOwnRunId` 清空。
- [x] silent reply、heartbeat、abort 和 seq gap 行为保持。
- [x] 两个仓库的聚焦测试、类型检查和修改文件 lint 通过。
- [x] Control UI own-run final 后回源 history，保留工具前后的完整消息序列。
- [x] 可见 final 携带的 `messageId` 等于同一持久化 assistant 的 `historyEntryId`，空或 silent final 不携带。
- [x] final 文本与历史投影不同但 id 相等时，业务前端仍能提交该 run。
- [x] final 带 id 但历史未命中时不回退文本，重试耗尽后保留 live overlay。
- [ ] 部署后完成 Control UI 与业务前端的人工显示时序对照。

## Review Amendments

Earlier independent review flagged two Important findings; both are covered by the current implementation:

- Assistant snapshots reset at every assistant `message_start`，因此 Gateway 保持当前 message 快照，不再把整个 run 拼成一个 message。
- 业务前端通过 ordered blocks 保存工具前文本、工具和工具后文本，并只用最后 assistant message 做 terminal 对账。
- Gateway 使用 seq 高水位拒绝 chat projection 重放，并分别记录非丢弃 WebSocket revision 与 node revision。
- Boundary deltas previously borrowed the terminal event's `seq`, which strict-dedup consumers could treat as a repeat. Boundary deltas now carry the latest assistant event's `seq` (`deltaSeqs`); reliable repeats may reuse that delta seq, while terminal `seq`s remain unique and larger.
- 文本相等对账无法区分裁剪、oversized 投影和同文不同消息，终态现改为优先使用持久化消息 id；`session.message` 推送仍是后续可选能力。

## Execution Evidence

- Executor: Codex.
- Final review: current-session local diff review completed; subagent review was not run because this session disallows subagent delegation.
- `[agent-frontend]`
  - Focused component Vitest: 3 files, 70 tests passed.
  - Focused reducer regression tests: 44 tests passed.
  - TypeScript type-check passed.
  - Biome check and `git diff --check` passed.
- `[openclaw-integration]`
  - Focused Gateway Vitest: 4 files, 36 tests passed.
  - Focused Control UI Vitest in Node mode: 2 files, 27 tests passed.
  - Project typecheck passed.
  - Control UI production build passed with the existing chunk-size warning.
  - Type-aware oxlint, oxfmt check and `git diff --check` passed.
- Not run by constraint: full test suites, Gateway restart, deployed dual-frontend comparison, and browser-mode Control UI tests because the local Playwright Chromium binary is absent.
- ID 对账增量验证：OpenClaw 4 files、73 tests passed；agent-frontend 2 component files、38 tests passed，reducer Node tests 40 passed。
- ID 对账增量的两仓 typecheck、定向 lint/format 和 `git diff --check` 均通过；agent-server 未改动，未知事件字段透传合同探针通过。
