import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskFlowStore } from "../taskflow/store.js";
import { createTaskFlowUpdateTool } from "./taskflow-update-tool.js";

describe("taskflow_update tool", () => {
  let tempDir: string;
  let agentDir: string;
  let tick: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskflow-tool-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
    tick = 0;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeTool() {
    return createTaskFlowUpdateTool({
      agentId: "main",
      agentSessionKey: "agent:main:dm:user-1",
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_tool",
      now: () => new Date(Date.UTC(2026, 5, 18, 8, 0, ++tick)),
    });
  }

  function makeToolWithSessionKey(agentSessionKey: string) {
    return createTaskFlowUpdateTool({
      agentId: "main",
      agentSessionKey,
      agentDir,
      stateDir: tempDir,
      idFactory: () => "tf_tool",
      now: () => new Date(Date.UTC(2026, 5, 18, 8, 0, ++tick)),
    });
  }

  it("creates a taskflow with initial items atomically", async () => {
    const tool = makeTool();

    const result = await tool.execute("call1", {
      operation: "create",
      title: "Tool state",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      taskFlowId: "tf_tool",
      revision: 1,
      changedItems: ["item_store"],
    });
    expect(JSON.stringify(result.details)).toContain("Persist state");
  });

  it("auto-subscribes Feishu direct sessions when creating a taskflow", async () => {
    const tool = makeToolWithSessionKey("agent:feishu-ou_owner:feishu:direct:ou_owner");

    const result = await tool.execute("call1", {
      operation: "create",
      title: "Feishu direct progress",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      snapshot: {
        subscribers: [
          {
            channel: "feishu",
            accountId: "default",
            to: "ou_owner",
          },
        ],
      },
    });
  });

  it("auto-subscribes Feishu group sessions when creating a taskflow", async () => {
    const tool = makeToolWithSessionKey("agent:feishu-group-oc_owner:feishu:group:oc_owner");

    const result = await tool.execute("call1", {
      operation: "create",
      title: "Feishu group progress",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      snapshot: {
        subscribers: [
          {
            channel: "feishu",
            accountId: "default",
            chatId: "oc_owner",
          },
        ],
      },
    });
  });

  it("preserves Feishu account id when auto-subscribing taskflows", async () => {
    const tool = makeToolWithSessionKey(
      "agent:feishu-ou_owner:feishu:work-account:direct:ou_owner",
    );

    const result = await tool.execute("call1", {
      operation: "create",
      title: "Feishu account progress",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      snapshot: {
        subscribers: [
          {
            channel: "feishu",
            accountId: "work-account",
            to: "ou_owner",
          },
        ],
      },
    });
  });

  it("does not auto-subscribe shared taskflows from Feishu sessions", async () => {
    const tool = makeToolWithSessionKey("agent:feishu-ou_owner:feishu:direct:ou_owner");

    const result = await tool.execute("call1", {
      operation: "create",
      scope: "shared",
      title: "Shared Feishu progress",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      snapshot: {
        scope: "shared",
        subscribers: [],
      },
    });
  });

  it("does not auto-subscribe non-Feishu sessions", async () => {
    const tool = makeTool();

    const result = await tool.execute("call1", {
      operation: "create",
      title: "Local progress",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      snapshot: { subscribers: [] },
    });
  });

  it("does not auto-subscribe Feishu topic-scoped sessions to preserve topic isolation", async () => {
    const tool = makeToolWithSessionKey(
      "agent:feishu-group-oc_chat:feishu:group:oc_chat:topic:ot_root",
    );

    const result = await tool.execute("call1", {
      operation: "create",
      title: "Topic-isolated progress",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    expect(result.details).toMatchObject({
      status: "success",
      snapshot: { subscribers: [] },
    });
  });

  it("rejects explicit Feishu subscriptions from topic-scoped sessions", async () => {
    const tool = makeToolWithSessionKey(
      "agent:feishu-group-oc_chat:feishu:group:oc_chat:topic:ot_root",
    );
    await tool.execute("call1", {
      operation: "create",
      title: "Topic-isolated progress",
    });

    const result = await tool.execute("call2", {
      operation: "subscribe_channel",
      taskFlowId: "tf_tool",
      subscriber: {
        channel: "feishu",
        chatId: "oc_chat",
      },
    });

    expect(result.details).toMatchObject({
      status: "error",
      code: "invalid_operation",
    });

    const store = createTaskFlowStore({ agentDir, stateDir: tempDir });
    const read = await store.readTaskFlow({
      agentId: "main",
      sessionKey: "agent:feishu-group-oc_chat:feishu:group:oc_chat:topic:ot_root",
      taskFlowId: "tf_tool",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.subscribers).toEqual([]);
  });

  it("declares a closed operation enum and item-only statuses in the tool schema", () => {
    const tool = makeTool();
    const properties = (
      tool.parameters as unknown as {
        properties: Record<string, { enum?: string[] }>;
      }
    ).properties;

    expect(properties.operation?.enum).toEqual([
      "create",
      "upsert_items",
      "set_item_status",
      "attach_evidence",
      "set_active_item",
      "subscribe_channel",
      "park_taskflow",
      "resume_taskflow",
      "revoke_access",
      "complete_taskflow",
      "cancel_taskflow",
    ]);
    expect(properties.status?.enum).toEqual([
      "pending",
      "in_progress",
      "completed",
      "blocked",
      "canceled",
    ]);
    expect(properties.taskFlowAccess).toBeUndefined();
    expect(properties.revokeReason).toBeUndefined();
  });

  it("always records manual revoke reasons on revoke_access", async () => {
    const tool = makeTool();
    await tool.execute("call1", {
      operation: "create",
      scope: "shared",
      title: "Revoke via tool",
    });
    const store = createTaskFlowStore({ agentDir, stateDir: tempDir });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_tool",
      targetSessionKey: "agent:main:subagent:child",
      access: "write_all",
    });

    const result = await tool.execute("call2", {
      operation: "revoke_access",
      taskFlowId: "tf_tool",
      targetSessionKey: "agent:main:subagent:child",
      revokeReason: "subagent_ended",
    });
    expect(result.details).toMatchObject({ status: "success" });

    const read = await store.readTaskFlow({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_tool",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.permissions[0]).toMatchObject({
      sessionKey: "agent:main:subagent:child",
      revokedReason: "manual",
    });
  });

  it("rejects unknown operations without committing a revision", async () => {
    const tool = makeTool();
    await tool.execute("call1", {
      operation: "create",
      title: "Tool state",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    const result = await tool.execute("call2", {
      operation: "set_status",
      taskFlowId: "tf_tool",
      itemId: "item_store",
      status: "completed",
    });
    expect(result.details).toMatchObject({ status: "error", code: "invalid_operation" });

    const followUp = await tool.execute("call3", {
      operation: "set_item_status",
      taskFlowId: "tf_tool",
      expectedRevision: 1,
      itemId: "item_store",
      status: "completed",
    });
    expect(followUp.details).toMatchObject({ status: "success", revision: 2 });
  });

  it("rejects taskflow statuses passed to set_item_status", async () => {
    const tool = makeTool();
    await tool.execute("call1", {
      operation: "create",
      title: "Tool state",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    const result = await tool.execute("call2", {
      operation: "set_item_status",
      taskFlowId: "tf_tool",
      expectedRevision: 1,
      itemId: "item_store",
      status: "parked",
    });
    expect(result.details).toMatchObject({ status: "error", code: "invalid_operation" });
  });

  it("returns revision conflict metadata without a snapshot", async () => {
    const tool = makeTool();
    await tool.execute("call1", {
      operation: "create",
      title: "Tool state",
      items: [{ id: "item_store", title: "Persist state" }],
    });

    const result = await tool.execute("call2", {
      operation: "set_item_status",
      taskFlowId: "tf_tool",
      expectedRevision: 0,
      itemId: "item_store",
      status: "completed",
    });

    expect(result.details).toEqual({
      status: "conflict",
      code: "revision_conflict",
      taskFlowId: "tf_tool",
      expectedRevision: 0,
      actualRevision: 1,
      affectedItemIds: ["item_store"],
      message:
        "TaskFlow changed since expectedRevision. Call taskflow_read, merge your intended change, then retry with the latest revision.",
    });
    expect(JSON.stringify(result.details)).not.toContain("Persist state");
  });
});
