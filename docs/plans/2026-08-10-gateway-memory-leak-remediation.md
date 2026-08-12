# Implementation Plan: OpenClaw Gateway Long-Running Memory Leak Remediation

## Overview

2026-08-10 07:49:51 CST，OpenClaw Gateway 在运行约 38 小时 43 分钟后触发
V8 heap OOM。Major GC 将堆从 3968.3 MB 回收到 3910.3 MB 后仍无法继续分配，
进程以 `SIGABRT` 退出，systemd 于 07:49:58 自动拉起。2026-08-08 16:14:40
发生过同类 OOM，两次都在约 3.9 GB 活堆处崩溃。

本方案分四层处理：先补可观测性，再修复已由源码证明的工具和 run/session
生命周期泄漏，随后降低 `sessions.list` 的瞬时分配，最后治理 PostgreSQL memory
manager 的高常驻基线。每一层必须独立部署和观察，避免多个变量同时变化后失去归因。

## Decision Summary

```text
┌────────────────────┬──────────────────────────────────────────────┬──────────┐
│ 决策               │ 方案                                         │ 优先级   │
├────────────────────┼──────────────────────────────────────────────┼──────────┤
│ 工具调用临时状态   │ 改为 run 级所有权，所有终态统一释放           │ P0       │
│ 进程级 Map         │ 生命周期清理、TTL、硬容量上限三层保护         │ P0       │
│ heap 定位          │ 暴露关键 Map 数量，阈值触发单次 heap snapshot │ P0       │
│ session store      │ 加载时裁剪，只读快照，组合结果缓存             │ P1       │
│ sessions.list      │ 减少 JSON.parse、structuredClone 和全量合并   │ P1       │
│ PostgreSQL manager │ 共享连接池，关闭失效 manager，逐步延迟初始化   │ P2       │
│ V8 heap 上限       │ 仅作临时保护，不作为泄漏修复                   │ 运维兜底 │
│ 上游修复           │ 按行为回移，不整提交 cherry-pick               │ P0/P1    │
└────────────────────┴──────────────────────────────────────────────┴──────────┘
```

## Requirements

- 修复工具执行成功、失败、取消、超时、订阅释放和进程关闭路径中的对象滞留。
- 所有长期存在的 run/session Map 必须同时具备显式清理、TTL 和硬容量上限。
- 保持现有工具调用、plugin hook、AgentEvent、subagent 和 Gateway RPC 契约。
- 保持 `after_tool_call` 收到 hook 调整后的参数。
- 保持工具 schema validation、loop detection 和 messaging tool 去重语义。
- `sessions.list` 返回字段、排序、过滤和 Control UI 行为保持兼容。
- session maintenance 在加载大 store 时主动裁剪，避免先完整构造超大对象再维护。
- PostgreSQL memory search 保持 agent 隔离、runtime credential 隔离和 schema 隔离。
- Gateway 配置变化或关闭时，旧 memory manager、watcher、timer 和数据库连接能够释放。
- 增加可验证的内存指标，能够区分 V8 heap、RSS、外部内存和关键容器数量。
- 修复后在等效负载下，Major GC 后的活堆不随运行时间持续单调增长。

## Non-goals

- 本方案不把 Agent Runtime 整体迁移出 Gateway 进程。
- 本方案不迁移 session store 到 SQLite 或 PostgreSQL。
- 本方案不重写 Pi Runtime、plugin hook 或 memory search 查询逻辑。
- 本方案不通过周期性重启掩盖泄漏。
- 本方案不把 `--max-old-space-size=12288` 视为最终修复。
- 本方案不在第一阶段合并所有 PostgreSQL manager。
- 本方案不承诺在缺少 heap snapshot 时，把历史 3 GB 增量归因到单一对象类型。

## Assumptions And Constraints

- 源码工作区为 `/home/xiaolu/github/openclaw-integration`。
- 当前分支为 `refactor/postgres-runtime-account-split`，基线提交为 `0b60bb65d9`。
- 当前分支不是以下上游修复提交的后代：
  - `820dc38525`：run context 和 subagent Map TTL。
  - `36c3a54b51`：Gateway 长运行 Map 清理。
  - `6a21962552`：session maintenance 默认 enforce 和 load-time prune。
  - `ef3f64952a`：session manager cache 主动清理。
- 当前分支相关文件结构已与上游提交显著分叉，应按行为回移最小改动。
- 不执行 `make build`，除非用户在当前对话明确要求。
- 不执行 `make test`。验证使用触及模块的 focused tests。
- Gateway restart 必须单独获得用户确认。
- 实施前后不得修改或清理工作区中与本方案无关的未跟踪文件。
- heap snapshot 可能产生数 GB 文件并暂停事件循环，必须设置单次触发和磁盘预算。

