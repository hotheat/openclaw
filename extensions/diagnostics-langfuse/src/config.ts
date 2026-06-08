import type { AgentTraceCaptureMode, OpenClawConfig } from "openclaw/plugin-sdk";

export type ResolvedLangfuseConfig = {
  enabled: true;
  host: string;
  publicKey: string;
  secretKey: string;
  serviceName: string;
  captureMode: AgentTraceCaptureMode;
  flushIntervalMs: number;
  timeoutMs: number;
};

function requiredString(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`diagnostics-langfuse: missing diagnostics.langfuse.${name}`);
  }
  return normalized;
}

export function resolveLangfuseConfig(config: OpenClawConfig): ResolvedLangfuseConfig | null {
  if (config.diagnostics?.enabled === false) {
    return null;
  }
  const raw = config.diagnostics?.langfuse;
  if (raw?.enabled !== true) {
    return null;
  }
  return {
    enabled: true,
    host: requiredString(raw.host, "host"),
    publicKey: requiredString(raw.publicKey, "publicKey"),
    secretKey: requiredString(raw.secretKey, "secretKey"),
    serviceName: raw.serviceName?.trim() || "openclaw-gateway",
    captureMode: raw.captureMode ?? "safe",
    flushIntervalMs: raw.flushIntervalMs ?? 5000,
    timeoutMs: raw.timeoutMs ?? 10000,
  };
}
