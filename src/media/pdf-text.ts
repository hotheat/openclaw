type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

export async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      pdfJsModulePromise = null;
      throw new Error(
        `Optional dependency pdfjs-dist is required for PDF extraction: ${String(err)}`,
      );
    });
  }
  return pdfJsModulePromise;
}

export async function extractPdfTextFromBuffer(params: {
  buffer: Buffer;
  maxPages: number;
  signal?: AbortSignal;
}): Promise<{
  pageCount: number;
  text: string;
  totalPages: number;
}> {
  params.signal?.throwIfAborted();
  const { getDocument } = await loadPdfJsModule();
  params.signal?.throwIfAborted();
  const loadingTask = getDocument({
    data: new Uint8Array(params.buffer),
    disableWorker: true,
  });
  let destroyPromise: Promise<void> | undefined;
  const destroyLoadingTask = () =>
    (destroyPromise ??= Promise.resolve().then(() => loadingTask.destroy()));
  const onAbort = () => {
    void destroyLoadingTask().catch(() => {});
  };
  if (params.signal?.aborted) {
    onAbort();
  } else {
    params.signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    params.signal?.throwIfAborted();
    const pdf = await loadingTask.promise;
    params.signal?.throwIfAborted();
    const pageCount = Math.max(1, Math.min(pdf.numPages, Math.floor(params.maxPages)));
    const textParts: string[] = [];

    for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
      params.signal?.throwIfAborted();
      const page = await pdf.getPage(pageNum);
      params.signal?.throwIfAborted();
      const textContent = await page.getTextContent();
      params.signal?.throwIfAborted();
      const pageText = textContent.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .filter(Boolean)
        .join(" ");
      if (pageText) {
        textParts.push(pageText);
      }
    }

    return {
      pageCount,
      text: textParts.join("\n\n"),
      totalPages: pdf.numPages,
    };
  } catch (error) {
    params.signal?.throwIfAborted();
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    await destroyLoadingTask().catch(() => {});
  }
}
