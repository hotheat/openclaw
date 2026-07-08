---
title: "Tool-loop detection"
description: "Configure optional guardrails for preventing repetitive or stalled tool-call loops"
summary: "How to enable and tune guardrails that detect repetitive tool-call loops"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to tune repetitive-call protection
  - You are editing agent tool/runtime policies
---

# Tool-loop detection

OpenClaw can keep agents from getting stuck in repeated tool-call patterns.
Repeated schema validation failures are guarded by default.
General repetitive-call detectors are opt-in with `tools.loopDetection.enabled: true`.

Disable the schema guard only where needed, because schema validation failures are deterministic and usually cannot recover by retrying the same call shape.

## Why this exists

- Detect repetitive sequences that do not make progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated errors).
- Detect specific repeated-call patterns for known polling tools.

## Configuration block

Global defaults:

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      schemaValidationWarningThreshold: 3,
      schemaValidationCriticalThreshold: 5,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
        schemaValidationError: true,
      },
    },
  },
}
```

Per-agent override (optional):

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### Field behavior

- `enabled`: enables general before-tool-call loop detection. It does not disable the schema validation safety net.
- `historySize`: number of recent tool calls kept for analysis.
- `warningThreshold`: minimum repeats before warning starts for general patterns.
- `criticalThreshold`: stronger threshold that can block no-progress patterns.
- `globalCircuitBreakerThreshold`: hard stop for any repeated no-progress outcome.
- `schemaValidationWarningThreshold`: repeated schema validation failures before warning.
- `schemaValidationCriticalThreshold`: repeated schema validation failures before blocking. Missing-required-field schema errors inject a repair warning after 3 matching failures and abort after the 4th matching failure. Cross-tool schema failures abort after 5 consecutive failures.
- `detectors.genericRepeat`: detects repeated same-tool/same-args calls.
- `detectors.knownPollNoProgress`: detects known polling-like loops with unchanged output.
- `detectors.pingPong`: detects alternating no-progress pair patterns.
- `detectors.schemaValidationError`: detects repeated tool schema validation failures.

## Recommended setup

- Keep defaults unchanged for schema validation protection.
- Set `enabled: true` only when you want generic repeat, poll, and ping-pong loop checks.
- If false positives occur:
  - raise `warningThreshold`, `criticalThreshold`, or schema validation thresholds
  - disable only the detector causing issues
  - reduce `historySize` for less strict historical context

## Logs and expected behavior

When a loop is detected, OpenClaw reports a loop event and blocks or dampens the next tool-cycle depending on severity.
This protects users from runaway token spend and lockups while preserving normal tool access.

- Prefer warning and temporary suppression first.
- Escalate only when repeated evidence accumulates.

## Notes

- `tools.loopDetection` is merged with agent-level overrides.
- Per-agent config fully overrides or extends global values.
- If no config exists, schema validation loop protection is still active.
