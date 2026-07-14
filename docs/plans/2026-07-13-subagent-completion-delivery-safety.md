# Implementation Plan: Subagent Completion Delivery Safety

## Overview

Prevent completion summaries from crossing delivery origins and stop treating in-memory queue
admission as successful delivery. Keep the persisted subagent registry as the recovery source while
the announce queue remains a process-local scheduler.

## Requirements

- Aggregate completion items only when channel, target, account, and thread match.
- Treat missing delivery identity as non-aggregatable.
- Resolve every run only after its completion group is delivered successfully.
- Keep `cleanup="delete"` sessions until delivery succeeds.
- Recover interrupted cleanup attempts after process restart.
- Preserve existing non-completion queue retry behavior.

## Architecture Changes

- `src/agents/subagent-announce-queue.ts`
  - Add per-item delivery receipts.
  - Drain completion items in strict `originKey` groups.
  - Use deterministic batch announce identities.
  - Disable lossy cap behavior for completion delivery.
- `src/agents/subagent-announce.ts`
  - Await completion delivery receipts.
  - Return `delivered=false` when grouped delivery fails.
  - Delete child sessions only after successful delivery.
- `src/agents/subagent-registry.store.ts`
  - Reset persisted in-flight cleanup flags that have no completion timestamp.

## Implementation Steps

### Phase 1: Queue Safety

1. Add a receipt-aware enqueue API without changing the existing boolean API.
2. Group completion items by `originKey`; isolate unkeyed items.
3. Resolve or reject every group member after `sendAnnounce`.
4. Generate a stable batch announce ID from group membership.

### Phase 2: Registry Semantics

1. Await the queue receipt in the completion path.
2. Defer transcript/session deletion until delivery succeeds.
3. Recover persisted `cleanupHandled=true` records when `cleanupCompletedAt` is absent.

### Phase 3: Tests

1. Reverse the cross-origin aggregation assertion.
2. Verify same-origin aggregation remains one send.
3. Verify grouped receipt fan-out and failure rejection.
4. Verify restart retries interrupted cleanup.
5. Verify `cleanup="delete"` retains the child session after delivery failure.

## Testing Strategy

- Queue unit tests for grouping, receipts, retries, and dedupe.
- Announce flow tests for delivery timing and cleanup behavior.
- Registry persistence tests for interrupted cleanup recovery.

## Risks & Mitigations

- **Duplicate delivery after process crash**
  - Use deterministic batch IDs. The system remains at-least-once because Gateway dedupe is
    process-local.
- **Unbounded completion queue**
  - Completion items are lossless in this patch. A durable SQLite outbox remains the long-term
    bounded-storage solution.
- **Hanging receipts**
  - Reject completion receipts on send failure so registry retry/backoff remains authoritative.

## Success Criteria

- [x] No completion prompt contains results from different `originKey` values.
- [x] Queue admission does not complete registry cleanup.
- [x] Delivery success fans out to every run in the aggregate.
- [x] Interrupted cleanup retries after restart.
- [x] Child transcripts survive failed completion delivery.
