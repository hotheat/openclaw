import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    const memorySearch = resolveMemorySearchConfig(params.cfg, agentId);
    if (!memorySearch) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    const shouldArmQmd = resolved.backend === "qmd" && Boolean(resolved.qmd);
    const shouldArmBuiltin =
      resolved.backend === "builtin" &&
      (memorySearch.store.driver === "sqlite" || memorySearch.store.driver === "postgres");

    if (!shouldArmQmd && !shouldArmBuiltin) {
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      const backendLabel = shouldArmQmd ? "qmd" : `builtin-${memorySearch.store.driver}`;
      params.log.warn(
        `${backendLabel} memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    const backendLabel = shouldArmQmd ? "qmd" : `builtin-${memorySearch.store.driver}`;
    params.log.info?.(`${backendLabel} memory startup initialization armed for agent "${agentId}"`);
    try {
      const syncPromise = manager.sync?.({ reason: "startup" });
      if (syncPromise) {
        void syncPromise
          .then(() => {
            params.log.info?.(
              `${backendLabel} memory startup sync completed for agent "${agentId}"`,
            );
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            params.log.warn(
              `${backendLabel} memory startup sync failed for agent "${agentId}": ${message}`,
            );
          });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.log.warn(
        `${backendLabel} memory startup sync failed for agent "${agentId}": ${message}`,
      );
    }
  }
}
