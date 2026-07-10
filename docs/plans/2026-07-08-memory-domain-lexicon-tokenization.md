# Memory Domain Lexicon Tokenization

## Interview Decisions (2026-07-08)

These decisions were captured in a design interview and take precedence over any
conflicting description below. Sections further down have been updated to match.

1. **Overlapping term matching — keep full retention.** `matchDomainTerms` keeps
   every matching lexicon term as its own `word` token (weight 1.0), including
   overlaps such as `EZH1/2` plus its `EZH1` / `EZH2` splits, or a config term that
   duplicates a built-in term. The resulting duplicate weighting is accepted as a
   recall-favoring tradeoff; no longest-match dedup and no query-side dedup are
   added.
2. **Lexicon scale — no performance protection.** Config lexicons are expected to
   stay under a few hundred terms, so the current `O(terms × text length)`
   substring scan is acceptable. No Aho-Corasick / trie / size cap is introduced.
   The linear cost is recorded as a known scaling limit.
3. **Built-in default terms — move out of code into the workspace, default on.**
   `DEFAULT_INNOVATION_DRUG_TERMS` is no longer hardcoded in
   `src/memory/domain-lexicon.ts`. It moves to a fixed workspace file
   `openclaw-workspace/lexicons/innovation-drug.yaml` and is loaded by default,
   gated by a new `memorySearch.lexicon.includeDefaults` switch (default `true`).
   Setting `includeDefaults: false` skips the default file so non-pharma agents are
   not injected with pharma tokens.
4. **Migration safety — current full-lock behavior is sufficient.**
   `migrate-search-tokens` may keep holding `withPostgresIndexLock` for the whole
   run. No per-batch lock release and no `--dry-run` are added now; dry-run stays in
   Future Work.
5. **Staleness detection — documentation reminder only.** No `lexicon_signature`,
   no startup/search-time warn, no auto-migration. The docs instruct operators to
   run `openclaw memory migrate-search-tokens` after changing the lexicon or
   tokenizer.
6. **`note` extraction — extend to mixed-case entities.** The `note` extractor is
   broadened so mixed-case / lowercase-leading entities such as `siRNA`, `mRNA`, and
   `Kras` are captured, in addition to the existing uppercase-leading technical
   spans and length-≥2 Chinese spans.
7. **Hybrid weighting — keep defaults.** No extra boost for exact-entity hits. The
   default `vectorWeight` 0.7 / `textWeight` 0.3 split stands; docs note that
   pharma-heavy deployments may raise `textWeight`.
8. **Malformed lexicon files — silent degradation.** `loadLexiconFileTerms`
   continues to `log.warn` and proceed on parse/read failure. One bad file must not
   block memory search; a dedicated validation command remains Future Work.

## Summary

This document records the memory search tokenization update for domain-heavy knowledge bases, especially pharmaceutical and biotech company notes. The implementation keeps vector retrieval as the semantic backbone and improves PostgreSQL keyword recall through a configurable domain lexicon, classified search tokens, explicit migration, and safer token-boundary matching.

The core position is:

- Do not depend on PostgreSQL's built-in text parser for Chinese or mixed pharma entities.
- Generate `search_tokens` in application code.
- Store the generated token string in `agent_memory.chunks.search_tokens`.
- Keep query-side tokenization identical to index-side tokenization.
- Recompute stored tokens only through an explicit CLI command.

## Context

The memory system already supports PostgreSQL storage, pgvector semantic retrieval, and `pg_trgm` keyword candidate recall. The weak point was domain entity matching:

- Chinese terms need deterministic matching beyond default PostgreSQL text search.
- Pharma terms often mix Chinese, English, digits, punctuation, and abbreviations.
- Company, drug, target, indication, and modality names need to be controlled by configuration.
- Existing `search_tokens` are persisted, so changing tokenization logic requires a migration path for existing chunks.

The target domain includes innovation drug companies and biomedical entities such as:

- companies: `BeiGene`, `ORIC Pharmaceuticals`, Chinese company aliases
- drugs: `ORIC-944`, `AK112`, `替雷利珠单抗`
- targets: `PD-1`, `PD-L1`, `CLDN18.2`, `EED`, `EZH1/2`
- modalities and clinical terms: `ADC`, `PROTAC`, `CAR-T`, `siRNA`, `NSCLC`, `PFS`, `ORR`

