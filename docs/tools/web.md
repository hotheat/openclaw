---
summary: "Web search + fetch tools (Brave web_search, xAI grok_search, web_fetch)"
read_when:
  - You want to enable web_search, grok_search, or web_fetch
  - You need Brave Search or xAI API key setup
  - You are migrating from legacy routed web_search provider config
title: "Web Tools"
---

# Web tools

OpenClaw ships three lightweight web tools:

- `web_search` — Brave-backed search that returns structured results (`title`, `url`, `description`).
- `grok_search` — xAI Grok-backed search that returns a synthesized answer plus citations.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## Which tool to use

### `web_search` (Brave)

Use `web_search` when you want:

- documentation or official pages
- a list of links to inspect
- region/language-specific search
- structured queries with operators like `site:`, `intitle:`, `filetype:`

### `grok_search` (xAI Grok)

Use `grok_search` when you want:

- recent news or live developments
- a synthesized answer with citations
- public reaction, sentiment, or trend summaries
- X/Twitter-specific lookups via `source: "x"`

`grok_search` does **not** support search operators like `site:`, `intitle:`,
or `filetype:`. Use `web_search` for those.

### `web_fetch`

Use `web_fetch` after you already have a URL and want extracted page content.

## Legacy migration

OpenClaw no longer routes `web_search` between multiple providers.

The following legacy config is rejected on startup:

- `tools.web.search.provider`
- `tools.web.search.perplexity`
- `tools.web.search.grok`

Migration:

- keep Brave config under `tools.web.search`
- move xAI config to `tools.web.grokSearch`
- use `grok_search` explicitly instead of expecting `web_search` to auto-route

## Getting a Brave API key

1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)
2. Choose the **Data for Search** plan (not “Data for AI”) and generate an API key
3. Run `openclaw configure --section web` to store the key in config, or set `BRAVE_API_KEY`

Recommended config:

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BSA...",
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

## Getting an xAI API key for `grok_search`

1. Create an xAI account and generate an API key
2. Set `XAI_API_KEY` in the Gateway environment, or store it in `tools.web.grokSearch.apiKey`

Recommended config:

```json5
{
  tools: {
    web: {
      grokSearch: {
        enabled: true,
        apiKey: "xai-...",
        model: "grok-4-1-fast",
        inlineCitations: false,
        timeoutSeconds: 30,
        cacheTtlMinutes: 0,
      },
    },
  },
}
```

## `web_search`

Requirements:

- `tools.web.search.enabled` must not be `false`
- `BRAVE_API_KEY` or `tools.web.search.apiKey`

Tool parameters:

- `query` (required)
- `count` (1–10; default from config)
- `country` (optional)
- `search_lang` (optional)
- `ui_lang` (optional)
- `freshness` (optional): `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`

Example:

```javascript
await web_search({
  query: "site:github.com openclaw docs",
  count: 5,
  country: "US",
  freshness: "pw",
});
```

## `grok_search`

Requirements:

- `tools.web.grokSearch.enabled` must not be `false`
- `XAI_API_KEY` or `tools.web.grokSearch.apiKey`

Tool parameters:

- `query` (required)
- `source` (optional): `"web"` (default) or `"x"`

Notes:

- `source: "x"` uses Grok's X/Twitter search path
- responses return synthesized `content`, `citations`, and `inlineCitations` when available
- cache is disabled by default because these answers are often time-sensitive
- there is no automatic fallback to `web_search`

Examples:

```javascript
await grok_search({
  query: "latest OpenAI announcements",
});

await grok_search({
  query: "what are people saying about Tesla earnings",
  source: "x",
});
```

## `web_fetch`

Fetch a URL and extract readable content.

Requirements:

- `tools.web.fetch.enabled` must not be `false`
- optional Firecrawl fallback: `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`

Tool parameters:

- `url` (required, http/https only)
- `extractMode` (`markdown` | `text`)
- `maxChars`

Notes:

- `web_fetch` uses Readability first, then Firecrawl if configured
- `tools.web.fetch.timeoutSeconds` limits each fetch stage (default: 30 seconds)
- `tools.web.fetch.totalTimeoutSeconds` limits the complete attempt, including serial fallbacks; when omitted, it defaults to at least 100 seconds and never below configured stage timeouts
- `web_fetch` does not execute JavaScript
- for JS-heavy sites, prefer the browser tool
- responses are cached by default for 15 minutes
