# Implementation Plan: OpenClaw Coalesced State Writes

## Overview

Reduce Gateway event-loop stalls and filesystem write amplification from `subagents/runs.json`
and `sessions.json`. Preserve atomic persistence, cross-process session locking, mutation order,
and caller-visible durability semantics.

## Requirements

- Replace synchronous subagent registry writes with asynchronous atomic writes.
- Coalesce repeated writes to the same file within 100 to 250 milliseconds.
- Batch session mutations under one cross-process lock, one disk read, and one disk write.
- Flush pending state during Gateway shutdown.
- Preserve error propagation for awaited session mutations.

## Architecture Changes

- `src/infra/coalesced-mutation-queue.ts`: reusable path-scoped mutation batching.
- `src/config/sessions/store.ts`: asynchronous disk reads and batched session mutations.
- `src/agents/subagent-registry.store.ts`: latest-wins asynchronous registry persistence.
- `src/gateway/server.impl.ts`: bounded shutdown flush.

## Implementation Steps

### Phase 1: Mutation Queue

1. Add a path-scoped coordinator with debounce, ordered mutation execution, failure isolation,
   explicit flush, and test cleanup.
2. Keep the coordinator independent from session types and filesystem locking.

### Phase 2: Session Store

1. Add an asynchronous uncached disk loader for mutation batches.
2. Route `updateSessionStore`, `updateSessionStoreEntry`, and `updateLastRoute` through the
   coordinator.
3. Combine maintenance options and write the final batch once under the existing file lock.

### Phase 3: Subagent Registry

1. Convert full synchronous writes to latest-wins asynchronous atomic writes.
2. Add explicit flush support and log background persistence failures.
3. Update persistence tests to wait for durability.

### Phase 4: Shutdown and Verification

1. Flush both queues with a hard timeout during Gateway close.
2. Add tests proving one physical write for concurrent updates.
3. Run focused Vitest targets and lint.

## Testing Strategy

- Unit: queue ordering, mutation failure isolation, flush behavior.
- Integration: concurrent session additions and patches survive one batched write.
- Persistence: subagent registry writes remain restart-safe and migration-safe.
- Shutdown: pending queues are included in Gateway close.

## Risks & Mitigations

- **Mutation failure leaks partial state**
  - Run every mutator against a cloned candidate and commit only successful candidates.
- **Cross-process overwrite**
  - Keep the existing lock and perform the uncached read after acquiring it.
- **Shutdown loses debounced state**
  - Add explicit bounded flush before Gateway resources close.
- **Maintenance callbacks differ within one batch**
  - Evaluate all active warning options against the final store and enforce maintenance once.

## Success Criteria

- [x] No synchronous write remains in subagent registry persistence.
- [x] Concurrent session mutations use one disk read and one atomic write per batch.
- [x] Awaited session mutations resolve only after the batch is durable.
- [x] Mutator and write failures reject affected callers without poisoning later batches.
- [x] Gateway shutdown flushes pending state within a bounded deadline.
