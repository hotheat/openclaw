import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  findGatewayRequest,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { createTaskFlowStore } from "./taskflow/store.js";

describe("sessions_spawn shared taskflow", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-taskflow-shared-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", agentDir, subagents: { allowAgents: ["worker"] } }, { id: "worker" }],
      },
    });
  });

  afterEach(async () => {
    resetSessionsSpawnConfigOverride();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("grants explicit shared access and appends TaskFlow Context to the child task", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const store = createTaskFlowStore({
        agentDir,
        stateDir: tempDir,
        idFactory: () => "tf_shared",
        now: () => new Date("2026-06-18T08:00:00.000Z"),
      });
      await store.createTaskFlow({
        agentId: "main",
        ownerSessionKey: "agent:main:main",
        scope: "shared",
        title: "Shared",
      });
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      await tool.execute("call1", {
        task: "do shared work",
        agentId: "worker",
        taskFlowId: "tf_shared",
        taskFlowScope: "shared",
        taskFlowAccess: "write_assigned",
      });

      const agentRequest = findGatewayRequest("agent");
      const message = (agentRequest?.params as { message?: string } | undefined)?.message ?? "";
      expect(message).toContain("[TaskFlow Context]");
      expect(message).toContain("taskFlowId=tf_shared");
      expect(message).toContain("access=write_assigned");

      const childSessionKey = (agentRequest?.params as { sessionKey?: string } | undefined)
        ?.sessionKey;
      expect(childSessionKey).toMatch(/^agent:worker:subagent:/);
      const read = await store.readTaskFlow({
        taskFlowId: "tf_shared",
        agentId: "worker",
        sessionKey: childSessionKey ?? "",
      });
      expect(read.status).toBe("success");
    });
  });

  it("rejects spawning into a local TaskFlow even when the caller claims shared scope", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const store = createTaskFlowStore({
        agentDir,
        stateDir: tempDir,
        idFactory: () => "tf_local",
        now: () => new Date("2026-06-18T08:00:00.000Z"),
      });
      await store.createTaskFlow({
        agentId: "main",
        ownerSessionKey: "agent:main:main",
        title: "Local",
      });

      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "try to leak a local taskflow",
        agentId: "worker",
        taskFlowId: "tf_local",
        taskFlowScope: "shared",
        taskFlowAccess: "write_assigned",
      })) as { details?: { status?: string; error?: string } };

      expect(result.details).toMatchObject({ status: "error" });
      expect(result.details?.error).toMatch(/shared/i);
    });
  });
});
