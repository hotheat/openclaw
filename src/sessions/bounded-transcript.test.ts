import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedTranscriptScanLimitError,
  readRecentTranscriptRecords,
  scanBoundedTranscript,
  type BoundedTranscriptRecord,
} from "./bounded-transcript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function createTranscript(lines: string[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bounded-transcript-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

describe("scanBoundedTranscript", () => {
  it("decodes records across chunk boundaries in newest-first order", async () => {
    const filePath = await createTranscript([
      JSON.stringify({ id: "one", value: "x".repeat(32) }),
      JSON.stringify({ id: "two" }),
    ]);
    const handle = await fs.open(filePath, "r");
    const records: BoundedTranscriptRecord[] = [];

    try {
      const stat = await handle.stat();
      const result = await scanBoundedTranscript({
        handle,
        endOffset: stat.size,
        maxRecords: 10,
        chunkSize: 5,
        visit: (record) => {
          records.push(record);
        },
      });

      expect(records).toMatchObject([
        { kind: "decoded", value: { id: "two" } },
        { kind: "decoded", value: { id: "one", value: "x".repeat(32) } },
      ]);
      expect(result.readChunks).toBeGreaterThan(1);
      expect(result.scannedRecords).toBe(2);
    } finally {
      await handle.close();
    }
  });

  it("classifies malformed and oversized records inside the shared module", async () => {
    const filePath = await createTranscript([
      "{bad-json",
      JSON.stringify({ value: "x".repeat(64) }),
    ]);
    const handle = await fs.open(filePath, "r");
    const records: BoundedTranscriptRecord[] = [];

    try {
      const stat = await handle.stat();
      const result = await scanBoundedTranscript({
        handle,
        endOffset: stat.size,
        maxRecords: 10,
        maxLineBytes: 16,
        visit: (record) => {
          records.push(record);
        },
      });

      expect(records.map((record) => record.kind)).toEqual(["oversized", "malformed"]);
      expect(result.malformedRecords).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("returns a continuation offset when the raw-record budget is exhausted", async () => {
    const filePath = await createTranscript([
      JSON.stringify({ id: "one" }),
      JSON.stringify({ id: "two" }),
      JSON.stringify({ id: "three" }),
    ]);
    const handle = await fs.open(filePath, "r");

    try {
      const stat = await handle.stat();
      const result = await scanBoundedTranscript({
        handle,
        endOffset: stat.size,
        maxRecords: 2,
        visit: () => undefined,
      });

      expect(result.scannedRecords).toBe(2);
      expect(result.continuationOffset).toBeTypeOf("number");
    } finally {
      await handle.close();
    }
  });

  it("fails when the scan budget cannot reach a complete line", async () => {
    const filePath = await createTranscript([JSON.stringify({ value: "x".repeat(1024) })]);
    const handle = await fs.open(filePath, "r");

    try {
      const stat = await handle.stat();
      await expect(
        scanBoundedTranscript({
          handle,
          endOffset: stat.size,
          maxRecords: 10,
          chunkSize: 16,
          maxLineBytes: 2048,
          maxScanBytes: 64,
          visit: () => undefined,
        }),
      ).rejects.toBeInstanceOf(BoundedTranscriptScanLimitError);
    } finally {
      await handle.close();
    }
  });
});

describe("readRecentTranscriptRecords", () => {
  it("returns recent decoded records in source order", async () => {
    const filePath = await createTranscript([
      JSON.stringify({ id: "old" }),
      JSON.stringify({ id: "middle" }),
      JSON.stringify({ id: "new" }),
    ]);

    await expect(readRecentTranscriptRecords(filePath, 2, 5)).resolves.toEqual([
      { id: "middle" },
      { id: "new" },
    ]);
  });

  it("counts malformed lines toward the bounded recent-record window", async () => {
    const filePath = await createTranscript([
      JSON.stringify({ id: "old" }),
      "{malformed-one",
      "{malformed-two",
    ]);

    await expect(readRecentTranscriptRecords(filePath, 2, 8)).resolves.toEqual([]);
  });
});
