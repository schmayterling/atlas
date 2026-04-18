# atlas capabilities showcase

things atlas can answer that a text-search agent (`rg`, `glob`, file
read) cannot. companion to `docs/BENCHMARK.md`, which covers the
head-to-head comparable subset.

every task here is graded against an explicit `expected` (symbol set,
count tolerance, or structural predicate) — no LLM grading. text search
has no row in these tables because the answer requires graph traversal,
type resolution, or both, which grep cannot do.

## why the split

aggregating "atlas vs grep on tasks grep can do" with "atlas alone on
tasks grep can't" produces an inflated number that reads as cooked.
codex review (notes in `.claude/plans/fizzy-baking-sphinx.md`) was
explicit on this point. so:

- `BENCHMARK.md` = the strict apples-to-apples comparison
- `CAPABILITIES.md` = the showcase of features atlas adds on top

both are real numbers; neither is the "headline" alone.

## reproduction

```bash
bun run bench-eval --capabilities
```

writes `bench-eval/results/<commit>-<timestamp>.json` with all
non-comparable tasks across every corpus.

## results

**ripgrep**

| task                          | capability       | score |    ms |
|-------------------------------|------------------|------:|------:|
| ripgrep-04-call-tracing       | call-tracing     |  1.00 |  0.48 |
| ripgrep-05-graph-querying     | graph-querying   |  1.00 |  4.75 |

**zod**

| task                          | capability       | score |    ms |
|-------------------------------|------------------|------:|------:|
| zod-04-call-tracing           | call-tracing     |  1.00 |  2.28 |
| zod-05-graph-querying         | graph-querying   |  1.00 | 20.35 |

**combined (4 atlas-only tasks)**: aggregate 1.00. text search has no
column here by construction.

## capability categories shown above

- **call-tracing**: who calls a given function? atlas walks the
  resolved-edge graph (TS compiler resolution where available);
  text search would have to grep the call name and false-positive
  on string literals, type annotations, comments.
- **graph-querying**: blast radius, trace, subsystem detection.
  atlas computes transitive closures over the symbol graph; text
  search has no edges to traverse.

## not yet shown but planned

- **test-coverage**: which test files exercise a given symbol?
  atlas joins `test_links` populated during indexing.
- **dead-code reachability**: what's unreferenced from any entry
  point? atlas does a reachability pass; text search returns
  symbols-not-found-by-name, which is wildly different.
- **cross-file alias resolution**: `import { Foo as Bar } from './x'`,
  then `Bar()` — atlas resolves this to the original Foo via the TS
  compiler API; text search loses the link.
