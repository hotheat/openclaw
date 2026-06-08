import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsLangfuseRuntime } from "./service.js";

const ROOT_OBSERVATION_ID = "0123456789abcdef";
const TOOL_OBSERVATION_ID = "1234567890abcdef";
const SPAN_OBSERVATION_ID = "abcdef1234567890";
const CHILD_OBSERVATION_ID = "fedcba0987654321";
const TRACE_ID = "1234567890abcdef1234567890abcdef";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createContext(
  config: OpenClawPluginServiceContext["config"],
): OpenClawPluginServiceContext {
  return {
    config,
    logger: createLogger(),
    stateDir: "/tmp/openclaw-diagnostics-langfuse-test",
  };
}

describe("diagnostics-langfuse service", () => {
  it("fails fast when enabled without required credentials", async () => {
    const runtime = createDiagnosticsLangfuseRuntime();

    await expect(
      runtime.service.start(
        createContext({
          diagnostics: {
            enabled: true,
            langfuse: {
              enabled: true,
              host: "http://localhost:3005",
            },
          },
        }),
      ),
    ).rejects.toThrow(/publicKey/i);
  });

  it("registers a sink that creates nested agent, generation, and tool observations", async () => {
    const generation = { update: vi.fn(), end: vi.fn(), id: "generation-id" };
    const tool = { update: vi.fn(), end: vi.fn(), id: TOOL_OBSERVATION_ID };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn((name: string) => {
        if (name === "openclaw.llm.generation") {
          return generation;
        }
        if (name === "openclaw.tool.sessions_spawn") {
          return tool;
        }
        throw new Error(`unexpected observation: ${name}`);
      }),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(() => root),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
            captureMode: "llm_text",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "session:key",
      provider: "openai",
      model: "gpt-5.1",
    });
    const llm = await run?.startGeneration?.({
      provider: "openai",
      model: "gpt-5.1",
      prompt: "hello",
      historyMessages: [],
      imagesCount: 0,
    });
    await llm?.end({ assistantTexts: ["world"], usage: { total: 2 } });
    const toolTrace = await run?.startTool?.({
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      params: { message: "research" },
    });
    await toolTrace?.end({ result: { runId: "child-run" }, durationMs: 3 });
    await run?.end?.({ success: true });

    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run",
      expect.objectContaining({
        metadata: expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
      }),
      expect.objectContaining({ asType: "agent" }),
    );
    expect(root.startObservation).toHaveBeenCalledWith(
      "openclaw.llm.generation",
      expect.objectContaining({ input: expect.objectContaining({ prompt: "hello" }) }),
      expect.objectContaining({ asType: "generation" }),
    );
    expect(root.startObservation).toHaveBeenCalledWith(
      "openclaw.tool.sessions_spawn",
      expect.objectContaining({
        metadata: expect.objectContaining({ toolName: "sessions_spawn" }),
      }),
      expect.objectContaining({ asType: "tool" }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: ["world"], usageDetails: { total: 2 } }),
    );
    expect(tool.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: { runId: "child-run" } }),
    );
    expect(root.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: { success: true } }),
    );
    expect(root.end).toHaveBeenCalled();
    expect(run?.traceParent).toEqual({
      parentTraceId: TRACE_ID,
      parentRunId: "run-1",
      parentSessionKey: "session:key",
      parentObservationId: ROOT_OBSERVATION_ID,
    });
  });

  it("exposes sessions_spawn tool observation as the child trace parent", async () => {
    const tool = { update: vi.fn(), end: vi.fn(), id: TOOL_OBSERVATION_ID };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(() => tool),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(() => root),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "session:key",
    });
    const toolTrace = await run?.startTool?.({
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      params: { task: "research" },
    });

    expect((toolTrace as { traceParent?: unknown } | undefined)?.traceParent).toEqual({
      parentTraceId: TRACE_ID,
      parentRunId: "run-1",
      parentSessionKey: "session:key",
      parentObservationId: TOOL_OBSERVATION_ID,
    });
  });

  it("records generic spans under the agent run", async () => {
    const span = { update: vi.fn(), end: vi.fn(), id: SPAN_OBSERVATION_ID };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(() => span),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(() => root),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
    });
    await run?.recordSpan?.({
      name: "openclaw.skills.resolve",
      output: {
        count: 2,
        skills: [
          { name: "pdf-generator", source: "workspace" },
          { name: "imagegen", source: "bundled" },
        ],
      },
      metadata: {
        promptChars: 256,
      },
    });

    expect(root.startObservation).toHaveBeenCalledWith(
      "openclaw.skills.resolve",
      expect.objectContaining({
        output: expect.objectContaining({ count: 2 }),
        metadata: expect.objectContaining({ promptChars: 256 }),
      }),
      expect.objectContaining({ asType: "span" }),
    );
    expect(span.end).toHaveBeenCalled();
  });

  it("keeps the exporter active when Langfuse auth check is temporarily unreachable", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockRejectedValue(new Error("fetch failed")),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(() => root),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    const ctx = createContext({
      diagnostics: {
        enabled: true,
        langfuse: {
          enabled: true,
          host: "http://localhost:3005",
          publicKey: "pk",
          secretKey: "sk",
        },
      },
    });

    await expect(runtime.service.start(ctx)).resolves.toBeUndefined();
    await runtime.sink.startRun({ runId: "run-1", sessionId: "session-1" });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Langfuse auth check failed"),
    );
    expect(client.startObservation).toHaveBeenCalled();
  });

  it("shuts down the client when startup auth explicitly fails", async () => {
    const client = {
      authCheck: vi.fn().mockResolvedValue(false),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });

    await expect(
      runtime.service.start(
        createContext({
          diagnostics: {
            enabled: true,
            langfuse: {
              enabled: true,
              host: "http://localhost:3005",
              publicKey: "pk",
              secretKey: "sk",
            },
          },
        }),
      ),
    ).rejects.toThrow(/auth check failed/i);

    expect(client.shutdown).toHaveBeenCalledTimes(1);
    await runtime.sink.startRun({ runId: "run-after-failed-start", sessionId: "session-1" });
    expect(client.startObservation).not.toHaveBeenCalled();
  });

  it("skips heartbeat runs before creating Langfuse observations", async () => {
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "heartbeat-run",
      sessionId: "heartbeat-session",
      channel: "heartbeat",
      messageProvider: "heartbeat",
    });

    expect(run).toBeUndefined();
    expect(client.createTraceId).not.toHaveBeenCalled();
    expect(client.startObservation).not.toHaveBeenCalled();
  });

  it("does not attach a synthetic parent span to top-level runs", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(() => root),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "session:key",
    });

    expect(client.createTraceId).toHaveBeenCalledWith("run-1");
    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run",
      expect.any(Object),
      expect.not.objectContaining({ parentSpanContext: expect.any(Object) }),
    );
    expect(run?.traceParent?.parentTraceId).toBe(TRACE_ID);
  });

  it("reuses incoming trace id only when a real parent observation id exists", async () => {
    const parentTraceId = "1234567890abcdef1234567890abcdef";
    const parentObservationId = "abcdef1234567890";
    const root = {
      id: ROOT_OBSERVATION_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(() => root),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "child-run",
      sessionId: "session-1",
      traceParent: {
        parentTraceId,
        parentObservationId,
        parentRunId: "parent-run",
      },
    });

    expect(client.createTraceId).not.toHaveBeenCalled();
    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run",
      expect.any(Object),
      expect.objectContaining({
        parentSpanContext: {
          traceId: parentTraceId,
          spanId: parentObservationId,
          traceFlags: 1,
        },
      }),
    );
    expect(run?.traceParent?.parentTraceId).toBe(parentTraceId);
  });

  it("emits observation ids that can be reused as child parent span context", async () => {
    const parentRoot = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const childRoot = {
      id: CHILD_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn().mockReturnValueOnce(parentRoot).mockReturnValueOnce(childRoot),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
          },
        },
      }),
    );

    const parentRun = await runtime.sink.startRun({
      runId: "parent-run",
      sessionId: "session-1",
    });
    const childRun = await runtime.sink.startRun({
      runId: "child-run",
      sessionId: "session-1",
      traceParent: parentRun?.traceParent,
    });

    expect(client.startObservation).toHaveBeenNthCalledWith(
      2,
      "openclaw.agent.run",
      expect.any(Object),
      expect.objectContaining({
        parentSpanContext: {
          traceId: TRACE_ID,
          spanId: ROOT_OBSERVATION_ID,
          traceFlags: 1,
        },
      }),
    );
    expect(childRun?.traceParent).toEqual({
      parentTraceId: TRACE_ID,
      parentRunId: "child-run",
      parentSessionKey: undefined,
      parentObservationId: CHILD_OBSERVATION_ID,
    });
  });

  it("omits route and local path metadata in safe mode", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    let rootAttributes: { metadata?: Record<string, unknown> } | undefined;
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      startObservation: vi.fn(
        (_name: string, attributes?: { metadata?: Record<string, unknown> }) => {
          rootAttributes = attributes;
          return root;
        },
      ),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const runtime = createDiagnosticsLangfuseRuntime({
      clientFactory: vi.fn().mockResolvedValue(client),
    });
    await runtime.service.start(
      createContext({
        diagnostics: {
          enabled: true,
          langfuse: {
            enabled: true,
            host: "http://localhost:3005",
            publicKey: "pk",
            secretKey: "sk",
            captureMode: "safe",
          },
        },
      }),
    );

    await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:feishu-ou_private:main",
      agentId: "feishu-ou_private",
      channel: "feishu",
      messageProvider: "feishu",
      lane: "subagent",
      provider: "openai",
      model: "gpt-5.1",
      workspaceDir: "/home/xiaolu/.openclaw/workspace-feishu-ou_private",
      spawnedBy: "agent:feishu-ou_parent:main",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:feishu-ou_parent:main",
        sourceChannel: "feishu",
        sourceTool: "sessions_send",
      },
      traceParent: {
        parentRunId: "parent-run",
        parentTraceId: "parent-trace",
        parentSessionKey: "agent:feishu-ou_parent:main",
      },
    });

    const metadata = rootAttributes?.metadata;
    expect(metadata).toMatchObject({
      serviceName: "openclaw-gateway",
      channel: "feishu",
      messageProvider: "feishu",
      lane: "subagent",
      provider: "openai",
      model: "gpt-5.1",
      inputProvenanceKind: "inter_session",
      inputProvenanceSourceChannel: "feishu",
      inputProvenanceSourceTool: "sessions_send",
    });
    expect(metadata).not.toHaveProperty("runId");
    expect(metadata).not.toHaveProperty("sessionId");
    expect(metadata).not.toHaveProperty("agentId");
    expect(metadata).not.toHaveProperty("sessionKey");
    expect(metadata).not.toHaveProperty("workspaceDir");
    expect(metadata).not.toHaveProperty("spawnedBy");
    expect(metadata).not.toHaveProperty("inputProvenanceSourceSessionKey");
    expect(metadata).not.toHaveProperty("parentRunId");
    expect(metadata).not.toHaveProperty("parentTraceId");
    expect(metadata).not.toHaveProperty("parentSessionKey");
  });
});
