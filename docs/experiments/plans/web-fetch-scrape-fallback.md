---
summary: "Plan: add a scraping-get fallback between direct web_fetch extraction and Firecrawl"
read_when:
  - Planning web_fetch reliability improvements for bot-blocked or extraction-failed pages
  - Adding a custom scrape backend without weakening current SSRF protections
owner: "openclaw"
status: "draft"
last_updated: "2026-04-16"
title: "Web Fetch SCRAPE API Fallback"
---

# Web Fetch SCRAPE API Fallback Plan

## Summary

Add a **scraping-get fallback** to `web_fetch` between local extraction and Firecrawl:

1. direct fetch + Readability
2. scraping-get
3. Firecrawl

This is intended to reduce user-visible failures for cases such as `HTTP 403`,
`fetch failed`, `HTTP 406`, redirect-limit failures, and extraction failures, while keeping
the current SSRF/private-network blocking behavior unchanged.

## Current Architecture

Today `web_fetch` works like this:

1. Run `fetchWithSsrFGuard` against the target URL.
2. If the response is HTML, try local Readability extraction.
3. If direct fetch fails, the response is non-2xx, or Readability returns no content, try
   Firecrawl when configured.
4. If SSRF protection blocks the URL, fail immediately.

That means there is only one remote fallback today. When Firecrawl is unavailable, not
configured, or cannot recover the page, the tool still fails even for cases where a simpler
internal scrape backend could have succeeded before spending Firecrawl capacity.

## Goals

- Reduce `web_fetch` failure rate without changing the public tool shape.
- Keep the existing `web_fetch` payload shape and cache behavior.
- Preserve the current SSRF/private-network guard as a hard security boundary.
- Make the new fallback easy to enable through environment configuration.

## Non-goals

- Replace Firecrawl.
- Change `web_fetch` request parameters.
- Allow the fallback service to bypass SSRF or internal-network restrictions.
- Introduce per-status-code policy tuning in the first iteration.

## Security Boundary

The SSRF boundary must be stated explicitly because the planned scraping-get endpoint is an
internal service such as `http://172.16.120.252:8011`.

There are two different network hops in the proposed design:

1. OpenClaw -> `SCRAPE_API_BASE_URL`
2. scraping-get -> user-provided target URL

The rules are:

- SSRF validation continues to apply to the **user-provided target URL**
- SSRF validation does **not** apply to the operator-configured `SCRAPE_API_BASE_URL`
- requests to `SCRAPE_API_BASE_URL` must not use `fetchWithSsrFGuard`, because the service
  may intentionally live on a private/internal address
- before sending a target URL to scraping-get, OpenClaw should still apply the same local
  SSRF decision it applies to direct fetches
- the scraping-get service should also enforce SSRF policy server-side as a second line of
  defense

This avoids two failure modes:

- accidentally blocking the trusted scraping service because it lives on a private IP
- accidentally weakening SSRF protections for the user-provided target URL

## Proposed Changes

### 1. Add scraping-get env-based config

Do not add a new `tools.web.fetch.scrape.*` config block in the first iteration.

Enable scraping-get only through:

- `SCRAPE_API_BASE_URL`

Behavior:

- if `SCRAPE_API_BASE_URL` is unset, scraping-get is treated as unavailable
- if `SCRAPE_API_BASE_URL` is set, scraping-get is enabled automatically
- Firecrawl keeps the current enablement model exactly as-is:
  `tools.web.fetch.firecrawl.*` and `FIRECRAWL_API_KEY`
- scraping-get timeout should reuse the existing `tools.web.fetch.timeoutSeconds`
  resolution path instead of introducing a new timeout config in v1

This keeps the first iteration small and avoids expanding the user-facing config surface.

### 2. Keep fallback ordering explicit

Use scraping-get as the **second-layer fallback** and keep Firecrawl as the final remote
fallback:

1. direct fetch succeeds and local extraction succeeds: return immediately
2. direct fetch succeeds but extraction fails: try scraping-get, then Firecrawl
3. direct fetch fails or returns non-2xx: try scraping-get, then Firecrawl
4. if scraping-get is unavailable: go directly to Firecrawl
5. if Firecrawl is disabled or unavailable: keep the best previous failure

### 3. Keep SSRF blocked as hard-fail

`SsrFBlockedError` remains a hard failure and must not call SCRAPE.

This preserves the current guarantee that `web_fetch` cannot be used to reach
private/internal/special-use target addresses through a secondary backend.

### 4. Trigger scraping-get for all non-SSRF fetch failures

The first iteration should treat **all non-SSRF failures** as eligible for scraping-get
fallback:

