# OpenClaw WebUI 暂缓观察清单

本文记录联调中已复现，或已确认风险路径但仍需验证生产影响，且当前不阻断主链路交付的问题。与 WebUI 链路直接相关、但已经确认需要独立排期的缺陷，只在本文保留交叉索引，不作为普通 `deferred` observation 管理。

当前优先级是走通 [Phase 1 单会话主链路](../../plans/2026-07-13-openclaw-phase-1-single-chat.md)：登录 → BFF 鉴权与隔离 → Gateway → Agent/Tool → 流式事件 → `chat.history` 对账。

## 记录规则

- 每个问题使用独立编号，按“结果与目的 → 必要上下文 → 事实与证据 → 输出契约 → 边界 → 验证”记录，使条目能直接作为后续排障任务说明。
- 只保留会改变排查方向的信息，明确区分已知事实、推断和未知项。
- 未取得协议帧、服务日志或 transcript 证据前，不写确定性根因。
- 问题若扩散到普通单 Tab 对话、身份隔离、数据丢失或主链路不可用，立即移出观察清单并重新排期。
- 主链路验收完成后统一复查未关闭项。

## SEC-001：Gateway assistant 流式事件向无关已认证连接广播

- 状态：`confirmed`，需要独立排期修复；不属于普通 deferred observation。
- 发现日期：2026-07-20。
- 归属：`openclaw-integration` Gateway。
- 当前决策：不纳入 PR #81 的修复范围；已作为独立后台问题登记。若后续建立 GitHub issue，在本条回填链接并以 issue 为主跟踪。

### 结果与目的

Gateway 应只把 session-scoped `agent`、`chat` 事件发送给拥有该 run/session 接收资格的连接。修复后，任意无关的已认证 operator、node 或其他 Gateway WebSocket 客户端均不能收到该会话的 assistant、thinking 或 lifecycle 内容。

### 必要上下文

涉及链路：Feishu/WebChat/其他入口触发 agent run → Gateway 生成 `agent`/`chat` 流式事件 → Gateway WebSocket 广播器选择接收连接 → BFF 或其他直连客户端接收事件。

相关实现：

- `src/gateway/server-chat.ts`
- `src/gateway/server-broadcast.ts`
- `src/agents/pi-embedded-subscribe.ts`
- `src/agents/pi-embedded-subscribe.handlers.messages.ts`
- `../agent-server/app/infra/openclaw/gateway_client_adapter.py`
- `../agent-server/app/services/openclaw_bridge_service.py`

### 事实与证据

#### 可确认结论

- `src/gateway/server-chat.ts` 对非 tool 的 `agent` 事件调用全局 `broadcast("agent", agentPayload)`；assistant 文本还会通过 `broadcast("chat", payload)` 发送。
- `src/gateway/server-broadcast.ts` 的 scope guard 只覆盖审批和配对事件。`agent`、`chat` 没有 guard，因此广播器会向任意 role/scope 的已认证连接发送。
- Gateway 已有 `nodeSendToSession(sessionKey, ...)` 和 tool-event recipient 集合，说明 session/run 定向投递机制已经存在；当前全局广播是额外暴露面。
- 正常 WebChat 浏览器经过 BFF 时，`OpenClawBridgeService.filter_event()` 会按 binding session key 和 child capability map 丢弃 foreign event，因此现行 BFF 能阻止两个正常 WebChat 用户直接串流。
- 任何绕过 BFF、直接连接 Gateway 的已认证客户端不会经过上述 BFF 过滤，可以在网络层收到其他会话事件。该问题属于已认证连接之间的横向数据越权。

#### 尚待设计确认

- Control UI 同 session 多连接、BFF 单一共享上游连接、node/channel subscriber 分别应如何登记 recipient，才能保持现有多 Tab、重连和 child run 行为。
- lifecycle、assistant、thinking、chat delta/final 各事件应采用 connection、run 还是 session 粒度的接收资格。
- seq-gap 等错误事件是否应跟随原 run 的 recipient 集合定向发送。

### 输出契约

后续恢复该任务时，输出必须包含：

1. 所有 `agent`、`chat` 事件产生点和接收者选择机制的完整清单。
2. BFF、Control UI、node、channel subscriber 和 tool-event recipient 的兼容性分析。
3. 最小修复方案及 recipient 生命周期、重连和清理策略。
4. 无关 operator、无关 node、同 session 合法多连接和 BFF 共享连接的自动化测试。
5. 对 assistant、thinking、lifecycle、chat delta/final 的覆盖结果。

### 边界

