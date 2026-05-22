---
name: session-memory
description: "Append a structured memory summary during builtin daily rollover"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically appends a structured memory summary to your workspace daily note
during builtin daily rollover, and then promotes durable facts into `MEMORY.md`.

Builtin runtime 也会在会话跨过 daily memory 边界时复用同一份 summary helper。
这不是新的 hook event。
它仍受 `session-memory.enabled` 控制。
daily summary 不会自行 reset 或归档会话。

## What It Does

When builtin runtime crosses the daily memory boundary:

1. **Finds the ended session** - Uses the ended session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Generates structured summary** - Uses the configured model to create a grounded structured summary
4. **Saves to memory** - Appends a new block to `<workspace>/memory/YYYY-MM-DD.md`
5. **Updates long-term memory** - Generates a structured JSON patch and applies it to `<workspace>/MEMORY.md` as Markdown sections
6. **Finishes silently** - The capture runs in the background and does not send a user-visible confirmation

## Output Format

Memory blocks are appended with the following format:

```markdown
## Daily Structured Summary

- **Generated At**: 2026-01-16 14:30:00 UTC
- **Source**: new
- **Source Sessions**: abc123def456

### 当前主问题 / 当天主线

- ...

### 主要任务推进

- ...

### 负向反馈 / 失败信号

- ...

### 改进方向

- ...

### 正向进展 / 已验证有效

- ...

### 用户偏好

- ...
```

推荐把 daily note 视为“任务态优先”的日级工作记忆：

- 先写当天主线、任务推进、正负反馈和改进方向
- 再写偏好、决策、风险、未完成事项等更适合复用的记忆

Long-term memory is stored in `MEMORY.md` as Markdown, not as raw JSON. The
model emits a JSON patch internally, and the runtime applies it to stable
sections such as user context, history, and durable facts.

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

The hook uses your configured model provider to generate summaries, so it works with any configured runtime provider.

## Configuration

The hook supports optional configuration:

| Option      | Type   | Default | Description                                                                                                                        |
| ----------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `messages`  | number | 15      | Number of recent user/assistant messages to consider for summary grounding                                                         |
| `provider`  | string | unset   | Optional provider override for session-memory LLM runs; when set alone, runtime tries to pick a registered model for that provider |
| `model`     | string | unset   | Optional model override for session-memory LLM runs; accepts `provider/model` or an alias and is the most deterministic option     |
| `timeoutMs` | number | 30000   | Timeout in milliseconds for each session-memory LLM run                                                                            |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "provider": "openai",
          "model": "gpt-4.1-mini",
          "timeoutMs": 60000
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Reuses the same helper for builtin daily memory summaries without requiring a session reset
- Applies long-term memory updates to `MEMORY.md` using a structured patch workflow
- Uses the same hook-level provider/model override for summary generation, long-term patch generation, and same-category fact consolidation when configured
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
