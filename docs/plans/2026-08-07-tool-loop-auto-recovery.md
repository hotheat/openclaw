# Implementation Plan: Tool Loop 自动恢复

## Overview

修复工具参数连续校验失败后，当前 run 被 `ToolLoopAbortError` 中止并永久停留在
`stopReason=aborted` 的问题。目标是在不依赖用户或 Control UI 补发“继续执行”消息的前提下，
由 runner 在同一个逻辑 run 内自动启动一次有界恢复 attempt，修正工具参数并继续完成原任务。

第一阶段只处理能够证明工具尚未执行的 schema validation loop。该场景可以安全重试修正后的
调用。结果未知的写入、发送、删除和命令执行不进入自动重试，继续使用现有副作用保护和明确失败
交接。第二阶段再评估修改 Agent Core 的工具结果拦截点，关闭第三次 repair warning 与下一轮
模型调用之间的竞态。

## Decision Summary

```text
┌──────────────────────┬────────────────────────────────────────────────┐
│ 决策                 │ 方案                                           │
├──────────────────────┼────────────────────────────────────────────────┤
│ 恢复边界             │ 同一个逻辑 run，新建模型 attempt                │
│ 首期错误范围         │ 重复 schema validation，工具确认未执行          │
│ 当前 stream          │ 保持 abort，不尝试复活已中止的模型流            │
│ 自动恢复次数         │ 独立 bucket，最多一次                           │
│ 恢复机制             │ 复用现有 completion contract continuation       │
│ 工具权限             │ schema validation 使用 normal                   │
│ 重复参数             │ 相同失败签名和参数指纹在恢复 attempt 中阻断      │
│ 外部副作用           │ 已成功或结果未知的 mutation 不得重复             │
│ 用户主动 abort       │ 永不自动恢复                                    │
│ 恢复失败             │ 返回明确终态错误，不再等待人工观察              │
│ 第三次 warning 竞态  │ 首期记录并容忍，第二阶段通过 awaited hook 关闭    │
│ TaskFlow             │ 可选增强，不作为普通工具恢复的前置条件           │
└──────────────────────┴────────────────────────────────────────────────┘
```

## Requirements

- 相同缺失必填字段的 schema validation 在第 4 次触发保护后，runner 自动继续一次。
- 自动恢复必须保留原始用户目标、当前会话上下文、已完成工具结果和生成中的文件。
- 恢复 attempt 必须获得具体的工具名、缺失字段、最近错误和禁止重复的调用指纹。
- 修正后的同一工具调用可以执行。
- 完全相同的失败调用不得在恢复 attempt 中再次执行。
- 自动恢复不得依赖自然语言关键词、Control UI 消息或 Feishu 新消息。
- 用户主动取消、超时、服务关闭和安全策略拒绝不得被识别为可恢复 tool loop。
- 已成功发送的消息或附件不得在恢复 attempt 中重复发送。
- mutation 工具结果未知时不得自动重试。
- 自动恢复最多一次，并受现有 completion continuation 总预算约束。
- 第二次仍未完成时必须产生用户可见的终态错误。
- 普通无错误工具调用不得增加额外 attempt。
- Feishu、subagent 和 researcher 的现有 completion contract 行为保持兼容。

## Non-goals

- 不自动恢复任意 `AbortError`。
- 不对权限拒绝、安全策略拒绝或用户取消进行重试。
- 不在第一阶段自动重试结果未知的 mutation。
- 不实现通用后台任务调度器。
- 不要求所有普通工具任务创建 TaskFlow。
- 不通过“继续处理”“稍后完成”等文本判断是否需要恢复。
- 不在第一阶段修改 `@mariozechner/pi-agent-core` 依赖。
- 不提高 schema validation 的 abort 阈值来掩盖问题。
- 不允许无限 continuation。

## Production Incident

目标会话：

```text
agent:feishu-group-oc_19daa094c44b5527be5019aae08265fc:
feishu:group:oc_19daa094c44b5527be5019aae08265fc
```

实际时间线：

```text
14:00:21.563  第 3 次 write 缺少 content
14:00:21.607  schema repair warning 生成
14:00:24.540  第 4 次相同 write 已经进入模型输出
14:00:24.610  ToolLoopAbortError 触发
14:00:24.886  assistant 以 stopReason=aborted 结束
14:05:15.167  Control UI 人工发送 continuation
14:07:49.860  新 run 使用完整 content 成功 write
14:08:04.917  message 工具把文件发送到 Feishu
```

