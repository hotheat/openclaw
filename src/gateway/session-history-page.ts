import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  scanBoundedTranscript,
  type BoundedTranscriptRecord,
} from "../sessions/bounded-transcript.js";
import { normalizeWebchatAttachmentRefs } from "../sessions/webchat-attachment-refs.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { scanLeadingInboundMediaPrompt, stripEnvelopeFromMessages } from "./chat-sanitize.js";
import type { ChatHistoryResult } from "./protocol/schema/types.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import {
  createHistoryCursor,
  decodeHistoryCursor,
  matchesCursorAnchor,
} from "./session-history-cursor.js";
import { capArrayByJsonBytes, resolveSessionTranscriptCandidates } from "./session-utils.fs.js";

export {
  assertValidSessionHistoryCursor,
  InvalidHistoryCursorError,
} from "./session-history-cursor.js";

const MAX_TRANSCRIPT_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_HISTORY_RAW_RECORDS = 10_000;
const OVERSIZED_TRANSCRIPT_RECORD_PLACEHOLDER =
  "[chat.history omitted: transcript record too large]";
const CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_ATTACHMENTS_PER_MESSAGE = 16;
const CHAT_HISTORY_ATTACHMENTS_PER_RESPONSE = 256;
const HISTORY_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const WEBCHAT_INPUT_ARTIFACT_PATH_RE =
  /[\\/]uploads[\\/]webchat[\\/][^\\/\s\]|]+[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([^\s\]|]+)(?:\s+\(([^)]+)\))?/gi;

export type HistoryPageRecord = {
  historyEntryId: string;
  startOffset: number;
  endOffset: number;
  message: unknown;
};

type HistoryCursorContext = {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  fileToken: string;
  fileSize: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type SessionHistoryPage = {
  records: HistoryPageRecord[];
  hasMore: boolean;
  cursorReset: boolean;
  paginationSupported: boolean;
  scannedBytes: number;
  readChunks: number;
  malformedLines: number;
  fileSize: number;
  nextOffset?: number;
  cursorContext?: HistoryCursorContext;
};

export type LoadedSessionHistoryPage = {
  messages: ChatHistoryResult["messages"];
  nextBefore?: string;
  hasMore: boolean;
  cursorReset: boolean;
  diagnostics: {
    scannedBytes: number;
    readChunks: number;
    malformedLines: number;
    responseBytes: number;
    placeholderCount: number;
    structuredRefMessages: number;
    markerFallbackMessages: number;
  };
};

export class SessionHistoryResponseBudgetError extends Error {
  constructor() {
    super("chat history response exceeded the response budget");
    this.name = "SessionHistoryResponseBudgetError";
  }
}

function truncateChatHistoryText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHAT_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
    truncated: true,
  };
}

function sanitizeChatHistoryContentBlock(block: unknown): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateChatHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string") {
    const res = truncateChatHistoryText(entry.arguments);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeChatHistoryMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    changed = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const res = truncateChatHistoryText(stripped.text);
    entry.content = res.text;
    changed ||= stripped.changed || res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block));
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }

  return { message: changed ? entry : message, changed };
}

function sanitizeChatHistoryMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const res = sanitizeChatHistoryMessage(message);
    changed ||= res.changed;
    return res.message;
  });
  return changed ? next : messages;
}

type ChatHistoryAttachmentRef = {
  attachmentId: string;
  ordinal: number;
};

function extractChatHistoryMarkerAttachmentRefs(text: string): ChatHistoryAttachmentRef[] {
  const refs: ChatHistoryAttachmentRef[] = [];
  const seen = new Set<string>();
  const { mediaLines } = scanLeadingInboundMediaPrompt(text);
  WEBCHAT_INPUT_ARTIFACT_PATH_RE.lastIndex = 0;
  for (const match of mediaLines.join("\n").matchAll(WEBCHAT_INPUT_ARTIFACT_PATH_RE)) {
    const attachmentId = match[1];
    if (!attachmentId || seen.has(attachmentId)) {
      continue;
    }
    seen.add(attachmentId);
    refs.push({ attachmentId, ordinal: refs.length });
    if (refs.length >= CHAT_HISTORY_ATTACHMENTS_PER_MESSAGE) {
      break;
    }
  }
  return refs;
}

