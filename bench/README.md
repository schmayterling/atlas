# bench

scenario-based correctness regression harness. see #83 for motivation.

complements the other two test layers:

- `bun test tests/` — unit + integration, runs on every commit
- `bun run bench` — scenario snapshots, runs per PR / pre-release
- `bun run dogfood` — perf regression gate, runs post-merge

each scenario seeds a small synthetic codebase, runs a set of named
queries, and snapshots the results to `expected.json`. a reviewer
approves behaviour changes by regenerating the snapshot.

## running

```bash
bun run bench                          # run every scenario
bun run bench -- --update              # rewrite expected.json files
bun run bench -- federation-chain      # run a single scenario
```

## layout

```
bench/
├── run.ts                      # scenario runner (canonical JSON, diff preview)
├── harness.ts                  # shared helpers: setupScenario, resolveStableId
├── README.md
└── scenarios/
    └── <scenario-name>/
        ├── scenario.ts         # default-exports a Scenario
        ├── expected.json       # canonical-json snapshot
        └── (project sources)   # consumed by setupScenario via cpSync
```

## adding a scenario

1. create `bench/scenarios/<name>/`.
2. write `scenario.ts` that default-exports a `Scenario`:

   ```ts
   import type { Scenario } from '../../run.js'
   import { setupScenario, resolveStableId } from '../../harness.js'

   const scenario: Scenario = {
       name: 'my-scenario',
       timeBudgetMs: 30_000,
       async run(ctx) {
           const { projects, teardown } = await setupScenario(ctx.tmpRoot, [
               { name: 'a', sourceDir: `${ctx.scenarioDir}/project-a` },
           ])
           try {
               // run queries, return { queries: {...} }
           } finally {
               teardown()
           }
       },
   }
   export default scenario
   ```

3. populate project source dirs next to `scenario.ts`.
4. run `bun run bench -- --update` once to generate the initial snapshot.
5. commit the snapshot so future diffs surface regressions.

## snapshot semantics

- the runner serialises `result.queries` with sorted object keys so
  diffs stay stable across bun versions.
- prefer normalising project ids / file paths to scenario-local names
  in your query output — the raw content-addressed ids depend on the
  scenario's tmp path and change every run.

## what to snapshot

lean into outputs that a small bug would move. for the federation
scenario: boundary chain shape, boundary counts, reachability flags.
avoid snapshotting raw timings — use `timeBudgetMs` to catch blowups.
