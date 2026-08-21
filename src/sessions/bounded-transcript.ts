import fs from "node:fs";

const DEFAULT_REVERSE_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_SCAN_BYTES = 32 * 1024 * 1024;

type ReverseLine = {
  bytes?: Buffer;
  startOffset: number;
  endOffset: number;
  oversized: boolean;
};

export type BoundedTranscriptRecord =
  | {
      kind: "decoded";
      value: unknown;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "malformed";
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "oversized";
      startOffset: number;
      endOffset: number;
    };

export type BoundedTranscriptScanResult = {
  scannedBytes: number;
  readChunks: number;
  scannedRecords: number;
  malformedRecords: number;
  continuationOffset?: number;
};

export class BoundedTranscriptScanLimitError extends Error {
  constructor() {
    super("transcript record exceeds the scan budget");
    this.name = "BoundedTranscriptScanLimitError";
  }
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

async function* readJsonlLinesBackward(params: {
  handle: fs.promises.FileHandle;
  endOffset: number;
  chunkSize: number;
  maxLineBytes: number;
  maxScanBytes: number;
  stats: { scannedBytes: number; readChunks: number };
}): AsyncGenerator<ReverseLine> {
  let position = params.endOffset;
  let currentLineEnd = params.endOffset;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let lineOversized = false;
  const lastByte = position > 0 ? await readByteAt(params.handle, position - 1) : null;
  let skipIncompleteTail = position > 0 && lastByte !== 0x0a;

  while (position > 0) {
    const remainingBudget = params.maxScanBytes - params.stats.scannedBytes;
    if (remainingBudget <= 0) {
      throw new BoundedTranscriptScanLimitError();
    }
    const readStart = Math.max(0, position - Math.min(params.chunkSize, remainingBudget));
    const requested = position - readStart;
    const buffer = Buffer.allocUnsafe(requested);
    const bytesRead = await readBufferAt(params.handle, buffer, readStart);
    if (bytesRead !== requested) {
      throw new Error("transcript changed while scanning records");
    }
    params.stats.scannedBytes += bytesRead;
    params.stats.readChunks += 1;
    const chunk = buffer.subarray(0, bytesRead);
    let segmentEnd = chunk.length;

    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      const lineStart = readStart + index + 1;
      const segment = chunk.subarray(index + 1, segmentEnd);
      const lineBytes = segment.length + fragmentBytes;
      const oversized = lineOversized || lineBytes > params.maxLineBytes;
      const bytes = oversized ? undefined : Buffer.concat([segment, ...fragments], lineBytes);
      const line: ReverseLine = {
        bytes,
        startOffset: lineStart,
        endOffset: currentLineEnd,
        oversized,
      };
      currentLineEnd = readStart + index;
      fragments = [];
      fragmentBytes = 0;
      lineOversized = false;
      segmentEnd = index;
      if (skipIncompleteTail) {
        skipIncompleteTail = false;
      } else if (lineBytes > 0 || oversized) {
        yield line;
      }
    }

    if (segmentEnd > 0) {
      if (lineOversized || fragmentBytes + segmentEnd > params.maxLineBytes) {
        fragments = [];
        fragmentBytes = 0;
        lineOversized = true;
      } else {
        fragments.unshift(chunk.subarray(0, segmentEnd));
        fragmentBytes += segmentEnd;
      }
    }
    position = readStart;
  }

  if ((fragments.length > 0 || lineOversized) && !skipIncompleteTail) {
    yield {
      bytes: lineOversized ? undefined : Buffer.concat(fragments, fragmentBytes),
      startOffset: 0,
      endOffset: currentLineEnd,
      oversized: lineOversized,
    };
  }
}

function decodeTranscriptLine(line: ReverseLine): BoundedTranscriptRecord {
  if (line.oversized || !line.bytes) {
    return {
      kind: "oversized",
      startOffset: line.startOffset,
      endOffset: line.endOffset,
    };
  }
  try {
    const bytes = line.bytes.at(-1) === 0x0d ? line.bytes.subarray(0, -1) : line.bytes;
    return {
      kind: "decoded",
      value: JSON.parse(bytes.toString("utf8")),
      startOffset: line.startOffset,
      endOffset: line.endOffset,
    };
  } catch {
    return {
      kind: "malformed",
      startOffset: line.startOffset,
      endOffset: line.endOffset,
    };
  }
}

export async function scanBoundedTranscript(params: {
  handle: fs.promises.FileHandle;
  endOffset: number;
  maxRecords: number;
  chunkSize?: number;
  maxLineBytes?: number;
  maxScanBytes?: number;
  visit: (record: BoundedTranscriptRecord) => boolean | void;
}): Promise<BoundedTranscriptScanResult> {
  const stats = { scannedBytes: 0, readChunks: 0 };
  const maxRecords = Math.max(0, params.maxRecords);
  let scannedRecords = 0;
  let malformedRecords = 0;
  if (maxRecords === 0) {
    return { ...stats, scannedRecords, malformedRecords };
  }

  const maxScanBytes = Math.max(1, params.maxScanBytes ?? DEFAULT_MAX_TRANSCRIPT_SCAN_BYTES);
  for await (const line of readJsonlLinesBackward({
    handle: params.handle,
    endOffset: params.endOffset,
    chunkSize: Math.max(1, params.chunkSize ?? DEFAULT_REVERSE_READ_CHUNK_BYTES),
    maxLineBytes: Math.max(1, params.maxLineBytes ?? DEFAULT_MAX_TRANSCRIPT_LINE_BYTES),
    maxScanBytes,
    stats,
  })) {
    const record = decodeTranscriptLine(line);
    scannedRecords += 1;
    malformedRecords += record.kind === "malformed" ? 1 : 0;
    if (params.visit(record) === false) {
      break;
    }
    if (
      record.startOffset > 0 &&
      (scannedRecords >= maxRecords || stats.scannedBytes >= maxScanBytes)
    ) {
      return {
        ...stats,
        scannedRecords,
        malformedRecords,
        continuationOffset: record.startOffset,
      };
    }
  }
  return { ...stats, scannedRecords, malformedRecords };
}

export async function readRecentTranscriptRecords(
  sessionFile: string,
  maxRecords = 100,
  chunkSize = DEFAULT_REVERSE_READ_CHUNK_BYTES,
): Promise<unknown[]> {
  if (maxRecords <= 0) {
    return [];
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(sessionFile, "r");
  } catch {
    return [];
  }
  try {
    const stat = await handle.stat();
    const newestFirst: unknown[] = [];
    await scanBoundedTranscript({
      handle,
      endOffset: stat.size,
      maxRecords,
      chunkSize,
      visit: (record) => {
        if (record.kind === "decoded") {
          newestFirst.push(record.value);
        }
      },
    });
    return newestFirst.toReversed();
  } finally {
    await handle.close();
  }
}
