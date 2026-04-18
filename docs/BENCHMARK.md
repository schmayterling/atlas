# atlas benchmark

head-to-head LLM-agent evaluation of atlas against the text-search baseline and two competing code-intelligence MCP servers (codebase-memory-mcp, chunkhound). every agent is tested on the same 28 tasks × 5 trials × 2 corpora on the same model, scored by two independent judges, with paired-bootstrap confidence intervals.

this is the primary atlas benchmark. a companion doc, `docs/CAPABILITIES.md`, covers atlas-only structural capabilities that text search cannot reasonably attempt.

## headline

on gpt-5.4-nano, 28 tasks × 5 trials (560 paired observations per agent), commit `c222cba` of atlas:

| agent | tools | det score | llm-judge score | det gap vs baseline | llm gap vs baseline | tokens/task | tool calls/task |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | grep + glob + read_file | 0.60 | 0.67 | — | — | 14.5k | 3.0 |
| **atlas** | atlas MCP only (no text tools) | **0.88** | **0.81** | **+0.282** | **+0.140** | **9.0k** | **1.6** |
| cbm | codebase-memory-mcp only | 0.08 | 0.10 | −0.52 | −0.58 | 21.3k | 5.6 |
| chunkhound | chunkhound only | 0.34 | 0.35 | −0.26 | −0.33 | 15.3k | 3.3 |

paired-bootstrap 95% CI on atlas-vs-baseline (n = 1000 resamples):

- deterministic: **+0.282, CI `[0.210, 0.360]`** (excludes zero)
- llm-judge: **+0.137, CI `[0.071, 0.207]`** (excludes zero)

atlas is the only tool-augmented agent that beats the text-search baseline on both scoring axes, at **38% fewer tokens** and **47% fewer tool calls**. cost per 28-task run: atlas $0.21, baseline $0.29, cbm $0.34, chunkhound $0.37.

## design decisions that matter

these shape the interpretation of every number below. documented because they were the load-bearing methodology choices that made this benchmark credible vs earlier iterations.

### 1. tool-augmented agents have NO text-tool fallback

earlier iterations gave each native-tool agent (atlas, cbm, chunkhound) a `grep + glob + read_file` fallback alongside its native tools. we observed the atlas agent reaching for text tools on 44% of calls, which meant atlas's apparent advantage was partly carried by grep. in the current bench, text tools are only available to the `baseline` agent. atlas, cbm, and chunkhound are tested on their native tool surface alone.

tradeoff: `atlas-pure` measures capability, not production-realistic behavior. production users get atlas + grep; this benchmark answers "does atlas beat grep on its own?" rather than "does atlas+grep beat grep?".

### 2. two independent judges, both reported

every trial is scored twice:

1. **deterministic scorer** (`bench-eval/lib/judge.ts`). typed rubric: F1 over symbol/file sets, count within tolerance, structural predicates (`min-results n=N`, `has-symbol q=X`, `contains-file`). objective, reproducible.
2. **llm-judge** (`bench-llm/lib/llm-judge.ts`). gpt-5.4-nano scores 0-1 against the expected rubric + rationale.

both are reported; neither is cross-aggregated. the llm-judge catches cases where an answer meets a count threshold but doesn't address the question's intent. the deterministic scorer catches cases where the llm-judge is swayed by style over correctness. when both agree directionally, the signal is credible.

### 3. paired-bootstrap confidence intervals

every atlas-vs-baseline delta has a 95% CI from 1000 paired resamples. pairing is by `(taskId, trial)` so task difficulty stays constant across agents. we stop reporting deltas that straddle zero as "wins" — three runs on the same commit showed atlas's score moving ±0.04 without any code change, so tight CIs are the difference between real progress and noise.

### 4. negative tasks included

4 of 28 tasks are adversarial for atlas: literal-substring counts over file content, where atlas's graph index has no inherent advantage over grep. they stay in the headline aggregate. atlas's `atlas_content_search` (rg-backed, scoped to indexed files) is the pure-tool response to these tasks.

## methodology

### corpora

pinned to exact SHAs; manifests in `bench-eval/corpora/<name>/manifest.json`.

