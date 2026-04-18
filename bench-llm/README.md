# bench-llm

llm-judged benchmark measuring how much atlas helps an agent answer
structural questions about a codebase, vs a baseline agent that has
only `Read + Grep + Glob`. see #84 for the full motivation.

this is **phase 1**: harness skeleton + seed questions + deterministic
scoring. the two agent implementations in `agents/` are stubs; wiring
them to a real anthropic/openai sdk is a follow-up (phase 2). the
runner is deliberately cheap enough to run offline so the scaffolding
can be exercised and iterated on without burning $30+ per invocation.

## what phase 1 ships

- `run.ts`: iterates questions, runs the configured agent, scores the
  answer, reports per-question and aggregate deltas.
- `judge.ts`: deterministic scorers (`symbol-set` F1, `open-ended`
  passthrough). an llm judge goes here in phase 2.
- `agents/baseline.ts` + `agents/with-atlas.ts`: minimal local stubs
  that illustrate the interface. replace with real agent drivers in
  phase 2.
- 5 seed questions under `questions/`, spanning capability categories
  from the issue (symbol-locate, symbol-set, dependency-trace,
  impact-analysis, cross-language). `atlas-002` is the motivating
  aliased-import question.
- `corpora/atlas-pinned/CORPUS.md`: corpus contract. for phase 1 the
  corpus is "the current atlas checkout"; phase 2 adds pinned refs.

## what phase 1 does not do

- no llm calls. `scripts/run.ts` runs deterministically offline.
- no pinned refs. the corpus is whatever the runner has checked out.
- no multi-trial variance reporting. one pass per question.
- no cost / token budgeting.

## running

```bash
bun run bench-llm                              # baseline vs with-atlas stub
bun run bench-llm -- --agent baseline          # only baseline
bun run bench-llm -- --question atlas-002      # single question
bun run bench-llm -- --corpus atlas-pinned     # explicit corpus (default)
```

## adding a question

1. create `questions/<id>.json` using the `Question` shape in `run.ts`:

   ```json
   {
     "id": "atlas-003",
     "corpus": "atlas-pinned",
     "ref": "17a8bb5",
     "capability": "impact-analysis",
     "question": "what files call X?",
     "expected": { "type": "symbol-set", "symbols": ["foo::bar"] },
     "rubric_notes": "...",
     "budget": { "toolCalls": 15, "tokens": 15000 }
   }
   ```

2. run `bun run bench-llm -- --question <id>` to validate the judge.
3. commit the question + the first trial's output in `runs/` if useful
   for reviewer context.

## scoring

- `symbol-set`: F1 over predicted vs expected identifier set.
- `open-ended`: returns 1.0 when the stub detects the expected string,
  else 0. phase 2 replaces this with an llm judge using a structured
  rubric.

## headline metric (phase 2)

```
delta = mean(score_with_atlas) - mean(score_baseline)
```

positive values mean atlas earned its tool slot for that capability.
tracked per capability so "atlas loses at symbol-locate but wins at
dependency-trace" shows up as a grouped report, not a single average.
