import { resolveAgentDir } from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { parseModelRef, resolveDefaultModelForAgent } from "../../../agents/model-selection.js";
import { discoverAuthStorage, discoverModels } from "../../../agents/pi-model-discovery.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionMemoryHookConfig } from "../../../config/types.hooks.js";
import { resolveHookConfig } from "../../config.js";
import type { SessionMemoryLlmOverrides } from "./types.js";

export function resolveSessionMemoryHookConfig(
  cfg?: OpenClawConfig,
): SessionMemoryHookConfig | undefined {
  const hookConfig = resolveHookConfig(cfg, "session-memory");
  if (!hookConfig) {
    return undefined;
  }
  return hookConfig as SessionMemoryHookConfig;
}

export function resolveSessionMemoryLlmOverrides(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  hookConfig?: SessionMemoryHookConfig;
}): SessionMemoryLlmOverrides {
  const providerRaw = params.hookConfig?.provider?.trim();
  const modelRaw = params.hookConfig?.model?.trim();
  const defaultModelRef =
    params.cfg && params.agentId
      ? resolveDefaultModelForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
        })
      : { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

  if (modelRaw) {
    const parsed = parseModelRef(modelRaw, providerRaw || defaultModelRef.provider);
    if (parsed) {
      return {
        provider: parsed.provider,
        model: parsed.model,
      };
    }
  }

  if (providerRaw) {
    const normalizedProvider = providerRaw;
    if (defaultModelRef.provider === normalizedProvider) {
      return {
        provider: normalizedProvider,
        model: defaultModelRef.model,
      };
    }

    if (params.cfg) {
      try {
        const agentDir = resolveAgentDir(params.cfg, params.agentId);
        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);
        const providerModel = modelRegistry
          .getAll()
          .find((entry) => entry.provider === normalizedProvider)?.id;
        if (providerModel) {
          return {
            provider: normalizedProvider,
            model: providerModel,
          };
        }
      } catch {
        // Ignore provider model discovery failures and fall through.
      }
    }

    return {
      provider: normalizedProvider,
    };
  }

  return {};
}

export function resolveSessionMemoryLlmTimeoutMs(params: {
  hookConfig?: SessionMemoryHookConfig;
  defaultTimeoutMs: number;
}): number {
  const timeoutMs = params.hookConfig?.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return params.defaultTimeoutMs;
  }
  return Math.floor(timeoutMs);
}
