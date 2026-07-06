# OpenClaw 压缩机制技术回溯

作者：OpenClaw 运行时排障笔记
日期：2026-07-05
范围：嵌入式 Pi Agent、OpenClaw run loop、context overflow recovery

## 1. 结论先放在前面

这次问题不是 `shouldCompact()` 的公式错。

SDK 的公式很简单：

```ts
contextTokens > contextWindow - reserveTokens;
```

这个公式在“模型调用结束后，根据本轮 usage 判断要不要压缩”这个场景里是合理的。

真正的问题在两个地方。

第一，SDK 判断的是上一条或当前 assistant message 的 `usage`。它不是下一次请求的完整输入。下一次请求还会加上当前 prompt、system prompt、工具 schema、图片和 provider 包装开销。

第二，OpenClaw 新增了 preflight compaction，但它复用了 `compactionCount`。外层 run loop 又把 `compactionCount > 0` 当成“SDK 已经在本次 prompt attempt 里处理过 overflow”。这会污染 overflow recovery 的判断。

一句话：

```text
SDK 的判断是事后维护。
OpenClaw 需要的是事前拦截。
preflight compact 不能伪装成 SDK post-prompt auto-compaction。
```

## 2. 先把三个“压缩”分清楚

OpenClaw 里不是只有一种压缩。

```text
+-------------------------------+----------------+-------------------------------+
| 机制                          | 决策方         | 通俗理解                      |
+-------------------------------+----------------+-------------------------------+
| SDK auto-compaction            | SDK            | SDK 自己发现快满了，自动整理  |
| OpenClaw preflight compaction  | OpenClaw       | 发请求前先估算，太大就先整理  |
| explicit overflow compaction   | OpenClaw       | 请求失败后，OpenClaw 手动救   |
| tool result truncation         | OpenClaw       | 单个工具结果太大，直接剪短    |
+-------------------------------+----------------+-------------------------------+
```

它们都在处理上下文窗口问题，但时机完全不同。

```text
user message
  |
  v
OpenClaw preflight estimate
  |
  |-- too large --> activeSession.compact()
  |
  v
activeSession.prompt()
  |
  v
SDK AgentSession.prompt()
  |
  |-- before prompt: check previous assistant
  |
  v
provider call
  |
  |-- agent_end: SDK check current assistant
  |
  v
OpenClaw inspects attempt result
  |
  |-- context overflow --> explicit overflow compaction
  |
  |-- still not enough --> tool result truncation
```

这条链路里，只有 SDK auto-compaction 是 SDK 自己决定的。explicit overflow compaction 的实际压缩动作会调用 SDK `session.compact()`，但“什么时候调用”是 OpenClaw 决定的。

## 3. SDK 到底什么时候判断压缩

SDK 判断压缩的核心入口是 `_checkCompaction(assistantMessage)`。

它有两个触发模式。

### 3.1 overflow 模式

模型返回 context overflow 错误。

```text
assistant.stopReason = error
errorMessage looks like context overflow
  |
  v
_runAutoCompaction("overflow", true)
  |
  v
compact
  |
  v
SDK schedules continue()
```

这里的 `willRetry=true`。SDK 会在压缩后继续 retry。

### 3.2 threshold 模式

模型调用成功，但 usage 显示上下文快满了。

```text
assistant.usage
  |
  v
calculateContextTokens(usage)
  |
  v
contextTokens > contextWindow - reserveTokens
  |
  v
_runAutoCompaction("threshold", false)
```

这里的 `willRetry=false`。因为请求已经成功，SDK 只是为下一轮提前整理上下文。

关键点在这里：

```text
assistant.usage 不是整个 session 的累计 usage。
它是最近一次模型调用返回的 usage。
```

SDK 计算的是：

```ts
contextTokens =
  usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
```

这不是“下一次请求会发给 provider 的完整 inputTokens”。

## 4. 为什么这次会超过上下文

这次 session 里看到：

```text
inputTokens = 265676
contextWindow = 262144
```

已经超过模型窗口。

但 SDK 没有提前拦住。原因是 SDK 的 threshold 判断不是 preflight。

SDK 看到的是上一条 assistant usage。下一次真正发请求时，还会叠加：

```text
history messages
+ current user prompt
+ system prompt
+ built-in tools
+ custom tools
+ client tools
+ images
+ provider framing overhead
= actual provider input
```

所以，SDK 可能判断“上一轮还没到阈值”，但下一次 provider payload 已经超限。

这不是 `>` 写错了。

这是判断对象错了。

## 5. OpenClaw preflight 补的是什么

OpenClaw preflight 做的是一件事：

```text
在 activeSession.prompt() 之前，
估算下一次请求的完整输入。
```

它估算：

```text
activeSession.messages
+ effectivePrompt
+ systemPromptText
+ model-facing tool definitions
+ prompt images
```

如果超过：

```text
contextWindow - reserveTokens
```

