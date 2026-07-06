# OpenClaw Compaction Mechanism

This note records how compaction works across OpenClaw and the embedded Pi SDK.
It is meant for debugging context overflow, preflight compaction, retry behavior,
and `compactionCount` regressions.

## Short Version

OpenClaw has multiple compaction layers:

```text
OpenClaw preflight compaction
  Runs before activeSession.prompt().
  Estimates the next full request and compacts early.

SDK auto-compaction
  Runs inside the Pi SDK after a model call, or before the next prompt by
  checking the previous assistant message.

OpenClaw explicit overflow compaction
  Runs after activeSession.prompt() returns a context overflow error and SDK
  auto-compaction did not already handle it.

OpenClaw tool result truncation
  Runs after overflow persists and the session likely contains a single
  oversized tool result that compaction cannot reduce enough.
```

The important boundary:

```text
preflight compaction != SDK post-prompt auto-compaction
```

They both compact session history, but they mean different things to the run
loop. Do not use one shared control-flow counter for both.

## Core Terms

- `contextWindow`: the model's maximum context size, resolved by OpenClaw from
  model configuration and passed into Pi session setup.
- `reserveTokens`: buffer kept free before triggering compaction.
- `assistant.usage`: provider-reported usage for one assistant message, usually
  the latest model call.
- `contextTokens`: SDK value derived from `assistant.usage`.
- `compaction`: summarize older session history into a persistent `compaction`
  entry and keep recent messages.
- `truncation`: shorten a single oversized `toolResult` message.

`assistant.usage` is not total session usage. It is the usage reported for one
model call.

SDK context pressure is computed like this:

```ts
contextTokens =
  usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
```

That is useful after a model call, but it is not the same as the next request's
full input payload.

## Why SDK Compaction Can Miss A Prompt Overflow

Pi SDK threshold compaction uses:

```ts
contextTokens > contextWindow - reserveTokens;
```

The formula is reasonable for post-turn maintenance. The problem is the token
source and timing.

The SDK checks a previous or current assistant message's `usage`. It does not
preflight the exact next provider payload before the request is launched.

The next request contains more than previous `assistant.usage`:

```text
session history
+ current user prompt
+ system prompt
+ tool schemas
+ images
+ provider framing overhead
= actual provider input
```

So a run can look safe by the SDK's previous `assistant.usage`, but still exceed
the provider context window when the next prompt is sent.

## Layer 1: OpenClaw Preflight Compaction

Location:

- `src/agents/pi-embedded-runner/run/attempt.ts`

Timing:

```text
before activeSession.prompt(effectivePrompt)
```

Purpose:

```text
Catch an oversized next prompt before starting the provider call.
```

Inputs estimated by OpenClaw:

```text
activeSession.messages
+ effectivePrompt
+ systemPromptText
+ model-facing tool definitions
+ prompt images
```

If the estimate crosses:

```text
contextWindow - reserveTokens
```

OpenClaw calls:

```ts
activeSession.compact("Preflight compaction before sending an oversized prompt.");
```

This uses the SDK's manual compaction implementation, but the decision to run it
is OpenClaw's decision.

Important behavior:

- Abort or timeout during preflight compaction must stop before `prompt()`.
- Preflight failure/no-op must not emit a false successful `after_compaction`.
- Preflight compaction should not be treated as SDK post-prompt auto-compaction
  for overflow recovery decisions.

## Layer 2: SDK Auto-Compaction

SDK package:

- `@mariozechner/pi-coding-agent`

Runtime implementation:

- `dist/core/agent-session.js`
- `dist/core/compaction/compaction.js`

OpenClaw observes SDK events through:

- `src/agents/pi-embedded-subscribe.handlers.compaction.ts`
- `src/agents/pi-embedded-subscribe.ts`

Timing:

```text
AgentSession.prompt()
  before sending new prompt:
    check last assistant message

Agent event handler
  on agent_end:
    check current assistant message
```

SDK check:

```text
_checkCompaction(assistantMessage)
```

SDK has two trigger modes.

Overflow mode:

```text
model returned context overflow error
  -> _runAutoCompaction("overflow", true)
  -> compact
  -> SDK schedules continue()
```

Threshold mode:

```text
successful assistant message has usage
  -> contextTokens > contextWindow - reserveTokens
  -> _runAutoCompaction("threshold", false)
  -> compact
  -> no automatic retry
```

SDK actual compaction pipeline:

```text
_runAutoCompaction()
  -> prepareCompaction(pathEntries, settings)
  -> compact(preparation, model, apiKey, ...)
     -> generateSummary()
        -> completeSimple(...)
  -> sessionManager.appendCompaction(...)
  -> sessionManager.buildSessionContext()
  -> agent.replaceMessages(...)
  -> emit auto_compaction_end
```

The summary is generated by a model call. It is not just local string trimming.

## Layer 3: OpenClaw Explicit Overflow Compaction

Location:

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/compact.ts`

Timing:

```text
after runEmbeddedAttempt()
  if promptError or assistant error looks like context overflow
```

Purpose:

```text
If SDK did not auto-compact for the overflow, OpenClaw performs an explicit
overflow recovery compaction and retries the prompt.
```

Flow:

```text
contextOverflowError
  -> hadAttemptLevelCompaction?
     yes:
       retry without additional OpenClaw compaction
     no:
       compactEmbeddedPiSessionDirect({ trigger: "overflow" })
       if compacted:
         retry prompt
