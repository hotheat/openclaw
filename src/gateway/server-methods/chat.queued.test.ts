import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRunSettlement } from "../../auto-reply/reply/queue.js";
import type { GetReplyOptions } from "../../auto-reply/types.js";
import type { GatewayRequestContext } from "./types.js";

const mockState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "sess-1",
  /** Captured replyOptions from the latest dispatch so tests can settle the queued run. */
  replyOptions: undefined as
    | Pick<GetReplyOptions, "onQueuedRunSettled" | "onAgentRunStart" | "runId">
    | undefined,
  /** What the mocked dispatch reports back to chat.send. */
  dispatchResult: { handledWithoutReplyReason: "queued" } as Record<string, unknown>,
  /** When set, the mocked dispatch waits on it before resolving. */
  holdDispatch: undefined as Promise<void> | undefined,
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(mockState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: mockState.sessionId,
        sessionFile: mockState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(
    async (params: {
      replyOptions: Pick<GetReplyOptions, "onQueuedRunSettled" | "onAgentRunStart" | "runId">;
      dispatcher: { markComplete: () => void; waitForIdle: () => Promise<void> };
    }) => {
      mockState.replyOptions = params.replyOptions;
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      if (mockState.holdDispatch) {
        await mockState.holdDispatch;
      }
      return mockState.dispatchResult;
    },
  ),
}));

const { chatHandlers } = await import("./chat.js");

function createTranscriptFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-send-queued-"));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: mockState.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  mockState.transcriptPath = transcriptPath;
}

type ChatContext = Pick<
  GatewayRequestContext,
  | "broadcast"
  | "nodeSendToSession"
  | "agentRunSeq"
  | "chatAbortControllers"
  | "chatRunBuffers"
  | "chatDeltaSentAt"
  | "chatAbortedRuns"
  | "removeChatRun"
  | "dedupe"
  | "registerToolEventRecipient"
  | "logGateway"
>;

