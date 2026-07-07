import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findGatewayRequest,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";

describe("sessions_spawn taskflow default boundary", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-taskflow-default-"));
    resetSessionsSpawnConfigOverride();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not pass taskflow context by default", async () => {
    setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });

    await tool.execute("call1", { task: "do work" });

    const agentRequest = findGatewayRequest("agent");
    expect(JSON.stringify(agentRequest?.params)).not.toContain("[TaskFlow Context]");
  });
});
