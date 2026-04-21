---
summary: "Plan: expose Brave web_search and Grok grok_search side by side, with tool descriptions guiding model choice instead of auto-routing"
read_when:
  - Planning Grok search integration without changing Brave web_search behavior
  - Deciding whether Brave and Grok search should be separate public tools
  - Designing tool descriptions to steer models toward structured search vs synthesized real-time search
owner: "openclaw"
status: "draft"
last_updated: "2026-04-17"
title: "Web Search And Grok Search Dual-Tool Plan"
---

# Web Search And Grok Search Dual-Tool Plan

## Summary

Extract Grok search from the existing `web_search` provider routing into its own
separate public tool `grok_search`, so Brave and Grok operate side by side.

The public tool surface becomes:

- keep `web_search` as the Brave-only search tool (remove Grok and Perplexity
  routing from it)
- add `grok_search` as a second public search tool backed by xAI Grok
- use tool descriptions with example queries to steer models toward the right
  tool
- do not silently switch a Brave-shaped request into a Grok-shaped response

This keeps Brave's structured search behavior stable while letting Grok search
exist as a first-class tool for real-time, social, and synthesized-answer use
cases.

## Why This Direction

The current single-tool routing creates a contract problem:

- Brave returns structured `results[]` entries with `title`, `url`, and
  `description`
- Grok returns synthesized `content` plus `citations`
- auto-routing would let the same public tool name return different shapes
  depending on internal heuristics

That is a bad fit for downstream consumers, future UI work, and tool docs.

Separate public tools are cleaner because:

- `web_search` can keep its Brave-oriented structured-results contract
- `grok_search` can expose Grok's native synthesized-answer contract
- models can still choose the better tool based on description and prompting
- no caller has to wonder whether a Brave-looking request was silently routed to
  a different provider

## Current State

Grok search already exists inside `web-search.ts` as one of three providers
(`brave`, `perplexity`, `grok`) behind the `web_search` tool. Key details:

- routed via `tools.web.search.provider` config (`"brave"` | `"perplexity"` |
  `"grok"`)
- calls `https://api.x.ai/v1/responses` directly via `fetch` (not ai-sdk)
- uses `tools: [{ type: "web_search" }]` in the request body (no `x_search`
  support)
- default model: `grok-4-1-fast` (ref: `web-search.ts:33`)
- API key resolution: config `apiKey` first, then `XAI_API_KEY` env var (ref:
  `web-search.ts:373-379`)
- response parsing via `extractGrokContent()`: walks `output[].content[]` blocks
  for `output_text` type, extracts `annotationCitations` from annotations (ref:
  `web-search.ts:147-162`)
- response shape: `{ content, citations, inlineCitations }` (ref:
  `web-search.ts:569-575`)
- cache key pattern: `grok:{query}:{grokModel}:{grokInlineCitations}` (ref:
  `web-search.ts:599`)
- timeout: configurable via `tools.web.search.timeoutSeconds` (ref:
  `web-search.ts:798`)

This plan extracts the Grok path out of `web_search` into a standalone tool.

## Key Changes

### 1. Keep `web_search` as Brave-only search

`web_search` becomes a Brave-only tool. Remove the Grok and Perplexity provider
routing from it.

Its intended use stays:

- documentation lookups
- finding official pages
- retrieving a list of links
- region-specific and language-specific search
- query refinement followed by `web_fetch`
- structured queries using `site:`, `intitle:`, `filetype:` operators

Recommended description (expanded with example queries to aid model selection):

```
Search the web using Brave Search API. Returns structured results with titles, URLs, and snippets.
Best for: finding documentation, official pages, API references, link discovery, region-specific search, structured queries with operators (site:, intitle:, filetype:).
Examples: "React 19 server components docs", "Python requests library official site", "site:github.com openai cookbook", "intitle:TypeScript handbook"
```

In this plan, `web_search` must not auto-route to Grok or Perplexity.

### 2. Add `grok_search` as a second public tool

Add a new public `grok_search` tool exposed alongside `web_search`.

Its intended use is:

- real-time news
- public reaction and sentiment
- trend spotting
- social/web discussion synthesis
- X/Twitter lookups
- natural language queries where a synthesized answer is more useful than a link
  list

Recommended description (expanded with example queries):

