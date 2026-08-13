# Implementation Plan: TaskFlow 持续执行约束

## Overview

修复 TaskFlow 在恢复后只更新状态、没有安排执行者，却仍向用户承诺“继续处理”的问题。方案引入运行级 `TaskFlowContinuationTracker`，只对当前回合存在活跃 TaskFlow 或成功 TaskFlow 变更的场景建立持续执行义务，并在回复完成前通过状态判断确认任务已经完成、明确挂起，或存在活跃的 tracked descendant。

校验复用现有 run completion contract 的受限重试机制。普通会话没有持续执行义务，只经过一次内存布尔判断，不新增 TaskFlow 状态读取、模型重试或消息延迟。现有自动 park 逻辑继续作为最终兜底。

## Decision Summary

```text
┌────────────────────┬──────────────────────────────────────────────┐
│ 决策               │ 方案                                         │
├────────────────────┼──────────────────────────────────────────────┤
│ 判断依据           │ TaskFlow 状态和 tracked descendant 状态       │
│ 触发范围           │ 活跃 TaskFlow 或本回合成功变更 TaskFlow       │
│ 普通会话           │ tracker 未激活，常数级返回                    │
│ 校验时点           │ attempt 完成、payload 构建和正常返回之前      │
│ 修复动作           │ 复用 completion contract，继续同一个 run      │
│ 重试上限           │ TaskFlow 专用一次修复重试                     │
│ 重试失败           │ 自动 park，返回明确的未启动执行错误           │
│ 最终兜底           │ 保留现有 finalization_missing 自动 park       │
│ 文本识别           │ 不依赖“继续处理”等自然语言模式                │
└────────────────────┴──────────────────────────────────────────────┘
```

## Requirements

- TaskFlow 在当前回合被创建、恢复或观察为 active 且包含 `in_progress` 项时，建立持续执行义务。
- 正常结束用户可见回合前，必须满足以下任一条件：
  - TaskFlow 已完成、取消、阻塞或明确挂起。
  - TaskFlow 不再包含 `in_progress` 项。
  - 同一 TaskFlow 存在尚未结束的 tracked descendant run。
- 没有 TaskFlow 的普通问答、闲聊和简单工具调用不得执行完整状态校验。
- 校验必须基于持久化 TaskFlow 快照和 subagent registry，不能依赖模型回复文本。
- 校验失败后，模型必须继续当前任务，启动 tracked descendant，或明确变更 TaskFlow 状态。
- TaskFlow 专用修复重试最多一次，避免模型进入无限继续循环。
- 重试失败时必须明确告诉用户任务没有进入执行状态，并将 TaskFlow 挂起。
- 已经通过 message tool 产生的外部副作用不能在修复重试中重复执行。
- 现有 `finalization_missing` 自动 park 行为保留，覆盖未进入新约束路径的异常情况。
- 第一阶段覆盖现有 completion-contract-enabled surfaces，重点包括 Feishu、subagent 和 researcher。
- 不改变普通 `sessions_spawn`、TaskFlow store schema、Feishu 卡片协议和外部工具参数。

## Non-goals

- 不实现通用后台任务调度器。
- 不自动把任意 active TaskFlow 转成 subagent。
- 不通过关键词判断模型是否承诺继续工作。
- 不让 parked TaskFlow 自动恢复。
- 不改变 pending-only TaskFlow 的现有语义。
- 不修改 TaskFlow 持久化格式或进行数据迁移。
- 不在本次修复中处理 blocked subagent handoff 的格式兼容问题。

## Current Behavior

### Failure Chain

```text
用户追问
  -> taskflow_update(resume_taskflow)
  -> TaskFlow status = active
  -> 模型读取文件
  -> 模型回复“继续处理”
  -> 当前 run 正常结束
  -> finalizeForegroundTaskFlow()
  -> 有 in_progress，且没有 active descendant
  -> park_taskflow(reason = finalization_missing)
  -> 后续没有执行者
```

### Existing Reusable Mechanisms

- `src/agents/pi-embedded-runner/run/completion.ts`
  - 已能识别不完整 attempt，并生成 continuation prompt。
- `src/agents/pi-embedded-runner/run.ts`
  - 已有有界 continuation loop、工具策略、终态错误和 lifecycle event。
- `src/agents/taskflow/finalization.ts`
  - 已能读取 foreground TaskFlow，并判断 active descendant。
- `src/agents/taskflow/prompt.ts`
  - 每次 attempt 已读取 foreground TaskFlow，用于注入 prompt。
