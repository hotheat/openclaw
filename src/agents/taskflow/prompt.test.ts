import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskFlowPromptContext } from "./prompt.js";
import { createTaskFlowStore } from "./store.js";

describe("buildTaskFlowPromptContext", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskflow-prompt-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns undefined when the owner session has no foreground taskflow", async () => {
    const context = await buildTaskFlowPromptContext({
      agentDir,
      stateDir: tempDir,
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });

    expect(context).toBeUndefined();
  });

  it("injects active taskflow markdown with revision and without updatedAt", async () => {
    const store = createTaskFlowStore({
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_prompt",
      now: () => new Date("2026-06-18T08:00:00.000Z"),
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Prompt state",
      items: [{ title: "Use persisted state" }],
    });

    const context = await buildTaskFlowPromptContext({
      agentDir,
      stateDir: tempDir,
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });

    expect(context).toContain("TaskFlow: tf_prompt");
    expect(context).toContain("Revision: 1");
    expect(context).toContain("- [ ] Use persisted state");
    expect(context).not.toContain("updatedAt");
    expect(context).not.toContain("2026-06-18T08:00:00.000Z");
  });

  it("injects only a short summary for parked taskflows", async () => {
    const store = createTaskFlowStore({
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_parked",
      now: () => new Date("2026-06-18T08:00:00.000Z"),
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Parked state",
      items: [{ title: "Do not expand me" }],
    });
    await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_parked",
      expectedRevision: 1,
      operation: "park_taskflow",
    });

    const context = await buildTaskFlowPromptContext({
      agentDir,
      stateDir: tempDir,
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });

    expect(context).toContain("Parked: 1 (tf_parked)");
    expect(context).not.toContain("Do not expand me");
  });
});
