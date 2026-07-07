import { describe, expect, it, vi } from "vitest";
import type { TaskFlow } from "../../../src/agents/taskflow/types.js";
import { TaskFlowFeishuPublisher } from "./taskflow-progress.js";

class FakeStreamingSession {
  readonly calls: Array<{ method: string; text?: string; chatId?: string }> = [];
  active = false;

  async start(chatId: string) {
    this.active = true;
    this.calls.push({ method: "start", chatId });
  }

  async update(text: string) {
    this.calls.push({ method: "update", text });
  }

  async close(text?: string) {
    this.active = false;
    this.calls.push({ method: "close", text });
  }

  isActive() {
    return this.active;
  }
}

function makeTaskFlow(status: TaskFlow["status"], revision: number): TaskFlow {
  return {
    id: "tf_feishu",
    scope: "local",
    agentId: "main",
    ownerSessionKey: "agent:main:dm:user-1",
    title: "Feishu progress",
    status,
    revision,
    createdAt: "2026-06-18T08:00:00.000Z",
    updatedAt: "2026-06-18T08:01:00.000Z",
    items: [
      {
        id: "item_a",
        title: "Render progress",
        status: "in_progress",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:01:00.000Z",
      },
    ],
    subscribers: [{ channel: "feishu", accountId: "work", chatId: "oc_1", createdAt: "now" }],
    permissions: [],
  };
}

function makeTaskFlowWithItemStatuses(): TaskFlow {
  return {
    ...makeTaskFlow("active", 5),
    title: "Feishu checklist",
    items: [
      {
        id: "done",
        title: "Completed item",
        status: "completed",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:01:00.000Z",
      },
      {
        id: "active",
        title: "Active item",
        status: "in_progress",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:01:00.000Z",
      },
      {
        id: "todo",
        title: "Todo item",
        status: "pending",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:01:00.000Z",
      },
      {
        id: "blocked",
        title: "Blocked item",
        status: "blocked",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:01:00.000Z",
      },
      {
        id: "canceled",
        title: "Canceled item",
        status: "canceled",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:01:00.000Z",
      },
    ],
  };
}

describe("TaskFlowFeishuPublisher", () => {
  it("starts once, skips duplicate revisions, keeps blocked open, and closes completed", async () => {
    const sessions: FakeStreamingSession[] = [];
    const publisher = new TaskFlowFeishuPublisher({
      createSession: () => {
        const session = new FakeStreamingSession();
        sessions.push(session);
        return session;
      },
      log: vi.fn(),
      error: vi.fn(),
    });

    await publisher.publish({ snapshot: makeTaskFlow("active", 1), markdown: "active" });
    await publisher.publish({ snapshot: makeTaskFlow("active", 1), markdown: "duplicate" });
    await publisher.publish({ snapshot: makeTaskFlow("blocked", 2), markdown: "blocked" });
    await publisher.publish({ snapshot: makeTaskFlow("completed", 3), markdown: "completed" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.calls.map((call) => call.method)).toEqual([
      "start",
      "update",
      "update",
      "close",
    ]);
    expect(sessions[0]?.calls[0]).toEqual({ method: "start", chatId: "oc_1" });
    expect(sessions[0]?.calls[1]?.text).toContain("Status: active");
    expect(sessions[0]?.calls[2]?.text).toContain("Status: blocked");
    expect(sessions[0]?.calls[3]?.text).toContain("Status: completed");
  });

  it("labels completed taskflow cards as completed instead of active", async () => {
    const sessions: FakeStreamingSession[] = [];
    const publisher = new TaskFlowFeishuPublisher({
      createSession: () => {
        const session = new FakeStreamingSession();
        sessions.push(session);
        return session;
      },
      log: vi.fn(),
      error: vi.fn(),
    });

    await publisher.publish({ snapshot: makeTaskFlow("completed", 1), markdown: "completed" });

    const text = sessions[0]?.calls.find((call) => call.method === "close")?.text;

    expect(text).toContain("## Completed TaskFlow");
    expect(text).not.toContain("## Active TaskFlow");
  });

  it("logs delivery errors without throwing", async () => {
    const error = vi.fn();
    const publisher = new TaskFlowFeishuPublisher({
      createSession: () => ({
        start: async () => {
          throw new Error("feishu unavailable");
        },
        update: async () => undefined,
        close: async () => undefined,
        isActive: () => false,
      }),
      log: vi.fn(),
      error,
    });

    await expect(
      publisher.publish({ snapshot: makeTaskFlow("active", 1), markdown: "active" }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("feishu unavailable"));
  });

  it("retries the same revision after a transient delivery failure", async () => {
    const session = new FakeStreamingSession();
    const error = vi.fn();
    let attempts = 0;
    const publisher = new TaskFlowFeishuPublisher({
      createSession: () => ({
        start: async (chatId: string) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("feishu unavailable");
          }
          await session.start(chatId);
        },
        update: async (text: string) => session.update(text),
        close: async (text?: string) => session.close(text),
        isActive: () => session.isActive(),
      }),
      log: vi.fn(),
      error,
    });

    await publisher.publish({ snapshot: makeTaskFlow("active", 1), markdown: "first" });
    await publisher.publish({ snapshot: makeTaskFlow("active", 1), markdown: "retry" });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("feishu unavailable"));
    expect(session.calls.map((call) => call.method)).toEqual(["start", "update"]);
    expect(session.calls[0]).toEqual({ method: "start", chatId: "oc_1" });
    expect(session.calls[1]?.text).toContain("TaskFlow: tf_feishu");
  });

  it("renders taskflows with Feishu-safe status markers instead of GFM checkboxes", async () => {
    const sessions: FakeStreamingSession[] = [];
    const publisher = new TaskFlowFeishuPublisher({
      createSession: () => {
        const session = new FakeStreamingSession();
        sessions.push(session);
        return session;
      },
      log: vi.fn(),
      error: vi.fn(),
    });

    await publisher.publish({
      snapshot: makeTaskFlowWithItemStatuses(),
      markdown: `## Active TaskFlow

TaskFlow: tf_feishu
Title: Feishu checklist
Revision: 5
Status: active

- [x] Completed item
- [~] Active item
- [ ] Todo item
- [!] Blocked item
- [-] Canceled item

Rules:
- Update this TaskFlow with taskflow_update when item status changes.`,
    });

    const text = sessions[0]?.calls.find((call) => call.method === "update")?.text;

    expect(text).toContain("✅ Completed item");
    expect(text).toContain("⏳ Active item");
    expect(text).toContain("○ Todo item");
    expect(text).toContain("⚠️ Blocked item");
    expect(text).toContain("✕ Canceled item");
    expect(text).not.toContain("- [x]");
    expect(text).not.toContain("[~]");
    expect(text).not.toContain("Rules:");
  });
});