- `src/agents/tools/taskflow-update-tool.ts`
  - 能在成功 mutation 后拿到最新 TaskFlow snapshot。

当前缺口在于这些信息没有汇聚成 run 级持续执行约束。completion contract 主要检查文本和工具循环，TaskFlow finalization 发生在回复已经准备完成之后。

## Target Behavior

```text
attempt 开始
  -> prompt loader 观察 foreground TaskFlow
  -> TaskFlow tool mutation 更新 tracker
  -> attempt 结束
  -> tracker 未激活
       -> 普通完成流程
  -> tracker 已激活
       -> 读取最新 TaskFlow snapshot
       -> terminal / no in_progress
            -> 普通完成流程
       -> active descendant 存在
            -> 普通完成流程
       -> active + in_progress + no executor
            -> completion continuation
            -> 要求继续执行、spawn tracked child 或显式 park/block
            -> 再校验一次
            -> 仍失败则 park 并返回明确错误
```

## Architecture Changes

### 1. Run-scoped TaskFlow tracker

新增 `src/agents/taskflow/continuation.ts`：

- 定义 `TaskFlowContinuationTracker`。
- 保存当前 run 观察到的 TaskFlow ID、最新 revision 和 `relevant` 状态。
- `observeSnapshot(snapshot)` 只在以下情况激活 tracker：
  - snapshot 为 active，且包含 `in_progress` 项。
  - 当前 run 成功执行了 create、resume 或状态更新，结果仍需持续执行。
- 提供 `assessTaskFlowContinuation()`：
  - tracker 未激活时返回 `not_applicable`。
  - TaskFlow 已终止、blocked、parked 或无 `in_progress` 时返回 `satisfied`。
  - 存在 active tracked descendant 时返回 `satisfied`。
  - active、含 `in_progress`、无执行者时返回 `continuation_required`。
- active descendant 判断复用 `taskflow/finalization.ts` 当前逻辑，避免两套定义漂移。

建议类型：

```ts
type TaskFlowContinuationAssessment =
  | { status: "not_applicable" }
  | {
      status: "satisfied";
      reason: "terminal_taskflow" | "no_in_progress" | "active_descendant";
      taskFlowId: string;
    }
  | {
      status: "continuation_required";
      reason: "active_in_progress_without_executor";
      taskFlowId: string;
      revision: number;
      title: string;
    };
```

### 2. Observe existing prompt state

扩展 `src/agents/taskflow/prompt.ts`：

- 保留 `buildTaskFlowPromptContext()` 的字符串返回契约。
- 增加可选 `onForegroundTaskFlow` observer。
- foreground snapshot 读取成功后，同时交给 run-scoped tracker。
- 没有 foreground TaskFlow 时不激活 tracker。

这样普通会话继续复用现有 prompt lookup，不增加额外 TaskFlow store 读取。

### 3. Observe TaskFlow mutations

沿工具创建链透传 observer：

- `src/agents/tools/taskflow-update-tool.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-tools.ts`
- `src/agents/pi-embedded-runner/run/params.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

`taskflow_update` 在 `createTaskFlow()` 或 `applyTaskFlowOperation()` 返回 success 后调用 observer，并传入结果 snapshot。失败、revision conflict 和只读操作不改变 tracker。

observer 只传递内存对象，不写入 store，不改变工具 JSON 返回。

### 4. Completion contract integration

扩展 `src/agents/pi-embedded-runner/run/completion.ts`：

- 增加 `taskflow_continuation_required` completion class。
- continuation prompt 明确要求模型完成以下一项：
  - 在当前 run 继续完成 TaskFlow。
  - 调用 `sessions_spawn`，使用 `taskFlowTracking="current"`。
  - 调用 `taskflow_update` 明确 park、block、cancel 或 complete。
- TaskFlow continuation 使用 `toolPolicy: "normal"`，确保模型可以 spawn 和更新状态。
- prompt 明确禁止重复已经完成的 message、文件发送和其他外部副作用。
- 不增加自然语言匹配规则。

建议 continuation prompt：

```text
The current TaskFlow still has in-progress work but no active tracked executor.
Do not end with another progress update.

Before ending this run, do one of the following:
1. Continue and complete the tracked work now.
2. Start a run-mode child with taskFlowTracking="current".
3. Explicitly park, block, cancel, or complete the TaskFlow with an accurate reason.

