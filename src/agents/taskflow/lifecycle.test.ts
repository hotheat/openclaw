import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { revokeTaskFlowAccessForSessionKey } from "./lifecycle.js";
import { createTaskFlowStore } from "./store.js";

describe("revokeTaskFlowAccessForSessionKey", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskflow-lifecycle-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("revokes live grants for the session key via the global index", async () => {
    const agentDir = path.join(tempDir, "agents", "main", "agent");
    const store = createTaskFlowStore({
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_1",
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Lifecycle",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:child",
      access: "write_all",
    });

    const result = await revokeTaskFlowAccessForSessionKey({
      cfg: { agents: { list: [{ id: "main", agentDir }] } } as OpenClawConfig,
      stateDir: tempDir,
      targetSessionKey: "agent:main:subagent:child",
      revokeReason: "session_deleted",
    });
    expect(result.revokedTaskFlowIds).toEqual(["tf_1"]);

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.permissions[0]).toMatchObject({
      sessionKey: "agent:main:subagent:child",
      revokedReason: "session_deleted",
    });
  });

  it("revokes by taskFlowId when provided and returns empty when nothing matches", async () => {
    const agentDir = path.join(tempDir, "agents", "main", "agent");
    const store = createTaskFlowStore({
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_1",
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Lifecycle",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:child",
      access: "read",
    });

    const cfg = { agents: { list: [{ id: "main", agentDir }] } } as OpenClawConfig;
    const targeted = await revokeTaskFlowAccessForSessionKey({
      cfg,
      stateDir: tempDir,
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:dm:user-1",
      revokeReason: "subagent_ended",
    });
    expect(targeted.revokedTaskFlowIds).toEqual(["tf_1"]);

    const missing = await revokeTaskFlowAccessForSessionKey({
      cfg,
      stateDir: tempDir,
      taskFlowId: "tf_unknown",
      targetSessionKey: "agent:main:subagent:child",
      revokeReason: "subagent_ended",
    });
    expect(missing.revokedTaskFlowIds).toEqual([]);
  });
});
