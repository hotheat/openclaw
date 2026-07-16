const warnedLegacyWebchatPaths = new Set<string>();

function warnLegacyWebchatControlUiConfig(configPath: string): void {
  if (warnedLegacyWebchatPaths.has(configPath)) {
    return;
  }
  warnedLegacyWebchatPaths.add(configPath);
  process.emitWarning(
    `${configPath}.webchat is deprecated for Control UI; migrate the value to ${configPath}.control-ui.`,
    {
      type: "DeprecationWarning",
      code: "OPENCLAW_CONTROL_UI_LEGACY_WEBCHAT_CONFIG",
    },
  );
}

export function resolveControlUiConfigValue<T>(params: {
  values: Record<string, T | undefined> | undefined;
  channel: string | undefined;
  configPath: string;
}): T | undefined {
  if (!params.channel || !params.values) {
    return undefined;
  }
  const explicitValue = params.values[params.channel];
  if (explicitValue !== undefined || params.channel !== "control-ui") {
    return explicitValue;
  }
  const legacyValue = params.values.webchat;
  if (legacyValue !== undefined) {
    warnLegacyWebchatControlUiConfig(params.configPath);
  }
  return legacyValue;
}

export function resetControlUiConfigCompatWarningsForTesting(): void {
  warnedLegacyWebchatPaths.clear();
}
