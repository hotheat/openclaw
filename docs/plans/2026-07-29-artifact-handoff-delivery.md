# Implementation Plan: Artifact Handoff Delivery

## Overview

Introduce explicit artifact profiles, delivery policies, and channel adapters for subagent handoffs. Preserve managed parent delivery for PPTX workflows, enable direct automatic delivery for unmanaged researcher exports, and prevent WebChat artifacts from being published twice.

## Requirements

- Resolve researcher export, PPTX generator, and PPTX restyle profiles during staging.
- Carry profile and delivery-policy metadata with requester-visible artifacts.
- Support `auto` and `confirmation` delivery policies.
- Deliver unmanaged direct artifacts through WebChat or Feishu adapters.
- Keep managed and nested handoffs owned by the parent agent.
- Deliver the completion summary on both Feishu and WebChat.
- Record per-artifact adapter outcomes so successful files are removed from parent delivery.
- Share profile ids, quality statuses, staging policy statuses, and issue-code semantics.
- Preserve the real staging order: guard preflight at 200, artifact stager at 100, and final guard policy at 0.
- Replace Researcher-specific pending-state defaults with generic artifact-handoff naming.

## Architecture Changes

- `src/plugins/types.ts`: extend staged artifact metadata and delivery hook results.
- `src/plugins/hooks.ts`: merge delivery outcomes and stop after one adapter handles the event.
- `src/agents/subagent-announce.ts`: select one delivery owner from the final completion route and filter delivered artifacts.
- `extensions/webui-artifacts/index.ts`: report handled, delivered, and failed artifacts.
- `extensions/feishu/src/subagent-handoff-delivery.ts`: add Feishu attachment delivery adapter.
- `extensions/subagent-handoff-output-guard/lib/`: add profile resolver and delivery policy modules.
- `src/agents/subagent-handoff-contract.ts`: define the Core handoff status and issue-code contract exported through the plugin SDK.
- `extensions/subagent-handoff-output-guard/index.js`: remain a hook composition root.
- `extensions/subagent-handoff-output-guard/lib/staging-policy.js`: own guard preflight and final profile acceptance.
- `extensions/subagent-handoff-output-guard/lib/handoff-state-store.js`: own pending state persistence, locking, ordering, and tombstones.
- `extensions/subagent-handoff-output-guard/lib/confirmation-delivery.js`: own confirmation prompts and message-tool delivery tracking.
- `extensions/subagent-handoff-output-guard/lib/output-sanitizer.js`: own protocol and workspace-path sanitization.
- `extensions/subagent-handoff-output-guard/lib/runtime-context.js`: resolve workspace, channel, peer, and pending-state context.
- `extensions/subagent-handoff-output-guard/lib/artifact-identity.js`: normalize artifact attachment identities and hashes.

## Implementation Steps

### Phase 1: Core Delivery Ownership

1. **Extend hook contracts** (`src/plugins/types.ts`, `src/plugins/hooks.ts`)
   - Add profile and delivery-policy metadata to accepted/staged artifacts.
   - Add `handled` and `deliveredArtifacts` to delivery results.
   - Stop invoking lower-priority delivery adapters after one adapter handles the event.
   - Risk: Medium. Existing plugins returning only failures must remain valid.

2. **Route by final completion owner** (`src/agents/subagent-announce.ts`)
   - Allow channel delivery only for top-level direct completions that do not require parent collection.
   - Remove successfully delivered artifacts from the parent-visible handoff.
   - Escalate unhandled, failed, or incomplete automatic delivery to the parent with only unresolved artifacts.
   - Risk: High. This is the duplicate-delivery control point.

### Phase 2: Channel Adapters

1. **Update WebChat adapter** (`extensions/webui-artifacts/index.ts`)
   - Return explicit per-artifact delivery outcomes.
   - Preserve deterministic handoff source IDs.

2. **Add Feishu adapter** (`extensions/feishu/src/subagent-handoff-delivery.ts`)
   - Resolve the current Feishu target and account from requester origin.
   - Send each staged file through the Feishu media sender.
   - Return explicit per-artifact delivery outcomes.

### Phase 3: Profiles And Policy

1. **Add profile resolver** (`extensions/subagent-handoff-output-guard/lib/artifact-profiles.js`)
   - Define built-in researcher export, PPTX generator, and PPTX restyle profiles.
   - Support configuration overrides and future profile additions.

2. **Add delivery policy resolver** (`extensions/subagent-handoff-output-guard/lib/delivery-policy.js`)
   - Resolve `auto` or `confirmation` per profile and channel.

3. **Integrate staging metadata** (`extensions/subagent-handoff-output-guard/index.js`)
   - Replace hard-coded prefix checks with profile resolution.
   - Attach profile and policy metadata to accepted artifacts.
   - Persist the resolved policy in Feishu handoff state.
   - Use generic pending artifact state naming.

4. **Fix cross-plugin staging order**
   - Keep guard preflight at priority 200.
   - Keep Researcher export staging at priority 100.
   - Keep final profile policy at priority 0.
   - Add a real two-plugin integration test for copy, metadata merge, and terminal halt.

5. **Deepen the output-guard modules**
   - Keep `index.js` limited to hook registration and dependency assembly.
   - Move persistent state and confirmation delivery behind a state-store interface.
   - Move staging evaluation, artifact identity, runtime context, and output sanitization into focused deep modules.
   - Add an architecture regression test that prevents orchestration details from returning to the entrypoint.

### Phase 4: Configuration And Documentation

1. Update plugin schema and `openclaw.json` with three explicit auto-delivery profiles.
2. Update researcher delegation guidance to describe summary plus automatic attachment delivery.
3. Keep PPTX guidance aligned with managed parent delivery.

## Testing Strategy

- Core hook aggregation and adapter ownership tests.
- Managed WebChat test: adapter is not called and parent receives one publish instruction.
- Direct WebChat test: adapter is called once and parent is not collected.
- Partial failure test: only unresolved artifacts remain for parent delivery.
- WebChat adapter success and failure tests.
- Feishu adapter success, channel mismatch, missing target, and partial failure tests.
- Output guard profile and delivery-policy tests.
- Real guard plus Researcher stager integration tests asserting `200 → 100 → 0`.
- Output-guard composition-root regression test.
- Existing researcher stager and output guard focused test suites.
- Run repository lint after focused tests and inspect unrelated formatter changes.

## Risks & Mitigations

- **Ambiguous adapter ownership**
  - Stop delivery hook traversal after the first `handled: true` result.
- **Silent partial delivery**
  - Treat every unreported artifact as unresolved.
- **Managed quality-gate regression**
  - Compute channel-delivery permission only after final parent-collection routing is known.
- **Cross-workspace path exposure**
  - Continue using staged requester-relative paths and existing path containment checks.
- **Feishu duplicate sends**
  - Bypass the parent `message` tool for direct automatic delivery and return consumed artifact paths to core.

## Success Criteria

- [x] Managed handoffs invoke no channel delivery hook.
- [x] Direct unmanaged WebChat handoffs publish each artifact once.
- [x] Direct unmanaged Feishu handoffs send attachments and the completion summary.
- [x] Successfully delivered artifacts are absent from parent delivery prompts.
- [x] Failed or unhandled artifacts remain available for parent recovery.
- [x] All three built-in profiles resolve explicitly and default to automatic delivery.
- [x] Staging runs in the real `200 → 100 → 0` plugin order.
- [x] Focused tests and lint pass.
