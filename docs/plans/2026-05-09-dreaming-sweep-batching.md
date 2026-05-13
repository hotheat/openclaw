# Implementation Plan: Dreaming Sweep Batching And Resume

## Overview

当前 `Memory Dreaming Promotion` 是一条 `systemEvent` cron job，会在一次运行里串行扫描全部 dreaming workspace。现网已确认在 52 个 workspace 场景下，单轮 sweep 需要约 64 分钟，而 cron 对非 `agentTurn` job 的默认总超时只有 10 分钟，导致 run history 被判定为 `cron: job execution timed out`。

本次方案不减少 workspace 数量，也不依赖单纯放大超时，而是把 dreaming sweep 改为可恢复、可分批、可续跑的执行模型，同时把 cron abort 信号真正接入 dreaming 内层链路，避免外层已超时而内层继续跑几十分钟。

## Requirements

- 保留现有 52 个 workspace 全量参与 dreaming sweep 的行为。
- 不要求单个 cron run 内完成全部 workspace。
- 允许同一轮 sweep 分批执行，并能跨 heartbeat/续跑事件恢复。
- timeout 到达后必须尽快停止，不允许 cron 已报错但 dreaming 继续长时间执行。
- 保持现有 managed dreaming cron 的用户入口和配置位置不变。
- 兼容已有 `DREAMS.md`、`memory/.dreams/`、phase report 等产物格式。

## Architecture Changes

- `extensions/memory-core/src/dreaming.ts`
  - 将一次性全量 sweep 改为批处理 + checkpoint 驱动。
- `extensions/memory-core/src/dreaming-phases.ts`
  - phase 执行链接入 deadline / abort 检查。
- `extensions/memory-core/src/dreaming-narrative.ts`
  - narrative 生成与 cleanup 接入 abort / best-effort 退出。
- `extensions/memory-core/src/dreaming-shared.ts` 或新增 `dreaming-sweep-state.ts`
  - 新增 sweep state 的读写、锁、过期恢复工具。
- `src/cron/service/timeout-policy.ts`
  - 评估是否需要为 managed dreaming continuation job 单独放宽超时，但不作为主修复路径。
- `extensions/memory-core/src/dreaming.test.ts`
  - 覆盖分批续跑、checkpoint 恢复、abort 收敛。
- `extensions/memory-core/src/dreaming-phases.test.ts`
  - 覆盖 phase 级别 deadline/abort 行为。
- `extensions/memory-core/src/dreaming-narrative.test.ts`
  - 覆盖 narrative timeout/cleanup/abort 收敛。

## Implementation Steps

### Phase 1: Sweep State 建模

1. **定义 dreaming sweep state 结构** (File: `extensions/memory-core/src/dreaming-shared.ts` or `extensions/memory-core/src/dreaming-sweep-state.ts`)
   - Action: 新增 sweep state 类型与序列化结构，至少包含 `sweepId`、`startedAtMs`、`updatedAtMs`、`workspaceDirs`、`nextIndex`、`completed`、`lastError`、`lockOwner`、`lockUpdatedAtMs`。
   - Why: 需要把“全量 sweep”拆成“多批次续跑”。
   - Dependencies: None
   - Risk: Low

2. **确定 state 文件路径和锁策略** (File: `extensions/memory-core/src/dreaming-shared.ts` or `extensions/memory-core/src/dreaming-sweep-state.ts`)
   - Action: 在主 workspace 的 `memory/.dreams/` 下定义统一 state 文件，例如 `memory/.dreams/managed-sweep-state.json`，并设计 stale lock 判定。
   - Why: state 不能挂在单个业务 workspace 下，否则续跑入口不稳定。
   - Dependencies: Step 1
   - Risk: Medium

3. **封装 state 读写 API** (File: `extensions/memory-core/src/dreaming-sweep-state.ts`)
   - Action: 提供 `loadSweepState`、`saveSweepState`、`clearSweepState`、`acquireSweepLock`、`releaseSweepLock`、`advanceSweepCursor`。
   - Why: 避免主执行函数堆积文件 IO 和锁细节。
   - Dependencies: Step 2
   - Risk: Medium

### Phase 2: 主循环改成分批续跑

