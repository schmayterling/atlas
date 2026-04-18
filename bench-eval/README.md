# bench-eval

reproducible corpus benchmark for atlas. clones pinned OSS repos,
indexes them, runs typed capability tasks against atlas and a
text-search baseline, scores both. distinct from `bench-llm/` which
covers the agentic-LLM eval (phase C of the benchmark plan).

two outputs, never cross-aggregated:
- `docs/BENCHMARK.md` — head-to-head atlas vs text-search on tasks
  both can reasonably attempt
- `docs/CAPABILITIES.md` — atlas-only showcase (blast, test-coverage,
  cross-file aliases, etc.) measured pass/fail with no baseline column

## running

```bash
bun run bench-eval --corpus ripgrep      # one corpus
bun run bench-eval --all                 # every corpus
bun run bench-eval --capabilities        # atlas-only tasks across all corpora
```

each run writes `bench-eval/results/<commit>-<timestamp>.json`.

## layout

```
bench-eval/
├── lib/
│   ├── corpus.ts          # idempotent git clone into .bench-cache/
│   └── judge.ts           # typed scorers: symbol-set / count / file-path / structural
├── agents/
│   ├── text-search.ts     # Bun.glob + rg + Bun.file().text()  (NO LLM)
│   └── atlas.ts           # dispatches to engine methods         (NO LLM)
├── corpora/
│   └── <name>/manifest.json   # { git_url, ref, expected_languages, root_subdir? }
├── tasks/
│   └── <corpus>/<id>.json     # { capability, intent, atlas_method, expected, comparable_to_text_search }
├── results/                   # gitkept dir; runs land here
└── run.ts                     # entrypoint
```

## corpora are pinned, never rolled

manifests pin a SHA. results.json files commit alongside, so the
historical numbers stay auditable.

## adding a task

1. ensure the corpus is in `corpora/`
2. create `tasks/<corpus>/<id>.json`:
   ```json
   {
     "id": "ripgrep-discovery-001",
     "capability": "discovery",
     "intent": "find the function that prints the version banner",
     "atlas_method": "search",
     "atlas_args": { "q": "print_version", "limit": 5 },
     "expected": { "type": "symbol-set", "symbols": ["src/main.rs::print_version"] },
     "comparable_to_text_search": true,
     "text_search_strategy": "rg --files-with-matches \"fn print_version\""
   }
   ```
3. run `bun run bench-eval --corpus <name>` to validate
4. commit task + the first results json
