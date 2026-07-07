import { describe, expect, it, vi } from "vitest";
import type { TaskFlow } from "../agents/taskflow/types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("taskflow hook runner methods", () => {
  it("runTaskFlowUpdated invokes registered taskflow_updated hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "taskflow_updated", handler }]);
    const runner = createHookRunner(registry);
    const snapshot = {
      id: "tf_1",
      scope: "local",
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Hook",
      status: "active",
      revision: 2,
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:01:00.000Z",
      items: [],
      subscribers: [],
      permissions: [],
    } satisfies TaskFlow;
    const event = {
      taskFlowId: "tf_1",
      revision: 2,
      operation: "set_item_status",
      changedItems: ["item_a"],
      snapshot,
      markdown: "## Active TaskFlow",
    };
    const ctx = { agentId: "main", sessionKey: "agent:main:dm:user-1" };

    await runner.runTaskFlowUpdated(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
  });
});
