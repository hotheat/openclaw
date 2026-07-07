import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskFlowStore } from "../taskflow/store.js";
import { createTaskFlowReadTool } from "./taskflow-read-tool.js";

describe("taskflow_read tool", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskflow-read-tool-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads the current foreground taskflow as JSON and Markdown", async () => {
    const store = createTaskFlowStore({
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_read",
      now: () => new Date("2026-06-18T08:00:00.000Z"),
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Read state",
      items: [{ id: "item_read", title: "Return snapshot" }],
    });
    const tool = createTaskFlowReadTool({
      agentId: "main",
      agentSessionKey: "agent:main:dm:user-1",
      agentDir,
      stateDir: tempDir,
    });

    const result = await tool.execute("call1", {});

    expect(result.details).toMatchObject({
      status: "success",
      taskFlowId: "tf_read",
      revision: 1,
      snapshot: { title: "Read state" },
    });
    expect(JSON.stringify(result.details)).toContain("- [ ] Return snapshot");
  });

  it("exposes only implemented parameters in the tool schema", () => {
    const tool = createTaskFlowReadTool({
      agentId: "main",
      agentSessionKey: "agent:main:dm:user-1",
      agentDir,
      stateDir: tempDir,
    });
    const properties = (tool.parameters as unknown as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).toEqual(["taskFlowId"]);
  });
});