就先执行：

```ts
activeSession.compact("Preflight compaction before sending an oversized prompt.");
```

这一步调用的还是 SDK 的 manual compact。区别是，决策在 OpenClaw。

这相当于出门前先看行李箱会不会炸，而不是等机场安检报错。

## 6. 真正压缩在哪里实现

压缩主体在 SDK。

SDK pipeline 是：

```text
prepareCompaction(pathEntries, settings)
  |
  v
compact(preparation, model, apiKey, ...)
  |
  v
generateSummary()
  |
  v
completeSimple(...)
  |
  v
sessionManager.appendCompaction(...)
  |
  v
sessionManager.buildSessionContext()
  |
  v
agent.replaceMessages(...)
```

它不是本地裁剪字符串。

它会再次调用模型生成 summary，然后写入一条 `type: "compaction"` 的 session entry。后续上下文会变成：

```text
compaction summary
+ firstKeptEntryId 之后的最近消息
```

OpenClaw 做的，是决定在哪些场景主动调用这套能力。

## 6.1 两类 compaction 的 prompt

先区分“谁决定压缩”和“谁生成 summary”。

SDK auto-compaction 和 OpenClaw explicit overflow compaction 的 summary 生成都走 SDK `compact()`。

所以它们底层使用同一套 compaction prompt。

```text
+-------------------------------+-------------------------------+
| 类型                          | prompt 差异                   |
+-------------------------------+-------------------------------+
| SDK auto-compaction            | SDK 默认总结 prompt           |
| explicit overflow compaction   | 当前 overflow 路径没有传      |
|                               | customInstructions，所以也用  |
|                               | SDK 默认总结 prompt           |
| OpenClaw preflight compaction  | 调用同一个 SDK compact，但会  |
|                               | 传入额外 Additional focus     |
+-------------------------------+-------------------------------+
```

调用链是：

```text
SDK auto-compaction
  |
  v
_runAutoCompaction(...)
  |
  v
compact(preparation, model, apiKey, undefined, ...)
```

```text
explicit overflow compaction
  |
  v
compactEmbeddedPiSessionDirect(...)
  |
  v
session.compact(params.customInstructions)
  |
  v
当前 overflow 调用方没有传 customInstructions
```

```text
OpenClaw preflight compaction
  |
  v
activeSession.compact(
  "Preflight compaction before sending an oversized prompt."
)
  |
  v
SDK generateSummary() 会把它拼到：
Additional focus: ...
```

系统 prompt 固定为：

```text
You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

首次 compaction 的 user prompt 结构是：

```text
<conversation>
[序列化后的历史消息]
</conversation>

The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

已经存在 previous summary 时，user prompt 会变成增量更新：

```text
<conversation>
[新历史消息]
</conversation>

<previous-summary>
[上一轮 compaction summary]
</previous-summary>

The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it
```

如果压缩点落在一个超长 turn 的中间，SDK 还会额外生成 turn prefix summary：

```text
<conversation>
[被切开的同一轮早期消息]
</conversation>

This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.
```

结论是：

```text
SDK auto-compaction 和 explicit overflow compaction 的 prompt 当前相同。
二者差别在触发时机和外层 retry / recovery 行为。
preflight compaction 使用同一套 SDK prompt，但多了一句 Additional focus。
```

## 7. explicit overflow compaction 是什么

这是 OpenClaw 外层 run loop 的补救。

如果 `activeSession.prompt()` 返回后，OpenClaw 看到 context overflow 错误，会进入 recovery。

判断来源有两个：

```text
promptError
  prompt 调用直接抛错，比如 provider 拒绝 input too large

assistantError
  SDK 得到 stopReason=error，errorMessage 是 context overflow
```

判断函数会匹配这类文案：

```text
request_too_large
context length exceeded
maximum context length
prompt is too long
exceeds model context window
413 too large
context overflow
```

然后 OpenClaw 走：

```text
contextOverflowError
  |
  v
hadAttemptLevelCompaction?
  |
  |-- yes --> retry without additional compaction
  |
  |-- no  --> compactEmbeddedPiSessionDirect({ trigger: "overflow" })
               |
               |-- compacted --> retry prompt
```

这个逻辑的原意是合理的。

如果 SDK 在本 attempt 里已经因为 overflow 自动压缩过，OpenClaw 不应该马上再压一次。否则可能造成重复压缩。

问题出在 `hadAttemptLevelCompaction` 怎么判断。

## 8. tool result truncation 是什么

有一种 overflow，压缩历史也救不了。

比如最近上下文里有一条工具结果特别大：

```text
read 一个巨大文件
search 返回几十万字
网页抓取返回超长内容
```

压缩会保留最近消息。如果这个超大 `toolResult` 正好在最近消息里，summary 再好也没用。

这时 OpenClaw 会尝试截短工具结果。

规则大致是：

