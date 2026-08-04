import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { resolvePinnedHostname, SsrFBlockedError } from "../../infra/net/ssrf.js";
import { logDebug } from "../../logger.js";
import { extractPdfTextFromBuffer } from "../../media/pdf-text.js";
import { readResponseWithLimit } from "../../media/read-response-with-limit.js";
import { wrapExternalContent, wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { validateHtmlExtractionResult } from "./web-fetch-result-validation.js";
import {
  extractReadableContent,
  htmlToMarkdown,
  markdownToText,
  truncateText,
  type ExtractMode,
} from "./web-fetch-utils.js";
import { fetchWithWebTimeout, resolveWebFetch } from "./web-request.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

export { extractReadableContent } from "./web-fetch-utils.js";

const EXTRACT_MODES = ["markdown", "text"] as const;

const DEFAULT_FETCH_MAX_CHARS = 20_000;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 750_000;
const DEFAULT_FETCH_PDF_MAX_RESPONSE_BYTES = 25_000_000;
const DEFAULT_FETCH_PDF_MAX_PAGES = 12;
const DEFAULT_FETCH_PDF_MIN_TEXT_CHARS = 200;
const FETCH_MAX_RESPONSE_BYTES_MIN = 32_000;
const FETCH_MAX_RESPONSE_BYTES_MAX = 10_000_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const DEFAULT_JINA_READER_BASE_URL = "https://r.jina.ai";
const DEFAULT_SCRAPE_PATH = "/api/v1/scrape";
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  extractMode: Type.Optional(
    stringEnum(EXTRACT_MODES, {
      description: 'Extraction mode ("markdown" or "text").',
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded).",
      minimum: 100,
    }),
  ),
});

type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type FirecrawlFetchConfig =
  | {
      enabled?: boolean;
      apiKey?: string;
      baseUrl?: string;
      onlyMainContent?: boolean;
      maxAgeMs?: number;
      timeoutSeconds?: number;
    }
  | undefined;

type JinaReaderFetchConfig =
  | {
      enabled?: boolean;
      apiKey?: string;
    }
  | undefined;

function resolveFetchConfig(cfg?: OpenClawConfig): WebFetchConfig {
  const fetch = cfg?.tools?.web?.fetch;
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  return fetch as WebFetchConfig;
}

function resolveFetchEnabled(params: { fetch?: WebFetchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.fetch?.enabled === "boolean") {
    return params.fetch.enabled;
  }
  return true;
}

function resolveFetchReadabilityEnabled(fetch?: WebFetchConfig): boolean {
  if (typeof fetch?.readability === "boolean") {
    return fetch.readability;
  }
  return true;
}

function resolveFetchMaxCharsCap(fetch?: WebFetchConfig): number {
  const raw =
    fetch && "maxCharsCap" in fetch && typeof fetch.maxCharsCap === "number"
      ? fetch.maxCharsCap
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    const configuredMaxChars = fetch?.maxChars;
    if (typeof configuredMaxChars === "number" && Number.isFinite(configuredMaxChars)) {
      return Math.max(DEFAULT_FETCH_MAX_CHARS, 100, Math.floor(configuredMaxChars));
    }
    return DEFAULT_FETCH_MAX_CHARS;
  }
  return Math.max(100, Math.floor(raw));
}

function resolveFetchMaxResponseBytes(fetch?: WebFetchConfig): number {
  const raw =
    fetch && "maxResponseBytes" in fetch && typeof fetch.maxResponseBytes === "number"
      ? fetch.maxResponseBytes
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_FETCH_MAX_RESPONSE_BYTES;
  }
  const value = Math.floor(raw);
  return Math.min(FETCH_MAX_RESPONSE_BYTES_MAX, Math.max(FETCH_MAX_RESPONSE_BYTES_MIN, value));
}

function resolveFirecrawlConfig(fetch?: WebFetchConfig): FirecrawlFetchConfig {
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  const firecrawl = "firecrawl" in fetch ? fetch.firecrawl : undefined;
  if (!firecrawl || typeof firecrawl !== "object") {
    return undefined;
  }
  return firecrawl as FirecrawlFetchConfig;
}

function resolveJinaReaderConfig(fetch?: WebFetchConfig): JinaReaderFetchConfig {
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  const jinaReader = "jinaReader" in fetch ? fetch.jinaReader : undefined;
  if (!jinaReader || typeof jinaReader !== "object") {
    return undefined;
  }
  return jinaReader as JinaReaderFetchConfig;
}