```
Search the web using xAI Grok for synthesized answers with citations.
Best for: recent news, live developments, public reaction, sentiment, trends, X/Twitter discussion, natural language queries.
Note: does not support search operators like site:, intitle:, filetype:. For structured/operator-based queries, use web_search instead.
Examples: "latest OpenAI announcements", "what are people saying about Tesla earnings", "news about AI regulation 2026"
```

The description explicitly calls out the operator gap to steer models toward
`web_search` for `site:`-style queries, avoiding the need for automatic
routing.

### 3. SDK path: PoC-first validation

v1 uses a PoC-first approach to decide between ai-sdk and direct fetch:

**Validation criteria (must all pass for ai-sdk migration):**

1. `@ai-sdk/xai` can stably inject Grok `web_search` tool via
   `provider.responses(model)`
2. `@ai-sdk/xai` can stably inject Grok `x_search` tool
3. The SDK response provides sufficient citation / annotation information to
   produce the canonical `content + citations + inlineCitations` output

**If validation passes:**

- migrate to `ai` + `@ai-sdk/xai`
- create a small helper around `createXai(...)`
- call `generateText(...)` with `provider.responses(model)`
- add normalization step if SDK response format differs from direct-fetch format

**If validation does not pass:**

- v1 keeps the current direct `fetch` implementation
- ai-sdk migration is deferred to a follow-up version
- rationale: the risk is capability gap (missing x_search support, lost
  annotation data), not minor format differences — normalization cannot fix
  missing capabilities

Use `grok-4-1-fast` as the default Grok search model (matching current default
in `web-search.ts:33`). The model is configurable.

Pass the original user query through as-is in v1. Do not add prompt rewriting
or multi-stage retrieval in this iteration.

### 4. X/Twitter detection: explicit `source` parameter

`grok_search` accepts an optional `source` parameter:

- `source="web"` (default): inject Grok `web_search` tool only
- `source="x"`: inject Grok `x_search` tool (for explicit X/Twitter lookups)

The model or caller must explicitly pass `source="x"` to trigger X/Twitter
search. No heuristic keyword matching or automatic detection.

The tool description should document this:

```
source: (optional) "x" to search X/Twitter posts specifically, "web" (default) for general web search.
```

### 5. System prompt: two fixed variants, per source

Every `grok_search` call must include a system prompt. v1 uses two fixed built-in
prompts (not user-configurable), selected by `source`:

**`source="web"` prompt constraints:**

- You are a real-time search summarizer.
- Answer based on search results. Do not fabricate.
- Do not write preamble phrases like "Here's a summary" or "Based on the
  results".
- Be concise: prefer one paragraph or 3-5 bullet points.
- Prioritize facts, dates, and sources.
- If information is uncertain, say so explicitly.
- Preserve citations in the response.
- Respond in the same language as the user query.

**`source="x"` prompt constraints:**

- You are an X/Twitter sentiment summarizer.
- Summarize discussion themes, main viewpoints, trends, and disagreements.
- Do not present individual posts as verified facts.
- Be concise: prefer one paragraph or 3-5 bullet points.
- Preserve citations in the response.
- Respond in the same language as the user query.

This treats Grok as a "search result synthesizer", not a general chat model.
v1 does not expose prompt customization; the prompts are internal to the tool
implementation.

### 6. Citation normalization

The current implementation already parses Grok's response into `content`,
`citations`, and `inlineCitations` via `extractGrokContent()`. The canonical
contract for `grok_search` output keeps this separation:

```typescript
{
  content: string;          // synthesized answer text (no citation markers)
  citations: string[];      // extracted URL list in order
  inlineCitations?: Array<{ // structured spans when available
    start_index: number;
    end_index: number;
    url: string;
  }>;
}
```

If the ai-sdk response format differs from the current direct-fetch format,
add a normalization step that:

1. Receives the SDK's raw text (which may contain `[[n]](url)` markdown
   citation markers or annotation-based citations)
2. Strips citation markers from `content`
3. Extracts URLs into `citations[]`
4. Populates `inlineCitations` when span positions can be stably recovered;
   omit when they cannot
5. Optionally preserves `rawMarkdownText` for debugging or fallback

**Citation rendering is channel-decided, not tool-forced:**

The tool layer returns only the canonical format above. Each channel decides how
to render based on its capabilities:

- WebChat: rich inline citations using `inlineCitations` (clickable highlighted
  spans)
- Slack: plain mrkdwn body text + numbered Sources list at bottom; no complex
  inline links
- CLI: plain text body + numbered URL list at bottom
- Other channels may optionally use `inlineCitations` to insert `[1]`-style
  markers, but this is the channel's choice, not a tool-layer requirement

Downstream channels receive this canonical contract and render citations in
their own format. The tool layer does not produce channel-specific output.

### 7. Provider integration: v1 independent, reuse auth

v1 implementation approach:

- `grok_search` is a standalone tool implementation, not wired into the
  `ProviderPlugin` / `models.providers` system
- reuse existing xAI auth/key helpers:
  - `XAI_API_KEY` env resolution from `model-auth.ts:308`
  - `resolveGrokApiKey()` pattern from `web-search.ts:373-379`
  - onboarding/auth choice path in `auth-choice.apply.xai.ts`
- do not invent a new "tool-level external service provider" framework

Rationale:

- the existing provider system is oriented around model/auth concerns
  (`ProviderPlugin` covers `auth`, `docsPath`, `models`), not tool-level
  service orchestration
- `grok_search` is a tool implementation, not a general model backend
- v2 can abstract if/when more xAI tools (e.g., `grok_chat`) are added

### 8. Keep provider-native output shapes

Do not normalize Brave and Grok into one fake shared result format.

Expected tool outputs:

- `web_search`
  - Brave-style structured `results[]` with `title`, `url`, `description`
- `grok_search`
  - synthesized `content` (plain text without citation markers)
  - `citations[]` (URL list)
  - `inlineCitations` when available (structured spans)

This means callers can tell, from the tool name alone, whether they are getting
structured search results or a synthesized answer.

### 9. Keep config explicit

Config should reflect that these are separate tools, not one routed tool.

Recommended config structure:

```yaml
tools:
  web:
    search:
      # Brave-backed web_search (existing config, minus provider routing)
      enabled: true
      apiKey: ...
      timeoutSeconds: 30
      cacheTtlMinutes: 60
      # Brave-specific: country, search_lang, ui_lang, freshness, count
    grokSearch:
      # Grok-backed grok_search (new)
      enabled: true # only effective when XAI_API_KEY is available
      apiKey: ... # optional; falls back to XAI_API_KEY env var
      model: "grok-4-1-fast"
      inlineCitations: false
      timeoutSeconds: 30
      cacheTtlMinutes: 0 # default: cache disabled
```

Grok-specific settings live under `tools.web.grokSearch` so the tool can be
enabled, disabled, and configured independently of Brave.

### 10. Legacy config handling: fail fast on cold start, graceful on reload

`web_search` becomes Brave-only in this plan. The old routed-provider config
becomes a breaking change.

**Cold start behavior:**

- if `tools.web.search.provider: "perplexity"` or
  `tools.web.search.provider: "grok"` is detected at startup, refuse to start
  with a clear actionable error
- the error should tell the user to:
  - move Grok settings to `tools.web.grokSearch`
  - switch `web_search` back to Brave config under `tools.web.search`
- docs, configure wizard copy, onboarding copy, and migration notes must be
  updated in the same change

**Running gateway hot reload behavior:**

- if a user edits config to an invalid/legacy state during runtime, do not crash
  the process and do not interrupt active conversations
- log a warning and skip the reload, continuing with the last valid in-memory
  config
- this matches existing gateway reload behavior: invalid config results in
  "config reload skipped (invalid config)", not a crash (ref:
  `src/gateway/config-reload.ts:314`)

**Config changes to remove:**

- remove `tools.web.search.provider`
- remove `tools.web.search.perplexity`
- remove `tools.web.search.grok`
- keep `tools.web.search` for Brave-backed `web_search`
- add `tools.web.grokSearch` for `grok_search`

### 11. Default state and tool registration

Tool registration follows the same pattern as `web_search` (Brave): controlled
by `enabled` config, not by key presence.

- `grok_search` is registered when `tools.web.grokSearch.enabled` is `true`
  (the default), regardless of whether an xAI API key is currently present
- the xAI API key is resolved at execution time, not at registration time:
  config `tools.web.grokSearch.apiKey` first, then `XAI_API_KEY` env var