## Incident Evidence

### Timeline

```text
2026-08-08 17:06:40  旧 Gateway PID 2504180 启动
        │
        ├── 约 2327 次 embedded settlement
        ├── 3752 次 sessions.list
        ├── 522 次 chat.history
        └── 约 117 个 PostgreSQL memory manager 初始化
        │
2026-08-10 07:49:47  sessions.list 完成，耗时 1611 ms
2026-08-10 07:49:50  Control UI 重连
2026-08-10 07:49:50  agent.identity.get 完成
2026-08-10 07:49:51  JSON.parse 分配字符串时 V8 heap OOM
2026-08-10 07:49:53  进程 SIGABRT
2026-08-10 07:49:58  systemd 自动拉起 PID 3541413
```

### OOM Signature

```text
Scavenge 3937.6 MB -> 3922.4 MB
Mark-Compact 3968.3 MB -> 3910.3 MB
FATAL ERROR: Reached heap limit
Allocation failed - JavaScript heap out of memory
JsonParser<unsigned short>::MakeString
Builtin_JsonParse
```

Major GC 后仍有约 3.91 GB 活对象。该数据证明存在长期对象滞留或等效的无界缓存。
`JSON.parse` 是最后分配点，只能证明最后触发器，无法证明全部长期持有者。

### Runtime Scale

```text
┌──────────────────────────┬────────────────────┐
│ 项目                     │ 规模               │
├──────────────────────────┼────────────────────┤
│ 配置 agent               │ 119                │
│ sessions.json            │ 120 个 / 19.63 MiB │
│ session 条目             │ 约 362             │
│ transcript JSONL         │ 3326 个 / 313 MiB  │
│ workspace memory 文件    │ 120 目录 / 3.66 MiB│
│ PostgreSQL 活跃 socket   │ 约 110             │
│ 新 Gateway 稳态 RSS 基线 │ 约 0.8-1.0 GiB     │
└──────────────────────────┴────────────────────┘
```

## Current Architecture Findings

### 1. Tool Start Data Has Process-Wide Ownership

`src/agents/pi-embedded-subscribe.handlers.tools.ts`：

```ts
const toolStartData = new Map<string, { startTime: number; args: unknown }>();
```

`handleToolExecutionStart()` 保存完整 `args`。只有 `handleToolExecutionEnd()` 删除。
`subscribeEmbeddedPiSession().unsubscribe()` 没有按 run 清理未完成工具。

```text
tool_execution_start
  -> process-level toolStartData.set(runId:toolCallId, full args)
  -> run abort / subscription unsubscribe / missing end event
  -> no delete
  -> full args retained until process exit
```

这是确定存在的泄漏路径。历史事故中该 Map 的实际 retained size 仍需 heap snapshot
确认。

### 2. Adjusted Tool Params Skip Cleanup On Abort

`src/agents/pi-tools.before-tool-call.ts` 使用进程级
`adjustedParamsByToolCallId` 保存 hook 调整后的完整参数，硬上限为 1024。

`src/agents/pi-tool-definition-adapter.ts` 的异常路径先判断：

```ts
if (signal?.aborted) {
  throw err;
}
if (name === "AbortError") {
  throw err;
}
```

清理调用位于这两个提前抛出之后。工具取消时对应参数不会被删除。Map 虽有条目上限，
仍可能长期保留 1024 份大参数，并存在不同 run 复用 `toolCallId` 时的覆盖风险。

### 3. Agent Event State Has No Complete Cleanup

`src/infra/agent-events.ts`：

- `seqByRun` 没有 TTL。
- `runContextById` 没有最后活跃时间。
- `clearAgentRunContext()` 只删除 context，不删除 sequence。
- `resetAgentRunContextForTest()` 不清理 sequence。

每个产生 AgentEvent 的 run 都会在 `seqByRun` 留下永久条目。

### 4. Session-Mode Subagent Runs Are Never Swept

`src/agents/subagent-registry.ts`：

- session 模式明确不设置 `archiveAtMs`。
- sweeper 只在存在 `archiveAtMs` 时启动。
- `sweepSubagentRuns()` 永久跳过没有 `archiveAtMs` 的 entry。

已完成 cleanup 的 session-mode run 仍可能保留在进程级 registry。

### 5. Other Gateway Maps Lack Bounds

- `src/gateway/control-plane-rate-limit.ts`
  - `controlPlaneBuckets` 没有 TTL 和硬容量上限。
- `src/gateway/server-methods/nodes.ts`
  - `nodeWakeById` 和 `nodeWakeNudgeById` 在断连时不清理。
