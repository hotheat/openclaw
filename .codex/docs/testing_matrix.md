# Testing Matrix

## Default Test Layout

- Base Vitest config runs `src/**/*.test.ts`, `extensions/**/*.test.ts`, and `test/**/*.test.ts`, with worker limits and coverage thresholds defined centrally. Refs: `vitest.config.ts:12`, `vitest.config.ts:35`, `vitest.config.ts:53`.
- Coverage intentionally excludes large integration-heavy surfaces such as CLI, gateway, channels, plugins, apps, and UI from the core threshold. Refs: `vitest.config.ts:68`.

## Which Suite To Run

- Core/unit-only changes: `pnpm test:fast` or `vitest run --config vitest.unit.config.ts`. Refs: `package.json:123`, `vitest.unit.config.ts:11`.
- Extension/plugin changes: `vitest run --config vitest.extensions.config.ts`. Refs: `vitest.extensions.config.ts:8`.
- End-to-end flows: `pnpm test:e2e`; this suite is serialized or near-serialized by default for determinism. Refs: `package.json:122`, `vitest.e2e.config.ts:8`, `vitest.e2e.config.ts:24`.
- Live/provider tests: `pnpm test:live`; always single-worker. Refs: `package.json:129`, `vitest.live.config.ts:8`.
- UI-only work: `pnpm test:ui` and `pnpm ui:build`. Refs: `package.json:131`, `package.json:136`, `ui/package.json:5`.

## Build/Check Commands

- Full repo checks: `pnpm check`. Refs: `package.json:57`.
- Main production build: `pnpm build`. Refs: `package.json:54`.
- Native/mobile surfaces use separate commands: Android (`android:*`), iOS (`ios:*`), macOS packaging (`mac:*`). Refs: `package.json:50`, `package.json:86`, `package.json:96`.

## Practical Rule

- Match verification depth to the surface you changed:
  - shared runtime/routing/core infra: run `pnpm test:fast` at minimum
  - plugin or channel package: run the relevant extension tests
  - gateway protocol or cross-surface flow: add `pnpm test:e2e`
  - UI changes: run `pnpm test:ui` and `pnpm ui:build`
- When in doubt, start with the narrow suite that covers your surface, then widen only if shared seams changed.
