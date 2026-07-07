import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools taskflow", () => {
  it("registers taskflow read and update tools when agent context is available", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dm:user-1",
      agentDir: "/tmp/openclaw-agent",
      requesterAgentIdOverride: "main",
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["taskflow_read", "taskflow_update"]),
    );
  });
});
