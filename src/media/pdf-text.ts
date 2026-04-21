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
}): Promise<{
  pageCount: number;
  text: string;
  totalPages: number;
}> {
  const { getDocument } = await loadPdfJsModule();
  const pdf = await getDocument({
    data: new Uint8Array(params.buffer),
    disableWorker: true,
  }).promise;
  const pageCount = Math.max(1, Math.min(pdf.numPages, Math.floor(params.maxPages)));
  const textParts: string[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
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
}