function createChatContext(): ChatContext {
  return {
    broadcast: vi.fn() as unknown as GatewayRequestContext["broadcast"],
    nodeSendToSession: vi.fn() as unknown as GatewayRequestContext["nodeSendToSession"],
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    dedupe: new Map(),
    registerToolEventRecipient: vi.fn(),
    logGateway: {
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as GatewayRequestContext["logGateway"],
  };
}

async function sendChat(
  context: ChatContext,
  idempotencyKey: string,
  extra?: { timeoutMs?: number },
) {
  const respond = vi.fn();
  await chatHandlers["chat.send"]({
    params: {
      sessionKey: "main",
      message: "report the current result",
      idempotencyKey,
      ...(extra?.timeoutMs != null ? { timeoutMs: extra.timeoutMs } : {}),
    },
    respond,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
    context: context as GatewayRequestContext,
  });
  return respond;
}

function chatStates(context: ChatContext): Array<{ state: string; message?: unknown }> {
  return (context.broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([event]) => event === "chat")
    .map(([, payload]) => payload as { state: string; message?: unknown });
}

async function settleQueuedRun(settlement: FollowupRunSettlement) {
  await vi.waitFor(() => {
    expect(mockState.replyOptions?.onQueuedRunSettled).toBeTypeOf("function");
  });
  mockState.replyOptions?.onQueuedRunSettled?.(settlement);
}

describe("chat.send queued behind an active session run", () => {
  beforeEach(() => {
    createTranscriptFixture();
    mockState.replyOptions = undefined;
    mockState.dispatchResult = { handledWithoutReplyReason: "queued" };
    mockState.holdDispatch = undefined;
  });

  it("broadcasts a queued state instead of an empty final and keeps the run in flight", async () => {
    const context = createChatContext();
    const respond = await sendChat(context, "idem-queued-1");

    expect(respond).toHaveBeenCalledWith(
      true,
      { runId: "idem-queued-1", status: "started" },
      undefined,
      { runId: "idem-queued-1" },
    );
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    // The run stays registered, so a client probe with the same key reports in_flight
    // rather than a cached "ok" that the client would treat as a finished turn.
    expect(context.chatAbortControllers.has("idem-queued-1")).toBe(true);
    expect(context.dedupe.has("chat:idem-queued-1")).toBe(false);
    const probe = await sendChat(context, "idem-queued-1");
    expect(probe).toHaveBeenCalledWith(
      true,
      { runId: "idem-queued-1", status: "in_flight" },
      undefined,
      { cached: true, runId: "idem-queued-1" },
    );
    expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
  });

  it("reuses the client run id for the queued run and closes out when it completes", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-2");
    mockState.replyOptions?.onAgentRunStart?.("idem-queued-2");
    await settleQueuedRun({ outcome: "done" });

    expect(mockState.replyOptions?.runId).toBe("idem-queued-2");
    await vi.waitFor(() => {
      expect(context.dedupe.get("chat:idem-queued-2")).toMatchObject({
        ok: true,
        payload: { runId: "idem-queued-2", status: "ok" },
      });
      expect(context.chatAbortControllers.has("idem-queued-2")).toBe(false);
    });
    // Lifecycle events from the queued run emit the real final; chat.send adds nothing.
    expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
  });

  it("emits a silent final tagged done when the queued runner completes before agent activity", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-done-before-start");
    await settleQueuedRun({ outcome: "done" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "final"]);
    });
    expect(chatStates(context)[1]?.message).toBeUndefined();
    // Tagged so clients keep the merge wording reserved for stopReason
    // merged/steered; an empty completion is not a merge promise.
    expect(chatStates(context)[1]).toMatchObject({ stopReason: "done" });
    expect(context.dedupe.get("chat:idem-queued-done-before-start")).toMatchObject({ ok: true });
    expect(context.chatAbortControllers.has("idem-queued-done-before-start")).toBe(false);
  });

  it("closes a merged message with a silent final tagged as merged", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-3");
    await settleQueuedRun({ outcome: "merged", runId: "idem-queued-4" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "final"]);
    });
    expect(chatStates(context)[1]?.message).toBeUndefined();
    // Clients must be able to tell a real merge (reply arrives under another
    // run) apart from an aborted batch or an empty completion.
    expect(chatStates(context)[1]).toMatchObject({ stopReason: "merged" });
    expect(context.dedupe.get("chat:idem-queued-3")).toMatchObject({ ok: true });
  });

  it("closes a steered message with a silent final tagged as steered", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-steered");
    await settleQueuedRun({ outcome: "steered" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "final"]);
    });
    expect(chatStates(context)[1]).toMatchObject({ stopReason: "steered" });
  });

  it("surfaces a dropped queued message as an error", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-5");
    await settleQueuedRun({ outcome: "dropped", reason: "cap" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "error"]);
    });
    expect(context.dedupe.get("chat:idem-queued-5")).toMatchObject({
      ok: false,
      payload: { status: "error" },
    });
  });

  it("surfaces a discarded overflow summary as an error", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-summary-discarded");
    await settleQueuedRun({ outcome: "dropped", reason: "summary-discarded" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "error"]);
    });
    const errorPayload = chatStates(context)[1] as { errorMessage?: string };
    expect(errorPayload.errorMessage).toContain("overflow summary was dropped");
    expect(context.dedupe.get("chat:idem-queued-summary-discarded")).toMatchObject({
      ok: false,
      payload: { status: "error" },
    });
  });

  it("broadcasts queued with seq 0 without advancing agentRunSeq", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-seq");
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    // The queued run later reuses this run id; its agent lifecycle events start at seq 1,
    // so the queued notice must not reserve a seq in the shared counter.
    expect(chatStates(context)[0]).toMatchObject({ seq: 0 });
    expect(context.agentRunSeq.has("idem-queued-seq")).toBe(false);
  });

  it("does not broadcast an error after the run was aborted", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-aborted");
    // chat.abort already broadcast the aborted terminal state for this run.
    context.chatAbortedRuns.set("idem-queued-aborted", Date.now());
    await settleQueuedRun({ outcome: "error", error: "The operation was aborted" });

    await vi.waitFor(() => {
      expect(context.dedupe.get("chat:idem-queued-aborted")).toMatchObject({ ok: true });
    });
    expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
  });

  it("unblocks the queued wait when the client aborts without a settlement", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-abort-race");
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    context.chatAbortControllers.get("idem-queued-abort-race")?.controller.abort();

    await vi.waitFor(() => {
      expect(context.dedupe.get("chat:idem-queued-abort-race")).toMatchObject({ ok: true });
      expect(context.chatAbortControllers.has("idem-queued-abort-race")).toBe(false);
    });
    // This abort bypassed chat.abort, so no aborted terminal was broadcast; the
    // closure must still close the run instead of hanging, and an aborted
    // terminal is the honest outcome (the message will never be answered).
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "aborted"]);
    });
  });

  it("does not broadcast queued after chat.abort already terminated the run", async () => {
    let releaseDispatch!: () => void;
    mockState.holdDispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const context = createChatContext();
    const respondPromise = sendChat(context, "idem-queued-abort-before-flash");
    // Wait until the abort controller is registered, then let chat.abort win the
    // race: aborted terminal broadcast, controller removed, run recorded as aborted.
    await vi.waitFor(() => {
      expect(context.chatAbortControllers.has("idem-queued-abort-before-flash")).toBe(true);
    });
    context.chatAbortControllers.get("idem-queued-abort-before-flash")?.controller.abort();
    context.chatAbortedRuns.set("idem-queued-abort-before-flash", Date.now());
    releaseDispatch();
    await respondPromise;

    await vi.waitFor(() => {
      expect(context.dedupe.get("chat:idem-queued-abort-before-flash")).toMatchObject({
        ok: true,
      });
      expect(context.chatAbortControllers.has("idem-queued-abort-before-flash")).toBe(false);
    });
    // No chat state at all: the aborted terminal already went out via chat.abort,
    // and the late queued notice must not flip clients back to running.
    expect(chatStates(context)).toEqual([]);
  });

  it("does not broadcast a second error after the queued agent run started", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-agent-error");
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    mockState.replyOptions?.onAgentRunStart?.("idem-queued-agent-error");
    await settleQueuedRun({ outcome: "error", error: "provider down" });

    await vi.waitFor(() => {
      expect(context.dedupe.get("chat:idem-queued-agent-error")).toMatchObject({
        ok: false,
        payload: { status: "error", summary: "provider down" },
      });
    });
    expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
  });

  it("broadcasts an error when the queued run fails before the agent starts", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-agent-failed-early");
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    // The follow-up runner now defers onAgentRunStart until real agent activity,
    // so a failure before any lifecycle event must surface as the error terminal.
    await settleQueuedRun({ outcome: "error", error: "No API key found for provider." });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "error"]);
    });
    expect(context.dedupe.get("chat:idem-queued-agent-failed-early")).toMatchObject({
      ok: false,
      payload: { status: "error", summary: "No API key found for provider." },
    });
  });

  it("broadcasts an aborted terminal when its batch was aborted elsewhere", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-batch-aborted");
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    // The collect batch was aborted through the primary run's id; this run was
    // never aborted directly, so chat.send must still deliver a terminal — and
    // it must say aborted (no reply will ever come), not a merge-shaped final.
    await settleQueuedRun({ outcome: "aborted" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued", "aborted"]);
    });
    expect(chatStates(context)[1]).toMatchObject({ stopReason: "aborted" });
    // Marking the run aborted keeps any stray later event from layering on top.
    expect(context.chatAbortedRuns.has("idem-queued-batch-aborted")).toBe(true);
    expect(context.dedupe.get("chat:idem-queued-batch-aborted")).toMatchObject({ ok: true });
  });

  it("extends the sweeper deadline while the message sits queued", async () => {
    let releaseDispatch!: () => void;
    mockState.holdDispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const context = createChatContext();
    // A large timeout keeps the 2-minute floor in resolveChatRunExpiresAtMs from
    // collapsing the initial and continuation deadlines onto the same value.
    const respondPromise = sendChat(context, "idem-queued-deadline", { timeoutMs: 600_000 });
    await vi.waitFor(() => {
      expect(context.chatAbortControllers.has("idem-queued-deadline")).toBe(true);
    });
    const entry = context.chatAbortControllers.get("idem-queued-deadline");
    expect(entry?.continuationExpiresAtMs).toBeGreaterThan(entry?.expiresAtMs ?? 0);
    releaseDispatch();
    await respondPromise;
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });
    // The queued notice re-arms the deadline to the continuation window so a
    // long-running predecessor cannot let the maintenance sweep abort the
    // message before its prompt reaches the model.
    expect(entry?.expiresAtMs).toBe(entry?.continuationExpiresAtMs);
  });

  it("re-arms the sweeper deadline when the queued run actually starts", async () => {
    const context = createChatContext();
    await sendChat(context, "idem-queued-deadline-start", { timeoutMs: 600_000 });
    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["queued"]);
    });

    // Simulate a stale deadline (e.g. long wait behind the active run).
    const entry = context.chatAbortControllers.get("idem-queued-deadline-start");
    expect(entry).toBeDefined();
    entry!.expiresAtMs = Date.now() - 1_000;
    mockState.replyOptions?.onAgentRunStart?.("idem-queued-deadline-start");
    expect(entry!.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("does not flash queued when dispatch reports the follow-up was dropped", async () => {
    mockState.dispatchResult = { handledWithoutReplyReason: "dropped" };
    const context = createChatContext();
    await sendChat(context, "idem-dropped-1");
    await settleQueuedRun({ outcome: "dropped", reason: "cap" });

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["error"]);
    });
    expect(context.dedupe.get("chat:idem-dropped-1")).toMatchObject({
      ok: false,
      payload: { status: "error" },
    });
  });

  it("still emits an empty final when the run was handled without queueing", async () => {
    mockState.dispatchResult = { handledWithoutReplyReason: "silent" };
    const context = createChatContext();
    await sendChat(context, "idem-silent-1");

    await vi.waitFor(() => {
      expect(chatStates(context).map((p) => p.state)).toEqual(["final"]);
      expect(context.dedupe.get("chat:idem-silent-1")).toMatchObject({ ok: true });
    });
  });
});
