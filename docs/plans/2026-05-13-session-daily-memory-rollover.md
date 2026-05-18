# Implementation Plan: Daily Structured Summary for Session Rollover

## Overview

OpenClaw 现有的 builtin `session-memory` 路径会在显式 `/new`、`/reset` 时把旧会话写成 `memory/YYYY-MM-DD-slug.md`。这条链路本质上是 **transcript-style capture**：取最近一段 user/assistant 内容，生成 slug，然后落成单独 Markdown 文件。

这个策略对 builtin memory 已经显得过于粗。它有几个直接问题：

- 会把原始 transcript 副本继续塞进 `memory/*.md`，造成 recall 噪声和重复索引。
- 它偏向“保留现场”，不擅长沉淀高信号信息，例如用户偏好、失败经验、自定义要求、已拍板决策。
- 当 daily rollover 也复用这条路径时，会进一步制造同日多份 `-slug.md`，并把安全策略、startup context、quoted memory 等模板噪声反复写入索引。

同时，builtin memory 已支持把 **原始会话**作为独立 source 建索引。也就是说，raw transcript 的职责本来就应该由 `sessions` source 承担，而不是再通过 `memory/*.md` 保留一份 Markdown 副本。

因此，这次方案将 daily rollover 的沉淀策略整体改成：

- raw transcript 由 `sessions` source 负责召回
- daily rollover 只负责生成 **grounded structured summary**
- summary 追加到 **新一天** 的 `memory/YYYY-MM-DD.md`
- `/new` 不再触发 transcript-style 写入
- `/reset` 保留为显式人工总结入口，但输出形态也改成 structured summary

这让 memory 层的职责更清晰：

- `sessions` source：原始会话召回
- `memory/YYYY-MM-DD.md`：当天 structured summary + running notes
- `MEMORY.md`：跨天稳定的长期事实

## Requirements

- 仅当旧会话因 **daily reset** 失效并切换新会话时，自动生成一份 structured summary。
- 因 **idle timeout** 失效并切换新会话时，不生成 summary。
- `/new` 不再触发 transcript-style memory capture。
- `/reset` 仍保留为显式人工总结入口，但输出与 daily rollover 使用同一 structured summary 形态。
- summary 必须写入 **新一天** 的 `memory/YYYY-MM-DD.md`，而不是单独的 `YYYY-MM-DD-slug.md`。
- summary 必须采用 **append-only 独立 block**，不覆盖旧 block，不维护单个可变汇总 section。
- summary 必须是 **grounded but structured**：
  - grounded：每条结论都必须可由旧 transcript 直接支持
  - structured：不再保留原始对话形态，只输出高信号摘要
- summary 只沉淀高信号类别：
  - 用户偏好
  - 自定义需求
  - 失败经验 / 反模式
  - 重要决策
  - 未完成事项
  - 风险 / 注意点 / 边界约束
- 若会话中存在 `researcher` 的 `export-file` handoff，则额外沉淀：
  - `workspace-relative export.path`
  - `summary`；若缺失则退回 `export.title`
- 自动 rollover 触发的 summary 必须是 **best-effort 异步执行**，不能阻塞新会话首条回复。
- 同一个旧 `sessionId` 只能被自动 summary 一次，避免重复沉淀。
- builtin memory 的 raw transcript recall 保持显式 opt-in；默认可以继续只使用 `sources: ["memory"]`。
- 如需同时召回原始会话，需要显式设置 `experimental.sessionMemory: true` 和 `sources: ["memory", "sessions"]`。

## Non-Goals

- 不保留 `/new` 的 transcript-style capture 作为主方案。
- 不继续把 daily rollover 设计成 transcript 副本保留层。
- 不在这一步直接写 `MEMORY.md`。
- 不在这一步做跨天模式归纳或 durable promotion。
- 不把所有 subagent / artifacts 都纳入产物总结。
- 不读取 researcher 导出文件正文来做二次总结。
- 不暴露绝对服务器路径。
- 不改动 pre-compaction memory flush 的行为。
- 不因 compaction 额外触发新的 rebuild / reindex 路径。
- 不在本期引入新的用户可见 slash command。

## Current Behavior

- `/new` / `/reset`
  - 通过 builtin `session-memory` hook 保存旧会话上下文。
  - 读取最近 N 条 user/assistant 内容（默认 15）。
  - 生成 slug。
  - 写入 `memory/YYYY-MM-DD-slug.md`。