Do not repeat any user-facing delivery or mutating side effect that already succeeded.
```

### 5. Pre-return enforcement

修改 `src/agents/pi-embedded-runner/run.ts`：

- 在现有 `assessRunCompletion(attempt)` 后执行 TaskFlow continuation assessment。
- 普通 completion 已完成但 TaskFlow assessment 为 `continuation_required` 时，覆盖为 TaskFlow completion class。
- TaskFlow continuation 使用独立 bucket 和最多一次 retry。
- retry 后重新读取最新 snapshot 和 subagent registry，不能复用旧判断。
- 满足约束后进入现有 payload build 和正常返回。
- continuation 达到上限后：
  - 调用 `park_taskflow`，reason 使用 `continuation_contract_exhausted`。
  - 返回明确用户错误，说明没有活跃执行者。
  - lifecycle error kind 使用 `taskflow_continuation_contract`。
- `didSendViaMessagingTool` 为 true 时，retry prompt 必须限制为生命周期修复，不能重新发送同一结果。

### 6. Finalization fallback

调整 `src/agents/taskflow/finalization.ts`：

- 导出可复用的 active descendant 判断。
- 保留当前 `finalizeForegroundTaskFlow()`。
- 新约束已经处理的正常路径不应再触发 park。
- 未进入 completion contract、异常 provider 路径或旧调用方仍由 `finalization_missing` 兜底。
- 日志区分：
  - `continuation_required`
  - `continuation_recovered`
  - `continuation_exhausted`
  - `finalization_missing`

### 7. Skill contract

在 source worktree 新增或同步 `workspace/skills/taskflow/SKILL.md`，补充以下规则：

```text
调用 create 或 resume_taskflow 后，如果仍有 in_progress 项，当前回合结束前必须：
1. 完成这些事项；
2. 启动 taskFlowTracking=current 的活跃 run-mode child；
3. 明确 park、block、cancel 或 complete TaskFlow。

