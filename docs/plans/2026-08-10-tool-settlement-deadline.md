# Implementation Plan: Tool Settlement Deadline

## Overview

修复 embedded agent 在工具结果已返回、最终回复仍在生成时，被固定 30 秒 idle 等待提前判定为未完成工具循环的问题。正常主流程改用当前 attempt 的剩余运行时限，保留超时后的中止、synthetic result 和禁止重复执行保护。

## Requirements

- 工具调用后的最终回复可以在 attempt 总超时范围内继续生成。
- attempt 总超时到达后仍中止 agent，不允许无限等待。
- 保留 `c6d0c235` 引入的悬空工具检测、重复写入保护和 mutating tool 禁止重放策略。
- 异常清理和 compact 失败路径继续使用 30 秒默认等待上限。
- 增加覆盖旧 30 秒边界的回归测试。

## Architecture Changes

- `src/agents/pi-embedded-runner/run/attempt.ts`
  - 在启动 attempt 超时计时器时记录统一截止时间。
  - 主工具收敛阶段传入截止时间对应的剩余等待预算。
- `src/agents/pi-embedded-runner.guard.waitforidle-before-flush.test.ts`
  - 验证显式等待预算超过 30 秒时，不会在旧默认边界提前返回。

## Implementation Steps

### Phase 1: Deadline Propagation

1. **记录 attempt 截止时间** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 复用超时计时器的标准化时限，计算 `attemptDeadlineAt`。
   - Why: idle 收敛等待和 agent abort 必须受同一个总时限约束。
   - Dependencies: None.
   - Risk: Low.

2. **传递剩余等待预算** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 主收敛调用传入 `Math.max(1, attemptDeadlineAt - Date.now())`。
   - Why: 避免固定 30 秒截断仍在正常进行的最终回复，同时避免超过 attempt 总时限。
   - Dependencies: Requires step 1.
   - Risk: Medium. 截止时间已经耗尽时只保留最小 1 毫秒等待，随后沿用现有安全终止路径。

### Phase 2: Regression Coverage

1. **覆盖旧 30 秒边界** (File: `src/agents/pi-embedded-runner.guard.waitforidle-before-flush.test.ts`)
   - Action: 使用 fake timers 验证 60 秒显式预算在 30 秒后仍等待，并在真实 toolResult 到达后正常收敛。
   - Why: 固化本次事故对应的时间线，防止显式预算再次被默认值覆盖。
   - Dependencies: Phase 1.
   - Risk: Low.

2. **运行安全回归测试**
   - Action: 运行 wait-for-idle、completion contract 和 completion assessment 聚焦测试。
   - Why: 确认未重新开放超时工具续跑或 mutating tool 重放。
   - Dependencies: Phase 1 and Phase 2 step 1.
   - Risk: Low.

## Testing Strategy

- Unit tests:
  - 显式 60 秒等待预算不会在 30 秒提前结束。
  - toolResult 在旧边界后到达时不写 synthetic result。
- Integration-focused tests:
  - 工具执行无法收敛时不继续 session。
  - mutating recovery 没有最终回复时不重新开放工具。
- Static validation:
  - 运行 `make lint`，检查类型、格式和 lint 规则。

## Risks & Mitigations

- **Risk**: 等待时间变长造成卡住。
  - Mitigation: 等待上限仍由 attempt 总超时控制，超时计时器继续 abort agent。
- **Risk**: 超时后重新执行有副作用的发送工具。
  - Mitigation: 不修改 completion contract、`mustStopBeforeContinuation` 和 mutating tool 恢复策略。
- **Risk**: 异常清理路径等待过久。
  - Mitigation: 仅主收敛调用使用剩余 attempt 时限，其他调用点保留 30 秒默认值。

## Success Criteria

- [ ] 主收敛等待使用 attempt 剩余运行时限。
- [ ] 超过 30 秒后到达的真实工具结果可以正常完成闭环。
- [ ] 无法收敛的工具执行仍停止，不继续或重复发送。
- [ ] 聚焦测试和 lint 通过。
- [ ] 只提交本次方案、实现和测试文件。