如果没有 14:05 的 Control UI 消息，旧 run 不会继续。文件生成和 Feishu 发送均属于后续人工触发
的新 run。

## Current Behavior

### Failure Chain

```text
Agent Core 校验 tool arguments
  -> validation error 转成 tool_execution_end
  -> OpenClaw subscriber 记录 schema validation outcome
  -> 第 3 次通过 session.steer() 投递 repair warning
  -> Agent Core 可能已经完成 steering queue 检查
  -> 模型发出第 4 次相同调用
  -> handler 调用 abortRun(ToolLoopAbortError)
  -> activeSession.abort()
  -> attempt.aborted = true
  -> run.ts 跳过 completion contract
  -> 返回空 aborted assistant
  -> 没有后续执行者
```

### Root Causes

#### 1. Tool result observation is outside the awaited execution path

`@mariozechner/pi-agent-core` 在执行工具后按以下顺序工作：

```text
stream.push(tool_execution_end)
  -> 构造 toolResult
  -> getSteeringMessages()
```

OpenClaw 通过 session event stream 消费 `tool_execution_end`。事件进入 stream 不代表 subscriber 已经
完成处理。Agent Core 可以在 subscriber 记录错误并调用 `steer()` 前完成 steering queue 检查。

相关路径：

- `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`
- `src/agents/pi-embedded-subscribe.handlers.ts`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts`

#### 2. Abort reason is not represented as an attempt termination

`runEmbeddedAttempt()` 只返回：

```text
aborted: boolean
promptError: unknown
termination: completed | incomplete_tool_loop
```

调用方无法可靠区分：

- 用户主动取消。
- 请求超时。
- Tool loop 保护中止。
- 服务关闭或上层 signal 中止。

相关路径：

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/types.ts`

#### 3. Completion contract excludes aborted attempts

现有 continuation 条件：

```ts
if (completionContractEnabled && !aborted && !timedOut) {
  // assess and continue
}
```

`ToolLoopAbortError` 即使具备明确修复方法，也无法进入现有的
`failed_but_incomplete` continuation。

相关路径：

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/completion.ts`

#### 4. Unit tests do not cover the Agent Core race

现有测试直接依次调用 `handleToolExecutionEnd()`，只能证明：

- 第 3 次调用了 `steer()`。
- 第 4 次调用了 `abortRun()`。

测试没有经过 Agent Core 的 `stream.push()`、steering poll 和下一次模型调用，因此无法证明 repair
warning 会在下一轮前被消费。

相关路径：

- `src/agents/pi-embedded-subscribe.handlers.tools.test.ts`

## Design Principles

### Preserve abort semantics

当前模型 stream 一旦中止，不再尝试原地恢复。`AbortController`、AgentSession streaming 状态和
provider stream 都已经进入终止流程。恢复动作由 runner 创建新的 attempt。

### Recover from state, not prose

恢复依据必须来自结构化错误：

- error kind。
- detector。
- tool name。
- outcome signature。
- missing required fields。
- call fingerprint。
- side-effect classification。

不依赖模型是否说“继续”“重试”或“下一步”。

### Retry only when the outcome is known

Schema validation 在 `tool.execute()` 前失败，可以证明工具没有执行。该类错误允许修正参数后自动
重试。

对于以下场景，恢复 attempt 只能检查状态或报告失败：

- 写入工具已经进入 execute，但结果丢失。
- message 工具发送结果未知。
- exec 命令已启动但 settlement 超时。
- delete、move、restart 等 mutation 没有确认结果。

### Bound every recovery path

每个逻辑 run 的 tool-loop recovery 使用独立计数器，最多一次。它同时受
`MAX_COMPLETION_CONTRACT_CONTINUATIONS` 总预算限制。

### Keep user-visible delivery idempotent

恢复 prompt 必须携带已发生的用户可见交付状态。Runner 需要阻止相同 target、文本和附件的重复
发送，不能只依赖模型遵守提示。

## Target Architecture

```text
tool_execution_end
  -> 提取结构化 schema failure
  -> 记录 diagnostic state
  -> 第 4 次生成 ToolLoopAbortError
       ├─ toolName
       ├─ detector
       ├─ outcomeSignature
       ├─ missingRequiredFields
       ├─ invalidArgsFingerprint
       ├─ sanitizedInvalidArgs
       └─ executionState = not_executed
  -> abort 当前 AgentSession
  -> runEmbeddedAttempt 返回 recoverable_tool_failure
  -> runner completion assessment
       ├─ 用户 abort / timeout          -> 原流程
       ├─ schema failure, 未执行        -> continuation 一次
       └─ mutation outcome unknown      -> 禁止 mutation，终态交接
  -> 新 attempt
       ├─ 注入结构化 recovery prompt
       ├─ 保留原任务和会话
       ├─ 阻断相同失败指纹
       └─ 允许修正后的调用
  -> 完成或返回明确终态错误
