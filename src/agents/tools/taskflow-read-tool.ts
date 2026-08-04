import { Type } from "@sinclair/typebox";
import { createTaskFlowStore } from "../taskflow/store.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveTaskFlowToolContext,
  type TaskFlowToolContextOptions,
} from "./taskflow-tool-context.js";

const TaskFlowReadToolSchema = Type.Object({
  taskFlowId: Type.Optional(Type.String()),
});

export function createTaskFlowReadTool(options: TaskFlowToolContextOptions): AnyAgentTool {
  return {
    label: "TaskFlow",
    name: "taskflow_read",
    sideEffect: "read_only",
    description:
      "Read the current foreground TaskFlow or a specific TaskFlow snapshot. Returns the JSON snapshot and Markdown checklist.",
    parameters: TaskFlowReadToolSchema,
    execute: async (_toolCallId, args) => {
      const ctx = resolveTaskFlowToolContext(options);
      if (!ctx.sessionKey?.trim()) {
        throw new ToolInputError("sessionKey required");
      }
      const params = args as Record<string, unknown>;
      const taskFlowId = readStringParam(params, "taskFlowId");
      const store = createTaskFlowStore({
        agentDir: ctx.agentDir,
        stateDir: ctx.stateDir,
      });
      return jsonResult(
        await store.readTaskFlow({
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          taskFlowId,
        }),
      );
    },
  };
}
