import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  findGatewayRequest,
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import { createTaskFlowStore } from "./taskflow/store.js";

describe("sessions_spawn taskflow lifecycle tracking", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-taskflow-tracking-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
    getCallGatewayMock().mockClear();
    resetSubagentRegistryForTests({ persist: false });
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", agentDir, subagents: { allowAgents: ["worker"] } }, { id: "worker" }],
      },
    });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    resetSessionsSpawnConfigOverride();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("tracks the current local taskflow by default for run mode without granting access", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const store = createTaskFlowStore({
        agentDir,
        stateDir: tempDir,
        idFactory: () => "tf_local",
        now: () => new Date("2026-07-13T08:00:00.000Z"),
      });
      await store.createTaskFlow({
        agentId: "main",
        ownerSessionKey: "agent:main:main",
        title: "Local tracked work",
        items: [{ id: "work", title: "Do work", status: "in_progress" }],
      });
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "do tracked work",
        agentId: "worker",
      })) as { details?: { status?: string; childSessionKey?: string } };

      expect(result.details?.status).toBe("accepted");
      const agentRequest = findGatewayRequest("agent");
      const message = (agentRequest?.params as { message?: string } | undefined)?.message ?? "";
      expect(message).not.toContain("[TaskFlow Context]");

      const runs = listSubagentRunsForRequester("agent:main:main");
      const trackedRun = runs.find((entry) => entry.trackingTaskFlowId === "tf_local");
      expect(trackedRun).toMatchObject({
        taskFlowId: undefined,
        trackingTaskFlowId: "tf_local",
      });

      const childSessionKey = result.details?.childSessionKey ?? "";
      const childRead = await store.readTaskFlow({
        taskFlowId: "tf_local",
        agentId: "worker",
        sessionKey: childSessionKey,
      });
      expect(childRead).toMatchObject({ status: "error", code: "forbidden" });
    });
  });

  it("allows run mode to opt out of automatic tracking", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const store = createTaskFlowStore({
        agentDir,
        stateDir: tempDir,
        idFactory: () => "tf_local",
        now: () => new Date("2026-07-13T08:00:00.000Z"),
      });
      await store.createTaskFlow({
        agentId: "main",
        ownerSessionKey: "agent:main:main",
        title: "Local tracked work",
        items: [{ id: "work", title: "Do work", status: "in_progress" }],
      });
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "do unrelated work",
        agentId: "worker",
        taskFlowTracking: "none",
      })) as { details?: { status?: string } };

      expect(result.details?.status).toBe("accepted");
      const runs = listSubagentRunsForRequester("agent:main:main");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.trackingTaskFlowId).toBeUndefined();
    });
  });

  it("continues untracked when auto mode finds no foreground taskflow", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "do ordinary work",
        agentId: "worker",
      })) as { details?: { status?: string } };

      expect(result.details?.status).toBe("accepted");
      const runs = listSubagentRunsForRequester("agent:main:main");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.trackingTaskFlowId).toBeUndefined();
    });
  });

  it("rejects current tracking when the requester has no foreground taskflow", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "do tracked work",
        agentId: "worker",
        taskFlowTracking: "current",
      })) as { details?: { status?: string; error?: string } };

      expect(result.details).toMatchObject({ status: "error" });
      expect(result.details?.error).toContain("foreground TaskFlow");
      expect(findGatewayRequest("agent")).toBeUndefined();
    });
  });

  it("rejects mixing lifecycle tracking with shared TaskFlow access", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "do conflicting work",
        agentId: "worker",
        taskFlowTracking: "current",
        taskFlowId: "tf_shared",
        taskFlowScope: "shared",
        taskFlowAccess: "read",
      })) as { details?: { status?: string; error?: string } };

      expect(result.details).toMatchObject({ status: "error" });
      expect(result.details?.error).toContain("cannot be combined");
      expect(findGatewayRequest("agent")).toBeUndefined();
    });
  });

  it.each([
    [{ taskFlowId: "tf_shared" }, "taskFlowScope"],
    [{ taskFlowScope: "shared" as const }, "taskFlowId"],
    [{ taskFlowAccess: "read" as const }, "taskFlowId"],
  ])("rejects incomplete shared TaskFlow parameters: %o", async (sharedParams, missingField) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      setupSessionsSpawnGatewayMock({});
      const tool = await getSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentDir,
      });

      const result = (await tool.execute("call1", {
        task: "do shared work",
        agentId: "worker",
        ...sharedParams,
      })) as { details?: { status?: string; error?: string } };

      expect(result.details).toMatchObject({ status: "error" });
      expect(result.details?.error).toContain(missingField);
      expect(findGatewayRequest("agent")).toBeUndefined();
    });
  });
});