```

## Data Model

### Structured Tool Loop Abort Error

新增 `src/agents/tool-loop-error.ts`：

```ts
export type ToolExecutionState = "not_executed" | "succeeded" | "failed" | "unknown";

export type ToolLoopRecoveryDescriptor = {
  detector: "schema_validation_error_repeat";
  toolName: string;
  count: number;
  outcomeSignature: string;
  missingRequiredFields: string[];
  invalidArgsFingerprint: string;
  sanitizedInvalidArgs?: Record<string, unknown>;
  executionState: ToolExecutionState;
  mutatingAction: boolean;
};

export class ToolLoopAbortError extends Error {
  readonly recovery: ToolLoopRecoveryDescriptor;
}
```

约束：

- `sanitizedInvalidArgs` 必须受长度和深度限制。
- 不记录 token、密码、认证头和完整文件正文。
- 第一阶段只创建 `executionState = "not_executed"` 的可恢复错误。
- 其他 detector 保持现有行为。

### Attempt Termination

扩展 `EmbeddedRunAttemptTermination`：

```ts
type EmbeddedRunAttemptTermination =
  | { kind: "completed" }
  | { kind: "incomplete_tool_loop"; ... }
  | {
      kind: "recoverable_tool_failure";
      recovery: ToolLoopRecoveryDescriptor;
    };
```

扩展 `EmbeddedRunAttemptResult`：

```ts
abortReason?: unknown;
```

`aborted` 继续表示当前 attempt 已经中止。恢复判断使用 `termination.kind`，不能通过错误文本匹配。

### Run-scoped Recovery State

在 `run.ts` 中维护：

```ts
type ToolLoopRecoveryState = {
  attempts: number;
  blockedFingerprints: Set<string>;
  successfulDeliveries: MessagingToolSend[];
  successfulMediaUrls: string[];
  successfulActionFingerprints: Set<string>;
};
```

该状态只存在于当前逻辑 run，多个 continuation attempt 共享。它不写入长期 session store。

## Recovery Classification

```text
┌────────────────────────────┬───────────────┬──────────────────────────┐
│ 错误                       │ Tool policy   │ 动作                     │
├────────────────────────────┼───────────────┼──────────────────────────┤
│ 缺少必填字段，未执行       │ normal        │ 修正参数后继续           │
│ 其他 schema validation     │ normal        │ 换调用形状后继续         │
│ 只读工具结果缺失           │ read_only     │ 检查或换只读策略         │
│ mutation 结果未知          │ disabled      │ 使用已有结果并明确交接   │
│ message 已成功             │ normal*       │ 禁止重复相同 delivery     │
│ 权限或策略拒绝             │ disabled      │ 返回阻塞原因              │
│ 用户主动取消               │ n/a           │ 不恢复                    │
│ timeout                    │ existing      │ 保持现有 timeout 处理     │
└────────────────────────────┴───────────────┴──────────────────────────┘

* 其他工具可以继续，但相同 message target/content/media 指纹必须被运行时阻断。
```

## Recovery Prompt Contract

新增 completion classification：

```ts
"recoverable_tool_failure";
```

建议 prompt：

```text
The previous attempt was stopped by tool-loop protection after repeated schema
validation failures.

Continue the same user task now. Do not send a progress-only reply.

Failed tool: write
Failure: missing required field(s): content
Execution state: the tool did not execute

The exact failed call shape is blocked. Use corrected arguments or switch strategy.
Do not repeat any successful user-facing delivery or mutating side effect from the
previous attempt.

