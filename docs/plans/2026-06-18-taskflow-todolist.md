# Implementation Plan: TaskFlow

## Overview

本计划为 OpenClaw 增加一等 TaskFlow 能力，用于复杂任务的规划、状态持久化、执行 agent 自主管理、Feishu 进度可视化和上下文压缩后的任务恢复。

目标链路：

```text
用户复杂任务
  -> 当前执行 agent 通过 prompt policy 判断需要 TaskFlow
  -> taskflow_update(create)
  -> 本地 TaskFlowStore 持久化
  -> before_prompt_build 注入当前 TaskFlow Markdown 快照
  -> TaskFlow owner 调用 taskflow_update 更新状态
  -> taskflow_updated typed plugin hook 发布 revision 变化
  -> Feishu TaskFlow publisher 更新 streaming card
  -> compaction / resume 后从 TaskFlowStore 重新注入快照
```

核心原则：

- TaskFlow 状态以本地文件为权威源，不依赖 transcript 中的工具调用历史。
- `taskflow_update` 是唯一写入口，`taskflow_read` 是读入口。
- Markdown checklist 是展示格式，JSON TaskFlow snapshot 是状态格式。
- Feishu 进度展示复用 `FeishuStreamingSession`，不复用 `reply-dispatcher`，通过 TaskFlow 事件桥触发。
- TaskFlow 默认归属当前执行 agent；父 agent 不默认感知子 agent 的内部 TaskFlow 变化。
- shared TaskFlow 只在显式跨 agent 协作时启用，不因为 `sessions_spawn` 自动创建。
- 每个 owner session 同时最多一个 unfinished TaskFlow；`blocked` 仍占用 active 单例。

## Resolved Design Decisions

- `active TaskFlow` 按 `ownerSessionKey` 保持单例。`active` 和 `blocked` 都属于 unfinished；只有 `completed`、`canceled` 释放单例。
- shared TaskFlow snapshot/event log 仍归属 owner agentDir；新增全局轻量索引用于 `taskFlowId` 定位 owner snapshot。
- shared 子 agent 默认只能写 assigned item、其子 item 和 evidence；整张表写入需要显式 `write_all`。
- Feishu 入站创建 `local` TaskFlow 时自动订阅当前 chat；`subscribe_channel` 保留给补订阅、跨 chat 和 shared 场景。
- TaskFlow revision 变化通过 `taskflow_updated` typed plugin hook 通知 extension，不使用独立内存 event bus。
- `taskflow_update(create)` 支持原子创建初始 items，避免空 TaskFlow 和重复进度推送。
- `taskflow_update` 不允许完整替换 items 数组，只允许增量 operation；删除第一版用 `canceled` 表示。
- compaction 恢复第一版只依赖 `ownerSessionKey -> active/blocked TaskFlow` 查询；`before_compaction` metadata hint 放到 hardening。
- JSONL event log 第一版作为审计记录，不做 snapshot 自动重建；event replay 放到 hardening。
- TaskFlow Skill 是 Phase 5 增强，不是 core TaskFlow 可用性的前提。
- TaskFlow status 集合为 `active | blocked | parked | completed | canceled`。foreground = `active | blocked`；`parked` 表示用户/owner 显式挂起、不占当前焦点，不占用 foreground 单例。
- 单例约束改为：每个 `ownerSessionKey` 同时最多一个 foreground TaskFlow（`active` 或 `blocked`）。`parked` 不计入 foreground 单例；同一 owner 可以同时持有多个 `parked` TaskFlow。
- `create` 只检查当前无 foreground TaskFlow；存在 `parked` 不阻挡 `create`。`resume_taskflow` 仅在当前没有 foreground TaskFlow 时允许，否则返回 conflict。
- `expectedRevision` 冲突只返回 conflict 元信息，不返回完整 snapshot，也不做任何 operation 的自动合并重试。
- snapshot 写入是权威提交点；JSONL event 写失败只产生 `audit_event_append_failed` warning，不回滚 snapshot、不阻塞 `taskflow_updated`。
- TaskFlow 文件是权威状态；owner session archive/delete 不自动改 TaskFlow status。prompt 注入只发生在当前正在运行的 session；archive 后该 session 不再 build prompt，孤儿文件只作为可读历史。
- `complete_taskflow` 不自动归档或移动文件；snapshot 留在原位，仅改 status、completedAt、revision；pending item 历史保留为可读事实，不强制改 canceled。
- shared 权限回收的主机制是 `subagent_ended` typed hook 自动 revoke；TTL 只做兜底；保留显式 `revoke_access` operation 用于中途取消。
- 运行时不干预 TaskFlow 创建频率或简单/复杂判断；过度创建治理只走 metrics 收集 + 后续调优 prompt policy。

## Reference Findings

### Codex 参考实现

已核对 Codex 源码后，可借鉴但不能直接等价复用：

- `update_plan` 是轻量 checklist UI 工具，schema 只有 `pending | in_progress | completed`，调用后发 `PlanUpdate` 事件给 UI。
- `PlanUpdate` 不是权威持久化状态，rollout 策略不会把它作为独立状态源保存。
- Codex 的 `goal` 扩展更接近持久化目标管理：SQLite 表保存 active / blocked / complete 等状态，并在 resume 后继续驱动。
- Codex 有 subagent 和 compaction 基础设施，但没有完整的共享 TaskFlow 状态源、Feishu 推送、按 agent scoped sharing 的 TaskFlow。

