import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const { infoMock, warnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "agents/grok-search",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { __testing, createGrokSearchTool } from "./grok-search.js";

const {
  resolveGrokSearchApiKey,
  resolveGrokSearchModel,
  resolveGrokSearchInlineCitations,
  resolveGrokSearchSource,
  extractGrokContent,
} = __testing;

function installFetchSequence(responses: Array<() => Promise<Response> | Response>) {
  const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected fetch call");
    }
    return next();
  });
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function jsonResponse(
  payload: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
) {
  return Promise.resolve({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as Response);
}

describe("grok_search config resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses config apiKey when provided", () => {
    expect(resolveGrokSearchApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("falls back to XAI_API_KEY when config is missing", () => {
    vi.stubEnv("XAI_API_KEY", "xai-env-key");
    expect(resolveGrokSearchApiKey({})).toBe("xai-env-key");
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveGrokSearchApiKey({})).toBeUndefined();
      expect(resolveGrokSearchApiKey(undefined)).toBeUndefined();
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveGrokSearchModel({})).toBe("grok-4-1-fast");
    expect(resolveGrokSearchModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveGrokSearchModel({ model: "grok-3" })).toBe("grok-3");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveGrokSearchInlineCitations({})).toBe(false);
    expect(resolveGrokSearchInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveGrokSearchInlineCitations({ inlineCitations: true })).toBe(true);
    expect(resolveGrokSearchInlineCitations({ inlineCitations: false })).toBe(false);
  });

  it("normalizes source values", () => {
    expect(resolveGrokSearchSource("web")).toBe("web");
    expect(resolveGrokSearchSource(" X ")).toBe("x");
    expect(resolveGrokSearchSource("rss")).toBeUndefined();
  });
});

describe("grok_search response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toEqual([]);
    expect(result.inlineCitations).toEqual([]);
  });

  it("extracts url_citation annotations and inline spans from content blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello with citations",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 0,
                  end_index: 5,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/b",
                  start_index: 6,
                  end_index: 10,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 0,
                  end_index: 5,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.inlineCitations).toEqual([
      { start_index: 0, end_index: 5, url: "https://example.com/a" },
      { start_index: 6, end_index: 10, url: "https://example.com/b" },
    ]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractGrokContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toEqual([]);
    expect(result.inlineCitations).toEqual([]);
  });

  it("extracts output_text blocks directly in output array (no message wrapper)", () => {
    const result = extractGrokContent({
      output: [
        { type: "web_search_call" },
        {
          type: "output_text",
          text: "direct output text",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/direct",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      ],
    } as Parameters<typeof extractGrokContent>[0]);
    expect(result.text).toBe("direct output text");
    expect(result.annotationCitations).toEqual(["https://example.com/direct"]);
    expect(result.inlineCitations).toEqual([
      { start_index: 0, end_index: 5, url: "https://example.com/direct" },
    ]);
  });
});

