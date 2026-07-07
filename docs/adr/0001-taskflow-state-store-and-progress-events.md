# TaskFlow state store and progress events

OpenClaw will implement TaskFlow as a core file-backed state store with owner-scoped snapshots, a lightweight global locator index, and `taskflow_updated` typed plugin events. We intentionally do not derive TaskFlow state from transcript tool history, Codex-style `update_plan` UI events, an in-memory event bus, or Feishu `reply-dispatcher`; those alternatives either lose state across compaction/restart, couple progress to a single assistant reply lifecycle, or make shared agent authorization unclear. Channel integrations such as Feishu may reuse low-level streaming primitives, but TaskFlow progress is published from TaskFlow revisions rather than assistant text streaming.

## Decisions captured during design interview (2026-06-18)

The following decisions refine the core plan in `docs/plans/2026-06-18-taskflow-todolist.md`. Each is recorded here as part of the architectural rationale so future contributors understand not just _what_ was decided but _why_ the rejected alternatives were rejected.

### D1. Status set includes `parked`; foreground single-slot rule

TaskFlow status is `active | blocked | parked | completed | canceled`. Foreground is defined as `active | blocked`. Each `ownerSessionKey` holds at most one **foreground** TaskFlow at a time; `parked` does not occupy the foreground slot.

- Why: `blocked` means "blocked but still my current focus, should resume"; `parked` means "owner explicitly suspended, not occupying current focus." Conflating them produces ambiguous resume paths (which of N blocked items should the prompt inject?).
- New operations: `park_taskflow(reason?)` (only on current foreground) and `resume_taskflow(taskFlowId)` (only when no foreground exists).
- Feishu publisher renders parked state as "已挂起" on the same card but does **not** close streaming mode; only `completed | canceled` close it.
- Rejected: forcing `cancel` to start a new flow (pollutes history semantics); relaxing `blocked` out of the slot (re-introduces the ambiguous foreground problem).

### D2. Revision conflict returns metadata only — no snapshot, no auto-merge

`taskflow_update` with a stale `expectedRevision` returns `{ code: "revision_conflict", expectedRevision, actualRevision, affectedItemIds, message }`. The model must call `taskflow_read`, merge its intent, and retry with the latest revision.

- Why: returning a full snapshot makes `taskflow_update` double as a read entry point and bloats conflict payloads. Auto-merging "seemingly commutative" operations like `attach_evidence` is unsafe because the item may have been canceled, the permission revoked, or the active item moved.
- The only rule injected into the prompt is: "If `taskflow_update` returns `revision_conflict`, call `taskflow_read`, merge, and retry."
- Operation-level commutativity is explicitly deferred to a future hardening phase.

### D3. File is authoritative; orphaned TaskFlows are readable history, not auto-canceled

TaskFlow files are the authoritative state; `ownerSessionKey` is ownership metadata. Archiving or deleting the owner session does **not** mutate the TaskFlow status.

- Why: archive is operational cleanup of a runtime session, not a business decision about task completion. Forcing cancel would manufacture incorrect terminal state.
- `taskflow_read(taskFlowId)` keeps working as long as the file exists.
- Prompt injection only happens in the currently-running session; once an owner session is archived it no longer builds prompts, so its TaskFlows simply stop being injected — they are not erased.
- Phase 6 adds an orphan scanner that marks `metadata.orphanedAt` on `active|blocked|parked` TaskFlows whose owner session is gone and `updatedAt` exceeds a threshold, and optionally archives / cancels / closes their Feishu subscribers.

### D4. Child-agent local TaskFlow only subscribes its own chat

When a Researcher or PPT subagent creates a `local` TaskFlow and inherits a Feishu delivery context, the publisher only subscribes **its own session's chat** by default. It does not push a card into the parent chat. To surface child progress in the parent chat, the child must explicitly call `subscribe_channel` targeting that chat.

- Why: default parent-chat fanout would silently couple child task visibility to every spawn, contradicting the "main agent is not a default orchestrator" rule and would risk waking the main agent or polluting its transcript.
- Parent agent observes child completion only through the spawn completion message, handoff, `delivery.json`, or explicit `taskflow_read`.

### D5. Shared permission revocation: lifecycle hook primary, TTL fallback, manual override

`TaskFlowPermission` is expanded with `grantedBySessionKey`, `grantedAt`, `expiresAt`, `revokedAt`, `revokedReason`. ACL only considers permissions with empty `revokedAt` and unexpired `expiresAt`.

