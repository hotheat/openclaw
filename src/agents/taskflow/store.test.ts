import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskFlowStore } from "./store.js";

describe("TaskFlowStore", () => {
  let tempDir: string;
  let tick = 0;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskflow-"));
    tick = 0;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeStore(options: Partial<Parameters<typeof createTaskFlowStore>[0]> = {}) {
    return createTaskFlowStore({
      ...options,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      stateDir: tempDir,
      idFactory: () => `tf_${++tick}`,
      now: () => new Date(Date.UTC(2026, 5, 18, 8, 0, tick)),
    });
  }

  it("creates a snapshot with initial items and writes local and global indexes", async () => {
    const store = makeStore();

    const result = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Ship TaskFlow",
      items: [{ title: "Write store" }, { id: "item_tools", title: "Wire tools" }],
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }
    expect(result.revision).toBe(1);
    expect(result.snapshot.items.map((item) => item.id)).toEqual([
      expect.stringMatching(/^item_[a-f0-9]{16}$/),
      "item_tools",
    ]);

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });

    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.title).toBe("Ship TaskFlow");
    expect(read.markdown).toContain("Revision: 1");

    const localIndex = JSON.parse(
      await fs.readFile(
        path.join(tempDir, "agents", "main", "agent", "taskflows", "index.json"),
        "utf8",
      ),
    );
    const globalIndex = JSON.parse(
      await fs.readFile(path.join(tempDir, "taskflows", "index.json"), "utf8"),
    );

    expect(localIndex.taskFlows.tf_1.ownerSessionKey).toBe("agent:main:dm:user-1");
    expect(globalIndex.taskFlows.tf_1.ownerAgentId).toBe("main");
  });

  it("enforces one foreground taskflow per owner session while parked flows do not occupy it", async () => {
    const store = makeStore();
    const ownerSessionKey = "agent:main:dm:user-1";

    const first = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey,
      title: "First",
    });
    expect(first.status).toBe("success");

    const conflict = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey,
      title: "Second",
    });
    expect(conflict).toMatchObject({
      status: "conflict",
      code: "foreground_conflict",
      taskFlowId: "tf_1",
    });

    const parked = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: ownerSessionKey,
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "park_taskflow",
      reason: "waiting for user",
    });
    expect(parked.status).toBe("success");

    const second = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey,
      title: "Second",
    });
    expect(second.status).toBe("success");

    const blockedResume = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: ownerSessionKey,
      taskFlowId: "tf_1",
      expectedRevision: 2,
      operation: "resume_taskflow",
    });
    expect(blockedResume).toMatchObject({
      status: "conflict",
      code: "foreground_conflict",
      taskFlowId: "tf_2",
    });

    await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: ownerSessionKey,
      taskFlowId: "tf_2",
      expectedRevision: 1,
      operation: "complete_taskflow",
    });

    const resumed = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: ownerSessionKey,
      taskFlowId: "tf_1",
      expectedRevision: 2,
      operation: "resume_taskflow",
    });
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      return;
    }
    expect(resumed.snapshot.status).toBe("active");
  });

  it("returns revision conflict metadata without mutating or returning the snapshot", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "CAS",
      items: [{ id: "item_a", title: "A" }],
    });

    const conflict = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 0,
      operation: "set_item_status",
      itemId: "item_a",
      status: "completed",
    });

    expect(conflict).toEqual({
      status: "conflict",
      code: "revision_conflict",
      taskFlowId: "tf_1",
      expectedRevision: 0,
      actualRevision: 1,
      affectedItemIds: ["item_a"],
      message:
        "TaskFlow changed since expectedRevision. Call taskflow_read, merge your intended change, then retry with the latest revision.",
    });
    expect("snapshot" in conflict).toBe(false);

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.items[0]?.status).toBe("pending");
  });

  it("completes the taskflow when the last item is completed", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Auto close",
      items: [
        { id: "item_a", title: "A", status: "completed" },
        { id: "item_b", title: "B" },
      ],
    });

    const completed = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "set_item_status",
      itemId: "item_b",
      status: "completed",
    });

    expect(completed.status).toBe("success");
    if (completed.status !== "success") {
      return;
    }
    expect(completed.snapshot.status).toBe("completed");
    expect(completed.snapshot.completedAt).toBe("2026-06-18T08:00:01.000Z");

    const foreground = await store.readTaskFlow({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(foreground).toMatchObject({
      status: "error",
      code: "not_found",
    });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("completed");
  });

  it("completes the taskflow when remaining items are completed or canceled", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Terminal item states",
      items: [
        { id: "item_done", title: "Done", status: "completed" },
        { id: "item_drop", title: "Drop" },
      ],
    });

    const canceled = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "set_item_status",
      itemId: "item_drop",
      status: "canceled",
    });

    expect(canceled.status).toBe("success");
    if (canceled.status !== "success") {
      return;
    }
    expect(canceled.snapshot.status).toBe("completed");
    expect(canceled.snapshot.completedAt).toBe("2026-06-18T08:00:01.000Z");
  });

  it("cancels the taskflow when every item is canceled", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Canceled terminal items",
      items: [
        { id: "item_drop_1", title: "Drop 1" },
        { id: "item_drop_2", title: "Drop 2", status: "canceled" },
      ],
    });

    const canceled = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "set_item_status",
      itemId: "item_drop_1",
      status: "canceled",
    });

    expect(canceled.status).toBe("success");
    if (canceled.status !== "success") {
      return;
    }
    expect(canceled.snapshot.status).toBe("canceled");
    expect(canceled.snapshot.completedAt).toBe("2026-06-18T08:00:01.000Z");
  });

  it("auto-completes when duplicate replacement items are canceled and the final active item completes", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "WorkBuddy-style cleanup",
      items: [
        { id: "identify", title: "Confirm boundary", status: "completed" },
        { id: "sources", title: "Collect sources", status: "completed" },
        { id: "architecture", title: "Map modules", status: "completed" },
        { id: "patterns", title: "Extract patterns", status: "completed" },
        { id: "conclusion", title: "Deliver summary" },
        { id: "dup_identify", title: "Duplicate confirm boundary", status: "canceled" },
        { id: "dup_sources", title: "Duplicate collect sources", status: "canceled" },
        { id: "dup_architecture", title: "Duplicate map modules", status: "canceled" },
        { id: "dup_patterns", title: "Duplicate extract patterns", status: "canceled" },
        { id: "dup_conclusion", title: "Duplicate deliver summary", status: "canceled" },
      ],
    });

    const completed = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "set_item_status",
      itemId: "conclusion",
      status: "completed",
    });

    expect(completed.status).toBe("success");
    if (completed.status !== "success") {
      return;
    }
    expect(completed.snapshot.status).toBe("completed");
    expect(completed.snapshot.completedAt).toBe("2026-06-18T08:00:01.000Z");
  });

  it("keeps the taskflow open when any item remains blocked", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Blocked item stays foreground",
      items: [
        { id: "item_done", title: "Done", status: "completed" },
        { id: "item_wait", title: "Wait" },
      ],
    });

    const blocked = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "set_item_status",
      itemId: "item_wait",
      status: "blocked",
    });

    expect(blocked.status).toBe("success");
    if (blocked.status !== "success") {
      return;
    }
    expect(blocked.snapshot.status).toBe("active");
    expect(blocked.snapshot.completedAt).toBeUndefined();

    const foreground = await store.readTaskFlow({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(foreground.status).toBe("success");
    if (foreground.status !== "success") {
      return;
    }
    expect(foreground.snapshot.id).toBe("tf_1");
  });

  it("keeps the committed snapshot and returns a warning when audit event append fails", async () => {
    const store = makeStore({
      appendEvent: async () => {
        throw new Error("event disk full");
      },
    });

    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Audit warning",
      items: [{ id: "item_a", title: "A" }],
    });

    expect(created.status).toBe("success");
    if (created.status !== "success") {
      return;
    }
    expect(created.warnings).toEqual(["audit_event_append_failed"]);

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.revision).toBe(1);
    expect(read.snapshot.metadata?.auditEventGaps).toEqual([
      { fromRevision: 1, toRevision: 1, detectedAt: "2026-06-18T08:00:01.000Z" },
    ]);
  });

  it("enforces shared ACL for read, write_assigned, and write_all permissions", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "ACL",
      items: [
        { id: "item_assigned", title: "Assigned", assigneeAgentId: "worker" },
        { id: "item_other", title: "Other" },
      ],
    });

    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      access: "write_assigned",
    });

    const assignedWrite = await store.applyTaskFlowOperation({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:child",
      taskFlowId: "tf_1",
      expectedRevision: 2,
      operation: "set_item_status",
      itemId: "item_assigned",
      status: "completed",
    });
    expect(assignedWrite.status).toBe("success");

    const deniedWrite = await store.applyTaskFlowOperation({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:child",
      taskFlowId: "tf_1",
      expectedRevision: 3,
      operation: "set_item_status",
      itemId: "item_other",
      status: "completed",
    });
    expect(deniedWrite).toMatchObject({ status: "error", code: "forbidden" });

    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:reviewer:subagent:child",
      access: "write_all",
    });

    const writeAll = await store.applyTaskFlowOperation({
      agentId: "reviewer",
      sessionKey: "agent:reviewer:subagent:child",
      taskFlowId: "tf_1",
      expectedRevision: 4,
      operation: "set_item_status",
      itemId: "item_other",
      status: "completed",
    });
    expect(writeAll.status).toBe("success");

    const unauthorized = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "stranger",
      sessionKey: "agent:stranger:subagent:child",
    });
    expect(unauthorized).toMatchObject({ status: "error", code: "forbidden" });
  });

  it("commits shared child updates back to the owner snapshot", async () => {
    const ownerStore = makeStore();
    await ownerStore.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Shared owner state",
      items: [{ id: "item_assigned", title: "Assigned", assigneeAgentId: "worker" }],
    });
    await ownerStore.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      access: "write_assigned",
    });

    const childStore = createTaskFlowStore({
      agentDir: path.join(tempDir, "agents", "worker", "agent"),
      stateDir: tempDir,
      now: () => new Date(Date.UTC(2026, 5, 18, 8, 0, ++tick)),
    });
    const childWrite = await childStore.applyTaskFlowOperation({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:child",
      taskFlowId: "tf_1",
      expectedRevision: 2,
      operation: "set_item_status",
      itemId: "item_assigned",
      status: "completed",
    });
    expect(childWrite.status).toBe("success");

    const ownerRead = await ownerStore.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(ownerRead.status).toBe("success");
    if (ownerRead.status !== "success") {
      return;
    }
    expect(ownerRead.revision).toBe(3);
    expect(ownerRead.snapshot.items[0]?.status).toBe("completed");

    const globalIndex = JSON.parse(
      await fs.readFile(path.join(tempDir, "taskflows", "index.json"), "utf8"),
    );
    expect(globalIndex.taskFlows.tf_1.snapshotPath).toBe(
      path.join(tempDir, "agents", "main", "agent", "taskflows", "tf_1.json"),
    );
  });

  it("rejects unknown operations without committing a new revision", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Reject unknown",
      items: [{ id: "item_a", title: "A" }],
    });

    const result = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      operation: "set_status" as never,
      itemId: "item_a",
    });
    expect(result).toMatchObject({ status: "error", code: "invalid_operation" });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.revision).toBe(1);
  });

  it("rejects taskflow-only statuses on set_item_status", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Item status domain",
      items: [{ id: "item_a", title: "A" }],
    });

    const result = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "set_item_status",
      itemId: "item_a",
      status: "active" as never,
    });
    expect(result).toMatchObject({ status: "error", code: "invalid_operation" });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.revision).toBe(1);
    expect(read.snapshot.items[0]?.status).toBe("pending");
  });

  it("revokes a shared grant by taskFlowId and blocks further child writes", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Revoke",
      items: [{ id: "item_a", title: "A", assigneeAgentId: "worker" }],
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      access: "write_assigned",
    });

    const revoked = await store.revokeAccessForSession({
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      revokeReason: "subagent_ended",
    });
    expect(revoked).toEqual({ status: "success", revokedTaskFlowIds: ["tf_1"] });

    const denied = await store.applyTaskFlowOperation({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:child",
      taskFlowId: "tf_1",
      operation: "set_item_status",
      itemId: "item_a",
      status: "completed",
    });
    expect(denied).toMatchObject({ status: "error", code: "forbidden" });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.revision).toBe(3);
    expect(read.snapshot.permissions[0]).toMatchObject({
      sessionKey: "agent:worker:subagent:child",
      revokedReason: "subagent_ended",
    });
    expect(typeof read.snapshot.permissions[0]?.revokedAt).toBe("string");
  });

  it("forbids write_all grantees from revoking permissions they did not grant", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Control plane",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:writer",
      access: "write_all",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:reader",
      access: "read",
    });

    const denied = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:subagent:writer",
      taskFlowId: "tf_1",
      operation: "revoke_access",
      targetSessionKey: "agent:main:subagent:reader",
    });
    expect(denied).toMatchObject({ status: "error", code: "forbidden" });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    const readerPermission = read.snapshot.permissions.find(
      (permission) => permission.sessionKey === "agent:main:subagent:reader",
    );
    expect(readerPermission?.revokedAt).toBeUndefined();
  });

  it("lets the owner revoke a grant via revoke_access and records a manual reason", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Owner revoke",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:writer",
      access: "write_all",
    });

    const revoked = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      operation: "revoke_access",
      targetSessionKey: "agent:main:subagent:writer",
    });
    expect(revoked.status).toBe("success");
    if (revoked.status !== "success") {
      return;
    }
    const writerPermission = revoked.snapshot.permissions.find(
      (permission) => permission.sessionKey === "agent:main:subagent:writer",
    );
    expect(writerPermission).toMatchObject({ revokedReason: "manual" });
    expect(typeof writerPermission?.revokedAt).toBe("string");
  });

  it("lets the original grantor revoke and re-grant the permissions it issued", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Grantor control",
      permissions: [
        {
          sessionKey: "agent:main:subagent:lead",
          access: "read",
          grantedBySessionKey: "agent:main:dm:user-1",
        },
        {
          sessionKey: "agent:main:subagent:helper",
          access: "read",
          grantedBySessionKey: "agent:main:subagent:lead",
        },
      ],
    });

    const regrant = await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:subagent:lead",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:helper",
      access: "write_assigned",
    });
    expect(regrant.status).toBe("success");

    const bootstrap = await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:subagent:lead",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:stranger",
      access: "read",
    });
    expect(bootstrap).toMatchObject({ status: "error", code: "forbidden" });

    const revoked = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:subagent:lead",
      taskFlowId: "tf_1",
      operation: "revoke_access",
      targetSessionKey: "agent:main:subagent:helper",
    });
    expect(revoked.status).toBe("success");
    if (revoked.status !== "success") {
      return;
    }
    const helperPermission = revoked.snapshot.permissions.find(
      (permission) => permission.sessionKey === "agent:main:subagent:helper",
    );
    expect(helperPermission).toMatchObject({ revokedReason: "manual" });
    expect(typeof helperPermission?.revokedAt).toBe("string");
  });

  it("revokes grants across taskflows for a session key and leaves other grantees intact", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "One",
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-2",
      scope: "shared",
      title: "Two",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:child",
      access: "write_all",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-2",
      taskFlowId: "tf_2",
      targetSessionKey: "agent:main:subagent:child",
      access: "read",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-2",
      taskFlowId: "tf_2",
      targetSessionKey: "agent:main:subagent:other",
      access: "read",
    });

    const revoked = await store.revokeAccessForSession({
      targetSessionKey: "agent:main:subagent:child",
      revokeReason: "session_deleted",
    });
    expect(revoked.status).toBe("success");
    if (revoked.status !== "success") {
      return;
    }
    expect([...revoked.revokedTaskFlowIds].toSorted()).toEqual(["tf_1", "tf_2"]);

    const read = await store.readTaskFlow({
      taskFlowId: "tf_2",
      agentId: "main",
      sessionKey: "agent:main:dm:user-2",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    const childPermission = read.snapshot.permissions.find(
      (permission) => permission.sessionKey === "agent:main:subagent:child",
    );
    expect(childPermission?.revokedReason).toBe("session_deleted");
    const otherPermission = read.snapshot.permissions.find(
      (permission) => permission.sessionKey === "agent:main:subagent:other",
    );
    expect(otherPermission?.revokedAt).toBeUndefined();

    const noop = await store.revokeAccessForSession({
      targetSessionKey: "agent:main:subagent:child",
      revokeReason: "session_deleted",
    });
    expect(noop).toEqual({ status: "success", revokedTaskFlowIds: [] });

    const reread = await store.readTaskFlow({
      taskFlowId: "tf_2",
      agentId: "main",
      sessionKey: "agent:main:dm:user-2",
    });
    expect(reread.status).toBe("success");
    if (reread.status !== "success") {
      return;
    }
    expect(reread.revision).toBe(read.revision);
  });

  it("generates unique implicit item ids across store instances", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Generated IDs",
      items: [{ title: "First" }],
    });

    const nextStore = makeStore();
    const upserted = await nextStore.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "upsert_items",
      items: [{ title: "Second" }],
    });

    expect(upserted.status).toBe("success");
    if (upserted.status !== "success") {
      return;
    }
    const itemIds = upserted.snapshot.items.map((item) => item.id);
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  it("rejects grants on local-scoped TaskFlows to enforce the local/shared boundary", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Local only",
    });

    const grant = await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:child",
      access: "write_assigned",
    });

    expect(grant).toMatchObject({ status: "error", code: "invalid_operation" });
  });

  it("allows only the owner to promote a non-terminal local TaskFlow to shared", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Promotable local flow",
      items: [
        {
          id: "work",
          title: "Keep existing work",
          status: "in_progress",
          evidence: [{ kind: "note", value: "existing evidence" }],
        },
      ],
      subscribers: [{ channel: "feishu", to: "ou_owner" }],
    });

    const unauthorized = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-2",
      taskFlowId: "tf_1",
      operation: "promote_to_shared",
    });
    expect(unauthorized).toMatchObject({ status: "error", code: "forbidden" });

    const promoted = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "promote_to_shared",
    });
    expect(promoted.status).toBe("success");
    if (promoted.status !== "success") {
      return;
    }
    expect(promoted.snapshot).toMatchObject({
      id: "tf_1",
      scope: "shared",
      status: "active",
      revision: 2,
      permissions: [],
      items: [
        {
          id: "work",
          title: "Keep existing work",
          status: "in_progress",
          evidence: [{ kind: "note", value: "existing evidence" }],
        },
      ],
      subscribers: [{ channel: "feishu", to: "ou_owner" }],
    });

    const grant = await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      access: "write_assigned",
    });
    expect(grant).toMatchObject({
      status: "success",
      revision: 3,
      snapshot: {
        scope: "shared",
        permissions: [
          {
            sessionKey: "agent:worker:subagent:child",
            access: "write_assigned",
          },
        ],
      },
    });

    const repeated = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 3,
      operation: "promote_to_shared",
    });
    expect(repeated).toMatchObject({ status: "error", code: "invalid_operation" });
  });

  it("rejects promotion of terminal local TaskFlows", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Terminal local flow",
    });
    await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 1,
      operation: "cancel_taskflow",
    });

    const promoted = await store.applyTaskFlowOperation({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      expectedRevision: 2,
      operation: "promote_to_shared",
    });
    expect(promoted).toMatchObject({ status: "error", code: "invalid_operation" });
  });

  it("does not reveal local scope to unauthorized grant callers", async () => {
    const store = makeStore();
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Local only",
    });

    const grant = await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-2",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:main:subagent:child",
      access: "write_assigned",
    });

    expect(grant).toMatchObject({ status: "error", code: "forbidden" });
  });

  it("rejects seeding permissions on local-scoped TaskFlows", async () => {
    const store = makeStore();

    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Local only",
      permissions: [
        {
          sessionKey: "agent:main:subagent:child",
          access: "read",
          grantedBySessionKey: "agent:main:dm:user-1",
        },
      ],
    });

    expect(created).toMatchObject({ status: "error", code: "invalid_operation" });
  });

  it("emits onCommitted for the grant and revoke paths that previously bypassed the hook", async () => {
    const events: { operation: string; revision: number }[] = [];
    const store = makeStore({
      onCommitted: (event) => {
        events.push({ operation: event.operation, revision: event.snapshot.revision });
      },
    });
    await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      scope: "shared",
      title: "Hook coverage",
    });
    await store.grantAccess({
      agentId: "main",
      sessionKey: "agent:main:dm:user-1",
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      access: "write_assigned",
    });
    await store.revokeAccessForSession({
      taskFlowId: "tf_1",
      targetSessionKey: "agent:worker:subagent:child",
      revokeReason: "subagent_ended",
    });

    expect(events).toEqual([
      { operation: "create", revision: 1 },
      { operation: "grant_access", revision: 2 },
      { operation: "revoke_access", revision: 3 },
    ]);
  });
});
