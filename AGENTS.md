# OpenClaw

## Project Overview

- Purpose: OpenClaw is a local-first AI gateway that connects CLI, Web UI, desktop/mobile nodes, and messaging channels through one control plane. Refs: `README.md:129`, `README.md:146`, `README.md:207`.
- Core flow: inbound messages are routed to an agent/session, executed through the runtime, then delivered back through channel-specific outbound adapters. Refs: `README.md:131`, `README.md:149`, `src/routing/resolve-route.ts:26`, `src/infra/outbound/deliver.ts:115`.
- Extensibility: most integrations are plugins discovered from bundled/global/workspace/config sources and registered into a shared runtime/registry. Refs: `src/plugins/discovery.ts:16`, `src/plugins/loader.ts:359`, `src/plugins/registry.ts:124`, `src/plugins/types.ts:245`.

## Tech Stack

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.
- Codex-local engineering notes: `.codex/docs/plugin_system.md`, `.codex/docs/architectural_patterns.md`, and `.codex/docs/testing_matrix.md`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).
- Installers served from `https://openclaw.ai/*`: live in the sibling repo `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).
  - Core channel docs: `docs/channels/`
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web` (WhatsApp web), `src/channels`, `src/routing`
  - Extensions (channel plugins): `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)
- When adding channels/extensions/apps/docs, update `.github/labeler.yml` and create matching GitHub labels (use existing channel/extension label colors).

- Core: Node 22+, TypeScript ESM, pnpm workspace. Refs: `package.json:35`, `package.json:223`, `package.json:226`, `pnpm-workspace.yaml:1`.
- CLI + gateway: Commander CLI with lazy command loading; gateway entrypoints live in `src/gateway`; plugin loading uses Jiti. Refs: `src/cli/program/build-program.ts:8`, `src/cli/program/command-registry.ts:40`, `src/gateway/server.ts:1`, `src/plugins/loader.ts:416`.
- Frontend + apps: Lit/Vite Control UI plus Swift macOS companion and native mobile apps. Refs: `ui/package.json:1`, `apps/macos/Package.swift:6`, `package.json:50`, `package.json:86`.
- Tests: Vitest with separate base, unit, extensions, e2e, and live configs. Refs: `vitest.config.ts:12`, `vitest.unit.config.ts:11`, `vitest.extensions.config.ts:8`, `vitest.e2e.config.ts:20`, `vitest.live.config.ts:8`.

## Key Directories

- Current working directory `~/github/openclaw-integration` is the local runtime directory for this environment.
- Local runtime config lives at `~/.openclaw/openclaw.json`; use that path when inspecting or updating the active OpenClaw configuration.
- Docs are hosted on Mintlify (docs.openclaw.ai).
- For plugin, architecture, or test-impact work, read `.codex/docs/plugin_system.md`, `.codex/docs/architectural_patterns.md`, and `.codex/docs/testing_matrix.md` first.
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- When working with documentation, read the mintlify skill.
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.

- `src/cli/`: CLI entrypoints, command tree, gateway/dev utilities. Refs: `src/cli/program/build-program.ts:8`, `src/cli/program/command-registry.ts:40`.
- `src/agents/`: agent runtime, model/provider selection, tools, memory, sandboxing. Refs: `README.md:148`, `src/plugins/runtime/index.ts:239`.
- `src/routing/` + `src/channels/`: session-key construction, agent routing, shared channel rules, channel catalogs. Refs: `src/routing/session-key.ts:19`, `src/routing/resolve-route.ts:26`, `src/channels/registry.ts:5`.
- `src/plugins/`: plugin discovery, manifest parsing, config validation, registry/runtime wiring. Refs: `src/plugins/manifest.ts:7`, `src/plugins/discovery.ts:16`, `src/plugins/loader.ts:359`, `src/plugins/registry.ts:164`.
- `src/infra/` + `src/media/`: outbound delivery, queues, state helpers, temp media serving/storage. Refs: `src/infra/outbound/deliver.ts:226`, `src/media/server.ts:28`.
- `extensions/`: channel/provider/memory/feature plugins, usually one package per integration. Refs: `extensions/slack/index.ts:6`, `extensions/google-gemini-cli-auth/index.ts:19`, `extensions/voice-call/index.ts:143`.
- `ui/`: gateway Control UI and WebChat frontend. Refs: `ui/package.json:1`.
- `apps/`: macOS/iOS/Android clients and shared native code. Refs: `apps/macos/Package.swift:6`.
- `docs/`: Mintlify product docs; use the `.codex/docs/*` files below as the short index before diving deeper.

## Git Workflow

- Do not commit directly on `otr-integration-v2.22`.
- Before committing, check the current branch. If it is `otr-integration-v2.22`, create a new branch first.
- New branch names and commit messages should use conventional prefixes such as `feat:`, `fix:`, `docs:`, or `refactor:`.

## Essential Commands

- Install: `pnpm install`
- Core build: `pnpm build`
- Full checks: `pnpm check`
- Main test suite: `pnpm test`
- Do not proactively run `make test`; it can raise CPU and memory usage. Run it only when the user explicitly asks for it.
- Fast unit slice: `pnpm test:fast`
- Extension tests: `vitest run --config vitest.extensions.config.ts`
- E2E slice: `pnpm test:e2e`
- Live slice: `pnpm test:live`
- Control UI: `pnpm ui:build`, `pnpm test:ui`
- Run CLI/gateway in dev: `pnpm openclaw ...`, `pnpm dev`, `pnpm gateway:dev`
- 需要运行 `openclaw gateway restart` 时，需要用户确认。
- Command sources: `package.json:49`, `ui/package.json:5`

## Additional Documentation

Check these `.codex/docs/*` files first, then follow the repo docs they reference when the task needs more depth:

- `.codex/docs/architectural_patterns.md`: recurring architecture, extension seams, routing/session conventions, and safety boundaries.
- `.codex/docs/plugin_system.md`: plugin package shape, manifest/loader/registry lifecycle, and channel/provider registration patterns.
- `.codex/docs/testing_matrix.md`: which test/build commands map to which surfaces, plus when to run unit vs extension vs e2e/live suites.
