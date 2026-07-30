import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { normalizeUsage, type NormalizedUsage, type UsageLike } from "../usage.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { fetchWithWebTimeout, WebRequestTimeoutError } from "./web-request.js";
import {
  CacheEntry,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";
const DEFAULT_GROK_CACHE_TTL_MINUTES = 0;
const GROK_SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const GROK_TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const GROK_OPERATOR_PATTERN = /\b(site|intitle|filetype):/gi;
const DOCS_URL = "https://docs.openclaw.ai/tools/web";
const log = createSubsystemLogger("agents/grok-search");

const WEB_SOURCE_PROMPT = [
  "You are a real-time search summarizer.",
  "Answer based on search results. Do not fabricate.",
  'Do not write preamble phrases like "Here\'s a summary" or "Based on the results".',
  "Be concise: prefer one paragraph or 3-5 bullet points.",
  "Prioritize facts, dates, and sources.",
  "If information is uncertain, say so explicitly.",
  "Preserve citations in the response.",
  "Respond in the same language as the user query.",
].join("\n");

const X_SOURCE_PROMPT = [
  "You are an X/Twitter sentiment summarizer.",
  "Summarize discussion themes, main viewpoints, trends, and disagreements.",
  "Do not present individual posts as verified facts.",
  "Be concise: prefer one paragraph or 3-5 bullet points.",
  "Preserve citations in the response.",
  "Respond in the same language as the user query.",
].join("\n");

const GrokSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  source: Type.Optional(
    Type.String({
      description:
        'Optional source selector. Use "web" (default) for general web search or "x" for X/Twitter search.',
    }),
  ),
});

type GrokSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { grokSearch?: infer Grok }
    ? Grok
    : undefined
  : undefined;

type GrokSearchSource = "web" | "x";

type GrokCitationSpan = {
  start_index: number;
  end_index: number;
  url: string;
};

type GrokUsageRecord = UsageLike & {
  raw?: UsageLike & {
    num_server_side_tools_used?: number;
  };
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  output_text?: string;
  citations?: string[];
  inline_citations?: GrokCitationSpan[];
  usage?: GrokUsageRecord;
};

type ExtractedGrokContent = {
  text: string | undefined;
  annotationCitations: string[];
  inlineCitations: GrokCitationSpan[];
};

class GrokSearchError extends Error {
  readonly status?: number;
  readonly transient: boolean;
  readonly kind: "auth" | "transient" | "request";

  constructor(params: {
    message: string;
    status?: number;
    transient?: boolean;
    kind: "auth" | "transient" | "request";
  }) {
    super(params.message);
    this.name = "GrokSearchError";
    this.status = params.status;
    this.transient = params.transient === true;
    this.kind = params.kind;
  }
}

function resolveGrokSearchConfig(cfg?: OpenClawConfig): GrokSearchConfig {
  const grokSearch = cfg?.tools?.web?.grokSearch;
  if (!grokSearch || typeof grokSearch !== "object") {
    return undefined;
  }
  return grokSearch as GrokSearchConfig;
}

