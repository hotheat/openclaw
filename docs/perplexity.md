---
summary: "Perplexity Sonar is no longer supported for web_search"
read_when:
  - You are migrating from old Perplexity web_search config
  - You are looking for the replacement after routed web_search providers were removed
title: "Perplexity Sonar (Removed)"
---

# Perplexity Sonar (removed)

OpenClaw no longer supports Perplexity as a `web_search` provider.

`web_search` is now always Brave-backed, and Grok-based synthesized search lives
in the separate `grok_search` tool.

## What changed

- removed: `tools.web.search.provider`
- removed: `tools.web.search.perplexity`
- removed: automatic provider routing inside `web_search`

## Migration

If your old config looked like this:

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
        },
      },
    },
  },
}
```

Update it to one of these patterns:

```json5
// Structured link search
{
  tools: {
    web: {
      search: {
        apiKey: "BSA...",
      },
    },
  },
}
```

```json5
// Synthesized search with citations
{
  tools: {
    web: {
      grokSearch: {
        apiKey: "xai-...",
      },
    },
  },
}
```

See [Web tools](/tools/web) for the current supported setup.