- `src/agents/tracing/context.ts`
  - `subagentLifecycleTraceRuns` 依赖 `ended` 事件删除，没有 TTL 兜底。
- `src/agents/pi-embedded-runner/session-manager-cache.ts`
  - 只在命中单个 key 时检查过期，不主动删除其他过期 key。

这些 Map 的单条记录通常较小。它们属于确定的长期增长点，不能单独解释历史 3 GB
增量。

### 6. Session Store Load Multiplies Allocations

`src/config/sessions/store.ts::loadSessionStore()` 当前路径：

```text
readFileSync UTF-8 string
  -> JSON.parse
  -> structuredClone into cache
  -> structuredClone for caller
  -> merge entry copies into combined store
  -> map/filter/sort into sessions.list response
```

`src/gateway/session-utils.ts::loadCombinedSessionStoreForGateway()` 每次遍历所有配置
agent，读取并合并约 120 个 store。Control UI 重连时会触发该路径。

session store 总量约 19.63 MiB，无法解释长期 3 GB 活堆，但在 heap 已接近上限时会
产生足以触发 OOM 的瞬时分配。

### 7. PostgreSQL Memory Manager Raises The Baseline

`src/gateway/server-startup-memory.ts` 启动时遍历所有 agent，并为每个启用 memory
search 的 agent 获取 manager 和执行 startup sync。

`src/memory/postgres-manager.ts`：

- `INDEX_CACHE` 按 `agentId + workspaceDir + settings` 永久缓存 manager。
- 每个 manager 在构造时调用 `createPostgresMemoryClient()`。
- 每个 manager 持有 watcher、timer、provider、缓存和数据库 client。
- `close()` 已实现，但 Gateway 没有集中管理已启动 manager 的生命周期。
- 配置变化产生新 cache key 时，旧 manager 没有统一关闭入口。

约 117 个 manager 和约 110 个 PostgreSQL socket 解释 0.8-1.0 GiB 常驻基线，
无法单独解释从基线增长到 3.9 GB。

## Root Cause Model

```text
工具取消参数滞留 ───────────┐
run/session Map 无 TTL ─────┤
trace / cache 缺少兜底清理 ─┼──> Major GC 活堆持续增长
未知 retaining object ──────┘                │
                                             ▼
119 个 memory manager ───────────────> 高常驻基线
                                             │
                                             ▼
Control UI reconnect
  -> sessions.list
  -> 120 个 store JSON.parse + clone + merge
  -> 最后一次分配超过约 4.1 GB V8 heap limit
  -> SIGABRT
  -> systemd restart
```

## Architecture Changes

### Tool Call Lifecycle Ownership

- `src/agents/pi-embedded-subscribe.handlers.types.ts`
  - 在 `EmbeddedPiSubscribeState` 增加 run-owned `toolStartData`。
- `src/agents/pi-embedded-subscribe.ts`
  - 初始化该 Map。
  - 在 `unsubscribe()` 中统一清理所有 pending tool 和 messaging 状态。
- `src/agents/pi-embedded-subscribe.handlers.tools.ts`
  - 删除 module-level `toolStartData`。
  - start/end 都通过 `ctx.state.toolStartData` 访问。
- `src/agents/pi-tools.before-tool-call.ts`
  - 为 adjusted params 引入 run-scoped key 和创建时间。
- `src/agents/pi-tool-definition-adapter.ts`
  - 所有异常路径在重新抛出前清理。
  - 使用 `finally` 作为最终兜底。

### Bounded Runtime State

- `src/infra/agent-events.ts`
  - context 增加 `registeredAt` 和 `lastActiveAt`。
  - clear 同时删除 context 和 sequence。
  - 暴露 `sweepStaleRunContexts()`。
- `src/gateway/server-maintenance.ts`
  - 每分钟调用 run context、rate-limit 和其他轻量 Map sweeper。
- `src/agents/subagent-registry.ts`
  - session-mode entry 在 cleanup 完成后应用绝对 TTL。
  - pending lifecycle error 增加 TTL。
- `src/agents/tracing/context.ts`
  - trace handle 增加最后活跃时间、TTL 和硬上限。

### Session Read Model

- `src/config/sessions/store.ts`
  - maintenance 默认使用 `enforce`。
  - load-time 对超限 store 执行 prune 和 cap。
  - 引入内部只读 snapshot API，避免查询路径重复深拷贝。
- `src/gateway/session-utils.ts`
  - 为 combined store 增加基于文件 mtime 的短期缓存。
  - 缓存只存查询所需投影，避免保留完整可变 entry 图。
- `src/gateway/server-methods/sessions.ts`
  - `sessions.list` 使用只读组合快照。
  - 保持现有参数和响应契约。

### PostgreSQL Manager Lifecycle

