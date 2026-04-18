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
OPENROUTER_API_KEY=sk-or-... bun run bench-llm --ci              # ~5 cheapest tasks
OPENROUTER_API_KEY=sk-or-... bun run bench-llm --full            # full curated subset
bun run bench-llm --ci --model openai/gpt-4o-mini                # cheaper-tier comparison
bun run bench-llm --task ripgrep-04-call-tracing                 # one task
bun run bench-llm --full --trials 3                              # 3 trials per task
bun run bench-llm --full --concurrency 8                         # 8 jobs in flight
bun run bench-llm --full --agents baseline,atlas,cbm,chunkhound  # head-to-head with competitors
```

defaults: `anthropic/claude-haiku-4.5`, 1 trial per task,
concurrency 5, `--agents baseline,atlas`. raise `--trials` for
variance estimation; raise `--concurrency` to shorten wall time.
openrouter handles upstream rate limits, but bumping past ~10 on a
free-tier key tends to produce 429s that show up as error rows.

## comparing against codebase-memory-mcp + chunkhound

bench-llm can spawn external MCP servers as additional agents and
score them on the same task set. install the competitors first:

**codebase-memory-mcp** (one-time):
```bash
# binary is `codebase-memory-mcp` (project's actual name).
# download from https://github.com/DeusData/codebase-memory-mcp
# put it on your PATH (or export CODEBASE_MEMORY_MCP_BIN=/path/to/binary).
which codebase-memory-mcp     # should resolve
codebase-memory-mcp --version # confirms it runs
```

invoking the binary with no args starts an MCP server on stdio —
that's what bench-llm spawns.

**chunkhound** (one-time):
```bash
pip install chunkhound
which chunkhound       # should resolve

# embeddings: this benchmark ships a config that points chunkhound at
# the local ollama server, so you do NOT need a paid voyage / openai
# key. you DO need ollama running with the nomic-embed-text model:
ollama pull nomic-embed-text
ollama serve &         # if not already running

# verify ollama is up:
curl -s http://localhost:11434/api/tags | grep nomic-embed-text
```

the chunkhound config used by bench-llm lives at
`bench-llm/config/chunkhound.json`. it points chunkhound at
`http://localhost:11434/v1` with the `nomic-embed-text` model — the
same embedding atlas uses, so neither tool gets a quality advantage
from a paid embedding tier. swap models / providers by editing the
file directly, or set `CHUNKHOUND_CONFIG_FILE` to point elsewhere.

**explicit `--agents` flag is required to include cbm + chunkhound.**
the default `--agents` list is `baseline,atlas` so existing benchmark
runs don't suddenly try to spawn binaries that aren't installed.
to include cbm and chunkhound:

```bash
bun run bench-llm --full --agents baseline,atlas,cbm,chunkhound \
  --model anthropic/claude-haiku-4.5 --trials 3 --concurrency 8
```

cost estimate: 12 tasks × 4 agents × 3 trials = 144 LLM rounds × $X
per round depending on model. ~$10 on haiku, ~$1 on nano/gemini-lite.
this is the apples-to-apples head-to-head BENCHMARK.md keeps
referring to as "tracked as a follow-up." once you run it, drop the
results json in `bench-llm/results/` and update `BENCHMARK.md`.

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
│   ├── mcp-client.ts      # spawn external mcp server, bridge to OpenAI tool format
│   ├── llm-agent.ts       # shared driver — prompt, JSON parse, scoring
│   └── pool.ts            # concurrency pool
├── agents/
│   ├── baseline.ts        # text tools only
│   ├── with-atlas.ts      # text tools + atlas tools (in-process)
│   ├── with-cbm.ts        # text tools + codebase-memory-mcp tools (spawned)
│   └── with-chunkhound.ts # text tools + chunkhound tools (spawned)
├── results/               # gitkept, runs land here
├── run.ts                 # entrypoint
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
