# Implementation Plan: WebChat Artifact Anchor Association Fix

## Overview

Fix WebChat output artifacts that are scoped to the correct session but rendered below the latest conversation because they lack a stable message-level anchor.
Separate upload idempotency from UI placement across `openclaw-integration`, `agent-server`, `client-collections`, and `agent-frontend`, while preserving access to historical artifacts that cannot be safely backfilled.

## Requirements

- Keep every output artifact authorized and listed by its existing user, target, and `clientSessionId` scope.
- Associate newly published artifacts with the exact parent tool call that produced or requested them.
- Support multiple files from one subagent handoff without violating artifact idempotency constraints.
- Preserve direct `webui_artifact_publish` placement for existing and new artifacts.
- Persist the originating `sessions_spawn` tool call across OpenClaw process restarts.
- Prevent historical unanchored artifacts from appearing below the latest assistant response.
- Keep historical artifacts downloadable from a session-level file history surface.
- Avoid timestamp, list order, or filename heuristics when an exact anchor is unavailable.
- Keep all new API fields optional during rollout.

## Current Failure

The current artifact model stores:

- Session ownership through `principal_id`, `target_kind`, `target_id`, and `client_session_id`.
- Upload idempotency through `source_tool_call_id`.
- No run, message, or placement anchor.

Direct publication passes the real `webui_artifact_publish` tool call ID as `sourceToolCallId`. Subagent handoff publication passes `subagent-handoff:<runId>:<index>` so each file has a unique idempotency key. The frontend only links `sourceToolCallId` values that match a visible `webui_artifact_publish` call. Every other artifact becomes `unlinked` and is rendered after the message list.

The `previousTurnArtifactIds` state only suppresses artifacts after a successful send in the current component instance. Initial load, remount, reconnect, and artifact-list timing races can expose historical artifacts again.

## Design Decisions

### Separate Idempotency And Placement

Keep `sourceToolCallId` as the existing idempotency identity for backward compatibility. Add `anchorToolCallId` as an optional, non-unique placement identity.

| Producer                        | `sourceToolCallId`                 | `anchorToolCallId`                        |
| ------------------------------- | ---------------------------------- | ----------------------------------------- |
| Direct `webui_artifact_publish` | Publish tool call ID               | Publish tool call ID                      |
| Subagent handoff                | `subagent-handoff:<runId>:<index>` | Originating `sessions_spawn` tool call ID |
| Historical row                  | Existing value or `null`           | `null`                                    |

One subagent handoff may publish several files. Their idempotency keys must remain distinct, while all files may share the same placement anchor.

### Persist The Spawn Anchor

Move `sourceToolCallId` into `SubagentRunRecord`. The current `WeakMap<SubagentRunRecord, string>` is process-local and is not serialized by the subagent registry persistence layer. Restarted announce retries and `subagents.list` therefore lose the exact spawn association.

During migration, `getSubagentSourceToolCallId` may read the persisted record first and fall back to the WeakMap for already-running in-memory records created before the change.

### Historical Artifact Policy

Rows with no usable `anchorToolCallId` remain session files. They must not be inserted after `ThreadPrimitive.Messages`.

Safe compatibility behavior:

- A historical direct artifact may use `sourceToolCallId` as a legacy anchor only when it exactly matches a visible `webui_artifact_publish` tool call.
- A historical subagent handoff artifact with a synthetic source ID remains unanchored.
- Unanchored artifacts are shown in a distinct session-level "历史文件" surface.
- No backfill should infer a spawn call from timestamps, artifact order, run order, filename, or the current last message.

## Architecture Changes

### `openclaw-integration`

- `src/agents/subagent-registry.types.ts`
  - Add optional `sourceToolCallId` to `SubagentRunRecord`.
- `src/agents/subagent-registry.ts`
  - Persist the normalized spawn tool call ID on the run record.
  - Preserve it when replacing a run after steer or continuation.
  - Pass it into `runSubagentAnnounceFlow`.
  - Keep a temporary WeakMap fallback only if needed for rolling compatibility.
- `src/agents/subagent-announce.ts`
  - Carry `sourceToolCallId` through announce and handoff staging/delivery events.
- `src/plugins/types.ts`
  - Add optional `sourceToolCallId` to `PluginHookSubagentHandoffStagingEvent`.
- `extensions/webui-artifacts/src/artifact-client.ts`
  - Extend artifact init input with optional `anchorToolCallId`.
- `extensions/webui-artifacts/src/webui-artifact-tool.ts`
  - Pass independent idempotency and placement values to artifact init.
