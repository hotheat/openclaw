# Plugin System

## Package Shape

- Most integrations live under `extensions/<id>/` as workspace packages. The common shape is `index.ts` + `openclaw.plugin.json` + `package.json`. Refs: `pnpm-workspace.yaml:1`, `extensions/slack/index.ts:1`, `src/plugins/manifest.ts:7`.
- `openclaw.plugin.json` is the activation contract; package metadata carries onboarding/catalog extras such as channel labels and install hints. Refs: `src/plugins/manifest.ts:10`, `src/plugins/manifest.ts:102`, `src/channels/plugins/catalog.ts:171`.

## Loader Lifecycle

- Discovery scans bundled/global/workspace/config sources and rejects unsafe candidates early. Refs: `src/plugins/discovery.ts:16`, `src/plugins/discovery.ts:177`.
- `loadOpenClawPlugins()` applies config defaults, discovers candidates, loads manifests, validates config, resolves precedence, and only then calls `register(api)`. Refs: `src/plugins/loader.ts:359`, `src/plugins/loader.ts:389`, `src/plugins/loader.ts:475`, `src/plugins/loader.ts:602`, `src/plugins/loader.ts:644`.
- Precedence is origin-aware, so duplicate plugin IDs are overridden instead of merged. Refs: `src/channels/plugins/catalog.ts:41`, `src/plugins/loader.ts:445`.

## Registration Surfaces

- Channel plugin example: `slack` sets runtime state and registers one channel plugin. Refs: `extensions/slack/index.ts:11`.
- Provider plugin example: `google-gemini-cli-auth` registers a model auth/provider surface. Refs: `extensions/google-gemini-cli-auth/index.ts:24`.
- Rich feature plugin example: `voice-call` parses typed config, lazily creates runtime state, and adds gateway methods. Refs: `extensions/voice-call/index.ts:147`, `extensions/voice-call/index.ts:166`, `extensions/voice-call/index.ts:192`.
- Full registration API surface lives in one place. Refs: `src/plugins/types.ts:245`, `src/plugins/registry.ts:172`.

## Conventions To Preserve

- Keep shared code on registry loaders and normalized IDs instead of importing plugin implementations directly. Refs: `src/channels/registry.ts:151`, `src/channels/plugins/load.ts:4`.
- Put plugin-specific runtime dependencies and behavior inside the extension package; core should only depend on the shared plugin API and runtime contracts. Refs: `extensions/slack/index.ts:1`, `src/plugins/types.ts:245`.
- When adding a new plugin, update both manifest/schema and registration code; either half on its own is incomplete. Refs: `src/plugins/manifest.ts:44`, `src/plugins/loader.ts:629`.