1. **重构 `runShortTermDreamingPromotionIfTriggered` 为预算驱动循环** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 把当前 `for (const workspaceDir of workspaces)` 改成读取 state 后从 `nextIndex` 开始处理；每次只处理 `N` 个 workspace 或直到 `deadlineMs` 临近。
   - Why: 这是本次修复的核心。
   - Dependencies: Phase 1
   - Risk: High

2. **引入 continuation 机制** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 当前批次未完成时，写回 state，并重新投递 continuation system event；完成时清空 state。
   - Why: 一条 cron job 只负责启动与推进，不要求一次跑完。
   - Dependencies: Phase 2 Step 1
   - Risk: High

3. **避免重复启动同一轮 sweep** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 如果发现已有未完成 state，则当前触发只做“恢复/推进”，不新建第二轮 sweep。
   - Why: 防止 03:00 定时触发与续跑事件重叠。
   - Dependencies: Phase 2 Step 2
   - Risk: High

4. **记录批次级 summary 日志** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 新增 `batchStart`、`batchEnd`、`nextIndex`、`remaining`、`rescheduled` 等日志。
   - Why: 后续排障要能看出 sweep 是否在稳定推进。
   - Dependencies: Phase 2 Step 1
   - Risk: Low

### Phase 3: Abort / Deadline 真正打通

1. **把 abort/deadline 作为显式参数下传** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 为主 sweep、phase 执行、narrative 生成新增 `abortSignal` / `deadlineMs` 参数。
   - Why: 当前外层 cron 超时后，内层没有及时停。
   - Dependencies: Phase 2
   - Risk: High

2. **在 workspace 粒度插入提前退出检查** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 每次开始处理 workspace 前检查 `abortSignal.aborted` 与剩余预算；若不足以安全完成下一步，先落 checkpoint 再退出。
   - Why: 避免处理到一半才被外层打断。
   - Dependencies: Phase 3 Step 1
   - Risk: Medium

3. **在 phase 粒度插入提前退出检查** (File: `extensions/memory-core/src/dreaming-phases.ts`)
   - Action: 在 light 前、light 后、rem 前、rem 后、deep 前都检查 deadline/abort。
   - Why: phase 是自然分界点，适合做收敛。
   - Dependencies: Phase 3 Step 1
   - Risk: Medium

4. **在 narrative 子流程接入 abort** (File: `extensions/memory-core/src/dreaming-narrative.ts`)
   - Action: 在 `startNarrativeRunOrFallback` 前、`waitForRun` 前后、`getSessionMessages` 前后做 abort 检查；cleanup 只做 best-effort，不再阻塞主 sweep 收尾。
   - Why: narrative 是当前最长路径之一。
   - Dependencies: Phase 3 Step 1
   - Risk: High

### Phase 4: 降低单个 workspace 单位成本

1. **复核 light/rem 各自 narrative 的必要性** (File: `extensions/memory-core/src/dreaming-phases.ts`)
   - Action: 设计开关或合并策略，例如允许单 workspace 只生成一段合并 diary，而不是 light/rem 各一段。
   - Why: 当前每个 workspace 最少两次 narrative 生成，线性放大总时长。
   - Dependencies: None
   - Risk: Medium

2. **将 cleanup 失败彻底降级为非阻塞** (File: `extensions/memory-core/src/dreaming-narrative.ts`)
   - Action: `missing scope: operator.admin`、`subagent methods are only available during a gateway request` 这类 cleanup 失败只计日志，不影响 sweep 推进，也不触发额外等待。
   - Why: 当前它们不是主因，但会拖慢和污染执行面。
   - Dependencies: Phase 3 Step 4
   - Risk: Low

3. **保守引入小并发的预留点** (File: `extensions/memory-core/src/dreaming.ts`)
   - Action: 先保持串行实现，但把批处理器设计成以后可配置 `maxParallelWorkspaces=2`。
   - Why: 先修正确性，保留后续扩展空间。
   - Dependencies: Phase 2
   - Risk: Medium

### Phase 5: Timeout 策略校准

1. **保持默认 10 分钟 safety net 不变** (File: `src/cron/service/timeout-policy.ts`)
   - Action: 默认不改全局 `DEFAULT_JOB_TIMEOUT_MS`。
   - Why: 这是全局 cron 安全边界，不能为了一个任务放宽所有 systemEvent job。
   - Dependencies: None
   - Risk: Low