function resolveFirecrawlApiKey(firecrawl?: FirecrawlFetchConfig): string | undefined {
  const fromConfig =
    firecrawl && "apiKey" in firecrawl && typeof firecrawl.apiKey === "string"
      ? normalizeSecretInput(firecrawl.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.FIRECRAWL_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveFirecrawlEnabled(params: { firecrawl?: FirecrawlFetchConfig }): boolean {
  return params.firecrawl?.enabled === true;
}

function resolveJinaReaderEnabled(params: { jinaReader?: JinaReaderFetchConfig }): boolean {
  return params.jinaReader?.enabled === true;
}

function resolveFirecrawlBaseUrl(firecrawl?: FirecrawlFetchConfig): string {
  const raw =
    firecrawl && "baseUrl" in firecrawl && typeof firecrawl.baseUrl === "string"
      ? firecrawl.baseUrl.trim()
      : "";
  return raw || DEFAULT_FIRECRAWL_BASE_URL;
}

function resolveFirecrawlOnlyMainContent(firecrawl?: FirecrawlFetchConfig): boolean {
  if (typeof firecrawl?.onlyMainContent === "boolean") {
    return firecrawl.onlyMainContent;
  }
  return true;
}

function resolveFirecrawlMaxAgeMs(firecrawl?: FirecrawlFetchConfig): number | undefined {
  const raw =
    firecrawl && "maxAgeMs" in firecrawl && typeof firecrawl.maxAgeMs === "number"
      ? firecrawl.maxAgeMs
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const parsed = Math.max(0, Math.floor(raw));
  return parsed > 0 ? parsed : undefined;
}

function resolveFirecrawlMaxAgeMsOrDefault(firecrawl?: FirecrawlFetchConfig): number {
  const resolved = resolveFirecrawlMaxAgeMs(firecrawl);
  if (typeof resolved === "number") {
    return resolved;
  }
  return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}

function resolveJinaReaderApiKey(jinaReader?: JinaReaderFetchConfig): string | undefined {
  const fromConfig =
    jinaReader && "apiKey" in jinaReader && typeof jinaReader.apiKey === "string"
      ? normalizeSecretInput(jinaReader.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.JINA_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveScrapeBaseUrl(): string | undefined {
  const raw = process.env.SCRAPE_API_BASE_URL?.trim() ?? "";
  return raw || undefined;
}

function resolveScrapeEnabled(scrapeBaseUrl?: string): boolean {
  return Boolean(scrapeBaseUrl);
}

function resolveMaxChars(value: unknown, fallback: number, cap: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(100, Math.floor(parsed));
  return Math.min(clamped, cap);
}

function resolveMaxRedirects(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(parsed));
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed) {
    return false;
  }
  const head = trimmed.slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType, maxChars } = params;
  if (!detail) {
    return "";
  }
  let text = detail;
  const contentTypeLower = contentType?.toLowerCase();
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text;
    text = markdownToText(withTitle);
  }
  const truncated = truncateText(text.trim(), maxChars);
  return truncated.text;
}

function redactUrlForDebugLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname && parsed.pathname !== "/" ? `${parsed.origin}/...` : parsed.origin;
  } catch {
    return "[invalid-url]";
  }
}

const WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD = wrapWebContent("", "web_fetch").length;
const WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD = wrapExternalContent("", {
  source: "web_fetch",
  includeWarning: false,
}).length;

function wrapWebFetchContent(
  value: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
  rawLength: number;
  wrappedLength: number;
} {
  if (maxChars <= 0) {
    return { text: "", truncated: true, rawLength: 0, wrappedLength: 0 };
  }
  const includeWarning = maxChars >= WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD;
  const wrapperOverhead = includeWarning
    ? WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD
    : WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD;
  if (wrapperOverhead > maxChars) {
    const minimal = includeWarning
      ? wrapWebContent("", "web_fetch")
      : wrapExternalContent("", { source: "web_fetch", includeWarning: false });
    const truncatedWrapper = truncateText(minimal, maxChars);
    return {
      text: truncatedWrapper.text,
      truncated: true,
      rawLength: 0,
      wrappedLength: truncatedWrapper.text.length,
    };
  }
  const maxInner = Math.max(0, maxChars - wrapperOverhead);
  let truncated = truncateText(value, maxInner);
  let wrappedText = includeWarning
    ? wrapWebContent(truncated.text, "web_fetch")
    : wrapExternalContent(truncated.text, { source: "web_fetch", includeWarning: false });

  if (wrappedText.length > maxChars) {
    const excess = wrappedText.length - maxChars;
    const adjustedMaxInner = Math.max(0, maxInner - excess);
    truncated = truncateText(value, adjustedMaxInner);
    wrappedText = includeWarning
      ? wrapWebContent(truncated.text, "web_fetch")
      : wrapExternalContent(truncated.text, { source: "web_fetch", includeWarning: false });
  }

  return {
    text: wrappedText,
    truncated: truncated.truncated,
    rawLength: truncated.text.length,
    wrappedLength: wrappedText.length,
  };
}

function wrapWebFetchField(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return wrapExternalContent(value, { source: "web_fetch", includeWarning: false });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unknown web_fetch error";
}

type RemoteFallbackError = {
  label: "scraping-get" | "firecrawl" | "jina-reader";
  message: string;
};

