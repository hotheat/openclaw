import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { jsonResult } from "../tools/common.js";
import { getCurrentToolTraceParent } from "./context.js";
import { wrapToolsWithAgentTracing } from "./tools.js";
import type { AgentTraceRunHandle } from "./types.js";

describe("wrapToolsWithAgentTracing", () => {
  it("runs tool execution with the tool trace parent in context", async () => {
    const traceParent = {
      parentTraceId: "trace-id",
      parentRunId: "run-id",
      parentSessionKey: "agent:main:main",
      parentObservationId: "tool-observation-id",
    };
    const end = vi.fn();
    const startTool = vi.fn(() => ({ traceParent, end }));
    const traceRun: AgentTraceRunHandle = { startTool };
    let activeTraceParent: unknown;
    const tool: AnyAgentTool = {
      name: "sessions_spawn",
      label: "sessions_spawn",
      description: "",
      parameters: {},
      async execute() {
        activeTraceParent = getCurrentToolTraceParent();
        return jsonResult({ status: "ok" });
      },
    };

    const [wrapped] = wrapToolsWithAgentTracing({ tools: [tool], traceRun });
    const result = await wrapped.execute("tool-call-1", { task: "research" });

    expect(result.details).toEqual({ status: "ok" });
    expect(activeTraceParent).toEqual(traceParent);
    expect(startTool).toHaveBeenCalledWith({
      toolName: "sessions_spawn",
      toolCallId: "tool-call-1",
      params: { task: "research" },
      startedAt: expect.any(Number),
    });
    expect(end).toHaveBeenCalledWith({
      result,
      durationMs: expect.any(Number),
      endedAt: expect.any(Number),
      error: undefined,
    });
  });

  it("ends the tool trace when execution throws", async () => {
    const end = vi.fn();
    const traceRun: AgentTraceRunHandle = {
      startTool: () => ({ end }),
    };
    const tool: AnyAgentTool = {
      name: "exec",
      label: "exec",
      description: "",
      parameters: {},
      async execute() {
        throw new Error("tool failed");
      },
    };

    const [wrapped] = wrapToolsWithAgentTracing({ tools: [tool], traceRun });
    await expect(wrapped.execute("tool-call-2", { command: "false" })).rejects.toThrow(
      "tool failed",
    );

    expect(end).toHaveBeenCalledWith({
      result: undefined,
      error: "tool failed",
      durationMs: expect.any(Number),
      endedAt: expect.any(Number),
    });
  });

  it("marks reads of prompt skill files as skill invocations", async () => {
    const startTool = vi.fn(() => ({ end: vi.fn() }));
    const traceRun: AgentTraceRunHandle = { startTool };
    const readTool: AnyAgentTool = {
      name: "read",
      label: "read",
      description: "",
      parameters: {},
      async execute() {
        return jsonResult({ status: "ok" });
      },
    };
    const [wrapped] = wrapToolsWithAgentTracing({
      tools: [readTool],
      traceRun,
      workspaceDir: "/tmp/workspace",
      skillFiles: [
        {
          name: "imagegen",
          filePath: "/tmp/workspace/skills/imagegen/SKILL.md",
        },
      ],
    });

    await wrapped.execute("tool-skill", {
      file_path: "skills/imagegen/SKILL.md",
    });
    await wrapped.execute("tool-file", {
      path: "skills/not-loaded/SKILL.md",
    });

    expect(startTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "read",
        skillName: "imagegen",
      }),
    );
    expect(startTool).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({
        skillName: expect.anything(),
      }),
    );
  });
});
