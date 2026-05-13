# Implementation Plan: Switch workspace memory to builtin memory-core

## Overview

Replace any legacy Lance/LanceDB-Pro memory ownership with the bundled `memory-core` memory slot and rely on the built-in `memory_search` and `memory_get` tools for recall. Keep `MEMORY.md` and `memory/YYYY-MM-DD.md` as the canonical, auditable file layer, and tighten workspace instructions so agents prefer memory tools over ad hoc file reads.

## Requirements

- Use bundled `memory-core` as the active memory plugin.
- Ensure `memory_search` and `memory_get` are available and preferred in prompts.
- Preserve the canonical memory file contract: `MEMORY.md` + `memory/YYYY-MM-DD.md`.
- Remove stale references to external Lance/LanceDB-Pro ownership where they still affect config or operator expectations.
- Keep security boundaries: no cross-workspace recall or generic file-read behavior through memory tools.

## Architecture Changes

- `~/.openclaw/openclaw.json`: confirm `plugins.entries.memory-core.enabled = true` and no explicit `plugins.slots.memory = "memory-lancedb-pro"` override remains.
- `~/.openclaw/workspace/AGENTS.md`: align human-written workspace guidance with the built-in memory contract and tool usage.
- Optional cleanup of old external memory plugin install paths/config if they are no longer used operationally.
- Validation through `openclaw memory status`, `openclaw memory index`, and a live memory recall smoke test.

## Implementation Steps

### Phase 1: Confirm active ownership

1. **Audit active memory config** (File: `~/.openclaw/openclaw.json`)
   - Action: Verify the active config uses bundled `memory-core` and does not pin `plugins.slots.memory` to an external Lance-based plugin.
   - Why: Avoid chasing an already-completed migration or leaving a hidden override in place.
   - Dependencies: None
   - Risk: Low

2. **Inventory stale legacy config** (Files: `~/.openclaw/openclaw.json.clobbered.*`, optional legacy plugin dirs)
   - Action: Check whether old `memory-lancedb-pro` / Lance-era config exists only in backups or still affects runtime.
   - Why: Distinguish real runtime state from historical artifacts.
   - Dependencies: Step 1
   - Risk: Low

### Phase 2: Align runtime behavior

3. **Validate memory-core health** (CLI: `openclaw memory status --deep --json`)
   - Action: Confirm backend, embedding provider, index status, and any failure mode.
   - Why: The migration is incomplete if memory-core is enabled but unhealthy.
   - Dependencies: Step 1
   - Risk: Medium

4. **Rebuild index if needed** (CLI: `openclaw memory index --force`)
   - Action: Reindex after config changes or provider changes.
   - Why: Search quality and tool reliability depend on current index state.
   - Dependencies: Step 3
   - Risk: Low

5. **Run recall smoke test** (CLI/tool flow)
   - Action: Put a canary fact in `MEMORY.md` or a dated daily note, then verify `memory_search` finds it and `memory_get` reads the exact lines.
   - Why: Confirms the end-to-end operator experience, not just config shape.
   - Dependencies: Step 4
   - Risk: Low

### Phase 3: Tighten workspace instructions

6. **Update workspace AGENTS memory guidance** (File: `~/.openclaw/workspace/AGENTS.md`)
   - Action: Keep a short memory section that says:
     - `MEMORY.md` is durable curated memory.
     - `memory/YYYY-MM-DD.md` is daily working memory.
     - Prefer `memory_search` / `memory_get` for recall during normal conversation.
     - Do not manually reread startup files unless needed.
   - Why: The agent should follow the runtime contract rather than legacy manual file-scanning habits.
   - Dependencies: Step 1
   - Risk: Low

7. **Remove Lance-specific prompt assumptions** (File: `~/.openclaw/workspace/AGENTS.md`, any workspace docs/prompts if present)
   - Action: Delete wording that assumes Lance-specific tools, indexes, storage paths, or troubleshooting.
   - Why: Prevent operator confusion and conflicting instructions.
   - Dependencies: Step 6
   - Risk: Low

### Phase 4: Optional cleanup and tuning

8. **Decide whether to keep dreaming** (File: `~/.openclaw/openclaw.json`)
   - Action: Keep or disable `plugins.entries.memory-core.config.dreaming.enabled` based on desired auto-promotion behavior.
   - Why: Dreaming is orthogonal to the migration but changes how durable memory evolves.
   - Dependencies: Step 3
   - Risk: Medium

9. **Retire unused external plugin assets** (Optional file/system cleanup)
   - Action: Remove old external memory plugin paths only after confirming no runtime references remain.
   - Why: Reduce ambiguity and future maintenance cost.
   - Dependencies: Steps 2-5
   - Risk: Medium

## Testing Strategy

- Config validation: `openclaw memory status --deep --json`
- Index validation: `openclaw memory index --force`
- CLI search validation: `openclaw memory search "canary fact"`
- Tool-path validation: ask a session to answer a memory-only fact and confirm it uses `memory_search` then `memory_get`
- Regression check: verify startup context still injects the expected daily notes and `MEMORY.md` behavior for main sessions

## Risks & Mitigations

- **Risk**: Config already uses `memory-core`, but operators still think Lance owns memory.
  - Mitigation: Treat this as a cleanup/alignment task, not a backend migration.

- **Risk**: Embedding provider is configured but unhealthy, making memory recall look broken.
  - Mitigation: Validate with `memory status --deep`, then fix provider/auth/index before changing prompts.

- **Risk**: Overly long workspace prompts duplicate built-in memory guidance and create prompt clutter.
  - Mitigation: Keep AGENTS memory instructions short and complementary to runtime/tool descriptions.

- **Risk**: Old external plugin artifacts are deleted too early.
  - Mitigation: Remove them only after the active config and smoke tests confirm they are unused.

## Success Criteria

- [ ] Active runtime uses bundled `memory-core`, not an external Lance-owned memory slot.
- [ ] `memory_search` and `memory_get` are available and work on real memory files.
- [ ] `MEMORY.md` and `memory/YYYY-MM-DD.md` remain the canonical explicit memory layer.
- [ ] Workspace `AGENTS.md` instructs the agent to prefer memory tools for recall.
- [ ] No user-facing docs/prompts still imply Lance-specific memory ownership.