结论：OpenClaw 应实现独立 TaskFlow state store，而不是只做 `update_plan` 风格 UI 事件。

### OpenClaw 当前入口

当前仓库已有适合接入 TaskFlow 的运行时入口：

- 工具注册入口：`src/agents/openclaw-tools.ts`
- 工具实现形态：`src/agents/tools/*.ts`
- prompt 动态注入入口：`before_prompt_build` hook，见 `src/plugins/types.ts` 和 `src/agents/pi-embedded-runner/run/attempt.ts`
- compaction 观察入口：`before_compaction` / `after_compaction`
- tool lifecycle 入口：`before_tool_call` / `after_tool_call`
- subagent 工具入口：`src/agents/tools/sessions-spawn-tool.ts`
- subagent 创建链路：`src/agents/subagent-spawn.ts`
- Feishu reply streaming：`extensions/feishu/src/reply-dispatcher.ts`
- Feishu streaming card primitive：`extensions/feishu/src/streaming-card.ts`
- commit `e41b8be` 启用了 Feishu block streaming 默认能力，可参考 `FeishuStreamingSession` 的使用和测试方式；不能把 TaskFlow 事件挂进 `reply-dispatcher`，因为它绑定单次 assistant reply 生命周期。

当前缺口：

- 没有 TaskFlow 权威状态模型。
- `sessions_spawn` 没有可选 `taskFlowId` 参数，无法在确实需要跨 agent 共享状态时传递授权上下文。
- Feishu block streaming 现在绑定 assistant partial/block reply，没有 TaskFlow update 事件源。
- compaction 后 prompt 可继续跑，但 TaskFlow 工具历史若只在 transcript 中，会被压缩影响。

## Requirements

- 复杂任务可创建 TaskFlow，并持久化到本地文件。
- TaskFlow 支持 Markdown checkbox 可视化。
- TaskFlow item 状态变化应尽快同步到 Feishu channel。
- compaction、resume、gateway restart 后，当前 active/blocked TaskFlow 不丢失。
- TaskFlow 默认是 `local` scope，由当前执行 agent 创建、读取和更新。
- Researcher 或 PPT 子 agent 如果自己的内部流程复杂，应自行判断是否创建本地 TaskFlow。
- 主 agent 不因为 spawn 子 agent 而默认创建 coarse TaskFlow item。
- shared TaskFlow 只在用户或任务明确要求跨 agent 共享状态时启用。
- 其他 agent 默认不能读写非自己 owner 的 TaskFlow。
- `taskflow_update` 负责 create/update/complete 等所有写操作。
- `taskflow_read` 负责读取当前 active TaskFlow 或指定 TaskFlow。
- 系统通过 prompt policy 判断何时创建 TaskFlow，运行时只做低风险 guard 和提示。
- 设计应映射 Deepagents `TodoListMiddleware` 的三个面：
  - 提示词
  - 状态
  - 工具
- 提供 OpenClaw TaskFlow Skill，用于模型行为约束和可迁移说明。

## Non Goals

- 不把 TaskFlow 状态写入每条 session message。
- 不在第一版实现复杂 DAG 调度或 worker pool。
- 不让所有 subagent 默认共享 TaskFlow。
- 不让主 agent 默认为 Researcher/PPT 子 agent 创建 coarse TaskFlow item。
- 不让子 agent 的内部 TaskFlow 更新唤醒主 agent 或进入主 agent transcript。
- 不把 Feishu 进度推送耦合进 assistant 文本 streaming pipeline。
- 不要求简单问答、单文件小改、单条命令创建 TaskFlow。

## State Model

新增目录：

```text
src/agents/taskflow/
  types.ts
  ids.ts
  paths.ts
  store.ts
  markdown.ts
  policy.ts
  prompt.ts
```

推荐持久化路径：

```text
<agentDir>/taskflows/index.json
<agentDir>/taskflows/<taskFlowId>.json
<agentDir>/taskflows/events/<taskFlowId>.jsonl
```

`agentDir` 通过 `resolveAgentDir(cfg, agentId)` 得到，默认形态是：

```text
~/.openclaw/agents/<agentId>/agent
```

shared TaskFlow 的 snapshot 和 event log 仍写在 owner agentDir。为了让授权子 agent 能通过 `taskFlowId` 找到 owner snapshot，新增轻量全局索引：

```text
<stateDir>/taskflows/index.json
```

全局索引只保存定位信息，例如 `taskFlowId -> ownerAgentId/ownerSessionKey/snapshotPath/scope`。它不是权威状态源；读写仍以 owner snapshot 为准。

状态结构：

```ts
type TaskFlow = {
  id: string;
  scope: "local" | "shared";
  agentId: string;
  ownerSessionKey: string;
  title: string;
  status: "active" | "blocked" | "parked" | "completed" | "canceled";
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  parkedAt?: string;
  parkedReason?: string;
  activeItemId?: string;
  items: TaskFlowItem[];
  subscribers: TaskFlowSubscriber[];
  permissions: TaskFlowPermission[];
  metadata?: {
    orphanedAt?: string;
    auditEventGaps?: { fromRevision: number; toRevision: number; detectedAt: string }[];
    [k: string]: unknown;
  };
};

type TaskFlowItem = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "canceled";
  parentId?: string;
  assigneeAgentId?: string;
  sourceSessionKey?: string;
  evidence?: TaskFlowEvidence[];
  createdAt: string;
  updatedAt: string;
};
```

更新规则：