function extractMessageMarkerAttachmentRefs(message: Record<string, unknown>) {
  const texts: string[] = [];
  if (typeof message.content === "string") {
    texts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        texts.push((block as { text: string }).text);
      }
    }
  } else if (typeof message.text === "string") {
    texts.push(message.text);
  }
  const seen = new Set<string>();
  return texts
    .flatMap((text) => extractChatHistoryMarkerAttachmentRefs(text))
    .filter((ref) => {
      if (seen.has(ref.attachmentId)) {
        return false;
      }
      seen.add(ref.attachmentId);
      return true;
    })
    .slice(0, CHAT_HISTORY_ATTACHMENTS_PER_MESSAGE)
    .map((ref, ordinal) => ({ ...ref, ordinal }));
}

function rebuildChatHistoryAttachmentReferences(messages: unknown[]): {
  messages: unknown[];
  structuredRefMessages: number;
  markerFallbackMessages: number;
} {
  let structuredRefMessages = 0;
  let markerFallbackMessages = 0;
  const responseAttachmentIds = new Set<string>();
  const rebuiltMessages = messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const source = message as Record<string, unknown>;
    const entry = { ...source };
    delete entry.attachments;
    delete entry.__openclaw;
    if (typeof source.role !== "string" || source.role.toLowerCase() !== "user") {
      const privateValue = source.__openclaw;
      if (
        privateValue &&
        typeof privateValue === "object" &&
        (privateValue as Record<string, unknown>).kind === "compaction" &&
        typeof (privateValue as Record<string, unknown>).id === "string"
      ) {
        entry.__openclaw = {
          kind: "compaction",
          id: (privateValue as Record<string, unknown>).id,
        };
      }
      return entry;
    }
    const privateValue = source.__openclaw;
    const structuredRefs =
      privateValue && typeof privateValue === "object"
        ? normalizeWebchatAttachmentRefs(
            (privateValue as Record<string, unknown>).attachments,
          )?.slice(0, CHAT_HISTORY_ATTACHMENTS_PER_MESSAGE)
        : undefined;
    let refs = structuredRefs;
    if (refs) {
      structuredRefMessages += 1;
    } else {
      refs = extractMessageMarkerAttachmentRefs(source);
      if (refs.length > 0) {
        markerFallbackMessages += 1;
      }
    }
    if (!refs || refs.length === 0) {
      return entry;
    }
    const boundedRefs = refs.filter((ref) => {
      if (responseAttachmentIds.has(ref.attachmentId)) {
        return true;
      }
      if (responseAttachmentIds.size >= CHAT_HISTORY_ATTACHMENTS_PER_RESPONSE) {
        return false;
      }
      responseAttachmentIds.add(ref.attachmentId);
      return true;
    });
    if (boundedRefs.length === 0) {
      return entry;
    }
    return { ...entry, __openclaw: { attachments: boundedRefs } };
  });
  return { messages: rebuiltMessages, structuredRefMessages, markerFallbackMessages };
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function parseHistoryTimestampString(timestamp: unknown): number | undefined {
  if (typeof timestamp !== "string") {
    return undefined;
  }
  const match = HISTORY_TIMESTAMP_RE.exec(timestamp);
  if (!match) {
    return undefined;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = resolveDaysInMonth(year, month);
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isValidIsoTimezone(timezone)
  ) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeHistoryTimestamp(
  message: unknown,
  recordTimestamp?: unknown,
): number | undefined {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const timestamp = (message as Record<string, unknown>).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp;
    }
    const parsedTimestamp = parseHistoryTimestampString(timestamp);
    if (parsedTimestamp !== undefined) {
      return parsedTimestamp;
    }
  }
  return parseHistoryTimestampString(recordTimestamp);
}

