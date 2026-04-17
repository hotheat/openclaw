# OpenClaw

## Project Overview

- Purpose: OpenClaw is a local-first AI gateway that connects CLI, Web UI, desktop/mobile nodes, and messaging channels through one control plane. Refs: `README.md:129`, `README.md:146`, `README.md:207`.
- Core flow: inbound messages are routed to an agent/session, executed through the runtime, then delivered back through channel-specific outbound adapters. Refs: `README.md:131`, `README.md:149`, `src/routing/resolve-route.ts:26`, `src/infra/outbound/deliver.ts:115`.
- Extensibility: most integrations are plugins discovered from bundled/global/workspace/config sources and registered into a shared runtime/registry. Refs: `src/plugins/discovery.ts:16`, `src/plugins/loader.ts:359`, `src/plugins/registry.ts:124`, `src/plugins/types.ts:245`.

## Tech Stack

- Core: Node 22+, TypeScript ESM, pnpm workspace. Refs: `package.json:35`, `package.json:223`, `package.json:226`, `pnpm-workspace.yaml:1`.
- CLI + gateway: Commander CLI with lazy command loading; gateway entrypoints live in `src/gateway`; plugin loading uses Jiti. Refs: `src/cli/program/build-program.ts:8`, `src/cli/program/command-registry.ts:40`, `src/gateway/server.ts:1`, `src/plugins/loader.ts:416`.
- Frontend + apps: Lit/Vite Control UI plus Swift macOS companion and native mobile apps. Refs: `ui/package.json:1`, `apps/macos/Package.swift:6`, `package.json:50`, `package.json:86`.
- Tests: Vitest with separate base, unit, extensions, e2e, and live configs. Refs: `vitest.config.ts:12`, `vitest.unit.config.ts:11`, `vitest.extensions.config.ts:8`, `vitest.e2e.config.ts:20`, `vitest.live.config.ts:8`.

## Key Directories

- `src/cli/`: CLI entrypoints, command tree, gateway/dev utilities. Refs: `src/cli/program/build-program.ts:8`, `src/cli/program/command-registry.ts:40`.
- `src/agents/`: agent runtime, model/provider selection, tools, memory, sandboxing. Refs: `README.md:148`, `src/plugins/runtime/index.ts:239`.
- `src/routing/` + `src/channels/`: session-key construction, agent routing, shared channel rules, channel catalogs. Refs: `src/routing/session-key.ts:19`, `src/routing/resolve-route.ts:26`, `src/channels/registry.ts:5`.
- `src/plugins/`: plugin discovery, manifest parsing, config validation, registry/runtime wiring. Refs: `src/plugins/manifest.ts:7`, `src/plugins/discovery.ts:16`, `src/plugins/loader.ts:359`, `src/plugins/registry.ts:164`.
- `src/infra/` + `src/media/`: outbound delivery, queues, state helpers, temp media serving/storage. Refs: `src/infra/outbound/deliver.ts:226`, `src/media/server.ts:28`.
- `extensions/`: channel/provider/memory/feature plugins, usually one package per integration. Refs: `extensions/slack/index.ts:6`, `extensions/google-gemini-cli-auth/index.ts:19`, `extensions/voice-call/index.ts:143`.
- `ui/`: gateway Control UI and WebChat frontend. Refs: `ui/package.json:1`.
- `apps/`: macOS/iOS/Android clients and shared native code. Refs: `apps/macos/Package.swift:6`.
- `docs/`: Mintlify product docs; use the `.codex/docs/*` files below as the short index before diving deeper.

## Essential Commands

- Install: `pnpm install`
- Core build: `pnpm build`
- Full checks: `pnpm check`
- Main test suite: `pnpm test`
- Fast unit slice: `pnpm test:fast`
- Extension tests: `vitest run --config vitest.extensions.config.ts`
- E2E slice: `pnpm test:e2e`
- Live slice: `pnpm test:live`
- Control UI: `pnpm ui:build`, `pnpm test:ui`
- Run CLI/gateway in dev: `pnpm openclaw ...`, `pnpm dev`, `pnpm gateway:dev`
- Command sources: `package.json:49`, `ui/package.json:5`

## Additional Documentation

Check these `.codex/docs/*` files first, then follow the repo docs they reference when the task needs more depth:

- `.codex/docs/architectural_patterns.md`: recurring architecture, extension seams, routing/session conventions, and safety boundaries.
- `.codex/docs/plugin_system.md`: plugin package shape, manifest/loader/registry lifecycle, and channel/provider registration patterns.
- `.codex/docs/testing_matrix.md`: which test/build commands map to which surfaces, plus when to run unit vs extension vs e2e/live suites.