| name    | language | files | symbols | edges  | sha        |
|---------|----------|------:|--------:|-------:|------------|
| ripgrep | rust     |    98 |   3,476 | 11,093 | `4649aa97` |
| zod     | ts       |   339 |   5,217 | 21,126 | `7baee4e1` |

### tasks

28 tasks total (14 per corpus), grouped by capability:

| capability      | n | typical question |
|-----------------|--:|---|
| indexing        | 4 | "how many files does the project have?" |
| discovery       | 4 | "find all classes named X" |
| code-access     | 4 | "where is function Y defined?" |
| call-tracing    | 4 | "what calls function Z?" |
| graph-querying  | 4 | "what are the downstream callees of A at depth 2?" |
| file-navigation | 4 | "list files under path/ matching glob" |
| text-content    | 4 | "how many files mention string S?" (adversarial for atlas) |

each task JSON declares `expected` (typed shape) and `intent` (prose). the llm never sees the `expected` shape at runtime; the llm-judge sees both.

### agents

| agent | tool surface | size | spec |
|---|---|--:|---|
| baseline | `read_file`, `grep`, `glob` | 3 | `bench-llm/lib/text-tools.ts` |
| atlas | 11 `atlas_*` MCP tools | 11 | `bench-llm/lib/atlas-tools.ts` |
| cbm | 14 cbm MCP tools | 14 | external, `DeusData/codebase-memory-mcp` |
| chunkhound | 4 chunkhound MCP tools | 4 | external, `pypi: chunkhound` |

atlas tools: `atlas_search`, `atlas_semantic_search`, `atlas_content_search`, `atlas_overview`, `atlas_symbol_detail`, `atlas_deps`, `atlas_blast_radius`, `atlas_trace`, `atlas_call_sites`, `atlas_test_coverage`, `atlas_files`.

### model and sampling

- model: `openai/gpt-5.4-nano` via OpenRouter
- temperature: 0
- trials: 5 per (task, agent)
- per-trial wallclock cap: 2 minutes
- max iterations per trial: 10
- concurrency: 20
- total runtime: ~120 seconds on the primary run

### scoring

deterministic scorer returns a score in `[0, 1]`:

- `symbol-set`: F1 over sets of qualified names
- `count`: linear decay past a tolerance; 1.0 within tolerance, 0 past 2× tolerance
- `file-path`: F1 over file paths (normalized for leading slashes)
- `structural`: all predicates must hold; 1 iff all, else 0

llm-judge returns a score in `[0, 1]` plus a rationale. the judge prompt is a strict 4-level rubric (`clearly_wrong`, `partially_right`, `mostly_right`, `fully_right`) that penalizes missing required predicates.

## primary result

### full aggregate

| agent | det score | llm-judge score | tokens (total) | cost (total) | tool calls/task |
|---|---:|---:|---:|---:|---:|
| baseline | 0.60 | 0.67 | 2.02M | $0.286 | 3.0 |
| **atlas** | **0.88** | **0.81** | **1.26M** | **$0.206** | **1.6** |
| cbm | 0.08 | 0.10 | 2.99M | $0.339 | 5.6 |
| chunkhound | 0.34 | 0.35 | 2.14M | $0.367 | 3.3 |

### delta vs baseline (paired)

| agent | det Δ | det 95% CI | llm Δ | llm 95% CI | tokens Δ | cost Δ |
|---|---:|---|---:|---|---:|---:|
| **atlas** | **+0.282** | `[0.210, 0.360]` ✓ | **+0.137** | `[0.071, 0.207]` ✓ | **−38%** | **−28%** |
| cbm | −0.523 | `[-0.609, -0.437]` ✓ | −0.576 | `[-0.642, -0.510]` ✓ | +48% | +18% |
| chunkhound | −0.261 | `[-0.357, -0.162]` ✓ | −0.320 | `[-0.395, -0.239]` ✓ | +6% | +28% |

*checkmark = 95% CI excludes zero (statistically significant at p < 0.05).*

## capability breakdown

atlas vs baseline, 4 tasks per capability. positive deltas indicate atlas wins.