2. **仅在必要时为 managed dreaming continuation 引入显式 timeout** (File: `extensions/memory-core/src/dreaming.ts`, `src/cron/types.ts`, cron persistence path if needed)
   - Action: 如果 continuation 仍可能超过安全预算，再评估把 dreaming job 改成 `agentTurn.timeoutSeconds` 风格的显式超时配置，或扩展 systemEvent timeout metadata。
   - Why: 作为兜底，而不是主修复路径。
   - Dependencies: Phase 2/3 稳定后再决定
   - Risk: Medium

### Phase 6: 测试与文档

1. **补 sweep state / batching 单元测试** (File: `extensions/memory-core/src/dreaming.test.ts`)
   - Action: 覆盖首次启动、续跑推进、完成清理、stale lock 恢复、重复触发去重。
   - Why: 分批续跑最容易出状态错乱。
   - Dependencies: Phase 1-3
   - Risk: Medium

2. **补 abort/regression 测试** (File: `extensions/memory-core/src/dreaming.test.ts`, `dreaming-phases.test.ts`, `dreaming-narrative.test.ts`)
   - Action: 模拟 deadline 已到、narrative wait 超时、外层 abort 触发后应快速退出。
   - Why: 当前真实问题就是 timeout 后不收敛。
   - Dependencies: Phase 3
   - Risk: Medium

3. **更新 dreaming 文档** (File: `docs/concepts/dreaming.md`, `docs/cli/memory.md`)
   - Action: 说明 managed sweep 现在是分批执行，单次 cron run 不是全量完成的保证。
   - Why: 避免后续误判 “定时任务失败”。
   - Dependencies: 实现稳定后
   - Risk: Low

## Testing Strategy

- Unit tests:
  - `extensions/memory-core/src/dreaming.test.ts`
  - `extensions/memory-core/src/dreaming-phases.test.ts`
  - `extensions/memory-core/src/dreaming-narrative.test.ts`
  - `src/cron/service/timeout-policy.test.ts`
- Integration tests:
  - 构造多 workspace sweep，验证 1 次触发会分多批完成。
  - 验证 abort 后会落 checkpoint 并在下次 continuation 恢复。
  - 验证已有未完成 state 时不会开启第二轮 sweep。
- E2E tests:
  - 本地 gateway 启动后人工触发 `openclaw cron run` 或等待 03:00 计划触发。
  - 观察 `openclaw cron runs --id ...` 不再在 10 分钟固定报错。
  - 观察日志中 sweep 会按批次推进并最终 `dreaming promotion complete`。

## Risks & Mitigations

- **Risk**: continuation 事件投递失败，state 留在半完成状态。
  - Mitigation: stale lock + heartbeat 恢复路径；下次触发优先恢复旧 state。

- **Risk**: state 文件损坏导致整个 sweep 卡死。
  - Mitigation: 加 schema 校验；损坏时记录告警并从安全初始状态重建。

- **Risk**: abort 在 narrative 中间到达，留下脏 session。
  - Mitigation: cleanup 保持 best-effort；主逻辑以 checkpoint 收敛为第一优先级。

- **Risk**: 批次过小导致 sweep 总完成时间拖得太长。
  - Mitigation: 用时间预算优先于固定数量；默认 2 到 5 个 workspace/批，并保留调参空间。

- **Risk**: light/rem narrative 合并改变现有 diary 语义。
  - Mitigation: 先把 batching 与 abort 修好；合并 narrative 作为第二阶段优化开关。

- **Risk**: 改动 `dreaming.ts` 过大引入回归。
  - Mitigation: 先抽 state helper，再局部替换 for-loop；通过 regression test 锁住现有行为。

## Success Criteria

- [ ] 52 个 workspace 场景下，managed dreaming 不再依赖单个 cron run 在 10 分钟内完成。
- [ ] `openclaw cron runs` 不再稳定出现 `cron: job execution timed out`。
- [ ] 外层 timeout 到达后，dreaming 内层会在可接受时间内停止并落 checkpoint。
- [ ] sweep 可在后续 continuation 中从断点恢复并最终完成全部 workspace。
- [ ] cleanup / scope 异常不再主导执行路径，也不会导致 sweep 长时间挂住。
- [ ] 文档明确说明 managed dreaming 的分批执行语义。
