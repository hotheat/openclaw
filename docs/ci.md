---
title: CI Pipeline
description: How the OpenClaw integration CI pipeline works
summary: "Current CI jobs, execution order, and local command equivalents"
read_when:
  - You are debugging GitHub Actions failures
  - You want the local command that matches a CI step
  - You are changing test scope or CI structure
---

# CI Pipeline

The repository currently uses two GitHub Actions workflows for pull requests:

- `CI`: build and validate code with the shared Makefile entrypoints
- `Codex Review`: run the automated review pass for pull requests

## Workflow order

For a normal pull request, the expected check sequence is:

1. `lint`
2. `codex_review`
3. `build`
4. `test`

`codex_review` is a separate workflow, so it can run in parallel with the `CI` workflow. Inside the `CI` workflow, `test` waits for both `lint` and `build`.

## CI jobs

| Workflow       | Job            | Purpose                                                 | Command          |
| -------------- | -------------- | ------------------------------------------------------- | ---------------- |
| `CI`           | `lint`         | format, type, and lint validation                       | `make lint`      |
| `CI`           | `build`        | runtime build, smoke import, and Control UI build       | `make build`     |
| `CI`           | `test`         | fast core regression lane kept under the PR time budget | `make test`      |
| `Codex Review` | `codex_review` | automated PR review                                     | workflow-managed |

## Local equivalents

Run the same commands locally when you want parity with CI:

```bash
make lint
make build
make test
```

The Makefile targets map to:

```bash
make lint   # pnpm check
make build  # pnpm build && pnpm smoke:build && pnpm ui:build
make test   # pnpm test
```

## Test scope

The default CI `test` job intentionally runs the fast core lane only.

- Default command: `pnpm test`
- Config: `vitest.unit.config.ts`
- Goal: keep PR validation fast while preserving strong coverage on routing, config, tooling, agent/runtime, and other core logic

When you need a broader local regression pass, use `pnpm test:full`.
