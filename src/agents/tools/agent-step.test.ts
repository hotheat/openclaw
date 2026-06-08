import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { runWithToolTraceParent } from "../tracing/context.js";
import { readLatestAssistantReply } from "./agent-step.js";

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed and changes were pushed." }],
        },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older output" }] },
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });
});

describe("runAgentStep", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("forwards the active tool trace parent to nested agent steps", async () => {
    const traceParent = {
      parentTraceId: "trace-id",
      parentRunId: "parent-run",
      parentSessionKey: "agent:main:main",
      parentObservationId: "tool-observation-id",
    };
    callGatewayMock.mockImplementation(async (request: unknown) => {
      const call = request as { method?: string };
      if (call.method === "agent") {
        return { runId: "child-run" };
      }
      if (call.method === "agent.wait") {
        return { status: "ok" };
      }
      if (call.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        };
      }
      return {};
    });
    const { runAgentStep } = await import("./agent-step.js");

    await runWithToolTraceParent(traceParent, async () => {
      await runAgentStep({
        sessionKey: "agent:main:child",
        message: "continue",
        extraSystemPrompt: "step",
        timeoutMs: 1000,
        sourceSessionKey: "agent:main:main",
        sourceChannel: "whatsapp",
      });
    });

    const agentCall = callGatewayMock.mock.calls
      .map((call) => call[0] as { method?: string; params?: unknown })
      .find((call) => call.method === "agent");
    expect(agentCall?.params).toMatchObject({ traceParent });
  });
});
