# Implementation Plan: Synthetic Heartbeat Session Lifecycle

## Overview

Replace mutable key/origin heuristics with explicit run-scoped heartbeat ownership. `heartbeatLease` rejects stale writes, while `heartbeatOnly` marks sessions created solely by heartbeat execution. Real inbound traffic atomically clears both fields and revokes the heartbeat run.

## Requirements

- Do not delete a user session created after the heartbeat transcript snapshot.
- Do not infer heartbeat ownership from session keys or mutable origin metadata.
- Hide only explicitly marked synthetic heartbeat sessions from Gateway and Control UI lists.
- Preserve acknowledgement-only transcript pruning for existing sessions.

## Architecture Changes

- `src/config/sessions/types.ts`: add persisted `heartbeatLease` and `heartbeatOnly` lifecycle markers.
- `src/config/sessions/store.ts`: enforce heartbeat ownership for all session-store writes and expose an abort signal for revoked runs.
- `src/infra/heartbeat-runner.ts`: validate `sessionId`, lease `runId`, and heartbeat-only `runId`; delete acknowledgement-only sessions after run accounting completes.
- `src/auto-reply/reply/session.ts`: claim heartbeat ownership during heartbeat initialization and revoke it when non-heartbeat traffic claims a session.
- `src/agents/pi-embedded-runner/run.ts`: expose optional callbacks at the existing session-lane execution boundary so transcript capture and rollback remain serialized with the heartbeat turn.
- `src/gateway/session-utils.ts`: filter only explicit heartbeat-only markers before rows reach clients.

## Implementation Steps

### Phase 1: Lifecycle Ownership

1. Add run-scoped heartbeat lease and heartbeat-only markers to `SessionEntry`.
2. Atomically claim or replace the lease during heartbeat session initialization.
3. Clear both markers and revoke the previous run during non-heartbeat session initialization.
4. Require session identity, lease, and heartbeat-only marker matches before deleting an acknowledgement-only session.
5. Capture existing transcript baselines and perform acknowledgement rollback before releasing the session lane.
6. Delay heartbeat-only entry deletion until embedded execution and run accounting complete.

### Phase 2: Visibility

1. Filter heartbeat-only entries in the Gateway session store projection.
2. Remove key suffix and origin heuristics from Gateway and Control UI filtering.
3. Keep the Control UI dependent on the already-filtered Gateway response.

### Phase 3: Tests

1. Add deterministic init-to-lane session replacement coverage.
2. Verify lease or heartbeat-only ownership mismatch prevents deletion and stale writes.
3. Verify run accounting finishes before heartbeat-only deletion.
4. Verify legitimate heartbeat-suffixed and heartbeat-origin sessions remain visible without a marker.
5. Verify explicitly marked sessions remain hidden.

## Testing Strategy

- Targeted Vitest coverage for heartbeat transcript pruning and session initialization.
- Targeted Gateway session utility tests.
- Targeted Control UI session view tests.

## Risks & Mitigations

- **Stale marker after a failed heartbeat**: keep it hidden until real inbound traffic clears ownership.
- **Concurrent user claim**: clear the markers through the serialized session-store mutation queue and abort the stale run before user transcript execution.
- **Post-run accounting recreates deleted entries**: defer deletion until accounting completes, then use a three-field ownership check.
- **Legacy heuristic-only entries become visible**: prefer visibility over false-positive hiding; no permanent user-controlled heuristic remains.

## Success Criteria

- [x] User session entries and transcripts survive the capture/create/heartbeat ACK race.
- [x] Cleanup deletes only the session claimed by the same heartbeat run and only after accounting.
- [x] Gateway filtering uses only `heartbeatOnly`; the UI renders the filtered result.
- [x] Targeted tests pass.