- 不以扩大 BFF 权限或依赖前端过滤替代 Gateway 接收者约束。
- 不削弱 BFF 已有的用户、target、session 和 child capability 隔离。
- tool event 当前的定向投递语义必须保持。
- 修复前若无法把 Gateway 网络入口限制为仅 BFF 可访问，应按身份隔离问题处理，不能降级为纯性能优化。

### 验证

- 两个独立已认证 Gateway 连接中，连接 B 无法收到连接 A 专属 session/run 的 `agent` 或 `chat` 事件。
- BFF 共享上游连接仍能收到由 BFF 发起的所有合法 WebChat session 事件，并在 BFF 内正确路由。
- 同 session 的合法多 Tab、Control UI 重连、active child 恢复和 node/channel subscriber 行为符合定义的 recipient 契约。
- assistant、thinking、lifecycle、chat delta/final 和 seq-gap 定向测试通过。

## OBS-001：多 Tab 中止后 partial 回答重复

- 状态：`deferred`，继续观察。
- 发现日期：2026-07-14。
- 当前决策：不纳入 Phase 1 主链路收尾范围。

### 结果与目的

恢复处理时，需要定位重复内容首次产生的层级，并给出最小修复方案。该问题单独收敛，当前阶段继续验证登录、鉴权隔离、Agent/Tool、流式回传和历史对账主链路。

### 必要上下文

涉及链路：Tab 2 `chat.send` → BFF → Gateway run → 两个 Tab 接收 `chat` 事件 → Tab 2 `chat.abort` → 终态历史对账 → 页面刷新后重新请求 `chat.history`。

相关实现：