- if the key is missing, invalid, or expired, the tool call returns a
  structured auth/setup error (matching Brave's behavior: ref
  `src/agents/tools/web-search.ts:230`, `src/agents/tools/web-search.ts:757`)
- the tool is never hidden from the tool list due to key status — it is always
  present when `enabled: true`, just like `web_search` does not disappear when
  `BRAVE_API_KEY` is absent (ref: `src/agents/tools/web-search.ts:732`)

**API key lifecycle:**

- config reload updates the key reference for subsequent turns; no dynamic
  registration/unregistration of the tool itself
- each run builds its tool list from the current config snapshot at run start
  (ref: `src/agents/pi-embedded-runner/run/attempt.ts:362`)
- config reload updates the config snapshot for future runs (ref:
  `src/gateway/config-reload.ts:323`)
- a currently executing run keeps its initial config for the duration of that
  run
- if a key is revoked or expires remotely (not via config change), calls fail
  with an auth error — the tool stays registered
- process environment variable changes (`XAI_API_KEY`) typically require a
  process restart to take effect

### 12. Error handling: tiered by error type

Error handling follows the "explicit boundaries, no silent fallback" principle:

| Error category | Examples                             | Behavior                                                                                                                                                 |
| -------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth / config  | missing key, invalid auth, forbidden | Fail immediately. Return structured error. No retry, no fallback.                                                                                        |
| Transient      | 429 rate limit, timeout, 502/503/5xx | One bounded retry. If still fails, return error with action hint: `grok_search is unavailable right now; try web_search for a link-based search result.` |

No automatic fallback to `web_search`. The action hint is informational only —
the model or user must explicitly choose to retry with `web_search`.

This preserves the design principle from the plan's core direction: tool
boundaries are clear, no hidden heuristics.

### 13. Timeout strategy: configurable in v1, turn-budget-aware later

v1 timeout behavior should stay within the current tool execution contract:

- default `timeoutSeconds`: 30 (conservative; do not default to 60 — too large
  for a tool call)
- apply the configured tool timeout locally, using the same `withTimeout` /
  `AbortSignal` pattern already used by `web_search`
- let the agent turn's existing abort path stop the tool if the overall turn
  times out

Do not assume the tool can read `remainingTurnBudget` in v1. Today the tool
execution contract exposes `toolCallId`, `params`, `signal`, and `onUpdate`,
but not the turn's remaining time budget (ref:
`@mariozechner/pi-agent-core/dist/types.d.ts:114`).

If the runtime later grows an explicit remaining-budget field for tools, a
follow-up can add:

```
effectiveTimeout = min(configuredTimeout, remainingTurnBudget - reserveBuffer)
```

Until that runtime plumbing exists, the plan should not promise
"insufficient remaining turn budget" fast-fail behavior.

### 14. Cache strategy: optional, default off

- default `cacheTtlMinutes`: `0` (cache disabled)
- cache is only active when the user explicitly configures a non-zero value
- cache key composition:

```
grok_search:{query}:{source}:{model}:{inlineCitations}
```

Future parameters (locale, region, search hints, prompt template version) should
also be included in the key when added.

Rationale: Grok returns synthesized answers with strong time-sensitivity
("latest news", "what people are saying right now"). Aggressive caching is a
poor fit. But short-window reuse for repeated queries is still valuable when
opted in.

### 15. Cost control: observability-first, no hard cap in v1

Grok's synthesized answers are significantly more expensive per-call than Brave's
structured results. xAI returns token usage data in each response:

```json
{
  "inputTokens": 17546,
  "outputTokens": 610,
  "totalTokens": 18156,
  "cachedInputTokens": 1174,
  "raw": {
    "input_tokens": 17546,
    "output_tokens": 610,
    "total_tokens": 18156,
    "num_server_side_tools_used": 3
  }
}
```

v1 cost control strategy:

- **Observability (v1):** record per-call metrics:
  - `toolCallId`, `model`, `source` (web/x), `latency`
  - token usage (`inputTokens`, `outputTokens`, `totalTokens`,
    `cachedInputTokens`) from xAI response
  - estimated cost based on token usage
  - if usage data is unavailable for a call, record call count and latency only
    — do not fabricate cost estimates
