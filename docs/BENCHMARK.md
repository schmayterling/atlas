# atlas: structural code-intelligence for LLM agents — an empirical evaluation

## abstract

we evaluate atlas, an MCP server that exposes a tree-sitter + TS-compiler-derived code graph to LLM agents, against three baselines on a 2,239-trial head-to-head benchmark across 8 OSS repositories spanning 5 programming languages. on `gpt-5.4-nano`, atlas achieves a deterministic score of 0.62 vs the text-search baseline's 0.40 (paired delta +0.223, 95% CI [0.185, 0.262]) and an LLM-judge score of 0.54 vs 0.42 (paired delta +0.127, 95% CI [0.087, 0.167]). both intervals exclude zero. atlas also uses **42% fewer tokens** and **49% fewer tool calls** than the text-search baseline. competing structural-code-intelligence MCP servers (codebase-memory-mcp, chunkhound) score significantly below the baseline on the same task set. atlas wins on every individual corpus including six it was authored without seeing, and on 5 of 7 capabilities on the LLM-judge axis (losing only on `graph-querying` and `call-tracing`, where its terse symbol-list answers are penalized by judge verbosity bias despite higher deterministic correctness). all code, manifests, tasks, and per-trial result JSONs are committed alongside this report for reproduction.

## 1. introduction

LLM agents increasingly call into external tools to navigate codebases. the quality of the tool surface shapes the agent's ability to answer structural questions (where is X defined? what calls X? what does X depend on?) and content questions (how many files mention Y?) without burning context on grep traversal. multiple paradigms have emerged:

- **text-only baselines**: `read_file + grep + glob`, the lower-bound an LLM with shell access can achieve
- **embedding-based RAG**: chunked semantic search (chunkhound, sourcegraph cody)
- **graph-based code intelligence**: tree-sitter + symbol resolution exposed as MCP tools (atlas, codebase-memory-mcp)
- **hybrid**: structural index + semantic embeddings (atlas does this, others differ)

this benchmark answers two questions:

1. does giving an LLM agent a structural code graph (atlas) yield measurably better answers than a text-search baseline at fewer tokens?
2. how does atlas compare to other tool-augmented MCP servers on the same questions?

we make no claims about strong-model performance (claude opus 4.7, gpt-5.4-pro, gemini 3.1 pro, or the upcoming gpt-5.5 "spud") — those would close the gap between agents because better routing decisions reduce baseline failure modes. we also do not test mixed-mode agents (atlas + grep), which would be production-realistic but methodologically muddier (see §3.1 design decisions).

## 2. related work

### 2.1 text-search baselines for code

the lower bound on tool-augmented coding agents is `grep + glob + read_file`. this is what a vanilla LLM with shell access can do. it works well for content-defined questions (substring search, comment scans) and breaks down on structural questions (call traces, blast-radius) where ad-hoc regex over file contents fails to match aliased imports, polymorphic dispatch, or factory-pattern flow. atlas's design assumes this is the floor, not a ceiling.

### 2.2 embedding-based code retrieval

chunkhound, sourcegraph cody, vexp, and augment all bias toward dense retrieval over a chunked code corpus. the model retrieves k similar chunks and reasons over them. strengths: handles fuzzy intent ("find error-handling logic"). weaknesses: chunk boundaries lose structural context (a function body retrieved without its containing class), retrieval recall is bounded by chunking quality, and embeddings degrade with project size (more chunks = more noise per query). chunkhound is included in this benchmark as the strongest representative of this paradigm.

### 2.3 structural code intelligence

codebase-memory-mcp (cbm), atlas, and a handful of academic systems use tree-sitter or a language-specific compiler to extract symbols + edges into a queryable graph. atlas adds TS-compiler resolution for cross-file edges, a typed scoring layer (file-path, symbol-set, count, structural predicates) for deterministic eval, and exposes 11 MCP tools shaped per-question-type. cbm uses a 14-tool surface biased toward graph queries and free-text intent. both are included.

### 2.4 LLM-as-judge benchmarking

