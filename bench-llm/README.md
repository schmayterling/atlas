# bench-llm

LLM-driven head-to-head benchmark. asks two agents the same questions
and measures which one earns its tool slot.

- **baseline**: read_file + grep + glob (no atlas)
- **with-atlas**: same tools PLUS atlas_search, atlas_overview,
  atlas_deps, atlas_blast_radius, atlas_trace, atlas_call_sites,
  atlas_test_coverage, atlas_files

both agents run on the SAME tasks from `bench-eval/tasks/<corpus>/`,
so the LLM eval answers the same structural questions as the
deterministic eval — just with prompt noise + token cost added.

LLM access goes through OpenRouter. one HTTP API for anthropic +
openai + gemini + open-weights, so swapping models is `--model
<provider/name>`. usage and cost come back exact from the provider.

## running

requires `OPENROUTER_API_KEY` env var.

```bash
OPENROUTER_API_KEY=sk-or-... bun run bench-llm --ci          # ~5 cheapest tasks
OPENROUTER_API_KEY=sk-or-... bun run bench-llm --full        # full curated subset
bun run bench-llm --ci --model openai/gpt-4o-mini            # cheaper-tier comparison
bun run bench-llm --task ripgrep-04-call-tracing             # one task
```

defaults: `anthropic/claude-haiku-4.5`, 1 trial per task. raise with
`--trials 3` for variance estimation.

## what's measured

per trial:
- `score` — bench-eval/lib/judge.ts result (0..1) on the task's typed
  expected
- `tokens` — input + output, exact, from the provider
- `cost` — passed through from openrouter
- `toolCalls` — how many tool invocations the agent made
- `wallMs` — end-to-end wall time
- `stoppedReason` — natural / max-iters / error

aggregates print at the end of every run, plus a results JSON lands
in `bench-llm/results/<commit>-<timestamp>.json` for diffing.

## layout

```
bench-llm/
├── lib/
│   ├── openrouter.ts      # minimal openai-shape client + tool-use loop
│   ├── text-tools.ts      # read_file / grep / glob (every agent)
│   ├── atlas-tools.ts     # atlas_* tools (with-atlas only)
│   └── llm-agent.ts       # shared driver — prompt, JSON parse, scoring
├── agents/
│   ├── baseline.ts        # text tools only
│   └── with-atlas.ts      # text tools + atlas tools
├── results/               # gitkept, runs land here
├── run.ts                 # entrypoint with --ci / --full / --task / --model
└── README.md
```

## why it's a separate dir from `bench-eval/`

`bench-eval/` is the deterministic capability eval — atlas vs
text-search baseline, no LLM. `bench-llm/` is the same TASK SET but
with an LLM driving each agent. keeping the harnesses separate avoids
conflating "atlas's structural correctness" with "model + atlas
behaviour with prompt noise". per the codex review note in the plan
file: never aggregate across these into one headline.

## CI subset

the `CI_TASK_IDS` set in `run.ts` controls what `--ci` runs. picked
to keep cost under ~$1 and surface the most interesting deltas
(call-tracing, graph-querying, hardest discovery cases). expand when
the harness has shipped real numbers a few times.
