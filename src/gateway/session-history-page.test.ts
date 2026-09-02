import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedTranscriptScanLimitError } from "../sessions/bounded-transcript.js";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  assertValidSessionHistoryCursor,
  createSessionHistoryPageCursor,
  InvalidHistoryCursorError,
  loadSessionHistoryPage,
  readSessionHistoryPage,
} from "./session-history-page.js";

const temporaryDirectories: string[] = [];

async function createTranscript(
  records: unknown[],
  options?: { sessionId?: string; version?: number; trailingNewline?: boolean },
): Promise<{ filePath: string; sessionId: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-page-"));
  temporaryDirectories.push(directory);
  const sessionId = options?.sessionId ?? "session-1";
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  const lines = [
    { type: "session", version: options?.version ?? 3, id: sessionId },
    ...records,
  ].map((record) => JSON.stringify(record));
  await fs.writeFile(
    filePath,
    `${lines.join("\n")}${options?.trailingNewline === false ? "" : "\n"}`,
  );
  return { filePath, sessionId };
}

async function readPage(params: {
  filePath: string;
  sessionId: string;
  limit: number;
  before?: string;
  chunkSize?: number;
  maxLineBytes?: number;
  maxScanBytes?: number;
  maxRawRecords?: number;
}) {
  return readSessionHistoryPage({
    sessionId: params.sessionId,
    storePath: undefined,
    sessionFile: params.filePath,
    before: params.before,
    limit: params.limit,
    chunkSize: params.chunkSize,
    maxLineBytes: params.maxLineBytes,
    maxScanBytes: params.maxScanBytes,
    maxRawRecords: params.maxRawRecords,
  });
}

async function cursorForPage(
  page: Awaited<ReturnType<typeof readPage>>,
  offset = page.nextOffset,
): Promise<string | undefined> {
  return offset === undefined ? undefined : createSessionHistoryPageCursor(page, offset);
}

function messageRecord(id: string | undefined, text: string, metadata?: Record<string, unknown>) {
  return {
    type: "message",
    ...(id ? { id } : {}),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      ...metadata,
    },
  };
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

