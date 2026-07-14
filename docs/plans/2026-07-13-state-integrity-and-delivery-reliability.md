# Implementation Plan: State Integrity and Delivery Reliability

## Overview

Fix four persistence and lifecycle defects that can silently lose pairing state, session mutations,
or subagent completion delivery. Keep the changes scoped to existing stores and queue abstractions.

## Requirements

- Preserve out-of-process device pairing changes during gateway mutations.
- Mark subagent completion delivery successful only after the queued send succeeds.
- Keep pending coalesced session writes alive until their drain timer runs.
- Propagate exhausted Windows atomic rename failures to callers.

## Architecture Changes

- `src/infra/device-pairing.ts`: serialize mutations with a cross-process file lock and reload disk
  state inside the lock.
- `src/agents/subagent-announce-queue.ts`: attach delivery receipts to lossless completion items and
  settle every item in an aggregate send.
- `src/infra/coalesced-mutation-queue.ts`: keep the sole drain timer referenced.
- `src/config/sessions/store.ts`: throw after the final Windows rename retry fails.

## Implementation Steps

### Phase 1: State Integrity

1. **Lock and reload device pairing mutations**
   - File: `src/infra/device-pairing.ts`
   - Action: acquire the existing cross-process file lock and refresh both pairing files before each
     mutation.
   - Why: cached snapshots must not overwrite approvals or edits made by another process.
   - Dependencies: none.
   - Risk: medium.

2. **Cover stale-cache overwrite**
   - File: `src/infra/device-pairing.test.ts`
   - Action: modify paired state on disk, verify another token, and assert the external device
     remains.
   - Why: reproduces the destructive writeback path.
   - Dependencies: step 1.
   - Risk: low.

### Phase 2: Delivery Lifecycle

1. **Settle queued completion receipts**
   - Files: `src/agents/subagent-announce-queue.ts`, `src/agents/subagent-announce.ts`
   - Action: return a delivery promise, fan out aggregate success or failure, and await it in the
     announce flow.
   - Why: registry cleanup must follow actual delivery.
   - Dependencies: none.
   - Risk: high.

2. **Recover interrupted cleanup**
   - File: `src/agents/subagent-registry.store.ts`
   - Action: reopen persisted cleanup records that were marked handled without a completion
     timestamp.
   - Why: a restart during queued delivery must retry the announce.
   - Dependencies: step 1.
   - Risk: medium.

### Phase 3: Session Write Reliability

1. **Keep the coalescing timer referenced**
   - File: `src/infra/coalesced-mutation-queue.ts`
   - Action: remove `unref()` from the only timer that starts a drain.
   - Why: pending writes must keep short-lived CLI processes alive.
   - Dependencies: none.
   - Risk: low.

2. **Propagate Windows rename exhaustion**
   - File: `src/config/sessions/store.ts`
   - Action: retain the final rename error and throw after all retries fail.
   - Why: the mutation queue can reject callers instead of reporting a lost write as successful.
   - Dependencies: none.
   - Risk: medium.

## Testing Strategy

- Unit tests: pairing stale-cache preservation, announce aggregate receipts, timer reference state,
  mutation batch rejection, and Windows rename exhaustion.
- Integration tests: focused existing subagent registry and session store suites.
- E2E tests: not required for these internal persistence paths.

## Risks & Mitigations

- **Long-running announce receipt**
  - Mitigation: existing announce timeout and queue failure paths settle the delivery result.
- **Cross-process lock contention**
  - Mitigation: reuse the established stale-lock and timeout behavior.
- **Windows transient locks**
  - Mitigation: retain the existing five-attempt backoff before surfacing failure.

## Success Criteria

- [x] External pairing state survives gateway authentication writes.
- [x] Registry cleanup completes only after queued announce delivery succeeds.
- [x] Pending coalesced writes keep the process alive until drained.
- [x] Exhausted Windows rename retries reject the save and queued mutations.
