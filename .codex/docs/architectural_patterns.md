# Architectural Patterns

## 1. Lazy composition is preferred over eager startup

- CLI commands are registered as placeholders, then the real command module is imported and reparsed on first use. Refs: `src/cli/program/command-registry.ts:241`, `src/cli/program/build-program.ts:8`.
- CLI dependency bundles and plugin runtime surfaces use dynamic imports to avoid paying for heavy channels or optional features until needed. Refs: `src/cli/deps.ts:19`, `src/plugins/runtime/index.ts:160`.
- Plugin loading delays Jiti creation until plugins are actually enabled. Refs: `src/plugins/loader.ts:416`.
- Implication: preserve lazy import boundaries when adding new commands, channels, or plugin runtime helpers.

## 2. Extensibility is registry-driven

- The shared plugin API exposes registration points for tools, hooks, HTTP handlers/routes, channels, gateway methods, CLI, services, providers, and lightweight commands. Refs: `src/plugins/types.ts:245`, `src/plugins/registry.ts:164`.
- Discovery, manifest parsing, config validation, and activation are separate phases. Refs: `src/plugins/discovery.ts:16`, `src/plugins/manifest.ts:44`, `src/plugins/loader.ts:389`.
- Channel and provider plugins follow the same entrypoint shape: export metadata plus `register(api)`. Refs: `extensions/slack/index.ts:6`, `extensions/google-gemini-cli-auth/index.ts:19`.
- Implication: new platform work should plug into the registry instead of wiring bespoke globals.

## 3. Session keys are the cross-channel identity boundary

- Session state is normalized into stable `agent:*` keys with helpers for main, DM, group, and thread variants. Refs: `src/routing/session-key.ts:19`, `src/routing/session-key.ts:105`, `src/routing/session-key.ts:221`.
- Routing resolves the target agent/session from channel, account, peer, guild/team, and roles, with cached binding evaluation. Refs: `src/routing/resolve-route.ts:26`, `src/routing/resolve-route.ts:172`.
- Inbound handlers persist session metadata and last-route state through shared channel/session helpers. Refs: `src/channels/session.ts:17`.
- Implication: when changing channel behavior, keep session-key semantics and route recording consistent across channels.

## 4. Channel-specific behavior stays behind adapters

- Outbound delivery uses a generic pipeline that loads a channel outbound adapter, normalizes payloads, chunks content, and writes through a queue. Refs: `src/infra/outbound/deliver.ts:115`, `src/infra/outbound/deliver.ts:226`.
- Shared channel metadata and ID normalization live in registries/catalogs so common code does not eagerly import heavy channel implementations. Refs: `src/channels/registry.ts:145`, `src/channels/plugins/load.ts:1`, `src/channels/plugins/catalog.ts:121`.
- Implication: prefer adding adapter implementations or registry metadata over channel-specific branches in shared code.

## 5. Schema-first configuration is a hard boundary

- Every plugin must ship `openclaw.plugin.json` with an `id` and `configSchema`. Refs: `src/plugins/manifest.ts:7`, `src/plugins/manifest.ts:44`.
- The loader validates plugin config before registration; invalid or missing schemas keep the plugin disabled/erroring instead of partially loading. Refs: `src/plugins/loader.ts:475`, `src/plugins/loader.ts:500`, `src/plugins/loader.ts:602`.
- Rich plugins parse config again at runtime for typed access. Refs: `extensions/voice-call/index.ts:147`.
- Implication: config changes belong in the manifest/schema path first, then in plugin runtime code.

## 6. Safety checks are pushed to file and plugin boundaries

- Plugin discovery blocks unsafe candidates when paths escape the root, are world-writable, or have suspicious ownership. Refs: `src/plugins/discovery.ts:65`, `src/plugins/discovery.ts:87`, `src/plugins/discovery.ts:177`.
- Media serving uses root-confined file opens, size limits, TTL expiry, and best-effort cleanup after delivery. Refs: `src/media/server.ts:15`, `src/media/server.ts:28`, `src/media/server.ts:64`.
- Implication: new filesystem or plugin-loading code should add validation at the boundary, not after the fact.
