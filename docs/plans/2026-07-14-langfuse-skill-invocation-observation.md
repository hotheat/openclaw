# Implementation Plan: Langfuse Skill Invocation Observation

## Overview

Distinguish skill discovery from actual skill invocation in Langfuse traces.
Keep `openclaw.skills.resolve` as the stable discovery span, and label the tool
observation that reads a prompt-loaded `SKILL.md` as `openclaw.skill.<name>`.

## Requirements

- Do not list all registered or prompt-loaded skills in the resolve node name.
- Mark a skill only when the agent actually reads that skill's `SKILL.md`.
- Use the canonical skill name rather than deriving it only from a directory name.
- Leave ordinary file reads as `openclaw.tool.read`.
- Preserve the original tool name, parameters, result, and timing metadata.

## Architecture Changes

- `src/agents/pi-embedded-runner/run/attempt.ts`: pass prompt-loaded skill file
  names and paths into the tool tracing wrapper.
- `src/agents/tracing/tools.ts`: match read tool paths against the prompt skill
  file table and attach `skillName` to the tool trace start event.
- `src/agents/tracing/types.ts`: add optional `skillName` to the tool trace event.
- `extensions/diagnostics-langfuse/src/service.ts`: render matched skill calls as
  `openclaw.skill.<name>`.
- `extensions/diagnostics-langfuse/src/capture.ts`: retain `skillName` in tool
  observation metadata.

## Implementation Steps

### Phase 1: Invocation Detection

1. **Build the prompt skill file table**
   - File: `src/agents/pi-embedded-runner/run/attempt.ts`
   - Action: Select skills with `includedInPrompt: true` and retain their canonical
     name and `SKILL.md` path.
   - Why: A resolved but truncated or hidden skill must not be marked as invoked.
   - Risk: Low.

2. **Match read calls to skill files**
   - File: `src/agents/tracing/tools.ts`
   - Action: Normalize `path` and `file_path`, resolve relative and home-prefixed
     paths, and compare them with the prompt skill file table.
   - Why: The model invokes a normal skill by reading its `SKILL.md`.
   - Risk: Medium because path forms differ between workspace and sandbox modes.
   - Mitigation: Use the effective run workspace and the exact skill file paths
     used to build the prompt.

### Phase 2: Langfuse Rendering

1. **Extend the trace event**
   - File: `src/agents/tracing/types.ts`
   - Action: Add optional `skillName` to `AgentTraceToolStartEvent`.
   - Why: Trace sinks need the canonical skill identity without parsing file paths.
   - Risk: Low because the field is optional.

2. **Name the invocation observation**
   - Files: `extensions/diagnostics-langfuse/src/service.ts`,
     `extensions/diagnostics-langfuse/src/capture.ts`
   - Action: Use `openclaw.skill.<name>` when `skillName` is present and retain it
     in metadata; otherwise keep the existing tool observation name.
   - Why: The trace tree should show only the skill actually invoked.
   - Risk: Low.

### Phase 3: Verification

1. **Add tracing tests**
   - File: `src/agents/tracing/tools.test.ts`
   - Action: Verify `SKILL.md` reads receive `skillName` and ordinary reads do not.

2. **Add Langfuse tests**
   - Files: `extensions/diagnostics-langfuse/src/service.test.ts`,
     `extensions/diagnostics-langfuse/src/capture.test.ts`
   - Action: Verify observation naming and metadata.

## Testing Strategy

- Core unit test: `src/agents/tracing/tools.test.ts`.
- Extension unit tests: `extensions/diagnostics-langfuse/src/service.test.ts` and
  `extensions/diagnostics-langfuse/src/capture.test.ts`.
- Regression: confirm `openclaw.skills.resolve` remains unchanged.
- Runtime verification: trigger one skill and inspect a new Langfuse trace for an
  `openclaw.skill.<name>` tool observation.

## Risks & Mitigations

- **A normal file named `SKILL.md` is misclassified**
  - Mitigation: require an exact match against the prompt skill file table.
- **A prompt skill is never used**
  - Mitigation: no invocation observation is emitted until its file is read.
- **A skill is read through `file_path` instead of `path`**
  - Mitigation: support both aliases before tool parameter normalization.

## Success Criteria

- [x] `openclaw.skills.resolve` remains a stable discovery node.
- [x] Reading one prompt skill creates `openclaw.skill.<that-skill-name>`.
- [x] Unused registered skills do not appear as invocation nodes.
- [x] Ordinary read calls remain `openclaw.tool.read`.