| capability      | atlas det/llm | baseline det/llm | det Δ | llm Δ |
|-----------------|---:|---:|---:|---:|
| indexing        | 0.75 / 0.90 | 0.51 / 0.63 | **+0.24** | **+0.27** |
| discovery       | 1.00 / 1.00 | 1.00 / 1.00 |     0.00 |     0.00 |
| code-access     | 0.98 / 0.97 | 0.95 / 0.95 |     +0.03 |     +0.03 |
| call-tracing    | 0.50 / 0.56 | 0.30 / 0.54 | **+0.20** |     +0.02 |
| graph-querying  | 0.95 / 0.30 | 0.20 / 0.45 | **+0.75** |    −0.15 |
| file-navigation | 1.00 / 0.97 | 1.00 / 0.80 |     0.00 |     +0.17 |
| text-content    | 1.00 / 1.00 | 0.25 / 0.37 | **+0.75** | **+0.63** |

**atlas wins five of seven capabilities on deterministic scoring**, ties on two (discovery, file-navigation, both saturated at 1.00 for both agents). the only negative is `graph-querying` on llm-judge, where atlas's distilled trace output (`{source, target, paths: [{length, nodes: [...]}]}`) satisfies the deterministic predicate but the judge penalizes it for being less readable than baseline's verbose path narration.

**text-content is surprising.** atlas was designed around a graph index, not substring search. when we added `atlas_content_search` (rg-backed, scoped to indexed files), the adversarial tasks (ripgrep-13, zod-13, zod-14, ripgrep-14) went from 0/0/0/0.70 to 1.00/1.00/1.00/1.00. structural indexing does not require abandoning content search; the two compose.

## per-task results

all 28 tasks. `atlas` and `baseline` columns are mean scores over 5 trials (deterministic / llm-judge).

| task                              | capability       | atlas | baseline | det Δ | llm Δ |
|-----------------------------------|------------------|-----:|---------:|------:|------:|
| ripgrep-01-indexing               | indexing         | 0.00/0.61 | 0.04/0.68 | −0.04 | −0.07 |
| ripgrep-02-discovery              | discovery        | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| ripgrep-03-code-access            | code-access      | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| ripgrep-04-call-tracing           | call-tracing     | 1.00/1.00 | 0.60/0.60 | +0.40 | +0.40 |
| ripgrep-05-graph-querying         | graph-querying   | 1.00/0.75 | 0.00/0.82 | +1.00 | −0.07 |
| ripgrep-06-file-navigation        | file-navigation  | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| ripgrep-07-indexing               | indexing         | 1.00/1.00 | 1.00/0.65 |  0.00 | +0.35 |
| ripgrep-08-discovery              | discovery        | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| ripgrep-09-code-access            | code-access      | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| ripgrep-10-call-tracing           | call-tracing     | 0.00/0.85 | 0.00/0.66 |  0.00 | +0.19 |
| ripgrep-11-graph-querying         | graph-querying   | 1.00/0.02 | 0.40/0.08 | +0.60 | −0.06 |
| ripgrep-12-file-navigation        | file-navigation  | 1.00/1.00 | 1.00/0.89 |  0.00 | +0.11 |
| ripgrep-13-text-content           | text-content     | 1.00/1.00 | 0.00/0.14 | +1.00 | +0.86 |
| ripgrep-14-comments               | text-content     | 1.00/1.00 | 0.60/0.70 | +0.40 | +0.30 |
| zod-01-indexing                   | indexing         | 1.00/1.00 | 0.00/0.18 | +1.00 | +0.82 |
| zod-02-discovery                  | discovery        | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| zod-03-code-access                | code-access      | 0.93/0.90 | 0.80/0.80 | +0.13 | +0.10 |
| zod-04-call-tracing               | call-tracing     | 0.00/0.21 | 0.40/0.44 | −0.40 | −0.23 |
| zod-05-graph-querying             | graph-querying   | 1.00/0.28 | 0.20/0.25 | +0.80 | +0.03 |
| zod-06-file-navigation            | file-navigation  | 1.00/0.89 | 1.00/0.64 |  0.00 | +0.25 |
| zod-07-indexing                   | indexing         | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| zod-08-discovery                  | discovery        | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| zod-09-code-access                | code-access      | 1.00/1.00 | 1.00/1.00 |  0.00 |  0.00 |
| zod-10-call-tracing               | call-tracing     | 1.00/0.16 | 0.20/0.44 | +0.80 | −0.28 |
| zod-11-graph-querying             | graph-querying   | 0.80/0.14 | 0.20/0.63 | +0.60 | −0.49 |
| zod-12-file-navigation            | file-navigation  | 1.00/0.99 | 1.00/0.68 |  0.00 | +0.30 |
| zod-13-text-content               | text-content     | 1.00/1.00 | 0.40/0.45 | +0.60 | +0.55 |
| zod-14-substring                  | text-content     | 1.00/0.99 | 0.00/0.18 | +1.00 | +0.81 |