Revocation precedence:

1. `subagent_ended` typed plugin hook automatically writes `revokedReason="subagent_ended"` (primary).
2. Owner (or the original grantor) calls `revoke_access(targetSessionKey)` for mid-task cancellation; this path always records `revokedReason="manual"` — lifecycle reasons are written only by system paths.
3. `expiresAt` TTL (fallback).
4. Session archive/delete writes `revokedReason="session_deleted"`.
5. Phase 6 orphan scanner cleans up residual permissions.

- Why: TTL alone is too coarse (subagents may be re-spawned). Lifecycle hooks give a deterministic release point without polling.
- Boundary: `mode="session"` persistent subagents are **not** revoked on a single `run_ended`; revocation fires on `subagent_ended`, archive, delete, or manual revoke.
- Manual `revoke_access` is callable by owner or by `grantedBySessionKey`.

### D6. Prompt injection is turn-boundary, keeps `revision`, drops `updatedAt`

`before_prompt_build` reads the foreground TaskFlow once per turn and injects a Markdown snapshot. Within a turn, `taskflow_update` returns do **not** trigger prompt reconstruction — the model relies on tool return values for in-turn state, and the next turn re-reads from the persistent snapshot.

The injected Markdown **keeps `revision`** but **omits `updatedAt`**:

- `revision` is required for the model to know whether its `expectedRevision` is stale.
- `updatedAt` changes too frequently and has low decision value; including it would defeat prompt cache for negligible benefit.

When `parked` TaskFlows exist, a single summary line is appended (count + ids) without expanding items.

- Rejected: re-injecting after every in-turn update (defeats cache and forces repeated prompt assembly); stripping `revision` (model cannot reason about CAS).

### D7. Snapshot writes first, event log second; audit gap is a warning, not corruption

Write order is: `fsync` snapshot under file lock → append JSONL event. Failures:

- Snapshot write fails → update fails; revision not incremented; `taskflow_updated` not fired.
- Snapshot succeeds, event fails → update **succeeds**; tool returns `success + warnings: ["audit_event_append_failed"]`; `logger.warn` records it; `metadata.auditEventGaps` records `{ fromRevision, toRevision, detectedAt }`; `taskflow_updated` **still fires** (snapshot is committed).
- Phase 1 recovery depends only on snapshot; event gaps do not block `taskflow_read`, prompt injection, compaction resume, or Feishu publisher.

- Why: making JSONL co-authoritative would force WAL / two-phase commit across two files (rejected as out-of-scope) or turn event log into a replay source (rejected — Phase 1 explicitly has no replay).
- Phase 6's repair CLI uses `metadata.auditEventGaps` to flag the revisions requiring manual reconciliation.

### D8. `complete_taskflow` leaves snapshot in place; pending items are historical facts

`complete_taskflow` only sets `status="completed"`, `completedAt=now`, and increments `revision`. It does **not**:

- Move or archive the file (Phase 1).
- Auto-generate a Markdown archive (would create a third state surface).
- Cascade-complete pending items (the model may want to record what was eventually left undone).
- Continue injecting into subsequent prompts (would pollute the next task's context).

Pending items remain readable via `taskflow_read(taskFlowId)`. If the owner wants a clean terminal state, they should explicitly mark items `canceled` before calling `complete_taskflow`.

### D9. No runtime heuristics for creation frequency; metrics only

The runtime does **not** inspect prompt length, turn count, or simple/complex heuristics to gate `taskflow_update(create)`. Hard constraints remain: foreground single-slot, ACL, revision CAS, schema validation, file-write safety.

Over-creation is governed by metrics collection and downstream tuning of `tool description`, prompt policy, TaskFlow Skill, and channel-specific hints — not by core runtime rules.

- Why: writing "simple vs complex" heuristics into core makes the behavior impossible to reason about and risks false-negatives on long-tail tasks (e.g. the user explicitly says "做个计划" / "跟踪一下" with a short message).
- Metrics captured on each `create`: `agentId`, `ownerSessionKeyKind`, `channel`, `promptLengthBucket`, `initialItemCount`, `outcome` (`create_accepted` / `create_conflict_foreground_occupied`), and later `completedWithinTurns` / `canceledWithinTurns` / `lifetimeSeconds`.

## Status

Accepted — 2026-06-18. Implementation tracked in `docs/plans/2026-06-18-taskflow-todolist.md`.
