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
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt).toContain(
      "Your previous reply did not satisfy the run completion contract.",
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.images).toBeUndefined();
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.inboundMediaPaths).toBeUndefined();
    expect(result.meta.error).toBeUndefined();
  });

  it("fails the run after repeated incomplete replies", async () => {
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

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow(
      /Run completion contract violated/,
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

  it("fails the run after repeated empty terminal attempts", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }))
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }))
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }));

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow(
      /Run completion contract violated/,
    );
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

  it("fails over when a hidden provider error leaves a normal IM run empty", async () => {
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

  it("lets Feishu completion contract retry empty results before model fallback", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [] }));

    await expect(
      runEmbeddedPiAgent({
        ...baseParams,
        sessionKey: "agent:feishu-ou_x:feishu:direct:ou_x",
        hasModelFallbacks: true,
      }),
    ).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      provider: "otr",
      model: "gpt-5.5",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
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