## Goals

- Improve exact and near-exact keyword recall for pharma domain entities.
- Allow user-controlled lexicon terms from config files.
- Avoid reading lexicon files during each recall.
- Avoid startup-time data migration.
- Avoid re-embedding when only `search_tokens` need to be refreshed.
- Keep table structure stable except for the existing `chunks.search_tokens` column.
- Avoid `lexicon_signature` metadata because explicit CLI migration is the chosen freshness boundary.

## Non Goals

- This change does not replace vector retrieval.
- This change does not introduce Jieba or another runtime segmentation dependency.
- This change does not store token type columns separately.
- This change does not add automatic stale-token detection at startup.
- This change does not drop any old database column that may already exist in a local development database.

## Current Pipeline

```text
raw text
  -> normalize per token
  -> match configured domain terms
  -> segment words with Intl.Segmenter
  -> extract generic keywords
  -> generate Chinese bigrams
  -> generate Chinese unigrams
  -> deduplicate by normalized value
  -> keep the highest token weight
  -> serialize into chunks.search_tokens
```

Query uses the same tokenizer:

```text
query
  -> buildSearchTokenEntries(query, domainLexicon)
  -> SQL candidate recall
  -> scoreSearchTokenMatches(queryTokens, row.search_tokens)
  -> hybrid merge with vector results
```

## Token Categories

Tokens are classified in memory, not persisted as separate columns.

```text
word    weight 1.00
bigram  weight 0.35
unigram weight 0.10
```

The scoring formula is normalized by query token weight:

```text
score = matchedWeight / totalQueryWeight
```

This gives high confidence to configured terms and segmented words, while still allowing Chinese bigram and unigram fallback to recover partial recall.

## Domain Lexicon

The domain lexicon has two sources:

- default innovation drug terms, loaded from a workspace file
- config-provided terms (inline `terms` and file `paths`)

The default innovation drug terms are **not** hardcoded in
`src/memory/domain-lexicon.ts`. They live in a fixed workspace file:

```text
openclaw-workspace/lexicons/innovation-drug.yaml
```

Loading of that file is controlled by a switch:

```text
memorySearch.lexicon.includeDefaults   (default: true)
```

When `includeDefaults` is `true` (the default), config resolution reads the
default lexicon file and merges its terms ahead of user-provided terms. When set
to `false`, the default file is skipped entirely, so non-pharma agents are not
injected with pharma tokens. `createDomainLexicon` no longer prepends a hardcoded
`DEFAULT_INNOVATION_DRUG_TERMS` array; the defaults arrive as ordinary resolved
terms.

The default file path is resolved relative to the **directory that holds the
active `openclaw.json`** — i.e. `path.dirname(resolveConfigPath())` — so it lands
next to the workspace config regardless of the process cwd. If the file does not
exist, it is skipped silently (an `fs.existsSync` guard, not a warning), because a
missing default lexicon just means the feature is not configured. This keeps a
config-less checkout from emitting per-search warnings and from silently acquiring
pharma terms. User-configured `lexicon.paths` that fail to read still warn (see
Configuration Flow).

Runtime `ResolvedMemorySearchConfig.lexicon` now only carries:

```ts
{
  terms: string[]
}
```

Raw config may still use `lexicon.paths` and `lexicon.terms`, plus the new
`lexicon.includeDefaults` flag. The paths (including the default file when enabled)
are resolved once during memory search config resolution. File contents are parsed
into terms, merged with inline terms, and then passed forward as `terms`.

This prevents per-search file I/O.

### Lexicon scale

Config lexicons are expected to hold at most a few hundred terms. `matchDomainTerms`
performs an `O(terms × text length)` substring scan per chunk at index time and per
query at search time. This is accepted for the expected scale; no multi-pattern
optimization (Aho-Corasick, trie) or size cap is added. If a deployment grows into
the thousands of terms, that linear cost is a known limit to revisit.

### Overlapping term matching

Every lexicon term that is a substring of the text becomes its own `word` token
(weight 1.0). Overlapping terms — e.g. `EZH1/2` together with its split `EZH1` /
`EZH2`, or a config term that duplicates a default term — are all retained. This can
let a single text span satisfy multiple query tokens and be counted more than once.
The behavior is intentional and favors recall; no longest-match-wins dedup or
query-side collapsing is applied.

