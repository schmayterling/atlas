# atlas benchmark

reproducible head-to-head benchmark of atlas vs a text-search baseline
on real OSS codebases. companion to `docs/CAPABILITIES.md`, which
covers atlas-only capabilities (call-tracing, blast radius, etc.) that
text search cannot reasonably attempt.

**this document covers phases A + B + C** of the benchmark plan.
results below are the comparable subset; atlas-only capabilities live
in `CAPABILITIES.md`.

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

## engine perf (phase B)

measured by `bun run bench-headline` on M-series macOS, github
ingest disabled, summaries / embeddings off.

| corpus  | files | symbols | edges  | cold index | peak rss | db size | unresolved edges |
|---------|------:|--------:|-------:|-----------:|---------:|--------:|-----------------:|
| ripgrep |    98 |   3,476 | 11,093 |    ~970 ms |   270 MB |  4.4 MB |             0.0% |
| zod     |   339 |   5,217 | 21,126 |   ~17.4 s  |   285 MB | 42.7 MB |             0.0% |

zod's cold time is dominated by ts-compiler cross-file resolution
(~13 s of 17 s on a re-indexed run). this is the work that lets the
benchmark's call-tracing tasks resolve aliased imports — see
`CAPABILITIES.md` for what that buys.

incremental indexing latency intentionally not published yet — atlas
re-runs flow / duplicate / subsystem detection on every `index()`
call even when no source files changed, which makes a naive timing
overstate the real cost. proper measurement needs an indexer-level
diff API. tracked as a follow-up.

### query latency (ms/call, 50 runs each)

| corpus  | search | files | deps  | blast |
|---------|-------:|------:|------:|------:|
| ripgrep |   0.47 |  0.21 |  0.61 |  0.56 |
| zod     |   0.59 |  0.64 | 42.61 | 19.29 |

zod's deps/blast are slower because the v3+v4+mini packages share
many cross-imports — a ZodObject `deps` walk fans out to hundreds
of nodes. ripgrep's rust workspace has shorter chains.

## phase C appendix: LLM head-to-head (real run)

run on **2026-04-18**, commit `1ef9bd9`, model
`openai/gpt-5.4-nano` via OpenRouter, **single trial per task**.
results JSON: `bench-llm/results/1ef9bd9-2026-04-18T05-46-27-534Z.json`.

both agents got `read_file`, `grep`, `glob`. with-atlas additionally
got `atlas_search`, `atlas_overview`, `atlas_deps`,
`atlas_blast_radius`, `atlas_trace`, `atlas_call_sites`,
`atlas_test_coverage`, `atlas_files`. they answered the same 12
tasks (6 ripgrep + 6 zod) used by the deterministic eval above.

**aggregate (12 tasks, 1 trial)**

| metric                 | baseline | with-atlas |     delta |
|------------------------|---------:|-----------:|----------:|
| mean score             |    0.500 |      0.917 |    +0.417 |
| total tokens           |  175,799 |     70,041 |   −60.2%  |
| total cost (USD)       |  $0.0219 |    $0.0222 |     +1.3% |
| mean tool calls / task |      3.8 |        1.5 |    −60.5% |

cost is essentially equal even though atlas uses 60% fewer tokens —
atlas tool responses (e.g. `atlas_call_sites` returning 200 entries
serialized as JSON) bill as input tokens, which are cheap; baseline
spends more on output tokens through repeated grep + summarize loops.

**per-task results**

| task                            | capability       | baseline | atlas | tokens (b) | tokens (a) |
|---------------------------------|------------------|---------:|------:|-----------:|-----------:|
| ripgrep-01-indexing             | indexing         |     0.00 |  1.00 |      4,014 |      2,642 |
| ripgrep-02-discovery            | discovery        |     1.00 |  1.00 |      2,473 |      1,982 |
| ripgrep-03-code-access          | code-access      |     1.00 |  1.00 |      1,592 |      2,496 |
| ripgrep-04-call-tracing         | call-tracing     |     0.00 |  1.00 |      1,782 |      1,926 |
| ripgrep-05-graph-querying       | graph-querying   |     0.00 |  1.00 |      4,942 |      5,736 |
| ripgrep-06-file-navigation      | file-navigation  |     1.00 |  1.00 |      1,056 |      1,896 |
| zod-01-indexing                 | indexing         |     0.00 |  0.00 |      2,998 |     15,819 |
| zod-02-discovery                | discovery        |     1.00 |  1.00 |      4,855 |      2,025 |
| zod-03-code-access              | code-access      |     1.00 |  1.00 |     23,058 |      3,451 |
| zod-04-call-tracing             | call-tracing     |     0.00 |  1.00 |     53,419 |     16,499 |
| zod-05-graph-querying           | graph-querying   |     0.00 |  1.00 |     74,159 |     13,278 |
| zod-06-file-navigation          | file-navigation  |     1.00 |  1.00 |      1,451 |      2,291 |

honest reads:

- **5 atlas wins, 6 ties, 1 mutual fail.** the wins are exactly the
  capability categories atlas was designed for (call-tracing,
  graph-querying, blast). the ties are surface-level discovery /
  code-access / file-navigation — text search handles those fine.
- **`zod-01-indexing` is a mutual fail.** both models got the wrong
  count for "ts files under `packages/zod/src/v4/`". atlas tried 3
  prefixes and missed; baseline missed in 1 call. the task surfaces a
  real ambiguity in how the prefix must be specified, and both fixed
  the symptom not the cause. fair benchmark behaviour.
- **the 60% token reduction comes mostly from `zod-04` and `zod-05`.**
  baseline burns 53k–74k tokens trying to compute call-tracing /
  blast via grep loops; atlas resolves both in 1–2 tool calls.

**what's NOT claimed by this number**

- 1 trial per task. no variance bands. recommended next run uses
  `--trials 3` so stderr is visible.
- one model. the wedge would shrink on a stronger model
  (haiku 4.5 / 4o / sonnet) because smarter agents can compensate for
  missing tools. it would widen on dumber models. publishing across
  the model tier is the real story.
- the LLM judge is bench-eval's deterministic judge (F1 / count /
  structural). when an LLM-as-judge replaces this, scores will move.
- 12 tasks is too few for a trustworthy headline number outside the
  context of this commit. expand the task set before treating this as
  a "score." it's a directional signal today.

## what's next

- 4-corpus complete set (django + next.js + 1 awkward) — django and
  next.js each take 5-10 min to clone + index, so they ship in a
  separate commit
- multi-trial LLM runs with `--trials 3` and a second model tier
  (haiku 4.5 + 4o-mini) for variance + cross-model comparison
- LLM-as-judge for open-ended capability tasks

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