Before ending, complete the task or return a concise failure handoff with the
concrete blocker.
```

Prompt 生成规则：

- 缺失字段来自结构化 descriptor。
- 不把完整大正文放入 prompt。
- 不暴露服务器敏感路径给用户，但模型内部可继续使用会话中已有的合法 workspace 路径。
- 如果前一 attempt 已通过 message 工具交付内容，明确禁止再次发送。
- 这是最后一次 tool-loop recovery；失败后必须返回终态。

## Fingerprint Blocking

恢复 attempt 必须阻止完全相同的失败调用，避免 continuation 再次消耗到相同 abort 阈值。

指纹：

```text
toolName
  + outcomeSignature
  + stable hash(sanitized tool params)
```

实现位置：

- `src/agents/pi-tools.before-tool-call.ts`
- `src/agents/tool-loop-detection.ts`

行为：

```text
当前调用指纹不在 blocked set
  -> 正常执行

当前调用指纹命中 blocked set
  -> before_tool_call 阻断
  -> 返回缺失字段和修正要求
  -> 不调用 tool.execute

工具名相同但参数已修正
  -> 指纹不同
  -> 允许执行
```

第一阶段不尝试自动补齐参数。模型必须根据工具 schema 和错误信息生成正确调用，避免系统猜测正文、
目标、路径或业务字段。

## Side-effect Ledger

现有 attempt 已提供：

- `didSendViaMessagingTool`
- `messagingToolSentTexts`
- `messagingToolSentMediaUrls`
- `messagingToolSentTargets`
- `lastToolError.mutatingAction`
- `lastToolError.actionFingerprint`

runner 在每个 attempt 结束后把这些结果合并到 run-scoped ledger。

恢复 attempt 的双层保护：

1. Recovery prompt 告知模型不可重复副作用。
2. `before_tool_call` 使用 action fingerprint 阻断已经成功或结果未知的相同 mutation。

第一阶段至少覆盖 message delivery。后续再扩展到 write、exec、delete、move 和服务控制工具。

## Configuration

扩展 `ToolLoopDetectionConfig`：

```ts
type ToolLoopRecoveryConfig = {
  enabled?: boolean;
  maxAttempts?: number;
};