不得只回复“继续处理”后结束回合。
```

该规则减少运行时约束触发次数。运行时状态判断仍是正确性保障。

## Implementation Steps

### Phase 1: 状态模型与复用判断

1. **提取 active descendant 判断**
   - File: `src/agents/taskflow/finalization.ts`
   - Action:
     - 将 `hasActiveDescendantRunForTaskFlow()` 改为可复用导出。
     - 保持现有匹配 `taskFlowId` 和 `trackingTaskFlowId` 的语义。
   - Why: continuation guard 和 finalization 必须共享同一执行者定义。
   - Dependencies: None.
   - Risk: Low.

2. **新增 continuation tracker 和 assessment**
   - File: `src/agents/taskflow/continuation.ts`
   - Action:
     - 创建 run-scoped tracker。
     - 实现 snapshot relevance 判断。
     - 实现最新状态读取和 continuation assessment。
     - tracker 未激活时不得创建 store 或读取磁盘。
   - Why: 普通会话需要常数级跳过，TaskFlow 会话需要状态驱动判断。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **增加 continuation 单元测试**
   - File: `src/agents/taskflow/continuation.test.ts`
   - Action:
     - 覆盖未激活、terminal、parked、blocked、pending-only、active descendant、ended descendant 和 orphaned active flow。
     - 断言未激活路径不调用 store。
   - Why: 固定状态机边界，避免 runner 测试承担全部组合。
   - Dependencies: Step 2.
   - Risk: Low.

### Phase 2: 运行时观察链

4. **从 prompt loader 观察 foreground snapshot**
   - Files:
     - `src/agents/taskflow/prompt.ts`
     - `src/agents/taskflow/prompt.test.ts`
   - Action:
     - 增加可选 observer。
     - 保持原字符串输出兼容。
     - 验证无 foreground 时 observer 不触发。
   - Why: 复用现有 TaskFlow 读取，避免普通会话新增 I/O。
   - Dependencies: Step 2.
   - Risk: Low.

5. **从 mutation tool 观察最新 snapshot**
   - Files:
     - `src/agents/tools/taskflow-update-tool.ts`
     - `src/agents/tools/taskflow-update-tool.test.ts`
     - `src/agents/openclaw-tools.ts`
     - `src/agents/openclaw-tools.taskflow.test.ts`
   - Action:
     - 为 tool options 增加内部 observer。
     - create/apply success 后上报 snapshot。
     - error 和 revision conflict 不上报。
   - Why: 捕获同一 attempt 内 create/resume 后出现的新持续执行义务。
   - Dependencies: Step 2.
   - Risk: Medium.

6. **透传 run-scoped tracker**
   - Files:
     - `src/agents/pi-tools.ts`
     - `src/agents/pi-embedded-runner/run/params.ts`
     - `src/agents/pi-embedded-runner/run/types.ts`
     - `src/agents/pi-embedded-runner/run/attempt.ts`
     - `src/agents/pi-embedded-runner/run.ts`
   - Action:
     - run 开始时创建 tracker。
     - 每个 continuation attempt 复用同一个 tracker。
     - prompt observer 和 TaskFlow mutation observer 指向该 tracker。
   - Why: obligation 必须跨同一 run 的多个 attempt 持续存在。
   - Dependencies: Steps 4-5.
   - Risk: Medium.

### Phase 3: Completion contract enforcement

7. **扩展 completion classification**
   - Files:
     - `src/agents/pi-embedded-runner/run/completion.ts`
     - `src/agents/pi-embedded-runner/run/completion.test.ts`
   - Action:
     - 增加 TaskFlow continuation class。
     - 生成状态驱动 continuation prompt。
     - 工具策略固定为 normal。
     - 不修改现有非终态文本正则。
   - Why: 复用成熟的受限重试和错误终态机制。
   - Dependencies: Step 2.
   - Risk: Medium.

8. **在正常返回前执行 TaskFlow assessment**
   - Files:
     - `src/agents/pi-embedded-runner/run.ts`
     - `src/agents/pi-embedded-runner/run.taskflow-finalization.test.ts`
     - `src/agents/pi-embedded-runner/run.completion-contract.test.ts`
   - Action:
     - 普通 completion assessment 后追加 TaskFlow assessment。
     - continuation required 时执行一次修复 attempt。
     - 每次 attempt 后重新校验最新状态。
     - 达到上限时 park 并返回明确错误。
   - Why: 阻止“恢复后无执行者”的 run 正常结束。
   - Dependencies: Steps 6-7.
   - Risk: High.

9. **保留和验证 finalization fallback**
   - Files:
     - `src/agents/taskflow/finalization.ts`
     - `src/agents/pi-embedded-runner/run.taskflow-finalization.test.ts`
   - Action:
     - 保留原有 orphan park 行为。
     - 新 guard 满足时断言 finalizer 不会误 park。
     - guard 未启用的旧路径继续 park。
   - Why: 降低迁移风险，覆盖异常和兼容调用方。
   - Dependencies: Step 8.
   - Risk: Medium.

### Phase 4: Agent contract and observability

10. **更新 TaskFlow Skill**
    - File: `workspace/skills/taskflow/SKILL.md`
    - Action:
      - 写入 create/resume 后的持续执行义务。
      - 明确 tracked child 必须使用 run mode 和 `taskFlowTracking="current"`。
      - 禁止只发进度承诺后结束。
    - Why: 减少运行时修复触发，提升模型首次执行正确率。
    - Dependencies: None.
    - Risk: Low.

11. **增加结构化日志**
    - Files:
      - `src/agents/pi-embedded-runner/run.ts`
      - `src/agents/taskflow/continuation.ts`
    - Action:
      - 记录 taskFlowId、revision、reason、retry 和 active descendant 状态。
      - 不记录用户正文或完整任务标题。
    - Why: 便于确认约束触发频率和失败原因。
    - Dependencies: Step 8.
    - Risk: Low.

## Testing Strategy

### Unit Tests

- `src/agents/taskflow/continuation.test.ts`
  - tracker 未激活时不读取 store。
  - active + `in_progress` + no descendant 返回 required。
  - active descendant 按 `taskFlowId` 或 `trackingTaskFlowId` 均满足约束。
  - ended descendant 不满足约束。
  - parked、blocked、completed、canceled 和 pending-only 满足约束。
- `src/agents/tools/taskflow-update-tool.test.ts`
  - create/resume/update success 上报 snapshot。
  - mutation error 和 revision conflict 不上报。
- `src/agents/taskflow/prompt.test.ts`
  - foreground snapshot 触发 observer。
  - parked-only 和 no-flow 不建立 foreground obligation。
- `src/agents/pi-embedded-runner/run/completion.test.ts`
  - TaskFlow continuation prompt 内容和工具策略正确。

### Runner Integration Tests

- `resume_taskflow -> assistant progress reply -> no child`
  - 第一次 attempt 被转换为 continuation。
  - 第二次 attempt 必须继续执行。
- `resume_taskflow -> sessions_spawn(taskFlowTracking=current)`
  - 正常结束，TaskFlow 保持 active。
- `resume_taskflow -> complete_taskflow`
  - 正常结束，不触发 continuation。
- `resume_taskflow -> park_taskflow`
  - 正常结束，状态和原因保留。
- `tracked child completion -> remaining in_progress -> parent progress reply`
  - parent 必须安排下一执行者或显式 park。
- `continuation retry -> still no executor`
  - TaskFlow 以 `continuation_contract_exhausted` 挂起。
  - 返回 `taskflow_continuation_contract` 错误。
- `message tool already delivered -> continuation retry`
  - 不重复发送消息或附件。
- 普通 Feishu 简单问答：
  - tracker 保持未激活。
  - attempt 次数仍为一次。
  - 不新增 TaskFlow store read。
- 非 Feishu、无 TaskFlow 会话：
  - 行为完全保持。

### Focused Validation Commands

```bash
pnpm vitest run \
  src/agents/taskflow/continuation.test.ts \
  src/agents/taskflow/prompt.test.ts \
  src/agents/tools/taskflow-update-tool.test.ts \
  src/agents/pi-embedded-runner/run/completion.test.ts \
  src/agents/pi-embedded-runner/run.completion-contract.test.ts \
  src/agents/pi-embedded-runner/run.taskflow-finalization.test.ts