- 每次写入递增 `revision`。
- `taskflow_update` 接受 `expectedRevision`，用于并发冲突检测。
- store 写入使用 file lock，参考 `src/hooks/bundled/session-memory/handler.ts` 中 `withFileLock` 的模式。
- JSON snapshot 是权威读取源，JSONL event 是 append-only 审计源。
- 同一 owner session 同时最多一个 **foreground** TaskFlow；foreground = `active` 或 `blocked`。
- `blocked` 表示未结束的阻塞状态，仍属 foreground，仍会被 prompt 注入并占用 foreground 单例。
- `parked` 表示 owner 显式挂起、暂不占当前焦点；不计入 foreground 单例；同一 owner 可同时持有多个 `parked` TaskFlow。
- `create` 仅在当前 owner session 没有 foreground TaskFlow 时允许；存在 `parked` 不阻挡 `create`。
- `park_taskflow` 仅能作用于当前 foreground TaskFlow，转入 `parked` 并记录 `parkedAt` / `parkedReason`。
- `resume_taskflow` 仅在当前 owner session 没有 foreground TaskFlow 时允许；否则返回 conflict，模型需先 `park_taskflow` 或 `complete_taskflow` 当前 foreground。
- `create` 发现 owner session 已有 foreground TaskFlow 时返回 conflict。后续可增加显式 `replaceActive`，但第一版不默认替换。
- snapshot 写入是权威提交点：先 fsync 写 snapshot（带 file lock），再 append JSONL event。event 写失败不回滚 snapshot，仅返回 `success + warning(audit_event_append_failed)`、记 `logger.warn`，并把 revision gap 写入 `metadata.auditEventGaps`。
- snapshot 损坏时返回 `corrupt_snapshot` 工具错误，不自动从 event log 重建。
- event log 重建和 repair CLI 放到 Phase 6。
- owner session archive/delete 不自动修改 TaskFlow status；Phase 6 orphan scanner 会扫描 `active|blocked|parked` 且 updatedAt 超过阈值的孤儿 TaskFlow，写入 `metadata.orphanedAt`，可选归档或 cancel。

## Tool Design

新增工具：

```text
taskflow_read
taskflow_update
```

注册位置：

```text
src/agents/openclaw-tools.ts
src/agents/tools/taskflow-read-tool.ts
src/agents/tools/taskflow-update-tool.ts
```

### taskflow_read

参数：

- `taskFlowId?: string`

（`scope` 列表读取与 `includeEvents` 事件回放属于未实现的候选扩展；在 store 提供对应 API 之前，不进入工具 schema。）

行为：

- 未传 `taskFlowId` 时读取当前 session 的 active/blocked TaskFlow。
- 传入 `taskFlowId` 时先查全局索引定位 owner snapshot，再做 ACL 校验。
- 返回 JSON snapshot 和 Markdown snapshot。
- 对无权限 agent 返回 403 风格工具错误。

### taskflow_update

参数：

- `operation`
  - `create`
  - `upsert_items`
  - `set_item_status`
  - `attach_evidence`
  - `set_active_item`
  - `subscribe_channel`
  - `park_taskflow`
  - `resume_taskflow`
  - `revoke_access`
  - `complete_taskflow`
  - `cancel_taskflow`
- `taskFlowId?: string`
- `expectedRevision?: number`
- `title?: string`
- `items?: TaskFlowItemInput[]`
- `itemId?: string`
- `status?: TaskFlowItemStatus | TaskFlowStatus`
- `evidence?: TaskFlowEvidenceInput`
- `subscriber?: TaskFlowSubscriberInput`
- `reason?: string`（用于 `park_taskflow`）
- `targetSessionKey?: string`（用于 `revoke_access`）

（工具不暴露 `revokeReason`：`revoke_access` operation 恒记录 `revokedReason="manual"`；`subagent_ended`/`expired`/`session_deleted` 只能由系统路径 `revokeAccessForSession` 写入，模型不可伪造。）

行为：

- `create` 创建 TaskFlow，并自动把当前 session 设为 owner；`create` 可原子写入初始 `items`。
- `create` 成功后的 revision 从 `1` 开始，返回的 snapshot 已包含初始 items。
- `create` 如果发现当前 owner session 已有 foreground（`active` 或 `blocked`）TaskFlow，返回 conflict；存在 `parked` 不阻挡 `create`。
- 所有非 create 写操作必须指定 `taskFlowId` 或能从当前 session 解析当前 foreground TaskFlow。
- 工具不接受完整 items 数组替换；所有写入必须通过增量 operation 完成。
- `upsert_items` 按 `itemId` 或客户端临时 key 合并。第一版不做删除，废弃 item 用 `canceled`。
- `complete_taskflow` 只修改 TaskFlow status，不隐式把所有 item 改为 completed。
- `park_taskflow` 只作用于当前 foreground TaskFlow，置为 `parked`，写入 `parkedAt` 与 `parkedReason`；不释放订阅，但 Feishu publisher 会更新 card 为「已挂起」状态而非 close。
- `resume_taskflow(taskFlowId)` 把 `parked` TaskFlow 转回 `active`；当前 owner session 已有 foreground TaskFlow 时返回 conflict。
- `revoke_access(targetSessionKey)` 在 shared scope 下显式撤销指定 child session 的权限，写入 `revokedAt` 与 `revokedReason="manual"`；ACL 变更属于控制面，只有 owner 或该权限的 `grantedBySessionKey` 可调用，`write_all` 数据面权限不隐含此能力。
- 写入成功后返回 `{ taskFlowId, revision, markdown, changedItems, warnings?: string[] }`；`warnings` 在 `audit_event_append_failed` 等情况下非空。
- 写入成功后同步触发 `taskflow_updated` typed plugin hook（即使 event log 写失败也触发，因为 snapshot 已提交）。
- `expectedRevision` 不匹配时**只返回 conflict 元信息**，不返回完整 snapshot，也不自动重试任何 operation。返回结构：

