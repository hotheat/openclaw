import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskFlowUpdateTool } from "./taskflow-update-tool.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runTaskFlowUpdated: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

describe("taskflow_update hook dispatch", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskflow-hook-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
    hookRunner.hasHooks.mockReset();
    hookRunner.runTaskFlowUpdated.mockReset();
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "taskflow_updated");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fires taskflow_updated after a successful create", async () => {
    const tool = createTaskFlowUpdateTool({
      agentId: "main",
      agentSessionKey: "agent:main:dm:user-1",
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_hook",
      now: () => new Date("2026-06-18T08:00:00.000Z"),
    });

    await tool.execute("call1", {
      operation: "create",
      title: "Hook state",
      items: [{ id: "item_a", title: "A" }],
    });

    expect(hookRunner.runTaskFlowUpdated).toHaveBeenCalledTimes(1);
    const [event, ctx] = hookRunner.runTaskFlowUpdated.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      taskFlowId: "tf_hook",
      revision: 1,
      operation: "create",
      changedItems: ["item_a"],
    });
    expect(event.snapshot.title).toBe("Hook state");
    expect(ctx).toEqual({ agentId: "main", sessionKey: "agent:main:dm:user-1" });
  });
});