function buildWebFetchFallbackError(params: {
  primaryError: unknown;
  fallbackErrors: RemoteFallbackError[];
}): Error {
  const primaryMessage = toErrorMessage(params.primaryError);
  if (params.fallbackErrors.length === 0) {
    return params.primaryError instanceof Error ? params.primaryError : new Error(primaryMessage);
  }
  const details = params.fallbackErrors
    .map((entry) => `${entry.label}: ${entry.message}`)
    .join(" | ");
  return new Error(`${primaryMessage} Fallbacks also failed: ${details}`);
}

function buildFirecrawlWebFetchPayload(params: {
  firecrawl: Awaited<ReturnType<typeof fetchFirecrawlContent>>;
  rawUrl: string;
  finalUrlFallback: string;
  statusFallback: number;
  extractMode: ExtractMode;
  maxChars: number;
  tookMs: number;
}): Record<string, unknown> {
  const wrapped = wrapWebFetchContent(params.firecrawl.text, params.maxChars);
  const wrappedTitle = params.firecrawl.title
    ? wrapWebFetchField(params.firecrawl.title)
    : undefined;
  return {
    url: params.rawUrl, // Keep raw for tool chaining
    finalUrl: params.firecrawl.finalUrl || params.finalUrlFallback, // Keep raw
    status: params.firecrawl.status ?? params.statusFallback,
    contentType: "text/markdown", // Protocol metadata, don't wrap
    title: wrappedTitle,
    extractMode: params.extractMode,
    extractor: "firecrawl",
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: wrapped.truncated,
    length: wrapped.wrappedLength,
    rawLength: wrapped.rawLength, // Actual content length, not wrapped
    wrappedLength: wrapped.wrappedLength,
    fetchedAt: new Date().toISOString(),
    tookMs: params.tookMs,
    text: wrapped.text,
    warning: wrapWebFetchField(params.firecrawl.warning),
  };
}

function buildJinaReaderWebFetchPayload(params: {
  jinaReader: Awaited<ReturnType<typeof fetchJinaReaderContent>>;
  rawUrl: string;
  finalUrlFallback: string;
  statusFallback: number;
  extractMode: ExtractMode;
  maxChars: number;
  tookMs: number;
}): Record<string, unknown> {
  const wrapped = wrapWebFetchContent(params.jinaReader.text, params.maxChars);
  return {
    url: params.rawUrl, // Keep raw for tool chaining
    finalUrl: params.jinaReader.finalUrl || params.finalUrlFallback, // Keep raw
    status: params.jinaReader.status ?? params.statusFallback,
    contentType: "text/markdown", // Protocol metadata, don't wrap
    title: undefined,
    extractMode: params.extractMode,
    extractor: "jina-reader",
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: wrapped.truncated,
    length: wrapped.wrappedLength,
    rawLength: wrapped.rawLength, // Actual content length, not wrapped
    wrappedLength: wrapped.wrappedLength,
    fetchedAt: new Date().toISOString(),
    tookMs: params.tookMs,
    text: wrapped.text,
    warning: undefined,
  };
}

async function assertScrapeTargetAllowed(url: string): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }
  await resolvePinnedHostname(parsedUrl.hostname);
}

function resolveScrapeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return DEFAULT_SCRAPE_PATH;
  }
  try {
    const url = new URL(trimmed);
    if (url.pathname && url.pathname !== "/") {
      return url.toString();
    }
    url.pathname = DEFAULT_SCRAPE_PATH;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

type ScrapeApiResponse = {
  status?: string;
  content?: string;
  url?: string;
  http_status?: number;
  warning?: string;
  error?: string;
};

function parseScrapeApiResponse(rawBody: string): ScrapeApiResponse | null {
  if (!rawBody.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ScrapeApiResponse) : null;
  } catch {
    return null;
  }
}

function buildScrapeFailureDetail(params: {
  payload: ScrapeApiResponse | null;
  rawBody: string;
  contentType?: string | null;
}): string {
  const payload = params.payload;
  const detail =
    typeof payload?.error === "string" && payload.error.trim()
      ? payload.error
      : typeof payload?.status === "string" && payload.status.trim() && payload.status !== "success"
        ? `status=${payload.status}`
        : typeof payload?.content === "string" && !payload.content.trim()
          ? "empty content"
          : params.rawBody.trim() || "invalid JSON response";
  return formatWebFetchErrorDetail({
    detail,
    contentType: params.contentType,
    maxChars: DEFAULT_ERROR_MAX_CHARS,
  });
}

function buildScrapeWebFetchPayload(params: {
  scrape: Awaited<ReturnType<typeof fetchScrapeContent>>;
  rawUrl: string;
  finalUrlFallback: string;
  statusFallback: number;
  extractMode: ExtractMode;
  maxChars: number;
  tookMs: number;
}): Record<string, unknown> {
  const wrapped = wrapWebFetchContent(params.scrape.text, params.maxChars);
  return {
    url: params.rawUrl, // Keep raw for tool chaining
    finalUrl: params.scrape.finalUrl || params.finalUrlFallback, // Keep raw
    status: params.scrape.status ?? params.statusFallback,
    contentType: "text/markdown", // Protocol metadata, don't wrap
    title: undefined,
    extractMode: params.extractMode,
    extractor: "scraping-get",
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: wrapped.truncated,
    length: wrapped.wrappedLength,
    rawLength: wrapped.rawLength,
    wrappedLength: wrapped.wrappedLength,
    fetchedAt: new Date().toISOString(),
    tookMs: params.tookMs,
    text: wrapped.text,
    warning: wrapWebFetchField(params.scrape.warning),
  };
}