type ToolLoopDetectionConfig = {
  // existing fields
  recovery?: ToolLoopRecoveryConfig;
};
```

约束：

- `maxAttempts` 只允许 `0` 或 `1`。
- 第一阶段默认关闭，通过 agent override 为目标 Feishu agent 开启。
- 验证生产指标后，再评估对 completion-contract-enabled surfaces 默认开启。
- schema validation detector 被关闭时，recovery 同时失效。

示例：

```json5
{
  agents: {
    list: [
      {
        id: "feishu-group-oc_19daa094c44b5527be5019aae08265fc",
        tools: {
          loopDetection: {
            recovery: {
              enabled: true,
              maxAttempts: 1,
            },
          },
        },
      },
    ],
  },
}
```

配置变更不是实现验证的前置条件。单元和集成测试应通过显式参数开启。

## Implementation Steps

### Phase 1: Structured Error and Attempt Termination

1. **新增结构化 ToolLoopAbortError**
   - Files:
     - `src/agents/tool-loop-error.ts`
     - `src/agents/tool-loop-error.test.ts`
   - Action:
     - 定义 `ToolLoopRecoveryDescriptor`。
     - 定义 `ToolLoopAbortError` 和类型守卫。
     - 实现参数脱敏、深度限制和长度限制。
   - Why:
     - runner 必须基于错误类型和执行状态判断，不能匹配英文错误文本。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Low.

2. **提取结构化 schema validation failure**
   - Files:
     - `src/agents/tool-loop-detection.ts`
     - `src/agents/tool-loop-detection.test.ts`
   - Action:
     - 在现有 outcome signature 之外返回缺失必填字段。
     - 保持现有 signature 兼容。
     - 对不同 provider 的 validation 文本增加 fixture。
   - Why:
     - recovery prompt 和 fingerprint blocking 需要稳定字段。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium.

3. **由 critical handler 创建结构化错误**
   - Files:
     - `src/agents/pi-embedded-subscribe.handlers.tools.ts`
     - `src/agents/pi-embedded-subscribe.handlers.tools.test.ts`
   - Action:
     - 用 `ToolLoopAbortError` 替换当前只设置 name 的通用 `Error`。
     - descriptor 包含 start args、outcome signature 和 mutation metadata。
     - warning 和 diagnostic event 保持兼容。
   - Why:
     - 将 subscriber 已掌握的信息传递给 attempt 和 runner。
   - Dependencies: Steps 1-2.
   - Complexity: Medium.
   - Risk: Medium.

4. **保留 abort reason 并生成 recoverable termination**
   - Files:
     - `src/agents/pi-embedded-runner/run/attempt.ts`
     - `src/agents/pi-embedded-runner/run/types.ts`
     - `src/agents/pi-embedded-runner.guard.waitforidle-before-flush.test.ts`
   - Action:
     - `abortRun()` 保存首个 abort reason。
     - 用户 abort、timeout 和 tool-loop abort 使用同一 abort 流程。
     - settlement 后识别 `ToolLoopAbortError`。
     - 返回 `termination.kind = recoverable_tool_failure`。
   - Why:
     - 当前 attempt 需要正常完成清理，同时把恢复责任交给 runner。
   - Dependencies: Step 3.
   - Complexity: High.
   - Risk: High.

### Phase 2: Completion Contract Recovery

5. **增加 recovery completion class**
   - Files:
     - `src/agents/pi-embedded-runner/run/completion.ts`
     - `src/agents/pi-embedded-runner/run/completion.test.ts`
   - Action:
     - 增加 `recoverable_tool_failure`。
     - 生成结构化 recovery prompt。
     - schema validation 使用 `toolPolicy = normal`。
   - Why:
     - 复用现有受限 continuation loop。
   - Dependencies: Step 4.
   - Complexity: Medium.
   - Risk: Medium.

6. **允许 recoverable abort 进入 continuation**
   - Files:
     - `src/agents/pi-embedded-runner/run.ts`
     - `src/agents/pi-embedded-runner/run.completion-contract.test.ts`
   - Action:
     - 在普通 `!aborted` completion assessment 前处理 recoverable termination。
     - 使用独立 `recoverable_tool_failure:normal` bucket。
     - 最多继续一次。
     - continuation attempt 复用 session、原 prompt 和 completion ledger。
     - 用户 abort 和 timeout 继续跳过。
   - Why:
     - 解决 run 被保护机制中止后永久停住的问题。
   - Dependencies: Step 5.
   - Complexity: High.
   - Risk: High.

7. **增加 run-scoped recovery ledger**
   - Files:
     - `src/agents/pi-embedded-runner/run.ts`
     - `src/agents/pi-embedded-runner/run/types.ts`
   - Action:
     - 聚合 blocked fingerprints。
     - 聚合成功 message deliveries。
     - 聚合成功和未知 mutation fingerprints。
     - continuation attempt 透传 recovery policy。
   - Why:
     - 防止自动续跑重复外部副作用。
   - Dependencies: Step 6.
   - Complexity: High.
   - Risk: High.

### Phase 3: Runtime Blocking and Idempotency

8. **在 before_tool_call 阻断失败指纹**
   - Files:
     - `src/agents/pi-tools.before-tool-call.ts`
     - `src/agents/pi-tools.before-tool-call.test.ts`
     - `src/agents/pi-tools.ts`
     - `src/agents/pi-embedded-runner/run/params.ts`
   - Action:
     - 为 HookContext 增加可选 recovery state。
     - 计算当前参数指纹。
     - 命中 blocked fingerprint 时返回结构化 block reason。
     - 修正参数产生新指纹后允许执行。
   - Why:
     - 保证 recovery attempt 不重复同一个错误调用。
   - Dependencies: Step 7.
   - Complexity: Medium.
   - Risk: Medium.

9. **阻断重复 message delivery**
   - Files:
     - `src/agents/pi-tools.before-tool-call.ts`
     - `src/agents/pi-embedded-messaging.ts`
     - `src/agents/pi-tools.before-tool-call.test.ts`
   - Action:
     - 复用 message target、文本和 media fingerprint。
     - 已成功 delivery 在 recovery attempt 中返回 blocked。
     - 不影响发送不同文件或不同目标。
   - Why:
     - prompt 约束不能单独保证外部副作用幂等。
   - Dependencies: Steps 7-8.
   - Complexity: Medium.
   - Risk: Medium.

10. **扩展 mutation outcome policy**
    - Files:
      - `src/agents/tool-mutation.ts`
      - `src/agents/pi-tools.before-tool-call.ts`
      - `src/agents/pi-tools.before-tool-call.test.ts`
    - Action:
      - 已成功相同 mutation 返回 already completed。
      - 结果未知相同 mutation 返回 unsafe to retry。
      - read-only 调用继续允许。
    - Why:
      - 为后续恢复其他 tool-loop 类型建立安全边界。
    - Dependencies: Step 7.
    - Complexity: Medium.
    - Risk: High.

### Phase 4: Configuration, Documentation, and Observability

11. **增加 recovery 配置**
    - Files:
      - `src/config/types.tools.ts`
      - `src/config/zod-schema.agent-runtime.ts`
      - `src/config/schema.help.ts`
      - `src/config/schema.labels.ts`
      - configuration tests
    - Action:
      - 增加 `tools.loopDetection.recovery`。
      - 校验 `maxAttempts`。
      - 第一阶段默认关闭。
    - Why:
      - 支持按 agent 灰度。
    - Dependencies: Step 6.
    - Complexity: Medium.
    - Risk: Low.

12. **更新用户文档**
    - Files:
      - `docs/tools/loop-detection.md`
      - `docs/gateway/configuration-reference.md`
    - Action:
      - 说明 repair warning、critical abort 和 auto recovery。
      - 说明只自动恢复确认未执行的 schema validation。
      - 说明副作用和重试上限。
    - Why:
      - 运行行为和配置必须可解释。
    - Dependencies: Step 11.
    - Complexity: Low.
    - Risk: Low.

13. **增加结构化 lifecycle 和 diagnostic events**
    - Files:
      - `src/agents/pi-embedded-runner/run.ts`
      - `src/logging/diagnostic.ts`
      - event type definitions and tests
    - Action:
      - 记录 `recovery_required`。
      - 记录 `recovery_started`。
      - 记录 `recovery_succeeded`。
      - 记录 `recovery_exhausted`。
      - 日志只包含 fingerprint，不包含完整参数。
    - Why:
      - 灰度阶段需要确认恢复率和重复副作用。
    - Dependencies: Steps 6-7.
    - Complexity: Medium.
    - Risk: Low.

### Phase 5: Close the Repair-warning Race

14. **评估 Agent Core awaited outcome hook**
    - Files:
      - `@mariozechner/pi-agent-core` integration
      - package patch or successor package evaluation
      - dedicated integration tests
    - Action:
      - 在 `tool_execution_end` 后、`getSteeringMessages()` 前增加 awaited interceptor。
      - OpenClaw 在 interceptor 中完成 schema outcome 记录和 warning queue。
      - 不再依赖 subscriber 消费时序保证正确性。
    - Why:
      - 第 3 次 warning 应在第 4 次模型调用前生效。
    - Dependencies: Phases 1-4.
    - Complexity: High.
    - Risk: High.

15. **迁移 warning handling**
    - Files:
      - `src/agents/pi-embedded-subscribe.handlers.tools.ts`
      - new Agent Core adapter
      - related tests
    - Action:
      - subscriber 保留聚合、输出和 hooks。
      - correctness-critical loop detection 移入 awaited interceptor。
      - 删除重复记录路径。
    - Why:
      - 避免同一 tool result 被两套路径计数。
    - Dependencies: Step 14.
    - Complexity: High.
    - Risk: High.

Phase 5 不阻塞首期上线。Phase 1-4 已能保证 critical abort 后自动恢复，消除人工 Control UI
continuation。Phase 5 用于减少一次无效调用和改善 transcript 顺序。

## Testing Strategy

### Unit Tests

- `src/agents/tool-loop-error.test.ts`
  - 结构化字段完整。
  - 参数脱敏。
  - 超长正文被截断。
  - 类型守卫只接受真实 ToolLoopAbortError。

- `src/agents/tool-loop-detection.test.ts`
  - 提取单个缺失字段。
  - 提取多个缺失字段。
  - 不同 provider 错误文本产生稳定 signature。
  - 非 schema error 不产生 recovery descriptor。

- `src/agents/pi-embedded-subscribe.handlers.tools.test.ts`
  - 第 4 次产生结构化 ToolLoopAbortError。
  - descriptor 标记 `not_executed`。
  - diagnostic count 仍为 4。

- `src/agents/pi-embedded-runner/run/completion.test.ts`
  - recoverable tool failure 生成 normal policy。
  - prompt 包含缺失字段。
  - prompt 不包含完整敏感参数。

- `src/agents/pi-tools.before-tool-call.test.ts`
  - 相同失败指纹被阻断。
  - 修正参数允许执行。
  - 已成功 message delivery 不重复。
  - 不同 target 或不同 filePath 允许发送。

### Runner Integration Tests

#### Primary Recovery

```text
write missing content x4
  -> current attempt aborts
  -> runner continuation starts automatically
  -> corrected write succeeds
  -> final assistant response succeeds