afterEach(async () => {
  __setMaxChatHistoryMessagesBytesForTest();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("loadSessionHistoryPage", () => {
  it("finalizes presentation, response budget, and cursor behind one interface", async () => {
    __setMaxChatHistoryMessagesBytesForTest(2_500);
    const transcript = await createTranscript(
      ["entry-1", "entry-2", "entry-3"].map((id) =>
        messageRecord(id, `${id}:${"x".repeat(900)}`, { usage: { output: 1 } }),
      ),
    );

    const latest = await loadSessionHistoryPage({
      sessionId: transcript.sessionId,
      storePath: undefined,
      sessionFile: transcript.filePath,
      limit: 3,
    });

    expect(
      latest.messages.map((message) => (message as { historyEntryId?: string }).historyEntryId),
    ).toEqual(["entry-2", "entry-3"]);
    expect(latest.messages[0]).not.toHaveProperty("usage");
    expect(latest).toMatchObject({ hasMore: true, cursorReset: false });
    expect(latest.nextBefore).toBeTypeOf("string");
    expect(latest.diagnostics.responseBytes).toBeLessThanOrEqual(2_500);

    const older = await loadSessionHistoryPage({
      sessionId: transcript.sessionId,
      storePath: undefined,
      sessionFile: transcript.filePath,
      before: latest.nextBefore,
      limit: 3,
    });
    expect(
      older.messages.map((message) => (message as { historyEntryId?: string }).historyEntryId),
    ).toEqual(["entry-1"]);
    expect(older.hasMore).toBe(false);
  });

  it("preserves a trusted timestamp on a final budget placeholder", async () => {
    const text = "b".repeat(400);
    const timestamp = 1_787_875_200_123;
    const expectedMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp,
      historyEntryId: "budget-placeholder",
    };
    __setMaxChatHistoryMessagesBytesForTest(
      Buffer.byteLength(JSON.stringify(expectedMessage), "utf8") + 1,
    );
    const transcript = await createTranscript([
      messageRecord("budget-placeholder", text, { timestamp }),
    ]);

    const result = await loadSessionHistoryPage({
      sessionId: transcript.sessionId,
      storePath: undefined,
      sessionFile: transcript.filePath,
      limit: 1,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      timestamp,
      __openclaw: { truncated: true, reason: "oversized" },
    });
    expect(result.diagnostics.placeholderCount).toBe(1);
  });

  it("omits a missing timestamp on a final budget placeholder", async () => {
    const text = "b".repeat(400);
    const expectedMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      historyEntryId: "budget-placeholder",
    };
    __setMaxChatHistoryMessagesBytesForTest(
      Buffer.byteLength(JSON.stringify(expectedMessage), "utf8") + 1,
    );
    const transcript = await createTranscript([messageRecord("budget-placeholder", text)]);

    const result = await loadSessionHistoryPage({
      sessionId: transcript.sessionId,
      storePath: undefined,
      sessionFile: transcript.filePath,
      limit: 1,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).not.toHaveProperty("timestamp");
    expect(result.messages[0]).toMatchObject({
      __openclaw: { truncated: true, reason: "oversized" },
    });
    expect(result.diagnostics.placeholderCount).toBe(1);
  });
});

describe("readSessionHistoryPage", () => {
  it("reads newest records and paginates backward without gaps or overlap", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two", { provider: "otr", model: "gpt-5.6-sol" }),
      messageRecord("entry-3", "three"),
    ]);

    const latest = await readPage({ ...transcript, limit: 2 });
    expect(latest.records.map((record) => record.historyEntryId)).toEqual(["entry-2", "entry-3"]);
    expect(latest.records[0]?.message).toMatchObject({
      historyEntryId: "entry-2",
      provider: "otr",
      model: "gpt-5.6-sol",
    });
    expect(latest.hasMore).toBe(true);
    const latestCursor = await cursorForPage(latest);
    expect(latestCursor).toBeTypeOf("string");
    expect(latest.cursorReset).toBe(false);

    const older = await readPage({
      ...transcript,
      limit: 2,
      before: latestCursor,
    });
    expect(older.records.map((record) => record.historyEntryId)).toEqual(["entry-1"]);
    expect(older.hasMore).toBe(false);
    expect(older.nextOffset).toBeUndefined();
  });

  it("normalizes trusted message and transcript timestamps without guessing legacy values", async () => {
    const envelopeTimestamp = "2026-08-28T00:00:00.123Z";
    const innerRfc3339Timestamp = "2026-08-28T08:01:02.345+08:00";
    const transcript = await createTranscript([
      {
        type: "message",
        id: "inner-wins",
        timestamp: envelopeTimestamp,
        message: { role: "assistant", content: "one", timestamp: 1_787_875_200_456 },
      },
      {
        type: "message",
        id: "envelope-fallback",
        timestamp: envelopeTimestamp,
        message: { role: "assistant", content: "two" },
      },
      {
        type: "message",
        id: "inner-rfc3339",
        message: {
          role: "assistant",
          content: "legacy string timestamp",
          timestamp: innerRfc3339Timestamp,
        },
      },
      {
        type: "message",
        id: "zero-falls-back",
        timestamp: envelopeTimestamp,
        message: { role: "assistant", content: "zero", timestamp: 0 },
      },
      {
        type: "message",
        id: "invalid",
        timestamp: 1_787_875_200_789,
        message: { role: "assistant", content: "three", timestamp: "1787875200789" },
      },
      ...["01", "08/28/2026", "2026-02-30T00:00:00.000Z"].map((timestamp, index) => ({
        type: "message",
        id: `invalid-envelope-${index}`,
        timestamp,
        message: { role: "assistant", content: `invalid ${index}` },
      })),
    ]);

    const page = await readPage({ ...transcript, limit: 10 });

    expect(page.records.map((record) => record.message)).toEqual([
      expect.objectContaining({ historyEntryId: "inner-wins", timestamp: 1_787_875_200_456 }),
      expect.objectContaining({
        historyEntryId: "envelope-fallback",
        timestamp: Date.parse(envelopeTimestamp),
      }),
      expect.objectContaining({
        historyEntryId: "inner-rfc3339",
        timestamp: Date.parse(innerRfc3339Timestamp),
      }),
      expect.objectContaining({
        historyEntryId: "zero-falls-back",
        timestamp: Date.parse(envelopeTimestamp),
      }),
      expect.not.objectContaining({ timestamp: expect.anything() }),
      expect.not.objectContaining({ timestamp: expect.anything() }),
      expect.not.objectContaining({ timestamp: expect.anything() }),
      expect.not.objectContaining({ timestamp: expect.anything() }),
    ]);
  });

  it("keeps UTF-8 intact across small chunk boundaries and skips malformed lines", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "中文🙂跨块"),
      "malformed-placeholder",
      messageRecord("entry-2", "尾部"),
    ]);
    const content = await fs.readFile(transcript.filePath, "utf8");
    await fs.writeFile(
      transcript.filePath,
      content.replace('"malformed-placeholder"', "{bad-json"),
    );

    const page = await readPage({ ...transcript, limit: 10, chunkSize: 5 });
    expect(page.records.map((record) => record.message)).toEqual([
      expect.objectContaining({ content: [{ type: "text", text: "中文🙂跨块" }] }),
      expect.objectContaining({ content: [{ type: "text", text: "尾部" }] }),
    ]);
    expect(page.malformedLines).toBe(1);
    expect(page.readChunks).toBeGreaterThan(1);
  });

  it("retries short positional reads without skipping transcript bytes", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
      messageRecord("entry-3", "three"),
    ]);
    const realHandle = await nodeFs.promises.open(transcript.filePath, "r");
    const shortReadHandle = {
      read: (buffer: Buffer, offset: number, length: number, position: number) =>
        realHandle.read(buffer, offset, Math.min(length, 3), position),
      stat: realHandle.stat.bind(realHandle),
      close: realHandle.close.bind(realHandle),
    } as typeof realHandle;
    const openSpy = vi.spyOn(nodeFs.promises, "open").mockResolvedValueOnce(shortReadHandle);

    try {
      const page = await readPage({ ...transcript, limit: 3, chunkSize: 7 });
      expect(page.paginationSupported).toBe(true);
      expect(page.records.map((record) => record.historyEntryId)).toEqual([
        "entry-1",
        "entry-2",
        "entry-3",
      ]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("ignores an incomplete trailing line without losing the preceding record", async () => {
    const transcript = await createTranscript([messageRecord("entry-1", "complete")]);
    await fs.appendFile(transcript.filePath, '{"type":"message","message":');

    const page = await readPage({ ...transcript, limit: 10, chunkSize: 7 });
    expect(page.records.map((record) => record.historyEntryId)).toEqual(["entry-1"]);
    expect(page.malformedLines).toBe(0);
  });

  it("emits compaction dividers and synthesizes stable offset IDs", async () => {
    const transcript = await createTranscript([
      messageRecord(undefined, "no id"),
      { type: "compaction", id: "compact-1", timestamp: "2026-08-18T00:00:00.000Z" },
    ]);

    const first = await readPage({ ...transcript, limit: 10 });
    const second = await readPage({ ...transcript, limit: 10 });
    expect(first.records[0]?.historyEntryId).toMatch(/^off-\d+$/);
    expect(second.records[0]?.historyEntryId).toBe(first.records[0]?.historyEntryId);
    expect(first.records[1]?.message).toMatchObject({
      historyEntryId: "compact-1",
      timestamp: Date.parse("2026-08-18T00:00:00.000Z"),
      __openclaw: { kind: "compaction", id: "compact-1" },
    });
  });

  it("omits timestamps when compaction records have no trusted time", async () => {
    const transcript = await createTranscript([
      { type: "compaction", id: "compact-invalid", timestamp: "not-a-date" },
    ]);

    const page = await readPage({ ...transcript, limit: 10 });

    expect(page.records[0]?.message).not.toHaveProperty("timestamp");
  });

  it("keeps an existing cursor valid when the transcript is appended", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
      messageRecord("entry-3", "three"),
    ]);
    const latest = await readPage({ ...transcript, limit: 1 });
    const latestCursor = await cursorForPage(latest);
    await fs.appendFile(
      transcript.filePath,
      `${JSON.stringify(messageRecord("entry-4", "four"))}\n`,
    );

    const older = await readPage({ ...transcript, limit: 2, before: latestCursor });
    expect(older.cursorReset).toBe(false);
    expect(older.records.map((record) => record.historyEntryId)).toEqual(["entry-1", "entry-2"]);
  });

  it("resets to the newest page when the transcript file is replaced", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
    ]);
    const initial = await readPage({ ...transcript, limit: 1 });
    const initialCursor = await cursorForPage(initial);
    await fs.rename(transcript.filePath, `${transcript.filePath}.bak`);
    await fs.writeFile(
      transcript.filePath,
      [
        JSON.stringify({ type: "session", version: 3, id: transcript.sessionId }),
        JSON.stringify(messageRecord("replacement", "new")),
        "",
      ].join("\n"),
    );

    const reset = await readPage({ ...transcript, limit: 1, before: initialCursor });
    expect(reset.cursorReset).toBe(true);
    expect(reset.records.map((record) => record.historyEntryId)).toEqual(["replacement"]);
  });

  it("resets cursors that exceed a truncated transcript", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
      messageRecord("entry-3", "three"),
    ]);
    const initial = await readPage({ ...transcript, limit: 1 });
    const initialCursor = await cursorForPage(initial);
    await fs.truncate(transcript.filePath, 0);
    await fs.writeFile(
      transcript.filePath,
      `${JSON.stringify({ type: "session", version: 3, id: transcript.sessionId })}\n`,
    );

    const reset = await readPage({ ...transcript, limit: 1, before: initialCursor });
    expect(reset.cursorReset).toBe(true);
    expect(reset.records).toEqual([]);
  });

  it("resets after an in-place truncate and rewrite that grows beyond the old offset", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
      messageRecord("entry-3", "three"),
    ]);
    const initial = await readPage({ ...transcript, limit: 1 });
    const initialCursor = await cursorForPage(initial);
    const cursor = decodeCursor(initialCursor) as { beforeOffset: number };
    const header = `${JSON.stringify({ type: "session", version: 3, id: transcript.sessionId })}\n`;
    const paddingLength = cursor.beforeOffset - header.length - 1;
    expect(paddingLength).toBeGreaterThanOrEqual(0);
    const rewritten = [
      header,
      `${" ".repeat(paddingLength)}\n`,
      `${JSON.stringify(messageRecord("replacement-1", "new one"))}\n`,
      `${JSON.stringify(messageRecord("replacement-2", "new two"))}\n`,
    ].join("");
    expect(Buffer.byteLength(rewritten)).toBeGreaterThan(cursor.beforeOffset);
    await fs.writeFile(transcript.filePath, rewritten);

    const reset = await readPage({ ...transcript, limit: 1, before: initialCursor });
    expect(reset.cursorReset).toBe(true);
    expect(reset.records.map((record) => record.historyEntryId)).toEqual(["replacement-2"]);
  });

  it("resets after a same-size rewrite modifies bytes before the cursor anchor", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
      messageRecord("entry-3", "three"),
    ]);
    const initial = await readPage({ ...transcript, limit: 1 });
    const initialCursor = await cursorForPage(initial);
    const content = await fs.readFile(transcript.filePath, "utf8");
    const rewritten = content.replace('"two"', '"TWO"');
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(content));
    await fs.writeFile(transcript.filePath, rewritten);

    const reset = await readPage({ ...transcript, limit: 1, before: initialCursor });
    expect(reset.cursorReset).toBe(true);
    expect(reset.records.map((record) => record.historyEntryId)).toEqual(["entry-3"]);
  });

  it("resets when bytes after the cursor anchor are modified in place", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
      messageRecord("entry-3", "three"),
    ]);
    const initial = await readPage({ ...transcript, limit: 1 });
    const initialCursor = await cursorForPage(initial);
    const content = await fs.readFile(transcript.filePath, "utf8");
    await fs.writeFile(transcript.filePath, content.replace('"three"', '"THREE"'));

    const reset = await readPage({ ...transcript, limit: 1, before: initialCursor });
    expect(reset.cursorReset).toBe(true);
    expect(reset.records.map((record) => record.historyEntryId)).toEqual(["entry-3"]);
  });

  it("does not paginate non-v3 transcripts", async () => {
    const transcript = await createTranscript(
      [messageRecord("entry-1", "one"), messageRecord("entry-2", "two")],
      { version: 2 },
    );

    const page = await readPage({ ...transcript, limit: 1 });
    expect(page.cursorReset).toBe(true);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeUndefined();
    expect(page.records.map((record) => record.historyEntryId)).toEqual(["entry-2"]);
  });

  it("rejects malformed cursors", async () => {
    const transcript = await createTranscript([messageRecord("entry-1", "one")]);
    await expect(
      readPage({ ...transcript, limit: 1, before: "not+a+base64url+cursor" }),
    ).rejects.toBeInstanceOf(InvalidHistoryCursorError);
  });

  it("rejects V1 cursors and non-canonical anchor bounds", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
    ]);
    const page = await readPage({ ...transcript, limit: 1 });
    const valid = decodeCursor(await cursorForPage(page));
    const v1 = encodeCursor({
      v: 1,
      sessionId: valid.sessionId,
      fileToken: valid.fileToken,
      beforeOffset: valid.beforeOffset,
    });
    expect(() => assertValidSessionHistoryCursor(v1)).toThrow(InvalidHistoryCursorError);

    const oversizedAnchor = encodeCursor({ ...valid, anchorLength: 4097 });
    expect(() => assertValidSessionHistoryCursor(oversizedAnchor)).toThrow(
      InvalidHistoryCursorError,
    );

    const shiftedAnchor = encodeCursor({
      ...valid,
      anchorStart: Number(valid.anchorStart) + 1,
      anchorLength: Number(valid.anchorLength) - 1,
    });
    expect(() => assertValidSessionHistoryCursor(shiftedAnchor)).toThrow(InvalidHistoryCursorError);
  });

  it("rejects oversized encoded cursors before decoding", () => {
    expect(() => assertValidSessionHistoryCursor("a".repeat(4097))).toThrow(
      InvalidHistoryCursorError,
    );
  });

  it("reads a record larger than one chunk", async () => {
    const text = "x".repeat(256 * 1024);
    const transcript = await createTranscript([messageRecord("large", text)]);

    const page = await readPage({ ...transcript, limit: 1, chunkSize: 1024 });
    expect(page.records[0]?.message).toMatchObject({
      historyEntryId: "large",
      content: [{ type: "text", text }],
    });
  });

  it("opens the transcript only once more when creating a page cursor", async () => {
    const transcript = await createTranscript(
      Array.from({ length: 1001 }, (_, index) => messageRecord(`entry-${index}`, "x")),
    );
    const openSpy = vi.spyOn(nodeFs.promises, "open");

    try {
      const page = await readPage({ ...transcript, limit: 1000 });
      expect(openSpy).toHaveBeenCalledTimes(1);
      await cursorForPage(page);
      expect(openSpy).toHaveBeenCalledTimes(2);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("propagates hard transcript open errors without exposing the path", async () => {
    const transcript = await createTranscript([messageRecord("entry-1", "one")]);
    const error = Object.assign(new Error(`EMFILE: ${transcript.filePath}`), { code: "EMFILE" });
    const openSpy = vi.spyOn(nodeFs.promises, "open").mockRejectedValueOnce(error);

    try {
      const read = readPage({ ...transcript, limit: 1 });
      await expect(read).rejects.toThrow("session history open failed: EMFILE");
      await expect(read).rejects.not.toThrow(transcript.filePath);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("returns an empty page when every transcript candidate is missing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-missing-"));
    temporaryDirectories.push(directory);

    const page = await readPage({
      filePath: path.join(directory, "missing.jsonl"),
      sessionId: "missing",
      limit: 1,
    });

    expect(page.records).toEqual([]);
    expect(page.cursorReset).toBe(false);
  });

  it("replaces an oversized transcript record and continues to older history", async () => {
    const oversizedRecord = messageRecord("oversized", "x".repeat(512));
    const oversizedLineBytes = Buffer.byteLength(JSON.stringify(oversizedRecord), "utf8");
    const transcript = await createTranscript([messageRecord("older", "old"), oversizedRecord]);

    const latest = await readPage({
      ...transcript,
      limit: 1,
      chunkSize: oversizedLineBytes + 1,
      maxLineBytes: 128,
      maxScanBytes: 4096,
    });
    expect(latest.records[0]?.message).toMatchObject({
      historyEntryId: expect.stringMatching(/^off-\d+$/),
      __openclaw: { truncated: true, reason: "oversized-transcript-record" },
    });
    expect(latest.hasMore).toBe(true);

    const older = await readPage({
      ...transcript,
      limit: 1,
      before: await cursorForPage(latest),
    });
    expect(older.records.map((record) => record.historyEntryId)).toEqual(["older"]);
  });

  it("rejects cursor creation when the transcript changes after the page read", async () => {
    const transcript = await createTranscript([
      messageRecord("entry-1", "one"),
      messageRecord("entry-2", "two"),
    ]);
    const page = await readPage({ ...transcript, limit: 1 });
    const content = await fs.readFile(transcript.filePath, "utf8");
    await fs.writeFile(transcript.filePath, content.replace('"two"', '"TWO"'));

    await expect(cursorForPage(page)).rejects.toThrow(
      "session history changed before creating the pagination cursor",
    );
  });

  it("returns a continuation boundary after the raw-record scan budget", async () => {
    const transcript = await createTranscript([
      messageRecord("older", "old"),
      "malformed-1",
      "malformed-2",
      "malformed-3",
    ]);
    const content = await fs.readFile(transcript.filePath, "utf8");
    await fs.writeFile(transcript.filePath, content.replaceAll(/"malformed-\d"/g, "{bad-json"));

    const latest = await readPage({ ...transcript, limit: 1, maxRawRecords: 2 });
    expect(latest.records).toEqual([]);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextOffset).toBeTypeOf("number");

    const older = await readPage({
      ...transcript,
      limit: 1,
      before: await cursorForPage(latest),
    });
    expect(older.records.map((record) => record.historyEntryId)).toEqual(["older"]);
  });

  it("fails within the scan budget when no line boundary is available", async () => {
    const transcript = await createTranscript([messageRecord("oversized", "x".repeat(1024))]);

    await expect(
      readPage({
        ...transcript,
        limit: 1,
        chunkSize: 16,
        maxLineBytes: 32,
        maxScanBytes: 64,
      }),
    ).rejects.toBeInstanceOf(BoundedTranscriptScanLimitError);
  });
});