function resolveDaysInMonth(year: number, month: number): number | undefined {
  if (month < 1 || month > 12) {
    return undefined;
  }
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidIsoTimezone(timezone: string): boolean {
  if (timezone === "Z") {
    return true;
  }
  const [hourText, minuteText] = timezone.slice(1).split(":");
  return Number(hourText) <= 23 && Number(minuteText) <= 59;
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const source =
    message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
  const role = source && typeof source.role === "string" ? source.role : "assistant";
  const timestamp = normalizeHistoryTimestamp(message);
  const metadata = Object.fromEntries(
    ["historyEntryId", "provider", "model"].flatMap((key) =>
      source && typeof source[key] === "string" ? [[key, source[key]]] : [],
    ),
  );
  return {
    role,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...metadata,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: { truncated: true, reason: "oversized" },
  };
}

function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

function applyHistoryMessagesToRecords(
  records: HistoryPageRecord[],
  messages: unknown[],
): HistoryPageRecord[] {
  if (messages.length === 0) {
    return [];
  }
  const retainedRecords = records.slice(-messages.length);
  return retainedRecords.map((record, index) => ({ ...record, message: messages[index] }));
}

function emptySessionHistoryPage(cursorReset: boolean): SessionHistoryPage {
  return {
    records: [],
    hasMore: false,
    cursorReset,
    paginationSupported: false,
    scannedBytes: 0,
    readChunks: 0,
    malformedLines: 0,
    fileSize: 0,
  };
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function isMissingPathError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function transcriptOpenError(error: unknown): Error {
  const code = errnoCode(error);
  return new Error(code ? `session history open failed: ${code}` : "session history open failed", {
    cause: error,
  });
}

function createFileToken(filePath: string, stat: fs.Stats): string {
  return createHash("sha256")
    .update(path.resolve(filePath))
    .update("\0")
    .update(String(stat.dev))
    .update("\0")
    .update(String(stat.ino))
    .digest("base64url")
    .slice(0, 22);
}

async function openActiveTranscript(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): Promise<{ filePath: string; handle: fs.promises.FileHandle } | null> {
  const candidates = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  );
  for (const candidate of candidates) {
    try {
      return { filePath: candidate, handle: await fs.promises.open(candidate, "r") };
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw transcriptOpenError(error);
      }
    }
  }
  return null;
}

async function readByteAt(handle: fs.promises.FileHandle, offset: number): Promise<number | null> {
  if (offset < 0) {
    return null;
  }
  const buffer = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(buffer, 0, 1, offset);
  return bytesRead === 1 ? buffer[0] : null;
}

async function readBufferAt(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
): Promise<number> {
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      position + totalBytesRead,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }
  return totalBytesRead;
}

async function isV3Transcript(handle: fs.promises.FileHandle, fileSize: number): Promise<boolean> {
  if (fileSize === 0) {
    return false;
  }
  const readSize = Math.min(fileSize, MAX_TRANSCRIPT_HEADER_BYTES);
  const buffer = Buffer.allocUnsafe(readSize);
  const bytesRead = await readBufferAt(handle, buffer, 0);
  const chunk = buffer.subarray(0, bytesRead);
  const newline = chunk.indexOf(0x0a);
  if (newline < 0 && fileSize > readSize) {
    return false;
  }
  const headerBytes = newline >= 0 ? chunk.subarray(0, newline) : chunk;
  const normalized =
    headerBytes.at(-1) === 0x0d ? headerBytes.subarray(0, headerBytes.length - 1) : headerBytes;
  try {
    const header = JSON.parse(normalized.toString("utf8")) as Record<string, unknown>;
    return header.type === "session" && header.version === 3;
  } catch {
    return false;
  }
}

function resolveHistoryEntryId(record: Record<string, unknown>, startOffset: number): string {
  return typeof record.id === "string" && record.id.length > 0 ? record.id : `off-${startOffset}`;
}

