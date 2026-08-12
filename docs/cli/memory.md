---
summary: "CLI reference for `openclaw memory` (status/index/search)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory postgres status
OPENCLAW_MEMORY_MIGRATION_URL='postgresql://...' openclaw memory postgres migrate
openclaw memory migrate-search-tokens
openclaw memory search "release checklist"
openclaw memory search --query "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents).
- `--verbose`: emit detailed logs during probes and indexing.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory migrate-search-tokens` re-tokenizes existing PostgreSQL memory chunks without re-embedding.
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.

## PostgreSQL schema management

PostgreSQL memory runtime connections use the dedicated URL configured at
`memorySearch.store.postgres.url`, normally `${MEMORY_DB_URL}`. Gateway startup
and ordinary memory commands only validate the existing schema. They do not
create extensions, tables, columns, or indexes.

Validate the configured schema with the runtime account:

```bash
openclaw memory postgres status
openclaw memory postgres status --schema agent_memory --json
```

Run schema DDL and one-time vector backfills with temporary administrator
credentials:

```bash
OPENCLAW_MEMORY_MIGRATION_URL='postgresql://...' \
  openclaw memory postgres migrate --schema agent_memory --vector-dims 1024
```

`OPENCLAW_MEMORY_MIGRATION_URL` is required for migration and is never read by Gateway startup.
Migration does not fall back to `MEMORY_DB_URL`.
For an empty vector-enabled store, `--vector-dims` is required so migration can create the first dimension-specific HNSW index before runtime writes metadata.
Existing stores infer dimensions from `index_meta`; supplying the option also pre-creates the index for that dimension.

## Domain lexicon

Keyword tokenization can be steered by a domain lexicon so high-signal entities
(companies, drugs, targets, indications, modalities) survive as whole search tokens.

- `memorySearch.lexicon.includeDefaults` (default `true`): loads the built-in
  innovation-drug lexicon from `<workspace>/lexicons/innovation-drug.yaml` — the
  `lexicons/` directory next to your `openclaw.json`. Set to `false` to skip these
  pharma terms for non-pharma agents. A missing file is ignored silently.
- `memorySearch.lexicon.paths`: extra YAML/JSON lexicon files (companies, drugs,
  targets, indications, modalities, aliases, notes).
- `memorySearch.lexicon.terms`: inline terms merged with the file terms.

After changing the lexicon (or upgrading the tokenizer), run
`openclaw memory migrate-search-tokens` so already-indexed chunks are re-tokenized.
There is no automatic staleness detection.