```json
{
  "status": "conflict",
  "code": "revision_conflict",
  "taskFlowId": "tf_123",
  "expectedRevision": 7,
  "actualRevision": 9,
  "affectedItemIds": ["item_a"],
  "message": "TaskFlow changed since expectedRevision. Call taskflow_read, merge your intended change, then retry with the latest revision."
}
```

模型需自行 `taskflow_read` → 合并意图 → 用最新 revision 重试。第一版不为 `attach_evidence` 等"看似可交换"的 operation 做自动合并，避免审计语义模糊。

## Ownership And Scope

TaskFlow 有三类状态边界：

| Scope             | 创建者         | 可见性                      | 用途                                                    |
| ----------------- | -------------- | --------------------------- | ------------------------------------------------------- |
| `local`           | 当前执行 agent | 当前 agent 和 Feishu 进度卡 | 默认模式，Researcher/PPT 子 agent 自己管理内部 TaskFlow |
| `shared`          | 显式授权方     | 被授权的多 agent/session    | 只有跨 agent 共享状态、协作写入、统一恢复时使用         |
| runtime lifecycle | 系统事件       | trace/log/parent completion | spawn started/ended 等运行态事件，不进入 TaskFlow       |

默认规则：

- 每个 agent 独立判断自己的工作是否需要 TaskFlow。
- 父 agent 的 `sessions_spawn` 动作本身不是 TaskFlow 创建条件。
- 子 agent 的 `taskflow_update` 直接写它自己的 TaskFlow，并通过 Feishu publisher 推送进度。
- 主 agent 不被子 agent 内部 TaskFlow 更新唤醒，也不把这些更新写入自己的 transcript。
- 只有显式使用 shared scope 时，`taskFlowId` 和写权限才跨 agent 传递。

## Creation Policy

系统判断是否需要创建 TaskFlow 的方式应是 prompt policy 主导，运行时只做辅助。

创建条件：

- 用户明确要求规划、计划、待办、跟踪状态。
- 当前执行 agent 的任务跨多个步骤、文件、工具或可能跨轮继续。
- 当前执行 agent 的任务有阶段依赖或顺序约束。
- 当前执行 agent 的任务有明显歧义，需要先拆解目标和边界。
- 任务需要 Feishu 中持续展示进度。
- 执行中产生额外步骤，并且这些步骤要在交还用户前完成。
- 任务失败后需要恢复、重试或记录证据。

不创建条件：

- 简单问答。
- 单条命令或单文件小改。
- 一次性查询或无需恢复的轻量操作。
- 用户只是在讨论方案，还没有要求执行。
- 当前 agent 只是 spawn 另一个 agent，且不需要跟踪自己的后续工作。

运行时 guard：

- `taskflow_update(create)` 不由 runtime 自动调用，仍由模型按 prompt policy 决定。
- `sessions_spawn` 不返回 `taskFlowRecommended`，避免把父 agent 变成默认编排者。
- 子 agent 收到任务后按同一套 Creation Policy 判断是否创建自己的 `local` TaskFlow。
- 只有显式传入 `taskFlowId` 或用户要求统一跟踪时，子 agent 才进入 shared TaskFlow 路径。
- **运行时不干预创建频率或简单/复杂判断**。运行时只保留硬约束：foreground 单例、ACL、revision CAS、schema 校验、文件写入安全。
- 创建过度的治理走 metrics 收集 + 后续调优，不在 core 引入启发式。
- 每次 `taskflow_update(create)` 记录以下 metrics（用于后续调 tool description、prompt policy、TaskFlow Skill、channel-specific behavior hints）：
  - `agentId`
  - `ownerSessionKeyKind`（main / subagent / spawn-mode）
  - `channel`（feishu / slack / cli / webchat / …）
  - `promptLengthBucket`（短 / 中 / 长）
  - `initialItemCount`
  - `outcome`（`create_accepted` / `create_conflict_foreground_occupied`）
  - 后续：`completedWithinTurns` / `canceledWithinTurns` / `lifetimeSeconds`

## Prompt And Cache Strategy

新增 prompt 构造：

```text
src/agents/taskflow/prompt.ts
src/hooks/bundled/taskflow/handler.ts
```

注入方式：

- 在 `before_prompt_build` 中读取当前 foreground（`active` 或 `blocked`）TaskFlow；`parked` 只注入一行短摘要。
- 通过 `prependContext` 注入短 Markdown 快照。
- **注入只在 turn 边界发生**：同一 turn 内 `taskflow_update` 成功后不重新构造 prompt；turn 内最新状态以工具返回值为准，下一个 turn 再从 snapshot 重新注入。
- **注入保留 `revision`，去掉 `updatedAt`**：`revision` 必须保留，否则模型无法判断自己的 `expectedRevision` 是否来自注入快照；`updatedAt` 高频变化、对决策价值低、会反复击穿 cache。
- 不修改基础 system prompt 主体，避免让稳定 prompt cache 因 TaskFlow 状态频繁失效。

示例注入：