- `fetch failed`
- HTTP non-2xx such as `403`, `404`, `406`
- redirect-limit failures
- Readability returned no content

If scraping-get fails, Firecrawl should still be attempted when configured.

Do not trigger scraping-get for:

- invalid URL / invalid protocol
- SSRF blocked errors

This keeps the policy simple and aligned with the observed failure distribution.

### 5. Add a scraping-get client helper

Implement a helper parallel to the existing Firecrawl helpers in `src/agents/tools/web-fetch.ts`
or an adjacent helper module:

- `resolveScrapeBaseUrl`
- `resolveScrapeEnabled`
- `fetchScrapeContent`
- `buildScrapeWebFetchPayload`
- `maybeFetchScrapeWebFetchPayload`
- `tryScrapeFallback`

The implementation style should mirror Firecrawl so the control flow stays readable and the
two remote fallbacks can share conventions, but scraping-get should remain env-driven rather
than config-driven.

### 6. scraping-get request contract

Call the service with:

```json
{
  "url": "<target-url>",
  "mode": "get",
  "output": "markdown",
  "timeout_ms": 30000
}
```

Request rules:

- always use `POST`
- always send JSON
- always request `mode: "get"` and `output: "markdown"`
- derive `timeout_ms` from the resolved `tools.web.fetch.timeoutSeconds` in milliseconds
- call the endpoint from `SCRAPE_API_BASE_URL`

Reference curl shape:

```bash
curl --location --request POST 'http://172.16.120.252:8011/api/v1/scrape' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "url": "https://mp.weixin.qq.com/s/WtQKUBPzqxlcToFuZTJtgA",
    "mode": "get",
    "output": "markdown",
    "timeout_ms": 30000
  }'
```

### 7. scraping-get response mapping

Treat the scraping-get call as successful when:

- the HTTP request succeeds
- the JSON response parses
- `status === "success"`
- `content` is a non-empty string

Map a successful scraping-get response into the normal `web_fetch` payload shape:

- `text`: `content`
- `extractor`: `"scraping-get"`
- `contentType`: `"text/markdown"`
- `finalUrl`: response `url` when present, otherwise the fallback input URL
- `status`: response `http_status` when present, otherwise the upstream fallback status or `200`
- `title`: unset
- `warning`: optional non-sensitive summary only when needed
- `externalContent`: use the same `web_fetch` untrusted-content wrapping
- `truncated/rawLength/wrappedLength`: reuse the existing wrapping/truncation path

`extractMode` handling:

- `markdown`: use `content` directly
- `text`: run `markdownToText(content)`

### 8. Error handling expectations

If scraping-get fails, do not replace a useful primary error with a vague fallback error.

Expected behavior:

- preserve the original fetch/extraction failure as the main error
- include scraping-get / Firecrawl failure details only as secondary context when they add
  signal
- never surface a bare "fallback failed" message if the original error is more actionable

## Test Plan

Add coverage around the current `web_fetch` fallback tests to prove the new chain works and
does not weaken security:

- direct fetch throws `fetch failed`, scraping-get succeeds, Firecrawl is not called
- direct fetch returns `403`, scraping-get fails, Firecrawl succeeds
- direct fetch returns `404`, scraping-get still succeeds as configured fallback
- HTML body yields no Readability content, scraping-get succeeds
- redirect-limit failure falls through to scraping-get
- `SsrFBlockedError` does not call scraping-get or Firecrawl
- scraping-get returns non-success status and falls through to Firecrawl
- scraping-get returns empty `content` and falls through to Firecrawl
- `extractMode: "text"` converts scraping-get markdown to plain text
- scraping-get success writes to the normal `web_fetch` cache key
- all fallback layers fail and the final error still preserves the original cause

## Acceptance Criteria

- `web_fetch` succeeds for representative 403/network/extraction failures when
  `SCRAPE_API_BASE_URL` is set and the scraping service returns usable content.
- `web_fetch` behavior is unchanged when `SCRAPE_API_BASE_URL` is not configured.
- SSRF/private-network blocked URLs still fail immediately without hitting scraping-get or
  Firecrawl.
- Returned payloads keep the existing `web_fetch` structure, wrapping, truncation, and cache
  semantics.

## Assumptions

- The scraping-get backend is trusted infrastructure and does not require auth headers in the
  first iteration.
- Firecrawl remains the final fallback and keeps its current config model.
- SSRF blocked failures remain hard-fail by design.
- The initial policy is intentionally broad: all non-SSRF runtime failures are eligible for
  scraping-get fallback.