- `../agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.ts`
- `../agent-frontend/src/features/openclaw-bff/state/chat-reducer.ts`
- `../agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts`
- `../agent-server/app/services/openclaw_bridge_service.py`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/chat-abort.ts`

### 事实与证据

#### 稳定复现步骤

1. Tab 2 发起长回答。
2. Tab 1 收到流式消息，但没有停止权限。
3. Tab 2 点击停止。
4. 部分回答出现两份。
5. 刷新页面并重新读取 `chat.history`。
6. 重复内容仍存在。

#### 期望结果

- 只有 Tab 2 能停止自己发起的 run。
- 中止后最多保留一条 assistant partial。
- 两个 Tab 刷新后读取到一致且无重复的历史。

#### 实际结果

- Tab 间的中止权限隔离符合预期。
- 中止后部分回答出现两份。
- 重复内容在刷新并读取 `chat.history` 后仍存在。

#### 可确认结论

- 重复内容刷新后仍能由 `chat.history` 恢复，因此问题不只存在于单个 Tab 的瞬时渲染状态。
- 当前没有原始 WebSocket 帧、workspace-api 日志和 Gateway transcript，不能确定重复记录产生于 Gateway、BFF 还是前端历史映射。

#### 缺失证据

- 同时保存两个 Tab 的 `chat.abort`、`chat` 终态事件和 `chat.history` 原始 WebSocket 帧。
- 对照 workspace-api 日志中的 session key、run ID、消息 ID 和中止时间。
- 检查 Gateway transcript，确认中止前后 assistant partial 的记录数量和标识。
- 比较原始历史与前端 mapper/reducer 输出，定位首次出现重复的层级。

### 输出契约

后续恢复该任务时，输出必须包含：

1. 最小稳定复现结果。
2. 重复内容首次出现层级的原始证据。
3. 分开的已知事实、推断和未验证信息。
4. 最小修复方案、影响范围和回归风险。
5. 相关自动化测试及手工多 Tab 验证结果。

### 边界

- 当前阶段不修改实现，先走通 Phase 1 主链路。
- 后续修复不得削弱“只有发起 Tab 拥有中止权限”的隔离语义。
- 未定位首次重复层级前，不做跨层重构，也不使用纯文本相等作为去重依据。

#### 重新排期条件

- 普通 `final` 或单 Tab 中止也出现重复。
- 重复影响其他 session、target 或用户。
- 重复导致历史继续增长、上下文污染或模型后续回答异常。
- Phase 1 主链路验收完成，进入稳定性收尾。

### 验证

- 能按上述步骤稳定复现修复前行为。
- 一次用户请求最多保留一条 assistant partial。
- 两个 Tab 刷新后的历史一致且无重复。
- 原始 `chat.history` 与 Gateway transcript 均无重复记录。
- 相关定向测试通过，并完成两个 Tab 的手工回归。

## OBS-002：BFF 在 session 过滤前向所有浏览器队列 fanout

- 状态：`deferred`，代码路径已确认，生产影响待压测验证。
- 发现日期：2026-07-20。
- 归属：`agent-server` OpenClaw Gateway bridge。
- 当前决策：现行 session 过滤继续承担 WebChat 机密性边界；将过滤前 fanout 作为可用性和资源隔离问题继续观察。

### 结果与目的

恢复处理时，需要验证无关 Feishu/WebChat 流式事件能否在实际并发下填满浏览器 subscriber queue，并判断是否应把 session/run 路由提前到入队之前。优化后，无关会话流量不应占用当前浏览器 binding 的队列容量或导致其 WebSocket 断开。

### 必要上下文

涉及链路：Gateway 全局事件 → agent-server 单一共享上游连接 → `OpenClawGatewayClientManager` → 每个浏览器 subscriber queue → `OpenClawBridgeService.filter_event()` → 浏览器 WebSocket。

相关实现：

- `../agent-server/app/infra/openclaw/gateway_client_adapter.py`
- `../agent-server/app/infra/openclaw/gateway_client_manager.py`
- `../agent-server/app/api/v1/controllers/openclaw_bridge_controller.py`
- `../agent-server/app/services/openclaw_bridge_service.py`
- `../agent-server/app/common/constants/openclaw_gateway.py`
- `../agent-server/app/common/ports/openclaw_gateway_port.py`
- `../agent-server/app/test/unit_test/services/test_openclaw_bridge_service.py`
- `../agent-server/app/test/unit_test/api/test_openclaw_bridge_controller.py`

### 事实与证据

#### 可确认结论

- agent-server 进程共享一个到 Gateway 的上游 WebSocket，adapter 把所有上游 event 写入同一事件队列。
- manager 收到事件后，先遍历所有 subscriber queue 执行 `put_nowait(event)`；此时尚未按用户、target 或 session 过滤。
- 每个浏览器的 controller 消费自己的队列后，才调用 `filter_event(binding, event)`。foreign parent/child session 事件会返回 `None`，现有定向测试覆盖该行为。
- 每个 subscriber queue 的上限是 100。队列溢出后，manager 会插入 `GatewaySubscriberClosed`、移除 subscriber；controller 随后以 1011 关闭浏览器 WebSocket。
- 因此当前已确认存在无关事件占用每个浏览器队列容量的资源放大路径；尚无证据表明生产环境已经发生溢出或串流。

#### 缺失证据

- Feishu 多会话、多个 WebChat run 和慢浏览器并发时的事件速率、队列 high-watermark 与消费延迟。
- 生产日志中 `OpenClaw Gateway subscriber queue overflowed`、1011 断线和前端重连是否存在时间相关性。
- assistant、thinking、lifecycle 和 chat 双事件对队列增长的实际贡献。
- Gateway 完成 SEC-001 定向广播后，BFF 仍会收到的无关事件规模。

### 输出契约

后续恢复该任务时，输出必须包含：

1. 可重复的并发压测场景和事件速率。
2. 各 subscriber queue 的 high-watermark、overflow 次数、过滤丢弃数和断线数。
3. Gateway 修复前后无关事件规模对比。
4. 保持 parent/child capability 隔离的最小入队前路由方案。
5. 慢消费者、断线重连、binding 清理和上游重连的定向测试结果。

### 边界

- 入队前路由只能减少候选接收者，不能放宽 `filter_event()` 的最终 default-deny 校验。
- parent session、已授权 child session/run、artifact event 和上游断开事件需要分别定义路由键和广播语义。
- 不把生产中尚未复现的 queue overflow 写成已发生事故。
- SEC-001 修复与本项优化分别验收；Gateway 定向广播不能替代 BFF 用户级隔离。

#### 重新排期条件

- 日志出现 subscriber queue overflow 或由此触发的 1011 WebSocket 断线。
- Feishu 或其他 WebChat 会话的负载能稳定影响当前浏览器的延迟、连接或消息完整性。
- subscriber 数或全局事件速率增长，使 fanout 的 CPU、内存或队列占用成为容量瓶颈。
- SEC-001 完成后仍存在显著的过滤前无关事件 fanout。

### 验证

- 并发 Feishu + WebChat 压测下，无关 session 事件不进入当前 binding 的 subscriber queue。
- 一个慢浏览器不会因其他 session 的事件突发而收到 1011 断线。
- parent、已授权 child、artifact 和上游断开事件仍能到达正确浏览器。
- foreign parent/child event 继续被最终过滤器拒绝。
- manager 的队列、过滤和断线指标能够区分本 binding 流量与无关流量。