- `src/memory/postgres-client.ts`
  - 引入按 runtime credential 和连接配置分组的共享 pool registry。
  - registry key 不包含明文 URL，不进入日志。
  - pool 使用引用计数。
- `src/memory/postgres-manager.ts`
  - manager 获取 shared client lease。
  - `close()` 释放 lease，最后一个引用关闭 pool。
  - cache entry 增加最后访问时间和配置代次。
- `src/gateway/server-startup-memory.ts`
  - 返回 Gateway memory runtime handle。
  - handle 记录本次启动的 manager，并提供 `close()`。
- Gateway shutdown/config reload
  - 关闭失效 manager、watcher、timer 和 pool lease。

### Memory Diagnostics

- 新增内部 memory diagnostics 模块，收集：
  - `process.memoryUsage()`。
  - `v8.getHeapStatistics()`。
  - 已注册关键 Map 的 size。
  - PostgreSQL manager、pool、watcher 和活跃连接数量。
- 快照策略：
  - 默认关闭。
  - 配置显式开启。
  - heap used 超过阈值后只抓一次。
  - 抓取前检查目录和剩余磁盘空间。
  - 快照失败只记录错误，不影响 Gateway。

## Implementation Steps

### Phase 0: Establish Baseline And Diagnostics

1. **定义内存诊断快照结构**
   - File: `src/infra/runtime-memory-diagnostics.ts` (new)
   - Action:
     - 定义 `RuntimeMemorySnapshot`。
     - 收集 heap used、heap total、heap limit、RSS、external、arrayBuffers。
     - 支持注册命名计数器，不暴露容器内容。
   - Why: 后续每个修复阶段需要使用同一组指标对比。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Low.

2. **为关键容器增加只读 size accessor**
   - Files:
     - `src/infra/agent-events.ts`
     - `src/agents/pi-tools.before-tool-call.ts`
     - `src/agents/tracing/context.ts`
     - `src/agents/subagent-registry.ts`
     - `src/gateway/control-plane-rate-limit.ts`
     - `src/memory/postgres-manager.ts`
   - Action:
     - 暴露内部 diagnostics accessor。
     - 不导出 Map，不允许外部修改。
     - 测试辅助接口与生产 diagnostics 接口分离。
   - Why: 仅观察 heap 数字无法判断是哪类状态增长。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Low.

3. **接入低频内存采样和阈值日志**
   - File: `src/gateway/server-maintenance.ts`
   - Action:
     - 每 5 分钟采样。
     - 只在增长超过阈值、heap 占比超过阈值或 debug 模式下记录。
     - 日志不包含 tool args、session 内容、URL 或凭证。
   - Why: 避免高频日志，同时建立长运行曲线。
   - Dependencies: Steps 1-2.
   - Complexity: Low.
   - Risk: Low.

4. **增加受控 heap snapshot**
   - Files:
     - `src/infra/runtime-memory-diagnostics.ts`
     - memory diagnostics config schema files
   - Action:
     - 支持单次阈值快照。
     - 使用原子 guard 防止并发快照。
     - 校验磁盘预算和输出目录权限。
   - Why: 精确确定历史 3 GB 增量的 retaining path。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium. 快照会暂停事件循环并消耗大量磁盘。

### Phase 1: Fix Deterministic Tool Argument Leaks

1. **将 `toolStartData` 移入 embedded subscription state**
   - Files:
     - `src/agents/pi-embedded-subscribe.handlers.types.ts`
     - `src/agents/pi-embedded-subscribe.ts`
     - `src/agents/pi-embedded-subscribe.handlers.tools.ts`
   - Action:
     - 增加 `toolStartData: Map<string, ToolStartRecord>`。
     - key 只使用当前 run 内的 `toolCallId`。
     - start/end handler 访问 `ctx.state`。
   - Why: 工具临时参数的所有者应是当前 subscription。
   - Dependencies: Phase 0 size accessor recommended, not required.
   - Complexity: Low.
   - Risk: Low.

2. **统一 subscription teardown**
   - File: `src/agents/pi-embedded-subscribe.ts`
   - Action:
     - 在 `unsubscribe()` 清理 `toolStartData`。
     - 清理 `toolMetaById`、`toolSummaryById`、pending messaging Maps。
     - 保持已提交的 messaging 去重历史不变，直到返回结果被消费。
   - Why: end event 可能因 abort、transport failure 或 runtime error 缺失。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Medium. 需要避免过早清理仍用于最终回复的数据。