function resolveGrokSearchEnabled(params: {
  grokSearch?: GrokSearchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.grokSearch?.enabled === "boolean") {
    return params.grokSearch.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function normalizeApiKey(key: unknown): string {
  return normalizeSecretInput(key);
}

function resolveGrokSearchApiKey(grokSearch?: GrokSearchConfig): string | undefined {
  const fromConfig = normalizeApiKey(grokSearch?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
  return fromEnv || undefined;
}

function resolveGrokSearchModel(grokSearch?: GrokSearchConfig): string {
  const fromConfig =
    grokSearch && "model" in grokSearch && typeof grokSearch.model === "string"
      ? grokSearch.model.trim()
      : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokSearchInlineCitations(grokSearch?: GrokSearchConfig): boolean {
  return grokSearch?.inlineCitations === true;
}

function resolveGrokSearchSource(value: unknown): GrokSearchSource | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "web" || normalized === "x") {
    return normalized;
  }
  return undefined;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupeInlineCitations(values: GrokCitationSpan[]): GrokCitationSpan[] {
  const seen = new Set<string>();
  const result: GrokCitationSpan[] = [];
  for (const entry of values) {
    const key = `${entry.start_index}:${entry.end_index}:${entry.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function parseAnnotationCitations(annotations: unknown): GrokCitationSpan[] {
  if (!Array.isArray(annotations)) {
    return [];
  }
  const spans: GrokCitationSpan[] = [];
  for (const entry of annotations) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      record.type !== "url_citation" ||
      typeof record.url !== "string" ||
      typeof record.start_index !== "number" ||
      typeof record.end_index !== "number"
    ) {
      continue;
    }
    spans.push({
      start_index: Math.trunc(record.start_index),
      end_index: Math.trunc(record.end_index),
      url: record.url,
    });
  }
  return spans;
}

function extractGrokContent(data: GrokSearchResponse): ExtractedGrokContent {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const inlineCitations = dedupeInlineCitations(
            parseAnnotationCitations(block.annotations),
          );
          return {
            text: block.text,
            annotationCitations: dedupeStrings(inlineCitations.map((entry) => entry.url)),
            inlineCitations,
          };
        }
      }
    }

    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const inlineCitations = dedupeInlineCitations(parseAnnotationCitations(output.annotations));
      return {
        text: output.text,
        annotationCitations: dedupeStrings(inlineCitations.map((entry) => entry.url)),
        inlineCitations,
      };
    }
  }

  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [], inlineCitations: [] };
}

function mergeNormalizedUsage(
  primary?: NormalizedUsage,
  fallback?: NormalizedUsage,
): NormalizedUsage | undefined {
  if (!primary && !fallback) {
    return undefined;
  }
  const merged = {
    input: primary?.input ?? fallback?.input,
    output: primary?.output ?? fallback?.output,
    cacheRead: primary?.cacheRead ?? fallback?.cacheRead,
    cacheWrite: primary?.cacheWrite ?? fallback?.cacheWrite,
    total: primary?.total ?? fallback?.total,
  };
  if (
    merged.input === undefined &&
    merged.output === undefined &&
    merged.cacheRead === undefined &&
    merged.cacheWrite === undefined &&
    merged.total === undefined
  ) {
    return undefined;
  }
  return merged;
}

function extractGrokUsage(data: GrokSearchResponse): NormalizedUsage | undefined {
  if (!data.usage || typeof data.usage !== "object") {
    return undefined;
  }
  const topLevel = normalizeUsage(data.usage);
  const raw =
    "raw" in data.usage && data.usage.raw && typeof data.usage.raw === "object"
      ? normalizeUsage(data.usage.raw)
      : undefined;
  return mergeNormalizedUsage(topLevel, raw);
}

function extractServerSideToolsUsed(data: GrokSearchResponse): number | undefined {
  const raw =
    data.usage && typeof data.usage === "object" && "raw" in data.usage
      ? data.usage.raw
      : undefined;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const count = (raw as { num_server_side_tools_used?: unknown }).num_server_side_tools_used;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return undefined;
  }
  return Math.trunc(count);
}

function detectOperatorMismatch(query: string): string[] {
  const matches = query.matchAll(GROK_OPERATOR_PATTERN);
  const operators = new Set<string>();
  for (const match of matches) {
    const name = match[1]?.toLowerCase();
    if (name) {
      operators.add(`${name}:`);
    }
  }
  return [...operators];
}

function logOperatorMismatch(params: {
  toolCallId: string;
  query: string;
  source: GrokSearchSource;
  operators: string[];
}) {
  if (params.operators.length === 0) {
    return;
  }
  log.info("grok_search operator mismatch", {
    toolCallId: params.toolCallId,
    toolName: "grok_search",
    source: params.source,
    query: params.query,
    operators: params.operators,
  });
}

function logGrokSearchMetrics(params: {
  toolCallId: string;
  source: GrokSearchSource;
  model: string;
  latencyMs: number;
  cached: boolean;
  usage?: NormalizedUsage;
  estimatedCostUsd?: number;
  serverSideToolsUsed?: number;
}) {
  log.info("grok_search call metrics", {
    toolCallId: params.toolCallId,
    toolName: "grok_search",
    source: params.source,
    model: params.model,
    latencyMs: params.latencyMs,
    cached: params.cached,
    usageAvailable: params.usage !== undefined,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(params.estimatedCostUsd !== undefined ? { estimatedCostUsd: params.estimatedCostUsd } : {}),
    ...(params.serverSideToolsUsed !== undefined
      ? { serverSideToolsUsed: params.serverSideToolsUsed }
      : {}),
  });
}

function logGrokSearchFailure(params: {
  toolCallId: string;
  source: GrokSearchSource;
  model: string;
  latencyMs: number;
  error: GrokSearchError;
}) {
  log.warn("grok_search call failed", {
    toolCallId: params.toolCallId,
    toolName: "grok_search",
    source: params.source,
    model: params.model,
    latencyMs: params.latencyMs,
    errorKind: params.error.kind,
    transient: params.error.transient,
    ...(params.error.status !== undefined ? { status: params.error.status } : {}),
  });
}

function missingGrokSearchKeyPayload() {
  return {
    error: "missing_xai_api_key",
    message:
      "grok_search needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.grokSearch.apiKey.",
    docs: DOCS_URL,
  };
}

function invalidGrokSourcePayload() {
  return {
    error: "invalid_source",
    message: 'source must be "web" or "x".',
    docs: DOCS_URL,
  };
}

function resolveSystemPrompt(source: GrokSearchSource): string {
  return source === "x" ? X_SOURCE_PROMPT : WEB_SOURCE_PROMPT;
}

function classifyGrokHttpError(status: number): "auth" | "transient" | "request" {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (GROK_TRANSIENT_STATUS_CODES.has(status)) {
    return "transient";
  }
  return "request";
}

async function throwGrokApiError(res: Response): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text || res.statusText;
  const kind = classifyGrokHttpError(res.status);
  throw new GrokSearchError({
    status: res.status,
    transient: kind === "transient",
    kind,
    message: `xAI API error (${res.status}): ${detail}`,
  });
}

function normalizeGrokError(err: unknown): GrokSearchError {
  if (err instanceof GrokSearchError) {
    return err;
  }
  if (err instanceof WebRequestTimeoutError) {
    return new GrokSearchError({
      kind: "transient",
      transient: true,
      message: "xAI request timed out.",
    });
  }
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  ) {
    return new GrokSearchError({
      kind: "transient",
      transient: true,
      message: "xAI request timed out.",
    });
  }
  return new GrokSearchError({
    kind: "request",
    message: err instanceof Error ? err.message : String(err),
  });
}

async function runGrokSearchRequest(params: {
  query: string;
  source: GrokSearchSource;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokCitationSpan[];
  usage?: NormalizedUsage;
  serverSideToolsUsed?: number;
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    instructions: resolveSystemPrompt(params.source),
    input: [
      {
        role: "user",
        content: params.query,
      },
    ],
    tools: [{ type: params.source === "x" ? "x_search" : "web_search" }],
  };

  const res = await fetchWithWebTimeout(
    XAI_API_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: params.timeoutSeconds * 1000,
      signal: params.signal,
    },
  );

  if (!res.ok) {
    return throwGrokApiError(res);
  }

  const data = (await res.json()) as GrokSearchResponse;
  const extracted = extractGrokContent(data);
  const content = extracted.text ?? "No response";
  const citations =
    Array.isArray(data.citations) && data.citations.length > 0
      ? dedupeStrings(data.citations)
      : extracted.annotationCitations;

  const inlineCitations = params.inlineCitations
    ? dedupeInlineCitations(
        Array.isArray(data.inline_citations) && data.inline_citations.length > 0
          ? data.inline_citations
          : extracted.inlineCitations,
      )
    : undefined;
  const usage = extractGrokUsage(data);
  const serverSideToolsUsed = extractServerSideToolsUsed(data);

  return {
    content,
    citations,
    inlineCitations: inlineCitations && inlineCitations.length > 0 ? inlineCitations : undefined,
    ...(usage ? { usage } : {}),
    ...(serverSideToolsUsed !== undefined ? { serverSideToolsUsed } : {}),
  };
}

async function runGrokSearchWithRetry(params: {
  query: string;
  source: GrokSearchSource;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokCitationSpan[];
  usage?: NormalizedUsage;
  serverSideToolsUsed?: number;
}> {
  try {
    return await runGrokSearchRequest(params);
  } catch (err) {
    if (params.signal?.aborted) {
      throw err;
    }
    const normalized = normalizeGrokError(err);
    if (!normalized.transient) {
      throw normalized;
    }
  }
  return runGrokSearchRequest(params).catch((err) => {
    if (params.signal?.aborted) {
      throw err;
    }
    throw normalizeGrokError(err);
  });
}

function grokSearchErrorPayload(error: GrokSearchError) {
  if (error.kind === "auth") {
    return {
      error: "xai_auth_error",
      status: error.status,
      message:
        "grok_search failed authentication with xAI. Check XAI_API_KEY or tools.web.grokSearch.apiKey.",
      docs: DOCS_URL,
    };
  }
  if (error.kind === "transient") {
    return {
      error: "grok_search_unavailable",
      status: error.status,
      message:
        "grok_search is unavailable right now; try web_search for a link-based search result.",
      action: "Retry grok_search later, or use web_search for structured links.",
      docs: DOCS_URL,
    };
  }
  return {
    error: "grok_search_failed",
    status: error.status,
    message: error.message || "grok_search failed.",
    docs: DOCS_URL,
  };
}

async function runGrokSearch(params: {
  toolCallId: string;
  query: string;
  source: GrokSearchSource;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  inlineCitations: boolean;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const start = Date.now();
  logOperatorMismatch({
    toolCallId: params.toolCallId,
    query: params.query,
    source: params.source,
    operators: detectOperatorMismatch(params.query),
  });
  const cacheKey = normalizeCacheKey(
    `grok_search:${params.query}:${params.source}:${params.model}:${String(params.inlineCitations)}`,
  );
  const cached = readCache(GROK_SEARCH_CACHE, cacheKey);
  if (cached) {
    logGrokSearchMetrics({
      toolCallId: params.toolCallId,
      source: params.source,
      model: params.model,
      latencyMs: Date.now() - start,
      cached: true,
    });
    return { ...cached.value, cached: true };
  }

  try {
    const { content, citations, inlineCitations, usage, serverSideToolsUsed } =
      await runGrokSearchWithRetry(params);
    const latencyMs = Date.now() - start;
    const estimatedCostUsd = estimateUsageCost({
      usage,
      cost: resolveModelCostConfig({
        provider: "xai",
        model: params.model,
        config: params.config,
      }),
    });

    logGrokSearchMetrics({
      toolCallId: params.toolCallId,
      source: params.source,
      model: params.model,
      latencyMs,
      cached: false,
      usage,
      estimatedCostUsd,
      serverSideToolsUsed,
    });

    const payload = {
      query: params.query,
      source: params.source,
      provider: "grok",
      model: params.model,
      tookMs: latencyMs,
      externalContent: {
        untrusted: true,
        source: "grok_search",
        provider: "grok",
        wrapped: true,
      },
      content: wrapWebContent(content, "grok_search"),
      citations,
      ...(inlineCitations ? { inlineCitations } : {}),
    };
    writeCache(GROK_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  } catch (err) {
    if (params.signal?.aborted) {
      throw err;
    }
    const normalized = normalizeGrokError(err);
    logGrokSearchFailure({
      toolCallId: params.toolCallId,
      source: params.source,
      model: params.model,
      latencyMs: Date.now() - start,
      error: normalized,
    });
    throw normalized;
  }
}

export function createGrokSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const grokSearch = resolveGrokSearchConfig(options?.config);
  if (!resolveGrokSearchEnabled({ grokSearch, sandboxed: options?.sandboxed })) {
    return null;
  }

  return {
    label: "Grok Search",
    name: "grok_search",
    description:
      'Search the web using xAI Grok for synthesized answers with citations. Best for: recent news, live developments, public reaction, sentiment, trends, X/Twitter discussion, natural language queries. Note: does not support search operators like site:, intitle:, filetype:. Use source="x" to search X/Twitter posts specifically; default source is "web". Examples: "latest OpenAI announcements", "what are people saying about Tesla earnings", "news about AI regulation 2026"',
    parameters: GrokSearchSchema,
    execute: async (toolCallId, args, signal) => {
      const apiKey = resolveGrokSearchApiKey(grokSearch);
      if (!apiKey) {
        return jsonResult(missingGrokSearchKeyPayload());
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const rawSource = readStringParam(params, "source");
      const source = rawSource ? resolveGrokSearchSource(rawSource) : "web";
      if (!source) {
        return jsonResult(invalidGrokSourcePayload());
      }
      const model = resolveGrokSearchModel(grokSearch);
      const timeoutSeconds = resolveTimeoutSeconds(
        grokSearch?.timeoutSeconds,
        DEFAULT_TIMEOUT_SECONDS,
      );
      const cacheTtlMs = resolveCacheTtlMs(
        grokSearch?.cacheTtlMinutes,
        DEFAULT_GROK_CACHE_TTL_MINUTES,
      );
      const inlineCitations = resolveGrokSearchInlineCitations(grokSearch);

      try {
        const result = await runGrokSearch({
          toolCallId,
          query,
          source,
          apiKey,
          model,
          timeoutSeconds,
          cacheTtlMs,
          inlineCitations,
          config: options?.config,
          signal,
        });
        return jsonResult(result);
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        return jsonResult(grokSearchErrorPayload(normalizeGrokError(err)));
      }
    },
  };
}

export const __testing = {
  resolveGrokSearchApiKey,
  resolveGrokSearchModel,
  resolveGrokSearchInlineCitations,
  resolveGrokSearchSource,
  extractGrokContent,
} as const;