- `extensions/webui-artifacts/index.ts`
  - Use a per-file synthetic source ID and the shared spawn anchor for handoff files.

### `agent-server`

- `migrations/versions/015_add_openclaw_artifact_anchor.py`
  - Add nullable `anchor_tool_call_id VARCHAR(255)`.
  - Do not add a uniqueness constraint.
  - Keep the existing `(session_ref, source_tool_call_id)` uniqueness constraint.
- `app/core/entities/openclaw/artifacts.py`
  - Add `anchor_tool_call_id` to `OpenClawArtifact` and `OpenClawArtifactDTO`.
- `app/infra/repository/db/pos/openclaw_artifact_po.py`
  - Map the new nullable column.
- `app/api/v1/schemas/openclaw_artifact_schema.py`
  - Accept optional `anchorToolCallId` in artifact init.
- `app/api/v1/controllers/openclaw_artifact_controller.py`
  - Forward the new field to `OpenClawArtifactService.init`.
- `app/services/openclaw_artifact_service.py`
  - Store and return the anchor in init, list, complete, and `artifact.available`.
- `app/common/constants/openclaw_gateway.py`
  - Add `sourceToolCallId` to `OPENCLAW_GATEWAY_SUBAGENT_PUBLIC_FIELDS`.
- `app/services/openclaw_protocol_translator.py`
  - Continue exposing only allowlisted subagent fields while preserving the new public association.

### `agent-frontend`

- `src/utils/openclawBff/types.ts`
  - Add optional `anchorToolCallId` to artifacts.
  - Add optional `sourceToolCallId` to subagent runs.
- `src/features/openclaw-bff/api/artifacts.ts`
  - Validate and parse the optional anchor.
- `src/features/openclaw-bff/hooks/artifact-state.ts`
  - Place artifacts by `anchorToolCallId`.
  - Permit anchors for `webui_artifact_publish` and `sessions_spawn`.
  - Retain the exact-match legacy fallback for historical direct publication.
  - Return unanchored artifacts as historical session files.
- `src/features/openclaw-bff/hooks/subagent-state.ts`
  - Parse `sourceToolCallId`.
  - Bind children to matching spawn calls before applying the legacy one-to-one fallback.
- `src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`
  - Remove `previousTurnArtifactIds`.
  - Pass linked artifacts into the thread and historical artifacts into a separate session-file surface.