3. **修复 adjusted params 的 abort 清理顺序**
   - Files:
     - `src/agents/pi-tools.before-tool-call.ts`
     - `src/agents/pi-tool-definition-adapter.ts`
   - Action:
     - key 改为包含 `runId` 和 `toolCallId`。
     - value 增加 `createdAt`。
     - 成功路径消费一次。
     - error、AbortError、signal abort 路径在重新抛出前消费。
     - `finally` 再执行幂等删除。
   - Why: 当前取消路径明确跳过删除。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Medium. 必须保持 `after_tool_call` 使用调整后的参数。

4. **为 adjusted params 增加 TTL 和硬上限**
   - File: `src/agents/pi-tools.before-tool-call.ts`
   - Action:
     - 每次 set/get 时低成本清理过期项。
     - 最大条数按活跃并发工具数量设置，禁止依赖 1024 个陈旧项。
     - 超限时按最旧创建时间淘汰并记录一次限频 warning。
   - Why: 生命周期清理仍需面对缺失回调和未知异常。
   - Dependencies: Step 3.
   - Complexity: Low.
   - Risk: Low.

5. **补齐工具生命周期测试**
   - Files:
     - `src/agents/pi-embedded-subscribe.handlers.tools.test.ts`
     - `src/agents/pi-tool-definition-adapter.after-tool-call.test.ts`
     - `src/agents/pi-tools.before-tool-call.test.ts`
   - Action:
     - start 后 unsubscribe。
     - execute 中 signal abort。
     - execute 抛出 `AbortError`。
     - after hook 成功和失败。
     - 两个 run 使用相同 `toolCallId`。
   - Why: 覆盖当前缺失的异常和取消路径。
   - Dependencies: Steps 1-4.
   - Complexity: Medium.
   - Risk: Low.

### Phase 2: Bound Run, Session And Gateway State

1. **回移 agent event TTL 行为**
   - Files:
     - `src/infra/agent-events.ts`
     - `src/infra/agent-events.test.ts`
     - `src/gateway/server-maintenance.ts`
   - Action:
     - context 增加注册和最后活跃时间。
     - emit 时更新 `lastActiveAt`。
     - clear 同时删除 sequence。
     - 每分钟清理超过 30 分钟无活动的 context 和 sequence。
   - Why: 当前每个 run 都可能永久留下 sequence。
   - Dependencies: Phase 0 diagnostics.
   - Complexity: Medium.
   - Risk: Low.

2. **回移 session-mode subagent TTL**
   - Files:
     - `src/agents/subagent-registry.ts`
     - related subagent registry tests
   - Action:
     - sweeper 始终启动。
     - session-mode run 在 `cleanupCompletedAt` 后保留 5 分钟。
     - 清理关联 pending error、timer、waiter 和 trace handle。
     - 活跃或 cleanup 未完成的 run 不删除。
   - Why: session-mode entry 没有 `archiveAtMs`，当前永久跳过。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Medium. 需保持 thread binding 和 session reuse 语义。

3. **限制 control-plane rate-limit Map**
   - Files:
     - `src/gateway/control-plane-rate-limit.ts`
     - `src/gateway/control-plane-rate-limit.test.ts`
     - `src/gateway/server-maintenance.ts`
   - Action:
     - 5 分钟 stale TTL。
     - 最大 10000 条。
     - 超限时淘汰最旧 key。
   - Why: unique device/IP/connection key 可无限增长。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

4. **清理 node wake/nudge 状态**
   - Files:
     - `src/gateway/server-methods/nodes.ts`
     - `src/gateway/server/ws-connection.ts`
     - node wake tests
   - Action:
     - 增加 `clearNodeWakeState(nodeId)`。
     - node WebSocket 断开时调用。
     - 增加 TTL 兜底。
   - Why: node ID 变化或临时节点会永久留存。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

5. **限制 lifecycle trace handle**
   - Files:
     - `src/agents/tracing/context.ts`
     - tracing tests
   - Action:
     - value 增加创建和最后活跃时间。
     - ended 正常删除。
     - 维护任务清理过期 handle。
     - 增加硬容量上限。
   - Why: 缺失 ended 事件时 trace handle 可能保留完整 tracing context。
   - Dependencies: Phase 0 diagnostics.
   - Complexity: Medium.
   - Risk: Medium. 过早清理会丢失 subagent 结束 trace 关联。

6. **主动清理 session manager cache**
   - Files:
     - `src/agents/pi-embedded-runner/session-manager-cache.ts`
     - `src/agents/pi-embedded-runner/session-manager-cache.test.ts`
   - Action:
     - 后续 cache 活动时遍历清理所有过期项。
     - 清理周期限制在 1-30 秒。
   - Why: 当前未再次访问的 key 永久保留。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

### Phase 3: Reduce Session Store Allocation Amplification

