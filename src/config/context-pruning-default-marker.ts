/**
 * Marks context-pruning config that was auto-enabled by `applyContextPruningDefaults`
 * (the Anthropic-auth default) so the registration path can tell it apart from an explicit
 * user setting. Auto-enabled cache-ttl is provider-gated to Anthropic-compatible models,
 * while an explicit `mode: "cache-ttl"` stays generic and applies to any provider.
 *
 * Uses a non-enumerable `Symbol.for` key instead of a plain string field deliberately:
 *   - It is a runtime-only provenance flag, not part of the config schema, so it must not be
 *     validated, stripped, or surfaced by the loader.
 *   - It must not be persisted to disk or leak into `JSON.stringify` (the pruning-defaults
 *     test asserts this) — a non-enumerable property is omitted by both JSON and `{...spread}`.
 *   - `Symbol.for` keeps the key stable across module reloads and realms sharing the registry.
 *
 * Caveat: the marker does NOT survive structured-clone or JSON round-trips, so it is only
 * meaningful on the in-process config object handed to the embedded runner. If config ever
 * crosses a process/IPC boundary before registration, this approach needs revisiting.
 */
const CONTEXT_PRUNING_AUTO_ENABLED = Symbol.for("openclaw.contextPruning.autoEnabled");

export type ContextPruningAutoEnabledSource = "anthropic-auth-default";

type MarkedContextPruningConfig = {
  [CONTEXT_PRUNING_AUTO_ENABLED]?: ContextPruningAutoEnabledSource;
};

export function markContextPruningAutoEnabled<T extends object>(
  contextPruning: T,
  source: ContextPruningAutoEnabledSource = "anthropic-auth-default",
): T {
  Object.defineProperty(contextPruning, CONTEXT_PRUNING_AUTO_ENABLED, {
    configurable: true,
    enumerable: false,
    value: source,
  });
  return contextPruning;
}

export function getContextPruningAutoEnabledSource(
  contextPruning: unknown,
): ContextPruningAutoEnabledSource | null {
  if (!contextPruning || typeof contextPruning !== "object") {
    return null;
  }
  const source = (contextPruning as MarkedContextPruningConfig)[CONTEXT_PRUNING_AUTO_ENABLED];
  return source === "anthropic-auth-default" ? source : null;
}

export function isContextPruningAutoEnabled(contextPruning: unknown): boolean {
  return getContextPruningAutoEnabledSource(contextPruning) !== null;
}
