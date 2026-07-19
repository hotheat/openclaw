# Implementation Plan: Langfuse Per-Generation Observations

## Overview

Split the agent trace generation lifecycle at each provider stream call. Preserve the agent run as the parent observation while recording tool-call rounds and the final answer as separate generation observations.

## Requirements

- Create one generation observation for each model request.
- Mark the last successful non-tool generation as the final answer.
- Keep model response timing separate from tool execution timing.
- Preserve capture-mode privacy behavior.

## Architecture Changes

- `src/agents/tracing/generations.ts`: wrap the model stream and manage round lifecycle.
- `src/agents/tracing/types.ts`: add round and response classification metadata.
- `src/agents/pi-embedded-runner/run/attempt.ts`: install the per-round stream wrapper.
- `extensions/diagnostics-langfuse/src/`: export round metadata and explicit response end times.

## Implementation Steps

1. Add a stream wrapper that starts a generation before each provider request.
2. End the previous generation at its model response timestamp before the next round starts.
3. Mark the final completed response when the agent prompt settles.
4. Export round input deltas in `llm_text` mode and full context in `full` mode.
5. Add focused runtime and Langfuse exporter tests.

## Testing Strategy

- Unit-test a tool-call round followed by a final-answer round.
- Unit-test provider failure before a stream is returned.
- Verify Langfuse metadata and explicit observation end timestamps.

## Success Criteria

- Each model request appears as a separate Langfuse generation.
- The final answer has `responseKind=final` and `isFinal=true`.
- Tool spans no longer inflate generation duration.
- Existing aggregate agent output and delivery behavior remain unchanged.