1. **启用 load-time session maintenance**
   - Files:
     - `src/config/sessions/store.ts`
     - session pruning tests
   - Action:
     - 默认 maintenance mode 改为 `enforce`。
     - 当条目超过 `maxEntries` 时，在返回和缓存前执行 prune/cap。
     - 只在实际变化时失效序列化缓存并记录摘要。
   - Why: 超大 store 需要在加载入口受限。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Medium. 默认行为从 warning 变为删除过期 metadata。

2. **增加只读 session store snapshot**
   - File: `src/config/sessions/store.ts`
   - Action:
     - 保留现有 mutable load API。
     - 增加内部 readonly API，返回不可变缓存快照。
     - 查询调用方禁止修改 snapshot。
     - mutation 调用方继续获得 clone。
   - Why: `sessions.list` 无需为防外部修改进行多次完整深拷贝。
   - Dependencies: Step 1.
   - Complexity: High.
   - Risk: High. 误用 readonly snapshot 会污染全局缓存。

3. **缓存 combined session projection**
   - Files:
     - `src/gateway/session-utils.ts`
     - `src/gateway/server-methods/sessions.ts`
   - Action:
     - 组合缓存 key 使用 agent store path、mtime 和查询相关配置代次。
     - 缓存 session list 所需字段投影，不缓存完整 entry。
     - 设置短 TTL 和最大缓存代次。
     - 任一 store mtime 变化时重建。
   - Why: Control UI 重连不应重复解析和复制全部 store。
   - Dependencies: Step 2.
   - Complexity: High.
   - Risk: Medium. 失效错误会显示陈旧 session metadata。

4. **按请求条件减少扫描范围**
   - Files:
     - `src/gateway/session-utils.ts`
     - sessions handler tests
   - Action:
     - 存在 `agentId` 时只加载目标 agent store。
     - 存在精确 key prefix 时解析目标 agent。
     - 无过滤条件时使用 combined projection cache。
   - Why: 避免局部查询仍扫描 119 个 agent。
   - Dependencies: Step 3.
   - Complexity: Medium.
   - Risk: Medium. 必须保持 legacy key 和 main alias 行为。

5. **增加 session list 分配与兼容测试**
   - Files:
     - Gateway sessions tests
     - session store cache tests
   - Action:
     - 生成多 agent、多 store fixture。
     - 验证排序、过滤、title、last message 和 aliases。
     - 统计 load/parse 次数，重复请求不得重复读取未变化 store。
   - Why: 以确定性 I/O 次数代替脆弱的单测 heap 断言。
   - Dependencies: Steps 1-4.
   - Complexity: Medium.
   - Risk: Low.

### Phase 4: Reduce PostgreSQL Memory Baseline

1. **建立 shared PostgreSQL pool registry**
   - Files:
     - `src/memory/postgres-client.ts`
     - new pool registry tests
   - Action:
     - 按规范化连接配置和 runtime credential identity 分组。
     - 使用不可逆 digest 作为内部 key。
     - 返回 `{ sql, release }` lease。
     - 引用归零时执行 `sql.end()`。
   - Why: 当前约 117 个 manager 各自创建 client 和连接池。
   - Dependencies: Phase 0 pool diagnostics.
   - Complexity: High.
   - Risk: High. 错误分组会破坏凭证或 agent 隔离。

2. **PostgresMemoryManager 使用 client lease**
   - File: `src/memory/postgres-manager.ts`
   - Action:
     - 构造时 acquire lease。
     - `close()` 幂等释放。
     - transaction 仍通过当前 `activeSql` 传递。
     - status-purpose manager 完成后必须关闭。
   - Why: manager 不再拥有独占 pool。
   - Dependencies: Step 1.
   - Complexity: High.
   - Risk: High.

3. **建立 Gateway memory runtime handle**
   - Files:
     - `src/gateway/server-startup-memory.ts`
     - `src/gateway/server-startup.ts`
     - Gateway shutdown files
   - Action:
     - startup 返回已初始化 manager 集合。
     - shutdown 调用统一 `close()`。
     - 配置 reload 对比新旧 cache key，关闭失效 manager。
   - Why: 当前 manager `close()` 没有 Gateway owner。
   - Dependencies: Step 2.
   - Complexity: High.
   - Risk: Medium.

4. **评估延迟初始化**
   - Files:
     - `src/gateway/server-startup-memory.ts`
     - `src/agents/tools/memory-tool.ts`
   - Action:
     - 先保留 main 和近期活跃 agent startup sync。
     - 其他 agent 首次 memory tool 调用时初始化并同步。
     - watcher 缺失期间的文件变化通过首次 sync 补齐。
   - Why: 119 个 agent 的 workspace memory 总量只有 3.66 MiB，全部常驻 manager
     的成本过高。
   - Dependencies: Steps 1-3 and production metrics.
   - Complexity: High.
   - Risk: High. 首次查询延迟会增加。

