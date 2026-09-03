import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { FollowupRun } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn(async (params: RunWithModelFallbackParams) => ({
  result: await params.run(params.provider, params.model),
  provider: params.provider,
  model: params.model,
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: RunWithModelFallbackParams) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

import { createFollowupRunner } from "./followup-runner.js";

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  ({
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider,
      agentAccountId: "primary",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  }) as FollowupRun;

const resetAgentMocks = () => {
  runEmbeddedPiAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  runWithModelFallbackMock.mockImplementation(async (params: RunWithModelFallbackParams) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
  }));
};

const providerConfig = (timeoutSeconds: number): ModelProviderConfig => ({
  baseUrl: "https://example.invalid/v1",
  timeoutSeconds,
  models: [],
});

function mockCompactionRun(params: {
  willRetry: boolean;
  result: {
    payloads: Array<{ text: string }>;
    meta: Record<string, unknown>;
  };
}) {
  runEmbeddedPiAgentMock.mockImplementationOnce(
    async (args: {
      onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    }) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: params.willRetry },
      });
      return params.result;
    },
  );
}

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    mockCompactionRun({
      willRetry: true,
      result: { payloads: [{ text: "final" }], meta: {} },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "on",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as FollowupRun;

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  function createMessagingDedupeRunner(
    onBlockReply: (payload: unknown) => Promise<void>,
    overrides: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }> = {},
  ) {
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
      sessionEntry: overrides.sessionEntry,
      sessionStore: overrides.sessionStore,
      sessionKey: overrides.sessionKey,
      storePath: overrides.storePath,
    });
  }

  it("drops payloads already sent via messaging tool", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      meta: {},
    });

    const runner = createMessagingDedupeRunner(onBlockReply);

    await runner(baseQueuedRun());

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });

    const runner = createMessagingDedupeRunner(onBlockReply);

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const runner = createMessagingDedupeRunner(onBlockReply);

    await runner(baseQueuedRun("slack"));

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("drops media URL from payload when messaging tool already sent it", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ mediaUrl: "/tmp/img.png" }],
      messagingToolSentMediaUrls: ["/tmp/img.png"],
      meta: {},
    });

    const runner = createMessagingDedupeRunner(onBlockReply);

    await runner(baseQueuedRun());

    // Media stripped → payload becomes non-renderable → not delivered.
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers media payload when not a duplicate", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ mediaUrl: "/tmp/img.png" }],
      messagingToolSentMediaUrls: ["/tmp/other.png"],
      meta: {},
    });

    const runner = createMessagingDedupeRunner(onBlockReply);

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 1_000, output: 50 },
          lastCallUsage: { input: 400, output: 20 },
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const runner = createMessagingDedupeRunner(onBlockReply, {
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await runner(baseQueuedRun("slack"));

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    // totalTokens should reflect the last call usage snapshot, not the accumulated input.
    expect(store[sessionKey]?.totalTokens).toBe(400);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(store[sessionKey]?.inputTokens).toBe(1_000);
    expect(store[sessionKey]?.outputTokens).toBe(50);
  });
});

describe("createFollowupRunner agentDir forwarding", () => {
  it("passes queued run agentDir to runEmbeddedPiAgent", async () => {
    resetAgentMocks();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });
    const agentDir = path.join("/tmp", "agent-dir");
    const queued = baseQueuedRun();
    await runner({
      ...queued,
      run: {
        ...queued.run,
        agentDir,
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as { agentDir?: string };
    expect(call?.agentDir).toBe(agentDir);
  });
});

describe("createFollowupRunner timeout resolution", () => {
  it("uses provider-specific timeout for fallback attempts", async () => {
    resetAgentMocks();
    runWithModelFallbackMock.mockImplementationOnce(async (params: RunWithModelFallbackParams) => {
      try {
        await params.run(params.provider, params.model);
      } catch {
        return {
          result: await params.run("deepinfra", "fallback-model"),
          provider: "deepinfra",
          model: "fallback-model",
        };
      }
      throw new Error("expected primary attempt to fail");
    });
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(new Error("primary timeout"))
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback ok" }],
        meta: {},
      });
    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });
    const queued = baseQueuedRun();

    await runner({
      ...queued,
      run: {
        ...queued.run,
        config: {
          agents: {
            defaults: {
              timeoutSeconds: 1,
            },
          },
          models: {
            providers: {
              anthropic: providerConfig(7),
              deepinfra: providerConfig(42),
            },
          },
        },
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      timeoutMs: 7_000,
    });
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]).toMatchObject({
      provider: "deepinfra",
      timeoutMs: 42_000,
    });
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit timeout override across fallback attempts", async () => {
    resetAgentMocks();
    runWithModelFallbackMock.mockImplementationOnce(async (params: RunWithModelFallbackParams) => {
      try {
        await params.run(params.provider, params.model);
      } catch {
        return {
          result: await params.run("deepinfra", "fallback-model"),
          provider: "deepinfra",
          model: "fallback-model",
        };
      }
      throw new Error("expected primary attempt to fail");
    });
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(new Error("primary timeout"))
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback ok" }],
        meta: {},
      });
    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });
    const queued = baseQueuedRun();

    await runner({
      ...queued,
      run: {
        ...queued.run,
        timeoutOverrideSeconds: 9,
        config: {
          agents: {
            defaults: {
              timeoutSeconds: 1,
            },
          },
          models: {
            providers: {
              anthropic: providerConfig(7),
              deepinfra: providerConfig(42),
            },
          },
        },
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      timeoutMs: 9_000,
    });
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]).toMatchObject({
      provider: "deepinfra",
      timeoutMs: 9_000,
    });
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
});