## Lexicon File Parsing

Lexicon files can be YAML or JSON-like structured documents. The parser extracts strings from domain-oriented keys:

```text
aliases
category
companies
company
companyType
drug
drugs
indication
indications
modality
modalities
name
target
targets
term
terms
```

For `note`, extraction is intentionally narrower than domain-key extraction, but
still covers the common entity shapes. `collectNoteTerms` now applies four passes:

1. **Uppercase-leading technical spans** — `\b[A-Z][A-Za-z0-9]*(?:[-./][A-Za-z0-9]+)*(?:\.[0-9]+)?`,
   kept only when `isUppercaseTechnicalSpan` holds (≥2 uppercase letters, or a
   digit, or a `- . /` separator). This keeps `EED`, `PD-1`, `CLDN18.2`, `CAR-T`,
   `HER2-low`, `TROP2` while dropping plain Title-case words like `Company`. The
   `\b` anchor prevents slicing `RNA` out of `siRNA`.
2. **Lowercase-leading mixed-case entities** — `[a-z]+[A-Z][A-Za-z0-9]*` captures
   `siRNA`, `mRNA`, `miRNA`, `shRNA`, `sgRNA`, `dsRNA`.
3. **Title-case single words** — `\b[A-Z][a-z]{2,}\b` captures `Kras`, `Myc`,
   guarded by a small `NOTE_TITLECASE_STOPWORDS` set (the, study, phase,
   pharmaceuticals, …) so ordinary prose does not leak in.
4. **Chinese spans** of length at least 2.

This is heuristic by design; the stopword guard trades a little recall for far less
prose noise in the free-text `note` field.

Values are also split on common delimiters such as parentheses, Chinese punctuation, commas, semicolons, and enumeration separators. This turns values like `PRC2 (EED, EZH1/2)` into useful sub-terms.

## Search Token Storage

`search_tokens` are stored in:

```text
agent_memory.chunks.search_tokens
```

The stored value is a space-separated serialized token string.

Spaces and selected separators inside token values are escaped before joining:

```text
oric pharmaceuticals -> oric~20pharmaceuticals
a_b%~                -> a~5fb~25~7e
```

The tokenizer output is persisted because search needs to run quickly without re-tokenizing every stored chunk.

## SQL Candidate Recall

Candidate recall uses the stored `search_tokens` field.

The safer boundary match is:

```sql
(' ' || search_tokens || ' ') ILIKE ANY($patterns)
```

Patterns are generated as:

```text
% serializedToken %
```

This avoids substring false positives. For example, query token `egfr` should not count as a full-token match against stored token `egfrviii`.

When `pg_trgm` is available, `similarity(search_tokens, serializedQueryTokens) > 0` remains as a broad candidate path. Results are still filtered by `scoreSearchTokenMatches(...) > 0` before returning, so trigram-only substring hits do not become text-score matches.

## PostgreSQL FTS Position

PostgreSQL has full text search and related extensions, but this implementation does not use PostgreSQL's language parser as the source of truth.

The chosen split is:

- PostgreSQL stores and searches the generated token string.
- Application code owns tokenization and domain vocabulary.
- `pg_trgm` is used for coarse candidate recall, not linguistic segmentation.
- Exact scoring is done in TypeScript against deserialized tokens.

This is more predictable for Chinese and pharma mixed-script entities.

## Explicit Migration

Changing tokenization logic affects stored `chunks.search_tokens`. Existing rows should be migrated explicitly:

```bash
openclaw memory migrate-search-tokens
```

The command:

- initializes the memory manager
- locks the PostgreSQL index (held for the full run — accepted per interview
  decision 4; large-table blocking is tolerated, no per-batch lock release)
- reads existing chunks by `agent_id` and configured `sources`
- recomputes `search_tokens` from `chunks.text`
- updates only rows whose token string changed
- does not re-chunk
- does not recompute embeddings
- does not write tokenizer or lexicon signatures to `index_meta`

Operators are expected to run this command after any lexicon or tokenizer change.
There is no automatic staleness detection or warning (interview decision 5); the
reminder lives in the CLI docs (`docs/cli/memory.md`, `docs/zh-CN/cli/memory.md`).

The result reports:

```text
migrated: rows updated
skipped: rows already matching current tokenization
```

## Why No lexicon_signature

