# Implementation Plan: Compaction And Pruning Stabilization

## Overview

当前 3.0 MB transcript 在 preflight 阶段估算到约 45 万 tokens，超过 262144 context window 和 20000 reserveTokens 后进入模型摘要式 compaction。`compaction-safeguard` 会把大量历史分块并串行调用当前模型摘要，300 秒安全网到期后 abort，没有落 compaction entry，导致下一轮重复处理同一个膨胀会话。

方案按止血、治本、优化推进。第一目标是保证 timeout 或 compaction error 后一定落一个不调模型的 emergency compaction entry，切断重复卡死链路；后续再把 toolResult 写入、preflight、compaction 输入和 contextPruning 门禁分别收紧。

## Requirements

- compaction timeout、AbortError、摘要调用超预算时必须推进会话状态，不能让同一个 transcript 下一轮继续进入相同 compaction 路径。
- emergency compaction 路径不得调用模型，行为参考 Codex token-budget compaction：直接安装新的压缩窗口并记录生命周期。
- 一次 compaction 生命周期内模型摘要调用最多 2 次，计数跨 dropped summary、history summary、turn prefix summary 共享。
- toolResult 在写入 session history 前即有单条硬上限，并保留原始大小、工具名、截断说明等 metadata。
- preflight 估算前先运行确定性裁剪，不依赖 provider eligibility、TTL 或 `contextPruning.mode`。
- compaction 输入必须有总预算和 chunk 数上限，禁止把 45 万 token 级别的历史交给 `summarizeInStages()`。
- `contextPruning` 注册和 TTL 记录要与 `isCacheTtlEligibleProvider()` 解耦，显式开启 pruning 的 provider 都应注册。
- 校验 workspace 中 OTR、DeepSeek、MicU、SSS、DuckCoding 等模型的 contextWindow 配置，避免阈值计算失准。

## Current State

- preflight 入口在 `src/agents/pi-embedded-runner/run/attempt.ts`，`estimatePromptPreflightTokens()` 直接估算 `activeSession.messages`，超过阈值后调用 `activeSession.compact()`。
- compaction timeout 安全网在 `src/agents/pi-embedded-runner/compaction-safety-timeout.ts`，默认 300 秒。
- `runPreflightCompactionToSettled()` 捕获 timeout 后调用 `abortCompaction()`，但当前没有 emergency compaction entry 兜底。
- `src/agents/pi-extensions/compaction-safeguard.ts` 会在 `session_before_compact` 里调用 `summarizeInStages()`，当前没有全局摘要调用预算。
- `src/agents/session-tool-result-guard.ts` 已在 persistence 前调用 `truncateToolResultMessage()`，但默认 `HARD_MAX_TOOL_RESULT_CHARS = 400000`，仍可能允许单条 toolResult 接近 10 万 tokens。
- `src/agents/pi-embedded-runner/tool-result-truncation.ts` 已支持 overflow 后按 contextWindow 截断 session 文件，但触发太晚。
- `src/agents/pi-embedded-runner/tool-result-context-guard.ts` 已有 prompt 前 in-memory toolResult guard，但它通过 `Agent.transformContext` 生效，preflight compaction 发生在 `activeSession.prompt()` 前，不能保证先于 preflight 估算执行。
- `src/agents/pi-embedded-runner/extensions.ts` 和 `src/agents/pi-embedded-runner/run/attempt.ts` 都复用 `isCacheTtlEligibleProvider()`，导致 OTR、DeepSeek 等 provider 不注册 `contextPruning`，也不会写 `openclaw.cache-ttl`。
- Pi SDK `appendCompaction(summary, firstKeptEntryId, ...)` 需要 `SessionEntry.id`；D1 的保留边界在 `AgentMessage[]` 层选择，必须增加 message 边界到 branch entry id 的解析层。
- `transcriptPolicy.repairToolUseResultPairing` 是 provider policy flag，OpenAI 兼容 provider 下为 false；emergency 裁剪不能依赖该 flag 来清理 orphan toolResult。

## Architecture Changes

- `src/agents/pi-embedded-runner/emergency-compaction.ts`
  - 新增无模型 emergency compaction helper，负责选择保留尾部、解析 `firstKeptEntryId`、显式清理 orphan toolResult、生成本地 summary、append compaction entry、重建 session context。
  - 写入前用 `sessionManager.getEntries()` 和 SDK 导出的 `getLatestCompactionEntry()` 做幂等检测，避免 timeout 竞态下重复 append compaction entry。