- daily / idle 自动 rollover
  - 通过 `resolveSessionResetPolicy()` + `evaluateSessionFreshness()` 判断旧 session 是否 stale。
  - stale 后在下一条消息进入时切换到新 `sessionId`。
  - 当前 daily rollover 已复用 `captureSessionToMemory(...)`，但本质仍然是 transcript-style capture。

- builtin memory
  - 已支持索引 `memory/*.md`
  - 也支持把原始会话作为 `sessions` source 独立索引

现网样本已经说明 transcript-style capture 的问题：

- `memory/2026-05-14-2301.md`
- `memory/2026-05-15-0033.md`
- `memory/2026-05-15-0339.md`
- `memory/2026-05-15-0412.md`

这些文件里反复沉淀了 runtime safety policy、startup context 和模板化安全文本，说明当前策略在 recall 质量上已经开始失真。

## Decision

采用以下策略：

1. **Replace transcript capture with structured summary**
   - daily rollover 不再写 transcript 副本。
   - 它只生成 structured summary。

2. **Remove `/new` auto capture**
   - `/new` 不再触发 memory 总结。
   - 显式人工总结入口只保留 `/reset`。

3. **Keep `sessions` as an opt-in raw recall layer**
   - builtin memory 默认可以继续只索引 `sources: ["memory"]`。
   - raw transcript 由可选 `sessions` source 负责。
   - 启用时必须显式设置 `experimental.sessionMemory: true` 和 `sources: ["memory", "sessions"]`。

4. **Write summary into the new day’s daily note**
   - summary 追加到新一天的 `memory/YYYY-MM-DD.md`。
   - 不再生成 `memory/YYYY-MM-DD-slug.md`。

5. **Append-only independent blocks**
   - 每次 daily rollover 或 `/reset` 只追加一个新的 summary block。
   - 不编辑旧 block。

6. **Grounded high-signal extraction**
   - summary 只提炼高信号 delta，不抄 transcript。
   - 只写当天新出现或被再次确认的信息。

7. **Researcher export summary**
   - 仅对 `researcher` 的 `export-file` handoff 追加“文件路径 + 简要描述”。
   - 使用 workspace-relative path。
   - 不读取导出文件正文。

8. **Async + idempotent**
   - 自动 summary 必须 fire-and-forget。
   - 同一旧 `sessionId` 只执行一次。

## Conceptual Boundary

### Structured summary vs raw transcript

新的 daily rollover summary 不是 raw transcript 的替身。

raw transcript 的职责：

- 作为原始证据
- 支撑 `sessions` source recall
- 必要时允许更细粒度追溯

daily structured summary 的职责：

- 面向单个旧 session 的高信号提炼
- 把当天值得保留的事实、偏好、约束、失败经验整理成更适合 recall 的文本
- 作为 short-term explicit memory 层的一部分

因此：

- `sessions` source 保证“不丢证据”
- `memory/YYYY-MM-DD.md` 保证“提炼可用信息”
- `MEMORY.md` 才承接“跨天长期稳定事实”

### Structured summary is still not Dreaming

daily structured summary 比旧的 grounded capture 更强，但仍不是 Dreaming。

它仍然：

- 面向单个旧 session
- 面向会话切换边界
- 不做跨天归纳
- 不直接做 durable promotion

Dreaming 仍然负责：

- 跨多来源短期痕迹做 light / REM / deep consolidation
- 决定什么值得升级到长期记忆

### Pre-compaction flush still stays

pre-compaction memory flush 继续保留。

它的职责与 daily structured summary 不同：

- pre-compaction flush
  - 面向“即将压缩前”的同日兜底写盘
  - 目标是尽量在上下文被压缩前，把值得保留的短期记忆写进当天 daily note

- daily structured summary
  - 面向“跨日会话切换”的结构化沉淀
  - 目标是把上一会话中的高信号信息整理成新一天可召回的 summary block

因此本方案不新增 compaction 专属的 rebuild / reindex 逻辑。

flush 产生的 `memory/YYYY-MM-DD.md` 变更，继续依赖默认的文件监听与 debounced incremental sync 进入索引和数据库。

## Proposed Runtime Semantics

### Stale reason model

保持现有 `staleReason` 语义：

