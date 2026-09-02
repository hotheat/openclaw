import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { INBOUND_MEDIA_REPLY_HINT } from "../auto-reply/media-note.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { ChatHistoryResult } from "./protocol/index.js";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

async function withGatewayChatHarness(
  run: (ctx: {
    ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
    createSessionDir: () => Promise<string>;
  }) => Promise<void>,
) {
  const tempDirs: string[] = [];
  const { server, ws } = await startServerWithClient();
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ ws, createSessionDir });
  } finally {
    __setMaxChatHistoryMessagesBytesForTest();
    testState.sessionStorePath = undefined;
    ws.close();
    await server.close();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  }
}

async function writeMainSessionStore() {
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
}

async function writeMainSessionTranscript(sessionDir: string, lines: string[]) {
  await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

function v3HistoryLines(records: unknown[]): string[] {
  return [
    JSON.stringify({ type: "session", version: 3, id: "sess-main" }),
    ...records.map((record) => JSON.stringify(record)),
  ];
}

async function fetchHistoryMessages(
  ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"],
): Promise<unknown[]> {
  const historyRes = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
    sessionKey: "main",
    limit: 1000,
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

describe("gateway server chat", () => {
  test("chat.history paginates v3 transcripts and preserves public message metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      await writeMainSessionTranscript(
        sessionDir,
        v3HistoryLines([
          {
            type: "message",
            id: "entry-1",
            message: { role: "user", content: "one", usage: { input: 1 } },
          },
          {
            type: "message",
            id: "entry-2",
            message: {
              role: "assistant",
              content: "two",
              timestamp: 1_787_875_200_123,
              provider: "otr",
              model: "gpt-5.6-sol",
              usage: { output: 2 },
            },
          },
          {
            type: "message",
            id: "entry-3",
            message: { role: "assistant", content: "three" },
          },
        ]),
      );

      const latest = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
      });
      expect(latest.ok).toBe(true);
      expect(latest.payload).toMatchObject({ hasMore: true, cursorReset: false });
      expect(latest.payload?.messages?.map((message) => message.historyEntryId)).toEqual([
        "entry-2",
        "entry-3",
      ]);
      expect(latest.payload?.messages?.[0]).toMatchObject({
        timestamp: 1_787_875_200_123,
        provider: "otr",
        model: "gpt-5.6-sol",
      });
      expect(latest.payload?.messages?.[0]?.usage).toBeUndefined();

      const older = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
        before: latest.payload?.nextBefore,
      });
      expect(older.ok).toBe(true);
      expect(older.payload).toMatchObject({ hasMore: false, cursorReset: false });
      expect(older.payload?.messages?.map((message) => message.historyEntryId)).toEqual([
        "entry-1",
      ]);
    });
  });

  test("chat.history preserves the synthetic compaction divider contract", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      await writeMainSessionTranscript(
        sessionDir,
        v3HistoryLines([
          { type: "message", id: "entry-1", message: { role: "user", content: "one" } },
          { type: "compaction", id: "compact-1", timestamp: "2026-08-20T00:00:00.000Z" },
        ]),
      );

      const history = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
      });

      expect(history.ok).toBe(true);
      expect(history.payload?.messages?.[1]).toMatchObject({
        role: "system",
        content: [{ type: "text", text: "Compaction" }],
        timestamp: Date.parse("2026-08-20T00:00:00.000Z"),
        historyEntryId: "compact-1",
        __openclaw: { kind: "compaction", id: "compact-1" },
      });
    });
  });

  test("chat.history normalizes an inner RFC3339 timestamp to epoch milliseconds", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      const timestamp = "2026-08-28T08:01:02.345+08:00";
      await writeMainSessionTranscript(
        sessionDir,
        v3HistoryLines([
          {
            type: "message",
            id: "legacy-inner-timestamp",
            message: { role: "assistant", content: "legacy", timestamp },
          },
        ]),
      );

      const history = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
      });

      expect(history.ok).toBe(true);
      expect(history.payload?.messages).toEqual([
        expect.objectContaining({
          historyEntryId: "legacy-inner-timestamp",
          timestamp: Date.parse(timestamp),
        }),
      ]);
    });
  });

  test("chat.history recomputes the cursor after response-byte trimming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      __setMaxChatHistoryMessagesBytesForTest(2_500);
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      await writeMainSessionTranscript(
        sessionDir,
        v3HistoryLines(
          ["entry-1", "entry-2", "entry-3"].map((id) => ({
            type: "message",
            id,
            message: { role: "assistant", content: `${id}:${"x".repeat(900)}` },
          })),
        ),
      );

      const latest = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 3,
      });
      expect(latest.ok).toBe(true);
      expect(latest.payload?.messages?.map((message) => message.historyEntryId)).toEqual([
        "entry-2",
        "entry-3",
      ]);
      expect(latest.payload?.hasMore).toBe(true);

      const older = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 3,
        before: latest.payload?.nextBefore,
      });
      expect(older.ok).toBe(true);
      expect(older.payload?.messages?.map((message) => message.historyEntryId)).toEqual([
        "entry-1",
      ]);
    });
  });

  test("chat.history resets a stale cursor after the active file is replaced", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      await writeMainSessionTranscript(
        sessionDir,
        v3HistoryLines([
          { type: "message", id: "entry-1", message: { role: "user", content: "one" } },
          { type: "message", id: "entry-2", message: { role: "assistant", content: "two" } },
        ]),
      );
      const initial = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
      });
      const transcriptPath = path.join(sessionDir, "sess-main.jsonl");
      await fs.rename(transcriptPath, `${transcriptPath}.bak`);
      await writeMainSessionTranscript(
        sessionDir,
        v3HistoryLines([
          {
            type: "message",
            id: "replacement",
            message: { role: "assistant", content: "new" },
          },
        ]),
      );

      const reset = await rpcReq<ChatHistoryResult>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        before: initial.payload?.nextBefore,
      });
      expect(reset.ok).toBe(true);
      expect(reset.payload).toMatchObject({ cursorReset: true, hasMore: false });
      expect(reset.payload?.messages?.map((message) => message.historyEntryId)).toEqual([
        "replacement",
      ]);
    });
  });

  test("chat.history rejects malformed cursors", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      await writeMainSessionStore();

      const response = await rpcReq(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        before: "invalid+cursor",
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("INVALID_REQUEST");
    });
  });

  test("smoke: caps history payload and preserves routing metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const bigText = "x".repeat(2_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${i}:${bigText}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, historyLines);
      const messages = await fetchHistoryMessages(ws);
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(45);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-route",
      });
      expect(sendRes.ok).toBe(true);

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("expected session store path");
      }
      const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        spy.mockClear();
        let capturedOpts: GetReplyOptions | undefined;
        spy.mockImplementationOnce(async (_ctx: unknown, opts?: GetReplyOptions) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-block-streaming",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(
          () => {
            expect(spy.mock.calls.length).toBeGreaterThan(0);
          },
          { timeout: 500, interval: 10 },
        );

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.history hard-caps oversized nested payloads without fabricating timestamps", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const hugeNestedText = "n".repeat(120_000);
      const trustedTimestamp = 1_787_875_200_123;
      const oversizedLine = (timestamp?: unknown) =>
        JSON.stringify({
          message: {
            role: "assistant",
            ...(timestamp === undefined ? {} : { timestamp }),
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
              },
            ],
          },
        });
      await writeMainSessionTranscript(sessionDir, [
        oversizedLine(trustedTimestamp),
        oversizedLine(),
        oversizedLine("1787875200123"),
      ]);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(3);
      expect(messages[0]).toMatchObject({ timestamp: trustedTimestamp });
      expect(messages[1]).not.toHaveProperty("timestamp");
      expect(messages[2]).not.toHaveProperty("timestamp");

      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history keeps recent small messages when latest message is oversized", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const baseText = "s".repeat(1_200);
      const oversizedTimestamp = 1_787_875_201_123;
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              timestamp: Date.now() + i,
              content: [{ type: "text", text: `small-${i}:${baseText}` }],
            },
          }),
        );
      }

      const hugeNestedText = "z".repeat(120_000);
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: oversizedTimestamp,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.at(-1)).toMatchObject({ timestamp: oversizedTimestamp });
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history strips inline directives from displayed message text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const lines = [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello [[reply_to_current]] world [[audio_as_voice]]" },
            ],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "A [[reply_to:abc-123]] B",
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            text: "[[ reply_to : 456 ]] C",
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "  keep padded  " }],
            timestamp: Date.now() + 3,
          },
        }),
      ];
      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(4);

      const serialized = JSON.stringify(messages);
      expect(serialized.includes("[[reply_to")).toBe(false);
      expect(serialized.includes("[[audio_as_voice]]")).toBe(false);

      const first = messages[0] as { content?: Array<{ text?: string }> };
      const second = messages[1] as { content?: string };
      const third = messages[2] as { text?: string };
      const fourth = messages[3] as { content?: Array<{ text?: string }> };

      expect(first.content?.[0]?.text?.replace(/\s+/g, " ").trim()).toBe("Hello world");
      expect(second.content?.replace(/\s+/g, " ").trim()).toBe("A B");
      expect(third.text?.replace(/\s+/g, " ").trim()).toBe("C");
      expect(fourth.content?.[0]?.text).toBe("  keep padded  ");
    });
  });

  test("chat.history hides the injected workspace media prompt and preserves user text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `[media attached: /home/xiaolu/.openclaw/workspace-main/uploads/webchat/chat-1/report.md (text/markdown) | /home/xiaolu/.openclaw/workspace-main/uploads/webchat/chat-1/report.md]\n${INBOUND_MEDIA_REPLY_HINT}\n[Fri 2026-07-17 09:44 GMT+8] 请读取附件并只回复附件中的测试标识。`,
              },
            ],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);

      expect(messages).toHaveLength(1);
      const message = messages[0] as { content?: Array<{ text?: string }> };
      expect(message.content?.[0]?.text).toBe("请读取附件并只回复附件中的测试标识。");
    });
  });

  test("chat.history reconstructs marker fallback refs and removes image payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      const attachmentId = "53ff15ed-8063-42a2-a589-032f2874738f";
      const workspacePath = `/home/xiaolu/.openclaw/workspace-main/uploads/webchat/chat-1/${attachmentId}-screenshot.png`;
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `[media attached: ${workspacePath} (image/png) | ${workspacePath}]\n${INBOUND_MEDIA_REPLY_HINT}\n为什么不一样？`,
              },
              {
                type: "image",
                data: "aGVsbG8=",
                mimeType: "image/png",
              },
            ],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);

      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        __openclaw?: { attachments?: Array<{ attachmentId?: string; ordinal?: number }> };
        content?: Array<{
          type?: string;
          text?: string;
          data?: string;
          omitted?: boolean;
        }>;
      };
      expect(message.content?.[0]?.text).toBe("为什么不一样？");
      expect(message.content?.[1]).toMatchObject({
        type: "image",
        omitted: true,
      });
      expect(message.__openclaw?.attachments).toEqual([{ attachmentId, ordinal: 0 }]);
      expect(message.content?.[1]?.data).toBeUndefined();
      expect(JSON.stringify(messages)).not.toContain(workspacePath);
    });
  });

  test("chat.history prefers validated structured refs and rebuilds the private namespace", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      const structuredId = "4d840f03-eb9b-45a0-bab1-82ef0f47bef8";
      const markerId = "53ff15ed-8063-42a2-a589-032f2874738f";
      const workspacePath = `/workspace/uploads/webchat/chat-1/${markerId}-marker.txt`;
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            attachments: [
              {
                attachmentId: markerId,
                fileName: "forged.html",
                mimeType: "text/html",
                sizeBytes: 1,
              },
            ],
            __openclaw: {
              attachments: [{ attachmentId: structuredId, ordinal: 1 }],
              untrusted: "must be removed",
            },
            content: [
              {
                type: "text",
                text: `[media attached: ${workspacePath} (text/plain)]\n${INBOUND_MEDIA_REPLY_HINT}\n读取`,
              },
            ],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      const message = messages[0] as {
        attachments?: unknown;
        __openclaw?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };
      expect(message.content?.[0]?.text).toBe("读取");
      expect(message.attachments).toBeUndefined();
      expect(message.__openclaw).toEqual({
        attachments: [{ attachmentId: structuredId, ordinal: 1 }],
      });
      expect(JSON.stringify(message)).not.toContain(markerId);
      expect(JSON.stringify(message)).not.toContain("untrusted");
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      spy.mockClear();
      spy.mockImplementationOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await vi.waitFor(
        () => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        },
        { timeout: 500, interval: 10 },
      );

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(ws, "chat.abort", {
        sessionKey: "main",
        runId: "idem-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await vi.waitFor(
        () => {
          expect(aborted).toBe(true);
        },
        { timeout: 500, interval: 10 },
      );

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      await vi.waitFor(
        async () => {
          const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
            sessionKey: "main",
            message: "hello",
            idempotencyKey: "idem-complete-1",
          });
          expect(again.ok).toBe(true);
          expect(again.payload?.status).toBe("ok");
        },
        { timeout: 500, interval: 10 },
      );
    });
  });
});