```

断言：

- 用户只发送一次消息。
- runId 不变。
- provider attempt 数为 2。
- 不需要 Control UI continuation。
- 最终 payload 不是 error。

#### Recovery Exhaustion

```text
attempt 1: write missing content x4
attempt 2: repeats blocked fingerprint and still cannot complete
```

断言：

- 不产生第 3 个 attempt。
- 返回 `tool_loop_recovery_exhausted`。
- 用户看到工具名、缺失字段和明确 blocker。

#### User Abort

```text
user abort during tool call
```

断言：

- 不启动 recovery。
- 保持现有 aborted 语义。

#### Timeout

```text
run timeout during tool execution
```

断言：

- 不按 ToolLoopAbortError 恢复。
- 现有 timeout/fallback 行为保持。

#### Delivery Idempotency

```text
message send succeeds
later schema loop aborts
recovery model attempts same message send
```

断言：

- 相同 delivery 被运行时阻断。
- Feishu 只收到一个附件。
- recovery 可以继续其他未完成工作。

#### Corrected Same Tool

```text
blocked write(file_path only)
corrected write(file_path + content)
```

断言：

- corrected call 指纹不同。
- write 实际执行一次。

### Agent Core Integration Test

Phase 5 增加真实 event loop 测试：

```text
third validation failure
  -> awaited outcome interceptor
  -> steering queued
  -> next assistant turn receives repair message
  -> no fourth invalid tool call
