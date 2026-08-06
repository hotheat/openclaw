import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const extractPdfTextFromBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));
vi.mock("../../media/pdf-text.js", () => ({
  extractPdfTextFromBuffer: extractPdfTextFromBufferMock,
}));

import { createWebFetchTool } from "./web-tools.js";

function createFetchTool(fetchOverrides: Record<string, unknown> = {}) {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            ...fetchOverrides,
          },
        },
      },
    },
    sandboxed: false,
  });
}

function delayedValue<T>(value: T, delayMs: number): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), delayMs);
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "";
}

function response(params: {
  status: number;
  contentType?: string;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}): Response {
  return {
    ok: params.status >= 200 && params.status < 300,
    status: params.status,
    statusText: params.status === 402 ? "Payment Required" : "Forbidden",
    headers: new Headers({
      "content-type": params.contentType ?? "text/html; charset=utf-8",
    }),
    body: null,
    text: params.text ?? (async () => ""),
    json: params.json ?? (async () => ({})),
  } as Response;
}

describe("web_fetch shared deadline", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
    fetchWithSsrFGuardMock.mockReset();
    extractPdfTextFromBufferMock.mockReset();
    vi.restoreAllMocks();
  });

  it("hard-times out a stage when the underlying fetch ignores abort", async () => {
    fetchWithSsrFGuardMock.mockImplementation(() => new Promise(() => {}));
    const tool = createFetchTool({
      timeoutSeconds: 1,
      firecrawl: { enabled: false },
    });

    const resultPromise = tool?.execute?.("call", { url: "https://example.com/hang" });
    let settled = false;
    void resultPromise?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).rejects.toThrow(
      'Web fetch stage "direct-fetch" timed out after 1000ms.',
    );
  });

  it("releases a late direct response even when body cancellation hangs", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ url }: { url: string }) =>
        await delayedValue(
          {
            response: {
              ok: true,
              status: 200,
              statusText: "OK",
              headers: new Headers({ "content-type": "text/plain" }),
              body: { cancel },
              text: async () => "",
            } as unknown as Response,
            finalUrl: url,
            release,
          },
          2_000,
        ),
    );
    const tool = createFetchTool({
      timeoutSeconds: 1,
      firecrawl: { enabled: false },
    });
    const resultPromise = tool?.execute?.("call", {
      url: "https://example.com/late-response",
    });
    const rejection = expect(resultPromise).rejects.toThrow(
      'Web fetch stage "direct-fetch" timed out after 1000ms.',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps caller abort connected after direct response headers arrive", async () => {
    let directSignal: AbortSignal | undefined;
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ signal, url }: { signal: AbortSignal; url: string }) => {
        directSignal = signal;
        return {
          response: response({
            status: 200,
            contentType: "text/plain",
            text: () => new Promise(() => {}),
          }),
          finalUrl: url,
          release: vi.fn(async () => {}),
        };
      },
    );
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    const tool = createFetchTool({ firecrawl: { enabled: false } });
    const resultPromise = tool?.execute?.(
      "call",
      { url: "https://example.com/abort-body" },
      controller.signal,
    );
    const rejection = expect(resultPromise).rejects.toBe(cancellation);

    await vi.advanceTimersByTimeAsync(0);
    expect(directSignal?.aborted).toBe(false);

    controller.abort(cancellation);
    await rejection;
    expect(directSignal?.aborted).toBe(true);
    expect(directSignal?.reason).toBe(cancellation);
  });

  it("aborts the direct response and does not wait for hanging release", async () => {
    let directSignal: AbortSignal | undefined;
    const release = vi.fn(() => new Promise<void>(() => {}));
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ signal, url }: { signal: AbortSignal; url: string }) => {
        directSignal = signal;
        return {
          response: response({
            status: 200,
            contentType: "text/plain",
            text: () => new Promise(() => {}),
          }),
          finalUrl: url,
          release,
        };
      },
    );
    const tool = createFetchTool({
      timeoutSeconds: 1,
      firecrawl: { enabled: false },
    });
    const resultPromise = tool?.execute?.("call", {
      url: "https://example.com/hanging-body",
    });
    const rejection = expect(resultPromise).rejects.toThrow(
      'Web fetch stage "response-body" timed out after 1000ms.',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(directSignal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves non-Error caller abort reasons", async () => {
    fetchWithSsrFGuardMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const cancellation = { kind: "owner-cancel" };
    const tool = createFetchTool({ firecrawl: { enabled: false } });
    const resultPromise = tool?.execute?.(
      "call",
      { url: "https://example.com/object-abort" },
      controller.signal,
    );
    const rejection = expect(resultPromise).rejects.toBe(cancellation);

    controller.abort(cancellation);
    await rejection;
  });

  it("does not apply the 100 second default below a configured stage timeout", async () => {
    fetchWithSsrFGuardMock.mockImplementation(() => new Promise(() => {}));
    const tool = createFetchTool({
      timeoutSeconds: 120,
      firecrawl: { enabled: false },
    });
    const resultPromise = tool?.execute?.("call", { url: "https://example.com/slow" });
    let settled = false;
    void resultPromise?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);

    const rejection = expect(resultPromise).rejects.toThrow("Web fetch timed out after 120000ms.");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });

  it("uses the configured total timeout across the complete fetch attempt", async () => {
    fetchWithSsrFGuardMock.mockImplementation(() => new Promise(() => {}));
    const tool = createFetchTool({
      timeoutSeconds: 300,
      totalTimeoutSeconds: 120,
      firecrawl: { enabled: false },
    });
    const resultPromise = tool?.execute?.("call", {
      url: "https://example.com/configured-total-timeout",
    });
    let settled = false;
    void resultPromise?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);

    const rejection = expect(resultPromise).rejects.toThrow("Web fetch timed out after 120000ms.");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });

  it("aborts PDF extraction when its stage times out", async () => {
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => ({
      response: new Response(Buffer.from("%PDF-1.7 mock"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
      finalUrl: url,
      release: vi.fn(async () => {}),
    }));
    let extractionSignal: AbortSignal | undefined;
    extractPdfTextFromBufferMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          extractionSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const tool = createFetchTool({
      timeoutSeconds: 1,
      firecrawl: { enabled: false },
    });
    const resultPromise = tool?.execute?.("call", { url: "https://example.com/slow.pdf" });
    const rejection = expect(resultPromise).rejects.toThrow(
      'Web fetch stage "pdf-extraction" timed out after 1000ms.',
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(extractionSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(extractionSignal?.aborted).toBe(true);
  });

  it("shares the 100 second deadline across serial fallbacks", async () => {
    vi.stubEnv("SCRAPE_API_BASE_URL", "https://scrape.example");
    vi.stubEnv("JINA_API_KEY", "jina-test-key");

    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      const directResponse = response({
        status: 403,
        text: () => delayedValue("blocked", 20_000),
      });
      return await delayedValue(
        {
          response: directResponse,
          finalUrl: url,
          release: vi.fn(async () => {}),
        },
        25_000,
      );
    });

    let scrapeTimeoutMs: number | undefined;
    let firecrawlTimeoutMs: number | undefined;
    let jinaStartedAt: number | undefined;
    let jinaAbortedAt: number | undefined;
    global.fetch = withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "https://scrape.example/api/v1/scrape") {
          const body = JSON.parse(requestBody(init)) as { timeout_ms?: number };
          scrapeTimeoutMs = body.timeout_ms;
          return await new Promise<Response>(() => {});
        }
        if (url === "https://api.firecrawl.dev/v2/scrape") {
          const body = JSON.parse(requestBody(init)) as { timeout?: number };
          firecrawlTimeoutMs = body.timeout;
          return await delayedValue(
            response({
              status: 402,
              contentType: "application/json",
              json: async () => ({ success: false, error: "Insufficient credits" }),
            }),
            20_000,
          );
        }
        if (url.startsWith("https://r.jina.ai/")) {
          jinaStartedAt = Date.now();
          init?.signal?.addEventListener(
            "abort",
            () => {
              jinaAbortedAt = Date.now();
            },
            { once: true },
          );
          return await new Promise<Response>(() => {});
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const tool = createFetchTool({
      timeoutSeconds: 30,
      firecrawl: {
        enabled: true,
        apiKey: "firecrawl-test",
        timeoutSeconds: 30,
      },
      jinaReader: { enabled: true },
    });
    const resultPromise = tool?.execute?.("call", {
      url: "https://example.com/shared-deadline",
    });
    const rejection = expect(resultPromise).rejects.toThrow("Web fetch timed out after 100000ms.");

    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scrapeTimeoutMs).toBe(30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(firecrawlTimeoutMs).toBe(25_000);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(jinaStartedAt).toBe(95_000);

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(jinaAbortedAt).toBe(100_000);
  });
});