- `staleReason = "daily"` 时，允许自动 summary
- `staleReason = "idle"` 时，明确跳过

必须继续避免仅根据 `policy.mode === "daily"` 触发总结，因为 daily 策略下也可能先被 idle 条件淘汰。

### Trigger matrix

- `/new`
  - 不触发 summary

- `/reset`
  - 触发 structured summary
  - 归类为显式人工总结

- daily rollover
  - 当旧会话因 `staleReason === "daily"` 切到新 `sessionId` 时触发
  - summary 异步执行

- idle rollover
  - 不触发 summary

### File strategy

summary 文件策略固定为：

- 文件：`memory/YYYY-MM-DD.md`
- 日期：**新一天**
- 写入方式：append-only block

每个 block 建议形态如下：

```markdown
## Daily Structured Summary

- **Generated At**: 2026-05-15 04:00 CST
- **Source**: daily-rollover
- **Source Sessions**: f291502b-0669-443e-8a95-9129fa67c8a6

### 用户偏好

- ...

### 自定义需求

- ...

### 失败经验 / 反模式

- ...

### 重要决策

- ...

### 未完成事项

- ...

### 风险 / 注意点

- ...

### Researcher 产物

- `artifacts/exports/feishu/glp1-oral-small-molecule-clinical/report.md` — 已完成中文竞争情报报告草案，可直接转 Feishu 文档。
```

### Extraction rules

summary 只允许沉淀以下高信号类别：

- 用户偏好
- 自定义需求
- 失败经验 / 反模式
- 重要决策
- 未完成事项
- 风险 / 注意点 / 边界约束
- Researcher 产物（仅 `researcher export-file`）

禁止沉淀：

- 寒暄
- 整段原始 transcript
- conversation metadata JSON
- runtime safety / security policy 模板
- startup context
- quoted daily memory
- `<relevant-memories>`
- `<SUBAGENT_HANDOFF>` 的大段原文
- slash commands
- 工具噪声

### Researcher export-file summary rules

仅当 transcript 中出现 `researcher` 的 `export-file` handoff 时，追加产物总结：

- 路径来源：`export.path`
- 路径形态：workspace-relative，例如 `artifacts/exports/feishu/...`
- 描述优先级：
  1. `summary`
  2. `export.title`

明确禁止：

- 读取导出文件正文
- 暴露绝对路径
- 总结非 researcher 的任意 artifacts 文件

## Architecture Changes

- `src/auto-reply/reply/session.ts`
  - daily rollover 仍是自动 summary 的接入点
  - 但调用目标从 transcript capture helper 改为 structured summary helper
  - `/new` 路径不再触发 capture

- `src/hooks/bundled/session-memory/handler.ts`
  - 从 transcript-style `captureSessionToMemory(...)` 重构为 structured summary helper
  - `/reset` 复用该 helper
  - `/new` 从主逻辑中移除

- `src/config/sessions/types.ts`
  - 保留 daily summary 幂等字段，例如 `dailyMemoryCaptureAt` / `dailyMemoryCaptureSessionId`
  - 语义从“capture”转向“summary”

- `docs/concepts/memory.md`
  - 后续需同步说明：
    - `sessions` source 是 raw transcript recall 层
    - daily rollover summary 是 structured short-term memory 层

- `docs/automation/hooks.md`
  - 后续需同步说明：
    - `session-memory` 不再以 `/new` transcript capture 为主叙事
    - `/reset` 仍是显式人工总结入口

## Implementation Steps

### Phase 1: Replace output shape

1. **删除 `-slug.md` 作为主方案输出**
   - 把文档中的 transcript-style 输出改成 `memory/YYYY-MM-DD.md` append-only block。

2. **定义 structured summary block schema**
   - 固定 metadata 行和 6-7 个高信号 section。

3. **移除最近 N 条 transcript 作为主 summary 策略**
   - `messages: 15` 不再是主叙事中心。

### Phase 2: Change trigger semantics

4. **移除 `/new` 自动总结**
   - `/new` 不再触发 summary。

5. **保留 `/reset` 作为显式总结入口**
   - `/reset` 继续走 helper，但输出改为 structured summary。

6. **保持 daily-only rollover**
   - 只有 `staleReason === "daily"` 才触发自动 summary。

### Phase 3: Define extraction rules

7. **固定高信号提炼范围**
   - 只写偏好、需求、失败经验、决策、待办、风险。