```

The compaction action still calls SDK `session.compact()`. The decision to call
it is OpenClaw's outer run loop decision.

This branch exists because SDK auto-compaction is not the only possible recovery
path. Provider errors can surface outside the SDK auto-compaction path, or SDK
compaction may not have run for the exact failure being handled.

## Layer 4: Tool Result Truncation

Location:

- `src/agents/pi-embedded-runner/tool-result-truncation.ts`

Timing:

```text
after context overflow persists and normal compaction is unavailable or
insufficient
```

Purpose:

```text
Handle the case where one tool result is itself too large.
```

Compaction summarizes older history and keeps recent messages. If the oversized
data is in a recent `toolResult`, compaction may keep it, so the request remains
too large.

Truncation checks for oversized tool results:

```text
toolResult text length > min(contextWindow * 0.3 * 4 chars, 400000 chars)
```

Then it:

```text
branches the session before the first oversized tool result
re-appends later entries
replaces oversized toolResult text with a truncated version
adds a truncation notice
retries the prompt
```

This is OpenClaw logic. It is not SDK auto-compaction.

## How The Layers Cooperate

Main flow:

```text
user message
  -> OpenClaw preflight estimate
     -> compact early if next request looks oversized
  -> activeSession.prompt()
     -> SDK may compact previous assistant context before prompt
     -> provider call
     -> SDK may auto-compact on agent_end
  -> OpenClaw inspects attempt result
     -> if context overflow remains:
        -> explicit overflow compaction
        -> if needed, tool result truncation
```

Practical meaning:

```text
preflight compaction
  "Clean up before launching a request that looks too large."

SDK auto-compaction
  "The SDK saw a previous/current assistant usage or overflow signal and compacted."

explicit overflow compaction
  "The provider still overflowed; OpenClaw manually triggers compaction and retries."

tool result truncation
  "A single tool result is too large; shorten it instead of summarizing history."
```

## `compactionCount` Semantics

Current sources:

- `src/agents/pi-embedded-subscribe.ts`
- `src/agents/pi-embedded-subscribe.handlers.compaction.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run.ts`

Current meaning:

```text
Number of successful compaction end events observed in an attempt.
```

Current consumers:

```text
run.ts
  -> accumulates into agentMeta.compactionCount for reporting
  -> uses attempt.compactionCount > 0 as hadAttemptLevelCompaction
```

The second use is control-flow sensitive.

Historically, `attempt.compactionCount > 0` approximated:

```text
SDK auto-compaction already happened inside this prompt attempt.
```

After adding preflight compaction, that approximation can become false:

```text
preflight compaction happened
  -> compactionCount increments
  -> prompt still overflows
  -> run.ts may think SDK already handled the overflow
  -> run.ts may skip explicit overflow compaction
  -> run.ts may skip tool result truncation
  -> same oversized prompt can be retried until retry cap
```

Design rule:

```text
Do not use total successful compaction count as proof that SDK post-prompt
auto-compaction handled a context overflow.
```

Safer model:

```text
compactionCount
  total successful compactions for reporting and user-visible status

sdkAutoCompactionCount / postPromptCompactionCount
  SDK auto_compaction_* events that happened after provider interaction and are
  valid for hadAttemptLevelCompaction control flow

preflightCompactionCount
  OpenClaw pre-prompt compactions for diagnostics/reporting
```

The overflow recovery branch should gate on `sdkAutoCompactionCount` or an
equivalent post-prompt signal, not on total `compactionCount`.

## Failure Modes To Watch

Preflight timeout or abort:

```text
preflight compact starts
  -> timeout/user cancel
  -> must stop before activeSession.prompt()
```

False after_compaction:

```text
compact failed/no-op
  -> should not fire after_compaction hook
```

Tool schema undercount:

```text
preflight estimate omits model-facing tool definitions
  -> estimate can be below actual provider payload
```

Counter pollution:

```text
preflight compaction increments the same counter used for SDK overflow recovery
  -> OpenClaw can skip explicit recovery branches
```

## Debugging Checklist

When a session hits context overflow:

1. Check actual provider input usage/error message.
2. Check configured and effective `contextWindow`.
3. Check `reserveTokens` and `keepRecentTokens`.
4. Check whether preflight estimate included prompt, system, tools, and images.
5. Check whether SDK emitted `auto_compaction_start/end`.
6. Check whether OpenClaw ran explicit overflow compaction.
7. Check whether oversized `toolResult` messages exist.
8. Check whether `compactionCount` was used as a control-flow signal.

Useful log markers:

```text
[context-preflight]
[context-overflow-diag]
[compaction-diag]
[context-overflow-recovery]
[tool-result-truncation]
```

## Code Reference Map

OpenClaw preflight:

- `src/agents/pi-embedded-runner/run/attempt.ts`

OpenClaw attempt result and counters:

- `src/agents/pi-embedded-subscribe.ts`
- `src/agents/pi-embedded-subscribe.handlers.compaction.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

OpenClaw overflow recovery:

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/compact.ts`

OpenClaw tool result truncation:

- `src/agents/pi-embedded-runner/tool-result-truncation.ts`

OpenClaw compaction settings bridge:

- `src/agents/pi-settings.ts`
- `src/agents/pi-embedded-runner/extensions.ts`

SDK compaction implementation:

- `@mariozechner/pi-coding-agent/dist/core/agent-session.js`
- `@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js`
- `@mariozechner/pi-coding-agent/dist/core/session-manager.js`
