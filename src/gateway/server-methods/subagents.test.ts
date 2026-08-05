import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import { ErrorCodes, type SubagentsListResult } from "../protocol/index.js";

const mocks = vi.hoisted(() => ({
  getSubagentSourceToolCallId: vi.fn(),
  listSubagentRunsForRequester: vi.fn(),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getSubagentSourceToolCallId: mocks.getSubagentSourceToolCallId,
  listSubagentRunsForRequester: mocks.listSubagentRunsForRequester,
}));

import { subagentsHandlers } from "./subagents.js";

type RespondCall = [boolean, unknown?, { code?: number; message?: string }?];

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:worker:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "private task text",
    cleanup: "keep",
    createdAt: 100,
    ...overrides,
  };
}

async function invokeSubagentsList(params: {
  requestParams?: Record<string, unknown>;
  connId?: string;
  caps?: string[];
  scopes?: string[];
}) {
  const respond = vi.fn();
  const registerToolEventRecipient = vi.fn();
  await subagentsHandlers["subagents.list"]({
    params: params.requestParams ?? { requesterSessionKey: "agent:main:main" },
    respond: respond as never,
    context: { registerToolEventRecipient } as never,
    client:
      params.connId === undefined && params.caps === undefined && params.scopes === undefined
        ? null
        : ({
            connId: params.connId,
            connect: { caps: params.caps, scopes: params.scopes },
          } as never),
    req: { type: "req", id: "req-subagents-list", method: "subagents.list" },
    isWebchatConnect: () => false,
  });
  return { respond, registerToolEventRecipient };
}

function readSuccessPayload(respond: ReturnType<typeof vi.fn>): SubagentsListResult {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  expect(call?.[0]).toBe(true);
  return call?.[1] as SubagentsListResult;
}