describe("createGrokSearchTool", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    infoMock.mockClear();
    warnMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("enables grok_search by default", () => {
    const tool = createGrokSearchTool({ config: {}, sandboxed: false });
    expect(tool?.name).toBe("grok_search");
  });

  it("returns a structured auth error when no key is available", async () => {
    const tool = createGrokSearchTool({ config: {}, sandboxed: true });
    const result = await tool?.execute?.("call-1", { query: "latest AI news" });
    expect(result?.details).toMatchObject({ error: "missing_xai_api_key" });
  });

  it("uses web_search tool by default and injects the web prompt", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    const mockFetch = installFetchSequence([
      () =>
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "summary" }],
            },
          ],
        }),
    ]);

    const tool = createGrokSearchTool({ config: {}, sandboxed: true });
    await tool?.execute?.("call-1", { query: "latest AI news" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("Expected fetch request init");
    }
    const body = JSON.parse(typeof request.body === "string" ? request.body : "{}") as Record<
      string,
      unknown
    >;
    expect(body.instructions).toContain("real-time search summarizer");
    expect(body.tools).toEqual([{ type: "web_search" }]);
  });

  it("uses x_search when source is x", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    const mockFetch = installFetchSequence([
      () =>
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "summary" }],
            },
          ],
        }),
    ]);

    const tool = createGrokSearchTool({ config: {}, sandboxed: true });
    await tool?.execute?.("call-1", { query: "Tesla earnings reaction", source: "x" });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("Expected fetch request init");
    }
    const body = JSON.parse(typeof request.body === "string" ? request.body : "{}") as Record<
      string,
      unknown
    >;
    expect(body.instructions).toContain("X/Twitter sentiment summarizer");
    expect(body.tools).toEqual([{ type: "x_search" }]);
  });

  it("logs usage and estimated cost when xAI returns usage data", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    installFetchSequence([
      () =>
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "summary" }],
            },
          ],
          usage: {
            inputTokens: 1200,
            outputTokens: 50,
            cachedInputTokens: 300,
            totalTokens: 1550,
            raw: {
              num_server_side_tools_used: 2,
            },
          },
        }),
    ]);

    const tool = createGrokSearchTool({
      config: {
        models: {
          providers: {
            xai: {
              baseUrl: "https://api.x.ai/v1",
              models: [
                {
                  id: "grok-4-1-fast",
                  name: "Grok 4.1 Fast",
                  reasoning: true,
                  input: ["text"],
                  cost: {
                    input: 1,
                    output: 2,
                    cacheRead: 0.5,
                    cacheWrite: 0,
                  },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      },
      sandboxed: true,
    });
    await tool?.execute?.("call-usage", { query: "latest AI news" });

    const metricsCall = infoMock.mock.calls.find(
      ([message]) => message === "grok_search call metrics",
    );
    expect(metricsCall).toBeDefined();
    const meta = metricsCall?.[1] as Record<string, unknown>;
    expect(meta).toMatchObject({
      toolCallId: "call-usage",
      toolName: "grok_search",
      source: "web",
      model: "grok-4-1-fast",
      cached: false,
      usageAvailable: true,
      usage: {
        input: 1200,
        output: 50,
        cacheRead: 300,
        total: 1550,
      },
      serverSideToolsUsed: 2,
    });
    expect(typeof meta.latencyMs).toBe("number");
    expect(meta.estimatedCostUsd).toBeCloseTo(0.00145);
  });

  it("logs operator mismatch patterns for site-style queries", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    installFetchSequence([
      () =>
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "summary" }],
            },
          ],
        }),
    ]);

    const tool = createGrokSearchTool({ config: {}, sandboxed: true });
    await tool?.execute?.("call-operators", {
      query: "site:github.com openclaw intitle:docs",
    });

    const mismatchCall = infoMock.mock.calls.find(
      ([message]) => message === "grok_search operator mismatch",
    );
    expect(mismatchCall).toBeDefined();
    expect(mismatchCall?.[1]).toMatchObject({
      toolCallId: "call-operators",
      toolName: "grok_search",
      source: "web",
      query: "site:github.com openclaw intitle:docs",
      operators: ["site:", "intitle:"],
    });
  });

  it("retries once on transient errors and returns a structured unavailable error", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    const mockFetch = installFetchSequence([
      () => jsonResponse({ error: "temporary failure" }, { ok: false, status: 503 }),
      () => jsonResponse({ error: "temporary failure again" }, { ok: false, status: 503 }),
    ]);

    const tool = createGrokSearchTool({ config: {}, sandboxed: true });
    const result = await tool?.execute?.("call-1", { query: "latest AI news" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result?.details).toMatchObject({
      error: "grok_search_unavailable",
      status: 503,
    });
    const failureCall = warnMock.mock.calls.find(
      ([message]) => message === "grok_search call failed",
    );
    expect(failureCall?.[1]).toMatchObject({
      toolCallId: "call-1",
      toolName: "grok_search",
      source: "web",
      model: "grok-4-1-fast",
      errorKind: "transient",
      status: 503,
      transient: true,
    });
  });

  it("does not retry after the caller aborts", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test");
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    const mockFetch = installFetchSequence([
      () => {
        controller.abort(cancellation);
        return jsonResponse({ error: "temporary failure" }, { ok: false, status: 503 });
      },
    ]);

    const tool = createGrokSearchTool({ config: {}, sandboxed: true });

    await expect(
      tool?.execute?.("call-abort", { query: "latest AI news" }, controller.signal),
    ).rejects.toBe(cancellation);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