5. **为 manager cache 增加代次和闲置清理**
   - File: `src/memory/postgres-manager.ts`
   - Action:
     - cache entry 保存 last access、config generation 和 active operation count。
     - 只关闭无活跃操作、已失效或超过 idle TTL 的 manager。
     - close 与 sync/search 并发时等待 in-flight promise。
   - Why: 防止配置变化产生旧 manager、watcher 和 pool lease 滞留。
   - Dependencies: Step 3.
   - Complexity: High.
   - Risk: High.

### Phase 5: Validation, Rollout And Cleanup

1. **运行 focused tests**
   - Action:
     - 运行工具生命周期、agent events、subagent registry、rate limit、node wake、
       session store、sessions handler、PostgreSQL manager 和 client tests。
     - 不运行 `make test`。
   - Why: 验证触及行为，控制测试范围。
   - Dependencies: Relevant phase completed.
   - Complexity: Medium.
   - Risk: Low.

2. **运行 lint**
   - Action:
     - 在当前工作树执行 `make lint`。
     - 检查 diff。
     - 只恢复 lint 引入的无关格式化变化。
   - Why: 遵守仓库验证流程。
   - Dependencies: Implementation completed.
   - Complexity: Low.
   - Risk: Medium. 当前工作树存在大量无关未跟踪文件。

3. **分阶段部署**
   - Action:
     - Deployment A: Phase 0-2。
     - Deployment B: Phase 3。
     - Deployment C: Phase 4 shared pool。
     - Deployment D: Phase 4 lazy initialization。
   - Why: 保留每一类修复的内存归因。
   - Dependencies: Owner approval and build verification.
   - Complexity: Medium.
   - Risk: Medium.

4. **观察窗口**
   - Action:
     - 每次部署至少覆盖 48 小时和一次历史故障周期。
     - 比较 Major GC 后 heap、RSS、关键 Map size、manager/pool 数量和
       `sessions.list` 延迟。
     - heap 持续增长时，在 3.0-3.5 GiB 触发单次 snapshot。
   - Why: 历史 OOM 周期约 39-42 小时。
   - Dependencies: Deployment.
   - Complexity: Medium.
   - Risk: Low.

## Testing Strategy

### Unit Tests

- Tool lifecycle:
  - start/end 后 Map 为零。
  - start/unsubscribe 后 Map 为零。
  - signal abort 后 adjusted params 为零。
  - `AbortError` 后 adjusted params 为零。
  - after hook 仍收到调整后的参数。
  - 相同 `toolCallId`、不同 `runId` 不串数据。
- Agent events:
  - clear 同时删除 context 和 sequence。
  - stale context 按 last activity 清理。
  - active context 不被 sweeper 删除。
- Subagent registry:
  - session-mode cleanup 后 TTL 删除。
  - active session-mode run 不删除。
  - thread binding 保持。
- Gateway Maps:
  - rate-limit 超过硬上限后保持有界。
  - node disconnect 清理 wake/nudge。
  - stale trace handle 清理。
- Session store:
  - load-time prune/cap。
  - readonly snapshot 不允许 mutation path 污染缓存。
  - combined projection 按 mtime 失效。
- PostgreSQL:
  - 相同 credential/config 共享 pool。
  - 不同 runtime account 不共享。
  - reference count 归零后关闭一次。
  - manager close 幂等。
  - config generation 变化关闭旧 manager。

### Integration Tests

- 创建 119 个 agent store fixture，连续调用 `sessions.list`：
  - 未变化文件只读取一次。
  - 修改单个 store 后只重建受影响快照。
  - 响应与旧实现深度相等。
- 连续执行 10000 次工具成功、失败和取消：
  - 工具临时 Map 回到零或当前活跃数量。
  - diagnostics size 不随累计调用数增长。
- 连续创建和结束 10000 个 run：
  - TTL 后 run context、sequence、trace 和 registry 回到稳定值。
- 使用多个 agent 并发 memory search：
  - pool 数量按 credential group 有界。
  - agent 查询结果隔离。
  - manager close 不终止其他 manager 的活跃查询。

### Soak Tests

- 负载模型：
  - `sessions.list` 每分钟 2 次。
  - `chat.history` 每分钟 1 次。
  - embedded run 和 tool call 按历史比例生成。
  - 周期性 Control UI reconnect。
  - 注入 5% tool abort 和 1% missing end event。
- 持续时间：
  - 本地加速测试至少 6 小时。
  - 生产灰度至少 48 小时。
- 通过条件：
  - Major GC 后 heap 不出现持续单调增长。
  - 6 小时测试后关键 Map size 回到活跃工作集范围。
  - `sessions.list` P95 不高于基线。
  - PostgreSQL pool/socket 数量不再接近 agent 数量。