```markdown
## Active TaskFlow

TaskFlow: tf_123
Revision: 7
Status: active

- [x] 收集当前架构入口
- [ ] 设计 taskflow_update 工具
  - [~] Feishu streaming bridge
- [ ] 补测试和文档

Rules:

- Update this TaskFlow with taskflow_update when item status changes.
- If taskflow_update returns revision_conflict, call taskflow_read, merge your intended change, then retry with the latest revision.
```

存在 `parked` TaskFlow 时，在 active 快照之后追加一行短摘要（不展开 items，避免污染当前上下文）：

```markdown
## Parked TaskFlows

Parked: 2 (tf_abc, tf_def). Use taskflow_read to inspect or resume_taskflow to continue.
```

说明：

- Markdown 中 `[~]` 只作为展示状态，状态源仍是 JSON。
- 注入内容设置最大字符数，例如 4000 chars。
- completed 历史过长时只注入最近完成项和未完成项。
- prompt cache 影响限定在本轮 user prompt 前缀，不污染稳定 system prompt。

## Feishu Progress Streaming

当前 Feishu streaming 链路：

```text
agent reply partial/block
  -> createFeishuReplyDispatcher
  -> onPartialReply / deliver(block|final)
  -> FeishuStreamingSession.start/update/close
```

TaskFlow 需要新增事件桥：

```text
taskflow_update
  -> TaskFlowStore.write
  -> taskflow_updated typed plugin hook
  -> TaskFlowFeishuPublisher
  -> renderTaskFlowMarkdown
  -> FeishuStreamingSession.start/update
```

新增文件：

```text
extensions/feishu/src/taskflow-progress.ts
extensions/feishu/src/taskflow-progress.test.ts
```

订阅来源：

- `taskflow_update(operation="subscribe_channel")`
- Feishu 入站上下文中创建 `local` TaskFlow 时，自动订阅当前 chat：
  - `channel="feishu"`
  - `accountId`
  - `to/chatId`
  - `threadId/replyToMessageId` 可选
- 子 agent 创建 `local` TaskFlow 时，如果它继承了 Feishu delivery context，**只订阅它自己 session 所属 chat，默认不订阅父 chat**。父 agent 不会被推送子 agent 的 local TaskFlow card，也不会被子 agent 的进度唤醒。如需让父 chat 看到子 agent 的进度，子 agent 必须显式调用 `subscribe_channel` 指向父 chat。

发送策略：

- 每个 `taskFlowId + accountId + chatId` 维护一个 streaming session。
- 第一次 update 创建 card。
- 后续 revision 更新同一 card content。
- `completed | canceled` 后 close streaming mode。
- `blocked` 更新 card，但不 close streaming mode。
- 更新频率做 coalescing，例如 300-800ms，避免 Feishu API 抖动。
- publisher 记录 `lastDeliveredRevision`，重复 revision 不发送。
- Feishu 不可用时，TaskFlow 状态仍写入本地；publisher 只记录 delivery error。
- publisher 不唤醒主 agent，不把子 agent 的 TaskFlow 更新写入主 agent transcript。
- 主 agent 后续只能通过 completion、handoff、`delivery.json` 或显式 `taskflow_read` 获取最终状态。
- `TaskFlowFeishuPublisher` 复用 `FeishuStreamingSession`，不复用 `createFeishuReplyDispatcher`。`reply-dispatcher` 绑定单次 assistant reply 生命周期；TaskFlow publisher 绑定 `taskFlowId + subscriber` 生命周期。

Markdown 渲染：

```text
src/agents/taskflow/markdown.ts
```

渲染约束：

- 标题、revision、status、更新时间。
- checkbox 展示 pending/completed。
- in_progress 用文本标记，例如 `[~]`。
- blocked/canceled 用短文本标记。
- 证据路径或子 agent sessionKey 作为附加行，超过长度截断。

## Subagent Boundary And Optional Sharing

默认情况下，子 agent 的 TaskFlow 是它自己的 `local` TaskFlow。主 agent 只委派任务，不创建父级 coarse item，也不监听子 agent 内部 TaskFlow。

当前 `sessions_spawn` 参数没有 TaskFlow 字段。为 shared scope 保留可选扩展：

```text
src/agents/tools/sessions-spawn-tool.ts
src/agents/subagent-spawn.ts
```

新增参数：

- `taskFlowId?: string`
- `taskFlowAccess?: "read" | "write_assigned" | "write_all"`
- `taskFlowScope?: "shared"`

默认行为：

- 不自动传递父 session 的 active TaskFlow。
- 不因为目标 agent 是 `researcher` 或 PPT 子 agent 而自动授权。
- `completionDelivery="direct"` 的 Researcher 结果直接交付给用户，不进入主 agent TaskFlow。
- same-agent PPT 子 agent 如果内部流程长，可自己创建 `local` TaskFlow 并直接推送 Feishu card。

shared 传播方式：

- 在 child task message 中追加短上下文：

```text
[TaskFlow Context]
taskFlowId=tf_123
access=write_assigned
Use taskflow_read before modifying shared state.
Use taskflow_update with expectedRevision when status changes.
```

- 在 TaskFlowStore permissions 中增加 child session 权限：

```ts
type TaskFlowPermission = {
  sessionKey: string;
  access: "read" | "write_assigned" | "write_all";
  grantedBySessionKey: string;
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedReason?: "subagent_ended" | "manual" | "expired" | "session_deleted";
};
```

ACL 规则：