- `src/agents/context-window-guard.ts`
  - 对 workspace/custom provider 使用 `DEFAULT_CONTEXT_TOKENS` 兜底的场景增加 source 诊断和 warning；动态 fallback 模型可通过全局 `models.defaultContextWindow` 声明默认窗口，避免破坏 baseUrl-only 配置兼容性。
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - 在 preflight compaction timeout 或 error 后调用 emergency helper。
  - 在 preflight token estimate 之前运行 deterministic pruning。
- `src/agents/pi-embedded-runner/compact.ts`
  - explicit overflow compaction 失败或 timeout 后也复用 emergency helper。
- `src/agents/compaction.ts`
  - 给 `summarizeInStages()`、`summarizeWithFallback()`、`summarizeChunks()` 增加共享摘要预算参数。
  - 增加 compaction 输入预算和 chunk 数上限。
- `src/agents/pi-extensions/compaction-safeguard.ts`
  - 创建并传递一次 compaction 生命周期的 summary budget。
  - 在预算耗尽时立即返回 fallback summary。
- `src/agents/pi-embedded-runner/preflight-pruning.ts`
  - 新增 preflight 专用确定性裁剪，不依赖 TTL 和 provider。
- `src/agents/pi-embedded-runner/tool-result-truncation.ts`
  - 收紧单条 toolResult 上限，支持占比制总预算、head/tail 截断、metadata 保留。
- `src/agents/session-tool-result-guard.ts`
  - 继续作为 persistence 边界，调用新的 toolResult truncation policy。
- `src/agents/pi-embedded-runner/cache-ttl.ts`
  - 拆出 pruning eligibility 和 provider cache eligibility，保留 Anthropic cache TTL 判断给缓存相关逻辑。
- `src/agents/pi-embedded-runner/extensions.ts`
  - `contextPruning.mode === "cache-ttl"` 时注册 pruning，不再按 Anthropic allowlist 拦截。
- `src/config/defaults.ts`
  - 调整默认 pruning TTL，不再用 1h 作为所有场景的裁剪节奏。
- `docs/concepts/session-pruning.md` 和 `/reference/session-management-compaction`
  - 后续实现时同步更新实际语义。本计划只新增方案文档。

## Implementation Steps

### Phase 0: Context Window 诊断

1. **校验模型窗口来源** (File: `src/agents/context-window-guard.ts`)
   - Action: 增加测试覆盖 `resolveContextWindowInfo()` 对 `models.providers.*.models[].contextWindow`、model registry、`agents.defaults.contextTokens` 的优先级。
   - Why: 所有 reserve、preflight、pruning、compaction budget 都依赖这个值。
   - Dependencies: None.
   - Risk: Low.

2. **记录运行时窗口诊断** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 在已有 `[context-preflight]` log 中补充 `contextWindowSource`，并在低于 `CONTEXT_WINDOW_WARN_BELOW_TOKENS` 时 warn。
   - Why: OTR、DeepSeek、MicU、SSS、DuckCoding 等 workspace 模型如果窗口配置错，能直接从日志看到来源。
   - Dependencies: Step 1.
   - Risk: Low.

