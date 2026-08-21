import { describe, expect, it, vi } from "vitest";
import {
  handleChatEvent,
  loadChatHistory,
  loadOlderChatHistory,
  resetChatHistoryForSessionSwitch,
  sendChatMessage,
  type ChatEventPayload,
  type ChatHistoryPort,
  type ChatState,
} from "./chat.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatHistoryHasMore: false,
    chatHistoryLoadingOlder: false,
    chatHistoryNextBefore: null,
    chatHistorySessionKey: "main",
    chatHistoryRequestGeneration: 0,
    chatHistoryInitialRequestId: 0,
    chatHistoryOlderRequestId: 0,
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingLevel: null,
    client: null,
    connected: true,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

function createHistoryPort(
  result: Awaited<ReturnType<ChatHistoryPort["load"]>>,
): ChatHistoryPort & { load: ReturnType<typeof vi.fn<ChatHistoryPort["load"]>> } {
  const load = vi.fn<ChatHistoryPort["load"]>().mockResolvedValue(result);
  return { load };
}

describe("chat history pagination", () => {
  it("loads a large initial window and retains its cursor", async () => {
    const port = createHistoryPort({
      sessionKey: "main",
      messages: [{ historyEntryId: "entry-2", role: "assistant" }],
      hasMore: true,
      nextBefore: "cursor-2",
      cursorReset: false,
      thinkingLevel: "medium",
    });
    const state = createState();

    await loadChatHistory(state, port);

    expect(port.load).toHaveBeenCalledWith({ sessionKey: "main", limit: 1000 });
    expect(state.chatMessages).toEqual([{ historyEntryId: "entry-2", role: "assistant" }]);
    expect(state.chatHistoryHasMore).toBe(true);
    expect(state.chatHistoryNextBefore).toBe("cursor-2");
    expect(state.chatThinkingLevel).toBe("medium");
  });

  it("prepends an older page and advances the cursor without duplicates", async () => {
    const port = createHistoryPort({
      sessionKey: "main",
      messages: [
        { historyEntryId: "entry-1", role: "user" },
        { historyEntryId: "entry-2", role: "assistant" },
      ],
      hasMore: true,
      nextBefore: "cursor-1",
      cursorReset: false,
    });
    const state = createState({
      chatMessages: [{ historyEntryId: "entry-2", role: "assistant" }],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "cursor-2",
    });

    await loadOlderChatHistory(state, port);

    expect(port.load).toHaveBeenCalledWith({
      sessionKey: "main",
      before: "cursor-2",
      limit: 100,
    });
    expect(state.chatMessages).toEqual([
      { historyEntryId: "entry-1", role: "user" },
      { historyEntryId: "entry-2", role: "assistant" },
    ]);
    expect(state.chatHistoryNextBefore).toBe("cursor-1");
  });

  it("replaces local history when an older-page cursor is reset", async () => {
    const port = createHistoryPort({
      sessionKey: "main",
      messages: [{ historyEntryId: "entry-new", role: "assistant" }],
      hasMore: false,
      cursorReset: true,
    });
    const state = createState({
      chatMessages: [{ historyEntryId: "entry-old", role: "user" }],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "stale-cursor",
    });

    await loadOlderChatHistory(state, port);

    expect(state.chatMessages).toEqual([{ historyEntryId: "entry-new", role: "assistant" }]);
    expect(state.chatHistoryHasMore).toBe(false);
    expect(state.chatHistoryNextBefore).toBe(null);
  });

  it("preserves loaded older messages when the latest window has stable overlap", async () => {
    const port = createHistoryPort({
      sessionKey: "main",
      messages: [
        { historyEntryId: "entry-2", role: "assistant" },
        { historyEntryId: "entry-3", role: "user" },
      ],
      hasMore: true,
      nextBefore: "latest-window-cursor",
      cursorReset: false,
    });
    const state = createState({
      chatMessages: [
        { historyEntryId: "entry-1", role: "user" },
        { historyEntryId: "entry-2", role: "assistant" },
      ],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "older-cursor",
    });

    await loadChatHistory(state, port);

    expect(state.chatMessages).toEqual([
      { historyEntryId: "entry-1", role: "user" },
      { historyEntryId: "entry-2", role: "assistant" },
      { historyEntryId: "entry-3", role: "user" },
    ]);
    expect(state.chatHistoryHasMore).toBe(true);
    expect(state.chatHistoryNextBefore).toBe("older-cursor");
  });

  it("rebuilds from the latest page when stable overlap is lost", async () => {
    const port = createHistoryPort({
      sessionKey: "main",
      messages: [{ historyEntryId: "entry-new", role: "assistant" }],
      hasMore: true,
      nextBefore: "new-cursor",
      cursorReset: false,
    });
    const state = createState({
      chatMessages: [{ historyEntryId: "entry-old", role: "user" }],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "old-cursor",
    });

    await loadChatHistory(state, port);

    expect(state.chatMessages).toEqual([{ historyEntryId: "entry-new", role: "assistant" }]);
    expect(state.chatHistoryHasMore).toBe(true);
    expect(state.chatHistoryNextBefore).toBe("new-cursor");
  });

  it("clears the previous session before loading colliding history IDs", async () => {
    const port = createHistoryPort({
      sessionKey: "session-b",
      messages: [{ historyEntryId: "off-0", role: "assistant", text: "session-b" }],
      hasMore: false,
      cursorReset: false,
    });
    const state = createState({
      sessionKey: "session-b",
      chatMessages: [
        { historyEntryId: "old-prefix", role: "user", text: "session-a secret" },
        { historyEntryId: "off-0", role: "assistant", text: "session-a" },
      ],
      chatHistoryHasMore: true,
      chatHistoryLoadingOlder: true,
      chatHistoryNextBefore: "session-a-cursor",
    });

    resetChatHistoryForSessionSwitch(state);
    expect(state.chatMessages).toEqual([]);
    expect(state.chatHistoryHasMore).toBe(false);
    expect(state.chatHistoryLoadingOlder).toBe(false);
    expect(state.chatHistoryNextBefore).toBe(null);
    expect(state.chatHistorySessionKey).toBe("session-b");

    await loadChatHistory(state, port);

    expect(state.chatMessages).toEqual([
      { historyEntryId: "off-0", role: "assistant", text: "session-b" },
    ]);
  });

  it("replaces history when its owner differs from the requested session", async () => {
    const port = createHistoryPort({
      sessionKey: "session-b",
      messages: [{ historyEntryId: "off-0", role: "assistant", text: "session-b" }],
      hasMore: false,
      cursorReset: false,
    });
    const state = createState({
      sessionKey: "session-b",
      chatHistorySessionKey: "session-a",
      chatMessages: [
        { historyEntryId: "old-prefix", role: "user", text: "session-a secret" },
        { historyEntryId: "off-0", role: "assistant", text: "session-a" },
      ],
    });

    await loadChatHistory(state, port);

    expect(state.chatHistorySessionKey).toBe("session-b");
    expect(state.chatMessages).toEqual([
      { historyEntryId: "off-0", role: "assistant", text: "session-b" },
    ]);
  });

  it("does not load an older page owned by another session", async () => {
    const port = createHistoryPort({
      sessionKey: "session-b",
      messages: [{ historyEntryId: "off-0", role: "assistant", text: "session-b" }],
      hasMore: false,
      cursorReset: false,
    });
    const state = createState({
      sessionKey: "session-b",
      chatHistorySessionKey: "session-a",
      chatMessages: [{ historyEntryId: "off-0", role: "assistant", text: "session-a" }],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "session-a-cursor",
    });

    await loadOlderChatHistory(state, port);

    expect(port.load).not.toHaveBeenCalled();
    expect(state.chatMessages).toEqual([]);
    expect(state.chatHistorySessionKey).toBe("session-b");
    expect(state.chatHistoryHasMore).toBe(false);
    expect(state.chatHistoryNextBefore).toBe(null);
  });

  it("ignores an older request after switching away and back", async () => {
    let resolveFirst!: (result: Awaited<ReturnType<ChatHistoryPort["load"]>>) => void;
    const firstPort: ChatHistoryPort = {
      load: vi.fn().mockReturnValue(
        new Promise<Awaited<ReturnType<ChatHistoryPort["load"]>>>((resolve) => {
          resolveFirst = resolve;
        }),
      ),
    };
    const state = createState();
    const firstLoad = loadChatHistory(state, firstPort);

    state.sessionKey = "session-b";
    resetChatHistoryForSessionSwitch(state);
    state.sessionKey = "main";
    resetChatHistoryForSessionSwitch(state);

    resolveFirst({
      sessionKey: "main",
      messages: [{ historyEntryId: "stale", role: "assistant" }],
      hasMore: false,
      cursorReset: false,
    });
    await firstLoad;

    expect(state.chatMessages).toEqual([]);
    expect(state.chatLoading).toBe(false);
  });

  it("releases the older-page loading flag when a refresh supersedes it", async () => {
    let resolveOlder!: (result: Awaited<ReturnType<ChatHistoryPort["load"]>>) => void;
    const olderPort: ChatHistoryPort = {
      load: vi.fn().mockReturnValue(
        new Promise<Awaited<ReturnType<ChatHistoryPort["load"]>>>((resolve) => {
          resolveOlder = resolve;
        }),
      ),
    };
    const state = createState({
      chatMessages: [{ historyEntryId: "entry-2", role: "assistant" }],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "cursor-2",
    });

    const olderLoad = loadOlderChatHistory(state, olderPort);
    expect(state.chatHistoryLoadingOlder).toBe(true);

    const refreshPort = createHistoryPort({
      sessionKey: "main",
      messages: [{ historyEntryId: "entry-2", role: "assistant" }],
      hasMore: true,
      nextBefore: "cursor-2",
      cursorReset: false,
    });
    await loadChatHistory(state, refreshPort);

    resolveOlder({
      sessionKey: "main",
      messages: [{ historyEntryId: "entry-1", role: "user" }],
      hasMore: false,
      cursorReset: false,
    });
    await olderLoad;

    expect(state.chatHistoryLoadingOlder).toBe(false);
    expect(state.chatMessages).toEqual([{ historyEntryId: "entry-2", role: "assistant" }]);

    const retryPort = createHistoryPort({
      sessionKey: "main",
      messages: [
        { historyEntryId: "entry-1", role: "user" },
        { historyEntryId: "entry-2", role: "assistant" },
      ],
      hasMore: false,
      cursorReset: false,
    });
    await loadOlderChatHistory(state, retryPort);

    expect(retryPort.load).toHaveBeenCalledWith({
      sessionKey: "main",
      before: "cursor-2",
      limit: 100,
    });
    expect(state.chatMessages).toEqual([
      { historyEntryId: "entry-1", role: "user" },
      { historyEntryId: "entry-2", role: "assistant" },
    ]);
  });

  it("releases the initial loading flag when an older-page load supersedes it", async () => {
    let resolveInitial!: (result: Awaited<ReturnType<ChatHistoryPort["load"]>>) => void;
    const initialPort: ChatHistoryPort = {
      load: vi.fn().mockReturnValue(
        new Promise<Awaited<ReturnType<ChatHistoryPort["load"]>>>((resolve) => {
          resolveInitial = resolve;
        }),
      ),
    };
    const state = createState({
      chatMessages: [{ historyEntryId: "entry-2", role: "assistant" }],
      chatHistoryHasMore: true,
      chatHistoryNextBefore: "cursor-2",
    });

    const initialLoad = loadChatHistory(state, initialPort);
    expect(state.chatLoading).toBe(true);

    const olderPort = createHistoryPort({
      sessionKey: "main",
      messages: [{ historyEntryId: "entry-1", role: "user" }],
      hasMore: false,
      cursorReset: false,
    });
    await loadOlderChatHistory(state, olderPort);

    resolveInitial({
      sessionKey: "main",
      messages: [{ historyEntryId: "stale", role: "assistant" }],
      hasMore: false,
      cursorReset: false,
    });
    await initialLoad;

    expect(state.chatLoading).toBe(false);
    expect(state.chatMessages).toEqual([
      { historyEntryId: "entry-1", role: "user" },
      { historyEntryId: "entry-2", role: "assistant" },
    ]);
  });
});

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("appends final payload from another run without clearing active stream", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("returns final for another run when payload has no message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatMessages).toEqual([]);
  });

  it("processes final from own run and clears state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("appends final payload message from own run before clearing stream state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
        timestamp: 101,
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("processes aborted from own run and keeps partial assistant message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
      timestamp: 2,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: partialMessage,
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage, partialMessage]);
  });

  it("falls back to streamed partial when aborted payload message is invalid", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("falls back to streamed partial when aborted payload has non-assistant role", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: {
        role: "user",
        content: [{ type: "text", text: "unexpected" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("processes aborted from own run without message and empty stream", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage]);
  });
});

describe("sendChatMessage", () => {
  it("requests external delivery for control chat sends", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });

    const runId = await sendChatMessage(state, "hello");

    expect(typeof runId).toBe("string");
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "hello",
        deliver: true,
      }),
    );
  });
});
