import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../../test/helpers/poll.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookLlmOutputEvent,
  PluginHookRegistration,
} from "../plugins/types.js";

const embeddedSubscribeTestState = vi.hoisted(() => ({
  delayedFinalEvents: [] as string[],
  stalledSettlementStarted: false,
  waitForCompactionRetryError: undefined as Error | undefined,
  providerContexts: [] as unknown[],
}));

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );

  return {
    ...actual,
    createAgentSession: async (
      ...args: Parameters<typeof actual.createAgentSession>
    ): ReturnType<typeof actual.createAgentSession> => {
      const result = await actual.createAgentSession(...args);
      const modelId = (args[0] as { model?: { id?: string } } | undefined)?.model?.id;
      if (modelId === "mock-throw") {
        const session = result.session as { prompt?: (...params: unknown[]) => Promise<unknown> };
        if (session && typeof session.prompt === "function") {
          session.prompt = async () => {
            throw new Error("transport failed");
          };
        }
      }
      if (modelId === "mock-delayed-final") {
        const session = result.session;
        const emitMessage = (
          message: Parameters<typeof session.sessionManager.appendMessage>[0],
        ) => {
          session.agent.appendMessage(message);
          session.sessionManager.appendMessage(message);
          const emit = (session as unknown as { _emit: (event: unknown) => void })._emit.bind(
            session,
          );
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
        };
        let settled = false;
        session.prompt = async () => {
          emitMessage({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_delayed_final",
                name: "read",
                arguments: {},
              },
            ],
            stopReason: "toolUse",
            api: "openai-responses",
            provider: "openai",
            model: modelId,
            usage: createMockUsage(1, 1),
            timestamp: Date.now(),
          });
          embeddedSubscribeTestState.delayedFinalEvents.push("prompt_return");
        };
        session.agent.waitForIdle = async () => {
          embeddedSubscribeTestState.delayedFinalEvents.push("settlement_start");
          if (!settled) {
            await Promise.resolve();
            emitMessage({
              role: "toolResult",
              toolCallId: "call_delayed_final",
              toolName: "read",
              content: [{ type: "text", text: "late tool result" }],
              isError: false,
              timestamp: Date.now(),
            });
            emitMessage({
              role: "assistant",
              content: [{ type: "text", text: "Final answer after delayed tool execution." }],
              stopReason: "stop",
              api: "openai-responses",
              provider: "openai",
              model: modelId,
              usage: createMockUsage(2, 3),
              timestamp: Date.now(),
            });
            settled = true;
            embeddedSubscribeTestState.delayedFinalEvents.push("final_emitted");
          }
          embeddedSubscribeTestState.delayedFinalEvents.push("settlement_end");
        };
      }
      if (modelId === "mock-synthetic-settlement") {
        const session = result.session;
        session.prompt = async () => {
          const message = {
            role: "assistant" as const,
            content: [
              {
                type: "toolCall" as const,
                id: "call_synthetic_settlement",
                name: "read",
                arguments: {},
              },
            ],
            stopReason: "toolUse" as const,
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: modelId,
            usage: createMockUsage(1, 1),
            timestamp: Date.now(),
          };
          session.agent.appendMessage(message);
          session.sessionManager.appendMessage(message);
        };
        session.agent.waitForIdle = async () => {};
      }
      if (modelId === "mock-stalled-settlement") {
        const session = result.session;
        session.prompt = async () => {};
        session.agent.waitForIdle = () => {
          embeddedSubscribeTestState.stalledSettlementStarted = true;
          return new Promise<void>(() => {});
        };
      }
      return result;
    },
  };
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [],
    stopReason: "error" as const,
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(0, 0),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }, context: unknown) => {
      embeddedSubscribeTestState.providerContexts.push(context);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
        });
        stream.end();
      });
      return stream;
    },
  };
});

