import { describe, expect, it } from "vitest";
import { renderTaskFlowMarkdown } from "./markdown.js";
import type { TaskFlow } from "./types.js";

describe("renderTaskFlowMarkdown", () => {
  it("renders a stable checklist from the JSON snapshot", () => {
    const taskFlow: TaskFlow = {
      id: "tf_render",
      scope: "local",
      agentId: "main",
      ownerSessionKey: "agent:main:dm:user-1",
      title: "Render",
      status: "active",
      revision: 3,
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:01:00.000Z",
      activeItemId: "item_impl",
      items: [
        {
          id: "item_impl",
          title: "Implement store",
          status: "in_progress",
          createdAt: "2026-06-18T08:00:00.000Z",
          updatedAt: "2026-06-18T08:01:00.000Z",
        },
        {
          id: "item_test",
          parentId: "item_impl",
          title: "Add tests",
          status: "completed",
          evidence: [{ kind: "file", value: "src/agents/taskflow/store.test.ts" }],
          createdAt: "2026-06-18T08:00:00.000Z",
          updatedAt: "2026-06-18T08:01:00.000Z",
        },
        {
          id: "item_blocked",
          title: "Publish event",
          status: "blocked",
          createdAt: "2026-06-18T08:00:00.000Z",
          updatedAt: "2026-06-18T08:01:00.000Z",
        },
      ],
      subscribers: [],
      permissions: [],
    };

    expect(renderTaskFlowMarkdown(taskFlow)).toBe(`## Active TaskFlow

TaskFlow: tf_render
Title: Render
Revision: 3
Status: active

- [~] Implement store
  - [x] Add tests
    Evidence: src/agents/taskflow/store.test.ts
- [!] Publish event

Rules:
- Update this TaskFlow with taskflow_update when item status changes.
- If taskflow_update returns revision_conflict, call taskflow_read, merge your intended change, then retry with the latest revision.`);
  });
});
