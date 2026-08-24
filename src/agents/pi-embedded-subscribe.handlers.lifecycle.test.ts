import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void;
    leafEntry?: unknown;
    getLeafEntry?: () => unknown;
  },
): EmbeddedPiSubscribeContext {
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
      session: {
        sessionManager: {
          getLeafEntry: overrides?.getLeafEntry ?? (() => overrides?.leafEntry),
        },
      },
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedPiSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      blockState: {
        thinking: true,
        final: true,
        inlineCode: createInlineCodeState(),
      },
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    flushBlockReplyBuffer: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleAgentEnd", () => {
  beforeEach(() => {
    vi.mocked(emitAgentEvent).mockClear();
  });

  it("logs the resolved error message when run ends with assistant error", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("runId=run-1");
    expect(warn.mock.calls[0]?.[0]).toContain("error=connection refused");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "connection refused",
      },
    });
  });

  it("keeps non-error run-end logging on debug only", () => {
    const ctx = createContext(undefined);

    handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });

  it("emits the persisted id when the leaf entry owns the current final assistant", () => {
    const assistant = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    };
    const onAgentEvent = vi.fn();
    const ctx = createContext(assistant, {
      onAgentEvent,
      leafEntry: {
        type: "message",
        id: "entry-final",
        message: assistant,
      },
    });

    handleAgentEnd(ctx);

    expect(emitAgentEvent).toHaveBeenCalledWith({
      runId: "run-1",
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "end",
        assistantMessageId: "entry-final",
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        assistantMessageId: "entry-final",
      },
    });
  });

  it("omits the id while the current assistant is not yet the persisted leaf", () => {
    const assistant = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    };
    const onAgentEvent = vi.fn();
    const ctx = createContext(assistant, {
      onAgentEvent,
      leafEntry: {
        type: "message",
        id: "entry-equal-copy",
        message: { ...assistant },
      },
    });

    handleAgentEnd(ctx);

    expect(emitAgentEvent).toHaveBeenCalledWith({
      runId: "run-1",
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "end" }),
    });
    expect(vi.mocked(emitAgentEvent).mock.calls[0]?.[0].data).not.toHaveProperty(
      "assistantMessageId",
    );
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it.each([
    ["user message", { type: "message", id: "entry-user", message: { role: "user" } }],
    ["tool result", { type: "message", id: "entry-tool", message: { role: "toolResult" } }],
    ["compaction", { type: "compaction", id: "entry-compaction" }],
  ])("omits the id when the persisted leaf is %s", (_label, leafEntry) => {
    const assistant = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    };
    const onAgentEvent = vi.fn();
    const ctx = createContext(assistant, { onAgentEvent, leafEntry });

    handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("keeps lifecycle completion when reading the persisted leaf fails", () => {
    const assistant = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    };
    const onAgentEvent = vi.fn();
    const ctx = createContext(assistant, {
      onAgentEvent,
      getLeafEntry: () => {
        throw new Error("session unavailable");
      },
    });

    handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("assistantMessageId unavailable"),
    );
  });
});
