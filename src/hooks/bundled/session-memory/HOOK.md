---
name: session-memory
description: "Append a structured memory summary when /reset is issued"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically appends a structured memory summary to your workspace daily note when you issue `/reset`.

Builtin runtime 也会在旧会话因 daily reset 自动 rollover 时复用同一份 summary helper。
这不是新的 hook event。
它仍受 `session-memory.enabled` 控制。
idle rollover 不会触发这条自动 summary。

## What It Does

When you run `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Generates structured summary** - Uses the configured model to create a grounded structured summary
4. **Saves to memory** - Appends a new block to `<workspace>/memory/YYYY-MM-DD.md` only when the summary has reliable additions
5. **Finishes silently** - The capture is internal housekeeping; it does not send a user-visible confirmation

When builtin runtime rotates a stale session because of **daily reset**:

1. It reuses the same summary helper in the background
2. It writes the same structured summary block shape
3. It does not emit a separate hook event
4. It skips empty summaries without writing a memory file
5. It skips idle-triggered rollover

If every structured section is `无可靠新增项。` and there is no researcher export handoff, no Markdown block is written. The daily rollover still marks the old session as processed so it is not retried.

## Output Format

Memory blocks are appended with the following format:

```markdown
## Daily Structured Summary

- **Generated At**: 2026-01-16 14:30:00 UTC
- **Source**: reset
- **Source Sessions**: abc123def456

### 用户偏好

- ...
```

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

The hook uses your configured model provider to generate summaries, so it works with any configured runtime provider.

## Configuration

The hook supports optional configuration:

| Option     | Type   | Default | Description                                                                |
| ---------- | ------ | ------- | -------------------------------------------------------------------------- |
| `messages` | number | 15      | Number of recent user/assistant messages to consider for summary grounding |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Reuses the same helper for builtin daily rollover summaries
- Falls back to a minimal empty-section block if summary generation fails

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-memory
```

Or remove it from your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
