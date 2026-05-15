import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";

export const DEFAULT_SECURITY_POLICY_RELATIVE_PATH = path.join("policy", "SECURITY_POLICY.md");
const log = createSubsystemLogger("agents/security-policy");

function resolveConfiguredSecurityPolicyPath(config?: OpenClawConfig): string | undefined {
  const configured = config?.agents?.defaults?.securityPolicyPath;
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return undefined;
  }
  const trimmed = configured.trim();
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.join(resolveStateDir(), trimmed);
}

export function resolveRuntimeSecurityPolicyPath(config?: OpenClawConfig): string {
  const configured = resolveConfiguredSecurityPolicyPath(config);
  if (configured) {
    return configured;
  }
  return path.join(resolveStateDir(), DEFAULT_SECURITY_POLICY_RELATIVE_PATH);
}

export async function readRuntimeSecurityPolicy(config?: OpenClawConfig): Promise<string> {
  const configuredPath = resolveConfiguredSecurityPolicyPath(config);
  const policyPath = configuredPath ?? resolveRuntimeSecurityPolicyPath(config);
  try {
    const text = await fs.readFile(policyPath, "utf8");
    return typeof text === "string" ? text.trim() : "";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return "";
    }
    if (configuredPath) {
      throw new Error(
        `Failed to read configured runtime security policy at ${policyPath}: ${String(error)}`,
        { cause: error },
      );
    }
    log.warn(`failed to read default runtime security policy at ${policyPath}: ${String(error)}`);
    return "";
  }
}