`lexicon_signature` was considered because `search_tokens` are persisted and depend on tokenizer plus lexicon terms.

It was removed because the selected operational model is explicit migration:

- startup does not auto-migrate stored data
- `sync()` does not trigger full reindex for lexicon changes
- CLI migration always recomputes against current code and current resolved terms
- no stale-state metadata is needed to decide whether migration should run

If a local database already has a `lexicon_signature` column from development, it is harmless. Current code no longer creates, reads, or writes it.

## API Shape

`search-lexemes.ts` now exposes the smaller tokenizer surface:

```ts
buildSearchTokenEntries(text, lexicon);
buildSearchTokenValues(text, lexicon);
serializeSearchTokens(tokens);
deserializeSearchTokens(serialized);
scoreSearchTokenMatches(queryTokens, serializedTokens);
```

Removed wrapper names:

```text
buildKeywordQueryTokens
buildKeywordQueryTokenEntries
```

Indexing and query now share the same tokenizer entrypoints.

## Configuration Flow

```text
openclaw config
  -> defaults.memorySearch.lexicon.paths / terms / includeDefaults
  -> agent override memorySearch.lexicon.paths / terms / includeDefaults
  -> resolveMemorySearchConfig
  -> if includeDefaults (default true): prepend openclaw-workspace/lexicons/innovation-drug.yaml
  -> read lexicon files once (default file + user paths)
  -> extract terms   (parse failure -> log.warn, continue with remaining terms)
  -> merge default terms, inline terms, and file terms
  -> ResolvedMemorySearchConfig.lexicon.terms
  -> createDomainLexicon
  -> PostgresMemoryManager tokenizer
```

Malformed or missing lexicon files degrade silently: `loadLexiconFileTerms`
logs a warning and continues so a single bad file never blocks memory search.

## Database Flow

```text
index file or session chunk
  -> chunk.text
  -> buildSearchTokenValues(text, domainLexicon)
  -> serializeSearchTokens(values)
  -> INSERT/UPDATE agent_memory.chunks.search_tokens

search query
  -> buildSearchTokenEntries(query, domainLexicon)
  -> SQL boundary candidate recall
  -> scoreSearchTokenMatches(queryTokens, row.search_tokens)
  -> mergeHybridResults(vector, keyword)
```

## Validation

Focused tests cover:

- domain YAML extraction
- configured company, drug, target, and note alias terms
- `note` extraction of mixed-case entities (`siRNA`, `mRNA`, `Kras`)
- `includeDefaults` switch: default file loaded when true, skipped when false
- default innovation drug terms sourced from the workspace file, not hardcoded
- malformed / missing lexicon file degrades silently (warn, terms omitted)
- classified word, bigram, and unigram token weights
- serialized token escaping
- PostgreSQL search-token migration
- no full reindex for tokenizer or lexicon changes
- token-boundary candidate matching, including `EGFR` not matching `egfrviii`
- CLI wiring for `memory migrate-search-tokens`

Validation commands used:

```bash
pnpm exec vitest run src/memory/search-lexemes.test.ts src/memory/postgres-manager.test.ts src/cli/memory-cli.test.ts src/cli/argv.test.ts src/agents/memory-search.test.ts
pnpm exec vitest run --config vitest.unit.config.ts src/memory/postgres-schema.test.ts src/memory/search-manager.test.ts
pnpm typecheck
make lint
```

## Tradeoffs

### Jieba

Jieba-style segmentation can be useful for general Chinese text, but it is not currently necessary as a runtime dependency because:

- domain entities are better handled by explicit lexicon terms
- vector retrieval already covers semantic recall
- n-gram fallback covers unknown Chinese partial matches
- adding a segmentation dependency increases packaging and runtime variability

The current design keeps the door open for future pluggable segmentation, but does not require it.

### N-gram

N-gram remains useful as fallback recall. It should not dominate scoring.

The current weights reflect that:

- word/domain matches dominate
- bigrams help phrase fragments
- unigrams are low-confidence fallback

### Technical spans

A separate "technical span extraction" stage is not required as a standalone pipeline step for the current domain. Technical entities are handled through:

- configured lexicon terms
- default innovation drug terms (workspace file, `includeDefaults` gated)
- `note` extraction rules (now including mixed-case entities)
- generic keyword extraction
- punctuation-aware term splitting

