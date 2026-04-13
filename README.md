# atlas

code intelligence for developers and agents. indexes multi-language codebases and answers structural questions about dependencies, blast radius, execution flow, test coverage, churn, hotspots, and dead code. zero hallucination; every answer comes from the actual code graph.

## what it does

- **index** a codebase incrementally using tree-sitter (syntax) + TypeScript compiler API (TS/JS resolution) + custom Go resolver (package-qualified calls, receiver-method calls on typed locals, cross-package type refs)
- **search** symbols by name (FTS5) or meaning (semantic search via Ollama embeddings)
- **deps** shows what a symbol depends on and what depends on it
- **blast** computes blast radius: what code is affected if a symbol changes
- **trace** finds execution paths between two symbols across packages
- **dead-code** finds unreferenced symbols via recursive reachability from an export + test + api-endpoint root set
- **tests / untested** map test files to the source symbols they exercise (`called` and `imported` confidence tiers, including `passed_as` middleware registration)
- **hotspots / hot-fragile** rank symbols and files by `fanin × churn × (1 − coverage)` to surface the riskiest refactor candidates
- **churn / history / contributors / co-change** git-aware file and commit analysis
- **subsystems** auto-detect high-level modules via graph community detection
- **channels** cross-language symbol linking via shared values (sql_table today; graphql / queue / env / openapi tracked under #30)
- **duplicates / flows** LLM-assisted code smell and execution-flow detection from embeddings
- **projects / use / --all-projects / --linked** multi-repo registry + federated search fan-out across linked projects
- **watch** continuous re-indexing on file changes
- **web UI** interactive dashboard, symbol browser, graph explorer, flow trace viewer, and code wiki
- **MCP server** exposes the core graph as tools for AI agents (Claude Code, Cursor, etc.)

## supported languages

| language | syntax extraction | cross-file resolution |
|----------|------------------|----------------------|
| TypeScript/JavaScript | tree-sitter | TS compiler API (full, workspace-bucket aware) |
| Go | tree-sitter | package-qualified calls, type refs, receiver-method calls on typed locals, `package_clause`-aware binding |
| Python | tree-sitter | intra-file only |
| Rust | tree-sitter | intra-file only |

## quickstart

requires [bun](https://bun.sh) and (optionally) [ollama](https://ollama.com) for semantic search and LLM summaries.

```bash
git clone https://github.com/schmayterling/atlas.git
cd atlas
bun install

# initialize and index a project
bun run src/bin.ts init
bun run src/bin.ts index --no-summarize --no-embed

# explore
bun run src/bin.ts search AtlasEngine
bun run src/bin.ts deps blastCommand
bun run src/bin.ts blast store.ts
bun run src/bin.ts trace blastCommand blast
bun run src/bin.ts dead-code
bun run src/bin.ts hot-fragile
bun run src/bin.ts channels list

# launch web UI
bun run src/bin.ts serve

# watch for changes and re-index automatically
bun run src/bin.ts watch --serve
```

for semantic search and LLM summaries:

```bash
# install ollama if you don't have it
brew install ollama   # macOS
# or: curl -fsSL https://ollama.com/install.sh | sh   # linux

# pull the embedding model (~270MB) and a chat model for LLM summaries
ollama pull nomic-embed-text
ollama pull qwen2.5-coder:1.5b   # optional, used by --summarize and flow naming

# index with embeddings + source bodies
bun run src/bin.ts index

# search by meaning
bun run src/bin.ts search --semantic "validates user input"
```

## CLI commands

| command | description |
|---------|-------------|
| `atlas init` | create .atlas/ directory with config |
| `atlas index` | incremental index (`--full` for re-index, `--no-embed` skip vector embeddings, `--no-summarize` skip LLM summaries, `--no-cochange`, `--no-github`) |
| `atlas status` | index health, stats, staleness |
| `atlas search <query>` | find symbols by name (`--semantic`, `--kind`, `--exact`, `--all-projects`, `--linked`) |
| `atlas deps <symbol>` | dependency tree (`--direction upstream/downstream/both`, `--depth N`) |
| `atlas blast <target>` | blast radius for a symbol or file (`--depth N`) |
| `atlas trace <from> <to>` | execution paths between two symbols (`--max-paths N`, `--depth N`) |
| `atlas dead-code` | unreferenced symbols via recursive reachability (`--kind`, `--path`, `--include-tests`) |
| `atlas tests <symbol>` | test files covering a symbol (called + imported confidence) |
| `atlas untested` | exported symbols with no called coverage (`--kind`, `--limit`) |
| `atlas hot-fragile` | rank files by churn × untested-symbol count |
| `atlas hotspots` | rank exported symbols by fanin × churn × (1 − coverage) (`--coverage called/imported/none`) |
| `atlas channels list` | list cross-language channel groups (`--kind sql_table`) |
| `atlas channels show <kind> <value>` | list every symbol that touches a channel value |
| `atlas churn` | files ranked by commit count (`--path`, `--since-days`) |
| `atlas history <file>` | git commit history for a file |
| `atlas contributors [file]` | top contributors overall or per file |
| `atlas co-change` | file pairs that change together (Jaccard similarity) |
| `atlas subsystems` | detected high-level subsystems (graph community detection) |
| `atlas subsystem <id>` | detail for one subsystem (member files, top exported symbols) |
| `atlas flows` | detected execution flows (LLM-named when ollama is available) |
| `atlas duplicates` | semantically similar function / class pairs detected from embeddings |
| `atlas projects <add/remove/list/link>` | multi-project registry |
| `atlas use [id]` | set or show the active project |
| `atlas serve` | start web UI + MCP HTTP (`--port 3000`, `--no-open`) |
| `atlas watch` | watch for changes and re-index (`--serve` to include web UI) |
| `atlas mcp` | start MCP server (stdio transport) |

all commands support `--json` for machine-readable output. piped output auto-detects non-TTY and defaults to JSON.

## web UI

`atlas serve` launches a local web interface at `http://localhost:3000` with:

- **dashboard**: index health, file/symbol/edge counts, language distribution
- **search**: debounced symbol search with kind filter, detail panel with source code and dependencies
- **graph**: interactive dependency graph and blast radius visualization (Cytoscape.js), click-to-explore nodes
- **trace**: execution path finder between two symbols with step-by-step flow display
- **dead code**: unreferenced symbol browser with kind/path filters and summary stats
- **wiki**: auto-generated documentation from docstrings, file tree navigation, rendered source code

the web UI is built at startup (React 19 + Tailwind CSS v4, bundled by Bun.build) and served from a single Hono process. no separate build step needed.

## MCP server (for AI agents)

atlas exposes 16 tools via the [Model Context Protocol](https://modelcontextprotocol.io):

`atlas_status`, `atlas_search`, `atlas_semantic_search`, `atlas_resolve_symbol`, `atlas_deps`, `atlas_blast_radius`, `atlas_trace`, `atlas_dead_code`, `atlas_history`, `atlas_churn`, `atlas_subsystems`, `atlas_subsystem`, `atlas_test_coverage`, `atlas_hot_fragile`, `atlas_channels_list`, `atlas_channels_show`

available via two transports:
- **stdio**: `atlas mcp` (for Claude Code, Cursor, etc.)
- **HTTP**: `atlas serve` exposes MCP at `http://localhost:3000/mcp` (streamable HTTP transport, fresh `McpServer` + transport built per request — the stateless SDK refuses reuse)

### claude code

add to your MCP config (`.claude.json` or settings):

```json
{
  "mcpServers": {
    "atlas": {
      "command": "bun",
      "args": ["run", "/path/to/atlas/src/bin.ts", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

then ask: "what depends on AtlasEngine?", "what's the blast radius of changing store.ts?", "which symbols touch the users table?", "which tests cover MiddlewareAuth?", "show hot-fragile files I should refactor first"

## architecture

```
CLI (commander) --+
MCP (stdio/HTTP)--+--> engine.ts --> queries/ --> bun:sqlite + graphology
Web (hono)      --+         ^
                            |
                    engine-pool.ts (per-project cache, --all-projects fan-out)
                            |
                       indexer (tree-sitter + TS compiler API + go-resolver)
                       embeddings (Ollama + sqlite-vec)
                       watcher (chokidar)
```

- **storage**: bun:sqlite (single `.atlas/atlas.db`). FTS5 for text search. sqlite-vec for vector search. schema + migrations live in `src/core/storage/schema.ts`; optional migrations are tagged inline via `Migration.optional?` and `Migration.acceptableErrors?`.
- **graph**: graphology MultiDirectedGraph loaded on-demand for traversals (BFS, DFS, path finding). budget-capped to prevent memory blowup. default edge kinds include `calls`, `type_ref`, `extends`, `passed_as`, `dispatches_to`.
- **indexing**: language-agnostic extractor registry. tree-sitter for fast syntax extraction. TypeScript compiler API for cross-file resolution (TS/JS), workspace-bucket aware (one `ts.Program` per `tsconfig.json`, released between buckets). Go cross-file resolver handles package-qualified calls, receiver-method calls on typed locals, and package-clause-aware binding. incremental via git-aware change detection + a post-resolver rebind pass that repairs importer rows orphaned by cascade.
- **test-mapping**: two-pass pipeline that credits each test file with every source symbol it reaches via `imports` (imported tier) and `calls` / `passed_as` edges (called tier). drives `tests`, `untested`, `hot-fragile`, `hotspots` coverage dimensions.
- **channel_hits**: language-agnostic cross-language link table. first channel is `sql_table` (FROM / JOIN / INTO / UPDATE scanner with T-SQL brackets, CTE suppression, and schema-prefix stripping). subsequent channels (graphql / queue / env / openapi) reuse the same table shape via `findChannelHitGroups(kind)`.
- **embeddings**: Ollama `nomic-embed-text` (768 dims). optional, graceful degradation when unavailable. embed text includes file context **and the actual source body** (not just metadata), capped to fit ollama's effective 2048-token embed context.
- **web**: Hono HTTP server, React 19 SPA (Tailwind CSS v4 dark theme, Cytoscape.js graph viz), bundled at startup by Bun.build.
- **watch**: chokidar file watcher with debounced re-indexing. `atlas watch --serve` combines continuous indexing with the web UI through a single shared engine.

## development

```bash
bun run src/bin.ts       # run any command
bun test tests/          # unit + integration tests (260 tests, ~25s, no Ollama)
bun run typecheck        # tsc --noEmit -p tsconfig.test.json (covers src + tests)
bun run dogfood          # perf regression test (indexes itself, benchmarks all queries)
bun run lint             # biome check
bun run format           # biome format
```

both `bun test tests/` and `bun run dogfood` should pass before any commit. the dogfood baseline lives in `scripts/dogfood-baseline.json` (tracked in git, refreshed via `bun run dogfood -- --refresh-baseline` — refuses to overwrite on failing runs). tests cover correctness (store, queries, extractors, web routes via in-process Hono, MCP server via `InMemoryTransport`, go-resolver fixtures, incremental reindex rebind); dogfood covers perf regressions against the tracked baseline across 8 query families.

## project structure

```
src/
  bin.ts                          # entry point
  cli/                            # commander CLI
  mcp/                            # MCP server (16 tools, stdio + HTTP)
  web/
    server.ts                     # createApp() + startWebServer() + MCP HTTP
    build.ts                      # Bun.build + Tailwind CLI pipeline
    routes/                       # REST API
    client/                       # React 19 SPA
      pages/                      # dashboard, search, graph, trace, dead-code, wiki, flows, duplicates
      components/                 # layout, graph-view, symbol-card, search-input
      lib/                        # typed API client, graph utils
  core/
    engine.ts                     # query facade
    engine-pool.ts                # per-project AtlasEngine cache (multi-project routing + federation fan-out)
    registry.ts                   # ~/.atlas/registry.json (projects, links, active project)
    storage/                      # bun:sqlite store, schema, migrations
    parser/
      parser-manager.ts           # language registry + tree-sitter cache
      extractor-registry.ts       # language-agnostic extractor dispatch
      extractors/                 # typescript.ts, python.ts, go.ts, rust.ts
    indexer/                      # file discovery, change detection, TS resolver, go-resolver, test-mapping, watcher
    graph/                        # graphology wrapper, BFS, budget caps
    queries/                      # search, deps, blast, trace, dead-code, duplicates, flows, api-trace, sql-linker, hotspots, test-coverage, git
    embeddings/                   # Ollama client, embed pipeline (source-body-aware)
    llm/                          # summary + flow naming + subsystem-description pipelines
  shared/                         # types, config, logger, identity
tests/
  unit/                           # pure-function tests (identity, config, change-detector, extractors, embed-pipeline, registry)
  integration/                    # tmp-store + fixture-engine tests (store, indexer, queries, web-routes, mcp-server, go-resolver, sql-linker, test-mapping, passed-as-edges, incremental-import-rebind)
  fixtures/tiny-project/          # 6 .ts files used by integration tests
  helpers/                        # setup (pins HOME for registry tests), tmp-store, fixture-engine, parse
scripts/
  dogfood.ts                      # perf regression + benchmark script
  dogfood-baseline.json           # tracked baseline for perf regressions
```

## status

internal tool. not published to npm. phases 1–6 shipped; phase 5 multi-project federation MVP shipped with open follow-ups tracked under #29, #30, #32.

current dogfood stats (atlas indexing itself): **147 files, 1273 symbols, 2886 edges, 22 sql_table channel groups**. 260/260 tests passing. query latencies: deps ~1.2ms, blast ~0.06ms, search ~0.26ms, trace ~1.7ms, dead-code ~3.1ms, channel-hits ~0.1ms, hotspots ~6.5ms, hot-fragile ~1.2ms.

## license

MIT