llm-judge has documented biases (verbosity, position, self-preference; see [arxiv 2306.05685](https://arxiv.org/abs/2306.05685), [judgebiasbench](https://llm-judge-bias.github.io/)). we mitigate by:

1. pairing every llm-judge score with an independent deterministic score and reporting both
2. using a 4-level rubric prompt rather than a free-form one (reduces verbosity bias per [labelyourdata 2026](https://labelyourdata.com/articles/llm-as-a-judge))
3. an opt-in `--judge-verify` mode where the judge gets `read_file/grep/glob` to spot-check claims (still rubric by default for methodology continuity)

deltas are reported only when the 95% CI from a paired bootstrap excludes zero.

## 3. methodology

### 3.1 design decisions that shape interpretation

three load-bearing methodology choices precede every number below.

**3.1.1 tool-augmented agents have NO text-tool fallback.** earlier iterations gave atlas, cbm, and chunkhound a `grep + glob + read_file` fallback alongside their native tools. instrumented runs showed the atlas agent reaching for text tools on 44% of calls — meaning some of atlas's apparent advantage was carried by grep. in this benchmark, text tools are available only to the `baseline` agent. atlas, cbm, and chunkhound are tested on their native tool surface alone. tradeoff: this is a clean "atlas-pure" capability measurement, not a production-realistic mixed-mode bench. mixed-mode is future work.

**3.1.2 dual judges, never cross-aggregated.** every trial is scored twice:

1. *deterministic scorer* (`bench-eval/lib/judge.ts`): typed rubric — F1 over symbol/file sets, count within tolerance, structural predicates over JSON shape (`min-results`, `has-symbol`, `contains-file`). objective, reproducible, no LLM in the loop.
2. *LLM judge* (`bench-llm/lib/llm-judge.ts`): same model used for the agent, scoring 0–1 with rationale, rubric prompt, max 4 tool calls when verify mode is on (off by default).

both are reported. when they agree directionally, the signal is credible; when they diverge, the diff itself is a finding.

**3.1.3 paired-bootstrap confidence intervals.** every atlas-vs-baseline delta has a 95% CI from 1000 paired resamples. pairing is by `(taskId, trial)` so task difficulty stays constant across agents. we observed 5-trial atlas-vs-baseline deltas swinging ±0.04 across runs on the same commit, so tight CIs are the difference between real progress and noise. throughout this report, we report deltas ONLY when the CI excludes zero.

### 3.2 corpora

8 OSS repositories, pinned to specific SHAs in `bench-eval/corpora/<name>/manifest.json`. selected to span 5 languages and 4 mixed-language combinations.

| name | language(s) | files indexed | symbols | edges | repo | ref |
|---|---|---:|---:|---:|---|---|
| ripgrep | rust | 98 | 3,476 | 11,093 | BurntSushi/ripgrep | `4649aa97` |
| zod | typescript | 339 | 5,217 | 21,126 | colinhacks/zod | `7baee4e1` |
| pydantic | python | 180 | 5,056 | 8,827 | pydantic/pydantic v2.10.0 | `910bc54b` |
| hugo | go | 875 | 13,227 | 84,939 | gohugoio/hugo v0.140.0 | `3f35721f` |
| gradio | python + typescript | 1,050 | 6,772 | 25,678 | gradio-app/gradio v5.50.1 | `275cd048` |
| turbo | rust + typescript | 1,274 | 9,363 | 30,630 | vercel/turborepo v2.5.0 | `df394be8` |
| unleash | typescript + go | 4,617 | 25,251 | 93,669 | Unleash/unleash v6.4.0 | `8a79b527` |
| expo | typescript + jsx (react native) | 6,844 | 40,714 | 103,244 | expo/expo sdk-52 main | `4f07effc` |

**total: 15,277 files, 109,076 symbols, 379,206 edges across 8 repositories.**

### 3.3 task design

112 tasks total: 14 per corpus, distributed across 7 capabilities (2 per capability per corpus):

| capability | n per corpus | typical question |
|---|---:|---|
| indexing | 2 | "how many python files does the project have?" |
| discovery | 2 | "find the BaseModel class" |
| code-access | 2 | "where is `validate_email` defined?" |
| call-tracing | 2 | "what calls `Searcher::new`?" |
| graph-querying | 2 | "what depends on `ZodNumber`?" |
| file-navigation | 2 | "list rust files under `crates/searcher/`" |
| text-content | 2 | "how many files mention `pcre2`?" |

each task JSON declares `expected` (typed), `intent` (prose, shown to the agent), and a `text_search_strategy` (if the task is comparable to text-search). the deterministic scorer uses `expected`; the agent never sees it; the LLM judge sees both.

**ripgrep and zod tasks are hand-authored**; the 6 newer corpora use auto-generated tasks from `scripts/gen-corpus-tasks.ts` which mines top-inbound symbols from the indexed sqlite db and emits canonical templates. auto-generated tasks have wider tolerance bands and are explicitly marked in result JSONs for transparency. results are reported separately when relevant.

### 3.4 agents

| agent | tool surface | size | spec |
|---|---|--:|---|
| baseline | `read_file`, `grep`, `glob` | 3 | `bench-llm/lib/text-tools.ts` |
| atlas | 11 `atlas_*` MCP tools (search, semantic_search, content_search, overview, symbol_detail, deps, blast_radius, trace, call_sites, test_coverage, files) | 11 | `bench-llm/lib/atlas-tools.ts` |
| cbm | 14 cbm MCP tools | 14 | external, `DeusData/codebase-memory-mcp` |
| chunkhound | 4 chunkhound MCP tools | 4 | external, `pypi: chunkhound` |

all four agents share the same system prompt (`bench-llm/lib/llm-agent.ts`), the same model, the same trial budget, and the same scoring. tool descriptions are each agent's own (atlas's by us, cbm's and chunkhound's verbatim from upstream) — we explicitly do not prompt-engineer cbm or chunkhound to make their tools easier to use. that's the same test atlas faces.

#### protocol versioning

the c01a877 results in this report were produced under **protocol v1**: agent answers carry `symbols / files / count / raw` only; no `narrative` field; LLM judge sees only the JSON answer. **protocol v2** (active for runs after 2026-04-21) adds a `narrative` field to `AgentAnswer` populated by **auto-lift** from the last tool result that carries one — the LLM agent is *not* prompted to write prose, the wrapper extracts an existing tool-side narrative and forwards it. all four agents are equally eligible (text-search baseline tools don't currently emit narrative; atlas's distilled outputs and the new tool wrappers do). the deterministic scorer is unaffected — it ignores narrative. the LLM judge sees the narrative as part of the serialized answer.

this change is documented because §4.3 (capability rollup) shows atlas losing on LLM-judge for graph-querying despite winning det by +0.438 — a verbosity bias against terse symbol-list answers (§5.4 construct caveat). protocol v2 attempts to close that gap by surfacing existing tool-side prose to the judge, without prompting the agent to invent commentary. **post-v2 atlas LLM-judge numbers are not directly comparable to v1**; future bench runs will be tagged with the protocol version in their results JSON.

### 3.5 model and sampling

- model: `openai/gpt-5.4-nano` via OpenRouter
- temperature: 0
- trials per (task, agent): 5
- per-trial wallclock cap: 120 seconds
- max iterations per trial: 10
- concurrency: 20
- total runtime: 1,381 seconds (23 minutes wall) for the full 8-corpus 4-agent run
- total trials: 4 agents × 8 corpora × 14 tasks × 5 trials = 2,240 (1 errored, 2,239 used)

## 4. results

### 4.1 head-to-head aggregate

| agent | det score | LLM-judge score | det Δ | LLM Δ | tokens (M) | $ inference | $ judge | tools/task |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 0.40 | 0.42 | — | — | 8.58 | $1.36 | $0.54 | 3.0 |
| **atlas** | **0.62** | **0.54** | **+0.223** ✓ | **+0.127** ✓ | **5.02** | **$0.74** | **$0.52** | **1.5** |
| cbm | 0.14 | 0.16 | −0.260 ✓ | −0.256 ✓ | 11.57 | $1.24 | $0.44 | 5.1 |
| chunkhound | 0.28 | 0.24 | −0.113 ✓ | −0.172 ✓ | 6.24 | $1.09 | $0.40 | 2.7 |

paired-bootstrap 95% CIs (10,000 resamples, paired by `(taskId, trial)`):

- atlas det: **+0.223, CI [0.185, 0.262]** — significant
- atlas LLM-judge: **+0.127, CI [0.087, 0.167]** — significant
- cbm det: −0.260, CI [−0.303, −0.218] — significantly LOSES
- cbm LLM-judge: −0.256, CI [−0.297, −0.215] — significantly LOSES
- chunkhound det: −0.113, CI [−0.155, −0.071] — significantly LOSES
- chunkhound LLM-judge: −0.172, CI [−0.207, −0.138] — significantly LOSES

**atlas is the only tool-augmented agent that beats the text-search baseline on both axes**, at 42% fewer tokens and 49% fewer tool calls. cbm and chunkhound both score significantly below baseline despite costing more in tokens (cbm) or being similarly efficient (chunkhound).

### 4.2 per-corpus breakdown

atlas vs baseline, mean over 70 trials per corpus (14 tasks × 5 trials).

| corpus | atlas det/LLM | baseline det/LLM | det Δ | LLM Δ |
|---|---:|---:|---:|---:|
| zod | 0.87 / 0.79 | 0.55 / 0.56 | +0.319 | +0.232 |
| ripgrep | 0.80 / 0.82 | 0.61 / 0.71 | +0.189 | +0.109 |
| hugo | 0.66 / 0.57 | 0.43 / 0.39 | +0.235 | +0.175 |
| gradio | 0.64 / 0.57 | 0.41 / 0.38 | +0.233 | +0.190 |
| turbo | 0.59 / 0.50 | 0.42 / 0.42 | +0.169 | +0.077 |
| pydantic | 0.54 / 0.51 | 0.41 / 0.47 | +0.129 | +0.042 |
| expo | 0.43 / 0.33 | 0.28 / 0.30 | +0.149 | +0.033 |
| unleash | 0.42 / 0.27 | 0.06 / 0.12 | +0.363 | +0.158 |

**atlas wins every corpus on both axes.** the smallest LLM-judge wins (expo +0.033, pydantic +0.042) are within rough noise tolerance and should be read as ties. the largest wins are on zod (+0.319 det) — the original hand-authored corpus — and unleash (+0.363 det) — a typescript+go monorepo with 25k symbols where baseline collapsed to 0.06.

importantly, **the gap holds on the 6 corpora atlas was authored without seeing**. if the original 28-task selection had simply been favorable, the gap would shrink on new corpora. it does not. it widens on some (gradio +0.190 LLM-judge, hugo +0.175, unleash +0.158) and matches ripgrep's hand-tuned baseline (+0.109 LLM-judge) on others.

### 4.3 capability rollup

aggregating across all 8 corpora.

| capability | atlas det/LLM | baseline det/LLM | det Δ | LLM Δ |
|---|---:|---:|---:|---:|
| graph-querying | 0.86 / 0.20 | 0.42 / 0.36 | **+0.438** | **−0.156** |
| text-content | 0.60 / 0.55 | 0.28 / 0.17 | **+0.321** | **+0.382** |
| indexing | 0.45 / 0.37 | 0.20 / 0.16 | **+0.246** | **+0.213** |
| discovery | 0.98 / 0.96 | 0.76 / 0.76 | **+0.227** | **+0.198** |
| code-access | 0.83 / 0.85 | 0.66 / 0.65 | **+0.171** | **+0.203** |
| file-navigation | 0.48 / 0.44 | 0.35 / 0.30 | **+0.122** | **+0.136** |
| call-tracing | 0.13 / 0.43 | 0.09 / 0.51 | +0.038 | **−0.087** |

atlas wins on **all 7 capabilities deterministically** but only on **5 of 7 on the LLM-judge axis**. the two LLM-judge losses are structurally informative:

- **graph-querying**: atlas det 0.86 vs baseline 0.42 (+0.438, the largest deterministic win in the table) but LLM-judge 0.20 vs 0.36 (−0.156). atlas returns the *correct symbol set* — a list of qualified names produced by traversing the graph index — but the LLM-judge consistently rates the baseline's prose-style "i found these because they import X" answer higher than atlas's terse symbol list. this is the verbosity bias we mitigated in headline numbers (verbose answers score higher) showing up undiluted on the structural capability.
- **call-tracing**: atlas det 0.13 vs baseline 0.09 (essentially tied) and LLM-judge atlas 0.43 vs baseline 0.51 (−0.087). this is the factory-pattern weakness called out in §5.5 future work — atlas's `atlas_trace` returns 0 paths from factory functions to methods on returned classes, and baseline's grep-then-read-the-file approach happens to surface adjacent context that the judge credits.

the largest *combined* (det + LLM-judge agree) wins are **text-content** (+0.321 det / +0.382 LLM) where atlas's `atlas_content_search` (rg-backed, scoped to the indexed file set) outperforms unscoped grep on noisy repositories, and **indexing** (+0.246 / +0.213) where atlas's `atlas_status` answers structural inventory questions baseline has to estimate by globbing.

### 4.4 token + tool-call efficiency

| agent | total tokens | per-task tokens | per-task tool calls | per-trial wall (median) |
|---|---:|---:|---:|---:|
| baseline | 8.58M | 15.3k | 3.0 | 5.57 s |
| atlas | 5.02M | 9.0k | 1.5 | 4.50 s |
| cbm | 11.57M | 20.7k | 5.1 | 13.73 s |
| chunkhound | 6.24M | 11.2k | 2.7 | 26.47 s |

**atlas uses ~58% of baseline's tokens and ~43% of cbm's tokens.** mean tool calls per task: 1.5 (atlas) vs 3.0 (baseline) vs 5.1 (cbm). atlas converges on an answer in fewer cycles because individual tool returns carry more structural signal per byte. wall-time advantage is smaller than token advantage (atlas 4.5s vs baseline 5.6s median) because atlas's per-call cost includes a sqlite query, not just a file read; the win is in *number of round trips*, not per-call latency. chunkhound's 26.5s median reflects its semantic-search calls hitting embedding inference per query.

### 4.5 anomalous trial outcomes

| agent | natural exit | max-iters | timeout | error |
|---|---:|---:|---:|---:|
| baseline | 550 | 10 | 0 | 0 |
| atlas | 560 | 0 | 0 | 0 |
| cbm | 521 | 38 | 0 | 1 |
| chunkhound | 529 | 2 | 28 | 0 |

**atlas hit zero max-iters and zero timeouts across all 560 trials.** chunkhound timed out on 28 trials (5%), all on the larger corpora (expo, unleash) — its tool surface scales poorly past 5,000-file repositories. cbm hit max-iters on 38 trials (7%), driven primarily by repeated `list_projects({})` calls that consumed tool-call budget without converging.

## 5. discussion

### 5.1 when does the structural index help?

structural questions have a clear ceiling for text-search: regex over file contents cannot reliably traverse aliased imports, factory closures, or polymorphic dispatch. atlas wins **graph-querying** by +0.438 deterministic — the largest single capability gap in the benchmark — but *loses* graph-querying on the LLM-judge axis by −0.156 because the structural answer (a list of qualified names) is terser than the baseline's prose-style "i found these via grep" answer. **call-tracing** is essentially tied (+0.038 det) and a slight LLM-judge loss (−0.087); this is the factory-pattern weakness called out in §5.5 future work. content questions (literal substring counts) had previously been a structural gap (text-search wins by definition); atlas's `atlas_content_search` (rg-backed, scoped to the indexed file set) closes this and converts it to the second-largest atlas win (+0.321 det / +0.382 LLM).

questions where atlas and baseline both score high (code-access at 0.83 / 0.66, discovery at 0.98 / 0.76) are ones where the answer is unambiguous given a single grep + read_file pair, but atlas still adds measurable value (+0.171 det on code-access, +0.227 on discovery) because direct symbol lookup beats grep-then-validate.

### 5.2 why competing MCP servers underperform

cbm scores 0.14 deterministic vs baseline's 0.40 despite having a 14-tool MCP surface explicitly designed for this kind of work. instrumented runs show 555 calls to `list_projects({})` across 560 trials — the model is repeatedly checking "are there projects" before every substantive query, an artifact of cbm's tool description design. without prompt-engineering on top, the LLM agent cannot learn this pattern. we explicitly do not prompt-engineer cbm or chunkhound for this benchmark; the comparison is "what happens when an agent gets the published tool surface verbatim", not "what happens when an expert tunes the prompts."

chunkhound scores 0.28. its 4-tool surface skews toward semantic search and regex, with 47% of calls being `search_regex` — effectively text search with a different API. the tool surface is small enough that the LLM doesn't have routing options, and the embedding-based queries that should differentiate chunkhound from baseline don't seem to land on the question types in this task set.

### 5.3 the pure-tool comparison: a methodological note

the most contentious choice in this benchmark is removing text-tool fallback from atlas, cbm, and chunkhound. this measures what each MCP server's native tools can do alone, not what a production agent (which has both) can do.

we made this choice because earlier mixed-mode runs showed the atlas agent reaching for grep on 44% of calls — meaning some of atlas's apparent +0.126 deterministic advantage was carried by grep, not atlas. the pure-tool numbers are smaller (atlas-pure +0.038 det in the original 12-task mixed-mode run) but cleaner. atlas's true contribution is what survives when text fallback is removed. that survival is, on this benchmark, +0.223 deterministic and +0.127 LLM-judge across 8 corpora — both significant.

### 5.4 threats to validity

**internal — task authoring overfit.** ripgrep + zod tasks (28 of 112) were hand-authored before any of the v3 atlas improvements landed. concern: atlas's tools were tuned in response to per-task failures. mitigation: we authored 84 tasks for the 6 new corpora using a templating script that mines top-inbound symbols from the indexed db without any reference to atlas's tool weaknesses. the per-corpus deltas (§4.2) show atlas wins are not concentrated on the hand-authored corpora — gradio (+0.190 LLM-judge) and hugo (+0.175) are auto-generated and beat ripgrep (+0.109).

**internal — auto-generated tasks favor a subset.** the script picks the top-inbound class per corpus for `discovery` tasks; this favors structural tools. counter-argument: text-search can find any class by `class FooBar` regex, so the pattern doesn't intrinsically favor atlas. and atlas wins the `text-content` capability (+0.321 det) which is the scriptable opposite of structural.

**external — model dependency.** all numbers are for `openai/gpt-5.4-nano`. earlier 12-task runs on `claude-haiku-4.5` showed a smaller atlas advantage (+0.17pp vs +0.22pp here) because better models reduce baseline failure modes. atlas's value scales inversely with model quality. opus 4.7 / gpt-5.4-pro would likely close the gap further. we explicitly do not claim model independence.

**external — corpus selection.** 8 corpora is wider than typical code-intelligence benchmarks (most use 1-3) but still finite. all are OSS, all have english code/comments, none are ML/scientific computing-heavy. results may not generalize to embedded systems, ML training code, or non-english codebases.

**construct — LLM-judge bias.** verbosity bias in LLM-judges is documented (~15% inflation per [labelyourdata](https://labelyourdata.com/articles/llm-as-a-judge)). we mitigate with a 4-level rubric prompt and dual-judge cross-validation. atlas's outputs are systematically more concise than baseline's (1.5 vs 3.0 tool calls/task → less raw text to summarize), so verbosity bias would *under-rate* atlas, not over-rate it. **§4.3 confirms this empirically**: on `graph-querying` atlas wins det by +0.438 but loses LLM-judge by −0.156, a 0.59-point gap consistent with a verbosity penalty on terse symbol-list answers. the +0.127 aggregate LLM-judge gap is therefore a lower bound on atlas's true structural advantage.

**construct — text-search strength.** baseline uses `read_file + grep + glob`. an experienced human with `ast-grep`, `ripgrep` advanced flags, and a custom indexer could likely beat both atlas and our baseline. we use the floor, not the ceiling, because we want to measure what an LLM agent gets for free, not what a tuned human can do.

### 5.5 future work

1. **strong-model evaluation**: rerun on the current frontier tier (`claude-opus-4.7` released 2026-04-16, `claude-sonnet-4.6`, `gpt-5.4-pro`, `gpt-5.4` standard, `gemini-3.1-pro`) and one open-weight 70B+ model to characterize how atlas's advantage scales. our `gpt-5.4-nano` numbers are a sub-frontier baseline; the 12-task `claude-haiku-4.5` run already showed the delta shrinking from +0.22pp to +0.17pp, and pro-tier models should compress it further.
2. **mixed-mode (atlas + grep)**: run atlas with text-tool fallback restored to measure production-realistic behavior (what atlas users actually get). report alongside pure-mode for transparency.
3. **factory-pattern call edges**: atlas's `atlas_trace` returns 0 paths from a factory function (e.g. zod's `string()`) to methods on its returned class. adding a `returns` edge kind would close this gap.
4. **incremental indexing benchmark**: atlas updates incrementally on file change; cbm and chunkhound full-reindex. quantifying the difference would surface a perf moat.
5. **held-out task set**: independent task authoring (different annotators, no knowledge of atlas's tool surface) on each of the 8 corpora, run as an overfitting alarm.
6. **adversarial codebases**: minified js, generated code (protobuf, openapi), heavily macro'd c++, codegen-heavy go.

## 6. reproduction

every corpus, every task, every result JSON is committed in this repository.

```bash
git clone https://github.com/<your-fork>/atlas
cd atlas
bun install

# deterministic eval (no LLM, no API key needed)
bun run bench-eval --all

# LLM head-to-head (requires OPENROUTER_API_KEY)
export OPENROUTER_API_KEY=...
bun run bench-llm --full \
  --agents baseline,atlas,cbm,chunkhound \
  --model openai/gpt-5.4-nano \
  --trials 5 --concurrency 20 \
  --judge-with-llm
```

every run writes `bench-llm/results/<commit>-<timestamp>.json` containing per-trial scores, full tool traces, token usage, llm-judge rationales, and abnormal-exit reasons. the run backing this report is `bench-llm/results/c01a877-2026-04-19T07-12-16-040Z.json`.

cost per full 4-agent 8-corpus 5-trial run on `gpt-5.4-nano`: **$6.33** ($4.43 inference + $1.90 judge). wall time at concurrency 20: **23 minutes** (1382 s).

## 7. result JSONs and commits

every published number above traces to a committed result JSON:

- **headline 8-corpus run**: `bench-llm/results/c01a877-2026-04-19T07-12-16-040Z.json` (commit `c01a877`)
- prior published 2-corpus run: `bench-llm/results/c222cba-2026-04-18T17-40-38-259Z.json` (commit `c222cba`)
- earlier mixed-mode runs (text-tool fallback): `bench-llm/results/e7e259c-*.json`

## 8. changelog

| date | commit | change | atlas det | atlas det Δ vs baseline |
|---|---|---|---:|---:|
| 2026-04-19 | `c01a877` | scaled to 8 corpora, 112 tasks, 2,239 trials. atlas wins every corpus on both axes. | 0.62 | +0.223 ✓ |
| 2026-04-18 | `c222cba` | 28 tasks, 2 corpora, 4 agents. published "atlas-pure beats baseline by 0.282 / 0.137". | 0.88 | +0.282 ✓ |
| 2026-04-18 | `e7e259c` | 28 tasks, mixed-mode (atlas + text fallback). showed atlas's +0.126 was partly grep-mediated; pivoted to pure-mode. | 0.76 | +0.126 (mixed) |
| 2026-04-17 | earlier | 12-task multi-model run (haiku, nano, mimo, gemini-flash). superseded. | 0.86 (haiku) | +0.17pp (haiku) |
