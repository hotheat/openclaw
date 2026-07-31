# Implementation Plan: PPTX Warning Delivery

> Superseded by
> `docs/plans/2026-07-29-generic-subagent-handoff-quality-gate.md`.
> 本文中的 public Plugin API parser 路线已放弃，不作为实施或验收依据。

## Overview

Keep the subagent handoff wire format and quality-gate state machine generic in OpenClaw core. A producer opts into the quality gate by declaring either `verification` or `delivery`; handoffs with neither field remain unmanaged for legacy staging flows. Deployment extensions reuse the core analyzer and apply local path, filename, channel, and wording policies.

## Requirements

- Preserve `verification.status` as `passed | failed`.
- Add `delivery.status` as `ready | warning | blocked`.
- Treat handoffs with neither `verification` nor `delivery` as unmanaged and exclude them from core parent auto-delivery.
- Treat legacy `verification.status=passed` with no delivery field as `ready`.
- Treat failed or unknown verification with no delivery field as `blocked`.
- Allow `verification.status=failed` only when `delivery.status=warning`.
- Include the verification summary in the parent delivery prompt and user-facing warning path.
- Keep researcher exports without verification metadata compatible.
- Keep one parser and one quality-state normalizer in core; extensions consume the normalized result through `OpenClawPluginApi`.

## Architecture Changes

- `src/agents/subagent-handoff.ts`: parse the generic `artifacts/` handoff envelope, strip trailer metadata, and normalize managed versus unmanaged delivery status.
- `src/agents/subagent-announce.ts`: route all deliverable artifacts, including warning deliveries, through the requester agent.
- `src/agents/subagent-announce-queue.ts`: render delivery status and verification details and require a user-facing warning.
- `src/plugins/types.ts` and `src/plugins/registry.ts`: expose the shared handoff analyzer to plugins.
- `openclaw-workspace/extensions/subagent-handoff-output-guard`: consume the shared analyzer, apply deployment-specific PPTX/researcher path policy, and persist warning metadata.
- Shared workspace rules and PPTX skills: distinguish ready, warning, and blocked handoffs.

## Implementation Steps

### Phase 1: Core Protocol

1. **Extend handoff artifact metadata** (`src/agents/subagent-handoff.ts`)
   - Action: add normalized delivery status, verification summary, shared trailer analysis, and unmanaged quality-gate state.
   - Why: verification result and delivery permission have different meanings.
   - Dependencies: None.
   - Risk: Medium; defaults must preserve existing passed handoffs.

2. **Route warning artifacts** (`src/agents/subagent-announce.ts`)
   - Action: replace passed-only filtering with a deliverable-artifact predicate.
   - Why: failed-but-renderable decks must reach the requester agent.
   - Dependencies: Step 1.
   - Risk: High; blocked and unknown artifacts must remain excluded.

3. **Expose warning context** (`src/agents/subagent-announce-queue.ts`)
   - Action: include delivery status and verification summary in artifact blocks and delivery instructions.
   - Why: the requester must notify the user when sending a warning artifact.
   - Dependencies: Steps 1-2.
   - Risk: Medium; prompt metadata limits still apply.

### Phase 2: Workspace Protocol

4. **Update output guard**
   - Action: remove its private wire parser and status matrix, consume `api.analyzeSubagentHandoff`, reject unmanaged PPTX, preserve unmanaged researcher exports, and persist warning metadata.
   - Why: Feishu pending delivery must retain the warning after the completion turn.
   - Dependencies: Phase 1 protocol.
   - Risk: Medium; researcher exports without verification must remain valid.

5. **Update PPTX skills and spawn prompts**
   - Action: emit ready handoffs after successful verification, warning handoffs for renderable failures, and blocked inline handoffs for unusable outputs.
   - Why: producers must classify the artifact explicitly.
   - Dependencies: Phase 1 protocol.
   - Risk: Low.

## Testing Strategy

- Parser tests for ready, warning, blocked, missing, and contradictory status combinations.
- Parser tests for generic `artifacts/` paths, unmanaged handoffs, trailer stripping, and inline mode.
- Parent announce tests for warning delivery on Feishu/external channels and WebChat.
- Queue tests for warning details and blocked artifact exclusion.
- Guard tests for ready, warning, blocked, missing verification, and legacy researcher exports.

## Risks & Mitigations

- **Failed output bypasses the block**: normalize contradictory `failed + ready` to blocked.
- **Warning details are lost before a later send**: persist verification summary in pending state.
- **Researcher delivery regresses**: apply strict delivery status rules only to PPTX exports.
- **Parser implementations drift**: expose the core analyzer through the plugin API and remove extension-side JSON parsing and normalization.
- **Ungated files enter parent auto-delivery**: mark unmanaged artifacts explicitly and keep the core deliverable predicate limited to ready and warning.
- **Prompt truncation hides the warning**: keep structured warning metadata in the artifact block independently of completion text.

## Success Criteria

- [ ] Passed PPTX files continue to deliver normally.
- [ ] Failed but renderable PPTX files deliver with visible verification details.
- [ ] Blocked, unknown, or contradictory PPTX handoffs do not enter delivery.
- [ ] Researcher exports without verification metadata continue to work.
- [ ] Core contains no PPTX-specific path or filename predicate.
- [ ] Workspace extension uses the core parser and quality-state normalization.
- [ ] Focused core and workspace tests pass.