describe("createFollowupRunner queued run correlation", () => {
  function createRunner() {
    return createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });
  }

  it("reuses the caller run id, reports run start, and settles done", async () => {
    resetAgentMocks();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (args: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
      }) => {
        args.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        return { payloads: [{ text: "queued answer" }] };
      },
    );
    const onAgentRunStart = vi.fn();
    const onSettled = vi.fn();
    const abortController = new AbortController();
    const queued: FollowupRun = {
      ...baseQueuedRun(),
      runId: "client-run-1",
      abortSignal: abortController.signal,
      onAgentRunStart,
      onSettled,
    };

    await createRunner()(queued);

    expect(onAgentRunStart).toHaveBeenCalledTimes(1);
    expect(onAgentRunStart).toHaveBeenCalledWith("client-run-1");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "client-run-1", abortSignal: abortController.signal }),
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "done" });
  });

  it("does not report run start when the agent fails before any activity", async () => {
    resetAgentMocks();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("No API key found for provider."));
    const onAgentRunStart = vi.fn();
    const onSettled = vi.fn();

    await createRunner()({ ...baseQueuedRun(), onAgentRunStart, onSettled });

    // Without agent activity, chat.send must stay responsible for broadcasting
    // the error terminal under the client run id.
    expect(onAgentRunStart).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      outcome: "error",
      error: "No API key found for provider.",
    });
  });

  it("settles done exactly once when the run produces no payloads", async () => {
    resetAgentMocks();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [] });
    const onSettled = vi.fn();

    await createRunner()({ ...baseQueuedRun(), onSettled });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "done" });
  });

  it("settles aborted without starting the agent when the signal is already aborted", async () => {
    resetAgentMocks();
    const abortController = new AbortController();
    abortController.abort();
    const onAgentRunStart = vi.fn();
    const onSettled = vi.fn();

    await createRunner()({
      ...baseQueuedRun(),
      runId: "client-run-aborted",
      abortSignal: abortController.signal,
      onAgentRunStart,
      onSettled,
    });

    // chat.abort already terminated this run id; the model must never start and
    // no lifecycle event may follow the aborted terminal.
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "aborted" });
    expect(onAgentRunStart).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("settles with the error when the agent run fails", async () => {
    resetAgentMocks();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("provider down"));
    const onSettled = vi.fn();

    await expect(createRunner()({ ...baseQueuedRun(), onSettled })).resolves.toBeUndefined();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "error", error: "provider down" });
  });

  it("settles aborted instead of error when the run fails after the caller aborted", async () => {
    resetAgentMocks();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("The operation was aborted"));
    const onSettled = vi.fn();
    const abortController = new AbortController();
    abortController.abort();

    await createRunner()({ ...baseQueuedRun(), abortSignal: abortController.signal, onSettled });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "aborted" });
  });

  it("settles delivery failures without rejecting the drain", async () => {
    resetAgentMocks();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: "queued answer" }] });
    const onSettled = vi.fn();
    const runner = createFollowupRunner({
      opts: {
        onBlockReply: async () => {
          throw new Error("delivery failed");
        },
      },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await expect(runner({ ...baseQueuedRun(), onSettled })).resolves.toBeUndefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ outcome: "error", error: "delivery failed" });
  });
});