```

该测试不能通过直接调用 handler 模拟。

### Focused Validation Commands

```bash
pnpm vitest run \
  src/agents/tool-loop-error.test.ts \
  src/agents/tool-loop-detection.test.ts \
  src/agents/pi-embedded-subscribe.handlers.tools.test.ts \
  src/agents/pi-tools.before-tool-call.test.ts \
  src/agents/pi-embedded-runner/run/completion.test.ts \
  src/agents/pi-embedded-runner/run.completion-contract.test.ts

make lint
```

按仓库约束，不运行 `make test`。只有 owner 在可信管理渠道明确批准部署并要求 build 验证时，才运行
`make build`。

## Rollout Plan

### Stage 1: Test-only

- 默认关闭 recovery。
- 完成 unit 和 runner integration tests。
- 验证 user abort、timeout 和 mutation unknown 不会误恢复。

### Stage 2: Single Feishu Agent

- 只为复现问题的 Feishu group agent 开启。
- `maxAttempts = 1`。
- 观察至少一周：
  - recovery required 次数。
  - recovery success rate。
  - recovery exhausted 次数。
  - duplicate delivery block 次数。
  - 用户主动 abort 误识别次数。

### Stage 3: Feishu Completion-contract Surfaces

- 扩展到指定 Feishu agents。
- 保持默认关闭，由 agent override 开启。
- 对 message、write 和 exec 的副作用指标单独统计。

### Stage 4: Default-on Evaluation

满足以下条件后评估默认开启：

- schema loop recovery 成功率稳定。
- 没有重复 Feishu 附件或消息。
- 没有用户 abort 被自动恢复。
- continuation token 成本可接受。
- recovery exhausted 能返回明确终态。

### Stage 5: Awaited Agent Core Hook

- 完成 Phase 5。
- 验证第 3 次 warning 能阻止第 4 次错误调用。
- 再评估降低 abort 触发频率。

## Observability

建议日志：

```text
[tool-loop-recovery] action=required
sessionKey=...
runId=...
tool=write
detector=schema_validation_error_repeat
count=4
fingerprint=...
executionState=not_executed

[tool-loop-recovery] action=continue
attempt=1/1
toolPolicy=normal

[tool-loop-recovery] action=succeeded
tool=write
durationMs=...

