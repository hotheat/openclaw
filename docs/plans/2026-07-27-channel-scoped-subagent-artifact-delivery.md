# Implementation Plan: Channel-Scoped Subagent Artifact Delivery

## Overview

Keep researcher completion text on runtime direct delivery while routing same-agent PPTX artifacts through the requester agent. Remove the unused `artifact_jobs` tool and enforce a channel-specific tool matrix.

## Requirements

- Researcher final text uses `completionDelivery="direct"` and is not rewritten by the requester agent.
- PPTX generator and restyle use `completionDelivery="parent"`.
- PPTX subagents generate and verify files, then emit terminal `SUBAGENT_HANDOFF` metadata for `artifacts/pptx-generator/*/final.pptx` or `artifacts/pptx-restyle/*/final.pptx`.
- WebChat requester sessions expose `webui_artifact_publish` and omit `message`.
- Feishu requester sessions expose `message` and omit `webui_artifact_publish`.
- Core leaves user-facing delivery tools enabled by default.
- The current deployment explicitly denies `message` and `webui_artifact_publish` for subagents through `tools.subagents.tools.deny`.
- Remove `artifact_jobs` implementation, policy, catalog, Schema, tests, and runtime configuration.

## Delivery Chain

```text
researcher
  -> SUBAGENT_HANDOFF staging
  -> optional WebChat artifact publication
  -> sanitized direct completion

same-agent PPTX child
  -> generate and verify final.pptx
  -> terminal SUBAGENT_HANDOFF with passed verification status
  -> parent completion queue preserves structured artifact metadata
  -> WebChat parent turn runs on its original surface with deliver=false
  -> requester agent uses its channel-specific delivery tool
```

## Architecture Changes

- `src/agents/subagent-handoff.ts`: accept only terminal, workspace-relative final PPTX metadata under approved artifact roots.
- `src/agents/subagent-announce.ts`: attach only passed same-agent parent artifacts, strip transport metadata, and bind WebChat parent turns to their original surface without external delivery fallback.
- `src/agents/subagent-announce-queue.ts`: preserve artifact metadata independently of completion text truncation while enforcing aggregate count and character limits.
- `src/agents/openclaw-tools.ts`: omit `message` in WebChat contexts.
- `src/agents/pi-tools.policy.ts`: retain only intrinsic subagent restrictions; deployment-specific delivery restrictions stay in configuration.
- `extensions/webui-artifacts/index.ts`: retain parent-WebChat-only registration.
- `openclaw.json`: explicitly deny `message` and `webui_artifact_publish` for subagents.
- Tool catalog, policy, config types, and Zod Schema: remove `artifact_jobs`.
- Shared workspace rules and PPTX skills: move delivery ownership to the requester agent.

## Testing Strategy

- Handoff parser path and verification normalization tests.
- Parent completion queue truncation tests.
- Feishu and WebChat parent delivery instruction tests.
- WebChat `message` omission tests.
- Subagent default-enabled and explicit delivery-tool deny tests.
- Existing WebUI artifact registration and delivery tests.

## Success Criteria

- Researcher direct completion does not invoke the requester model.
- Verified PPTX paths remain visible to the requester even when child text is truncated.
- Failed, unknown, out-of-root, non-final, or non-terminal handoffs are not presented as deliverable.
- WebChat parent completion cannot fall back to an unrelated external delivery channel.
- WebChat sessions cannot call `message`.
- Feishu sessions cannot load `webui_artifact_publish`.
- Current deployment subagents cannot call `message` or `webui_artifact_publish`.
- No runtime or current workspace configuration references `artifact_jobs`.