3. **诊断 workspace 模型默认窗口兜底** (File: `src/agents/context-window-guard.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 增加 default context window 诊断；当 `contextWindowSource === "default"` 且 provider/model 来自 workspace/custom 配置集合时输出明确 warning，建议显式配置 `models.defaultContextWindow`、`models.providers.*.models[].contextWindow` 或 registry context window。
   - Why: Phase 3、Phase 4、Phase 5、D1 都按同一个 `contextWindow` 计算预算；对已知 workspace 模型静默使用 `DEFAULT_CONTEXT_TOKENS = 200000` 会让所有阈值同时失真。
   - Dependencies: Step 1.
   - Risk: Medium.

### Phase 1: 止血入口

1. **新增 emergency compaction helper** (File: `src/agents/pi-embedded-runner/emergency-compaction.ts`)
   - Action: 实现 `appendEmergencyCompaction(params)`：
     - 打开或复用 `SessionManager`。
     - 读取当前 branch，并记录 `preLeafId`、`preCompactionCount`。
     - 保留最近用户回合或最近 `keepRecentTokens` 对应尾部。
     - 基于 branch entries 建立 context message index 到 `SessionEntry.id` 的对齐结果；实现 `resolveFirstKeptEntryId(branchEntries, keptMessageBoundary)`。
     - 对齐时只把会进入 `buildSessionContext()` 的 `message`、`custom_message`、`branch_summary` 纳入 message 序列；跳过 `model_change`、`thinking_level_change`、`custom`、`label`、`session_info` 等非上下文 entry。
     - 对裁剪后的 messages 显式运行 `dropOrphanedToolResults()`；仅在 provider policy 允许时再运行 `repairToolUseResultPairing()` 插入 synthetic toolResult。
     - 对被丢弃部分生成本地 summary，不调用模型。
     - append 前重新读取 `sessionManager.getEntries()`，用 SDK 导出的 `getLatestCompactionEntry(entries)` 和幂等标记判断 SDK 是否已落 compaction；已落则只 rebuild context，不再 append。
     - 调用 `sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true)`。
     - 返回 rebuilt `messages`、`firstKeptEntryId`、`tokensBefore`、`reason`。
   - Why: timeout 后必须落状态，避免同一 3 MB transcript 每轮重复进入 compaction。
   - Dependencies: Phase 0.
   - Risk: High.

2. **定义本地 summary 格式** (File: `src/agents/pi-embedded-runner/emergency-compaction.ts`)
   - Action: summary 包含：
     - 触发原因：timeout、summary_budget_exhausted、context_overflow_after_compaction、compaction_error。
     - 原始 message 数、估算 tokens、toolResult chars、最大 tool contributors。
     - 最近文件操作、tool failure 摘要、保留尾部说明。
     - 明确声明旧 web_fetch、exec 大输出已丢弃。
   - Why: 不调模型时仍保留足够的恢复线索。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **preflight timeout 后落 emergency entry** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 在 `runPreflightCompactionToSettled()` timeout/error 分支中，`abortCompaction()` 后调用 `appendEmergencyCompaction()`；成功后 `activeSession.agent.replaceMessages(rebuiltMessages)` 并继续重新估算或直接 prompt。调用时传入 `runId`、`preLeafId`、`preCompactionCount`、`contextWindowSource`。
   - Why: 这是第一优先级止血点。
   - Dependencies: Step 1.
   - Risk: High.

4. **explicit overflow compaction 失败后落 emergency entry** (File: `src/agents/pi-embedded-runner/compact.ts`)
   - Action: 将 `compactWithSafetyTimeout(() => session.compact(...))` 改为保存 `compactPromise`，timeout/error 后先 abort，再 bounded settle wait，随后调用同一 emergency helper，返回 `compacted: true` 和 reason `emergency_compaction`。
   - Why: overflow recovery 路径也不能在 timeout 后空转。
   - Dependencies: Step 1.
   - Risk: High.

### Phase 2: 摘要调用预算

1. **新增 summary budget 类型** (File: `src/agents/compaction.ts`)
   - Action: 新增 `SummaryCallBudget`：
     - `maxCalls: number`
     - `usedCalls: number`
     - `tryConsume(label): boolean`
   - Why: 预算要跨 dropped summary、history summary、turn prefix summary 共享。
   - Dependencies: None.
   - Risk: Medium.

2. **限制 generateSummary 总调用次数** (File: `src/agents/compaction.ts`)
   - Action: 在 `summarizeChunks()` 调用 `generateSummary()` 前消耗预算；预算耗尽时抛出可识别错误或返回 fallback marker。
   - Why: 当前 300 秒死等来自多个 chunk 串行模型摘要。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **compaction-safeguard 传递共享预算** (File: `src/agents/pi-extensions/compaction-safeguard.ts`)
   - Action: `session_before_compact` 内创建 `createSummaryCallBudget(2)`，传给所有 `summarizeInStages()`。
   - Why: 确保一次 compaction 生命周期最多 2 次模型摘要。
   - Dependencies: Step 1.
   - Risk: Medium.

4. **预算耗尽走 fallback summary** (File: `src/agents/pi-extensions/compaction-safeguard.ts`)
   - Action: 捕获 summary budget exhausted 后返回 fallback summary，而不是继续分块摘要。
   - Why: 与 emergency compaction 形成双保险。
   - Dependencies: Step 2.
   - Risk: Medium.

### Phase 3: 源头 toolResult 裁剪

1. **收紧单条 toolResult 上限** (File: `src/agents/pi-embedded-runner/tool-result-truncation.ts`)
   - Action: 按 **D5** 口径 `min(固定上限, 窗口占比)` 实现,不再用固定 400000 一刀切。通用 `min(40K chars, contextWindow*0.04*4)`;web_fetch/exec/unknown 压一档 `min(20K, contextWindow*0.03*4)`;绝对硬顶 40K chars;image block 不参与文本 cap。保留配置扩展点。
   - Why: Codex 原则是单项不能无界;固定值在小窗口撑爆、大窗口偏保守,故取二者较小。
   - Dependencies: Phase 0 (需可靠 contextWindow).
   - Risk: Medium.

2. **head/tail 截断和 metadata 保留** (File: `src/agents/pi-embedded-runner/tool-result-truncation.ts`)
   - Action: `truncateToolResultMessage()` 改为保留 head 和 tail，输出截断说明，details 中保留 `originalChars`、`keptHeadChars`、`keptTailChars`、`truncatedAt`、`toolName`。
   - Why: 大输出常见于 web_fetch 和 exec，尾部通常包含错误、统计或命令结果。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **persistence guard 使用新 policy** (File: `src/agents/session-tool-result-guard.ts`)
   - Action: `capToolResultSize()` 改用新 policy，不再只按固定字符 cap。
   - Why: 工具输出写入 JSONL 前先有硬上限。
   - Dependencies: Step 2.
   - Risk: Medium.

4. **按工具类型保守裁剪** (File: `src/agents/pi-embedded-subscribe.tools.ts`)
   - Action: 为 `web_fetch`、`web_search`、`exec`、文件读取类工具输出增加默认较低上限；媒体 toolResult 保留现有安全判断。
   - Why: 最大来源已经定位为 web_fetch 和 exec。
   - Dependencies: Step 2.
   - Risk: Medium.

### Phase 4: Preflight 确定性裁剪

1. **新增 preflight pruning 模块** (File: `src/agents/pi-embedded-runner/preflight-pruning.ts`)
   - Action: 实现 `pruneMessagesBeforePreflight(params)`，输入 messages、contextWindowTokens、reserveTokens、tool budgets，输出裁剪后 messages 和 metrics。
   - Why: preflight estimate 必须看裁剪后的上下文。
   - Dependencies: Phase 3.
   - Risk: Medium.

2. **裁剪策略独立于 TTL 和 provider** (File: `src/agents/pi-embedded-runner/preflight-pruning.ts`)
   - Action: 策略固定执行：
     - 保护最近 N 个 assistant turn。
     - 先 soft trim 旧 toolResult。
     - 再 hard clear 旧 web_fetch、exec 大输出。
     - 目标历史预算为 `contextWindowTokens * 0.6`。
   - Why: 这是上下文安全逻辑，不应依赖 Anthropic cache TTL。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **接入 preflight 估算前** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 在 `estimatePromptPreflightTokens()` 前运行 pruning，并 `activeSession.agent.replaceMessages(prunedMessages)`。
   - Why: 避免 45 万 tokens 直接触发模型摘要式 compaction。
   - Dependencies: Step 1.
   - Risk: High.

4. **记录 pruning metrics** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 增加 `[context-preflight-prune]` log，记录 messagesBefore、messagesAfter、toolResultCharsBefore、toolResultCharsAfter、truncatedCount、clearedCount。
   - Why: 后续定位 Feishu 长会话是否被有效裁剪。
   - Dependencies: Step 3.
   - Risk: Low.

### Phase 5: Compaction 输入预算

1. **增加 compaction input budget** (File: `src/agents/compaction.ts`)
   - Action: 新增 `pruneMessagesForSummarizationBudget()`，在进入 `summarizeInStages()` 前把 messages 限制到 `contextWindow * 0.5`。
   - Why: 禁止把 45 万 tokens 级别输入交给摘要模型。
   - Dependencies: Phase 2.
   - Risk: Medium.

2. **限制 chunk 数** (File: `src/agents/compaction.ts`)
   - Action: `summarizeInStages()` 增加 `maxChunks`，默认 2，超过预算部分生成 deterministic dropped note。
   - Why: 分块数无上限会直接拉长 compaction 时间。
   - Dependencies: Step 1.
   - Risk: Medium.

3. **compaction-safeguard 使用输入预算** (File: `src/agents/pi-extensions/compaction-safeguard.ts`)
   - Action: 在 dropped summary、history summary、turn prefix summary 前都先调用预算裁剪。
   - Why: 所有摘要入口都要遵守同一个上限。
   - Dependencies: Step 1.
   - Risk: Medium.

### Phase 6: ContextPruning 解耦和默认值

1. **拆分 eligibility** (File: `src/agents/pi-embedded-runner/cache-ttl.ts`)
   - Action: 保留 `isCacheTtlEligibleProvider()` 给 Anthropic cache 相关逻辑；新增 `shouldTrackContextPruningTtl()` 或直接以 `contextPruning.mode` 为准。
   - Why: provider cache 能力和本地上下文裁剪是两件事。
   - Dependencies: Phase 1 to Phase 5.
   - Risk: Low.

2. **注册 pruning 不看 Anthropic allowlist** (File: `src/agents/pi-embedded-runner/extensions.ts`)
   - Action: `buildContextPruningFactory()` 去掉 `isCacheTtlEligibleProvider()` 判断。
   - Why: OTR、DeepSeek、MicU、SSS、DuckCoding 等模型在显式开启 `contextPruning` 后都应注册。
   - Dependencies: Step 1.
   - Risk: Low.

3. **TTL timestamp 跟随 pruning 配置写入** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: `shouldTrackCacheTtl` 改名为 `shouldTrackContextPruningTtl`，条件只看 `contextPruning.mode === "cache-ttl"`。
   - Why: 下一轮 pruning 需要 last touch 依据。
   - Dependencies: Step 1.
   - Risk: Low.

4. **调小默认 TTL** (File: `src/config/defaults.ts`)
   - Action: **只改自动启用场景**的默认 `ttl` 从 1h 到 5m/10m;用户显式配置的 `ttl` 一律优先,不覆盖。
   - Why: 1h 对长 Feishu 会话止血太慢;但不覆盖显式配置,避免破坏用户为 Anthropic prompt cache 命中特意设的 TTL。
   - Dependencies: Step 2.
   - Risk: Medium.

5. **同步文档语义** (File: `docs/concepts/session-pruning.md`, `docs/reference/session-management-compaction.md`)
   - Action: 实现完成后更新文档，说明 pruning 不再仅限 Anthropic，并补充 emergency compaction。
   - Why: 当前文档写着只对 Anthropic API 生效，实现变化后必须同步。
   - Dependencies: Step 2 to Step 4.
   - Risk: Low.

## Testing Strategy

- Unit tests:
  - `src/agents/pi-embedded-runner/emergency-compaction.test.ts`
    - timeout 后 append compaction entry。
    - 不调用模型。
    - 保留最近尾部并丢弃旧 toolResult。
    - `resolveFirstKeptEntryId()` 能跳过 `model_change`、`thinking_level_change`、`custom`、`label` 等非上下文 entry，把 kept message 边界映射到正确 `SessionEntry.id`。
    - emergency 裁剪后会显式 drop orphan toolResult；OpenAI 兼容 provider 不插 synthetic toolResult。
    - 使用 `getLatestCompactionEntry()` 和幂等标记检测到 SDK 已落 compaction 时不会重复 append。
  - `src/agents/pi-embedded-runner/run/attempt.test.ts`
    - preflight timeout 调用 emergency compaction。
    - preflight 估算前会先运行 deterministic pruning。
    - workspace/custom provider 在 `contextWindowSource === "default"` 时输出 warning；provider fallback 不再默认阻断。
  - `src/agents/compaction.test.ts`
    - summary budget 跨多个 `summarizeInStages()` 调用共享。
    - chunk 数超过上限时走 dropped note。
  - `src/agents/pi-extensions/compaction-safeguard.test.ts`
    - dropped summary、history summary、turn prefix 共享最多 2 次摘要调用。
    - 预算耗尽返回 fallback summary。
  - `src/agents/session-tool-result-guard.test.ts`
    - persistence 前 head/tail 截断。
    - metadata 保留。
  - `src/agents/pi-embedded-runner/tool-result-context-guard.test.ts`
    - prompt 前 guard 仍保留现有兜底行为。
  - `src/agents/pi-embedded-runner/extensions.test.ts`
    - OTR、DeepSeek、MicU 等 provider 在 `contextPruning.mode = "cache-ttl"` 时注册 pruning。
  - `src/agents/pi-embedded-runner/cache-ttl.test.ts`
    - Anthropic cache eligibility 保持不变。
    - context pruning TTL tracking 不再被 provider allowlist 限制。

- Integration tests:
  - 使用临时 session JSONL 构造 3 MB transcript，其中 toolResult 占比超过 80%，验证第一次 run timeout 后会落 emergency compaction entry，第二次 run 不再重复处理原 transcript。
  - 构造 `web_fetch` 和 `exec` 大输出，验证写入 transcript 后已经被截断。
  - 构造 OTR primary、DeepSeek fallback 配置，验证 contextWindow 来源和 pruning 注册。

- Commands:
  - 优先运行聚焦 Vitest：
    - `./node_modules/.bin/vitest run --config vitest.config.ts src/agents/pi-embedded-runner/*.test.ts src/agents/pi-embedded-runner/run/*.test.ts src/agents/pi-extensions/compaction-safeguard.test.ts src/agents/compaction.test.ts src/agents/session-tool-result-guard.test.ts`
  - 不主动运行 `pnpm test` 或 `pnpm test:fast`，除非用户确认。

## Risks & Mitigations

- **Risk**: emergency compaction entry 的 `firstKeptEntryId` 选择错误，导致丢失当前用户回合或工具调用配对断裂。
  - Mitigation: 先基于 `sessionManager.getBranch()` 实现并单测 `resolveFirstKeptEntryId(branchEntries, keptMessageBoundary)`；对齐逻辑必须跳过非上下文 entry，并覆盖 compaction/model_change/custom entry 混入场景。

- **Risk**: timeout 后同时存在 SDK 内部 compaction 状态,可能产生**双 compaction entry**(而非文件级并发写 —— preflight 已在 `attempt.ts:307` await settle,写入侧有 `acquireSessionWriteLock`)。见 **D6**。
  - Mitigation: emergency 写前重读 entries，用 SDK 导出的 `getLatestCompactionEntry(entries)` 读取 latest compaction，并比较 `runId`/`emergencyId`/`preLeafId`/`preCompactionCount`；若 SDK 已落 entry，则只 `replaceMessages` 不再 append。补齐 explicit overflow 路径的 abort + bounded settle wait。

- **Risk**: toolResult 源头裁剪影响需要完整输出的任务。
  - Mitigation: 保留 head/tail、原始大小和继续读取提示；需要完整数据时引导用户用 offset/limit 或文件路径查看。

- **Risk**: 过早 preflight pruning 导致最近任务上下文丢失。
  - Mitigation: 保护最近 N 个 assistant turns，并优先裁旧 toolResult，不动 user 和 assistant 正文。

- **Risk**: 摘要预算过低导致 compaction summary 质量下降。
  - Mitigation: 这是止血优先级下的明确取舍；summary budget 耗尽时至少落 deterministic fallback，保证会话继续。

- **Risk**: 默认 TTL 从 1h 调小影响 Anthropic prompt cache 命中。
  - Mitigation: 只改自动默认，保留显式配置优先；必要时对 Anthropic cacheRetention 场景保留独立默认。

- **Risk**: contextWindow 配置过大或过小导致裁剪阈值失真。
  - Mitigation: Phase 0 先记录 source；当 workspace/custom provider 落到 `DEFAULT_CONTEXT_TOKENS` 兜底时输出 warning，要求显式配置全局 `defaultContextWindow`、逐模型 `contextWindow` 和 `maxTokens` 以获得准确预算。

## Success Criteria

- [ ] 3 MB transcript 在 compaction timeout 后会写入 emergency compaction entry。
- [ ] 同一会话下一轮不会再次把原 45 万 token 历史送入模型摘要式 compaction。
- [ ] 一次 compaction 生命周期内 `generateSummary()` 最多调用 2 次。
- [ ] `web_fetch` 和 `exec` 大输出在写入 JSONL 前已被截断，并保留 metadata。
- [ ] preflight token estimate 使用裁剪后的 `activeSession.messages`。
- [ ] `summarizeInStages()` 不再接收超过 compaction 输入预算的消息集合。
- [ ] `firstKeptEntryId` 从 branch entry 序列解析，非 message entry 不会打乱保留边界。
- [ ] emergency 写入前会检测 latest compaction entry，timeout 竞态下不会重复 append。
- [ ] OTR、DeepSeek、MicU、SSS、DuckCoding 等显式开启 `contextPruning` 的 provider 会注册 pruning。
- [ ] Anthropic cache TTL 相关行为仍由 `isCacheTtlEligibleProvider()` 保护。
- [ ] contextWindow 来源在日志中可诊断，workspace/custom provider 使用 200k 默认窗口计算预算时会告警。
- [ ] 聚焦单元测试通过。

## Rollout Order

1. 先实现 Phase 0 和 Phase 1，解决每轮卡死重来的生产风险。
2. 再实现 Phase 2，压住 compaction 模型调用次数。
3. 再实现 Phase 3 和 Phase 4，把膨胀从源头和 preflight 前处理掉。
4. 再实现 Phase 5，保证 compaction 输入规模可控。
5. 最后实现 Phase 6，修正 pruning 门禁和默认 TTL，并同步用户文档。

## Interview Decisions (Locked)

以下决策来自需求澄清,优先级高于正文中的初稿描述。实现时以本节为准。

### D1. Emergency compaction 保留边界(口径:turn 为主 + token 封顶)

- 先按语义边界选最近 N 个完整 user turn,默认 `N=1`,最多尝试扩到 `N=2`。
- 计算该 slice 的 tokens,与 `tailBudget = min(keepRecentTokens, contextWindow * 0.3, 60000)` 比较:
  - 不超预算:保留该 slice。
  - 超预算:不向前扩,只保留最近 1 个 user turn。
  - 最近 1 个 user turn 仍超预算:在该 turn 内只裁 toolResult —— 先 hard clear 旧 toolResult;保留当前 user 消息、assistant 文本与 toolCall 骨架;最后一个必要 toolResult 保留 head/tail 截断版。
- 裁完后先显式运行 orphan cleanup：`dropOrphanedToolResults()` 对所有 provider 执行；`repairToolUseResultPairing()` 只在 provider policy 允许 synthetic toolResult 时执行，OpenAI 兼容 provider 不依赖该 repair flag。
- 仍超预算继续清 toolResult,**不切 user 消息**。
- `firstKeptEntryId` 不能由 message index 直接换算。必须基于 `sessionManager.getBranch()` 建立上下文 message 到 branch entry 的映射，先实现并单测 `resolveFirstKeptEntryId(branchEntries, keptMessageBoundary)`。
- 原则:不能从 turn 中间按 token 直接切,除非是在同一 turn 内裁 toolResult 内容。目标是既保住当前任务语义,又避免 emergency 后马上再次超窗口。

### D2. Preflight 裁剪 vs prompt cache(仅超阈值才裁)

- 只有历史估算超过阈值(历史 > `contextWindow * 0.6`)时才裁剪并 `replaceMessages`。
- 未超阈值时**完全不动消息**,保住 Anthropic prompt cache 前缀命中。

### D3. 被丢弃大输出保留可恢复线索(保留来源 + 提示可重读)

- 每条丢弃的 web_fetch/exec 大输出,在 emergency summary 中保留字段:`toolName`、`url` 或 `path`、`command` 前 200 字符、`exitCode`/`status`、`originalChars`/`keptChars`、`timestamp`、`hint`(可用 offset/limit、路径、URL 或重新执行命令获取原文)。
- 放在 emergency summary 的 `Dropped Large Tool Outputs` 小节;每条限 300–500 chars,最多 10 条,超出写 `... and N more`。

### D4. Summary budget 耗尽的裁决优先级(fallback summary 即终态)

分层职责,避免双 compaction entry:

1. 正常模型 summary。
2. **summary budget exhausted**(compaction-safeguard 内部可控退化)→ 返回 deterministic fallback summary,由 Pi SDK 正常 append compaction entry。**这是终态,不升级到 emergency。**
3. **timeout / error / append 失败 / SDK compaction 未落 entry** → 走 emergency compaction。
4. **preflight compaction timeout** → 直接 emergency(已证明 SDK compaction 未正常落状态)。

### D5. 单条 toolResult 上限口径(`min(固定上限, 窗口占比)`)

- 通用 toolResult:`min(40K chars, contextWindowTokens * 0.04 * 4 chars)`
- `web_fetch` / `exec` / `unknown`:再压一档 `min(20K chars, contextWindowTokens * 0.03 * 4 chars)`
- `read` / 文件读取:`min(40K chars, contextWindowTokens * 0.04 * 4 chars)`
- 全局绝对硬顶:`40K chars`
- image block 不参与文本 cap,只裁 text blocks。
- 先用字符估算落地,后续若有 tokenizer 可替换为 token policy。

### D6. 并发安全:核心是防双 entry,覆盖两条路径(选"两者都做")

- **真正风险是重复 entry,不是文件级并发写**(preflight 已在 `attempt.ts:307` `await compactPromise.catch()` 等 settle,写入侧有 `acquireSessionWriteLock`)。
- **preflight 路径**:emergency 写前重读 branch/latest entry;若 abort/settle 前 SDK 已成功 `appendCompaction`,则只做 `replaceMessages`/状态同步,**不再 append**。
- **explicit overflow 路径**(`compact.ts:716`):当前直接 `compactWithSafetyTimeout(() => session.compact(...))`,未保留 `compactPromise`、未在 timeout 后 abort+await settle。需补成与 preflight 一致的 abort + bounded settle wait。
- latest compaction 检测使用 SDK 包根导出的 `getLatestCompactionEntry(sessionManager.getEntries())`；判断依据是 details 中的 `runId` / `emergencyId` / `preLeafId` / `preCompactionCount`。
- 两边 emergency append 都加幂等标记:`runId` / `emergencyId` / `preLeafId` / `preCompactionCount`。

### D7. toolResult 裁剪收口层(persistence guard 做最终硬底 + 工具内保留软上限)

- **第一阶段(止血硬底)**:在 `session-tool-result-guard.ts` 建立统一 `ToolResultPersistencePolicy`,按 `toolName` 分档(web_fetch/exec 低,read 中,默认高)。注意当前 cap 在 `tool_result_persist` / `before_message_write` hook **之前**,不是最终硬底 —— 需挪到 `originalAppend()` 前,或最后再 cap 一次。
- **第二阶段**:把工具内部已有软上限(web_fetch `DEFAULT_FETCH_MAX_CHARS=50_000`、bash `maxOutputChars`、read `maxBytes`/offset continuation)对齐到 policy,防止源头先膨胀。**这些源头限制不删**(防内存和中间事件膨胀)。
- 测试重点:`session-tool-result-guard.test.ts` —— 按 toolName 分档、未知工具走默认档、hook 之后仍被最终 cap。

### D8. 分档阈值依据(先分析坏样本 + 低频校准 log)

- 直接解析当前失败的 3MB / 45 万 token session JSONL:assistant toolCall(id/name)→ 关联 toolResult(id)→ 按 toolName 统计 chars 分布(占比、P95/P99、最大值)→ 用坏样本定第一版阈值。
- 初始阈值用 D5 的 `min(固定上限, 窗口占比)`。
- 上线后加低频控 log,**只记 metadata**(`toolName`、`chars`、`capChars`、`truncated`、`provider`/`model`、`contextWindow`、`sessionKeyHash`),仅在 `chars > cap * 0.8` 或发生 truncate 时记录。

### D9. 合入与验收节奏

- **合入**:全部 Phase 完成后一次性合入(不分批 PR)。
- **验收**:unit 覆盖行为(不调模型 / 落 entry / 保留尾部 / 分档 cap / 防双 entry)+ 用真实坏样本构造集成测试(第一次 run timeout 后必落 emergency entry,第二次 run 不再重处理原 transcript),通过即上,不等影子环境。

### D10. contextWindow 兜底硬保护

- `contextWindowSource === "default"` 会被记录到日志；workspace/custom provider 推荐显式提供 `models.defaultContextWindow`、`models.providers.*.models[].contextWindow` 或可从 registry 解析到 model context window。
- 当 workspace/custom provider 落到 `DEFAULT_CONTEXT_TOKENS = 200000` 时，Phase 0 保持兼容继续运行，但在 warning 中给出 provider、modelId、配置路径。
- 该保护必须先于 D1 tailBudget、D5 toolResult cap、Phase 4 preflight pruning、Phase 5 compaction input budget 执行。

## References

- Codex context principle: `/Users/jiaoguo/github/codex/AGENTS.md`
- Codex tool output truncation: `/Users/jiaoguo/github/codex/codex-rs/core/src/context_manager/history.rs`
- Codex token-budget compaction: `/Users/jiaoguo/github/codex/codex-rs/core/src/compact_token_budget.rs`
- OpenClaw compaction deep dive: `/reference/session-management-compaction`
- OpenClaw session pruning docs: `/concepts/session-pruning`
