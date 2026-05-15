import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  DEFAULT_SECURITY_POLICY_RELATIVE_PATH,
  readRuntimeSecurityPolicy,
  resolveRuntimeSecurityPolicyPath,
} from "./security-policy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime security policy", () => {
  it("resolves the policy path under the active state dir", async () => {
    await withStateDirEnv("security-policy-", async ({ stateDir }) => {
      expect(resolveRuntimeSecurityPolicyPath()).toBe(
        path.join(stateDir, DEFAULT_SECURITY_POLICY_RELATIVE_PATH),
      );
    });
  });

  it("returns trimmed policy content when the file exists", async () => {
    await withStateDirEnv("security-policy-", async ({ stateDir }) => {
      const policyPath = path.join(stateDir, DEFAULT_SECURITY_POLICY_RELATIVE_PATH);
      await fs.mkdir(path.dirname(policyPath), { recursive: true });
      await fs.writeFile(policyPath, "  Rule A\nRule B\n", "utf8");

      await expect(readRuntimeSecurityPolicy()).resolves.toBe("Rule A\nRule B");
    });
  });

  it("returns empty string when the policy file is missing", async () => {
    await withStateDirEnv("security-policy-", async () => {
      await expect(readRuntimeSecurityPolicy()).resolves.toBe("");
    });
  });

  it("warns and returns empty string when the default policy path fails to read for non-ENOENT reasons", async () => {
    await withStateDirEnv("security-policy-", async ({ stateDir }) => {
      const policyPath = path.join(stateDir, DEFAULT_SECURITY_POLICY_RELATIVE_PATH);
      await fs.mkdir(path.dirname(policyPath), { recursive: true });
      await fs.mkdir(policyPath, { recursive: true });

      await expect(readRuntimeSecurityPolicy()).resolves.toBe("");
    });
  });

  it("uses agents.defaults.securityPolicyPath when configured", async () => {
    await withStateDirEnv("security-policy-", async ({ tempRoot, stateDir }) => {
      const configuredPolicyPath = path.join(tempRoot, "custom-policy.md");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            securityPolicyPath: configuredPolicyPath,
          },
        },
      };

      await fs.writeFile(configuredPolicyPath, "  Custom Rule\n", "utf8");

      expect(resolveRuntimeSecurityPolicyPath(cfg)).toBe(configuredPolicyPath);
      await expect(readRuntimeSecurityPolicy(cfg)).resolves.toBe("Custom Rule");

      expect(resolveRuntimeSecurityPolicyPath()).toBe(
        path.join(stateDir, DEFAULT_SECURITY_POLICY_RELATIVE_PATH),
      );
    });
  });

  it("resolves relative agents.defaults.securityPolicyPath from the active state dir", async () => {
    await withStateDirEnv("security-policy-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            securityPolicyPath: DEFAULT_SECURITY_POLICY_RELATIVE_PATH,
          },
        },
      };
      const configuredPolicyPath = path.join(stateDir, DEFAULT_SECURITY_POLICY_RELATIVE_PATH);

      await fs.mkdir(path.dirname(configuredPolicyPath), { recursive: true });
      await fs.writeFile(configuredPolicyPath, "  Relative Rule\n", "utf8");

      expect(resolveRuntimeSecurityPolicyPath(cfg)).toBe(configuredPolicyPath);
      await expect(readRuntimeSecurityPolicy(cfg)).resolves.toBe("Relative Rule");
    });
  });

  it("throws when an explicitly configured security policy path cannot be read", async () => {
    await withStateDirEnv("security-policy-", async ({ tempRoot }) => {
      const configuredPolicyPath = path.join(tempRoot, "configured-policy-dir");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            securityPolicyPath: configuredPolicyPath,
          },
        },
      };

      await fs.mkdir(configuredPolicyPath, { recursive: true });

      await expect(readRuntimeSecurityPolicy(cfg)).rejects.toThrow();
    });
  });
});