- **No hard per-turn cap (v1):** the current tool execution architecture lacks
  per-turn concurrent call counting infrastructure:
  - tool execution signature only has `toolCallId` / `params` / `signal` /
    `onUpdate`, no turn-scoped quota context
  - session-level `before_tool_call` hooks and loop detection exist, but not
    turn-level admission control (ref: `src/agents/pi-tools.before-tool-call.ts:67`)
  - implementing a tool-layer lock would require inventing turn identity,
    handling concurrency, retry, abort, and cross-event cleanup — fragile and
    not justified without evidence of abuse
- **Tool description guidance:** descriptions guide the model toward single
  calls per query
- **Follow-up:** if observability data shows clear abuse patterns, add runtime
  strategy with `maxCallsPerTurn` in a future version

Leverage existing cost/usage infrastructure in `src/infra/session-cost-usage.ts`
and `docs/reference/api-usage-costs.md`.

### 16. Tool policy: group:web with structured/synthesized subgroups

Adding `grok_search` is not just a tool-description change. The trust boundary
between `web_search` (sends query to Brave, returns link list) and `grok_search`
(sends query to xAI, returns AI-generated synthesized answer) requires
expressible policy control.

**Policy group design:**

- `group:web` — all web-related tools (coarse-grained kill switch)
  - `web_search`
  - `grok_search`
  - `web_fetch`
- `group:web-structured` — structured search only
  - `web_search`
- `group:web-synthesized` — synthesized search only
  - `grok_search`

This allows administrators to:

- disable all web capability: `tools.deny=["group:web"]`
- allow only Brave link retrieval: `tools.allow=["group:web-structured"]`
- explicitly deny Grok synthesized answers: `tools.deny=["group:web-synthesized"]`
- without having to reference individual tool names

At minimum, also update:

- tool display / discoverability surfaces keyed by tool name
- security / audit exposure reporting so `grok_search` is counted as a
  web-capable tool
- docs and examples that refer to "web tools" or `group:web` so they include
  the new tool and subgroups explicitly

### 17. Tool misselection: describe + log, observe then optimize

v1 strategy has two tracks:

**Track A — Description-level guidance (ship in v1):**

- tool descriptions include example queries and explicit "best for" guidance
- `web_search` description says: "Best for: docs, official pages, link
  discovery, structured queries with operators (site:, intitle:, filetype:)"
- `grok_search` description says: "Best for: recent news, sentiment, X
  discussion, natural language queries. Note: does not support search operators."
- system prompt tool summaries updated accordingly

**Track B — Observability (ship in v1):**

- log every tool call with `toolName`, `args` (query, source), and `toolCallId`
- additionally log operator-mismatch patterns: grok_search calls containing
  `site:`, `intitle:`, `filetype:` operators (informational, not blocking)
- leverage existing tool-call event infrastructure (`agent-events.ts:49`,
  `pi-embedded-subscribe.handlers.tools.ts:212`)
- analyze misselection patterns post-launch to inform description/prompt
  adjustments

Do not add routing guardrails, classifiers, or prompt rewriters in v1.

### 18. Parallel calls: allowed, independent return

Models may call both `web_search` and `grok_search` in the same turn. Both
execute independently and return separately. No tool-layer deduplication or
merging.

The model receives both results and synthesizes a combined answer on its own.
This matches the existing tool pipeline behavior (concurrent tool results
delivered in order, no cross-tool aggregation).

Prompt guidance (soft constraint, not enforced):

> Unless you need both structured links and a synthesized perspective on the
> same topic, prefer one search tool per query.

### 19. Update prompts and docs to teach tool choice

System prompt and tool docs should teach this split clearly:

- use `web_search` when you want a list of links or conventional search results,
  or when using structured operators (`site:`, `intitle:`, `filetype:`)
- use `grok_search` when you want a synthesized answer about recent events,
  social reaction, sentiment, trends, or X/Twitter discussion

This should be reflected in:

- tool descriptions (with example queries and operator compatibility notes)
- system prompt tool summaries
- config docs
- onboarding and configure wizard copy where relevant

The existing system prompt at `system-prompt.ts:263` has very terse summaries
(`"Search the web (Brave API)"`). Update both `web_search` and add `grok_search`
with enough detail to make the right choice obvious to the model.

## Non-Goals