- `src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
  - Render linked artifacts for both publish and spawn tool calls.
  - Remove the unlinked artifact footer after `ThreadPrimitive.Messages`.
  - Keep session-level historical files visually outside the message stream.

### `client-collections`

- `agent-frontend-client/schemas/open-claw-artifact-dto.ts` and generated companion files
  - Regenerate the frontend client from the updated agent-server OpenAPI contract.
  - Expose optional `anchorToolCallId` on `OpenClawArtifactDTO`.

## Ownership Map

| Scope                       | Owner              | Allowed paths                                                                                                         |
| --------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| OpenClaw core and extension | Coordinating Codex | Planned `src/agents/*`, `src/plugins/types.ts`, and `extensions/webui-artifacts/*` paths                              |
| Agent server                | Coordinating Codex | Planned artifact schema, controller, service, entity, repository, constants, translator, migration, and focused tests |
| Generated client            | Coordinating Codex | Generated `agent-frontend-client` output produced from the updated OpenAPI contract                                   |
| Agent frontend              | Coordinating Codex | Planned OpenClaw BFF types, API parser, state hooks, screen, thread components, and focused tests                     |
| Remote acceptance           | Coordinating Codex | `ssh-xiaolu-test:~/github/openclaw-integration` update, Gateway restart, and WebChat acceptance checks                |

## Implementation Steps

### Phase 1: Agent Server Contract And Storage

1. **Add the artifact anchor column**
   - File: `agent-server/migrations/versions/015_add_openclaw_artifact_anchor.py`
   - Action:
     - Add nullable `anchor_tool_call_id`.
     - Add no unique constraint because several handoff files share one anchor.
     - Implement downgrade by dropping only the new column.
   - Why: The server must accept the new field before OpenClaw starts sending it.
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

2. **Extend artifact domain and persistence models**
   - Files:
     - `agent-server/app/core/entities/openclaw/artifacts.py`
     - `agent-server/app/infra/repository/db/pos/openclaw_artifact_po.py`
   - Action:
     - Add optional `anchor_tool_call_id`.
     - Expose it as `anchorToolCallId` in browser DTOs.
   - Why: The placement identity must survive init, completion, list, and event delivery.
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Low.

3. **Extend artifact init and response flow**
   - Files:
     - `agent-server/app/api/v1/schemas/openclaw_artifact_schema.py`
     - `agent-server/app/api/v1/controllers/openclaw_artifact_controller.py`
     - `agent-server/app/services/openclaw_artifact_service.py`
   - Action:
     - Accept optional `anchorToolCallId`.
     - Store it without using it for idempotency lookup.
     - Return it from list, completion, and `artifact.available`.
     - Keep `source_tool_call_id` as the only idempotency lookup key.
   - Why: Mixing the two fields would reintroduce the multi-file uniqueness conflict.
   - Dependencies: Step 2.
   - Complexity: Medium.
   - Risk: Medium.

4. **Expose the subagent spawn association**
   - Files:
     - `agent-server/app/common/constants/openclaw_gateway.py`
     - `agent-server/app/services/openclaw_protocol_translator.py`
   - Action:
     - Add `sourceToolCallId` to the subagent public-field allowlist.
     - Preserve private gateway session keys, raw run IDs, task text, and results filtering.
   - Why: The frontend can replace ordinal subagent binding with an exact relation.
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low, provided the field contains only the browser-visible parent tool call ID.

### Phase 2: OpenClaw Spawn Anchor Propagation

1. **Persist `sourceToolCallId` in subagent records**
   - Files:
     - `src/agents/subagent-registry.types.ts`
     - `src/agents/subagent-registry.ts`
     - `src/agents/subagent-registry-state.ts`
   - Action:
     - Add the optional field to `SubagentRunRecord`.
     - Set it during `registerSubagentRun`.
     - Preserve it in `replaceSubagentRunAfterSteer`.
     - Read persisted records without requiring a schema migration.
     - Keep compatibility with records that omit the field.
   - Why: The current WeakMap loses the anchor after restart and across worker disk reads.
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Medium because registry recovery behavior is shared by all subagents.

2. **Carry the anchor into handoff hooks**
   - Files:
     - `src/agents/subagent-registry.ts`
     - `src/agents/subagent-announce.ts`
     - `src/plugins/types.ts`
   - Action:
     - Add optional `sourceToolCallId` to `runSubagentAnnounceFlow`.
     - Add it to `stageAndDeliverSubagentHandoff`.
     - Include it in staging and delivery hook events.
   - Why: The WebChat adapter should receive the exact spawn anchor from core.
   - Dependencies: Phase 2, Step 1.
   - Complexity: Medium.
   - Risk: Low because the hook field is optional.

3. **Send separate init identities**
   - Files:
     - `extensions/webui-artifacts/src/artifact-client.ts`
     - `extensions/webui-artifacts/src/webui-artifact-tool.ts`
     - `extensions/webui-artifacts/index.ts`
   - Action:
     - Extend `ArtifactInitInput` with `anchorToolCallId`.
     - Let `publishWorkspaceArtifact` accept independent `sourceId` and `anchorToolCallId`.
     - For direct publication, send the real tool call ID in both fields.
     - For handoff publication, keep `subagent-handoff:<runId>:<index>` as the source and send the event spawn ID as the anchor.
     - Omit the anchor when old or recovered records do not contain it.
   - Why: Multiple files can share one placement while retaining independent retries.
   - Dependencies: Agent-server Phase 1 must be deployed first.
   - Complexity: Medium.
   - Risk: High if deployed before the server because the init schema forbids unknown fields.

### Phase 2.5: Regenerate The Frontend Client

1. **Regenerate the OpenAPI client**
   - Repository: `client-collections`
   - Action:
     - Generate from the updated agent-server OpenAPI contract.
     - Increment the client package version according to the server delivery workflow.
     - Confirm `OpenClawArtifactDTO` exposes optional `anchorToolCallId`.
     - Update the agent-frontend submodule gitlink to the generated client commit before frontend verification.
   - Why: The browser artifact list uses the generated `OpenClawArtifactsApi`; the client contract must match the server DTO.
   - Dependencies: Agent-server Phase 1.
   - Complexity: Medium.
   - Risk: Medium because generated output and the frontend gitlink must remain aligned.

### Phase 3: Frontend Exact Placement

1. **Parse the new DTO fields**
   - Files:
     - `agent-frontend/src/utils/openclawBff/types.ts`
     - `agent-frontend/src/features/openclaw-bff/api/artifacts.ts`
     - `agent-frontend/src/features/openclaw-bff/hooks/subagent-state.ts`
   - Action:
     - Add bounded optional ID validation for artifact anchors.
     - Parse subagent `sourceToolCallId`.
     - Ignore malformed optional fields without weakening required-field validation.
   - Why: Optional parsing permits mixed-version rollout and historical rows.
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

2. **Bind subagents by exact spawn ID**
   - File: `agent-frontend/src/features/openclaw-bff/hooks/subagent-state.ts`
   - Action:
     - Bind every child whose `sourceToolCallId` matches a visible `sessions_spawn` call.
     - Apply the existing one-unmatched-child/one-unmatched-anchor fallback only to legacy children without an exact association.
     - Leave ambiguous legacy children under "其他子任务".
   - Why: Artifact placement and subagent card placement should use the same parent anchor.
   - Dependencies: Phase 3, Step 1.
   - Complexity: Medium.
   - Risk: Medium around retained and archived child runs.

3. **Place artifacts by explicit anchor**
   - File: `agent-frontend/src/features/openclaw-bff/hooks/artifact-state.ts`
   - Action:
     - Build a set of visible artifact-capable anchors from `webui_artifact_publish` and `sessions_spawn`.
     - Prefer `anchorToolCallId`.
     - Use `sourceToolCallId` only as a legacy direct-publish fallback when it matches a visible publish call.
     - Return every remaining artifact in a `historical` collection.
   - Why: Synthetic handoff IDs and unrelated tool calls must never be treated as current-message anchors.
   - Dependencies: Phase 3, Step 1.
   - Complexity: Medium.
   - Risk: Medium because this function controls all artifact placement.

4. **Remove the message-footer fallback**
   - Files:
     - `agent-frontend/src/features/openclaw-bff/screen/OpenClawChatScreen.tsx`
     - `agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx`
   - Action:
     - Remove `previousTurnArtifactIds` and `sendAndTrackSession` artifact bookkeeping.
     - Stop rendering historical artifacts after `ThreadPrimitive.Messages`.
     - Allow linked artifacts under both `webui_artifact_publish` and `sessions_spawn`.
     - Add or reuse a session-level file-history affordance outside the chronological message list.
   - Why: Component-local suppression cannot establish artifact ownership.
   - Dependencies: Phase 3, Step 3.
   - Complexity: Medium.
   - Risk: Medium because historical files must remain discoverable.

### Phase 4: Historical Compatibility And Rollout

1. **Do not backfill synthetic handoff rows**
   - Scope: Existing `openclaw_artifacts` records.
   - Action:
     - Leave `anchor_tool_call_id` null for historical rows.
     - Let the frontend recover only exact legacy direct-publish matches.
   - Why: Old synthetic source IDs do not contain the originating spawn tool call ID, and registry retention may already have expired.
   - Dependencies: Agent-server Phase 1 and Frontend Phase 3.
   - Complexity: Low.
   - Risk: Low.

2. **Deploy in compatibility order**
   - Order:
     1. Deploy the agent-server migration and optional contract.
     2. Deploy the regenerated client with agent-frontend optional parsing and historical-file behavior.
     3. Deploy openclaw-integration anchor propagation.
   - Why: OpenClaw must not send `anchorToolCallId` to an older server with `extra='forbid'`.
   - Dependencies: All implementation phases.
   - Complexity: Medium.
   - Risk: High if deployment order is reversed.

3. **Observe mixed-version behavior**
   - Action:
     - Log artifact init with booleans for source and anchor presence without logging opaque IDs.
     - Count unanchored output artifacts returned to the browser.
     - Verify the count declines after OpenClaw rollout while historical rows remain stable.
   - Why: This confirms new producers are sending anchors and separates rollout gaps from old data.
   - Dependencies: Phase 4, Step 2.
   - Complexity: Low.
   - Risk: Low.

## Testing Strategy

### `agent-server`

- Unit test artifact init accepts and stores `anchorToolCallId`.
- Unit test list and `artifact.available` return `anchorToolCallId`.
- Repository test creates two artifacts with different `source_tool_call_id` values and the same `anchor_tool_call_id`.
- Repository test retains existing idempotency conflict behavior for duplicate source IDs.
- Protocol translator test preserves `sourceToolCallId` and continues stripping raw gateway identifiers and private run data.
- Migration upgrade and downgrade smoke test.
- Suggested focused command:
  - `uv run pytest app/test/unit_test/api/test_openclaw_artifact_controller.py app/test/unit_test/services/test_openclaw_artifact_service.py app/test/unit_test/infra/repository/test_openclaw_artifact_repository.py app/test/unit_test/services/test_openclaw_protocol_translator.py`

### `openclaw-integration`

- Registry persistence test writes and restores `sourceToolCallId`.
- Steer/replacement test preserves the source tool call ID.
- Handoff hook test receives the source tool call ID.
- WebUI artifact test verifies:
  - Direct publication sends the same source and anchor.
  - Two handoff files send distinct source IDs.
  - Both handoff files send the same spawn anchor.
  - Missing legacy anchor remains valid.
- Suggested focused command:
  - `pnpm test src/agents/subagent-registry.persistence.test.ts src/agents/subagent-announce.format.test.ts extensions/webui-artifacts/index.test.ts extensions/webui-artifacts/src/webui-artifact-tool.test.ts`
- Run `make lint` in the current worktree after focused tests.
- Do not run `make test` unless explicitly requested.

### `agent-frontend`

- Artifact placement test links direct output to `webui_artifact_publish`.
- Artifact placement test links multiple handoff files to one `sessions_spawn`.
- Legacy direct artifact test uses an exact source fallback.
- Synthetic historical handoff artifact remains historical.
- Reload/remount test confirms historical files never appear below the latest message.
- Subagent state test binds exact source IDs before the legacy fallback.
- Ambiguous legacy subagents remain under "其他子任务".
- Suggested focused command:
  - `npm run test:unit -- src/features/openclaw-bff/hooks/artifact-state.test.ts src/features/openclaw-bff/hooks/subagent-state.test.ts`
  - `npm run test:components -- src/features/openclaw-bff/screen/OpenClawChatScreen.test.tsx src/features/openclaw-bff/components/chat/ArtifactCard.test.tsx`
  - `npm run lint`

### `client-collections`

- Generated client contains optional `anchorToolCallId` in `OpenClawArtifactDTO`.
- Generated package build passes.
- Agent-frontend uses the exact generated commit through its submodule gitlink.

### Cross-Repository Acceptance

1. Start a WebChat turn that spawns one subagent and exports two files.
2. Confirm both files appear under the originating `sessions_spawn` card.
3. Refresh the page and confirm placement is unchanged.
4. Restart OpenClaw before completion, allow announce recovery, and confirm placement is unchanged.
5. Open a session containing an August 11 historical synthetic handoff artifact.
6. Confirm the old file remains downloadable from history and does not appear below the latest assistant response.
7. Publish a direct file and confirm it remains attached to its `webui_artifact_publish` call.
8. On `ssh-xiaolu-test`, update `~/github/openclaw-integration`, restart the OpenClaw Gateway, and repeat the direct and subagent placement checks against the deployed runtime.

## Risks & Mitigations

- **Server rejects new init fields during mixed-version rollout**
  - Mitigation: Deploy the optional agent-server contract before OpenClaw.

- **Multiple handoff files collide on one source ID**
  - Mitigation: Keep the indexed synthetic source ID and use the shared spawn ID only as a non-unique anchor.

- **Restarted subagent loses its parent association**
  - Mitigation: Persist `sourceToolCallId` in `SubagentRunRecord` and cover disk restore with focused tests.

- **Historical artifacts are silently hidden**
  - Mitigation: Keep them in a distinct session-level historical-file surface with normal download authorization.

- **Incorrect historical backfill attaches a file to the wrong message**
  - Mitigation: Allow only exact direct-publish fallback; do not infer subagent anchors.

- **Raw gateway identity leaks through `subagents.list`**
  - Mitigation: Expose only `sourceToolCallId`; keep session keys, raw run IDs, task content, and outcomes behind the existing translator.

- **Frontend renders an anchor for an unrelated tool**
  - Mitigation: Accept placement only when the anchor matches a visible `webui_artifact_publish` or `sessions_spawn` call.

## Success Criteria

- [ ] New direct artifacts remain attached to their exact `webui_artifact_publish` calls.
- [ ] New subagent artifacts attach to their exact originating `sessions_spawn` calls.
- [ ] Multiple files from one handoff publish successfully with one shared placement anchor.
- [ ] OpenClaw restart and announce retry preserve the spawn anchor.
- [ ] Browser reload and reconnect preserve artifact placement.
- [ ] Historical unanchored artifacts never appear below the latest assistant response.
- [ ] Historical artifacts remain downloadable from a session-level history surface.
- [ ] Existing artifact idempotency and session authorization behavior remain unchanged.
- [ ] Subagent cards use exact source associations when available.
- [ ] Focused tests and repository lint pass in all three repositories.