- owner session full access。
- child session 只能访问授权 TaskFlow。
- `write_assigned` child session 只能写 `assigneeAgentId` 指向自己的 item、其子 item 和这些 item 的 evidence。
- `write_all` child session 可写整张 shared TaskFlow，必须显式传入。
- 父 session 可写全部 item。
- 其他 agent 默认无权限，即使知道 `taskFlowId`。
- ACL 校验只认 `revokedAt` 为空 **且** `expiresAt` 未过期的权限。

权限回收机制（按优先级）：

1. **正常结束**：`subagent_ended` typed plugin hook 触发自动 `revoke_access(revokeReason="subagent_ended")`。session 模式（`mode="session"`）的持久子 agent 不在单次 run 完成（`run_ended`）时 revoke，只在 `subagent_ended`、archive/delete 或手动 revoke 时回收。
2. **中途取消**：owner 调用 `taskflow_update(operation="revoke_access", targetSessionKey, revokeReason="manual")`。
3. **异常残留兜底**：`expiresAt` TTL 到期；Phase 6 orphan scanner 在 owner session 已 archive 时回收残留权限。
4. **session 删除**：session archive/delete 时通过 hook 写 `revokeReason="session_deleted"`。

适用 shared scope 的场景：

- 用户明确要求主 agent 统一跟踪多个 agent 的状态。
- 多个子 agent 需要读写同一张任务清单。
- 任务失败恢复必须依赖跨 agent 共享状态。
- 交付链路需要统一验收多个子任务。

不适用 shared scope 的场景：

- Researcher 单次 direct completion。
- Researcher export-file 后续由用户另行要求发送。
- PPT same-agent child 只需要自己展示 analyze/apply/verify/deliver 进度。
- 父 agent 只是发起 spawn 并等待最终 completion。

## Deepagents Middleware Mapping

OpenClaw 侧对应 Deepagents `TodoListMiddleware`：

| Middleware 面     | OpenClaw 实现                                              |
| ----------------- | ---------------------------------------------------------- |
| 提示词            | `src/agents/taskflow/prompt.ts` + `before_prompt_build`    |
| 状态              | `src/agents/taskflow/store.ts` + agentDir local files      |
| 工具              | `taskflow_read` + `taskflow_update`                        |
| 状态变化事件      | `taskflow_updated` typed plugin hook                       |
| 子 agent 生命周期 | `subagent_ended` typed plugin hook 自动 revoke shared 权限 |
| 可视化            | `src/agents/taskflow/markdown.ts` + Feishu publisher       |

这应作为 core feature 实现。可再提供 OpenClaw TaskFlow Skill，负责告诉模型何时创建、何时更新、如何和 subagent 协作，但 skill 不作为权威状态源。

新增 Skill：

```text
workspace/skills/taskflow/SKILL.md
```

Skill 是 Phase 5 增强，不是 TaskFlow core 能力的启用条件。Skill 内容只写行为合同：

- 何时创建 TaskFlow。
- 何时更新 item 状态。
- 子 agent 如何独立判断是否创建本地 TaskFlow。
- 只有 shared scope 才传递 `taskFlowId`。
- 失败时如何标记 blocked 并附 evidence。

## Error Recovery

### Revision conflict

链路：

```text
taskflow_update(expectedRevision=7)
  -> store 当前 revision=9
  -> 返回 conflict { code: revision_conflict, expectedRevision: 7, actualRevision: 9, affectedItemIds }
  -> 模型 taskflow_read
  -> 合并意图后用 latest revision 重试
```

第一版不为任何 operation 做自动合并：`attach_evidence` 等"看似可交换"的 operation 也可能因为 item 已 canceled、权限已变更或 active item 已移动而不可交换。自动合并会让审计语义模糊。

### Snapshot vs event log 不一致

snapshot 是权威源，event log 是审计源。双写顺序与失败语义：

- snapshot 写入是权威提交点：先 fsync 写 snapshot（带 file lock）。
- 成功后再 append JSONL event。
- snapshot 写失败：update 失败，不递增可见 revision，不触发 `taskflow_updated`。
- snapshot 写成功 + event 写失败：update 视为成功；返回 `{ status: success, warnings: ["audit_event_append_failed"] }`；记 `logger.warn`；在 `metadata.auditEventGaps` 记录 `{ fromRevision, toRevision, detectedAt }`；仍触发 `taskflow_updated`。

后果：snapshot revision 与 event log tail revision 可能不同步（snapshot > event tail）。第一版不实现 event replay，所以 event gap 不影响 `taskflow_read`、prompt 注入、compaction 恢复或 Feishu publisher，只影响审计完整性和未来 repair 工具的可用性。Phase 6 的 repair CLI 会基于 `metadata.auditEventGaps` 提示需要人工核对的范围。

### Tool failure

- `after_tool_call` 可观察 tool error。
- 第一版不自动改 TaskFlow，避免误判。
- prompt policy 要求模型在关键工具失败后标记 item `blocked` 或附 evidence。
- 后续可增加 `tools.taskflow.autoAttachToolErrors=true`，把失败摘要挂到 active item evidence。

### Compaction

- compaction 只影响 transcript。
- foreground（active/blocked）TaskFlow 通过 `ownerSessionKey` 从 TaskFlowStore 查询并重新注入。
- `parked` TaskFlow 通过短摘要注入（count + ids），不展开 items。
- 第一版不在 `before_compaction` 中写 session metadata hint，避免维护第二份恢复状态。
- `before_compaction` metadata hint 可在 Phase 6 作为性能或迁移优化加入。

### Owner session archive/delete