[tool-loop-recovery] action=exhausted
reason=repeated_blocked_fingerprint
```

指标：

- `tool_loop_recovery_required_total`
- `tool_loop_recovery_started_total`
- `tool_loop_recovery_succeeded_total`
- `tool_loop_recovery_exhausted_total`
- `tool_loop_recovery_duplicate_mutation_blocked_total`
- `tool_loop_recovery_duration_ms`

## Risks and Mitigations

### Recovery repeats an external side effect

- Risk:
  - 模型可能重复发送文件、重复写入或重新执行命令。
- Mitigation:
  - 第一阶段只恢复 tool 未执行的 schema validation。
  - 聚合 message delivery ledger。
  - before-tool-call 阻断相同成功或未知 mutation fingerprint。
  - continuation 最多一次。

### Abort reason is overwritten

- Risk:
  - 上层 signal 或 cleanup 可能覆盖首个 ToolLoopAbortError。
- Mitigation:
  - `abortRun()` 只保存第一个 abort reason。
  - timeout 状态单独保存。
  - termination 在 settlement 后统一派生。

### Session transcript contains an aborted assistant

- Risk:
  - provider 对 message ordering 或空 assistant 处理不一致。
- Mitigation:
  - 复用现有 session sanitization。
  - 增加 OpenAI、Anthropic-compatible 和 qwen provider fixture。
  - continuation prompt 作为新的用户 turn 注入。

### Recovery attempt repeats the same invalid call

- Risk:
  - 模型无视错误信息，再次提交相同参数。
- Mitigation:
  - blocked fingerprint 由 runtime 执行。
  - 不依赖 prompt。
  - 命中后终止 recovery，不再开启额外 attempt。

### Configuration increases complexity

- Risk:
  - global 和 per-agent merge 产生意外启用。
- Mitigation:
  - 第一阶段默认关闭。
  - `maxAttempts` 只允许 0 或 1。
  - schema detector 关闭时 recovery 强制关闭。

### Agent Core repair warning race remains

- Risk:
  - 第 4 次无效调用仍可能发生。
- Mitigation:
  - Phase 1-4 自动恢复，任务不会永久停住。
  - Phase 5 引入 awaited outcome hook。
  - 集成测试固定事件顺序。

### Completion contract interactions

- Risk:
  - tool-loop recovery 与 empty result、non-terminal text continuation 共享预算。
- Mitigation:
  - 使用独立 bucket。
  - 保留全局 continuation 总上限。
  - 日志记录 classification 和 bucket。

### Duplicate session delivery

- Risk:
  - message 工具已成功，但 transcript 或 snapshot 未及时反映。
- Mitigation:
  - ledger 使用 tool result commit 状态。
  - 同时跟踪 target、text 和 media URL。
  - 对已知 snapshot 竞态增加 integration fixture。

## Success Criteria

- [ ] 相同缺失字段导致第 4 次 schema validation failure 后，runner 自动启动一次恢复 attempt。
- [ ] 恢复过程不需要用户、Control UI、cron 或 system event 补发消息。
- [ ] 当前 attempt 保持 abort，新的 attempt 继续同一逻辑 run。
- [ ] 修正后的工具参数可以成功执行。
- [ ] 完全相同的失败调用在恢复 attempt 中被 runtime 阻断。
- [ ] 用户主动 abort 不触发自动恢复。
- [ ] timeout 不触发 schema loop recovery。
- [ ] 已成功 Feishu message 或附件不重复发送。
- [ ] mutation 结果未知时不自动重复执行。
- [ ] 自动恢复最多一次。
- [ ] 恢复耗尽后返回明确用户终态和结构化错误。
- [ ] 普通工具调用不增加 attempt。
- [ ] 现有 completion contract tests 保持通过。
- [ ] 生产日志可以区分 required、started、succeeded 和 exhausted。
- [ ] Phase 5 完成后，第 3 次 repair warning 能在下一次模型调用前生效。

## Recommended Implementation Order

```text
ToolLoopAbortError
  -> structured schema failure
  -> attempt termination
  -> completion classification
  -> runner bounded continuation
  -> failed fingerprint blocking
  -> delivery ledger
  -> configuration and metrics
  -> single-agent rollout
  -> awaited Agent Core hook
```

优先完成 Phase 1-2，可以最小范围解决“aborted 后永久停住”。Phase 3 在生产启用前完成，确保外部
副作用安全。Phase 5 单独评审依赖维护成本，不与首期恢复能力绑定。
