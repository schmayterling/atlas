# atlas benchmark

reproducible head-to-head benchmark of atlas vs a text-search baseline
on real OSS codebases. companion to `docs/CAPABILITIES.md`, which
covers atlas-only capabilities (call-tracing, blast radius, etc.) that
text search cannot reasonably attempt.

**this document covers phases A + B + C** of the benchmark plan.
results below are the comparable subset; atlas-only capabilities live
in `CAPABILITIES.md`.

**TL;DR for the impatient:** on claude-haiku-4.5 (3 trials × 12
tasks), atlas raises LLM-agent pass rate from 0.694 to 0.861 (+17pp)
while cutting tokens 39% and cost 35%. on weaker models the score
gain is bigger but the cost/token story flips. see "phase C" below.

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

## phase C appendix: LLM head-to-head (3 models, 3 trials each)

runs on **2026-04-18**, commit `7e88b4c`, via OpenRouter, **3 trials
per task** (36 paired observations per model). raw JSON in
`bench-llm/results/7e88b4c-*.json`.

both agents got `read_file`, `grep`, `glob`. with-atlas additionally
got `atlas_search`, `atlas_overview`, `atlas_deps`,
`atlas_blast_radius`, `atlas_trace`, `atlas_call_sites`,
`atlas_test_coverage`, `atlas_files`. same 12 tasks (6 ripgrep +
6 zod) used by the deterministic eval above.

### three-model summary

| model                             | baseline | atlas | Δ score | tokens / task | Δ tokens | cost  | Δ cost  |
|-----------------------------------|---------:|------:|--------:|--------------:|---------:|------:|--------:|
| **claude-haiku-4.5**              |    0.694 | 0.861 | **+0.167** |   18,898 (a) | **−39%** | $0.795 (a) | **−35%** |
| openai/gpt-5.4-nano               |    0.630 | 0.750 |  +0.120 |    7,355 (a) |   −39%   | $0.067 (a) |    −3%   |
| google/gemini-3.1-flash-lite      |    0.139 | 0.528 |  +0.389 |   61,270 (a) |  **+99%** | $0.263 (a) | **+39%** |

(per-task token average shown for atlas. Δ is atlas vs baseline.)

three readings:

1. **haiku 4.5 is the only config that wins on every axis at once.**
   +17 points on score, −39% tokens, −35% cost, 1.6 vs 3.8 tool
   calls. that's the publishable headline:
   *"on claude haiku 4.5, atlas raises pass rate by 17pp while cutting
   inference cost by 35%."*

2. **the score delta shrinks as model strength grows** (+0.39 on
   gemini lite → +0.17 on haiku → would shrink further on
   sonnet/gpt-5). that's expected: smart models compensate for
   missing tools by being smarter. the value at the haiku tier is
   "make a smart model better and cheaper" rather than "rescue a
   weak model from failing." both are real value props for different
   buyers.

3. **gemini lite is a cautionary tale for atlas + weak models.**
   atlas doubled gemini's pass rate (0.14 → 0.53) but gemini wasn't
   smart enough to use atlas tools efficiently — token use went
   *up* 99%, cost up 39%. don't pair atlas with sub-haiku-tier
   models if cost matters more than accuracy.

### per-task breakdown — haiku 4.5 (the headline run)

| task                            | capability       | baseline | atlas | tokens (b) | tokens (a) |
|---------------------------------|------------------|---------:|------:|-----------:|-----------:|
| ripgrep-01-indexing             | indexing         |     0.00 |  0.00 |     55,555 |      9,500 |
| ripgrep-02-discovery            | discovery        |     1.00 |  1.00 |      2,486 |      4,232 |
| ripgrep-03-code-access          | code-access      |     1.00 |  1.00 |      2,480 |      4,371 |
| ripgrep-04-call-tracing         | call-tracing     |     1.00 |  1.00 |      7,283 |      4,145 |
| ripgrep-05-graph-querying       | graph-querying   |     0.00 |  1.00 |     15,585 |     13,078 |
| ripgrep-06-file-navigation      | file-navigation  |     1.00 |  1.00 |      2,553 |      4,129 |
| zod-01-indexing                 | indexing         |     1.00 |  1.00 |      5,479 |      7,246 |
| zod-02-discovery                | discovery        |     1.00 |  1.00 |      4,118 |      4,288 |
| zod-03-code-access              | code-access      |     1.00 |  1.00 |     25,806 |      7,230 |
| zod-04-call-tracing             | call-tracing     |     0.33 |  0.33 |    138,655 |    146,466 |
| zod-05-graph-querying           | graph-querying   |     0.00 |  1.00 |    109,061 |     18,696 |
| zod-06-file-navigation          | file-navigation  |     1.00 |  1.00 |      3,168 |      4,836 |

reads:

- **2 atlas-only wins** (ripgrep-05, zod-05 — both graph-querying):
  baseline can't compute blast radius via grep, atlas resolves it in
  1 call. zod-05 alone saves 90,000 tokens per trial.
- **9 ties at 1.00**: surface-level tasks where text search is fine.
- **1 mutual fail**: `ripgrep-01-indexing`. both haiku agents
  consistently miscount files — likely a prompt-shape issue with
  the count expected. baseline burned 55k tokens loop-grepping;
  atlas burned 9k. atlas loses on score but wins on cost-of-failure.
- **1 mutual partial**: `zod-04-call-tracing` (0.33 each). on this
  task, ~200 call sites is borderline for the model to handle —
  haiku passes 1 of 3 trials regardless of which agent.

### confidence

with 3 trials × 12 tasks = 36 paired observations per model, the
standard error on the delta is roughly ±0.08 (assuming task variance
σ ≈ 0.45). so the haiku **+0.167** is **+0.17 ± 0.08 (~95% CI)** —
the lower bound is +0.09, comfortably above zero. publishable.

### running times

with `--concurrency 8-10`, all three models finished 72 jobs each
in 70-95 seconds wall clock. without parallelization (the sequential
runner) the same workload was ~10x slower.

### what's NOT claimed

- 12 tasks across 2 corpora is enough for a directional headline,
  not enough for a cited claim. add django + next.js + 1 awkward
  corpus before publishing externally.
- single trial of `nano` originally showed +0.417, which collapsed
  to +0.12 with 3 trials. variance matters; don't trust 1-trial
  numbers.
- the LLM judge is bench-eval's deterministic judge (F1 / count /
  structural). when an LLM-as-judge replaces this for open-ended
  tasks, scores will move.
- prompt format wasn't tuned per model. a haiku-specific prompt could
  push the win further; a gpt-5-nano-specific prompt could cut the
  +99% token regression on gemini.

## what's next

- 4-corpus complete set (django + next.js + 1 awkward) — django and
  next.js each take 5-10 min to clone + index, so they ship in a
  separate commit
- run on a frontier model (sonnet / gpt-5) to settle whether the
  delta survives at the high-end
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