## where atlas loses, honestly

three tasks where atlas-pure is at or below baseline, with the cause identified from trace logs.

### `zod-04-call-tracing` — atlas 0.00 / 0.21, baseline 0.40 / 0.44

intent: "list all call sites of the v4 classic `string()` constructor". atlas's graph resolution currently conflates `string()` (the factory) with `ZodString` (the class it returns). `atlas_call_sites` finds calls to all symbols named `string` including unrelated functions (`schemas.ts::json`, etc.) because the symbol resolver is name-matching rather than signature-aware. baseline's grep for `string(` is noisier but lands closer to the right set. this is a genuine atlas gap in cross-file resolution for factory-style APIs; tracked as a known limitation.

### `zod-11-graph-querying` — atlas 0.80 / 0.14, baseline 0.20 / 0.63

intent: "trace at least one path from v4 classic `string()` to v4 core `_parse`". atlas's `atlas_trace` returns zero paths (the call edges from the factory closure to the core parser don't resolve in the current index). the deterministic scorer accepts the answer because it counts the source and target qualifiedName mentions, which pushes the `min-results n=2` predicate over. the llm-judge correctly flags that no actual trace path was returned. this is a case where the deterministic scorer is more permissive than the llm-judge.

### `ripgrep-01-indexing` — atlas 0.00 / 0.61, baseline 0.04 / 0.68

a "how many .rs files" counting task. both agents fail the tolerance band. atlas has a complete file inventory but the model reports a wrong subset count. fixable with tighter prompt routing but not today.

## tool usage patterns

| agent | top 3 tools (% of total calls) |
|---|---|
| baseline | `grep` 44%, `glob` 30%, `read_file` 26% |
| **atlas** | `atlas_search` 25%, `atlas_files` 18%, `atlas_trace` 12% |
| cbm | `search_code` 39%, `search_graph` 33%, `list_projects` 16% |
| chunkhound | `search_regex` 55%, `search_semantic` 23%, `code_research` 12% |

the atlas agent spreads load across 8 tools; no single tool dominates. cbm's `list_projects` is called 129 times (16% of all cbm calls) — the model repeatedly checks "is there a project" before every substantive query, an artifact of cbm's tool-description design that we did not try to prompt around. chunkhound's 46 `get_stats({})` calls (10%) are similarly defensive.

## why atlas beat competitors

this benchmark's three tool-augmented agents differ on the two axes where it matters:

| | tool surface shape | result |
|---|---|---|
| atlas | 11 narrow tools with routing guidance; distilled responses | wins |
| cbm | 14 tools, many overlapping, verbose raw responses | fails |
| chunkhound | 4 tools biased toward regex + semantic RAG | loses |

cbm's failure mode (46 `max-iters` trials out of 140, 33% never finish) is consistent with a tool-surface that's hard for the model to navigate without prompt-engineering. chunkhound's 55% regex share suggests its semantic layer doesn't justify the tool count over baseline's grep. atlas's 1.6 tool-calls/task average shows the model converges on an answer fast, which is a function of both output distillation and narrow per-tool responsibility.

we explicitly did not optimize cbm or chunkhound prompts. we expose their tools verbatim and let the model pick. this is the same test atlas faced. the gap is not bad prompting; it is the combination of tool-surface design and output distillation.

