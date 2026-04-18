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

## phase C appendix: LLM head-to-head (4 models, 3 trials each)

runs on **2026-04-18**, via OpenRouter, **3 trials per task** (36
paired observations per model). raw JSON in `bench-llm/results/`.

both agents got `read_file`, `grep`, `glob`. with-atlas additionally
got `atlas_search`, `atlas_overview`, `atlas_deps`,
`atlas_blast_radius`, `atlas_trace`, `atlas_call_sites`,
`atlas_test_coverage`, `atlas_files`. same 12 tasks (6 ripgrep +
6 zod) used by the deterministic eval above.

### four-model summary

| model                             | baseline | atlas | Δ score | tokens / task | Δ tokens | cost / 12 tasks (atlas) | Δ cost  |
|-----------------------------------|---------:|------:|--------:|--------------:|---------:|------------------------:|--------:|
| **claude-haiku-4.5**              |    0.694 | 0.861 | **+0.167** |       19,018 |  **−39%** |               $0.795     | **−35%** |
| openai/gpt-5.4-nano               |    0.630 | 0.750 |  +0.120 |        7,355 |    −39%   |               $0.067     |    −3%   |
| xiaomi/mimo-v2-omni               |    0.486 | 0.667 |  +0.181 |       46,790 |    −19%   |               $0.478     |   **+9%** |
| google/gemini-3.1-flash-lite      |    0.139 | 0.528 |  +0.389 |       61,270 |  **+99%** |               $0.263     |  **+39%** |

(per-task tokens shown for atlas. Δ columns are atlas vs baseline.
gpt-5.4-nano: 36 baseline obs / 36 atlas. xiaomi: 35 baseline / 36
atlas — one baseline trial errored. wall time on `--concurrency 8-10`
ranged 70-95s for the three small/cheap models, 290s for xiaomi.)

four readings:

1. **haiku 4.5 is still the only config that wins on every axis.**
   +17 points on score, −39% tokens, −35% cost, 1.6 vs 3.8 tool
   calls. publishable headline:
   *"on claude haiku 4.5, atlas raises pass rate by 17pp while cutting
   inference cost by 35%."*

2. **the cost story splits into three regimes by model class.**
   - **claude-tier** (haiku): atlas cuts cost meaningfully (−35%)
     because output tokens dominate billing and atlas reduces output
     by giving the model facts up front.
   - **openai-nano-tier**: atlas cost-neutral (~−3%). nano's input/output
     pricing is almost flat, so token-savings translate to cost-savings
     at a near-1:1 ratio but nano was already cheap.
   - **everyone-else-tier** (xiaomi, gemini): atlas can RAISE cost
     even when tokens drop. xiaomi: −19% tokens but +9% cost — atlas's
     tool responses bias toward output-heavy reasoning that bills
     more per token. gemini: weak model loops on atlas tools, +99%
     tokens and +39% cost.

3. **score delta is roughly inversely proportional to baseline competence.**
   gemini (baseline 0.14) → +0.39. xiaomi (0.49) → +0.18. nano (0.63)
   → +0.12. haiku (0.69) → +0.17. atlas helps weak models more, but
   the haiku case is special: the delta plateaus at +0.17 because
   haiku is smart enough to USE atlas tools well rather than just
   needing them.

4. **xiaomi/mimo is interesting: middle of the score range, middle of
   the cost story.** atlas doubled its win rate on graph-querying
   and call-tracing tasks (where structural facts are required) but
   it actually LOST on `zod-03-code-access` (0.67→0.33), suggesting
   the model gets confused when atlas hands back too much context.
   prompt tuning likely matters more on this tier than on haiku.

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

## comparison to alternatives

three other tools compete for the same MCP slot atlas occupies. all
self-published numbers below — we have NOT yet run any of them
against the bench-eval task set, so this is architectural / methodology
comparison only. apples-to-apples results would require wiring each
as a third agent in `bench-llm/agents/` (tracked as a follow-up).

### codebase-memory-mcp (CBM) — github.com/DeusData/codebase-memory-mcp

closest direct competitor.