- no auto-routing from `web_search` to Grok in v1
- no requirement that Brave and Grok share an identical response schema
- no fake conversion of Grok answers into Brave-like `title/url/snippet` rows
- no public `x_search` tool in this iteration (handled inside `grok_search`
  via `source="x"`)
- no query rewriting, `site:` augmentation, or retrieval orchestration in v1
- no streaming in v1 (complete return only)
- no silent fallback from `grok_search` to `web_search`
- no integration into the `ProviderPlugin` model-provider system in v1
- no turn-budget-aware timeout cap in v1 without new runtime plumbing
- no hard per-turn call cap in v1 (deferred to runtime strategy when
  justified by observability data)
- no user-configurable Grok system prompt in v1 (fixed built-in prompts only)

## Test Plan

- `web_search`
  - returns Brave structured results as before
  - Grok and Perplexity provider routing is removed from `web_search`
  - keeps `country`, `search_lang`, `ui_lang`, and `freshness` behavior
  - does not attempt Grok routing
- `grok_search`
  - returns synthesized `content` and `citations` in canonical format
  - uses Grok `web_search` tool by default
  - uses Grok `x_search` tool when `source="x"` is passed
  - includes appropriate system prompt per source variant
  - does not stream; returns complete result
  - citation normalization strips markers from content, extracts URLs
- tool registration
  - `grok_search` appears in tool list when `tools.web.grokSearch.enabled` is true, regardless of key presence
  - `grok_search` returns structured auth error when key is missing/invalid, matching Brave's pattern
  - config hot reload updates key reference for subsequent turns
  - running turns keep their initial config
- error handling
  - auth errors fail immediately without retry
  - transient errors retry once then fail with action hint
  - no automatic fallback to `web_search` under any condition
- timeout behavior
  - uses configured tool timeout in v1
  - respects agent-level abort signal when the overall turn times out
  - does not rely on a `remainingTurnBudget` field that tools do not currently receive
- cache
  - default off (`cacheTtlMinutes = 0`)
  - when enabled, cache key includes `query:source:model:inlineCitations`
  - cache misses and hits behave correctly
- cost observability
  - per-call metrics logged: toolCallId, model, source, latency, usage, estimated cost
  - xAI usage data captured when available
  - calls without usage data record call count and latency only
  - operator-mismatch patterns logged (grok_search with site:/intitle:/filetype:)
- parallel calls
  - both `web_search` and `grok_search` can be called in the same turn
  - results returned independently without merging
- config
  - Brave and Grok can be enabled independently
  - missing Brave credentials fail only `web_search`
  - missing Grok credentials: `grok_search` still registered, returns auth error on call
  - legacy `tools.web.search.provider: "perplexity"` fails cold start with clear migration error
  - legacy `tools.web.search.provider: "grok"` fails cold start with clear migration error
  - hot reload with invalid legacy config logs warning and skips reload
- policy
  - `group:web` covers `web_search`, `grok_search`, and `web_fetch`
  - `group:web-structured` covers `web_search` only
  - `group:web-synthesized` covers `grok_search` only
  - `tools.deny=["group:web"]` blocks all three tools
  - `tools.deny=["group:web-synthesized"]` blocks only `grok_search`
- regression checks
  - existing `web_search` callers keep receiving Brave-shaped payloads
  - no existing Brave-only UI or docs path silently changes to Grok semantics
  - `tools.deny=["group:web"]` blocks `grok_search`
  - security/audit reporting includes `grok_search`
  - tool-display / prompt summaries / docs surfaces recognize `grok_search`

## Assumptions

- OpenClaw should expose two public search tools in this change:
  `web_search` and `grok_search`
- `web_search` becomes Brave-only and keeps its structured-results contract
- `grok_search` is allowed to return synthesized-answer output with citations
- explicit X/Twitter lookups are handled inside `grok_search` via `source="x"`,
  not through a separate public `x_search` tool
- v1 should prioritize clear tool boundaries over clever routing
- v1 does not stream; v2 may revisit streaming for better latency UX
- v1 does not integrate into the `ProviderPlugin` system; v2 may abstract if
  more xAI tools are added
- v1 SDK path depends on PoC validation; direct fetch is the fallback
- v1 uses fixed built-in system prompts for Grok, not user-configurable prompts
- v1 does not enforce hard per-turn call caps; observability informs future
  runtime strategy
