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
