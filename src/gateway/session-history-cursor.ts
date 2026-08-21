import { createHash } from "node:crypto";
import type fs from "node:fs";

const HISTORY_CURSOR_VERSION = 2;
const HISTORY_CURSOR_ANCHOR_SIDE_BYTES = 2 * 1024;
const MAX_HISTORY_CURSOR_ANCHOR_BYTES = HISTORY_CURSOR_ANCHOR_SIDE_BYTES * 2;
const MAX_HISTORY_CURSOR_ENCODED_BYTES = 4 * 1024;
const MAX_HISTORY_CURSOR_SESSION_ID_BYTES = 1024;
const HISTORY_CURSOR_HASH_DOMAIN = "openclaw-history-cursor-v2";

export type HistoryCursorPayload = {
  v: typeof HISTORY_CURSOR_VERSION;
  sessionId: string;
  fileToken: string;
  beforeOffset: number;
  anchorStart: number;
  anchorLength: number;
  anchorHash: string;
};

export class InvalidHistoryCursorError extends Error {
  constructor(message = "invalid chat history cursor") {
    super(message);
    this.name = "InvalidHistoryCursorError";
  }
}

export function decodeHistoryCursor(value: string): HistoryCursorPayload {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_HISTORY_CURSOR_ENCODED_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new InvalidHistoryCursorError();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new InvalidHistoryCursorError();
  }
  if (decoded.toString("base64url") !== value) {
    throw new InvalidHistoryCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new InvalidHistoryCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidHistoryCursorError();
  }
  const payload = parsed as Record<string, unknown>;
  const beforeOffset = payload.beforeOffset;
  const anchorStart = payload.anchorStart;
  const anchorLength = payload.anchorLength;
  if (
    payload.v !== HISTORY_CURSOR_VERSION ||
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length === 0 ||
    Buffer.byteLength(payload.sessionId, "utf8") > MAX_HISTORY_CURSOR_SESSION_ID_BYTES ||
    typeof payload.fileToken !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(payload.fileToken) ||
    !Number.isSafeInteger(beforeOffset) ||
    (beforeOffset as number) < 0 ||
    !Number.isSafeInteger(anchorStart) ||
    (anchorStart as number) < 0 ||
    !Number.isSafeInteger(anchorLength) ||
    (anchorLength as number) <= 0 ||
    (anchorLength as number) > MAX_HISTORY_CURSOR_ANCHOR_BYTES ||
    typeof payload.anchorHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.anchorHash)
  ) {
    throw new InvalidHistoryCursorError();
  }
  const normalizedBeforeOffset = beforeOffset as number;
  const normalizedAnchorStart = anchorStart as number;
  const normalizedAnchorLength = anchorLength as number;
  const expectedAnchorStart = Math.max(
    0,
    normalizedBeforeOffset - HISTORY_CURSOR_ANCHOR_SIDE_BYTES,
  );
  const anchorEnd = normalizedAnchorStart + normalizedAnchorLength;
  if (
    !Number.isSafeInteger(anchorEnd) ||
    normalizedAnchorStart !== expectedAnchorStart ||
    anchorEnd <= normalizedBeforeOffset ||
    anchorEnd - normalizedBeforeOffset > HISTORY_CURSOR_ANCHOR_SIDE_BYTES
  ) {
    throw new InvalidHistoryCursorError();
  }
  return {
    v: HISTORY_CURSOR_VERSION,
    sessionId: payload.sessionId,
    fileToken: payload.fileToken,
    beforeOffset: normalizedBeforeOffset,
    anchorStart: normalizedAnchorStart,
    anchorLength: normalizedAnchorLength,
    anchorHash: payload.anchorHash,
  };
}

export function assertValidSessionHistoryCursor(value: string): void {
  decodeHistoryCursor(value);
}

function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function hashCursorAnchor(params: {
  beforeOffset: number;
  anchorStart: number;
  anchorLength: number;
  bytes: Buffer;
}): string {
  return createHash("sha256")
    .update(HISTORY_CURSOR_HASH_DOMAIN)
    .update("\0")
    .update(String(params.beforeOffset))
    .update("\0")
    .update(String(params.anchorStart))
    .update("\0")
    .update(String(params.anchorLength))
    .update("\0")
    .update(params.bytes)
    .digest("base64url");
}

async function readCursorAnchorBytes(
  handle: fs.promises.FileHandle,
  anchorStart: number,
  anchorLength: number,
): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(anchorLength);
  let totalBytesRead = 0;
  while (totalBytesRead < anchorLength) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytesRead,
      anchorLength - totalBytesRead,
      anchorStart + totalBytesRead,
    );
    if (bytesRead === 0) {
      return null;
    }
    totalBytesRead += bytesRead;
  }
  return buffer;
}

export async function createHistoryCursor(params: {
  handle: fs.promises.FileHandle;
  fileSize: number;
  sessionId: string;
  fileToken: string;
  beforeOffset: number;
}): Promise<string> {
  const anchorStart = Math.max(0, params.beforeOffset - HISTORY_CURSOR_ANCHOR_SIDE_BYTES);
  const anchorEnd = Math.min(
    params.fileSize,
    params.beforeOffset + HISTORY_CURSOR_ANCHOR_SIDE_BYTES,
  );
  const anchorLength = anchorEnd - anchorStart;
  const bytes = await readCursorAnchorBytes(params.handle, anchorStart, anchorLength);
  if (!bytes) {
    throw new Error("session history changed while creating a pagination cursor");
  }
  return encodeHistoryCursor({
    v: HISTORY_CURSOR_VERSION,
    sessionId: params.sessionId,
    fileToken: params.fileToken,
    beforeOffset: params.beforeOffset,
    anchorStart,
    anchorLength,
    anchorHash: hashCursorAnchor({
      beforeOffset: params.beforeOffset,
      anchorStart,
      anchorLength,
      bytes,
    }),
  });
}

export async function matchesCursorAnchor(
  handle: fs.promises.FileHandle,
  cursor: HistoryCursorPayload,
): Promise<boolean> {
  const bytes = await readCursorAnchorBytes(handle, cursor.anchorStart, cursor.anchorLength);
  if (!bytes) {
    return false;
  }
  return (
    hashCursorAnchor({
      beforeOffset: cursor.beforeOffset,
      anchorStart: cursor.anchorStart,
      anchorLength: cursor.anchorLength,
      bytes,
    }) === cursor.anchorHash
  );
}
