import "./run.overflow-compaction.mocks.shared.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "../subagent-registry.js";
import { createTaskFlowStore } from "../taskflow/store.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.shared-test.js";
import { abortEmbeddedPiRun } from "./runs.js";

describe("run taskflow finalization", () => {
  let tempDir: string;
  let tick = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedRunEmbeddedAttempt.mockReset();
    resetSubagentRegistryForTests({ persist: false });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-taskflow-finalize-"));
    tick = 0;
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeStore() {
    return createTaskFlowStore({
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      stateDir: tempDir,
      idFactory: () => `tf_${++tick}`,
      now: () => new Date(Date.UTC(2026, 6, 7, 4, 9, tick)),
    });
  }

  function makeWorkerStore() {
    return createTaskFlowStore({
      agentDir: path.join(tempDir, "agents", "worker", "agent"),
      stateDir: tempDir,
      idFactory: () => `tf_${++tick}`,
      now: () => new Date(Date.UTC(2026, 6, 7, 4, 9, tick)),
    });
  }

  async function seedForegroundTaskFlow() {
    const store = makeStore();
    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      title: "KimiWork 架构设计模式拆解",
      items: [
        { id: "boundary", title: "确认 KimiWork 项目边界", status: "completed" },
        { id: "sources", title: "收集公开资料与线索", status: "completed" },
        { id: "modules", title: "拆解核心架构模块", status: "completed" },
        { id: "patterns", title: "提炼设计模式与取舍", status: "completed" },
        { id: "conclusion", title: "输出中文结论", status: "in_progress" },
      ],
    });
    expect(created.status).toBe("success");
    return store;
  }

  async function seedPendingOnlyForegroundTaskFlow() {
    const store = makeStore();
    const created = await store.createTaskFlow({
      agentId: "main",
      ownerSessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      title: "Pending-only foreground taskflow",
      items: [
        { id: "boundary", title: "确认 KimiWork 项目边界", status: "completed" },
        { id: "sources", title: "收集公开资料与线索", status: "completed" },
        { id: "conclusion", title: "输出中文结论" },
      ],
    });
    expect(created.status).toBe("success");
    return store;
  }

  async function seedWorkerAssignedForegroundTaskFlow() {
    const store = makeWorkerStore();
    const created = await store.createTaskFlow({
      agentId: "worker",
      ownerSessionKey: "agent:worker:feishu:direct:ou_worker",
      scope: "shared",
      title: "Worker assigned foreground taskflow",
      items: [
        { id: "boundary", title: "确认范围", status: "completed" },
        {
          id: "conclusion",
          title: "输出中文结论",
          status: "in_progress",
          assigneeAgentId: "worker",
        },
      ],
    });
    expect(created.status).toBe("success");
    return store;
  }

  it("parks a foreground taskflow when the run ends with a user-facing reply and orphan in_progress items", async () => {
    const store = await seedForegroundTaskFlow();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["结论：KimiWork 更接近 orchestrator + mode pipeline。"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      sessionId: "session-taskflow-finalization",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });

    expect(result.meta.error).toBeUndefined();

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("parked");
    expect(read.snapshot.parkedReason).toBe("finalization_missing");
    expect(read.snapshot.items.find((item) => item.id === "conclusion")?.status).toBe(
      "in_progress",
    );
  });

  it("does not park when an active descendant subagent run is still bound to the same taskflow", async () => {
    const store = await seedForegroundTaskFlow();
    addSubagentRunForTests({
      runId: "run-child-1",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      requesterDisplayKey: "feishu",
      task: "继续整理结论",
      cleanup: "delete",
      spawnMode: "run",
      taskFlowId: "tf_1",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["我已把子任务交给后台继续汇总结论。"],
      }),
    );

    await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      sessionId: "session-taskflow-subagent-exempt",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("active");
    expect(read.snapshot.parkedReason).toBeUndefined();
  });

  it("does not park when an active descendant only tracks the local taskflow lifecycle", async () => {
    const store = await seedForegroundTaskFlow();
    addSubagentRunForTests({
      runId: "run-child-tracked",
      childSessionKey: "agent:main:subagent:child-tracked",
      requesterSessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      requesterDisplayKey: "feishu",
      task: "继续整理结论",
      cleanup: "delete",
      spawnMode: "run",
      trackingTaskFlowId: "tf_1",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["我已把子任务交给后台继续汇总结论。"],
      }),
    );

    await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      sessionId: "session-taskflow-tracked-subagent-exempt",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("active");
    expect(read.snapshot.parkedReason).toBeUndefined();
  });

  it("parks when the tracked descendant has already ended", async () => {
    const store = await seedForegroundTaskFlow();
    addSubagentRunForTests({
      runId: "run-child-tracked-ended",
      childSessionKey: "agent:main:subagent:child-tracked-ended",
      requesterSessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      requesterDisplayKey: "feishu",
      task: "继续整理结论",
      cleanup: "delete",
      spawnMode: "run",
      trackingTaskFlowId: "tf_1",
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["子任务已经结束，当前事项仍未收尾。"],
      }),
    );

    await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      sessionId: "session-taskflow-ended-tracked-subagent",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });

    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("parked");
    expect(read.snapshot.parkedReason).toBe("finalization_missing");
  });

  it("does not finalize the taskflow on aborted runs", async () => {
    const store = await seedForegroundTaskFlow();

    const run = runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      sessionId: "session-taskflow-aborted",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });
    abortEmbeddedPiRun("session-taskflow-aborted");
    const result = await run;

    expect(result.meta.aborted).toBe(true);
    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("active");
    expect(read.snapshot.parkedReason).toBeUndefined();
  });

  it("does not park a foreground taskflow when remaining items are only pending", async () => {
    const store = await seedPendingOnlyForegroundTaskFlow();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["结论已输出，剩余事项等待下一轮补充。"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      sessionId: "session-taskflow-pending-only",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "main", "agent"),
    });

    expect(result.meta.error).toBeUndefined();
    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "main",
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("active");
    expect(read.snapshot.parkedReason).toBeUndefined();
    expect(read.snapshot.items.find((item) => item.id === "conclusion")?.status).toBe("pending");
  });

  it("parks assigned in_progress items for non-main agents using the resolved workspace agent id", async () => {
    const store = await seedWorkerAssignedForegroundTaskFlow();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["结论：该任务仍需下一轮确认。"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      agentId: "worker",
      sessionKey: "agent:worker:feishu:direct:ou_worker",
      sessionId: "session-taskflow-worker-agent",
      workspaceDir: tempDir,
      agentDir: path.join(tempDir, "agents", "worker", "agent"),
    });

    expect(result.meta.error).toBeUndefined();
    const read = await store.readTaskFlow({
      taskFlowId: "tf_1",
      agentId: "worker",
      sessionKey: "agent:worker:feishu:direct:ou_worker",
    });
    expect(read.status).toBe("success");
    if (read.status !== "success") {
      return;
    }
    expect(read.snapshot.status).toBe("parked");
    expect(read.snapshot.parkedReason).toBe("finalization_missing");
  });
});
