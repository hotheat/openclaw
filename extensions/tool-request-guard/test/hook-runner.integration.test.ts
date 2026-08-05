import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../../../src/agents/pi-tools.before-tool-call.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../src/plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import type {
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration,
} from "../../../src/plugins/types.js";

type ToolRequestGuardApi = {
  pluginConfig?: Record<string, unknown>;
  logger: {
    info(message: string): void;
    warn(message: string): void;
  };
  on<K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ): void;
};

const requireFromRepo = createRequire(path.join(process.cwd(), "package.json"));
const registerToolRequestGuard = requireFromRepo("./extensions/tool-request-guard/index.js") as (
  api: ToolRequestGuardApi,
) => void;

function installToolRequestGuard() {
  const registry = createEmptyPluginRegistry();
  registerToolRequestGuard({
    pluginConfig: {},
    logger: {
      info() {},
      warn() {},
    },
    on(hookName, handler, opts) {
      registry.typedHooks.push({
        pluginId: "tool-request-guard",
        hookName,
        handler,
        priority: opts?.priority,
        source: "extensions/tool-request-guard/index.js",
      } as PluginHookRegistration);
    },
  });
  initializeGlobalHookRunner(registry);
}

describe("tool-request-guard HookRunner integration", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("blocks Feishu exec message sends before the underlying tool executes", async () => {
    installToolRequestGuard();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any, {
      agentId: "feishu-ou_test",
      sessionKey: "agent:feishu-ou_test:feishu:direct:ou_test",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute(
        "call-guarded-send",
        {
          command: "openclaw message send --channel feishu --target user:ou_other --message 'hi'",
        },
        undefined,
        extensionContext,
      ),
    ).rejects.toThrow(
      "Feishu 会话中禁止通过 exec 调用 openclaw message send；请使用 message 工具，让 outbox/router 接管发送。",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