make lint
```

按本仓库约束，不运行 `make test`。部署前如获得 owner 明确批准，再运行 `make build`。

## Risks & Mitigations

- **Risk: 已流式发送的进度文本无法撤回**
  - Mitigation:
    - 状态约束确保同一 run 随后真正安排执行。
    - continuation prompt 禁止再次发送相同内容。
    - 后续可单独评估将 final block reply 延迟到约束满足之后。

- **Risk: continuation retry 重复外部副作用**
  - Mitigation:
    - prompt 明确禁止重复已成功副作用。
    - 保留 `didSendViaMessagingTool` 和 tool settlement 信息。
    - TaskFlow retry 只允许一次。

- **Risk: tracker observer 透传范围扩大**
  - Mitigation:
    - observer 为可选内部参数。
    - 不改变工具 schema 和外部返回。
    - 各层增加 focused type/unit tests。

- **Risk: active TaskFlow 因历史状态错误触发额外 attempt**
  - Mitigation:
    - 只对 `in_progress` 项触发。
    - pending-only 保持现有行为。
    - 用户或模型可明确 park/block 解除约束。

- **Risk: subagent registry 与 TaskFlow snapshot 存在短暂竞态**
  - Mitigation:
    - assessment 在 attempt 结束时读取最新状态。
    - active descendant 判断只接受没有 `endedAt` 的 run。
    - revision conflict 时不覆盖用户或其他 run 的更新。

- **Risk: completion contract 总重试预算相互影响**
  - Mitigation:
    - TaskFlow 使用独立 continuation bucket。
    - 总 continuation 上限继续生效。
    - 日志区分 completion 和 TaskFlow continuation。

- **Risk: 普通会话出现额外开销**
  - Mitigation:
    - tracker 未激活时常数级返回。
    - 复用 prompt loader 已有的 foreground TaskFlow 读取。
    - 测试断言无 TaskFlow 时不新增 store read 和 attempt。

## Rollout Order

1. 合入 tracker、assessment 和单元测试，不接入 runner。
2. 接入 prompt/tool observer，记录 shadow assessment 日志，不阻止完成。
3. 在测试环境开启 continuation enforcement。
4. 验证 Feishu 普通会话 attempt 次数和延迟无变化。
5. 验证 create/resume、child completion 和 message tool 场景。
6. 启用一次修复 retry。
7. 保留 finalization fallback，观察 `finalization_missing` 数量是否下降。

## Success Criteria

- [ ] `resume_taskflow` 后仍有 `in_progress` 且无执行者时，run 不能以普通成功状态结束。
- [ ] 模型启动 tracked descendant 后可以正常回复用户。
- [ ] tracked descendant 完成但任务仍未完成时，parent 必须继续安排执行或明确挂起。
- [ ] 普通简单会话不执行完整 TaskFlow continuation assessment。
- [ ] 普通会话不增加模型 attempt 和 TaskFlow store read。
- [ ] 不依赖“继续处理”等自然语言模式。
- [ ] TaskFlow continuation 重试最多一次。
- [ ] 重试失败时 TaskFlow 被明确挂起，用户收到准确原因。
- [ ] 已成功的消息、文件和 mutating tool side effect 不被重复执行。
- [ ] 现有 `finalization_missing` 兜底测试继续通过。
- [ ] focused tests 和 `make lint` 通过。