## Rollout Plan

```text
Baseline metrics
    │
    ▼
Phase 0 diagnostics
    │
    ▼
Phase 1-2 deterministic leak fixes
    │  observe >= 48h
    ▼
Phase 3 session allocation fixes
    │  observe >= 48h
    ▼
Phase 4 shared pool
    │  observe >= 48h
    ▼
Phase 4 lazy manager initialization
```

- 每次部署前按 owner-approved 流程运行 `make build`。
- 每次部署后需要显式批准 Gateway restart。
- 每阶段保留独立 commit，便于回滚。
- Phase 4 shared pool 和 lazy initialization 必须拆成两个部署。
- `--max-old-space-size=12288` 可在修复观察期作为临时兜底。
- 兜底开启后必须同时配置 diagnostics；内存增长不能因更大 heap 被隐藏。

## Risks And Mitigations

- **风险：工具状态清理过早，after hook 丢失调整后参数**
  - Mitigation: 成功路径先读取参数，再执行幂等删除；异常路径统一 finally 清理。

- **风险：session-mode subagent TTL 破坏可复用 thread binding**
  - Mitigation: 只删除 run tracking entry，不删除 session 或 thread binding；以
    `cleanupCompletedAt` 作为 TTL 起点。

- **风险：readonly session snapshot 被误修改**
  - Mitigation: API 命名明确；开发环境可 deep-freeze；mutation API 保持 clone。

- **风险：combined session cache 显示陈旧数据**
  - Mitigation: mtime + config generation 双重失效；短 TTL；mutation 后主动失效。

- **风险：共享 PostgreSQL pool 混用不同凭证**
  - Mitigation: pool key 包含 runtime credential identity 和全部连接行为配置；
    添加明确的不共享测试。

- **风险：共享 pool 降低高并发吞吐**
  - Mitigation: 先记录真实并发；按 credential group 配置 pool max；观察等待时间。

- **风险：关闭 idle manager 时仍有 search/sync**
  - Mitigation: active operation reference count；关闭前等待 in-flight promise。

- **风险：heap snapshot 阻塞 Gateway 或占满磁盘**
  - Mitigation: 默认关闭；单次触发；磁盘预算；独立目录；失败不重试。

- **风险：多项修复同时部署后无法归因**
  - Mitigation: 按 Phase 0-2、Phase 3、Phase 4 分阶段部署，每阶段观察至少 48 小时。

- **风险：扩大 V8 heap 后宿主机压力增加**
  - Mitigation: 12 GiB 仅为临时值；同时监控 RSS、cgroup 和宿主机 available memory。

## Success Criteria

- [ ] 工具 start 后 abort/unsubscribe 不留下完整 args。
- [ ] `adjustedParamsByToolCallId` 在 success、error、AbortError 和 signal abort 后清零。
- [ ] 所有长期 run/session Map 具备显式清理、TTL 和硬容量上限。
- [ ] session-mode subagent tracking 在 cleanup 完成后按 TTL 删除。
- [ ] `sessions.list` 不再对未变化的 120 个 store 重复读取、解析和多次深拷贝。
- [ ] session maintenance 默认 enforce，并在 load-time 对超限 store 生效。
- [ ] PostgreSQL pool 数量按 credential group 有界，不再接近 agent 数量。
- [ ] 配置变化和 Gateway shutdown 会关闭失效 manager、watcher、timer 和 pool lease。
- [ ] diagnostics 能输出 heap、RSS、关键 Map size、manager 和 pool 数量。
- [ ] 可在受控阈值下生成单次 heap snapshot。
- [ ] focused tests 和 lint 通过。
- [ ] 生产灰度连续运行 48 小时后，Major GC 活堆没有持续单调增长。
- [ ] 覆盖历史 39-42 小时故障周期后，没有再次出现约 3.9 GB 活堆 OOM。
- [ ] `sessions.list` P95 延迟不高于修复前基线。

## Recommended Implementation Order

```text
1. Diagnostics and heap snapshot guard
2. toolStartData run ownership
3. adjusted params abort cleanup
4. agent event / subagent / trace / rate-limit TTL
5. session manager cache cleanup
6. load-time session maintenance
7. readonly session snapshot and combined projection cache
8. shared PostgreSQL pool
9. Gateway memory runtime owner and stale manager close
10. lazy memory manager initialization
```

优先完成第 1-5 项。它们改动范围可控，覆盖已由源码证明的泄漏路径。第 6-7 项降低
OOM 触发概率。第 8-10 项属于高风险架构优化，应建立 heap snapshot 和长运行指标后
再实施。
