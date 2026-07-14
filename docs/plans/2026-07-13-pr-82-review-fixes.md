# Implementation Plan: PR 82 Review Fixes

## Overview

Resolve the verified lifecycle and state-integrity findings in PR 82 without expanding the feature
surface. Prefer small ordering, validation, and recoverability changes over new persistence systems.

## Requirements

- Preserve FIFO ordering between queued session mutations and full-store saves.
- Reject incomplete shared TaskFlow spawn arguments.
- Ensure tracked TaskFlows receive a parent turn when a child completes.
- Keep truncated completion results recoverable before delete-mode cleanup succeeds.
- Let shutdown state flushes use the existing write-lock time budget.

## Architecture Changes

- `src/config/sessions/store.ts`: serialize full saves with pending mutations for the same path.
- `src/agents/subagent-spawn.ts`: validate shared TaskFlow parameter combinations.
- `src/agents/subagent-registry.ts` and `src/agents/subagent-announce.ts`: route tracked completions
  through the requester agent turn.
- `src/agents/subagent-announce-queue.ts`: expose truncation and preserve a child-session reference.
- `src/gateway/server-close.ts`, `src/gateway/server.impl.ts`, and
  `src/cli/gateway-cli/run-loop.ts`: stop write producers, flush state before closing transports,
  and propagate flush failures to process shutdown.

## Implementation Steps

### Phase 1: State Ordering

1. Serialize full session-store saves through the mutation queue and add an ordering regression
   test.
2. Increase the shutdown flush budget so normal lock waits and Windows rename retries can finish.

### Phase 2: TaskFlow Lifecycle

1. Reject partial shared TaskFlow argument sets before creating a child session.
2. Pass lifecycle-tracking state into completion delivery and force tracked completions through the
   requester agent turn.
3. Add coverage for direct-capable origins to verify the parent turn still runs.

### Phase 3: Completion Recoverability

1. Mark aggregate results when per-item or total prompt limits truncate content.
2. Include the originating child session key in truncated summaries.
3. Prevent delete-mode cleanup from removing the only full result when delivery was truncated.

## Testing Strategy

- Unit: session write ordering, TaskFlow argument validation, aggregate truncation metadata.
- Integration: tracked child completion with a direct-capable requester origin.
- Regression: existing session, subagent announce, TaskFlow, registry, pairing, and stream tests.

## Risks & Mitigations

- **Risk**: Parent routing adds one agent turn for tracked completions.
  - Mitigation: restrict the behavior to runs with `trackingTaskFlowId`.
- **Risk**: Flush-before-save can add latency to legacy full-store callers.
  - Mitigation: only wait for queued work on the same store path.
- **Risk**: Retained delete-mode sessions require later cleanup.
  - Mitigation: retain only when truncation makes the queued prompt lossy.

## Success Criteria

- [x] Mixed session writes preserve invocation order.
- [x] Incomplete shared TaskFlow parameters fail before spawn.
- [x] Tracked completions execute a requester agent turn.
- [x] Truncated results retain a readable source.
- [x] Normal shutdown waits long enough for state locks and rename retries.
- [x] Targeted tests and diff checks pass.