function buildPdfWebFetchPayload(params: {
  rawUrl: string;
  finalUrl: string;
  status: number;
  normalizedContentType: string;
  extractMode: ExtractMode;
  text: string;
  maxChars: number;
  tookMs: number;
}): Record<string, unknown> {
  const wrapped = wrapWebFetchContent(params.text, params.maxChars);
  return {
    url: params.rawUrl,
    finalUrl: params.finalUrl,
    status: params.status,
    contentType: params.normalizedContentType,
    title: undefined,
    extractMode: params.extractMode,
    extractor: "pdfjs",
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: wrapped.truncated,
    length: wrapped.wrappedLength,
    rawLength: wrapped.rawLength,
    wrappedLength: wrapped.wrappedLength,
    fetchedAt: new Date().toISOString(),
    tookMs: params.tookMs,
    text: wrapped.text,
    warning: undefined,
  };
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [raw] = value.split(";");
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

class FirecrawlFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FirecrawlFetchError";
  }
}

function shouldTryJinaReaderAfterFirecrawlError(error: unknown): boolean {
  return error instanceof FirecrawlFetchError && error.status === 402;
}

function resolveJinaReaderEndpoint(params: { baseUrl?: string; url: string }): string {
  const baseUrl = (params.baseUrl ?? DEFAULT_JINA_READER_BASE_URL).trim();
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/${params.url}`;
}

export async function fetchFirecrawlContent(params: {
  url: string;
  extractMode: ExtractMode;
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  proxy: "auto" | "basic" | "stealth";
  storeInCache: boolean;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  title?: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
}> {
  const endpoint = resolveFirecrawlEndpoint(params.baseUrl);
  const body: Record<string, unknown> = {
    url: params.url,
    formats: ["markdown"],
    onlyMainContent: params.onlyMainContent,
    timeout: params.timeoutSeconds * 1000,
    maxAge: params.maxAgeMs,
    proxy: params.proxy,
    storeInCache: params.storeInCache,
  };

  const res = await fetchWithWebTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: params.timeoutSeconds * 1000,
      signal: params.signal,
    },
  );

  const payload = (await res.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      content?: string;
      metadata?: {
        title?: string;
        sourceURL?: string;
        statusCode?: number;
      };
    };
    warning?: string;
    error?: string;
  };

  if (!res.ok || payload?.success === false) {
    const detail = payload?.error ?? "";
    throw new FirecrawlFetchError(
      `Firecrawl fetch failed (${res.status}): ${wrapWebContent(detail || res.statusText, "web_fetch")}`.trim(),
      res.status,
    );
  }

  const data = payload?.data ?? {};
  const rawText =
    typeof data.markdown === "string"
      ? data.markdown
      : typeof data.content === "string"
        ? data.content
        : "";
  const text = params.extractMode === "text" ? markdownToText(rawText) : rawText;
  return {
    text,
    title: data.metadata?.title,
    finalUrl: data.metadata?.sourceURL,
    status: data.metadata?.statusCode,
    warning: payload?.warning,
  };
}

export async function fetchJinaReaderContent(params: {
  url: string;
  extractMode: ExtractMode;
  apiKey: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  finalUrl?: string;
  status?: number;
}> {
  await assertScrapeTargetAllowed(params.url);

  const endpoint = resolveJinaReaderEndpoint({ url: params.url });
  const res = await fetchWithWebTimeout(
    endpoint,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "text/markdown, text/plain;q=0.9, */*;q=0.8",
      },
    },
    {
      timeoutMs: params.timeoutSeconds * 1000,
      signal: params.signal,
    },
  );

  const rawText = await res.text().catch(() => "");
  if (!res.ok || rawText.trim().length === 0) {
    const wrappedDetail = wrapWebFetchContent(rawText || res.statusText, DEFAULT_ERROR_MAX_CHARS);
    throw new Error(`Jina Reader fetch failed (${res.status}): ${wrappedDetail.text}`);
  }

  const text = params.extractMode === "text" ? markdownToText(rawText) : rawText;
  return {
    text,
    finalUrl: params.url,
    status: res.status,
  };
}

export async function fetchScrapeContent(params: {
  url: string;
  extractMode: ExtractMode;
  baseUrl: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
}> {
  await assertScrapeTargetAllowed(params.url);

  const endpoint = resolveScrapeEndpoint(params.baseUrl);
  const timeoutMs = params.timeoutSeconds * 1000;
  const body = {
    url: params.url,
    mode: "get",
    output: "markdown",
    timeout_ms: timeoutMs,
  };

  const res = await fetchWithWebTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      timeoutMs,
      signal: params.signal,
    },
  );

  const rawBody = await res.text().catch(() => "");
  const payload = parseScrapeApiResponse(rawBody);
  if (
    !res.ok ||
    !payload ||
    payload.status !== "success" ||
    typeof payload.content !== "string" ||
    payload.content.trim().length === 0
  ) {
    const detail = buildScrapeFailureDetail({
      payload,
      rawBody,
      contentType: res.headers.get("content-type"),
    });
    const wrappedDetail = wrapWebFetchContent(detail || res.statusText, DEFAULT_ERROR_MAX_CHARS);
    const statusCode = typeof payload?.http_status === "number" ? payload.http_status : res.status;
    throw new Error(`Scraping-get fetch failed (${statusCode}): ${wrappedDetail.text}`);
  }

  const content = payload.content;
  const text = params.extractMode === "text" ? markdownToText(content) : content;
  return {
    text,
    finalUrl: typeof payload.url === "string" && payload.url ? payload.url : undefined,
    status: typeof payload.http_status === "number" ? payload.http_status : undefined,
    warning: typeof payload.warning === "string" ? payload.warning : undefined,
  };
}

type FirecrawlRuntimeParams = {
  firecrawlEnabled: boolean;
  firecrawlApiKey?: string;
  firecrawlBaseUrl: string;
  firecrawlOnlyMainContent: boolean;
  firecrawlMaxAgeMs: number;
  firecrawlProxy: "auto" | "basic" | "stealth";
  firecrawlStoreInCache: boolean;
  firecrawlTimeoutSeconds: number;
};

type JinaReaderRuntimeParams = {
  jinaReaderEnabled: boolean;
  jinaReaderApiKey?: string;
};

type ScrapeRuntimeParams = {
  scrapeEnabled: boolean;
  scrapeBaseUrl?: string;
};

type WebFetchRuntimeParams = FirecrawlRuntimeParams &
  JinaReaderRuntimeParams &
  ScrapeRuntimeParams & {
    url: string;
    extractMode: ExtractMode;
    maxChars: number;
    maxResponseBytes: number;
    maxRedirects: number;
    timeoutSeconds: number;
    cacheTtlMs: number;
    userAgent: string;
    readabilityEnabled: boolean;
    signal?: AbortSignal;
  };

type RemoteFallbackRuntimeParams = WebFetchRuntimeParams & {
  urlToFetch: string;
  finalUrlFallback: string;
  statusFallback: number;
  cacheKey: string;
  startedAt: number;
};

function toFirecrawlContentParams(
  params: FirecrawlRuntimeParams & {
    url: string;
    extractMode: ExtractMode;
    signal?: AbortSignal;
  },
): Parameters<typeof fetchFirecrawlContent>[0] | null {
  if (!params.firecrawlEnabled || !params.firecrawlApiKey) {
    return null;
  }
  return {
    url: params.url,
    extractMode: params.extractMode,
    apiKey: params.firecrawlApiKey,
    baseUrl: params.firecrawlBaseUrl,
    onlyMainContent: params.firecrawlOnlyMainContent,
    maxAgeMs: params.firecrawlMaxAgeMs,
    proxy: params.firecrawlProxy,
    storeInCache: params.firecrawlStoreInCache,
    timeoutSeconds: params.firecrawlTimeoutSeconds,
    signal: params.signal,
  };
}

function toJinaReaderContentParams(
  params: JinaReaderRuntimeParams & {
    url: string;
    extractMode: ExtractMode;
    timeoutSeconds: number;
    signal?: AbortSignal;
  },
): Parameters<typeof fetchJinaReaderContent>[0] | null {
  if (!params.jinaReaderApiKey) {
    return null;
  }
  if (!params.jinaReaderEnabled) {
    return null;
  }
  return {
    url: params.url,
    extractMode: params.extractMode,
    apiKey: params.jinaReaderApiKey,
    timeoutSeconds: params.timeoutSeconds,
    signal: params.signal,
  };
}

async function maybeFetchJinaReaderWebFetchPayload(
  params: WebFetchRuntimeParams & {
    urlToFetch: string;
    finalUrlFallback: string;
    statusFallback: number;
    cacheKey: string;
    tookMs: number;
  },
): Promise<Record<string, unknown> | null> {
  const jinaReaderParams = toJinaReaderContentParams({
    ...params,
    url: params.urlToFetch,
    extractMode: params.extractMode,
  });
  if (!jinaReaderParams) {
    return null;
  }

  const jinaReader = await fetchJinaReaderContent(jinaReaderParams);
  const payload = buildJinaReaderWebFetchPayload({
    jinaReader,
    rawUrl: params.url,
    finalUrlFallback: params.finalUrlFallback,
    statusFallback: params.statusFallback,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
    tookMs: params.tookMs,
  });
  writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function maybeFetchFirecrawlWebFetchPayload(
  params: WebFetchRuntimeParams & {
    urlToFetch: string;
    finalUrlFallback: string;
    statusFallback: number;
    cacheKey: string;
    tookMs: number;
  },
): Promise<Record<string, unknown> | null> {
  const firecrawlParams = toFirecrawlContentParams({
    ...params,
    url: params.urlToFetch,
    extractMode: params.extractMode,
  });
  if (!firecrawlParams) {
    return null;
  }

  const firecrawl = await fetchFirecrawlContent(firecrawlParams);
  const payload = buildFirecrawlWebFetchPayload({
    firecrawl,
    rawUrl: params.url,
    finalUrlFallback: params.finalUrlFallback,
    statusFallback: params.statusFallback,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
    tookMs: params.tookMs,
  });
  writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function maybeFetchScrapeWebFetchPayload(
  params: WebFetchRuntimeParams & {
    urlToFetch: string;
    finalUrlFallback: string;
    statusFallback: number;
    cacheKey: string;
    tookMs: number;
  },
): Promise<Record<string, unknown> | null> {
  if (!params.scrapeEnabled || !params.scrapeBaseUrl) {
    return null;
  }

  const scrape = await fetchScrapeContent({
    url: params.urlToFetch,
    extractMode: params.extractMode,
    baseUrl: params.scrapeBaseUrl,
    timeoutSeconds: params.timeoutSeconds,
    signal: params.signal,
  });
  const payload = buildScrapeWebFetchPayload({
    scrape,
    rawUrl: params.url,
    finalUrlFallback: params.finalUrlFallback,
    statusFallback: params.statusFallback,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
    tookMs: params.tookMs,
  });
  writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function maybeFetchFallbackWebFetchPayload(
  params: RemoteFallbackRuntimeParams,
  options?: { allowFirecrawl?: boolean },
): Promise<{ payload: Record<string, unknown> | null; errors: RemoteFallbackError[] }> {
  const errors: RemoteFallbackError[] = [];
  params.signal?.throwIfAborted();

  try {
    const payload = await maybeFetchScrapeWebFetchPayload({
      ...params,
      tookMs: Date.now() - params.startedAt,
    });
    if (payload) {
      return { payload, errors };
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof SsrFBlockedError) {
      throw error;
    }
    errors.push({ label: "scraping-get", message: toErrorMessage(error) });
  }

  if (options?.allowFirecrawl !== false) {
    params.signal?.throwIfAborted();
    try {
      const payload = await maybeFetchFirecrawlWebFetchPayload({
        ...params,
        tookMs: Date.now() - params.startedAt,
      });
      if (payload) {
        return { payload, errors };
      }
    } catch (error) {
      params.signal?.throwIfAborted();
      errors.push({ label: "firecrawl", message: toErrorMessage(error) });
      if (shouldTryJinaReaderAfterFirecrawlError(error)) {
        params.signal?.throwIfAborted();
        try {
          const payload = await maybeFetchJinaReaderWebFetchPayload({
            ...params,
            tookMs: Date.now() - params.startedAt,
          });
          if (payload) {
            return { payload, errors };
          }
        } catch (jinaReaderError) {
          params.signal?.throwIfAborted();
          errors.push({ label: "jina-reader", message: toErrorMessage(jinaReaderError) });
        }
      }
    }
  }

  return { payload: null, errors };
}

async function runPdfWebFetch(
  params: WebFetchRuntimeParams & {
    res: Response;
    finalUrl: string;
    status: number;
    normalizedContentType: string;
    cacheKey: string;
    startedAt: number;
  },
): Promise<Record<string, unknown>> {
  try {
    const buffer = await readResponseWithLimit(
      params.res,
      Math.max(params.maxResponseBytes, DEFAULT_FETCH_PDF_MAX_RESPONSE_BYTES),
    );
    const extracted = await extractPdfTextFromBuffer({
      buffer,
      maxPages: DEFAULT_FETCH_PDF_MAX_PAGES,
    });
    const text = extracted.text.trim();
    if (text.length < DEFAULT_FETCH_PDF_MIN_TEXT_CHARS) {
      throw new Error(
        `Extracted only ${text.length} characters across ${extracted.pageCount} page(s).`,
      );
    }

    const payload = buildPdfWebFetchPayload({
      rawUrl: params.url,
      finalUrl: params.finalUrl,
      status: params.status,
      normalizedContentType: params.normalizedContentType,
      extractMode: params.extractMode,
      text,
      maxChars: params.maxChars,
      tookMs: Date.now() - params.startedAt,
    });
    writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
    return payload;
  } catch (error) {
    const fallback = await maybeFetchFallbackWebFetchPayload(
      {
        ...params,
        urlToFetch: params.finalUrl,
        finalUrlFallback: params.finalUrl,
        statusFallback: params.status,
        cacheKey: params.cacheKey,
        startedAt: params.startedAt,
      },
      { allowFirecrawl: false },
    );
    if (fallback.payload) {
      return fallback.payload;
    }
    throw buildWebFetchFallbackError({
      primaryError: new Error(`PDF extraction failed: ${toErrorMessage(error)}`),
      fallbackErrors: fallback.errors,
    });
  }
}

async function runWebFetch(params: WebFetchRuntimeParams): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }

  const start = Date.now();
  let res: Response;
  let release: (() => Promise<void>) | null = null;
  let finalUrl = params.url;
  try {
    const result = await fetchWithSsrFGuard({
      url: params.url,
      fetchImpl: resolveWebFetch(),
      maxRedirects: params.maxRedirects,
      timeoutMs: params.timeoutSeconds * 1000,
      signal: params.signal,
      init: {
        headers: {
          Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
          "User-Agent": params.userAgent,
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    });
    res = result.response;
    finalUrl = result.finalUrl;
    release = result.release;

    // Cloudflare Markdown for Agents — log token budget hint when present
    const markdownTokens = res.headers.get("x-markdown-tokens");
    if (markdownTokens) {
      logDebug(
        `[web-fetch] x-markdown-tokens: ${markdownTokens} (${redactUrlForDebugLog(finalUrl)})`,
      );
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof SsrFBlockedError) {
      throw error;
    }
    const fallback = await maybeFetchFallbackWebFetchPayload({
      ...params,
      urlToFetch: finalUrl,
      finalUrlFallback: finalUrl,
      statusFallback: 200,
      cacheKey,
      startedAt: start,
    });
    if (fallback.payload) {
      return fallback.payload;
    }
    throw buildWebFetchFallbackError({
      primaryError: error,
      fallbackErrors: fallback.errors,
    });
  }

  try {
    if (!res.ok) {
      const rawDetailResult = await readResponseText(res, { maxBytes: DEFAULT_ERROR_MAX_BYTES });
      const rawDetail = rawDetailResult.text;
      const detail = formatWebFetchErrorDetail({
        detail: rawDetail,
        contentType: res.headers.get("content-type"),
        maxChars: DEFAULT_ERROR_MAX_CHARS,
      });
      const wrappedDetail = wrapWebFetchContent(detail || res.statusText, DEFAULT_ERROR_MAX_CHARS);
      const primaryError = new Error(`Web fetch failed (${res.status}): ${wrappedDetail.text}`);
      const fallback = await maybeFetchFallbackWebFetchPayload({
        ...params,
        urlToFetch: params.url,
        finalUrlFallback: finalUrl,
        statusFallback: res.status,
        cacheKey,
        startedAt: start,
      });
      if (fallback.payload) {
        return fallback.payload;
      }
      throw buildWebFetchFallbackError({
        primaryError,
        fallbackErrors: fallback.errors,
      });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const normalizedContentType = normalizeContentType(contentType) ?? "application/octet-stream";
    if (contentType.includes("application/pdf")) {
      return await runPdfWebFetch({
        ...params,
        res,
        finalUrl,
        status: res.status,
        normalizedContentType,
        cacheKey,
        startedAt: start,
      });
    }

    const bodyResult = await readResponseText(res, {
      maxBytes: params.maxResponseBytes,
      throwOnError: true,
    });
    const body = bodyResult.text;
    const responseTruncatedWarning = bodyResult.truncated
      ? `Response body truncated after ${params.maxResponseBytes} bytes.`
      : undefined;

    let title: string | undefined;
    let extractor = "raw";
    let text = body;
    if (contentType.includes("text/markdown")) {
      // Cloudflare Markdown for Agents: server returned pre-rendered markdown
      extractor = "cf-markdown";
      if (params.extractMode === "text") {
        text = markdownToText(body);
      }
    } else if (contentType.includes("text/html")) {
      if (params.readabilityEnabled) {
        const readable = await extractReadableContent({
          html: body,
          url: finalUrl,
          extractMode: params.extractMode,
        });
        if (readable?.text) {
          const validation = await validateHtmlExtractionResult({
            html: body,
            extractedText:
              params.extractMode === "text" ? readable.text : markdownToText(readable.text),
            title: readable.title,
            contentType,
            httpStatus: res.status,
          });
          if (validation.failureClass) {
            logDebug(
              `[web-fetch] downgraded readability result to ${validation.failureClass} body=${validation.metadata.bodyLength} text=${validation.metadata.textLength} scripts=${validation.metadata.scriptCount} root=${validation.metadata.htmlHasClientRenderRoot ? "yes" : "no"} (${redactUrlForDebugLog(finalUrl)})`,
            );
            const fallback = await maybeFetchFallbackWebFetchPayload({
              ...params,
              urlToFetch: finalUrl,
              finalUrlFallback: finalUrl,
              statusFallback: res.status,
              cacheKey,
              startedAt: start,
            });
            if (fallback.payload) {
              return fallback.payload;
            }
            throw buildWebFetchFallbackError({
              primaryError: new Error(
                `Web fetch extraction failed: Post-validation classified readability result as ${validation.failureClass}.`,
              ),
              fallbackErrors: fallback.errors,
            });
          }
          text = readable.text;
          title = readable.title;
          extractor = "readability";
        } else {
          const fallback = await maybeFetchFallbackWebFetchPayload({
            ...params,
            urlToFetch: finalUrl,
            finalUrlFallback: finalUrl,
            statusFallback: res.status,
            cacheKey,
            startedAt: start,
          });
          if (fallback.payload) {
            return fallback.payload;
          }
          throw buildWebFetchFallbackError({
            primaryError: new Error(
              "Web fetch extraction failed: Readability returned no content.",
            ),
            fallbackErrors: fallback.errors,
          });
        }
      } else {
        const fallback = await maybeFetchFallbackWebFetchPayload({
          ...params,
          urlToFetch: finalUrl,
          finalUrlFallback: finalUrl,
          statusFallback: res.status,
          cacheKey,
          startedAt: start,
        });
        if (fallback.payload) {
          return fallback.payload;
        }
        throw buildWebFetchFallbackError({
          primaryError: new Error("Web fetch extraction failed: Readability disabled."),
          fallbackErrors: fallback.errors,
        });
      }
    } else if (contentType.includes("application/json")) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
        extractor = "json";
      } catch {
        text = body;
        extractor = "raw";
      }
    }

    const wrapped = wrapWebFetchContent(text, params.maxChars);
    const wrappedTitle = title ? wrapWebFetchField(title) : undefined;
    const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);
    const payload = {
      url: params.url, // Keep raw for tool chaining
      finalUrl, // Keep raw
      status: res.status,
      contentType: normalizedContentType, // Protocol metadata, don't wrap
      title: wrappedTitle,
      extractMode: params.extractMode,
      extractor,
      externalContent: {
        untrusted: true,
        source: "web_fetch",
        wrapped: true,
      },
      truncated: wrapped.truncated,
      length: wrapped.wrappedLength,
      rawLength: wrapped.rawLength, // Actual content length, not wrapped
      wrappedLength: wrapped.wrappedLength,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      text: wrapped.text,
      warning: wrappedWarning,
    };
    writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  } finally {
    if (release) {
      await release();
    }
  }
}

function resolveFirecrawlEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  }
  try {
    const url = new URL(trimmed);
    if (url.pathname && url.pathname !== "/") {
      return url.toString();
    }
    url.pathname = "/v2/scrape";
    return url.toString();
  } catch {
    return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  }
}

export function createWebFetchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  if (!resolveFetchEnabled({ fetch, sandboxed: options?.sandboxed })) {
    return null;
  }
  const readabilityEnabled = resolveFetchReadabilityEnabled(fetch);
  const scrapeBaseUrl = resolveScrapeBaseUrl();
  const scrapeEnabled = resolveScrapeEnabled(scrapeBaseUrl);
  const firecrawl = resolveFirecrawlConfig(fetch);
  const firecrawlApiKey = resolveFirecrawlApiKey(firecrawl);
  const firecrawlEnabled = resolveFirecrawlEnabled({ firecrawl });
  const firecrawlBaseUrl = resolveFirecrawlBaseUrl(firecrawl);
  const firecrawlOnlyMainContent = resolveFirecrawlOnlyMainContent(firecrawl);
  const firecrawlMaxAgeMs = resolveFirecrawlMaxAgeMsOrDefault(firecrawl);
  const firecrawlTimeoutSeconds = resolveTimeoutSeconds(
    firecrawl?.timeoutSeconds ?? fetch?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const jinaReader = resolveJinaReaderConfig(fetch);
  const jinaReaderEnabled = resolveJinaReaderEnabled({ jinaReader });
  const jinaReaderApiKey = resolveJinaReaderApiKey(jinaReader);
  const userAgent =
    (fetch && "userAgent" in fetch && typeof fetch.userAgent === "string" && fetch.userAgent) ||
    DEFAULT_FETCH_USER_AGENT;
  const maxResponseBytes = resolveFetchMaxResponseBytes(fetch);
  return {
    label: "Web Fetch",
    name: "web_fetch",
    sideEffect: "read_only",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation.",
    parameters: WebFetchSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const extractMode = readStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readNumberParam(params, "maxChars", { integer: true });
      const maxCharsCap = resolveFetchMaxCharsCap(fetch);
      const result = await runWebFetch({
        url,
        extractMode,
        maxChars: resolveMaxChars(
          maxChars ?? fetch?.maxChars,
          DEFAULT_FETCH_MAX_CHARS,
          maxCharsCap,
        ),
        maxResponseBytes,
        maxRedirects: resolveMaxRedirects(fetch?.maxRedirects, DEFAULT_FETCH_MAX_REDIRECTS),
        timeoutSeconds: resolveTimeoutSeconds(fetch?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(fetch?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        userAgent,
        readabilityEnabled,
        scrapeEnabled,
        scrapeBaseUrl,
        firecrawlEnabled,
        firecrawlApiKey,
        firecrawlBaseUrl,
        firecrawlOnlyMainContent,
        firecrawlMaxAgeMs,
        firecrawlProxy: "auto",
        firecrawlStoreInCache: true,
        firecrawlTimeoutSeconds,
        jinaReaderEnabled,
        jinaReaderApiKey,
        signal,
      });
      return jsonResult(result);
    },
  };
}
