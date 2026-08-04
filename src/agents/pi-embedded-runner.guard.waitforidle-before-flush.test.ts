import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPendingToolResultsAfterIdle } from "./pi-embedded-runner/wait-for-idle-before-flush.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
    stopReason: "toolUse",
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function getMessages(sm: ReturnType<typeof guardSessionManager>): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("flushPendingToolResultsAfterIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for idle so real tool results can land before flush", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const idle = deferred<void>();
    const agent = { waitForIdle: () => idle.promise };

    appendMessage(assistantToolCall("call_retry_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 1_000,
    });

    // Flush is waiting for idle; synthetic result must not appear yet.
    await Promise.resolve();
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant"]);

    // Tool completes before idle wait finishes.
    appendMessage(toolResult("call_retry_1", "command output here"));
    idle.resolve();
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { isError?: boolean }).isError).not.toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "command output here",
    );
  });

  it("does not flush pending tool calls when idle cannot be confirmed", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    appendMessage(assistantToolCall("call_orphan_1"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    const result = await flushPromise;

    const entries = getMessages(sm);

    expect(result.waitStatus).toBe("timeout");
    expect(result.pendingBeforeFlush.map((call) => call.toolCallId)).toEqual(["call_orphan_1"]);
    expect(result.syntheticResults).toEqual([]);
    expect(entries.map((entry) => entry.role)).toEqual(["assistant"]);
  });

  it("aborts a stalled agent before writing synthetic tool results", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    let aborted = false;
    const agent = {
      waitForIdle: () => (aborted ? Promise.resolve() : new Promise<void>(() => {})),
    };

    appendMessage(assistantToolCall("call_orphan_abort"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
      abortAgent: async () => {
        aborted = true;
      },
    });
    await vi.advanceTimersByTimeAsync(30);
    const result = await flushPromise;

    expect(result.waitStatus).toBe("idle_after_abort");
    expect(result.syntheticResults.map((call) => call.toolCallId)).toEqual(["call_orphan_abort"]);
  });

  it("returns after the settlement timeout when abort never resolves", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    appendMessage(assistantToolCall("call_abort_hangs"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
      abortSettlementTimeoutMs: 20,
      abortAgent: () => new Promise<void>(() => {}),
    });

    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(20);
    const result = await flushPromise;

    expect(result.waitStatus).toBe("timeout");
    expect(result.pendingBeforeFlush.map((call) => call.toolCallId)).toEqual(["call_abort_hangs"]);
    expect(result.syntheticResults).toEqual([]);
    expect(getMessages(sm).map((entry) => entry.role)).toEqual(["assistant"]);
  });

  it("clears timeout handle when waitForIdle resolves first", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    vi.useFakeTimers();
    const agent = {
      waitForIdle: async () => {},
    };

    await flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