describe("subagents.list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSubagentSourceToolCallId.mockReturnValue(undefined);
    mocks.listSubagentRunsForRequester.mockReturnValue([]);
  });

  it("rejects missing, whitespace-only, and extra params", async () => {
    for (const requestParams of [
      {},
      { requesterSessionKey: "   " },
      { requesterSessionKey: "agent:main:main", extra: true },
    ]) {
      const { respond } = await invokeSubagentsList({ requestParams });
      const call = respond.mock.calls[0] as RespondCall | undefined;
      expect(call?.[0]).toBe(false);
      expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    }
    expect(mocks.listSubagentRunsForRequester).not.toHaveBeenCalled();
  });

  it("returns an empty list when the requester has no direct children", async () => {
    const { respond } = await invokeSubagentsList({});

    expect(readSuccessPayload(respond)).toEqual({ runs: [] });
    expect(mocks.listSubagentRunsForRequester).toHaveBeenCalledWith("agent:main:main");
  });

  it("projects only the public DTO and maps active and terminal statuses", async () => {
    mocks.listSubagentRunsForRequester.mockReturnValue([
      createRun({ runId: "pending", childSessionKey: "child-pending", createdAt: 1 }),
      createRun({
        runId: "running",
        childSessionKey: "child-running",
        createdAt: 2,
        startedAt: 3,
        label: " worker ",
        sessionLabel: " session ",
        model: " provider/model ",
        spawnMode: "run",
        requesterOrigin: { channel: "feishu", to: "private-target" },
      }),
      createRun({
        runId: "ok",
        childSessionKey: "child-ok",
        createdAt: 4,
        startedAt: 5,
        endedAt: 6,
        outcome: { status: "ok" },
      }),
      createRun({
        runId: "error",
        childSessionKey: "child-error",
        createdAt: 7,
        endedAt: 8,
        outcome: { status: "error", error: "private failure" },
      }),
      createRun({
        runId: "timeout",
        childSessionKey: "child-timeout",
        createdAt: 9,
        endedAt: 10,
        outcome: { status: "timeout" },
      }),
      createRun({
        runId: "unknown",
        childSessionKey: "child-unknown",
        createdAt: 11,
        endedAt: 12,
      }),
    ]);
    mocks.getSubagentSourceToolCallId.mockImplementation((run: SubagentRunRecord) =>
      run.runId === "running" ? "call_spawn_running" : undefined,
    );

    const { respond } = await invokeSubagentsList({});
    const payload = readSuccessPayload(respond);

    expect(payload.runs.map((run) => run.status)).toEqual([
      "pending",
      "running",
      "ok",
      "error",
      "timeout",
      "unknown",
    ]);
    expect(payload.runs[1]).toEqual({
      runId: "running",
      childSessionKey: "child-running",
      sourceToolCallId: "call_spawn_running",
      label: "worker",
      sessionLabel: "session",
      model: "provider/model",
      spawnMode: "run",
      createdAt: 2,
      startedAt: 3,
      status: "running",
    });
    for (const run of payload.runs) {
      expect(run).not.toHaveProperty("task");
      expect(run).not.toHaveProperty("requesterOrigin");
      expect(run).not.toHaveProperty("requesterSessionKey");
      expect(run).not.toHaveProperty("cleanup");
      expect(run).not.toHaveProperty("outcome");
    }
  });

  it("uses the requester-scoped registry query without exposing another requester", async () => {
    mocks.listSubagentRunsForRequester.mockImplementation((requesterSessionKey: string) =>
      requesterSessionKey === "agent:a:main"
        ? [
            createRun({
              runId: "run-a",
              childSessionKey: "agent:a:subagent:child",
              requesterSessionKey: "agent:a:main",
            }),
          ]
        : [
            createRun({
              runId: "run-b",
              childSessionKey: "agent:b:subagent:child",
              requesterSessionKey: "agent:b:main",
            }),
          ],
    );

    const { respond } = await invokeSubagentsList({
      requestParams: { requesterSessionKey: "agent:a:main" },
    });

    expect(readSuccessPayload(respond).runs.map((run) => run.runId)).toEqual(["run-a"]);
    expect(mocks.listSubagentRunsForRequester).toHaveBeenCalledWith("agent:a:main");
  });

  it("registers only active runs when both connId and tool-events capability are present", async () => {
    mocks.listSubagentRunsForRequester.mockReturnValue([
      createRun({ runId: "pending" }),
      createRun({ runId: "running", startedAt: 101 }),
      createRun({ runId: "terminal", endedAt: 102, outcome: { status: "ok" } }),
    ]);

    const subscribed = await invokeSubagentsList({
      connId: "conn-1",
      caps: ["tool-events"],
      scopes: ["operator.write"],
    });
    expect(subscribed.registerToolEventRecipient.mock.calls).toEqual([
      ["pending", "conn-1"],
      ["running", "conn-1"],
    ]);

    const admin = await invokeSubagentsList({
      connId: "conn-admin",
      caps: ["tool-events"],
      scopes: ["operator.admin"],
    });
    expect(admin.registerToolEventRecipient.mock.calls).toEqual([
      ["pending", "conn-admin"],
      ["running", "conn-admin"],
    ]);

    const withoutCap = await invokeSubagentsList({
      connId: "conn-2",
      caps: [],
      scopes: ["operator.write"],
    });
    expect(withoutCap.registerToolEventRecipient).not.toHaveBeenCalled();

    const withoutConn = await invokeSubagentsList({
      caps: ["tool-events"],
      scopes: ["operator.write"],
    });
    expect(withoutConn.registerToolEventRecipient).not.toHaveBeenCalled();
  });

  it("does not register tool events for read-only clients", async () => {
    mocks.listSubagentRunsForRequester.mockReturnValue([createRun({ runId: "running" })]);

    const readOnly = await invokeSubagentsList({
      connId: "conn-read",
      caps: ["tool-events"],
      scopes: ["operator.read"],
    });

    expect(readOnly.registerToolEventRecipient).not.toHaveBeenCalled();
  });
});