function attachHistoryMetadata(
  message: unknown,
  historyEntryId: string,
  recordTimestamp?: unknown,
): unknown {
  const timestamp = normalizeHistoryTimestamp(message, recordTimestamp);
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const entry: Record<string, unknown> = {
      ...(message as Record<string, unknown>),
      historyEntryId,
    };
    if (timestamp === undefined) {
      delete entry.timestamp;
      return entry;
    }
    return {
      ...entry,
      timestamp,
    };
  }
  return {
    role: "system",
    content: [{ type: "text", text: String(message) }],
    historyEntryId,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function toHistoryPageRecord(
  line: Extract<BoundedTranscriptRecord, { kind: "decoded" }>,
): HistoryPageRecord | null {
  const parsed = line.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const historyEntryId = resolveHistoryEntryId(record, line.startOffset);
  if (record.message) {
    return {
      historyEntryId,
      startOffset: line.startOffset,
      endOffset: line.endOffset,
      message: attachHistoryMetadata(record.message, historyEntryId, record.timestamp),
    };
  }
  if (record.type !== "compaction") {
    return null;
  }
  const timestamp = normalizeHistoryTimestamp(undefined, record.timestamp);
  return {
    historyEntryId,
    startOffset: line.startOffset,
    endOffset: line.endOffset,
    message: {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      ...(timestamp === undefined ? {} : { timestamp }),
      historyEntryId,
      __openclaw: { kind: "compaction", id: historyEntryId },
    },
  };
}

function oversizedHistoryPageRecord(
  line: Extract<BoundedTranscriptRecord, { kind: "oversized" }>,
): HistoryPageRecord {
  const historyEntryId = `off-${line.startOffset}`;
  return {
    historyEntryId,
    startOffset: line.startOffset,
    endOffset: line.endOffset,
    message: {
      role: "assistant",
      content: [{ type: "text", text: OVERSIZED_TRANSCRIPT_RECORD_PLACEHOLDER }],
      historyEntryId,
      __openclaw: { truncated: true, reason: "oversized-transcript-record" },
    },
  };
}

async function isLineBoundary(handle: fs.promises.FileHandle, offset: number): Promise<boolean> {
  return offset === 0 || (await readByteAt(handle, offset - 1)) === 0x0a;
}

export async function readSessionHistoryPage(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  before?: string;
  limit: number;
  chunkSize?: number;
  maxLineBytes?: number;
  maxScanBytes?: number;
  maxRawRecords?: number;
}): Promise<SessionHistoryPage> {
  const decodedCursor = params.before ? decodeHistoryCursor(params.before) : undefined;
  const opened = await openActiveTranscript(params);
  if (!opened) {
    return {
      records: [],
      hasMore: false,
      cursorReset: Boolean(params.before),
      paginationSupported: false,
      scannedBytes: 0,
      readChunks: 0,
      malformedLines: 0,
      fileSize: 0,
    };
  }

  try {
    const stat = await opened.handle.stat();
    const fileSize = stat.size;
    const fileToken = createFileToken(opened.filePath, stat);
    const v3 = await isV3Transcript(opened.handle, fileSize);
    let cursorReset = !v3;
    let endOffset = fileSize;

    if (decodedCursor && v3) {
      const matchesFile =
        decodedCursor.sessionId === params.sessionId &&
        decodedCursor.fileToken === fileToken &&
        decodedCursor.beforeOffset <= fileSize &&
        decodedCursor.anchorStart + decodedCursor.anchorLength <= fileSize &&
        (await isLineBoundary(opened.handle, decodedCursor.beforeOffset)) &&
        (await matchesCursorAnchor(opened.handle, decodedCursor));
      if (matchesFile) {
        endOffset = decodedCursor.beforeOffset;
      } else {
        cursorReset = true;
      }
    }

    const newestFirst: HistoryPageRecord[] = [];
    const maxRawRecords = Math.max(1, params.maxRawRecords ?? DEFAULT_MAX_HISTORY_RAW_RECORDS);
    const scan = await scanBoundedTranscript({
      handle: opened.handle,
      endOffset,
      maxRecords: maxRawRecords,
      chunkSize: params.chunkSize,
      maxLineBytes: params.maxLineBytes,
      maxScanBytes: params.maxScanBytes,
      visit: (line) => {
        if (line.kind === "oversized") {
          newestFirst.push(oversizedHistoryPageRecord(line));
        } else if (line.kind === "decoded") {
          const record = toHistoryPageRecord(line);
          if (record) {
            newestFirst.push(record);
          }
        }
        return newestFirst.length <= params.limit;
      },
    });

    const canPaginate = v3;
    const hasLookahead = newestFirst.length > params.limit;
    const records = newestFirst.slice(0, params.limit).toReversed();
    const nextOffset = canPaginate
      ? hasLookahead
        ? records[0]?.startOffset
        : scan.continuationOffset
      : undefined;
    const hasMore = nextOffset !== undefined;
    return {
      records,
      hasMore,
      cursorReset,
      paginationSupported: canPaginate,
      scannedBytes: scan.scannedBytes,
      readChunks: scan.readChunks,
      malformedLines: scan.malformedRecords,
      fileSize,
      nextOffset,
      cursorContext: canPaginate
        ? {
            sessionId: params.sessionId,
            storePath: params.storePath,
            sessionFile: params.sessionFile,
            agentId: params.agentId,
            fileToken,
            fileSize,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          }
        : undefined,
    };
  } finally {
    await opened.handle.close();
  }
}

