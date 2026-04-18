# atlas benchmark

reproducible head-to-head benchmark of atlas vs a text-search baseline
on real OSS codebases. companion to `docs/CAPABILITIES.md`, which
covers atlas-only capabilities (call-tracing, blast radius, etc.) that
text search cannot reasonably attempt.

**this document is a work in progress** — phase B of the benchmark
plan. results below are the comparable subset; atlas-only capabilities
live in `CAPABILITIES.md`.

## methodology

each corpus is a pinned OSS repo (commit SHA in
`bench-eval/corpora/<name>/manifest.json`). atlas indexes it, then we
run a fixed task set:

- 6 capability categories per corpus, mirroring the structure CBM uses
  (indexing / discovery / code-access / call-tracing / graph-querying /
  file-navigation)
- each task ships an `expected` value (typed) and a
  `comparable_to_text_search` flag
- tasks flagged comparable get a `text_search_strategy` (rg or glob)
  and feed both this document's aggregate and a head-to-head delta
- non-comparable tasks (the ones text search can't reasonably do) feed
  `CAPABILITIES.md` instead and never contribute to the comparable
  aggregate

scoring: F1 over symbol/file sets, count within tolerance, structural
predicates over JSON shape. all in `[0, 1]`. no LLM in the loop —
phase C wires that as a separate appendix.

**baseline naming**: we call it the "text-search baseline" everywhere,
not "neutral baseline." `Bun.glob` + `rg` + `Bun.file().text()` is a
lower bound on what a grep-based agent can do, not what an experienced
human or an ast-grep user could. see codex review notes in
`/.claude/plans/fizzy-baking-sphinx.md`.

## reproduction

```bash
git clone https://github.com/<your>/atlas
cd atlas
bun install
bun run bench-eval --all
```

every result writes to `bench-eval/results/<commit>-<timestamp>.json`.
the latest published numbers are committed to that directory so
historical regression diffs stay auditable.

## corpora

| name    | language(s) | files | symbols | edges  | pinned ref |
|---------|-------------|------:|--------:|-------:|------------|
| ripgrep | rust        |    98 |   3,476 | 11,093 | `4649aa97` |
| zod     | typescript  |   339 |   5,217 | 21,126 | `7baee4e1` |

(more corpora land in follow-up commits — django, next.js, plus one
structurally awkward repo per the codex pushback to avoid only-famous
selection.)

## results: comparable tasks

results below are the latest run on each corpus — see
`bench-eval/results/` for raw JSON.

**ripgrep**

| task                              | capability       | atlas | text-search | delta |
|-----------------------------------|------------------|------:|------------:|------:|
| ripgrep-01-indexing               | indexing         |  1.00 |        1.00 |  0.00 |
| ripgrep-02-discovery              | discovery        |  1.00 |        1.00 |  0.00 |
| ripgrep-03-code-access            | code-access      |  1.00 |        0.00 | +1.00 |
| ripgrep-06-file-navigation        | file-navigation  |  1.00 |        1.00 |  0.00 |
| **AGGREGATE**                     |                  |  1.00 |        0.75 | +0.25 |

**zod**

| task                              | capability       | atlas | text-search | delta |
|-----------------------------------|------------------|------:|------------:|------:|
| zod-01-indexing                   | indexing         |  1.00 |        1.00 |  0.00 |
| zod-02-discovery                  | discovery        |  1.00 |        1.00 |  0.00 |
| zod-03-code-access                | code-access      |  1.00 |        0.00 | +1.00 |
| zod-06-file-navigation            | file-navigation  |  1.00 |        1.00 |  0.00 |
| **AGGREGATE**                     |                  |  1.00 |        0.75 | +0.25 |

**combined (2 corpora, 8 comparable tasks)**

| metric                            |  atlas | text-search |  delta |
|-----------------------------------|-------:|------------:|-------:|
| comparable aggregate              |   1.00 |        0.75 |  +0.25 |

text-search loses on `code-access` for both corpora — the rg pattern
needs the exact full signature shape to match, while atlas resolves
the symbol via its qualified name. text-search ties on the other 3
capabilities. atlas-only capability tasks (call-tracing,
graph-querying) score 1.00 across both corpora — see `CAPABILITIES.md`.

## what's next

- 4-corpus complete set (django + next.js + 1 awkward) before
  publishing aggregate-across-corpora numbers
- phase B engine perf table (cold + incremental indexing latency, peak
  RSS, db size per kloc, unresolved-edge rate, query latency)
- phase C LLM appendix (claude haiku via OpenRouter, opt-in)

## what we explicitly are NOT claiming

- atlas does not support 66 languages. the published number is the
  count atlas actually indexes today (TS/JS, Python, Go, Rust). any
  benchmark expansion must clear the new extractor's correctness gate
  in `bench/` first.
- the comparable aggregate above does not include atlas-only
  capabilities. mixing them would produce a flattering but dishonest
  number. see `CAPABILITIES.md` for the atlas-only showcase.
- the text-search baseline is a lower bound, not what a skilled human
  or a structural search tool (ast-grep, semgrep) would produce.