- archive/delete 一个 owner session 不自动修改其名下 TaskFlow 的 status。
- archive 后该 session 不再 build prompt，所以也不会再注入它名下的 TaskFlow；这些文件只是可读历史。
- `taskflow_read(taskFlowId)` 仍可读取，只要文件存在。
- Phase 6 orphan scanner 扫描 `active|blocked|parked` 且 `updatedAt` 超过阈值、owner session 已 archive/delete 的 TaskFlow，写入 `metadata.orphanedAt`，可选归档或 cancel，并 close 对应 Feishu subscriber。

### Gateway restart

- typed plugin hook 没有持久状态，gateway restart 不影响 TaskFlowStore。
- Feishu publisher 重启后读取 active subscribers。
- 下一次 `taskflow_update` 会重新创建或更新 Feishu card。
- 若需要主动恢复，可在 `gateway_start` 扫描 active TaskFlow subscribers。

## Implementation Steps

### Phase 1: Core state and renderer

1. 新增 `src/agents/taskflow/types.ts`。
2. 新增 `paths.ts`，从 `resolveAgentDir(cfg, agentId)` 派生 taskflows 路径。
3. 新增 `store.ts`，支持 read/create/update/list active 和全局索引定位。
4. 新增 file lock 和 revision CAS。
5. 强制 owner session active/blocked 单例。
6. 新增 `markdown.ts`，输出稳定 Markdown checklist。
7. JSONL event log 作为审计记录写入，不实现 event replay。
8. 增加单元测试覆盖 schema、状态迁移、CAS、active 单例、Markdown。

### Phase 2: Tools and prompt injection

1. 新增 `taskflow_read` 和 `taskflow_update`。
2. 在 `createOpenClawTools` 注册工具，并传入 `agentId/sessionKey/agentDir/config/messageChannel/accountId`。
3. 新增 `src/hooks/bundled/taskflow/handler.ts`。
4. 在 `before_prompt_build` 通过 `ownerSessionKey` 注入 active/blocked TaskFlow 快照。
5. 增加 prompt 注入测试，确认无 active TaskFlow 时不注入。
6. 增加 create-with-items、禁止完整数组替换、blocked 继续注入的工具测试。

### Phase 3: Feishu progress publisher

1. 新增 `taskflow_updated` typed plugin hook。
2. `taskflow_update` 写入成功后触发 hook。
3. 在 Feishu extension 中新增 `TaskFlowFeishuPublisher`。
4. 复用 `FeishuStreamingSession` 发送和更新 card，不复用 `reply-dispatcher`。
5. 支持 `subscribe_channel` 记录 Feishu chat subscriber。
6. Feishu 入站创建 local TaskFlow 时自动订阅当前 chat。
7. 增加 fake publisher 测试，覆盖 revision coalescing、blocked 不 close、complete close、send failure 不影响 store。

### Phase 4: Subagent boundary and optional sharing

1. 扩展 `sessions_spawn` schema，增加可选 `taskFlowId`、`taskFlowAccess` 和 `taskFlowScope`。
2. 默认不解析或传递父 active TaskFlow。
3. 仅当 `taskFlowScope="shared"` 且传入 `taskFlowId` 时，为 child session 授权。
4. shared child prompt 增加 TaskFlow Context。
5. `local` child TaskFlow 使用 child session 自己的 owner session 和 Feishu subscriber。
6. TaskFlowStore enforcement 根据 scope、sessionKey 和 `read|write_assigned|write_all` 做 ACL。
7. 增加默认不共享、显式 shared assigned 可写、write_all 可写、非授权 denied 测试。

### Phase 5: Skill and documentation

1. 新增 `workspace/skills/taskflow/SKILL.md` 作为可迁移行为合同。
2. 更新相关 agent workspace 同步配置，让需要额外行为提示的 Feishu workspace 和子 agent workspace 能看到 skill。
3. 更新 `docs/concepts/agent-loop.md`，补充 TaskFlow state 注入和 event bridge。
4. 更新 `docs/concepts/session-tool.md`，补充 `sessions_spawn` 的 optional shared TaskFlow 参数和默认不共享规则。
5. 如暴露给用户配置，更新配置文档和 schema help。

### Phase 6: Hardening

1. 增加 `gateway_start` 恢复 active subscribers 的可选扫描。
2. 增加 orphaned TaskFlow 清理策略。
3. 增加 completed TaskFlow archive 策略。
4. 增加 event log 重建工具函数。
5. 如需要，增加 `before_compaction` metadata hint。

## Testing Strategy

Unit:

- `src/agents/taskflow/store.test.ts`
- `src/agents/taskflow/markdown.test.ts`
- `src/agents/taskflow/prompt.test.ts`
- `src/agents/tools/taskflow-update-tool.test.ts`
- `src/agents/tools/taskflow-read-tool.test.ts`
- `src/hooks/bundled/taskflow/handler.test.ts`
- `src/agents/openclaw-tools.taskflow.test.ts`
- `src/plugins/wired-hooks-taskflow.test.ts`

Subagent:

- `src/agents/openclaw-tools.subagents.taskflow-default.test.ts`
- `src/agents/subagent-spawn.taskflow-shared.test.ts`
- `src/agents/subagent-spawn.taskflow-local.test.ts`

Feishu:

- `extensions/feishu/src/taskflow-progress.test.ts`
- fake `FeishuStreamingSession`，不打真实 Feishu API。

Targeted commands:

```text
pnpm vitest run src/agents/taskflow src/agents/tools/taskflow-*.test.ts src/hooks/bundled/taskflow/handler.test.ts src/plugins/wired-hooks-taskflow.test.ts
pnpm vitest run src/agents/openclaw-tools.subagents.taskflow-default.test.ts src/agents/subagent-spawn.taskflow-shared.test.ts src/agents/subagent-spawn.taskflow-local.test.ts
pnpm vitest run --config vitest.extensions.config.ts extensions/feishu/src/taskflow-progress.test.ts
```

不建议第一轮直接跑 full `pnpm test`，因为当前 AGENTS 指令要求完整测试需用户确认。

## Risks And Mitigations

- Risk: TaskFlow 更新太频繁，Feishu card 更新打爆 API。
  - Mitigation: publisher 按 revision 去重并 coalesce。
- Risk: prompt 中 TaskFlow 快照太长影响模型上下文和 cache。
  - Mitigation: 限制注入长度，只保留 active/blocked/pending 和最近完成项。
- Risk: shared TaskFlow 中 subagent 并发写冲突。
  - Mitigation: `expectedRevision` CAS，冲突后 read-merge-retry。
- Risk: 子 agent 内部 TaskFlow 进度污染主 agent 上下文。
  - Mitigation: `local` scope 默认不写入主 agent transcript，Feishu publisher 通过 `taskflow_updated` hook 消费 TaskFlow 事件。
- Risk: 子 agent 越权改 shared TaskFlow。
  - Mitigation: sessionKey ACL，只在显式 `taskFlowScope="shared"` 时授予 `read|write_assigned|write_all`。
- Risk: Feishu 发送失败让任务状态回滚。
  - Mitigation: store 写入先完成，publisher failure 只记录 delivery error。
- Risk: Markdown 展示和 JSON 状态不一致。
  - Mitigation: Markdown 全量从 JSON 渲染，不接受 Markdown 反向解析为状态。
- Risk: 模型过度创建 TaskFlow。
  - Mitigation: prompt policy 明确简单任务不创建，后续从 usage metrics 调整。
- Risk: 全局索引与 owner snapshot 不一致。
  - Mitigation: snapshot 是权威源，索引只定位；读到缺失或不匹配 snapshot 时返回可诊断错误并允许重建索引。

## Success Criteria

- [ ] 复杂任务可通过 `taskflow_update(create)` 创建持久化 TaskFlow。
- [ ] `create` 可原子写入初始 items。
- [ ] 同一 owner session 同时最多一个 foreground（`active` 或 `blocked`）TaskFlow；`parked` 不计入。
- [ ] `park_taskflow` 把当前 foreground 转入 `parked`，释放 foreground 单例；`resume_taskflow` 仅在无 foreground 时允许。
- [ ] `taskflow_update` 是唯一写入口，所有写入递增 revision。
- [ ] `taskflow_update` 不允许完整替换 items 数组。
- [ ] revision 冲突只返回 `{ code: revision_conflict, expectedRevision, actualRevision, affectedItemIds, message }`，不返回 snapshot，不自动合并。
- [ ] snapshot 写失败时不递增 revision、不触发 hook；event 写失败时返回 success + warning，仍触发 hook。
- [ ] `taskflow_read` 可返回 JSON 和 Markdown 快照；owner session archive 后仍可读。
- [ ] compaction 后 foreground TaskFlow 仍会被注入 prompt；`parked` 只注入一行短摘要。
- [ ] prompt 注入保留 revision、不包含 updatedAt；同一 turn 内不重新注入。
- [ ] Feishu 入站创建 local TaskFlow 时自动订阅当前 chat。
- [ ] 子 agent local TaskFlow 只订阅自己 session 所属 chat，不推父 chat。
- [ ] Feishu 中 TaskFlow 状态变化能通过 `taskflow_updated` hook 更新同一张 streaming card。
- [ ] completed/canceled TaskFlow 会 close Feishu streaming card。
- [ ] blocked TaskFlow 会更新 Feishu card，但不会 close streaming card。
- [ ] parked TaskFlow 把 Feishu card 更新为「已挂起」，但不 close。
- [ ] Researcher/PPT 子 agent 可自行创建 `local` TaskFlow，并直接通过 Feishu publisher 展示内部进度。
- [ ] 主 agent 不因子 agent `local` TaskFlow 更新而被唤醒或写入 transcript。
- [ ] shared TaskFlow 只在显式传入 `taskFlowId` 和 `taskFlowScope="shared"` 时跨 agent 授权。
- [ ] shared 子 agent 默认只能 `write_assigned`，`write_all` 必须显式授予。
- [ ] `subagent_ended` hook 自动 revoke 该 sessionKey 的 shared 权限；`mode="session"` 子 agent 只在 `subagent_ended`（非 `run_ended`）时 revoke。
- [ ] owner 可通过 `revoke_access(targetSessionKey, revokeReason)` 手动撤销权限。
- [ ] ACL 校验只认 `revokedAt` 为空且 `expiresAt` 未过期的权限。
- [ ] 非授权子 agent 无法读写其他 session 的 TaskFlow。
- [ ] `complete_taskflow` 不移动文件、不自动归档；遗留 pending item 保留为可读历史。
- [ ] `taskflow_update(create)` 不被运行时干预；创建 metrics（agentId、sessionKind、channel、promptBucket、initialItemCount、outcome）会被记录。
- [ ] prompt cache 主要保持基础 system prompt 稳定，TaskFlow 只作为动态 prepend context。
- [ ] 相关单元测试和 Feishu extension 测试通过。
