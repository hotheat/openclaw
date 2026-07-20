# WebUI 聊天绑定 webchat 隔离会话，而非飞书渠道主会话

Status: accepted (2026-07-13)

Phase 1 Web 聊天页需要决定浏览器会话绑定到哪条 Gateway session。浏览器聊天使用 webchat 隔离会话（`agent:{agentId}:webchat:{clientInstanceId}:main`），不绑定飞书私聊所在的渠道主会话（`agent:{agentId}:main`）。Web 与飞书因此是同一个专属 agent（共享 memory/workspace）下的两条互不可见的对话历史，UI 需向用户明示。

## Considered Options

**绑定渠道主会话（被否决）**：让 Web 页直接读写 `agent:{agentId}:main`，与飞书共享同一条对话。技术上已验证可行——OpenClaw 默认 `dmScope="main"`（`src/routing/resolve-route.ts`）使飞书私聊落在 agent 主会话；chat delta/final 事件对所有 Gateway 连接广播，BFF 按 sessionKey 过滤即可实时镜像飞书侧输出；`resolveSendPolicy` 默认 allow，`chat.send` 可写入。否决理由：

1. **工具事件缺失**：Gateway 的 tool 事件按 runId 只推送给"声明 `tool-events` capability 且发起该 run 的连接"（`src/gateway/server-methods/chat.ts` 的 `registerToolEventRecipient`），且事件按 `sessionKey` 精确过滤。飞书渠道 run 落在 `agent:{agentId}:main`，与 webchat 会话 `agent:{agentId}:webchat:{clientInstanceId}:main` 是**不同 sessionKey**，因此即使网页绑定渠道主会话，飞书侧 run 的工具事件也会被 sessionKey 过滤丢弃——网页对飞书侧 run 只有文本、没有工具卡片，体验割裂。
2. **配置耦合**：会话形态依赖部署保持 `session.dmScope="main"` 默认值；一旦配置改为 per-peer 变体，Web 与飞书会静默劈成两条历史，且 BFF 需要用 Python 复刻 `buildAgentPeerSessionKey` 的全部变体才能对齐。
3. **飞书记录缺口**：BFF 丢弃 `deliver` 参数，Web 轮次的回复不会推送到飞书 App；反向开启 deliver 又会对用户造成重复通知。
4. **入站不可见**：用户在飞书侧发的消息没有实时事件，网页只能靠 history 重载补齐。

## Consequences

- Web 会话是网页专属 transcript；用户预期"网页能看到飞书聊天记录"需靠 UI 提示管理。
- Phase 2 多 Chat 在 webchat namespace 内扩展短 ID 会话，`main` 保留为默认会话。
- 若未来要做"与飞书同一会话"，上述四点是需要先解决的前置问题（尤其是 tool recipient 注册机制需要 OpenClaw 侧改动）。

## Verified Topology & Tool-Event Delivery (2026-07-13 interview)

本节记录在 Phase 1 计划访谈中核实、与本 ADR 决策相关的架构事实，不改变上述结论，仅澄清工具事件的实际投递范围：

- **上游 Gateway 连接为全局 Singleton 共享一条**（`agent-server/app/common/containers/clients.py:248` `providers.Singleton`）。每个浏览器 Tab 拿到独立订阅队列，但共享同一条上游连接与 fan-out。
- **事件 fan-out 在前、`sessionKey` 过滤在后**：Gateway `broadcast` 遍历所有连接不做 session 成员校验（`src/gateway/server-broadcast.ts:93-114`），BFF `filter_event` 再按 `binding.session_key` 精确过滤（`openclaw_bridge_service.py`）。
- **同 session 多 Tab 共享工具卡片**：同用户多 Tab 的 `clientSessionId` 都为 `main` → 相同 `binding.session_key` → 工具事件对两 Tab 都通过过滤。因此 webchat 会话**内部**的 own 与 foreign run 都会实时收到工具卡片（聚合键为 `runId + toolCallId`，见 OpenClaw `buildToolStartKey`）。这与本 ADR 否决理由 #1 不冲突：#1 针对的是**跨渠道**（飞书 run 落在 `agent:{agentId}:main`，sessionKey 不同，工具事件被过滤丢弃）；webchat→webchat 是同 session，自然共享。
- 工具事件按 `runId + connId` 注册 recipient（`registerToolEventRecipient`），recipient 是共享上游连接；新连接（重连后）不自动恢复 recipient，断线窗口内事件不重放——这些运行时事实与终态收敛策略记录于 `docs/plans/2026-07-13-openclaw-phase-1-single-chat.md` 的 Architecture Decision 3、5、7、8。
