# Implementation Plan: Assistant Stream Whitespace Flood Guard

## Overview

Add bounded stream processing for assistant text deltas. Pure-whitespace deltas keep their text
semantics but skip full-buffer parsing, while pathological streams are aborted before they can
consume sustained CPU and memory.

## Requirements

- Preserve spaces and newlines between valid text chunks.
- Avoid rescanning the complete assistant buffer for pure-whitespace deltas.
- Abort streams with excessive whitespace, excessive duration, or excessive total output.
- Prevent an aborted whitespace body from being emitted or persisted as normal assistant text.
- Record enough metrics to identify the limit that fired.

## Architecture Changes

- `src/agents/pi-embedded-stream-guard.ts`: own limit evaluation and guard state.
- `src/agents/pi-embedded-subscribe.handlers.message-state.ts`: sanitize aborted completions and
  clear per-message buffers.
- `src/agents/pi-embedded-subscribe.handlers.types.ts`: attach guard state to each subscription.
- `src/agents/pi-embedded-subscribe.ts`: initialize and reset the guard at message boundaries.
- `src/agents/pi-embedded-subscribe.handlers.messages.ts`: apply the guard before buffer parsing and
  sanitize aborted message completion.

## Implementation Steps

### Phase 1: Stream Guard

1. **Add bounded guard state** (File: `src/agents/pi-embedded-stream-guard.ts`)
   - Action: Track total characters, consecutive whitespace characters/events, elapsed whitespace
     time, and the abort reason.
   - Why: Keep policy testable and independent from event-handler side effects.
   - Dependencies: None.
   - Risk: Low.

2. **Attach state to subscriptions** (Files:
   `src/agents/pi-embedded-subscribe.handlers.types.ts`, `src/agents/pi-embedded-subscribe.ts`)
   - Action: Initialize the guard and reset it only when a new assistant message starts.
   - Why: Late end events must not reopen an already aborted message.
   - Dependencies: Step 1.
   - Risk: Low.

### Phase 2: Message Handling

1. **Guard text chunks before parsing** (File:
   `src/agents/pi-embedded-subscribe.handlers.messages.ts`)
   - Action: Abort on limit violations. Append accepted whitespace but skip full-buffer parsing and
     streaming emissions until meaningful text arrives.
   - Why: Removes the repeated full-buffer scan that caused event-loop starvation.
   - Dependencies: Phase 1.
   - Risk: Medium; paragraph streaming can be delayed until the next text chunk.

2. **Sanitize aborted completion** (File:
   `src/agents/pi-embedded-subscribe.handlers.messages.ts`)
   - Action: Convert an aborted assistant message to an error with empty content before normal
     message-end processing.
   - Why: Avoid emitting or persisting the malformed whitespace payload as a valid reply.
   - Dependencies: Previous step.
   - Risk: Low.

### Phase 3: Verification

1. **Add focused tests** (Files:
   `src/agents/pi-embedded-stream-guard.test.ts`,
   `src/agents/pi-embedded-subscribe.handlers.messages.test.ts`)
   - Action: Cover semantic whitespace, each limit, one-shot abort, and message-end sanitization.
   - Why: Protect both the policy and its subscription integration.
   - Dependencies: Phases 1 and 2.
   - Risk: Low.

## Testing Strategy

- Unit tests: guard thresholds, reset behavior, and error metadata.
- Integration tests: whitespace between text chunks, abort callback, and sanitized message end.
- No full build or broad test suite for this scoped change.

## Risks & Mitigations

- **Risk**: Valid generated content contains many whitespace-only chunks.
  - Mitigation: Require 256 consecutive events or 64 KiB before aborting.
- **Risk**: A provider continues emitting after abort.
  - Mitigation: Mark the guard aborted before invoking `abortRun` and ignore later text updates.
- **Risk**: Whitespace completes a paragraph boundary.
  - Mitigation: Preserve it in buffers and flush at `text_end`; otherwise process it with the next
    meaningful chunk.

## Success Criteria

- [x] Whitespace-only deltas do not trigger complete-buffer parsing.
- [x] The known 72,000-line failure is aborted within 257 whitespace events.
- [x] Spaces and newlines between valid chunks remain intact.
- [x] Aborted malformed text is not emitted as a normal assistant response.
- [x] Focused tests pass.
