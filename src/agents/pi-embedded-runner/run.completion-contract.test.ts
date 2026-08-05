import "./run.overflow-compaction.mocks.shared.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedEmitAgentEvent,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.shared-test.js";
import { abortEmbeddedPiRun } from "./runs.js";

const baseParams = {
  sessionId: "test-session",
  sessionKey: "agent:main:subagent:worker-1",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
  images: [{ type: "image" as const, mimeType: "image/png", data: "Zm9v" }],
  inboundMediaPaths: ["/tmp/input.png"],
  webchatAttachmentRefs: [{ attachmentId: "53ff15ed-8063-42a2-a589-032f2874738f", ordinal: 0 }],
};

const makeAssistantMessage = (overrides: Partial<AssistantMessage>): AssistantMessage =>
  ({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "otr",
    model: "gpt-5.5",
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  }) as AssistantMessage;

describe("run completion contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRunEmbeddedAttempt.mockReset();
  });

  it("continues the same run after non-terminal text and returns the later result", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["我会继续分析并补充结果。"],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["最终结论：问题在 tool-error-latch 之外。"],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      prompt: "hello",
      suppressLifecycleTerminal: true,
      images: baseParams.images,
      inboundMediaPaths: baseParams.inboundMediaPaths,
      webchatAttachmentRefs: baseParams.webchatAttachmentRefs,
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt).toContain(
      "Your previous reply did not satisfy the run completion contract.",
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.images).toBeUndefined();
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.inboundMediaPaths).toBeUndefined();
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.webchatAttachmentRefs).toBeUndefined();
    expect(result.meta.error).toBeUndefined();
  });

  it("returns an explicit terminal error after repeated incomplete replies", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["我会继续重试。"],
          lastToolError: { toolName: "web_fetch", error: "403" },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["我会换个方法继续试。"],
          lastToolError: { toolName: "web_fetch", error: "403" },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["下一步我继续处理。"],
          lastToolError: { toolName: "web_fetch", error: "403" },
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.error?.kind).toBe("completion_contract");
    expect(result.payloads?.[0]?.text).toContain(
      "Model execution stopped before producing a final response.",
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(mockedEmitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error" }),
      }),
    );
  });

  it("returns an explicit terminal error after repeated empty terminal attempts", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }))
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }))
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.error?.kind).toBe("completion_contract");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt).toContain(
      "ended without a user-facing result",
    );
    expect(mockedEmitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error" }),
      }),
    );
  });

  it("enforces the continuation cap across changing completion classifications", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["我会继续处理。"],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }))
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["我会换个方法继续。"],
          lastToolError: { toolName: "web_fetch", error: "403" },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["最终结论：已完成。"],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.error?.kind).toBe("completion_contract");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
  });

  it("fails over when the current attempt has a provider error and no successful result", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeAssistantMessage({
          stopReason: "toolUse",
        }),
        assistantErrors: [
          makeAssistantMessage({
            stopReason: "error",
            errorMessage: "Our servers are currently overloaded. Please try again later.",
          }),
        ],
      }),
    );

    await expect(
      runEmbeddedPiAgent({
        ...baseParams,
        sessionKey: "agent:main:main",
        hasModelFallbacks: true,
      }),
    ).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      provider: "otr",
      model: "gpt-5.5",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("continues once without tools when tool results exist but final text is missing", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["我会继续整理结果。"],
          lastAssistant: makeAssistantMessage({
            stopReason: "toolUse",
          }),
          termination: {
            kind: "incomplete_tool_loop",
            cause: "awaiting_final_response",
            lastStopReason: "toolUse",
            unresolvedToolCalls: [],
            syntheticToolResultsWritten: false,
            toolWaitStatus: "idle",
          },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["最终结论：已基于现有工具结果完成汇总。"],
        }),
      );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
      hasModelFallbacks: true,
    });

    expect(result.meta.error).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      disableTools: true,
      recoveryToolPolicy: "normal",
    });
  });

  it("uses read-only recovery when read-only tool results are missing", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          termination: {
            kind: "incomplete_tool_loop",
            cause: "missing_tool_results",
            lastStopReason: "toolUse",
            unresolvedToolCalls: [
              {
                toolCallId: "fetch-1",
                toolName: "web_fetch",
                mutatingAction: false,
              },
            ],
            syntheticToolResultsWritten: true,
            toolWaitStatus: "idle_after_abort",
          },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["已改用其他只读来源完成。"],
        }),
      );

    await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });

    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      disableTools: false,
      recoveryToolPolicy: "read_only",
    });
  });

  it("does not continue the session when tool execution fails to settle", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        termination: {
          kind: "incomplete_tool_loop",
          cause: "missing_tool_results",
          lastStopReason: "toolUse",
          unresolvedToolCalls: [
            {
              toolCallId: "fetch-1",
              toolName: "web_fetch",
              mutatingAction: false,
            },
          ],
          syntheticToolResultsWritten: true,
          toolWaitStatus: "timeout",
        },
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });

    expect(result.meta.error).toMatchObject({
      kind: "incomplete_tool_loop",
      unresolvedTools: [
        {
          toolCallId: "fetch-1",
          toolName: "web_fetch",
          mutatingAction: false,
        },
      ],
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not reopen tools when mutating recovery still has no final reply", async () => {
    const unresolvedMutation = {
      kind: "incomplete_tool_loop" as const,
      cause: "missing_tool_results" as const,
      lastStopReason: "toolUse",
      unresolvedToolCalls: [
        {
          toolCallId: "send-1",
          toolName: "message",
          mutatingAction: true,
          actionFingerprint: "tool=message|action=send|to=feishu:oc_1",
        },
      ],
      syntheticToolResultsWritten: true,
      toolWaitStatus: "idle_after_abort" as const,
    };
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          termination: unresolvedMutation,
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
        }),
      );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
    });

    expect(result.meta.error).toMatchObject({
      kind: "incomplete_tool_loop",
      unresolvedTools: [
        {
          toolCallId: "send-1",
          toolName: "message",
          mutatingAction: true,
        },
      ],
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      disableTools: true,
    });
  });

  it("fails over immediately on the current model overloaded error", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeAssistantMessage({
          stopReason: "error",
          errorMessage: "Our servers are currently overloaded. Please try again later.",
        }),
      }),
    );

    await expect(
      runEmbeddedPiAgent({
        ...baseParams,
        hasModelFallbacks: true,
      }),
    ).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      provider: "otr",
      model: "gpt-5.5",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("emits a terminal lifecycle event for completion-contract early returns", async () => {
    const onAgentEvent = vi.fn();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new Error("incorrect role information"),
      }),
    );

    const result = await runEmbeddedPiAgent({ ...baseParams, onAgentEvent });

    expect(result.meta.error?.kind).toBe("role_ordering");
    expect(mockedEmitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "end" }),
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "end" }),
    });
  });

  it("emits an aborted terminal lifecycle event when a completion-contract run is cancelled", async () => {
    const onAgentEvent = vi.fn();

    const run = runEmbeddedPiAgent({ ...baseParams, onAgentEvent });
    abortEmbeddedPiRun(baseParams.sessionId);

    const result = await run;

    expect(result.meta.aborted).toBe(true);
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(mockedEmitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "end", aborted: true }),
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "end", aborted: true }),
    });
  });
});
