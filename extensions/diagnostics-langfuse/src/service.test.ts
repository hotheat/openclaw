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

function createPropagateAttributesMock() {
  return vi.fn(<T>(_params: Record<string, unknown>, fn: () => T) => fn());
}

function propagatedMetadataStrings(attributes: unknown): string[] {
  const metadata =
    typeof attributes === "object" && attributes !== null && "metadata" in attributes
      ? (attributes as { metadata?: unknown }).metadata
      : undefined;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  return Object.values(metadata).filter((value): value is string => typeof value === "string");
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
      propagateAttributes: createPropagateAttributesMock(),
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
    expect(client.propagateAttributes).toHaveBeenCalledTimes(3);
    for (const [attributes] of client.propagateAttributes.mock.calls) {
      expect(attributes).toMatchObject({
        traceName: "openclaw.agent.run",
        sessionId: "session-1",
        metadata: expect.objectContaining({
          runId: "run-1",
          sessionId: "session-1",
          provider: "openai",
          model: "gpt-5.1",
        }),
      });
    }
  });

  it("propagates searchable run metadata through OTEL attributes", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
      agentId: "main",
      channel: "feishu",
      messageProvider: "feishu",
      metadata: {
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
      },
      startedAt: 1_762_000_000_000,
    });

    const propagation = client.propagateAttributes.mock.calls[0]?.[0];
    expect(propagation).toMatchObject({
      traceName: "openclaw.agent.run main feishu",
      userId: "ou_626a753df7ba7cc68063270223eddde5",
      sessionId: "session-1",
      metadata: expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
        agentId: "main",
        channel: "feishu",
        messageProvider: "feishu",
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
      }),
    });
    const propagationMetadata = propagation?.metadata as Record<string, string> | undefined;
    expect(propagationMetadata?.searchTerms).toContain("ou_626a753df7ba7cc68063270223eddde5");
    expect(propagationMetadata?.searchTerms).toContain("main");
    expect(propagationMetadata?.searchTerms).toContain(
      "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
    );
    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run main feishu",
      expect.objectContaining({
        metadata: expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
      }),
      expect.objectContaining({
        asType: "agent",
        startTime: new Date(1_762_000_000_000),
      }),
    );
  });

  it("uses the searchable trace name as the top-level root observation name", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey:
        "agent:feishu-ou_626a753df7ba7cc68063270223eddde5:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
      agentId: "feishu-ou_626a753df7ba7cc68063270223eddde5",
      channel: "feishu",
      messageProvider: "feishu",
      metadata: {
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
      },
    });

    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run feishu-ou_626a753df7ba7cc68063270223eddde5 feishu",
      expect.any(Object),
      expect.objectContaining({ asType: "agent" }),
    );
  });

  it("starts runs through OTEL without public ingestion writes", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
    });

    expect(run?.traceParent).toMatchObject({
      parentTraceId: TRACE_ID,
      parentRunId: "run-1",
      parentObservationId: ROOT_OBSERVATION_ID,
    });
    expect(client.propagateAttributes).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveProperty("upsertTrace");
    expect(client).not.toHaveProperty("createObservation");
  });

  it("creates inherited child runs with OTEL parent span context only", async () => {
    const parentTraceId = "1234567890abcdef1234567890abcdef";
    const parentObservationId = "abcdef1234567890";
    const root = {
      id: CHILD_OBSERVATION_ID,
      traceId: parentTraceId,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    await runtime.sink.startRun({
      runId: "child-run",
      sessionId: "child-session",
      sessionKey: "agent:child:main",
      agentId: "child",
      channel: "feishu",
      senderId: "ou_child",
      traceParent: {
        parentTraceId,
        parentObservationId,
        parentRunId: "parent-run",
        parentSessionKey: "parent-session",
      },
    });

    expect(client.createTraceId).not.toHaveBeenCalled();
    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run",
      expect.objectContaining({
        metadata: expect.objectContaining({
          runId: "child-run",
          sessionId: "child-session",
          agentId: "child",
          parentRunId: "parent-run",
        }),
      }),
      expect.objectContaining({
        parentSpanContext: {
          traceId: parentTraceId,
          spanId: parentObservationId,
          traceFlags: 1,
        },
      }),
    );
    const propagation = client.propagateAttributes.mock.calls[0]?.[0];
    expect(propagation).toEqual({
      traceName: "openclaw.agent.run",
    });
    expect(client).not.toHaveProperty("upsertTrace");
    expect(client).not.toHaveProperty("createObservation");
  });

  it("does not propagate child trace identity for inherited child runs", async () => {
    const parentTraceId = "1234567890abcdef1234567890abcdef";
    const parentObservationId = "abcdef1234567890";
    const root = {
      id: CHILD_OBSERVATION_ID,
      traceId: parentTraceId,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    await runtime.sink.startRun({
      runId: "child-run",
      sessionId: "child-session",
      sessionKey: "agent:child:main",
      agentId: "child",
      channel: "feishu",
      senderId: "ou_child",
      traceParent: {
        parentTraceId,
        parentObservationId,
        parentRunId: "parent-run",
        parentSessionKey: "parent-session",
      },
    });

    const propagation = client.propagateAttributes.mock.calls[0]?.[0];
    expect(propagation).toEqual({
      traceName: "openclaw.agent.run",
    });
  });

  it("flushes and shuts down the OTEL provider on stop", async () => {
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    await runtime.sink.startRun({
      runId: "run-1",
      sessionId: "session-1",
    });
    await runtime.service.stop?.(
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

    expect(client.flush).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it("adds subagent ids to parent OTEL observation search metadata", async () => {
    const eventObservation = { end: vi.fn() };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(
        (_name: string, _attributes?: { metadata?: Record<string, unknown> }) => eventObservation,
      ),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
      runId: "parent-run",
      sessionId: "session-1",
      sessionKey: "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
      agentId: "main",
      channel: "feishu",
      metadata: {
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
      },
    });
    const childAgentId = "feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3";
    const childSessionKey =
      "agent:feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3";
    await run?.recordSubagentLifecycle?.({
      phase: "spawned",
      runId: "child-run",
      parentRunId: "parent-run",
      childSessionKey,
      agentId: childAgentId,
      label: "researcher",
    });

    expect(root.update).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          subagentIds: [childAgentId],
          subagentSessionKeys: [childSessionKey],
          searchTerms: expect.arrayContaining([
            "parent-run",
            "session-1",
            "ou_626a753df7ba7cc68063270223eddde5",
            childAgentId,
            childSessionKey,
          ]),
        }),
      }),
    );
    expect(root.startObservation).toHaveBeenCalledWith(
      "openclaw.subagent.spawned",
      expect.objectContaining({
        metadata: expect.objectContaining({
          subagentIds: [childAgentId],
          subagentSessionKeys: [childSessionKey],
          searchTerms: expect.arrayContaining([childAgentId, childSessionKey]),
        }),
      }),
      expect.objectContaining({ asType: "event" }),
    );
    const lifecyclePropagation = client.propagateAttributes.mock.calls.at(-1)?.[0];
    expect(lifecyclePropagation).toMatchObject({
      traceName: "openclaw.agent.run main feishu",
      userId: "ou_626a753df7ba7cc68063270223eddde5",
      sessionId: "session-1",
      metadata: expect.objectContaining({
        runId: "parent-run",
        sessionId: "session-1",
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
        subagentIds: childAgentId,
        subagentSessionKeys: childSessionKey,
      }),
    });
    const lifecyclePropagationMetadata = lifecyclePropagation?.metadata as
      | Record<string, string>
      | undefined;
    expect(lifecyclePropagationMetadata?.searchTerms).toContain("parent-run");
    expect(lifecyclePropagationMetadata?.searchTerms).toContain("session-1");
    expect(lifecyclePropagationMetadata?.searchTerms).toContain(
      "ou_626a753df7ba7cc68063270223eddde5",
    );
    expect(Object.values(lifecyclePropagationMetadata ?? {})).toContain(childAgentId);
    expect(Object.values(lifecyclePropagationMetadata ?? {})).toContain(childSessionKey);

    await run?.recordSpan?.({
      name: "openclaw.after-subagent",
      metadata: { promptChars: 32 },
    });
    const spanPropagation = client.propagateAttributes.mock.calls.at(-1)?.[0];
    expect(spanPropagation?.metadata).toMatchObject({
      subagentIds: childAgentId,
      subagentSessionKeys: childSessionKey,
    });
    const spanPropagationMetadata = spanPropagation?.metadata as Record<string, string> | undefined;
    expect(spanPropagationMetadata?.searchTerms).toContain("parent-run");
    expect(spanPropagationMetadata?.searchTerms).toContain("ou_626a753df7ba7cc68063270223eddde5");
    expect(Object.values(spanPropagationMetadata ?? {})).toContain(childAgentId);
    expect(Object.values(spanPropagationMetadata ?? {})).toContain(childSessionKey);
  });

  it("propagates updated subagent search metadata to observations created after spawn", async () => {
    const observation = {
      id: CHILD_OBSERVATION_ID,
      update: vi.fn(),
      end: vi.fn(),
    };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(() => observation),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    const childAgentId = "feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3";
    const childSessionKey =
      "agent:feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3";
    const run = await runtime.sink.startRun({
      runId: "parent-run",
      sessionId: "session-1",
      sessionKey: "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
      agentId: "main",
      channel: "feishu",
      metadata: {
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
      },
    });
    await run?.recordSubagentLifecycle?.({
      phase: "spawned",
      runId: "child-run",
      parentRunId: "parent-run",
      childSessionKey,
      agentId: childAgentId,
      label: "researcher",
    });
    await run?.startGeneration?.({
      provider: "openai",
      model: "gpt-5.1",
      prompt: "continue",
      historyMessages: [],
      imagesCount: 0,
    });
    await run?.startTool?.({
      toolName: "sessions_send",
      toolCallId: "tool-1",
      params: { message: "ping" },
    });
    await run?.recordSpan?.({
      name: "openclaw.after-subagent",
      metadata: { promptChars: 32 },
    });

    const laterPropagations = client.propagateAttributes.mock.calls.slice(2).map(([attributes]) => {
      return attributes as { metadata?: Record<string, string> };
    });
    expect(laterPropagations).toHaveLength(3);
    for (const propagation of laterPropagations) {
      expect(propagation.metadata).toMatchObject({
        subagentIds: childAgentId,
        subagentSessionKeys: childSessionKey,
      });
      expect(propagation.metadata?.searchTerms).toContain("parent-run");
      expect(propagation.metadata?.searchTerms).toContain("ou_626a753df7ba7cc68063270223eddde5");
      expect(Object.values(propagation.metadata ?? {})).toContain(childAgentId);
      expect(Object.values(propagation.metadata ?? {})).toContain(childSessionKey);
    }
  });

  it("keeps propagated metadata strings within the Langfuse SDK limit", async () => {
    const eventObservation = { end: vi.fn() };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(
        (_name: string, _attributes?: { metadata?: Record<string, unknown> }) => eventObservation,
      ),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
      runId: "parent-run",
      sessionId: "session-1",
      sessionKey: "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
      agentId: "main",
      channel: "feishu",
      metadata: {
        senderId: "ou_626a753df7ba7cc68063270223eddde5",
      },
    });
    await run?.recordSubagentLifecycle?.({
      phase: "spawned",
      runId: "child-run",
      parentRunId: "parent-run",
      childSessionKey:
        "agent:feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3",
      agentId: "feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3",
      label: "researcher",
    });

    for (const [attributes] of client.propagateAttributes.mock.calls) {
      for (const value of propagatedMetadataStrings(attributes)) {
        expect(value.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("keeps route and user identifiers out of propagated OTEL attributes in safe mode", async () => {
    const eventObservation = { end: vi.fn() };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(
        (_name: string, _attributes?: { metadata?: Record<string, unknown> }) => eventObservation,
      ),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
      spawnedBy: "agent:parent:main",
      senderId: "ou_626a753df7ba7cc68063270223eddde5",
      metadata: {
        userId: "ou_626a753df7ba7cc68063270223eddde5",
      },
      traceParent: {
        parentRunId: "parent-run",
        parentTraceId: "parent-trace",
        parentSessionKey: "agent:feishu-ou_parent:main",
      },
    });

    const propagation = client.propagateAttributes.mock.calls[0]?.[0];
    expect(propagation).toMatchObject({
      traceName: "openclaw.agent.run",
    });
    expect(propagation).not.toHaveProperty("sessionId");
    expect(propagation).not.toHaveProperty("userId");
    expect(propagation.metadata).toMatchObject({
      serviceName: "openclaw-gateway",
      channel: "feishu",
      messageProvider: "feishu",
      lane: "subagent",
      provider: "openai",
      model: "gpt-5.1",
    });
    expect(propagation.metadata).not.toHaveProperty("runId");
    expect(propagation.metadata).not.toHaveProperty("sessionId");
    expect(propagation.metadata).not.toHaveProperty("sessionKey");
    expect(propagation.metadata).not.toHaveProperty("agentId");
    expect(propagation.metadata).not.toHaveProperty("senderId");
    expect(propagation.metadata).not.toHaveProperty("userId");
    expect(propagation.metadata).not.toHaveProperty("parentRunId");
    expect(propagation.metadata).not.toHaveProperty("parentTraceId");
    expect(propagation.metadata).not.toHaveProperty("parentSessionKey");
    expect(propagation.metadata).not.toHaveProperty("workspaceDir");
    expect(propagation.metadata).not.toHaveProperty("spawnedBy");
    expect(propagation.metadata).not.toHaveProperty("searchTerms");
  });

  it("does not append subagent identifiers in safe mode", async () => {
    const eventObservation = { end: vi.fn() };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn(
        (_name: string, _attributes?: { metadata?: Record<string, unknown> }) => eventObservation,
      ),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
            captureMode: "safe",
          },
        },
      }),
    );

    const run = await runtime.sink.startRun({
      runId: "parent-run",
      sessionId: "session-1",
      sessionKey: "agent:main:feishu:direct:ou_626a753df7ba7cc68063270223eddde5",
      agentId: "main",
      channel: "feishu",
      senderId: "ou_626a753df7ba7cc68063270223eddde5",
    });
    await run?.recordSubagentLifecycle?.({
      phase: "spawned",
      runId: "child-run",
      parentRunId: "parent-run",
      childSessionKey:
        "agent:feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3",
      agentId: "feishu:g-agent-researcher-subagent-8327051f-d4c0-4cb1-a2f7-14fc763597b3",
      label: "researcher",
    });

    expect(root.update).not.toHaveBeenCalled();
    const eventMetadata = root.startObservation.mock.calls[0]?.[1]?.metadata;
    expect(eventMetadata).toMatchObject({
      phase: "spawned",
      label: "researcher",
    });
    expect(eventMetadata).not.toHaveProperty("runId");
    expect(eventMetadata).not.toHaveProperty("parentRunId");
    expect(eventMetadata).not.toHaveProperty("agentId");
    expect(eventMetadata).not.toHaveProperty("childSessionKey");
    expect(eventMetadata).not.toHaveProperty("subagentIds");
    expect(eventMetadata).not.toHaveProperty("subagentSessionKeys");
    expect(eventMetadata).not.toHaveProperty("searchTerms");
    const lifecyclePropagation = client.propagateAttributes.mock.calls.at(-1)?.[0];
    expect(lifecyclePropagation?.metadata).not.toHaveProperty("subagentId");
    expect(lifecyclePropagation?.metadata).not.toHaveProperty("subagentSessionKey");
    expect(lifecyclePropagation?.metadata).not.toHaveProperty("searchTerms");
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
      propagateAttributes: createPropagateAttributesMock(),
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
      propagateAttributes: createPropagateAttributesMock(),
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

  it("names actual skill invocation tool observations without renaming ordinary reads", async () => {
    const tool = { update: vi.fn(), end: vi.fn(), id: TOOL_OBSERVATION_ID };
    const root = {
      id: ROOT_OBSERVATION_ID,
      traceId: TRACE_ID,
      startObservation: vi.fn((_name: string) => tool),
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
    await run?.startTool?.({
      toolName: "read",
      toolCallId: "tool-skill",
      skillName: "imagegen",
      params: { path: "/workspace/skills/imagegen/SKILL.md" },
    });
    await run?.startTool?.({
      toolName: "read",
      toolCallId: "tool-file",
      params: { path: "/workspace/notes.txt" },
    });

    expect(root.startObservation).toHaveBeenNthCalledWith(
      1,
      "openclaw.skill.imagegen",
      expect.objectContaining({
        metadata: expect.objectContaining({
          toolName: "read",
          skillName: "imagegen",
        }),
      }),
      expect.objectContaining({ asType: "tool" }),
    );
    expect(root.startObservation.mock.calls[1]?.[0]).toBe("openclaw.tool.read");
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
      propagateAttributes: createPropagateAttributesMock(),
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
      propagateAttributes: createPropagateAttributesMock(),
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
      propagateAttributes: createPropagateAttributesMock(),
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
      propagateAttributes: createPropagateAttributesMock(),
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
      propagateAttributes: createPropagateAttributesMock(),
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

  it("starts visible child agent observations through OTEL parent context", async () => {
    const parentTraceId = "1234567890abcdef1234567890abcdef";
    const parentObservationId = "abcdef1234567890";
    const root = {
      id: CHILD_OBSERVATION_ID,
      traceId: parentTraceId,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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

    await runtime.sink.startRun({
      runId: "child-run",
      sessionId: "session-1",
      sessionKey: "child-session",
      traceParent: {
        parentTraceId,
        parentObservationId,
        parentRunId: "parent-run",
        parentSessionKey: "parent-session",
      },
      startedAt: 1_762_000_000_000,
    });

    expect(client.startObservation).toHaveBeenCalledWith(
      "openclaw.agent.run",
      expect.objectContaining({
        metadata: expect.objectContaining({
          runId: "child-run",
          sessionId: "session-1",
          parentRunId: "parent-run",
          parentTraceId,
          parentSessionKey: "parent-session",
        }),
      }),
      expect.objectContaining({
        asType: "agent",
        startTime: new Date(1_762_000_000_000),
        parentSpanContext: {
          traceId: parentTraceId,
          spanId: parentObservationId,
          traceFlags: 1,
        },
      }),
    );
    expect(client.propagateAttributes).toHaveBeenCalledWith(
      {
        traceName: "openclaw.agent.run",
      },
      expect.any(Function),
    );
    expect(client).not.toHaveProperty("createObservation");
  });

  it("does not perform background ingestion for child run startup", async () => {
    const parentTraceId = "1234567890abcdef1234567890abcdef";
    const parentObservationId = "abcdef1234567890";
    const root = {
      id: CHILD_OBSERVATION_ID,
      traceId: parentTraceId,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
      runId: "child-run",
      sessionId: "session-1",
      traceParent: {
        parentTraceId,
        parentObservationId,
        parentRunId: "parent-run",
      },
    });

    expect(run?.traceParent).toMatchObject({
      parentTraceId,
      parentRunId: "child-run",
      parentObservationId: CHILD_OBSERVATION_ID,
    });
    expect(client.propagateAttributes).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveProperty("createObservation");
    expect(client).not.toHaveProperty("upsertTrace");
  });

  it("does not log public ingestion failures when child runs start", async () => {
    const parentTraceId = "1234567890abcdef1234567890abcdef";
    const parentObservationId = "abcdef1234567890";
    const root = {
      id: CHILD_OBSERVATION_ID,
      traceId: parentTraceId,
      update: vi.fn(),
      end: vi.fn(),
    };
    const client = {
      authCheck: vi.fn().mockResolvedValue(true),
      createTraceId: vi.fn(async (seed: string) => `trace-${seed}`),
      propagateAttributes: createPropagateAttributesMock(),
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
          captureMode: "llm_text",
        },
      },
    });
    await runtime.service.start(ctx);

    await runtime.sink.startRun({
      runId: "child-run",
      sessionId: "session-1",
      traceParent: {
        parentTraceId,
        parentObservationId,
        parentRunId: "parent-run",
      },
    });

    expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("ingestion"));
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
      propagateAttributes: createPropagateAttributesMock(),
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
      propagateAttributes: createPropagateAttributesMock(),
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