vi.mock("./pi-embedded-subscribe.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-embedded-subscribe.js")>(
    "./pi-embedded-subscribe.js",
  );

  return {
    ...actual,
    subscribeEmbeddedPiSession: (
      ...args: Parameters<typeof actual.subscribeEmbeddedPiSession>
    ): ReturnType<typeof actual.subscribeEmbeddedPiSession> => {
      const subscription = actual.subscribeEmbeddedPiSession(...args);
      const isDelayedFinal =
        (args[0].session.model as { id?: string } | undefined)?.id === "mock-delayed-final";
      return {
        ...subscription,
        unsubscribe: () => {
          if (isDelayedFinal) {
            embeddedSubscribeTestState.delayedFinalEvents.push("unsubscribe");
          }
          subscription.unsubscribe();
        },
        waitForCompactionRetry: async () => {
          if (embeddedSubscribeTestState.waitForCompactionRetryError) {
            throw embeddedSubscribeTestState.waitForCompactionRetryError;
          }
          return await subscription.waitForCompactionRetry();
        },
      };
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let abortEmbeddedPiRun: typeof import("./pi-embedded-runner/runs.js").abortEmbeddedPiRun;
let isEmbeddedPiRunActive: typeof import("./pi-embedded-runner/runs.js").isEmbeddedPiRunActive;
let waitForEmbeddedPiRunEnd: typeof import("./pi-embedded-runner/runs.js").waitForEmbeddedPiRunEnd;
let SessionManager: typeof import("@mariozechner/pi-coding-agent").SessionManager;
let tempRoot: string | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;
let runCounter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({ abortEmbeddedPiRun, isEmbeddedPiRunActive, waitForEmbeddedPiRunEnd } =
    await import("./pi-embedded-runner/runs.js"));
  ({ SessionManager } = await import("@mariozechner/pi-coding-agent"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-agent-"));
  agentDir = path.join(tempRoot, "agent");
  workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  if (!tempRoot) {
    return;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

const makeOpenAiConfig = (modelIds: string[]) =>
  ({
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // Use a realistic window well above the default compaction reserve (16_384) so the
            // preflight/emergency-compaction path is not spuriously triggered for small prompts.
            contextWindow: 200_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  }) satisfies OpenClawConfig;

const makeAnthropicConfig = (modelIds: string[]) =>
  ({
    models: {
      providers: {
        anthropic: {
          api: "anthropic-messages",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  }) satisfies OpenClawConfig;

const nextSessionFile = () => {
  sessionCounter += 1;
  return path.join(workspaceDir, `session-${sessionCounter}.jsonl`);
};
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;
const immediateEnqueue = async <T>(task: () => Promise<T>) => task();

const runWithOrphanedSingleUserMessage = async (text: string, sessionKey: string) => {
  const sessionFile = nextSessionFile();
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

  const cfg = makeOpenAiConfig(["mock-1"]);
  return await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("orphaned-user"),
    enqueue: immediateEnqueue,
  });
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionEntries = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown });
};

const readSessionMessages = async (sessionFile: string) => {
  const entries = await readSessionEntries(sessionFile);
  return entries
    .filter((entry) => entry.type === "message")
    .map(
      (entry) => (entry as { message?: { role?: string; content?: unknown } }).message,
    ) as Array<{ role?: string; content?: unknown }>;
};

const runDefaultEmbeddedTurn = async (sessionFile: string, prompt: string, sessionKey: string) => {
  const cfg = makeOpenAiConfig(["mock-1"]);
  await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt,
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("default-turn"),
    enqueue: immediateEnqueue,
  });
};

describe("runEmbeddedPiAgent", () => {
  it("persists WebChat refs through compaction without leaking them to trace or the next turn", async () => {
    const sessionFile = nextSessionFile();
    const sessionKey = nextSessionKey();
    await runEmbeddedPiAgent({
      sessionId: "session:webchat-refs",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: makeOpenAiConfig(["mock-1"]),
      prompt: "inspect attachment",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("webchat-refs"),
      enqueue: immediateEnqueue,
      webchatAttachmentRefs: [{ attachmentId: "53ff15ed-8063-42a2-a589-032f2874738f", ordinal: 0 }],
    });

    const sessionManager = SessionManager.open(sessionFile);
    const firstUserEntry = sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(firstUserEntry?.id).toEqual(expect.any(String));
    sessionManager.appendCompaction("summary", firstUserEntry?.id as string, 1);
    const restartedHistory = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { SessionManager } from "@mariozechner/pi-coding-agent"; const messages = SessionManager.open(process.argv[1]).buildSessionContext().messages; process.stdout.write(JSON.stringify(messages));',
        sessionFile,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(restartedHistory).toContain("__openclaw");
    expect(restartedHistory).toContain("53ff15ed-8063-42a2-a589-032f2874738f");

    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const tracedHistoryMessages: unknown[] = [];
    registry.agentTraceSinks.push({
      pluginId: "trace-test",
      source: "trace-test",
      sink: {
        startRun: () => ({
          startGeneration: (event) => {
            tracedHistoryMessages.push(event.historyMessages);
            return { end: () => {} };
          },
          end: () => {},
        }),
      },
    });
    setActivePluginRegistry(registry);
    embeddedSubscribeTestState.providerContexts.length = 0;

    try {
      await runDefaultEmbeddedTurn(sessionFile, "next turn", sessionKey);
    } finally {
      setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    }

    const entries = await readSessionEntries(sessionFile);
    const userMessages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message?: Record<string, unknown> }).message)
      .filter((message) => message?.role === "user");
    expect(userMessages[0]?.__openclaw).toEqual({
      attachments: [{ attachmentId: "53ff15ed-8063-42a2-a589-032f2874738f", ordinal: 0 }],
    });
    expect(userMessages[1]?.__openclaw).toBeUndefined();
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
    expect(JSON.stringify(tracedHistoryMessages)).not.toContain("__openclaw");
    expect(JSON.stringify(tracedHistoryMessages)).not.toContain(
      "53ff15ed-8063-42a2-a589-032f2874738f",
    );
    expect(JSON.stringify(embeddedSubscribeTestState.providerContexts)).not.toContain("__openclaw");
    expect(JSON.stringify(embeddedSubscribeTestState.providerContexts)).not.toContain(
      "53ff15ed-8063-42a2-a589-032f2874738f",
    );
  });

  it("runs lifecycle callbacks before releasing the session lane", async () => {
    const sessionFile = nextSessionFile();
    const events: string[] = [];
    const result = await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: nextSessionKey(),
      sessionFile,
      workspaceDir,
      config: makeOpenAiConfig(["mock-1"]),
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("session-lane-callbacks"),
      enqueue: immediateEnqueue,
      onSessionLaneStart: () => {
        events.push("start");
      },
      onSessionLaneComplete: async (payloads) => {
        expect(payloads?.length).toBeGreaterThan(0);
        await expect(fs.stat(sessionFile)).resolves.toBeTruthy();
        events.push("complete");
      },
    });

    expect(result.payloads?.length).toBeGreaterThan(0);
    expect(events).toEqual(["start", "complete"]);
  });

  it("settles delayed tool loops before snapshots, hooks, and unsubscribe", async () => {
    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const agentEnd = vi.fn((event: PluginHookAgentEndEvent) => {
      embeddedSubscribeTestState.delayedFinalEvents.push("agent_end_hook");
      expect((event.messages.at(-1) as { role?: string } | undefined)?.role).toBe("assistant");
    });
    const llmOutput = vi.fn((event: PluginHookLlmOutputEvent) => {
      const lastAssistant = event.lastAssistant as
        | { content?: Array<{ type?: string; text?: string }> }
        | undefined;
      embeddedSubscribeTestState.delayedFinalEvents.push("llm_output_hook");
      expect(event.assistantTexts).toContain("Final answer after delayed tool execution.");
      expect(lastAssistant?.content?.[0]?.text).toBe("Final answer after delayed tool execution.");
    });
    registry.typedHooks.push(
      {
        pluginId: "settlement-test",
        hookName: "agent_end",
        handler: agentEnd,
        source: "test",
      } as PluginHookRegistration<"agent_end">,
      {
        pluginId: "settlement-test",
        hookName: "llm_output",
        handler: llmOutput,
        source: "test",
      } as PluginHookRegistration<"llm_output">,
    );
    embeddedSubscribeTestState.delayedFinalEvents.length = 0;
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    try {
      const result = await runEmbeddedPiAgent({
        sessionId: "session:delayed-final",
        sessionKey: nextSessionKey(),
        sessionFile: nextSessionFile(),
        workspaceDir,
        config: makeOpenAiConfig(["mock-delayed-final"]),
        prompt: "finish after the tool result",
        provider: "openai",
        model: "mock-delayed-final",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("delayed-final"),
        enqueue: immediateEnqueue,
      });

      expect(result.payloads?.[0]?.text).toBe("Final answer after delayed tool execution.");
      expect(agentEnd).toHaveBeenCalledTimes(1);
      expect(llmOutput).toHaveBeenCalledTimes(1);
      expect(embeddedSubscribeTestState.delayedFinalEvents).toEqual([
        "prompt_return",
        "settlement_start",
        "final_emitted",
        "settlement_end",
        "agent_end_hook",
        "llm_output_hook",
        "unsubscribe",
      ]);
    } finally {
      resetGlobalHookRunner();
      setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    }
  });

  it("reports synthetic tool settlement consistently to snapshots, hooks, and traces", async () => {
    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const agentEnd = vi.fn();
    const endTraceRun = vi.fn();
    registry.typedHooks.push({
      pluginId: "synthetic-settlement-test",
      hookName: "agent_end",
      handler: agentEnd,
      source: "test",
    } as PluginHookRegistration<"agent_end">);
    registry.agentTraceSinks.push({
      pluginId: "synthetic-settlement-test",
      source: "test",
      sink: {
        startRun: () => ({ end: endTraceRun }),
      },
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    try {
      const sessionFile = nextSessionFile();
      await runEmbeddedPiAgent({
        sessionId: "session:synthetic-settlement",
        sessionKey: nextSessionKey(),
        sessionFile,
        workspaceDir,
        config: makeAnthropicConfig(["mock-synthetic-settlement"]),
        prompt: "leave a pending tool call",
        provider: "anthropic",
        model: "mock-synthetic-settlement",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("synthetic-settlement"),
        enqueue: immediateEnqueue,
      });

      const transcriptMessages = await readSessionMessages(sessionFile);
      expect(transcriptMessages.at(-1)).toMatchObject({
        role: "toolResult",
        content: [
          expect.objectContaining({
            text: expect.stringContaining("inserted synthetic error result"),
          }),
        ],
      });
      expect(agentEnd).toHaveBeenCalledTimes(1);
      expect(agentEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "toolResult",
              toolCallId: "call_synthetic_settlement",
              isError: true,
            }),
          ]),
          success: false,
          error: expect.stringContaining("missing_tool_results"),
        }),
        expect.anything(),
      );
      expect(endTraceRun).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining("missing_tool_results"),
        }),
      );
    } finally {
      resetGlobalHookRunner();
      setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    }
  });

  it("handles prompt error paths without dropping user state", async () => {
    for (const testCase of [
      {
        label: "assistant error response keeps user message",
        model: "mock-error",
        prompt: "boom",
        runIdPrefix: "prompt-error",
        expectReject: false,
      },
      {
        label: "transport error fails fast before writing transcript",
        model: "mock-throw",
        prompt: "transport error",
        runIdPrefix: "transport-error",
        expectReject: true,
      },
    ] as const) {
      const sessionFile = nextSessionFile();
      const cfg = makeOpenAiConfig([testCase.model]);
      const sessionKey = nextSessionKey();
      const execution = runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey,
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: testCase.prompt,
        provider: "openai",
        model: testCase.model,
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId(testCase.runIdPrefix),
        enqueue: immediateEnqueue,
      });

      if (testCase.expectReject) {
        await expect(execution, testCase.label).rejects.toThrow("transport failed");
        await expect(fs.stat(sessionFile), testCase.label).rejects.toBeTruthy();
      } else {
        const result = await execution;
        expect(result.payloads?.[0]?.isError, testCase.label).toBe(true);

        const messages = await readSessionMessages(sessionFile);
        const userIndex = messages.findIndex(
          (message) => message?.role === "user" && textFromContent(message.content) === "boom",
        );
        expect(userIndex, testCase.label).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it(
    "appends new user + assistant after existing transcript entries",
    { timeout: 90_000 },
    async () => {
      const sessionFile = nextSessionFile();
      const sessionKey = nextSessionKey();

      const sessionManager = SessionManager.open(sessionFile);
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed user" }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seed assistant" }],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "mock-1",
        usage: createMockUsage(1, 1),
        timestamp: Date.now(),
      });

      await runDefaultEmbeddedTurn(sessionFile, "hello", sessionKey);

      const messages = await readSessionMessages(sessionFile);
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      const newUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "hello",
      );
      const newAssistantIndex = messages.findIndex(
        (message, index) => index > newUserIndex && message?.role === "assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(newUserIndex).toBeGreaterThan(seedAssistantIndex);
      expect(newAssistantIndex).toBeGreaterThan(newUserIndex);
    },
  );

  it("repairs orphaned user messages and continues", async () => {
    const result = await runWithOrphanedSingleUserMessage("orphaned user", nextSessionKey());

    expect(result.meta.error).toBeUndefined();
    expect(result.payloads?.length ?? 0).toBeGreaterThan(0);
  });

  it("marks pending runs as busy before session lane starts", async () => {
    let releaseSessionGate: (() => void) | undefined;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSessionGate = resolve;
    });
    let sessionCalls = 0;
    const gatedEnqueue = async <T>(task: () => Promise<T>) => {
      sessionCalls += 1;
      if (sessionCalls === 1) {
        await sessionGate;
      }
      return await task();
    };

    const sessionFile = nextSessionFile();
    const cfg = makeOpenAiConfig(["mock-1"]);
    const sessionId = "session:pending-busy";
    const sessionKey = nextSessionKey();

    const execution = runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("pending-busy"),
      enqueue: gatedEnqueue,
    });

    try {
      const active = await pollUntil(
        async () => (isEmbeddedPiRunActive(sessionId) ? true : undefined),
        { timeoutMs: 1000, intervalMs: 10 },
      );
      expect(active).toBe(true);
    } finally {
      releaseSessionGate?.();
    }

    await execution;

    expect(await waitForEmbeddedPiRunEnd(sessionId, 50)).toBe(true);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
  });

  it("clears pending runs when enqueue rejects before attempt start", async () => {
    const sessionFile = nextSessionFile();
    const cfg = makeOpenAiConfig(["mock-1"]);
    const sessionId = "session:pending-reject";
    const sessionKey = nextSessionKey();
    const enqueueError = new Error("session lane rejected");
    let firstCall = true;
    const rejectingEnqueue = async <T>(task: () => Promise<T>) => {
      if (firstCall) {
        firstCall = false;
        throw enqueueError;
      }
      return await task();
    };

    await expect(
      runEmbeddedPiAgent({
        sessionId,
        sessionKey,
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("pending-reject"),
        enqueue: rejectingEnqueue,
      }),
    ).rejects.toThrow("session lane rejected");

    expect(await waitForEmbeddedPiRunEnd(sessionId, 50)).toBe(true);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
  });

  it("ends trace runs when setup fails after trace start", async () => {
    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const endTraceRun = vi.fn();
    registry.agentTraceSinks.push({
      pluginId: "trace-test",
      source: "trace-test",
      sink: {
        startRun: () => ({ end: endTraceRun }),
      },
    });
    setActivePluginRegistry(registry);

    try {
      const sessionFile = nextSessionFile();
      const cfg: OpenClawConfig = {
        ...makeOpenAiConfig(["mock-1"]),
        agents: {
          defaults: {
            securityPolicyPath: tempRoot,
          },
        },
      };

      await expect(
        runEmbeddedPiAgent({
          sessionId: "session:trace-setup-fails",
          sessionKey: nextSessionKey(),
          sessionFile,
          workspaceDir,
          config: cfg,
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          timeoutMs: 5_000,
          agentDir,
          runId: nextRunId("trace-setup-fails"),
          enqueue: immediateEnqueue,
        }),
      ).rejects.toThrow(/runtime security policy/i);

      expect(endTraceRun).toHaveBeenCalledTimes(1);
      expect(endTraceRun).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringMatching(/runtime security policy/i),
        }),
      );
    } finally {
      setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    }
  });

  it("measures successful trace run duration from run start", { timeout: 90_000 }, async () => {
    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const generationEnd = vi.fn();
    const endTraceRun = vi.fn();
    let now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 1_000;
      return now;
    });

    registry.agentTraceSinks.push({
      pluginId: "trace-test",
      source: "trace-test",
      sink: {
        startRun: async () => {
          for (let i = 0; i < 10; i += 1) {
            Date.now();
          }
          return {
            startGeneration: () => ({ end: generationEnd }),
            end: endTraceRun,
          };
        },
      },
    });
    setActivePluginRegistry(registry);

    try {
      const sessionFile = nextSessionFile();
      const cfg = makeOpenAiConfig(["mock-1"]);

      await runEmbeddedPiAgent({
        sessionId: "session:trace-success-duration",
        sessionKey: nextSessionKey(),
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("trace-success-duration"),
        enqueue: immediateEnqueue,
      });

      const generationDuration = generationEnd.mock.calls[0]?.[0]?.durationMs;
      const runDuration = endTraceRun.mock.calls[0]?.[0]?.durationMs;
      expect(generationDuration).toEqual(expect.any(Number));
      expect(runDuration).toEqual(expect.any(Number));
      expect(runDuration).toBeGreaterThan(generationDuration + 5_000);
      expect(endTraceRun).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    } finally {
      dateNow.mockRestore();
      setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    }
  });

  it("ends the current generation when post-prompt compaction waiting fails", async () => {
    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const generationEnd = vi.fn();
    const endTraceRun = vi.fn();
    registry.agentTraceSinks.push({
      pluginId: "trace-test",
      source: "trace-test",
      sink: {
        startRun: () => ({
          startGeneration: () => ({ end: generationEnd }),
          end: endTraceRun,
        }),
      },
    });
    setActivePluginRegistry(registry);
    embeddedSubscribeTestState.waitForCompactionRetryError = new Error("compaction wait failed");

    try {
      await expect(
        runEmbeddedPiAgent({
          sessionId: "session:trace-compaction-wait-fails",
          sessionKey: nextSessionKey(),
          sessionFile: nextSessionFile(),
          workspaceDir,
          config: makeOpenAiConfig(["mock-1"]),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          timeoutMs: 5_000,
          agentDir,
          runId: nextRunId("trace-compaction-wait-fails"),
          enqueue: immediateEnqueue,
        }),
      ).rejects.toThrow("compaction wait failed");

      expect(generationEnd).toHaveBeenCalledTimes(1);
      expect(endTraceRun).toHaveBeenCalledTimes(1);
      expect(endTraceRun).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "compaction wait failed",
        }),
      );
    } finally {
      embeddedSubscribeTestState.waitForCompactionRetryError = undefined;
      setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    }
  });

  it("releases the session lane promptly when cancellation interrupts settlement", async () => {
    const sessionId = "session:stalled-settlement-abort";
    embeddedSubscribeTestState.stalledSettlementStarted = false;
    const execution = runEmbeddedPiAgent({
      sessionId,
      sessionKey: nextSessionKey(),
      sessionFile: nextSessionFile(),
      workspaceDir,
      config: makeOpenAiConfig(["mock-stalled-settlement"]),
      prompt: "wait forever during settlement",
      provider: "openai",
      model: "mock-stalled-settlement",
      timeoutMs: 120_000,
      agentDir,
      runId: nextRunId("stalled-settlement-abort"),
      enqueue: immediateEnqueue,
    });

    await pollUntil(
      async () => (embeddedSubscribeTestState.stalledSettlementStarted ? true : undefined),
      { timeoutMs: 1_000, intervalMs: 10 },
    );
    const abortedAt = Date.now();
    expect(abortEmbeddedPiRun(sessionId)).toBe(true);

    const outcome = await Promise.race([execution, delay(2_500).then(() => "timeout" as const)]);

    expect(outcome).not.toBe("timeout");
    if (outcome === "timeout") {
      return;
    }
    expect(Date.now() - abortedAt).toBeLessThan(2_500);
    expect(outcome.meta.aborted).toBe(true);
    expect(outcome.payloads).toBeUndefined();
    expect(await waitForEmbeddedPiRunEnd(sessionId, 100)).toBe(true);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
  });

  it("aborts pending runs that are waiting on the global lane", async () => {
    let releaseGlobalGate: (() => void) | undefined;
    const globalGate = new Promise<void>((resolve) => {
      releaseGlobalGate = resolve;
    });
    let enqueueCalls = 0;
    const gatedEnqueue = async <T>(task: () => Promise<T>) => {
      enqueueCalls += 1;
      if (enqueueCalls === 2) {
        await globalGate;
      }
      return await task();
    };

    const sessionFile = nextSessionFile();
    const cfg = makeOpenAiConfig(["mock-1"]);
    const sessionId = "session:pending-global-abort";
    const sessionKey = nextSessionKey();
    const lifecycleEvents: string[] = [];

    const execution = runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("pending-global-abort"),
      enqueue: gatedEnqueue,
      onSessionLaneStart: () => {
        lifecycleEvents.push("start");
      },
      onSessionLaneComplete: () => {
        lifecycleEvents.push("complete");
      },
    });

    try {
      const queuedTwice = await pollUntil(
        async () => (enqueueCalls >= 2 ? enqueueCalls : undefined),
        { timeoutMs: 1000, intervalMs: 10 },
      );
      expect(queuedTwice).toBeGreaterThanOrEqual(2);
      expect(lifecycleEvents).toEqual(["start"]);
      expect(isEmbeddedPiRunActive(sessionId)).toBe(true);
      expect(abortEmbeddedPiRun(sessionId)).toBe(true);

      const earlyOutcome = await Promise.race([
        execution,
        delay(200).then(() => "timeout" as const),
      ]);
      expect(earlyOutcome).toBe("timeout");
      expect(lifecycleEvents).toEqual(["start"]);
    } finally {
      releaseGlobalGate?.();
    }

    const outcome = await execution;
    expect(outcome.meta.aborted).toBe(true);
    expect(outcome.payloads).toBeUndefined();
    expect(lifecycleEvents).toEqual(["start", "complete"]);
    expect(await waitForEmbeddedPiRunEnd(sessionId, 100)).toBe(true);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    await delay(20);
    await expect(fs.stat(sessionFile)).rejects.toBeTruthy();
  });
});
