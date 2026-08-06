import { afterEach, describe, expect, it, vi } from "vitest";

const getDocumentMock = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: getDocumentMock,
}));

import { extractPdfTextFromBuffer } from "./pdf-text.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  getDocumentMock.mockReset();
  vi.restoreAllMocks();
});

describe("extractPdfTextFromBuffer", () => {
  it("destroys the loading task after successful extraction", async () => {
    const destroy = vi.fn(async () => {});
    const getPage = vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({ items: [{ str: "page text" }] })),
    }));
    getDocumentMock.mockReturnValue({
      destroy,
      promise: Promise.resolve({ getPage, numPages: 1 }),
    });

    await expect(
      extractPdfTextFromBuffer({ buffer: Buffer.from("pdf"), maxPages: 12 }),
    ).resolves.toEqual({
      pageCount: 1,
      text: "page text",
      totalPages: 1,
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the loading task after extraction fails", async () => {
    const destroy = vi.fn(async () => {});
    const failure = new Error("invalid pdf");
    getDocumentMock.mockReturnValue({
      destroy,
      promise: Promise.reject(failure),
    });

    await expect(
      extractPdfTextFromBuffer({ buffer: Buffer.from("pdf"), maxPages: 12 }),
    ).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys once on abort and does not continue to the next page", async () => {
    const textContent = deferred<{ items: Array<{ str: string }> }>();
    const textStarted = deferred<void>();
    const cancellation = new Error("cancelled");
    const destroy = vi.fn(async () => {
      textContent.reject(new Error("worker destroyed"));
    });
    const getPage = vi.fn(async () => ({
      getTextContent: vi.fn(() => {
        textStarted.resolve();
        return textContent.promise;
      }),
    }));
    getDocumentMock.mockReturnValue({
      destroy,
      promise: Promise.resolve({ getPage, numPages: 2 }),
    });
    const controller = new AbortController();
    const extraction = extractPdfTextFromBuffer({
      buffer: Buffer.from("pdf"),
      maxPages: 12,
      signal: controller.signal,
    });

    await textStarted.promise;
    controller.abort(cancellation);

    await expect(extraction).rejects.toBe(cancellation);
    expect(destroy).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledWith(1);
  });
});