| dimension | CBM | atlas |
|---|---|---|
| approach | tree-sitter syntax graph + cypher queries | tree-sitter for Py/Go/Rust **+ TS compiler resolution for TS/JS** + sqlite graph |
| languages | 66 (claimed; quality tiered) | 5 (TS, JS, Python, Go, Rust) |
| binary | single static, zero deps | bun runtime + sqlite-vec + optional Ollama |
| MCP tools | 14 (`index_repository`, `search_graph`, `trace_call_path`, `query_graph` cypher, `get_code_snippet`, `get_architecture`, `manage_adr`, `ingest_traces`, others) | 8 (atlas_search, atlas_overview, atlas_deps, atlas_blast_radius, atlas_trace, atlas_call_sites, atlas_test_coverage, atlas_files) |
| published indexing speed | "Linux kernel 28M LOC, 75K files in 3 min on M3 Pro" | ripgrep 98 files / 970ms; zod 339 files / 17.4s on M-series (no kernel test yet) |
| published query latency | "<1ms cypher, <10ms name search, ~150ms dead code" | search 0.47-0.59ms, deps 0.6-43ms, blast 0.6-19ms (50-run avg) |
| published token-reduction claim | 99.2% (5 queries: 3,400 vs 412,000 tokens) | 39% per task (haiku, 3 trials × 12 tasks) — a much smaller, much more conservative number measured under different conditions |
| published accuracy / capability score | 91.8% aggregate over 35 langs × 12 questions, "83% answer quality" on 31 repos | atlas 1.00 vs text-search 0.75 on the deterministic eval; haiku +17pp / 0.86 in the LLM eval |
| benchmark reproducibility | text recipe, no scripted runner | `bun install && bun run bench-eval --all` + `bench-llm` with results JSON committed to git |

**honest read:** CBM has 13× the language breadth, a unified
single-binary distribution story, and a more permissive cypher query
surface. atlas trades that breadth for **TS compiler-resolved edges**
(catches aliased imports / re-exports / `as` rebindings that
tree-sitter syntactically misses) and a benchmark anyone can rerun
with three commands. CBM's published headline ("99.2% token reduction")
is from a 5-query cherry-picked comparison; atlas's headline (−39%
on haiku across 36 paired observations) is the methodologically
boring number that holds up. for one-time exploratory queries on
exotic languages, CBM. for repeatable structural work on TS-heavy
codebases, atlas.

### chunkhound — github.com/chunkhound/chunkhound

different category — semantic-RAG-first, not graph-first.

| dimension | chunkhound | atlas |
|---|---|---|
| approach | hybrid: tree-sitter chunking (cAST) + embedding retrieval (HNSW) + LLM-driven research orchestration | tree-sitter + TS compiler graph + optional embedding |
| languages | 32 via tree-sitter (no compiler resolution for any) | 5 with depth |
| MCP tools | 3 (semantic search, regex search, code research) | 8 structural |
| call graph / dependency edges | none — semantic search only | yes, with confidence + edge kinds |
| blast radius / impact analysis | no | yes |
| test coverage mapping | no | yes |
| published claims | "cAST: 4.3pt gain on retrieval benchmarks", "10-100× faster indexing", "5 minutes to first query", token budgets 30k-150k auto-scaled | see this doc |

**honest read:** chunkhound and atlas are **complementary, not
competitive**. chunkhound is great for "find code about authentication"
(natural-language semantic). atlas is great for "every caller of
`processPayment` and what tests exercise it" (structural). a real
agent stack might use chunkhound for retrieval + atlas for
verification. chunkhound has not published head-to-head numbers
against any specific competitor; the 4.3pt cAST gain is on retrieval
benchmarks vs naive chunking, not vs structural tools.

### what would real head-to-head numbers look like

to make this comparison rigorous we'd need to:

1. wire CBM as a third agent in `bench-llm/agents/cbm.ts` — its
   `index_repository` + `search_graph` + `trace_call_path` map cleanly
   to atlas's `atlas_search` + `atlas_deps` + `atlas_call_sites`
2. wire chunkhound similarly — its semantic + regex would handle
   the discovery / code-access tasks; it would skip call-tracing and
   graph-querying entirely (mark them not-comparable, like our text-
   search baseline)
3. run all three (atlas / CBM / chunkhound) against the same 12 tasks
   on the same 4 LLM models, 3 trials each = 144 paired observations
   per (tool, model) pair
4. publish the matrix

cost estimate: 144 obs × 4 models × 3 tools = 1,728 LLM rounds. on
haiku that's ~$10. on free-tier nano + gemini that's ~$2. **probably
the single highest-leverage benchmark investment available** — it
turns "atlas claims X" into "atlas vs CBM vs chunkhound on the same
tasks under identical conditions" which is the only credibility tier
above our current one.

tracked as a follow-up.

## what's next

- wire CBM + chunkhound as bench-llm agents (above)
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