```text
toolResult text length >
  min(contextWindow * 0.3 * 4 chars, 400000 chars)
```

执行方式：

```text
找到第一条 oversized toolResult
  |
  v
从它的 parent 重新 branch
  |
  v
重新追加后续 entries
  |
  v
把 oversized toolResult 换成截短版
  |
  v
retry prompt
```

这是最后一道兜底。它不是 SDK 能力。

## 9. 第二层和第三层怎么配合

它们不是同时执行。

```text
context overflow
  |
  v
explicit overflow compaction
  |
  |-- compacted --> retry prompt
  |
  |-- not compacted / not enough
        |
        v
      tool result truncation
        |
        |-- truncated --> retry prompt
        |
        |-- not truncated --> return context overflow error
```

注意一个细节。

explicit overflow compaction 成功，只代表“压缩动作成功”。不代表下一次 prompt 一定成功。

如果 retry 以后仍然 overflow，OpenClaw 会进入下一轮 recovery，再看该走哪条分支。

## 10. 这次 review 指出的风险

风险在 `compactionCount`。

现在它有两个用途。

```text
+----------------------+----------------------------------+
| 用途                 | 说明                             |
+----------------------+----------------------------------+
| 展示统计             | agentMeta.compactionCount         |
| hook 参数            | after_compaction.compactedCount   |
| 控制流判断           | attempt.compactionCount > 0       |
+----------------------+----------------------------------+
```

第三个用途最危险。

外层 run loop 现在会把：

```ts
attempt.compactionCount > 0;
```

理解为：

```text
SDK 已经在本次 prompt attempt 里做过 auto-compaction。
```

但 preflight compaction 加进来后，这个推断不再可靠。

错误链路是：

```text
OpenClaw preflight compaction
  |
  v
compactionCount++
  |
  v
activeSession.prompt()
  |
  v
provider still returns context overflow
  |
  v
run.ts sees compactionCount > 0
  |
  v
thinks SDK already handled overflow
  |
  v
skips explicit overflow compaction
  |
  v
may skip tool result truncation
  |
  v
retries same oversized request until retry cap
```

这就是 review 说的“仍然 overflow 时，外层可能跳过显式 overflow compaction / truncation”。

不是 preflight 不该压缩。

是 preflight 不能污染 SDK overflow recovery 的控制信号。

## 11. 正确的计数模型

应该把统计和控制流拆开。

```text
compactionCount
  总成功压缩次数
  用于展示、状态、hook 统计

preflightCompactionCount
  OpenClaw prompt 前主动压缩次数
  用于诊断

sdkAutoCompactionCount / postPromptCompactionCount
  SDK auto_compaction_* 事件次数
  用于判断 hadAttemptLevelCompaction
```

外层 overflow recovery 不应该继续用：

```ts
const hadAttemptLevelCompaction = attempt.compactionCount > 0;
```

应该改成类似：

```ts
const hadAttemptLevelCompaction = attempt.sdkAutoCompactionCount > 0;
```

这里的名字可以再定。

但原则不能变：

```text
总压缩次数用于展示。
SDK post-prompt auto-compaction 信号用于控制流。
preflight compaction 只说明发请求前整理过，不说明 overflow 已经被 SDK 救过。
```

## 12. 排查时看什么

遇到 context overflow，不要先盯着公式。

先看链路。

```text
1. 实际 provider inputTokens 是多少
2. effective contextWindow 是多少
3. preflight 是否估算了 prompt / system / tools / images
4. SDK 是否发出 auto_compaction_start / auto_compaction_end
5. OpenClaw 是否进入 explicit overflow compaction
6. 是否存在 oversized toolResult
7. compactionCount 是否被当成控制流信号
```

相关日志：

```text
[context-preflight]
[context-overflow-diag]
[compaction-diag]
[context-overflow-recovery]
[tool-result-truncation]
```

## 13. 代码地图

OpenClaw preflight：

```text
src/agents/pi-embedded-runner/run/attempt.ts
```

OpenClaw overflow recovery：

```text
src/agents/pi-embedded-runner/run.ts
src/agents/pi-embedded-runner/compact.ts
```

OpenClaw tool result truncation：

```text
src/agents/pi-embedded-runner/tool-result-truncation.ts
```

OpenClaw compaction events and counts：

```text
src/agents/pi-embedded-subscribe.ts
src/agents/pi-embedded-subscribe.handlers.compaction.ts
```

SDK compaction implementation：

```text
@mariozechner/pi-coding-agent/dist/core/agent-session.js
@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js
@mariozechner/pi-coding-agent/dist/core/session-manager.js
```

## 14. 最后一句

这套机制不是缺一层压缩。

它缺的是边界。

preflight 是出门前看箱子。SDK auto-compaction 是路上自己整理。overflow recovery 是失败后回来救。truncation 是发现东西太大，直接剪短。

把这四件事记到一个计数器里，代码就会把“整理过”误读成“救过”。
