import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import {
  createBaseWebFetchToolConfig,
  installWebFetchSsrfHarness,
} from "./web-fetch.test-harness.js";
import { createWebFetchTool } from "./web-tools.js";

const extractPdfTextFromBufferMock = vi.fn();

vi.mock("../../media/pdf-text.js", () => ({
  extractPdfTextFromBuffer: (...args: unknown[]) => extractPdfTextFromBufferMock(...args),
}));

installWebFetchSsrfHarness();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if ("url" in input && typeof input.url === "string") {
    return input.url;
  }
  return "";
}

function requestBodyJson(mockFetch: ReturnType<typeof installMockFetch>, callIndex: number) {
  const request = mockFetch.mock.calls[callIndex]?.[1];
  const requestBody = request?.body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const mockFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => await impl(input, init),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function pdfResponse(body = "%PDF-1.7 mock") {
  return new Response(Buffer.from(body), {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

function scrapeResponse(
  markdown: string,
  url = "https://example.com/report.pdf",
  httpStatus = 200,
) {
  return new Response(
    JSON.stringify({
      status: "success",
      content: markdown,
      url,
      http_status: httpStatus,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  extractPdfTextFromBufferMock.mockReset();
});

describe("web_fetch pdf handling", () => {
  it("extracts PDF text with pdfjs when enough text is available", async () => {
    const mockFetch = installMockFetch(async () => pdfResponse());
    extractPdfTextFromBufferMock.mockResolvedValue({
      text: "Quarterly report ".repeat(20),
      pageCount: 2,
      totalPages: 2,
    });

    const tool = createWebFetchTool(createBaseWebFetchToolConfig());
    const result = await tool?.execute?.("call", { url: "https://example.com/report.pdf" });
    const details = result?.details as {
      contentType?: string;
      extractor?: string;
      text?: string;
    };

    expect(details.extractor).toBe("pdfjs");
    expect(details.contentType).toBe("application/pdf");
    expect(details.text).toContain("Quarterly report");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to scraping-server when PDF text is too short", async () => {
    vi.stubEnv("SCRAPE_API_BASE_URL", "http://scrape.internal:8011");
    const mockFetch = installMockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.includes("scrape.internal")) {
        return scrapeResponse("# scraped pdf\n\nRecovered PDF text");
      }
      return pdfResponse();
    });
    extractPdfTextFromBufferMock.mockResolvedValue({
      text: "short",
      pageCount: 1,
      totalPages: 10,
    });

    const tool = createWebFetchTool(createBaseWebFetchToolConfig());
    const result = await tool?.execute?.("call", { url: "https://example.com/report.pdf" });
    const details = result?.details as { extractor?: string; text?: string };

    expect(details.extractor).toBe("scraping-get");
    expect(details.text).toContain("Recovered PDF text");
    expect(requestBodyJson(mockFetch, 1)).toMatchObject({
      url: "https://example.com/report.pdf",
      mode: "get",
      output: "markdown",
    });
  });

  it("falls back to scraping-server when pdfjs extraction fails", async () => {
    vi.stubEnv("SCRAPE_API_BASE_URL", "http://scrape.internal:8011");
    installMockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.includes("scrape.internal")) {
        return scrapeResponse("# scraped pdf\n\nRecovered after parse failure");
      }
      return pdfResponse();
    });
    extractPdfTextFromBufferMock.mockRejectedValue(new Error("corrupt pdf"));

    const tool = createWebFetchTool(createBaseWebFetchToolConfig());
    const result = await tool?.execute?.("call", { url: "https://example.com/broken.pdf" });
    const details = result?.details as { extractor?: string; text?: string };

    expect(details.extractor).toBe("scraping-get");
    expect(details.text).toContain("Recovered after parse failure");
  });

  it("throws a clear error when PDF extraction and scraping fallback both fail", async () => {
    installMockFetch(async () => pdfResponse());
    extractPdfTextFromBufferMock.mockRejectedValue(new Error("corrupt pdf"));

    const tool = createWebFetchTool(createBaseWebFetchToolConfig());

    await expect(
      tool?.execute?.("call", { url: "https://example.com/broken.pdf" }),
    ).rejects.toThrow("PDF extraction failed: corrupt pdf");
  });
});
