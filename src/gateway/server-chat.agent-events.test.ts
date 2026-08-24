import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

describe("agent event handler", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    resetAgentRunContextForTest();
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    harness.handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  const FALLBACK_LIFECYCLE_DATA = {
    phase: "fallback",
    selectedProvider: "fireworks",
    selectedModel: "fireworks/minimax-m2p5",
    activeProvider: "deepinfra",
    activeModel: "moonshotai/Kimi-K2.5",
  } as const;

  function emitLifecycleEnd(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 2,
    assistantMessageId?: string,
  ) {
    handler({
      runId,
      seq,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "end",
        ...(assistantMessageId ? { assistantMessageId } : {}),
      },
    });
  }

  function emitFallbackLifecycle(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq?: number;
    sessionKey?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq ?? 1,
      stream: "lifecycle",
      ts: Date.now(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: { ...FALLBACK_LIFECYCLE_DATA },
    });
  }

  function expectSingleAgentBroadcastPayload(broadcast: ReturnType<typeof vi.fn>) {
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    return broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
  }

  function expectSingleFinalChatPayload(broadcast: ReturnType<typeof vi.fn>) {
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: unknown;
      messageId?: string;
      silent?: boolean;
    };
    expect(payload.state).toBe("final");
    return payload;
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("flushes the latest assistant text before tool start", () => {
    const { broadcast, broadcastToConnIds, chatRunState, toolEventRecipients, handler, nowSpy } =
      createHarness({ now: 1_100 });
    chatRunState.registry.add("run-tool-boundary", {
      sessionKey: "session-tool-boundary",
      clientRunId: "client-tool-boundary",
    });
    toolEventRecipients.add("run-tool-boundary", "conn-1");

    handler({
      runId: "run-tool-boundary",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "先" },
    });
    handler({
      runId: "run-tool-boundary",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "先提取两份 PDF 的内容。" },
    });
    handler({
      runId: "run-tool-boundary",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "exec", toolCallId: "tool-1" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.[1]).toMatchObject({
      seq: 1,
      state: "delta",
      message: { content: [{ text: "先" }] },
    });
    expect(chatCalls[1]?.[1]).toMatchObject({
      seq: 2,
      state: "delta",
      message: { content: [{ text: "先提取两份 PDF 的内容。" }] },
    });
    expect(chatCalls[1]?.[2]).toBeUndefined();

    const boundaryBroadcastIndex = broadcast.mock.calls.findIndex(
      ([event, payload]) => event === "chat" && (payload as { seq?: number }).seq === 2,
    );
    expect(broadcast.mock.invocationCallOrder[boundaryBroadcastIndex]).toBeLessThan(
      broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    nowSpy?.mockRestore();
  });

  it("flushes the latest assistant text before final with its own seq", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_200 });
    chatRunState.registry.add("run-final-boundary", {
      sessionKey: "session-final-boundary",
      clientRunId: "client-final-boundary",
    });

    handler({
      runId: "run-final-boundary",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "完整" },
    });
    handler({
      runId: "run-final-boundary",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "完整回答。" },
    });
    emitLifecycleEnd(handler, "run-final-boundary", 3, "entry-final-boundary");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls[1]?.[1]).toMatchObject({
      seq: 2,
      state: "delta",
      message: { content: [{ text: "完整回答。" }] },
    });
    expect(chatCalls[1]?.[2]).toBeUndefined();
    expect(chatCalls[2]?.[1]).toMatchObject({
      seq: 3,
      state: "final",
      messageId: "entry-final-boundary",
      message: { content: [{ text: "完整回答。" }] },
    });
    expect(chatRunState.buffers.has("client-final-boundary")).toBe(false);
    expect(chatRunState.deltaRevisions.has("client-final-boundary")).toBe(false);
    expect(chatRunState.deltaLastBroadcastRevisions.has("client-final-boundary")).toBe(false);
    expect(chatRunState.deltaLastNodeRevisions.has("client-final-boundary")).toBe(false);
    expect(chatRunState.deltaSeqs.has("client-final-boundary")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("reliably repeats a droppable revision once at the next tool boundary", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_300,
    });
    chatRunState.registry.add("run-no-repeat", {
      sessionKey: "session-no-repeat",
      clientRunId: "client-no-repeat",
    });

    handler({
      runId: "run-no-repeat",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "already sent" },
    });
    handler({
      runId: "run-no-repeat",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "tool-no-repeat" },
    });
    handler({
      runId: "run-no-repeat",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "tool-no-repeat-2" },
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(2);
    expect(chatBroadcastCalls(broadcast)[1]?.[2]).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("flushes a new revision even when its text matches the previous snapshot", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_400 });
    chatRunState.registry.add("run-same-text", {
      sessionKey: "session-same-text",
      clientRunId: "client-same-text",
    });

    for (const seq of [1, 2]) {
      handler({
        runId: "run-same-text",
        seq,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "处理中。" },
      });
    }
    handler({
      runId: "run-same-text",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "process", toolCallId: "tool-same-text" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        seq: 1,
        message: expect.objectContaining({
          content: [expect.objectContaining({ text: "处理中。" })],
        }),
      }),
      expect.objectContaining({
        seq: 2,
        message: expect.objectContaining({
          content: [expect.objectContaining({ text: "处理中。" })],
        }),
      }),
    ]);
    nowSpy?.mockRestore();
  });

  it("keeps per-message assistant snapshots across tool boundaries", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_500 });
    chatRunState.registry.add("run-merge", {
      sessionKey: "session-merge",
      clientRunId: "client-merge",
    });

    handler({
      runId: "run-merge",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "先提取两份 PDF 的内容。", delta: "先提取两份 PDF 的内容。" },
    });
    handler({
      runId: "run-merge",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "exec", toolCallId: "tool-merge" },
    });
    handler({
      runId: "run-merge",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "两份文档均已解析。", delta: "两份文档均已解析。" },
    });
    emitLifecycleEnd(handler, "run-merge", 4);

    const chatCalls = chatBroadcastCalls(broadcast);
    const texts = chatCalls.map(
      (call) =>
        (call[1] as { state?: string; message?: { content?: Array<{ text?: string }> } }).message
          ?.content?.[0]?.text,
    );
    const statesAndSeqs = chatCalls.map(
      (call) => `${(call[1] as { state?: string }).state}:${(call[1] as { seq?: number }).seq}`,
    );
    expect(statesAndSeqs).toEqual(["delta:1", "delta:1", "delta:3", "final:4"]);
    expect(texts).toEqual([
      "先提取两份 PDF 的内容。",
      "先提取两份 PDF 的内容。",
      "两份文档均已解析。",
      "两份文档均已解析。",
    ]);
    nowSpy?.mockRestore();
  });

  it("dedupes replayed assistant deltas after a tool boundary", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_600 });
    chatRunState.registry.add("run-dedup", {
      sessionKey: "session-dedup",
      clientRunId: "client-dedup",
    });

    handler({
      runId: "run-dedup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "hello", delta: "hello" },
    });
    handler({
      runId: "run-dedup",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "exec", toolCallId: "tool-dedup" },
    });
    handler({
      runId: "run-dedup",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "world", delta: "world" },
    });
    handler({
      runId: "run-dedup",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "world", delta: "world" },
    });
    emitLifecycleEnd(handler, "run-dedup", 4);

    const finalCall = chatBroadcastCalls(broadcast).at(-1);
    expect(finalCall?.[1]).toMatchObject({
      state: "final",
      message: { content: [{ text: "world" }] },
    });
    nowSpy?.mockRestore();
  });

  it("keeps the seq high-water mark when stale assistant events arrive", () => {
    const { broadcast, agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 1_700 });
    chatRunState.registry.add("run-out-of-order", {
      sessionKey: "session-out-of-order",
      clientRunId: "client-out-of-order",
    });

    for (const [seq, text] of [
      [5, "current"],
      [4, "stale"],
      [5, "replayed"],
    ] as const) {
      handler({
        runId: "run-out-of-order",
        seq,
        stream: "assistant",
        ts: Date.now(),
        data: { text },
      });
    }

    expect(agentRunSeq.get("run-out-of-order")).toBe(5);
    expect(chatRunState.buffers.get("client-out-of-order")).toBe("current");
    expect(chatBroadcastCalls(broadcast)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("preserves identical assistant messages on both sides of a tool boundary", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_800 });
    chatRunState.registry.add("run-identical-messages", {
      sessionKey: "session-identical-messages",
      clientRunId: "client-identical-messages",
    });

    handler({
      runId: "run-identical-messages",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "处理中。" },
    });
    handler({
      runId: "run-identical-messages",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "process", toolCallId: "tool-identical" },
    });
    handler({
      runId: "run-identical-messages",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "处理中。" },
    });
    emitLifecycleEnd(handler, "run-identical-messages", 4);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls.map((call) => (call[1] as { seq?: number }).seq)).toEqual([1, 1, 3, 4]);
    expect(chatCalls.at(-1)?.[1]).toMatchObject({
      state: "final",
      message: { content: [{ text: "处理中。" }] },
    });
    nowSpy?.mockRestore();
  });

  it("clears delta revisions with chat run state", () => {
    const { chatRunState } = createHarness();
    chatRunState.deltaRevisions.set("client-clear", 2);
    chatRunState.deltaLastBroadcastRevisions.set("client-clear", 1);
    chatRunState.deltaLastNodeRevisions.set("client-clear", 1);
    chatRunState.deltaSeqs.set("client-clear", 2);

    chatRunState.clear();

    expect(chatRunState.deltaRevisions.size).toBe(0);
    expect(chatRunState.deltaLastBroadcastRevisions.size).toBe(0);
    expect(chatRunState.deltaLastNodeRevisions.size).toBe(0);
    expect(chatRunState.deltaSeqs.size).toBe(0);
  });

  it("strips inline directives from assistant chat events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello [[reply_to_current]] world [[audio_as_voice]]",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("Hello  world ");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      " NO_REPLY  ",
    );
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    emitLifecycleEnd(handler, "run-2", 2, "entry-silent");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: unknown;
      messageId?: string;
      silent?: boolean;
    };
    expect(payload.message).toBeUndefined();
    expect(payload.messageId).toBeUndefined();
    expect(payload.silent).toBe(true);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("suppresses cumulative NO_REPLY lead fragments and marks the final as silent", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_100,
    });
    chatRunState.registry.add("run-silent", {
      sessionKey: "session-silent",
      clientRunId: "client-silent",
    });

    for (const [index, text] of ["NO", "NO_", "NO_RE", "NO_REPLY"].entries()) {
      handler({
        runId: "run-silent",
        seq: index + 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text },
      });
    }
    emitLifecycleEnd(handler, "run-silent", 5);

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: unknown;
      silent?: boolean;
    };
    expect(payload.message).toBeUndefined();
    expect(payload.silent).toBe(true);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("keeps natural-language No-prefix assistant text visible", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 2_200 }),
      "No, that is valid",
    );

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.[1]).toMatchObject({
      state: "delta",
      message: {
        content: [{ text: "No, that is valid" }],
      },
    });
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("omits a lifecycle message id when no assistant text was buffered", () => {
    const { broadcast, chatRunState, handler } = createHarness({ now: 2_300 });
    chatRunState.registry.add("run-empty-final", {
      sessionKey: "session-empty-final",
      clientRunId: "client-empty-final",
    });

    emitLifecycleEnd(handler, "run-empty-final", 1, "entry-empty-final");

    const payload = expectSingleFinalChatPayload(broadcast);
    expect(payload.message).toBeUndefined();
    expect(payload.messageId).toBeUndefined();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback" });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-internal", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback-internal" });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-session-key",
      sessionKey: "session-from-event",
    });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      sessionKey: "session-tool-remap",
      clientRunId: "run-tool-client",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "tool-remap-1",
        result: { content: [{ type: "text", text: "secret" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });

  it("suppresses heartbeat ack-like chat output when showOk is false", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-heartbeat", {
      sessionKey: "session-heartbeat",
      clientRunId: "client-heartbeat",
    });
    registerAgentRunContext("run-heartbeat", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      },
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);

    emitLifecycleEnd(handler, "run-heartbeat");

    const finalPayload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(finalPayload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
  });

  it("keeps heartbeat alert text in final chat output when remainder exceeds ackMaxChars", () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: { defaults: { heartbeat: { ackMaxChars: 10 } } },
    });

    const { broadcast, chatRunState, handler } = createHarness({ now: 3_000 });
    chatRunState.registry.add("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      clientRunId: "client-heartbeat-alert",
    });
    registerAgentRunContext("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat-alert",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Disk usage crossed 95 percent on /data and needs cleanup now.",
      },
    });

    emitLifecycleEnd(handler, "run-heartbeat-alert");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe(
      "Disk usage crossed 95 percent on /data and needs cleanup now.",
    );
  });
});