### Hybrid weighting

Keyword text scores are normalized to `0..1` and merged with vector scores using the
default `vectorWeight` 0.7 / `textWeight` 0.3 split. No extra boost is given to
exact-entity (`word`) matches (interview decision 7). Improved keyword recall can
still be outweighed by the vector component; pharma-heavy deployments that want
exact entity matches to rank higher should raise `memorySearch.query.hybrid.textWeight`
via config rather than relying on a hardcoded boost.

## Future Work

- Consider a shared base tokenizer between `query-expansion.ts` and `search-lexemes.ts`.
- Consider optional pluggable Chinese segmentation if domain data shows n-gram fallback is too noisy.
- Consider storing token categories separately only if SQL-side weighted scoring becomes necessary.
- Consider a CLI dry-run mode for `migrate-search-tokens`.
- Consider a lexicon validation command that prints extracted terms before migration.

### Medium Term: OpenSearch Store Driver

Add `memorySearch.store.driver: "opensearch"` as an independent memory store implementation.
The goal is to use OpenSearch's lexical analyzers instead of expanding local Chinese
segmentation logic.

The intended shape is an `OpenSearchMemoryManager` parallel to the existing SQLite
and PostgreSQL managers:

```text
sync file/session chunk
  -> shared chunking and source filtering
  -> embedBatch through the existing EmbeddingProvider
  -> OpenSearch document upsert
       text fields indexed with analyzer such as ik_max_word or smartcn
       vector field indexed with OpenSearch kNN support

search query
  -> OpenSearch lexical query using the configured analyzer
  -> embedQuery through the existing EmbeddingProvider
  -> OpenSearch vector query
  -> mergeHybridResults(vector, keyword)
```

This driver should not force OpenSearch to emit the same `search_tokens` string used
by PostgreSQL. OpenSearch should own analyzer-based tokenization inside the index.
The TypeScript tokenizer in `search-lexemes.ts` remains the SQLite/PostgreSQL
fallback and the deterministic path for deployments without OpenSearch.

Configuration should be additive, for example:

```ts
memorySearch: {
  store: {
    driver: "opensearch",
    opensearch: {
      node: "http://localhost:9200",
      index: "openclaw-memory",
      analyzer: "ik_max_word"
    }
  }
}
```

OpenSearch implementation boundaries:

- Reuse the existing `EmbeddingProvider`; do not create a second embedding strategy
  abstraction.
- Reuse existing chunking, source selection, lexicon loading, and hybrid merge code
  where possible.
- Let OpenSearch analyzers handle Chinese segmentation and synonym expansion.
- Keep PostgreSQL `search_tokens` migration unchanged; OpenSearch indexing is a
  separate reindex path.

### Long Term: MemoryIndexBackend Interface

After OpenSearch proves the backend boundary, extract the common index/search
contract behind SQLite, PostgreSQL, and OpenSearch. The interface should model
storage and retrieval capabilities, not tokenizer internals.

The target contract should cover:

```ts
type MemoryIndexBackend = {
  initStore(): Promise<void>;
  upsertChunks(chunks: IndexedMemoryChunk[]): Promise<void>;
  deletePath(path: string, source: MemorySource): Promise<void>;
  searchKeyword(query: string, limit: number): Promise<KeywordMemoryResult[]>;
  searchVector(queryVec: number[], limit: number): Promise<VectorMemoryResult[]>;
  status(): MemoryProviderStatus;
  probe(): Promise<{ lexical: boolean; vector: boolean }>;
  close?(): Promise<void>;
};
```

The manager layer would then own the shared orchestration:

```text
read files/sessions
  -> chunk
  -> call EmbeddingProvider for vectors when available
  -> backend.upsertChunks

search
  -> backend.searchKeyword
  -> EmbeddingProvider.embedQuery
  -> backend.searchVector
  -> mergeHybridResults
```

This keeps the dependency direction explicit:

- `EmbeddingProvider` owns vector generation.
- `MemoryIndexBackend` owns persistence, lexical recall, vector recall, and backend
  capability probing.
- `mergeHybridResults` stays backend-independent.
- Analyzer/tokenizer details remain backend-specific: PostgreSQL may keep
  `search_tokens`, SQLite may keep FTS helpers, and OpenSearch may rely on
  `ik_max_word`, `smartcn`, or another configured analyzer.