8. **加入 researcher 导出产物摘要**
   - 仅处理 `researcher export-file` handoff。
   - 记录 workspace-relative path + 简要描述。

9. **明确噪声过滤规则**
   - 文档中列出必须忽略的模板文本和 metadata 源。

### Phase 4: Keep runtime guarantees

10. **保持 fire-and-forget**
    - 自动 summary 不阻塞新会话首条回复。

11. **保持 `sessionId` 级别幂等**
    - 同一旧 `sessionId` 最多自动 summary 一次。

12. **保留 failure isolation**
    - summary 失败只记日志，不影响新会话继续。

13. **保留 pre-compaction flush 现状**
    - compaction 前的 memory flush 继续保留。
    - flush 写盘后的索引更新继续走 watcher / incremental sync。
    - 不新增 compaction-specific rebuild / reindex。

## Testing Strategy

- Session lifecycle tests
  - daily stale -> 新 session + 追加 structured summary block
  - idle stale -> 新 session + 不追加 summary
  - `/new` -> 不落任何 summary
  - `/reset` -> 追加 structured summary
  - 同一旧 session 不重复 summary

- Content-shape tests
  - 输出为 `memory/YYYY-MM-DD.md`
  - 输出为 append-only block
  - 不再生成 `YYYY-MM-DD-slug.md`
  - 不包含 raw transcript 副本

- Filtering tests
  - 过滤 security policy / startup context / quoted memory / metadata JSON / handoff 原文
  - researcher export-file 只保留 path + 简述

- Failure-path tests
  - summary helper 抛错时：
    - 新会话正常继续
    - 不影响首条回复
    - 只记录日志

- Compaction interaction tests
  - pre-compaction flush 继续写 `memory/YYYY-MM-DD.md`
  - 不引入额外的 compaction rebuild / reindex 分支
  - flush 写盘后仍由默认 watcher / incremental sync 更新索引

## Risks & Mitigations

- **Risk**: 旧文档和旧实现都围绕 capture layer，改写不彻底会导致语义混杂。
  - **Mitigation**: 本文档整体替换旧叙事，不保留 transcript capture 作为主方案。

- **Risk**: 去掉 `/new` 后，用户担心显式切会话时没有总结。
  - **Mitigation**: 保留 `/reset` 作为显式人工总结入口。

- **Risk**: 若不启用 `sessions` source，会削弱 raw transcript recall。
  - **Mitigation**: 在文档中明确 sessions recall 是 opt-in，并给出启用配置。

- **Risk**: structured summary 过度抽象，开始漂。
  - **Mitigation**: 明确要求 grounded extraction，每条结论必须能从 transcript 直接支持。

- **Risk**: researcher 产物总结泄露绝对路径或读取正文。
  - **Mitigation**: 只记录 workspace-relative `export.path` 和 `summary/title`，不读取文件正文。

- **Risk**: 去掉 `/new` transcript capture 后，担心 compaction 前没有兜底写盘。
  - **Mitigation**: 保留 pre-compaction memory flush，继续作为同日 durable note 的安全网。

## Success Criteria

- [ ] `/new` 不再触发 transcript-style memory capture。
- [ ] `/reset` 保留显式人工总结入口，且输出变为 structured summary。
- [ ] daily stale 自动切换时，会异步向新一天 `memory/YYYY-MM-DD.md` 追加 structured summary block。
- [ ] idle stale 自动切换时，不会追加 summary。
- [ ] 同一旧 `sessionId` 不会被自动 summary 多次。
- [ ] summary 不再写 raw transcript 副本，不再依赖 `YYYY-MM-DD-slug.md`。
- [ ] 文档明确说明 raw transcript recall 需要显式启用 `experimental.sessionMemory: true` 和 `sources: ["memory", "sessions"]`。
- [ ] researcher `export-file` handoff 会被沉淀为“workspace-relative path + 简要描述”。
- [ ] summary 会过滤安全策略、startup context、quoted memory、metadata JSON 和 handoff 原文等噪声。
- [ ] 文档明确区分 `sessions` recall、daily structured summary 与 `MEMORY.md` 长期记忆三层职责。
- [ ] pre-compaction memory flush 保留，且 flush 写盘后的入库继续依赖 watcher / incremental sync，而不是新增 compaction-specific rebuild / reindex。
