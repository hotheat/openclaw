import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resolveCurrentAgentTraceParent } from "./context.js";
import { createAgentTraceRunEndOnce, createAgentTraceRunner } from "./runner.js";
import type { AgentTraceObservationHandle, AgentTraceSink } from "./types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createLogger() {
  return {
    warn: vi.fn(),
  };
}

function createRegistry(sinks: AgentTraceSink[]): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    agentTraceSinks: sinks.map((sink, index) => ({
      pluginId: `sink-${index}`,
      sink,
      source: `sink-${index}.ts`,
    })),
    diagnostics: [],
  };
}

describe("createAgentTraceRunner", () => {
  it("fans out run, generation, tool and end events to sinks", async () => {
    const generationEnd = vi.fn();
    const toolEnd = vi.fn();
    const startGeneration = vi.fn(
      (): AgentTraceObservationHandle => ({
        end: generationEnd,
      }),
    );
    const startTool = vi.fn(
      (): AgentTraceObservationHandle => ({
        end: toolEnd,
      }),
    );
    const recordSpan = vi.fn();
    const end = vi.fn();
    const sink: AgentTraceSink = {
      startRun: vi.fn(() => ({
        startGeneration,
        startTool,
        recordSpan,
        end,
      })),
    };

    const runner = createAgentTraceRunner(createRegistry([sink]), createLogger());
    const run = await runner.startRun({
      runId: "run-1",
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5.1",
    });
    const generation = await run.startGeneration?.({
      provider: "openai",
      model: "gpt-5.1",
      prompt: "hello",
      historyMessages: [],
      imagesCount: 0,
    });
    await generation?.end({ assistantTexts: ["world"], usage: { total: 2 } });
    const tool = await run.startTool?.({
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      params: { message: "research" },
    });
    await tool?.end({ result: { runId: "child-run" }, durationMs: 7 });
    await run.recordSpan?.({
      name: "openclaw.skills.resolve",
      input: { workspaceDir: "/tmp/workspace" },
      output: { count: 1, skills: [{ name: "pdf-generator", source: "workspace" }] },
      metadata: { promptChars: 120 },
    });
    await run.end?.({ success: true, durationMs: 10 });

    expect(sink.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
    expect(startGeneration).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello" }));
    expect(generationEnd).toHaveBeenCalledWith(
      expect.objectContaining({ assistantTexts: ["world"] }),
    );
    expect(startTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "sessions_spawn" }));
    expect(toolEnd).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 7 }));
    expect(recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "openclaw.skills.resolve",
        output: expect.objectContaining({ count: 1 }),
      }),
    );
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("isolates sink failures from the agent run", async () => {
    const logger = createLogger();
    const healthyEnd = vi.fn();
    const broken: AgentTraceSink = {
      startRun: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const healthy: AgentTraceSink = {
      startRun: vi.fn(() => ({
        end: healthyEnd,
      })),
    };

    const runner = createAgentTraceRunner(createRegistry([broken, healthy]), logger);
    const run = await runner.startRun({ runId: "run-1", sessionId: "session-1" });
    await run.end?.({ success: true });

    expect(healthyEnd).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("agent trace sink failed"));
  });

  it("selects run trace parent by registry order instead of sink completion order", async () => {
    const firstParent = {
      parentTraceId: "first-trace",
      parentRunId: "run-1",
      parentObservationId: "first-root",
    };
    const secondParent = {
      parentTraceId: "second-trace",
      parentRunId: "run-1",
      parentObservationId: "second-root",
    };
    const first: AgentTraceSink = {
      startRun: vi.fn(async () => {
        await delay(10);
        return { traceParent: firstParent };
      }),
    };
    const second: AgentTraceSink = {
      startRun: vi.fn(async () => ({ traceParent: secondParent })),
    };

    const runner = createAgentTraceRunner(createRegistry([first, second]), createLogger());
    const run = await runner.startRun({ runId: "run-1", sessionId: "session-1" });

    expect(run.traceParent).toEqual(firstParent);
  });

  it("selects tool trace parent by registry order instead of sink completion order", async () => {
    const firstParent = {
      parentTraceId: "first-trace",
      parentRunId: "run-1",
      parentObservationId: "first-tool",
    };
    const secondParent = {
      parentTraceId: "second-trace",
      parentRunId: "run-1",
      parentObservationId: "second-tool",
    };
    const first: AgentTraceSink = {
      startRun: vi.fn(() => ({
        startTool: async (): Promise<AgentTraceObservationHandle> => {
          await delay(10);
          return { traceParent: firstParent, end: vi.fn() };
        },
      })),
    };
    const second: AgentTraceSink = {
      startRun: vi.fn(() => ({
        startTool: async (): Promise<AgentTraceObservationHandle> => ({
          traceParent: secondParent,
          end: vi.fn(),
        }),
      })),
    };

    const runner = createAgentTraceRunner(createRegistry([first, second]), createLogger());
    const run = await runner.startRun({ runId: "run-1", sessionId: "session-1" });
    const tool = await run.startTool?.({
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      params: {},
    });

    expect(tool?.traceParent).toEqual(firstParent);
  });

  it("ends a run handle at most once", async () => {
    const end = vi.fn();
    const endOnce = createAgentTraceRunEndOnce({ end });

    await endOnce({ success: false, error: "startup failed", durationMs: 5 });
    await endOnce({ success: true, durationMs: 10 });

    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith({
      success: false,
      error: "startup failed",
      durationMs: 5,
    });
  });
});

describe("resolveCurrentAgentTraceParent", () => {
  it("does not fabricate a trace id when a local trace run has no parent", () => {
    expect(
      resolveCurrentAgentTraceParent({
        traceRun: {},
        currentRunId: "run-with-local-sink",
        currentSessionKey: "agent:main",
        inheritedParent: undefined,
      }),
    ).toBeUndefined();
  });

  it("does not propagate a local trace parent without a trace id", () => {
    expect(
      resolveCurrentAgentTraceParent({
        traceRun: {
          traceParent: {
            parentRunId: "run-with-incomplete-parent",
            parentObservationId: "parent-observation",
          },
        },
        currentRunId: "run-with-incomplete-parent",
        currentSessionKey: "agent:main",
        inheritedParent: undefined,
      }),
    ).toBeUndefined();
  });

  it("does not synthesize a child parent from inbound context without a trace id", () => {
    expect(
      resolveCurrentAgentTraceParent({
        traceRun: undefined,
        currentRunId: "child-run",
        currentSessionKey: "agent:child:main",
        inheritedParent: {
          parentRunId: "parent-run",
          parentSessionKey: "agent:parent:main",
          parentObservationId: "parent-observation",
        },
      }),
    ).toBeUndefined();
  });

  it("synthesizes a child parent from inbound trace context without a local run handle", () => {
    expect(
      resolveCurrentAgentTraceParent({
        traceRun: undefined,
        currentRunId: "child-run",
        currentSessionKey: "agent:child:main",
        inheritedParent: {
          parentTraceId: "root-trace",
          parentRunId: "parent-run",
          parentSessionKey: "agent:parent:main",
          parentObservationId: "parent-observation",
        },
      }),
    ).toEqual({
      parentTraceId: "root-trace",
      parentRunId: "child-run",
      parentSessionKey: "agent:child:main",
      parentObservationId: undefined,
    });
  });
});
