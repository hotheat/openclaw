import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  __testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import type { PluginHookSubagentHandoffStagingResult } from "../plugins/types.js";
import {
  enqueueAnnounce,
  getAnnounceQueueSizeForTests,
  resetAnnounceQueuesForTests,
} from "./subagent-announce-queue.js";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type RequesterResolution = {
  requesterSessionKey: string;
  requesterOrigin?: Record<string, unknown>;
} | null;
type SubagentDeliveryTargetResult = {
  origin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sendSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
const chatInjectSpy = vi.fn(async (_req: AgentCallRequest) => ({ ok: true }));
const appendAssistantMessageToSessionTranscriptMock = vi.fn(async () => ({
  ok: true as const,
  sessionFile: "/tmp/requester-session.jsonl",
}));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const readLatestAssistantReplyMock = vi.fn(
  async (_sessionKey?: string): Promise<string | undefined> => "raw subagent reply",
);
const persistSubagentResultSnapshotMock = vi.fn(async () => "stable-result-ref");
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn((_sessionId?: string) => false),
  isEmbeddedPiRunStreaming: vi.fn((_sessionId?: string) => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
const subagentRegistryMock = {
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn((_sessionKey: string) => 0),
  resolveRequesterForChildSession: vi.fn((_sessionKey: string): RequesterResolution => null),
};
const subagentDeliveryTargetHookMock = vi.fn(
  async (_event?: unknown, _ctx?: unknown): Promise<SubagentDeliveryTargetResult | undefined> =>
    undefined,
);
let hasSubagentDeliveryTargetHook = false;
let hasSubagentHandoffStagingHook = true;
let hasSubagentHandoffDeliveryHook = false;
const buildAcceptedStagingResult = (event: unknown): PluginHookSubagentHandoffStagingResult => {
  const handoff = (event as { handoff?: { artifacts?: Array<{ relativePath?: string }> } }).handoff;
  const sourcePaths = (handoff?.artifacts ?? [])
    .map((artifact) => artifact.relativePath?.trim())
    .filter((value): value is string => Boolean(value));
  return {
    policyStatus: "evaluated" as const,
    acceptedArtifacts: sourcePaths.map((sourceRelativePath) => ({
      sourceRelativePath,
      requesterRelativePath: sourceRelativePath,
    })),
    stagedArtifacts: sourcePaths.map((sourceRelativePath) => ({
      sourceRelativePath,
      relativePath: sourceRelativePath,
    })),
    rejections: [],
    failures: [],
  };
};
const subagentHandoffStagingHookMock = vi.fn(async (event: unknown, _ctx: unknown) =>
  buildAcceptedStagingResult(event),
);
const subagentHandoffDeliveryHookMock = vi.fn(
  async (event: unknown, _ctx: unknown): Promise<unknown> => ({
    handled: true,
    deliveredArtifacts:
      (event as { artifacts?: Array<{ relativePath?: string }> }).artifacts
        ?.map((artifact) => artifact.relativePath)
        .filter((value): value is string => Boolean(value)) ?? [],
    failures: [],
  }),
);
const hookRunnerMock = {
  hasHooks: vi.fn((hookName: string) => {
    if (hookName === "subagent_delivery_target") {
      return hasSubagentDeliveryTargetHook;
    }
    if (hookName === "subagent_handoff_staging") {
      return hasSubagentHandoffStagingHook;
    }
    if (hookName === "subagent_handoff_delivery") {
      return hasSubagentHandoffDeliveryHook;
    }
    return false;
  }),
  runSubagentDeliveryTarget: vi.fn((event: unknown, ctx: unknown) =>
    subagentDeliveryTargetHookMock(event, ctx),
  ),
  runSubagentHandoffStaging: vi.fn((event: unknown, ctx: unknown) =>
    subagentHandoffStagingHookMock(event, ctx),
  ),
  runSubagentHandoffDelivery: vi.fn((event: unknown, ctx: unknown) =>
    subagentHandoffDeliveryHookMock(event, ctx),
  ),
};
const chatHistoryMock = vi.fn(async (_sessionKey?: string) => ({
  messages: [] as Array<unknown>,
}));
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
const defaultOutcomeAnnounce = {
  task: "do thing",
  timeoutMs: 10,
  cleanup: "keep" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" } as const,
};

async function getSingleAgentCallParams() {
  await vi.waitFor(() => {
    expect(agentSpy).toHaveBeenCalledTimes(1);
  });
  expect(agentSpy).toHaveBeenCalledTimes(1);
  const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
  return call?.params ?? {};
}

function loadSessionStoreFixture(): Record<string, Record<string, unknown>> {
  return new Proxy(sessionStore, {
    get(target, key: string | symbol) {
      if (typeof key === "string" && !(key in target) && key.includes(":subagent:")) {
        return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      }
      return target[key as keyof typeof target];
    },
  });
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "send") {
      return await sendSpy(typed);
    }
    if (typed.method === "chat.inject") {
      return await chatInjectSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey);
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
      sessionsDeleteSpy(typed);
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("./subagent-result-store.js", () => ({
  persistSubagentResultSnapshot: persistSubagentResultSnapshotMock,
}));

vi.mock("../config/sessions.js", () => ({
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
  loadSessionStore: vi.fn(() => loadSessionStoreFixture()),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/workspace-${agentId}`,
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("./subagent-registry.js", () => subagentRegistryMock);
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

describe("subagent announce formatting", () => {
  let previousFastTestEnv: string | undefined;
  let runSubagentAnnounceFlow: (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];

  beforeAll(async () => {
    ({ runSubagentAnnounceFlow } = await import("./subagent-announce.js"));
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    agentSpy
      .mockClear()
      .mockImplementation(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
    sendSpy
      .mockClear()
      .mockImplementation(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
    chatInjectSpy.mockClear().mockResolvedValue({ ok: true });
    appendAssistantMessageToSessionTranscriptMock
      .mockClear()
      .mockResolvedValue({ ok: true, sessionFile: "/tmp/requester-session.jsonl" });
    sessionsDeleteSpy.mockClear().mockImplementation((_req: AgentCallRequest) => undefined);
    embeddedRunMock.isEmbeddedPiRunActive.mockClear().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockClear().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockClear().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockClear().mockResolvedValue(true);
    subagentRegistryMock.isSubagentSessionRunActive.mockClear().mockReturnValue(true);
    subagentRegistryMock.countActiveDescendantRuns.mockClear().mockReturnValue(0);
    subagentRegistryMock.resolveRequesterForChildSession.mockClear().mockReturnValue(null);
    hasSubagentDeliveryTargetHook = false;
    hasSubagentHandoffStagingHook = true;
    hasSubagentHandoffDeliveryHook = false;
    hookRunnerMock.hasHooks.mockClear();
    hookRunnerMock.runSubagentDeliveryTarget.mockClear();
    hookRunnerMock.runSubagentHandoffStaging.mockClear();
    hookRunnerMock.runSubagentHandoffDelivery.mockClear();
    subagentDeliveryTargetHookMock.mockReset().mockResolvedValue(undefined);
    subagentHandoffStagingHookMock
      .mockReset()
      .mockImplementation(async (event: unknown) => buildAcceptedStagingResult(event));
    subagentHandoffDeliveryHookMock.mockReset().mockResolvedValue(undefined);
    subagentHandoffDeliveryHookMock.mockImplementation(async (event: unknown) => ({
      handled: true,
      deliveredArtifacts:
        (event as { artifacts?: Array<{ relativePath?: string }> }).artifacts
          ?.map((artifact) => artifact.relativePath)
          .filter((value): value is string => Boolean(value)) ?? [],
      failures: [],
    }));
    readLatestAssistantReplyMock.mockClear().mockResolvedValue("raw subagent reply");
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
    sessionStore = {};
    resetAnnounceQueuesForTests();
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("sends instructional message to main agent with status and findings", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-123",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-123",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: true,
      startedAt: 10,
      endedAt: 20,
    });

    expect(agentSpy).toHaveBeenCalled();
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: { message?: string; sessionKey?: string };
    };
    const msg = call?.params?.message as string;
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(msg).toContain("[System Message]");
    expect(msg).toContain("[sessionId: child-session-123]");
    expect(msg).toContain("subagent task");
    expect(msg).toContain("failed");
    expect(msg).toContain("boom");
    expect(msg).toContain("Result:");
    expect(msg).toContain("raw subagent reply");
    expect(msg).toContain("Stats:");
    expect(msg).toContain("A completed subagent task is ready for user delivery.");
    expect(msg).toContain("Convert the result above into your normal assistant voice");
    expect(msg).toContain("Keep this internal context private");
  });

  it("includes success status when outcome is ok", async () => {
    // Use waitForCompletion: false so it uses the provided outcome instead of calling agent.wait
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("completed successfully");
  });

  it("uses child-run announce identity for direct idempotency", async () => {
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-direct-idem",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.idempotencyKey).toBe(
      "announce:v1:agent:main:subagent:worker:run-direct-idem",
    );
  });

  it.each([
    { role: "toolResult", toolOutput: "tool output line 1", childRunId: "run-tool-fallback-1" },
    { role: "tool", toolOutput: "tool output line 2", childRunId: "run-tool-fallback-2" },
  ] as const)(
    "falls back to latest $role output when assistant reply is empty",
    async (testCase) => {
      chatHistoryMock.mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
          {
            role: testCase.role,
            content: [{ type: "text", text: testCase.toolOutput }],
          },
        ],
      });
      readLatestAssistantReplyMock.mockResolvedValue("");

      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        waitForCompletion: false,
      });

      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const msg = call?.params?.message as string;
      expect(msg).toContain(testCase.toolOutput);
    },
  );

  it("uses latest assistant text when it appears after a tool output", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "tool",
          content: [{ type: "text", text: "tool output line" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant final line" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-latest-assistant",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      waitForCompletion: false,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("assistant final line");
  });

  it("keeps full findings and includes compact stats", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-usage",
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
      },
    };
    readLatestAssistantReplyMock.mockResolvedValue(
      Array.from({ length: 140 }, (_, index) => `step-${index}`).join(" "),
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("Result:");
    expect(msg).toContain("Stats:");
    expect(msg).toContain("tokens 1.0k (in 12 / out 1.0k)");
    expect(msg).toContain("prompt/cache 197.0k");
    expect(msg).toContain("[sessionId: child-session-usage]");
    expect(msg).toContain("A completed subagent task is ready for user delivery.");
    expect(msg).toContain(
      `Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`,
    );
    expect(msg).toContain("step-0");
    expect(msg).toContain("step-139");
  });

  it("sends deterministic completion message directly for manual spawn completion", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-direct",
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46,
      },
      "agent:main:main": {
        sessionId: "requester-session",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "final answer: 2" }] }],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const rawMessage = call?.params?.message;
    const msg = typeof rawMessage === "string" ? rawMessage : "";
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(msg).toContain("✅ Subagent main finished");
    expect(msg).toContain("final answer: 2");
    expect(msg).not.toContain("Convert the result above into your normal assistant voice");
    expect(appendAssistantMessageToSessionTranscriptMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      text: msg,
    });
  });

  it("routes completion through requester agent when parent delivery is required", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-parent-delivery",
      },
      "agent:main:main": {
        sessionId: "requester-session-parent-delivery",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "final.pptx ready",
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: {
                    path: "artifacts/pptx-generator/run-1/final.pptx",
                    title: "Deck",
                    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                  },
                  verification: { status: "passed" },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-parent-delivery",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscriptMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(1);
    });
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      expectFinal?: boolean;
    };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(call?.params?.deliver).toBe(true);
    expect(call?.expectFinal).toBe(true);
    const msg = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(msg).toContain("[Subagent completion summary]");
    expect(msg).toContain("Completed: do thing");
    expect(msg).toContain("Succeeded: 1");
    expect(msg).toContain("Failed: 0");
    expect(msg).toContain("Active: 0");
    expect(msg).toContain("final.pptx ready");
    expect(msg).toContain("Deliverable artifacts:");
    expect(msg).toContain("artifacts/pptx-generator/run-1/final.pptx");
    expect(msg).toContain("Delivery: ready");
    expect(msg).toContain("Verification: passed");
    expect(msg).toContain("call the `message` tool");
    expect(msg).toContain(`reply ONLY: ${SILENT_REPLY_TOKEN}`);
    expect(msg).not.toContain("<SUBAGENT_HANDOFF>");
    expect(msg).not.toContain("Stats:");
  });

  it("routes WebChat parent delivery checks through webui artifact publish", async () => {
    const requesterSessionKey = "agent:main:webchat:namespace:chat_1";
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-webchat-parent-delivery",
      },
      [requesterSessionKey]: {
        sessionId: "requester-session-webchat-parent-delivery",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "deck ready",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/pptx-generator/run-2/final.pptx", title: "Deck" },
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-webchat-parent-delivery",
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      requesterOrigin: { channel: "internal" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(params.channel).toBe("internal");
    expect(params.deliver).toBe(false);
    expect(params.to).toBeUndefined();
    expect(message).toContain("Deliverable artifacts:");
    expect(message).toContain("artifacts/pptx-generator/run-2/final.pptx");
    expect(message).toContain("call `webui_artifact_publish`");
    expect(message).not.toContain("call the `message` tool");
    expect(message).not.toContain("<SUBAGENT_HANDOFF>");
  });

  it("does not present failed verification artifacts as deliverable", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-failed-verification",
      },
      "agent:main:main": {
        sessionId: "requester-session-failed-verification",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "verification failed",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/pptx-generator/run-failed/final.pptx", title: "Deck" },
          verification: { status: "failed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-failed-verification",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).not.toContain("Deliverable artifacts:");
    expect(message).not.toContain("artifacts/pptx-generator/run-failed/final.pptx");
    expect(message).not.toContain("call the `message` tool");
    expect(message).not.toContain("call `webui_artifact_publish`");
  });

  it("keeps unmanaged researcher artifacts out of core parent auto-delivery", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-unmanaged-researcher",
      },
      "agent:main:main": {
        sessionId: "requester-session-unmanaged-researcher",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "research complete",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/exports/feishu/research/run-1/report.md",
            title: "Research report",
            mime: "text/markdown",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );
    subagentHandoffStagingHookMock.mockResolvedValueOnce({
      policyStatus: "evaluated",
      acceptedArtifacts: [],
      stagedArtifacts: [],
      rejections: [
        {
          code: "plugin:test-requester",
          message: "Requester policy rejected this artifact.",
        },
      ],
      failures: [],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-unmanaged-researcher",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("research complete");
    expect(message).not.toContain("Deliverable artifacts:");
    expect(message).not.toContain("artifacts/exports/feishu/research/run-1/report.md");
    expect(message).not.toContain("call the `message` tool");
    expect(message).not.toContain("call `webui_artifact_publish`");
  });

  it("preserves Researcher Markdown and citation URLs when stripping handoff metadata", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-researcher-markdown",
      },
      "agent:main:main": {
        sessionId: "requester-session-researcher-markdown",
      },
    };
    const report = [
      "# 调研报告",
      "",
      "## 结论",
      "",
      "- 来源: https://arxiv.org/abs/2607.01234",
      "",
      "| 指标 | 值 |",
      "| --- | --- |",
      "| A | 1 |",
      "",
      "```python",
      "print('kept')",
      "```",
    ].join("\n");
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        report,
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/exports/feishu/research/run-1/report.md",
            title: "Research report",
            mime: "text/markdown",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-researcher-markdown",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain(report);
    expect(message).not.toContain("<SUBAGENT_HANDOFF>");
  });

  it("reports invalid accepted mappings instead of producing a silent empty result", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-invalid-mapping",
      },
      "agent:main:main": {
        sessionId: "requester-session-invalid-mapping",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "research complete",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/exports/feishu/research/run-1/report.md",
            title: "Research report",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );
    subagentHandoffStagingHookMock.mockResolvedValueOnce({
      policyStatus: "evaluated",
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/unknown/not-declared.md",
          requesterRelativePath: "../../escape.md",
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-invalid-mapping",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("Artifact delivery issues:");
    expect(message).toContain("did not accept any valid artifact mapping");
    expect(message).not.toContain("../../escape.md");
    expect(message).not.toContain("artifacts/unknown/not-declared.md");
  });

  it("does not stage or deliver a handoff after the outer announce signal aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    const handoffReply = [
      "research complete",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        export: {
          path: "artifacts/exports/feishu/research/run-1/report.md",
          title: "Research report",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-aborted-handoff",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      roundOneReply: handoffReply,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
      signal: controller.signal,
    });

    expect(didAnnounce).toBe(false);
    expect(subagentHandoffStagingHookMock).not.toHaveBeenCalled();
    expect(subagentHandoffDeliveryHookMock).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("presents failed verification artifacts declared for warning delivery", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-warning-delivery",
      },
      "agent:main:main": {
        sessionId: "requester-session-warning-delivery",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "deck generated with verification issues",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/pptx-generator/run-warning/final.pptx", title: "Deck" },
          verification: {
            status: "failed",
            summary: "Slide 7 contains text overflow.",
          },
          delivery: { status: "warning" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-warning-delivery",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("Deliverable artifacts:");
    expect(message).toContain("artifacts/pptx-generator/run-warning/final.pptx");
    expect(message).toContain("Delivery: warning");
    expect(message).toContain("Verification: failed");
    expect(message).toContain("Verification details: Slide 7 contains text overflow.");
    expect(message).toContain("explicitly tell the user that verification failed");
    expect(message).toContain("call the `message` tool");
  });

  it("requires parent delivery for managed artifacts even when completion delivery is direct", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-managed-direct",
      },
      "agent:main:main": {
        sessionId: "requester-session-managed-direct",
      },
    };
    hasSubagentHandoffDeliveryHook = true;
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "deck ready",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/pptx-generator/run-managed-direct/final.pptx",
            title: "Deck",
          },
          verification: { status: "passed" },
          delivery: { status: "ready" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-managed-direct",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "direct",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(subagentHandoffDeliveryHookMock).not.toHaveBeenCalled();
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("Deliverable artifacts:");
    expect(message).toContain("call the `message` tool");
  });

  it.each([
    { status: "error" as const, error: "boom" },
    { status: "timeout" as const },
    { status: "unknown" as const },
  ])("does not deliver managed artifacts for a $status run", async (outcome) => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: `child-session-${outcome.status}-artifact`,
      },
      "agent:main:main": {
        sessionId: `requester-session-${outcome.status}-artifact`,
      },
    };
    hasSubagentHandoffDeliveryHook = true;
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "partial deck",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: `artifacts/pptx-generator/run-${outcome.status}/final.pptx`,
            title: "Deck",
          },
          verification: { status: "passed" },
          delivery: { status: "ready" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: `run-${outcome.status}-artifact`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      outcome,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    expect(subagentHandoffStagingHookMock).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryEligible: false, outcome: outcome.status }),
      expect.anything(),
    );
    expect(subagentHandoffDeliveryHookMock).not.toHaveBeenCalled();
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).not.toContain("Deliverable artifacts:");
    expect(message).not.toContain("call the `message` tool");
    expect(message).not.toContain("Deployment policy did not accept any valid artifact mapping");
  });

  it("binds a missing-channel WebChat parent turn to internal delivery", async () => {
    const requesterSessionKey = "agent:main:webchat:namespace:chat_1";
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-webchat-missing-channel",
      },
      [requesterSessionKey]: {
        sessionId: "requester-session-webchat-missing-channel",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "deck ready",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/pptx-generator/run-3/final.pptx", title: "Deck" },
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-webchat-missing-channel",
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(params.channel).toBe("internal");
    expect(params.deliver).toBe(false);
    expect(message).toContain("Deliverable artifacts:");
    expect(message).toContain("artifacts/pptx-generator/run-3/final.pptx");
    expect(message).toContain("call `webui_artifact_publish`");
    expect(message).not.toContain("call the `message` tool");
  });

  it("coalesces sibling WebChat artifacts on the internal surface", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const requesterSessionKey = "agent:main:webchat:namespace:chat_batch";
    sessionStore = {
      "agent:main:subagent:webchat-a": {
        sessionId: "child-session-webchat-a",
      },
      "agent:main:subagent:webchat-b": {
        sessionId: "child-session-webchat-b",
      },
      [requesterSessionKey]: {
        sessionId: "requester-session-webchat-batch",
      },
    };
    readLatestAssistantReplyMock.mockImplementation(async (params?: unknown) => {
      const sessionKey =
        typeof params === "string"
          ? params
          : (params as { sessionKey?: string } | undefined)?.sessionKey;
      const suffix = sessionKey?.endsWith("webchat-a") ? "a" : "b";
      return [
        `deck ${suffix} ready`,
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: `artifacts/pptx-generator/webchat-${suffix}/final.pptx`,
            title: `Deck ${suffix}`,
          },
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n");
    });

    const results = await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:webchat-a",
        childRunId: "run-webchat-a",
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        requesterOrigin: { channel: "internal" },
        ...defaultOutcomeAnnounce,
        label: "deck-a",
        expectsCompletionMessage: true,
        completionDelivery: "parent",
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:webchat-b",
        childRunId: "run-webchat-b",
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        requesterOrigin: { channel: "internal" },
        ...defaultOutcomeAnnounce,
        label: "deck-b",
        expectsCompletionMessage: true,
        completionDelivery: "parent",
      }),
    ]);

    expect(results).toEqual([true, true]);
    await vi.waitFor(
      () => {
        expect(agentSpy).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 },
    );
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(params.channel).toBe("internal");
    expect(params.deliver).toBe(false);
    expect(message).toContain("artifacts/pptx-generator/webchat-a/final.pptx");
    expect(message).toContain("artifacts/pptx-generator/webchat-b/final.pptx");
    expect(message.match(/call `webui_artifact_publish`/g)).toHaveLength(1);
  });

  it("strips malformed handoff metadata from parent completion prompts", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-malformed-handoff",
      },
      "agent:main:main": {
        sessionId: "requester-session-malformed-handoff",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "deck generation failed",
        "<SUBAGENT_HANDOFF>",
        "{invalid-json}",
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-malformed-handoff",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    expect(subagentHandoffStagingHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffMalformed: true,
        handoff: expect.objectContaining({
          quality: expect.objectContaining({ deliveryStatus: "blocked" }),
          artifacts: [],
        }),
      }),
      expect.anything(),
    );
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("deck generation failed");
    expect(message).toContain("Malformed subagent handoff metadata");
    expect(message).not.toContain("<SUBAGENT_HANDOFF>");
    expect(message).not.toContain("{invalid-json}");
  });

  it("stages a handoff trailer with trailing text as malformed", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-trailing-handoff",
      },
      "agent:main:main": {
        sessionId: "requester-session-trailing-handoff",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "deck generation finished",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/pptx-generator/run-trailing/final.pptx",
          },
          verification: { status: "passed" },
          delivery: { status: "ready" },
        }),
        "</SUBAGENT_HANDOFF>",
        "unexpected trailing text",
      ].join("\n"),
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-trailing-handoff",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    expect(subagentHandoffStagingHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffMalformed: true,
        handoff: expect.objectContaining({
          quality: expect.objectContaining({ deliveryStatus: "blocked" }),
          artifacts: [],
        }),
      }),
      expect.anything(),
    );
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("unexpected trailing text");
    expect(message).toContain("Malformed subagent handoff metadata");
    expect(message).not.toContain("artifacts/pptx-generator/run-trailing/final.pptx");
  });

  it("keeps parent artifact delivery checks when sibling runs are still active", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-parent-delivery-active-sibling",
      },
      "agent:main:main": {
        sessionId: "requester-session-parent-delivery-active-sibling",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "final.pptx ready",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/pptx-generator/run-active-sibling/final.pptx",
            title: "Deck",
          },
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 1 : 0,
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-parent-delivery-active-sibling",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(1);
    });
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const msg = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(msg).toContain("Active: 1");
    expect(msg).toContain("Other subagent runs are still active.");
    expect(msg).toContain("For user-requested deliverables listed above");
  });

  it("coalesces parent completions into one requester turn", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    sessionStore = {
      "agent:main:subagent:batch-a": {
        sessionId: "child-session-batch-a",
      },
      "agent:main:subagent:batch-b": {
        sessionId: "child-session-batch-b",
      },
      "agent:main:main": {
        sessionId: "requester-session-batch",
      },
    };
    readLatestAssistantReplyMock.mockImplementation(async (params?: unknown) => {
      const sessionKey =
        typeof params === "string"
          ? params
          : (params as { sessionKey?: string } | undefined)?.sessionKey;
      return sessionKey?.endsWith("batch-a") ? "wrote AACR_071.jsonl" : "wrote AACR_072.jsonl";
    });

    const results = await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:batch-a",
        childRunId: "run-batch-a",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
        ...defaultOutcomeAnnounce,
        label: "AACR-071",
        expectsCompletionMessage: true,
        completionDelivery: "parent",
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:batch-b",
        childRunId: "run-batch-b",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
        ...defaultOutcomeAnnounce,
        label: "AACR-072",
        expectsCompletionMessage: true,
        completionDelivery: "parent",
      }),
    ]);

    expect(results).toEqual([true, true]);
    await vi.waitFor(
      () => {
        expect(agentSpy).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 },
    );
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      expectFinal?: boolean;
    };
    const message = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(call?.expectFinal).toBe(true);
    expect(message).toContain("Completed: AACR-071, AACR-072");
    expect(message).toContain("Succeeded: 2");
    expect(message).toContain("Failed: 0");
    expect(message).toContain("Active: 0");
    expect(message).toContain("wrote AACR_071.jsonl");
    expect(message).toContain("wrote AACR_072.jsonl");
    expect(message).not.toContain("Stats:");
    expect(message).not.toContain("Parked TaskFlows");
    expect(message).not.toContain("For verified user-requested deliverables");
  });

  it("keeps one pending parent wake while the requester run is active", async () => {
    let releaseRequester = (_settled: boolean) => {};
    const requesterSettled = new Promise<boolean>((resolve) => {
      releaseRequester = resolve;
    });
    embeddedRunMock.isEmbeddedPiRunActive.mockImplementation(
      (sessionId?: string) => sessionId === "requester-session-busy",
    );
    embeddedRunMock.waitForEmbeddedPiRunEnd
      .mockImplementationOnce(async () => await requesterSettled)
      .mockResolvedValue(true);
    sessionStore = {
      "agent:main:subagent:batch-a": {
        sessionId: "child-session-busy-a",
      },
      "agent:main:subagent:batch-b": {
        sessionId: "child-session-busy-b",
      },
      "agent:main:main": {
        sessionId: "requester-session-busy",
      },
    };

    const firstAnnounce = runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:batch-a",
      childRunId: "run-busy-a",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      label: "AACR-073",
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });
    await vi.waitFor(() => {
      expect(embeddedRunMock.waitForEmbeddedPiRunEnd).toHaveBeenCalledTimes(1);
    });

    const secondAnnounce = runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:batch-b",
      childRunId: "run-busy-b",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      label: "AACR-074",
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    await vi.waitFor(() => {
      expect(getAnnounceQueueSizeForTests("completion:agent:main:main")).toBe(2);
    });
    expect(agentSpy).not.toHaveBeenCalled();
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    releaseRequester(true);

    await expect(Promise.all([firstAnnounce, secondAnnounce])).resolves.toEqual([true, true]);
    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(1);
    });
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const message = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(message).toContain("Completed: AACR-073, AACR-074");
  });

  it("keeps delete-mode child sessions when parent completion delivery fails", async () => {
    agentSpy.mockRejectedValueOnce(new Error("gateway unavailable"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:delete-on-success",
      childRunId: "run-delete-on-success",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      cleanup: "delete",
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(false);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("keeps truncated delete-mode results available through session history", async () => {
    const childSessionKey = "agent:main:subagent:truncated-result";
    sessionStore = {
      [childSessionKey]: { sessionId: "child-session-truncated" },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey,
      childRunId: "run-truncated-result",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      cleanup: "delete",
      roundOneReply: "x".repeat(10_000),
      expectsCompletionMessage: true,
      completionDelivery: "parent",
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(call?.params?.message).toContain("Truncated: true");
    expect(call?.params?.message).toContain(`Result session: ${childSessionKey}`);
    expect(call?.params?.message).toContain("Result ref: stable-result-ref");
    expect(call?.params?.message).toContain(
      "continue at nextContentOffset until contentHasMore=false",
    );
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("keeps completion-mode delivery coordinated when sibling runs are still active", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-coordinated",
      },
      "agent:main:main": {
        sessionId: "requester-session-coordinated",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "final answer: 2" }] }],
    });
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 1 : 0,
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-coordinated",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscriptMock).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const rawMessage = call?.params?.message;
    const msg = typeof rawMessage === "string" ? rawMessage : "";
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(msg).toContain("There are still 1 active subagent run for this session.");
    expect(msg).toContain(
      "If they are part of the same workflow, wait for the remaining results before sending a user update.",
    );
  });

  it("direct completion delivery bypasses requester coordination when sibling runs are active", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-direct-explicit",
      },
      "agent:main:main": {
        sessionId: "requester-session-direct-explicit",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce("researcher final");
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 1 : 0,
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-explicit",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "direct",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const msg = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(msg).toContain("researcher final");
    expect(msg).not.toContain("Convert the result above into your normal assistant voice");
  });

  it("injects direct completion into the requester WebChat session without running the parent agent", async () => {
    const requesterSessionKey = "agent:feishu-ou_test:webchat:namespace:chat_1";
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-webchat-direct",
      },
      [requesterSessionKey]: {
        sessionId: "requester-session-webchat-direct",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "researcher final",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/exports/researcher/run-1/report.md",
            title: "Report",
            mime: "text/markdown",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );
    hasSubagentHandoffStagingHook = true;
    hasSubagentHandoffDeliveryHook = true;

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-webchat-direct",
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      requesterOrigin: { channel: "internal" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "direct",
      sourceToolCallId: "spawn-call-webchat",
    });

    expect(didAnnounce).toBe(true);
    expect(chatInjectSpy).toHaveBeenCalledTimes(1);
    expect(chatInjectSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "chat.inject",
      params: {
        sessionKey: requesterSessionKey,
        message: expect.stringContaining("researcher final"),
        idempotencyKey: expect.any(String),
      },
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
    expect(subagentHandoffStagingHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-webchat-direct",
        requesterSessionKey,
        sourceToolCallId: "spawn-call-webchat",
        content: expect.stringContaining("<SUBAGENT_HANDOFF>"),
      }),
      expect.objectContaining({ requesterSessionKey }),
    );
    expect(subagentHandoffDeliveryHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey,
        sourceToolCallId: "spawn-call-webchat",
        artifacts: [
          {
            sourceRelativePath: "artifacts/exports/researcher/run-1/report.md",
            relativePath: "artifacts/exports/researcher/run-1/report.md",
            fileName: undefined,
            title: "Report",
            mimeType: "text/markdown",
            profileId: undefined,
            deliveryPolicy: undefined,
          },
        ],
      }),
      expect.objectContaining({ requesterSessionKey }),
    );
    expect(subagentHandoffDeliveryHookMock.mock.invocationCallOrder[0]).toBeLessThan(
      chatInjectSpy.mock.invocationCallOrder[0],
    );
  });

  it("sends a confirmation prompt without invoking automatic channel delivery", async () => {
    const relativePath = "artifacts/exports/feishu/run-confirm/report.md";
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-confirmation",
      },
      "agent:main:main": {
        sessionId: "requester-session-confirmation",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce(
      [
        "researcher final",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: relativePath,
            title: "Report",
            mime: "text/markdown",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );
    subagentHandoffStagingHookMock.mockResolvedValueOnce({
      policyStatus: "evaluated",
      acceptedArtifacts: [
        {
          sourceRelativePath: relativePath,
          requesterRelativePath: relativePath,
          profileId: "researcher-export",
          deliveryPolicy: "confirmation",
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    });
    hasSubagentHandoffDeliveryHook = true;

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-confirmation",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "direct",
    });

    expect(didAnnounce).toBe(true);
    expect(subagentHandoffDeliveryHookMock).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(call.params?.message).toContain("researcher final");
    expect(call.params?.message).toContain(
      "A result file is ready. Reply that you want the file sent to receive it.",
    );
    expect(call.params?.message).not.toContain(relativePath);
  });

  it("direct completion delivery does not fall back to requester agent without a direct target", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-direct-no-target",
      },
      "agent:main:main": {
        sessionId: "requester-session-direct-no-target",
      },
    };
    readLatestAssistantReplyMock.mockResolvedValueOnce("researcher final");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-no-target",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {},
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      completionDelivery: "direct",
    });

    expect(didAnnounce).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("keeps session-mode completion delivery on the bound destination when sibling runs are active", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-bound",
      },
      "agent:main:main": {
        sessionId: "requester-session-bound",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "bound answer: 2" }] }],
    });
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 1 : 0,
    );
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "acct-1",
      listBySession: (targetSessionKey: string) =>
        targetSessionKey === "agent:main:subagent:test"
          ? [
              {
                bindingId: "discord:acct-1:thread-bound-1",
                targetSessionKey,
                targetKind: "subagent",
                conversation: {
                  channel: "discord",
                  accountId: "acct-1",
                  conversationId: "thread-bound-1",
                  parentConversationId: "parent-main",
                },
                status: "active",
                boundAt: Date.now(),
              },
            ]
          : [],
      resolveByConversation: () => null,
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-session-bound-direct",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      spawnMode: "session",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:thread-bound-1");
  });

  it("does not duplicate to main channel when two active bound sessions complete from the same requester channel", async () => {
    sessionStore = {
      "agent:main:subagent:child-a": {
        sessionId: "child-session-a",
      },
      "agent:main:subagent:child-b": {
        sessionId: "child-session-b",
      },
      "agent:main:main": {
        sessionId: "requester-session-main",
      },
    };

    // Simulate active sibling runs so non-bound paths would normally coordinate via agent().
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 2 : 0,
    );
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "acct-1",
      listBySession: (targetSessionKey: string) => {
        if (targetSessionKey === "agent:main:subagent:child-a") {
          return [
            {
              bindingId: "discord:acct-1:thread-child-a",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "acct-1",
                conversationId: "thread-child-a",
                parentConversationId: "main-parent-channel",
              },
              status: "active",
              boundAt: Date.now(),
            },
          ];
        }
        if (targetSessionKey === "agent:main:subagent:child-b") {
          return [
            {
              bindingId: "discord:acct-1:thread-child-b",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "acct-1",
                conversationId: "thread-child-b",
                parentConversationId: "main-parent-channel",
              },
              status: "active",
              boundAt: Date.now(),
            },
          ];
        }
        return [];
      },
      resolveByConversation: () => null,
    });

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:child-a",
        childRunId: "run-child-a",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: {
          channel: "discord",
          to: "channel:main-parent-channel",
          accountId: "acct-1",
        },
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        spawnMode: "session",
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:child-b",
        childRunId: "run-child-b",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: {
          channel: "discord",
          to: "channel:main-parent-channel",
          accountId: "acct-1",
        },
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        spawnMode: "session",
      }),
    ]);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(agentSpy).not.toHaveBeenCalled();

    const directTargets = sendSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { to?: string } })?.params?.to,
    );
    expect(directTargets).toEqual(
      expect.arrayContaining(["channel:thread-child-a", "channel:thread-child-b"]),
    );
    expect(directTargets).not.toContain("channel:main-parent-channel");
  });

  it("uses completion direct-send headers for error and timeout outcomes", async () => {
    const cases = [
      {
        childSessionId: "child-session-direct-error",
        requesterSessionId: "requester-session-error",
        childRunId: "run-direct-completion-error",
        replyText: "boom details",
        outcome: { status: "error", error: "boom" } as const,
        expectedHeader: "❌ Subagent main failed this task (session remains active)",
        excludedHeader: "✅ Subagent main",
        spawnMode: "session" as const,
      },
      {
        childSessionId: "child-session-direct-timeout",
        requesterSessionId: "requester-session-timeout",
        childRunId: "run-direct-completion-timeout",
        replyText: "partial output",
        outcome: { status: "timeout" } as const,
        expectedHeader: "⏱️ Subagent main timed out",
        excludedHeader: "✅ Subagent main finished",
        spawnMode: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      sendSpy.mockClear();
      sessionStore = {
        "agent:main:subagent:test": {
          sessionId: testCase.childSessionId,
        },
        "agent:main:main": {
          sessionId: testCase.requesterSessionId,
        },
      };
      chatHistoryMock.mockResolvedValueOnce({
        messages: [{ role: "assistant", content: [{ type: "text", text: testCase.replyText }] }],
      });
      readLatestAssistantReplyMock.mockResolvedValue("");

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
        ...defaultOutcomeAnnounce,
        outcome: testCase.outcome,
        expectsCompletionMessage: true,
        ...(testCase.spawnMode ? { spawnMode: testCase.spawnMode } : {}),
      });

      expect(didAnnounce).toBe(true);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
      const rawMessage = call?.params?.message;
      const msg = typeof rawMessage === "string" ? rawMessage : "";
      expect(msg).toContain(testCase.expectedHeader);
      expect(msg).toContain(testCase.replyText);
      expect(msg).not.toContain(testCase.excludedHeader);
    }
  });

  it("routes manual completion direct-send using requester thread hints", async () => {
    const cases = [
      {
        childSessionId: "child-session-direct-thread",
        requesterSessionId: "requester-session-thread",
        childRunId: "run-direct-stale-thread",
        requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
        requesterSessionMeta: {
          lastChannel: "discord",
          lastTo: "channel:stale",
          lastThreadId: 42,
        },
        expectedThreadId: undefined,
      },
      {
        childSessionId: "child-session-direct-thread-pass",
        requesterSessionId: "requester-session-thread-pass",
        childRunId: "run-direct-thread-pass",
        requesterOrigin: {
          channel: "discord",
          to: "channel:12345",
          accountId: "acct-1",
          threadId: 99,
        },
        requesterSessionMeta: {},
        expectedThreadId: "99",
      },
    ] as const;

    for (const testCase of cases) {
      sendSpy.mockClear();
      agentSpy.mockClear();
      sessionStore = {
        "agent:main:subagent:test": {
          sessionId: testCase.childSessionId,
        },
        "agent:main:main": {
          sessionId: testCase.requesterSessionId,
          ...testCase.requesterSessionMeta,
        },
      };
      chatHistoryMock.mockResolvedValueOnce({
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      });

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: testCase.requesterOrigin,
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });

      expect(didAnnounce).toBe(true);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy).not.toHaveBeenCalled();
      const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
      expect(call?.params?.channel).toBe("discord");
      expect(call?.params?.to).toBe("channel:12345");
      expect(call?.params?.threadId).toBe(testCase.expectedThreadId);
    }
  });

  it("uses hook-provided thread target across requester thread variants", async () => {
    const cases = [
      {
        childRunId: "run-direct-thread-bound",
        requesterOrigin: {
          channel: "discord",
          to: "channel:12345",
          accountId: "acct-1",
          threadId: "777",
        },
      },
      {
        childRunId: "run-direct-thread-bound-single",
        requesterOrigin: {
          channel: "discord",
          to: "channel:12345",
          accountId: "acct-1",
        },
      },
      {
        childRunId: "run-direct-thread-no-match",
        requesterOrigin: {
          channel: "discord",
          to: "channel:12345",
          accountId: "acct-1",
          threadId: "999",
        },
      },
    ] as const;

    for (const testCase of cases) {
      sendSpy.mockClear();
      hasSubagentDeliveryTargetHook = true;
      subagentDeliveryTargetHookMock.mockResolvedValueOnce({
        origin: {
          channel: "discord",
          accountId: "acct-1",
          to: "channel:777",
          threadId: "777",
        },
      });

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: testCase.requesterOrigin,
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        spawnMode: "session",
      });

      expect(didAnnounce).toBe(true);
      expect(subagentDeliveryTargetHookMock).toHaveBeenCalledWith(
        {
          childSessionKey: "agent:main:subagent:test",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: testCase.requesterOrigin,
          childRunId: testCase.childRunId,
          spawnMode: "session",
          expectsCompletionMessage: true,
        },
        {
          runId: testCase.childRunId,
          childSessionKey: "agent:main:subagent:test",
          requesterSessionKey: "agent:main:main",
        },
      );
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
      expect(call?.params?.channel).toBe("discord");
      expect(call?.params?.to).toBe("channel:777");
      expect(call?.params?.threadId).toBe("777");
      const message = typeof call?.params?.message === "string" ? call.params.message : "";
      expect(message).toContain("completed this task (session remains active)");
      expect(message).not.toContain("finished");
    }
  });

  it.each([
    {
      name: "delivery-target hook returns no override",
      childRunId: "run-direct-thread-persisted",
      hookResult: undefined,
    },
    {
      name: "delivery-target hook returns non-deliverable channel",
      childRunId: "run-direct-thread-multi-no-origin",
      hookResult: {
        origin: {
          channel: "webchat",
          to: "conversation:123",
        },
      },
    },
  ])("keeps requester origin when $name", async ({ childRunId, hookResult }) => {
    hasSubagentDeliveryTargetHook = true;
    subagentDeliveryTargetHookMock.mockResolvedValueOnce(hookResult);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "discord",
        to: "channel:12345",
        accountId: "acct-1",
      },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      spawnMode: "session",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(call?.params?.threadId).toBeUndefined();
  });

  it("steers announcements into an active run when queue mode is steer", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(true);
    embeddedRunMock.queueEmbeddedPiMessage.mockReturnValue(true);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "steer",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-789",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(embeddedRunMock.queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "session-123",
      expect.stringContaining("[System Message]"),
    );
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("queues announce delivery with origin account routing", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-456",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "kev",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-999",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    expect(params.channel).toBe("whatsapp");
    expect(params.to).toBe("+1555");
    expect(params.accountId).toBe("kev");
  });

  it("keeps queued idempotency unique for same-ms distinct child runs", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-followup",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "followup",
        queueDebounceMs: 0,
      },
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-1",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        task: "first task",
      });
      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-2",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        task: "second task",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(agentSpy).toHaveBeenCalledTimes(2);
    const idempotencyKeys = agentSpy.mock.calls
      .map((call) => (call[0] as { params?: Record<string, unknown> })?.params?.idempotencyKey)
      .filter((value): value is string => typeof value === "string");
    expect(idempotencyKeys).toContain("announce:v1:agent:main:subagent:worker:run-1");
    expect(idempotencyKeys).toContain("announce:v1:agent:main:subagent:worker:run-2");
    expect(new Set(idempotencyKeys).size).toBe(2);
  });

  it("prefers direct delivery first for completion-mode and then queues on direct failure", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-collect",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };
    sendSpy.mockRejectedValueOnce(new Error("direct delivery unavailable"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-direct-fallback",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "send",
      params: { sessionKey: "agent:main:main" },
    });
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: "agent:main:main" },
    });
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: { channel: "whatsapp", to: "+1555", deliver: true },
    });
  });

  it("returns failure for completion-mode when direct delivery fails and queue fallback is unavailable", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-direct-only",
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
    };
    sendSpy.mockRejectedValueOnce(new Error("direct delivery unavailable"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-direct-fail",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).toHaveBeenCalledTimes(0);
  });

  it("returns failure when direct delivery fails and the fallback queue rejects the announce", async () => {
    let releaseDrain: (() => void) | undefined;
    const drainBlocked = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    try {
      embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
      embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
      sessionStore = {
        "agent:main:main": {
          sessionId: "session-full-queue",
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "acct-full-queue",
          queueMode: "followup",
          queueDebounceMs: 100,
          queueCap: 1,
          queueDrop: "new",
        },
      };
      enqueueAnnounce({
        key: "agent:main:main:acct:acct-full-queue",
        item: {
          announceId: "announce:existing",
          prompt: "existing completion",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:main",
        },
        settings: {
          mode: "followup",
          debounceMs: 100,
          cap: 1,
          dropPolicy: "new",
          beforeDrain: async () => await drainBlocked,
        },
        send: async () => {},
      });
      sendSpy.mockRejectedValueOnce(new Error("direct delivery unavailable"));

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-completion-queue-rejected",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        expectsCompletionMessage: true,
        requesterOrigin: {
          channel: "whatsapp",
          to: "+1555",
          accountId: "acct-full-queue",
        },
        ...defaultOutcomeAnnounce,
      });

      expect(didAnnounce).toBe(false);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy).not.toHaveBeenCalled();
      expect(getAnnounceQueueSizeForTests("agent:main:main:acct:acct-full-queue")).toBe(1);
    } finally {
      resetAnnounceQueuesForTests();
      releaseDrain?.();
    }
  });

  it("uses assistant output for completion-mode when latest assistant text exists", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "old tool output" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant completion text" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-assistant-output",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("assistant completion text");
    expect(msg).not.toContain("old tool output");
  });

  it("routes an unhandled export through the parent without exposing handoff metadata", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "已完成一版可交付的内部扫描。",
                "",
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  summary: "已完成 GLP-1 路线扫描。",
                  reason: "该任务信息量较大，适合文件交付。",
                  export: {
                    path: "artifacts/exports/feishu/glp1-route-scan-20260518/glp1-route-scan.md",
                    title: "GLP-1 路线扫描",
                    mime: "text/markdown",
                  },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-export-file",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("已完成一版可交付的内部扫描。");
    expect(message).toContain("Deliverable artifacts:");
    expect(message).toContain("call the `message` tool");
    expect(message).not.toContain("<SUBAGENT_HANDOFF>");
  });

  it("keeps only failed direct-delivery artifacts for parent recovery", async () => {
    hasSubagentHandoffStagingHook = true;
    hasSubagentHandoffDeliveryHook = true;
    const deliveredPath = "artifacts/exports/feishu/glp1-summary.md";
    const failedPath = "artifacts/exports/feishu/glp1-data.csv";
    subagentHandoffDeliveryHookMock.mockResolvedValueOnce({
      handled: true,
      deliveredArtifacts: [deliveredPath],
      failures: [{ relativePath: failedPath, message: "upload failed" }],
    });
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "已完成一版可交付的内部扫描。",
                "",
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  exports: [
                    {
                      path: deliveredPath,
                      title: "GLP-1 summary",
                      mime: "text/markdown",
                    },
                    {
                      path: failedPath,
                      title: "GLP-1 data",
                      mime: "text/csv",
                    },
                  ],
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-export-file-failed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "default" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    const params = await getSingleAgentCallParams();
    const message = typeof params.message === "string" ? params.message : "";
    expect(message).toContain("Artifact delivery issues:");
    expect(message.match(/upload failed/g)).toHaveLength(1);
    expect(message).toContain(failedPath);
    expect(message).not.toContain(deliveredPath);
    expect(message).not.toContain("Artifact delivery incomplete");
    expect(message).not.toContain("<SUBAGENT_HANDOFF>");
  });

  it("falls back to latest tool output for completion-mode when assistant output is empty", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "tool output only" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-tool-output",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("tool output only");
  });

  it("does not fall back to tool output for completion-mode when the run failed", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "tool output only" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-tool-output-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
      outcome: { status: "error", error: "terminated" },
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("failed");
    expect(msg).toContain("terminated");
    expect(msg).not.toContain("tool output only");
    expect(msg).toContain("failed before producing a final summary");
  });

  it("ignores user text when deriving fallback completion output", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "user prompt should not be announced" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-ignore-user",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("✅ Subagent main finished");
    expect(msg).not.toContain("user prompt should not be announced");
  });

  it("does not crash when completion-mode has no outcome and no fallback reply", async () => {
    chatHistoryMock.mockResolvedValue({ messages: [] });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-no-outcome-no-reply",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      task: "do thing",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: undefined,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("✅ Subagent main finished");
  });

  it("queues announce delivery back into requester subagent session", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:subagent:orchestrator": {
        sessionId: "session-orchestrator",
        spawnDepth: 1,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker-queued",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", to: "+1555", accountId: "acct" },
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
  });

  it.each([
    {
      testName: "includes threadId when origin has an active topic/thread",
      childRunId: "run-thread",
      expectedThreadId: "42",
      requesterOrigin: undefined,
    },
    {
      testName: "prefers requesterOrigin.threadId over session entry threadId",
      childRunId: "run-thread-override",
      expectedThreadId: "99",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
        threadId: 99,
      },
    },
  ] as const)("thread routing: $testName", async (testCase) => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-thread",
        lastChannel: "telegram",
        lastTo: "telegram:123",
        lastThreadId: 42,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: testCase.childRunId,
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...(testCase.requesterOrigin ? { requesterOrigin: testCase.requesterOrigin } : {}),
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    expect(params.channel).toBe("telegram");
    expect(params.to).toBe("telegram:123");
    expect(params.threadId).toBe(testCase.expectedThreadId);
  });

  it("splits collect-mode queues when accountId differs", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-acc-split",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-a",
        childRunId: "run-a",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-a" },
        ...defaultOutcomeAnnounce,
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-b",
        childRunId: "run-b",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-b" },
        ...defaultOutcomeAnnounce,
      }),
    ]);

    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(2);
    });
    const accountIds = agentSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { accountId?: string } })?.params?.accountId,
    );
    expect(accountIds).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
  });

  it.each([
    {
      testName: "uses requester origin for direct announce when not queued",
      childRunId: "run-direct",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123" },
      expectedChannel: "whatsapp",
      expectedAccountId: "acct-123",
    },
    {
      testName: "normalizes requesterOrigin for direct announce delivery",
      childRunId: "run-direct-origin",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-987 " },
      expectedChannel: "whatsapp",
      expectedAccountId: "acct-987",
    },
  ] as const)("direct announce: $testName", async (testCase) => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: testCase.childRunId,
      requesterSessionKey: "agent:main:main",
      requesterOrigin: testCase.requesterOrigin,
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      expectFinal?: boolean;
    };
    expect(call?.params?.channel).toBe(testCase.expectedChannel);
    expect(call?.params?.accountId).toBe(testCase.expectedAccountId);
    expect(call?.expectFinal).toBe(true);
  });

  it("injects direct announce into requester subagent session instead of chat channel", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
  });

  it("keeps completion-mode announce internal for nested requester subagent sessions", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    hasSubagentHandoffDeliveryHook = true;
    const nestedReply = [
      "deck ready",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        export: {
          path: "artifacts/pptx-generator/nested/final.pptx",
          title: "Nested deck",
        },
        verification: { status: "passed" },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");
    readLatestAssistantReplyMock.mockResolvedValue(nestedReply);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:orchestrator:subagent:worker",
      childRunId: "run-worker-nested-completion",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      expectsCompletionMessage: true,
      completionDelivery: "parent",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(1);
    });
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
    expect(subagentHandoffStagingHookMock).toHaveBeenCalledTimes(1);
    expect(subagentHandoffDeliveryHookMock).not.toHaveBeenCalled();
    const message = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(message).toContain("Use these results as an internal orchestration update.");
    expect(message).not.toContain("call the `message` tool");
    expect(message).not.toContain("call `webui_artifact_publish`");
  });

  it("keeps direct completion delivery internal for nested requester subagent sessions", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    readLatestAssistantReplyMock.mockResolvedValueOnce("nested worker final");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:orchestrator:subagent:worker",
      childRunId: "run-worker-nested-direct-completion",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      expectsCompletionMessage: true,
      completionDelivery: "direct",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(1);
    });
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
  });

  it("retries reading subagent output when early lifecycle completion had no text", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValueOnce(true).mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockResolvedValue(true);
    readLatestAssistantReplyMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Read #12 complete.");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-1",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "context-stress-test",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(embeddedRunMock.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("child-session-1", 1000);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(call?.params?.message).toContain("Read #12 complete.");
    expect(call?.params?.message).not.toContain("(no output)");
  });

  it("uses advisory guidance when sibling subagents are still active", async () => {
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 2 : 0,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("There are still 2 active subagent runs for this session.");
    expect(msg).toContain(
      "If they are part of the same workflow, wait for the remaining results before sending a user update.",
    );
    expect(msg).toContain("If they are unrelated, respond normally using only the result above.");
  });

  it("defers announce while finished runs still have active descendants", async () => {
    const cases = [
      {
        childRunId: "run-parent",
        expectsCompletionMessage: false,
      },
      {
        childRunId: "run-parent-completion",
        expectsCompletionMessage: true,
      },
    ] as const;

    for (const testCase of cases) {
      agentSpy.mockClear();
      sendSpy.mockClear();
      subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent" ? 1 : 0,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...(testCase.expectsCompletionMessage ? { expectsCompletionMessage: true } : {}),
        ...defaultOutcomeAnnounce,
      });

      expect(didAnnounce).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    }
  });

  it("waits for updated synthesized output before announcing nested subagent completion", async () => {
    let historyReads = 0;
    chatHistoryMock.mockImplementation(async () => {
      historyReads += 1;
      if (historyReads < 3) {
        return {
          messages: [{ role: "assistant", content: "Waiting for child output..." }],
        };
      }
      return {
        messages: [{ role: "assistant", content: "Final synthesized answer." }],
      };
    });
    readLatestAssistantReplyMock.mockResolvedValue(undefined);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:parent",
      childRunId: "run-parent-synth",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
      timeoutMs: 100,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message ?? "";
    expect(msg).toContain("Final synthesized answer.");
    expect(msg).not.toContain("Waiting for child output...");
  });

  it("bubbles child announce to parent requester when requester subagent already ended", async () => {
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", to: "+1555", accountId: "acct-main" },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.to).toBe("+1555");
    expect(call?.params?.accountId).toBe("acct-main");
  });

  it("keeps announce retryable when ended requester subagent has no fallback requester", async () => {
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue(null);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf-missing-fallback",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
      cleanup: "delete",
    });

    expect(didAnnounce).toBe(false);
    expect(subagentRegistryMock.resolveRequesterForChildSession).toHaveBeenCalledWith(
      "agent:main:subagent:orchestrator",
    );
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("defers announce when child run stays active after settle timeout", async () => {
    const cases = [
      {
        childRunId: "run-child-active",
        task: "context-stress-test",
        expectsCompletionMessage: false,
      },
      {
        childRunId: "run-child-active-completion",
        task: "completion-context-stress-test",
        expectsCompletionMessage: true,
      },
    ] as const;

    for (const testCase of cases) {
      agentSpy.mockClear();
      sendSpy.mockClear();
      embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
      embeddedRunMock.waitForEmbeddedPiRunEnd.mockResolvedValue(false);
      sessionStore = {
        "agent:main:subagent:test": {
          sessionId: "child-session-active",
        },
      };

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        task: testCase.task,
        ...(testCase.expectsCompletionMessage ? { expectsCompletionMessage: true } : {}),
      });

      expect(didAnnounce).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    }
  });

  it("prefers requesterOrigin channel over stale session lastChannel in queued announce", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    // Session store has stale whatsapp channel, but the requesterOrigin says bluebubbles.
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-stale",
        lastChannel: "whatsapp",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-stale-channel",
      requesterSessionKey: "main",
      requesterOrigin: { channel: "telegram", to: "telegram:123" },
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    // The channel should match requesterOrigin, NOT the stale session entry.
    expect(call?.params?.channel).toBe("telegram");
    expect(call?.params?.to).toBe("telegram:123");
  });

  it("routes or falls back for ended parent subagent sessions (#18037)", async () => {
    const cases = [
      {
        name: "routes to parent when parent session still exists",
        childSessionKey: "agent:main:subagent:newton:subagent:birdie",
        childRunId: "run-birdie",
        requesterSessionKey: "agent:main:subagent:newton",
        requesterDisplayKey: "subagent:newton",
        sessionStoreFixture: {
          "agent:main:subagent:newton": {
            sessionId: "newton-session-id-alive",
            inputTokens: 100,
            outputTokens: 50,
          },
          "agent:main:subagent:newton:subagent:birdie": {
            sessionId: "birdie-session-id",
            inputTokens: 20,
            outputTokens: 10,
          },
        },
        expectedSessionKey: "agent:main:subagent:newton",
        expectedDeliver: false,
        expectedChannel: undefined,
      },
      {
        name: "falls back when parent session is deleted",
        childSessionKey: "agent:main:subagent:birdie",
        childRunId: "run-birdie-orphan",
        requesterSessionKey: "agent:main:subagent:newton",
        requesterDisplayKey: "subagent:newton",
        sessionStoreFixture: {
          "agent:main:subagent:birdie": {
            sessionId: "birdie-session-id",
            inputTokens: 20,
            outputTokens: 10,
          },
        },
        expectedSessionKey: "agent:main:main",
        expectedDeliver: true,
        expectedChannel: "discord",
      },
      {
        name: "falls back when parent sessionId is blank",
        childSessionKey: "agent:main:subagent:newton:subagent:birdie",
        childRunId: "run-birdie-empty-parent",
        requesterSessionKey: "agent:main:subagent:newton",
        requesterDisplayKey: "subagent:newton",
        sessionStoreFixture: {
          "agent:main:subagent:newton": {
            sessionId: " ",
            inputTokens: 100,
            outputTokens: 50,
          },
          "agent:main:subagent:newton:subagent:birdie": {
            sessionId: "birdie-session-id",
            inputTokens: 20,
            outputTokens: 10,
          },
        },
        expectedSessionKey: "agent:main:main",
        expectedDeliver: true,
        expectedChannel: "discord",
      },
    ] as const;

    for (const testCase of cases) {
      agentSpy.mockClear();
      embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
      embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
      subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
      sessionStore = testCase.sessionStoreFixture as Record<string, Record<string, unknown>>;
      subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "discord", accountId: "jaris-account" },
      });

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: testCase.childSessionKey,
        childRunId: testCase.childRunId,
        requesterSessionKey: testCase.requesterSessionKey,
        requesterDisplayKey: testCase.requesterDisplayKey,
        ...defaultOutcomeAnnounce,
        task: "QA task",
      });

      expect(didAnnounce, testCase.name).toBe(true);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
      expect(call?.params?.sessionKey, testCase.name).toBe(testCase.expectedSessionKey);
      expect(call?.params?.deliver, testCase.name).toBe(testCase.expectedDeliver);
      expect(call?.params?.channel, testCase.name).toBe(testCase.expectedChannel);
    }
  });
});