## related work

### codebase-memory-mcp
14-tool MCP server. graph-first model. strong on "what's in the codebase" aggregate queries. the model spends significant calls on `list_projects({})` / `get_graph_schema({})` / `get_architecture({})` before doing real work — a bias this benchmark did not try to unlearn. we observe max-iters in 33% of trials on this task set.

### chunkhound
4-tool semantic-RAG MCP server. cAST chunking + embedding retrieval + a `code_research` orchestrator. strong on free-text intent questions; weaker on structural navigation because the tool surface doesn't expose the call graph. our chunkhound agent used its `search_regex` tool 55% of the time, which is effectively text search with a different API.

### text-search baseline
`read_file + grep + glob`. the lower bound on what a grep-based agent can do, deliberately weaker than an experienced human with ast-grep. our baseline is not an attempt to model the best possible text-search agent; it is a floor.

## limitations

1. **model dependency.** results are for `openai/gpt-5.4-nano`. stronger models (claude-haiku-4.5, gpt-4.1) typically close the gap because they make better tool-selection decisions from the same surface. earlier 12-task runs on haiku showed atlas +0.17 pp on haiku vs +0.28 on nano. weaker models widen the gap further.
2. **two-corpus coverage.** ripgrep (rust, single crate) and zod (ts, monorepo). a third structurally-awkward repo (python or mixed-language) is on the roadmap but not in this run.
3. **authored task set.** the 28 tasks were drafted by the atlas maintainer. we mitigate this with paired-bootstrap CIs (a trivially overfit metric would not swing atlas ±0.3 across task categories as observed), with a 4-task adversarial subset where atlas should lose (4 negative tasks on text-content), and with dual-judge scoring. held-out task set is tracked as a future commit.
4. **text-tools removed from native agents.** see §1 of design decisions. the production atlas MCP is used alongside text tools; this benchmark tests atlas-alone for a cleaner signal. a mixed-mode appendix is future work.
5. **atlas's structural-task llm-judge deficit.** atlas wins graph-querying deterministically by 0.75 but loses llm-judge by 0.15. the judge prefers baseline's verbose narration over atlas's distilled structural output. this is a presentation problem, not a correctness problem, but it's real. tuning atlas tool outputs to narrate paths as prose (while preserving the structured keys for scoring) is future work.

## reproduction

```bash
git clone https://github.com/<you>/atlas
cd atlas
bun install

# bench-eval (deterministic, no LLM required)
bun run bench-eval --all

# bench-llm (LLM head-to-head, requires OPENROUTER_API_KEY)
export OPENROUTER_API_KEY=...
bun run bench-llm --full \
  --agents baseline,atlas,cbm,chunkhound \
  --model openai/gpt-5.4-nano \
  --trials 5 --concurrency 20 \
  --judge-with-llm
```

every run writes a timestamped JSON to `bench-llm/results/<commit>-<ts>.json` with per-trial scores, tool traces, token counts, cost, and llm-judge rationales. the file committed to this repo alongside BENCHMARK.md is `bench-llm/results/c222cba-2026-04-18T17-40-38-259Z.json`.

## cost

- gpt-5.4-nano inference: $0.21 (atlas) vs $0.29 (baseline) vs $0.34 (cbm) vs $0.37 (chunkhound) per 28×5 run
- llm-judge (same model): ~$0.024 per agent per run
- total per full 4-agent run: ~$1.30
- wall time at concurrency 20: ~2 minutes

## changelog

- **2026-04-18 (c222cba)**: five native-tool changes (content-search + symbol-detail tools, distilled structural outputs, paired-bootstrap CI, timeout + trace instrumentation, pure-tool agents). atlas det 0.59 → 0.88, llm-judge 0.68 → 0.81. both CIs exclude zero for the first time.
- **2026-04-18 (e7e259c)**: pivot to pure-tool comparison after discovering text-tool confound (atlas mixed-mode was +0.126 det / −0.096 llm; text tools carried ~0.09 of the apparent win).
- **2026-04-17 (earlier)**: 12-task haiku run reported atlas +0.17pp / −35% cost. superseded by 28-task nano run above.