export async function createSessionHistoryPageCursor(
  page: SessionHistoryPage,
  beforeOffset: number,
): Promise<string | undefined> {
  const context = page.cursorContext;
  if (!page.paginationSupported || !context) {
    return undefined;
  }
  const opened = await openActiveTranscript(context);
  if (!opened) {
    throw new Error("session history cursor source is unavailable");
  }
  try {
    const stat = await opened.handle.stat();
    const fileToken = createFileToken(opened.filePath, stat);
    if (
      fileToken !== context.fileToken ||
      stat.size !== context.fileSize ||
      stat.mtimeMs !== context.mtimeMs ||
      stat.ctimeMs !== context.ctimeMs ||
      beforeOffset > stat.size ||
      !(await isLineBoundary(opened.handle, beforeOffset))
    ) {
      throw new Error("session history changed before creating the pagination cursor");
    }
    const cursor = await createHistoryCursor({
      handle: opened.handle,
      fileSize: stat.size,
      sessionId: context.sessionId,
      fileToken,
      beforeOffset,
    });
    const finalStat = await opened.handle.stat();
    if (
      finalStat.dev !== stat.dev ||
      finalStat.ino !== stat.ino ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error("session history changed while creating the pagination cursor");
    }
    return cursor;
  } finally {
    await opened.handle.close();
  }
}

export async function loadSessionHistoryPage(params: {
  sessionId?: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  before?: string;
  limit: number;
}): Promise<LoadedSessionHistoryPage> {
  if (params.before) {
    decodeHistoryCursor(params.before);
  }
  const page = params.sessionId
    ? await readSessionHistoryPage({
        sessionId: params.sessionId,
        storePath: params.storePath,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        before: params.before,
        limit: params.limit,
      })
    : emptySessionHistoryPage(Boolean(params.before));

  let workingRecords = page.records;
  const rebuilt = rebuildChatHistoryAttachmentReferences(
    workingRecords.map((record) => record.message),
  );
  workingRecords = applyHistoryMessagesToRecords(workingRecords, rebuilt.messages);
  const withoutEnvelopes = stripEnvelopeFromMessages(
    workingRecords.map((record) => record.message),
  );
  workingRecords = applyHistoryMessagesToRecords(workingRecords, withoutEnvelopes);
  const sanitized = sanitizeChatHistoryMessages(workingRecords.map((record) => record.message));
  workingRecords = applyHistoryMessagesToRecords(workingRecords, sanitized);

  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: workingRecords.map((record) => record.message),
    maxSingleMessageBytes: perMessageHardCap,
  });
  workingRecords = applyHistoryMessagesToRecords(workingRecords, replaced.messages);
  const capped = capArrayByJsonBytes(
    workingRecords.map((record) => record.message),
    maxHistoryBytes,
  ).items;
  workingRecords = applyHistoryMessagesToRecords(workingRecords, capped);
  const bounded = enforceChatHistoryFinalBudget({
    messages: workingRecords.map((record) => record.message),
    maxBytes: maxHistoryBytes,
  });
  workingRecords = applyHistoryMessagesToRecords(workingRecords, bounded.messages);

  if (page.records.length > 0 && workingRecords.length === 0) {
    throw new SessionHistoryResponseBudgetError();
  }

  const earliestReturned = workingRecords[0];
  const droppedReadableRecords =
    Boolean(earliestReturned) && earliestReturned?.startOffset !== page.records[0]?.startOffset;
  const nextOffset = droppedReadableRecords ? earliestReturned?.startOffset : page.nextOffset;
  const hasMore = page.paginationSupported && nextOffset !== undefined;
  const nextBefore =
    hasMore && nextOffset !== undefined
      ? await createSessionHistoryPageCursor(page, nextOffset)
      : undefined;
  const messages = workingRecords.map((record) => record.message) as ChatHistoryResult["messages"];

  return {
    messages,
    nextBefore,
    hasMore,
    cursorReset: page.cursorReset,
    diagnostics: {
      scannedBytes: page.scannedBytes,
      readChunks: page.readChunks,
      malformedLines: page.malformedLines,
      responseBytes: jsonUtf8Bytes(messages),
      placeholderCount: replaced.replacedCount + bounded.placeholderCount,
      structuredRefMessages: rebuilt.structuredRefMessages,
      markerFallbackMessages: rebuilt.markerFallbackMessages,
    },
  };
}
