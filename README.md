# atlas

code intelligence for developers and agents. indexes TypeScript/JavaScript and Python codebases and answers structural questions about dependencies, blast radius, execution flow, and dead code. zero hallucination; every answer comes from the actual code graph.

## what it does

- **index** a codebase incrementally using tree-sitter (syntax) + TypeScript compiler API (resolution)
- **search** symbols by name (FTS5) or meaning (semantic search via Ollama embeddings)
- **deps** shows what a symbol depends on and what depends on it
- **blast** computes blast radius: what code is affected if a symbol changes
- **trace** finds execution paths between two symbols
- **dead-code** finds unreferenced symbols
- **watch** continuous re-indexing on file changes
- **web UI** interactive dashboard, symbol browser, graph explorer, flow trace viewer, and code wiki
- **MCP server** exposes all of the above as tools for AI agents (Claude Code, Cursor, etc.)

## supported languages

| language | syntax extraction | cross-file resolution |
|----------|------------------|----------------------|
| TypeScript/JavaScript | tree-sitter | TS compiler API (full) |
| Python | tree-sitter | intra-file only |

## quickstart

requires [bun](https://bun.sh) and (optionally) [ollama](https://ollama.com) for semantic search.

```bash
git clone https://github.com/0x6d6179/atlas.git
cd atlas
bun install

# initialize and index a project
bun run src/bin.ts init
bun run src/bin.ts index

# explore
bun run src/bin.ts search AtlasEngine
bun run src/bin.ts deps blastCommand
bun run src/bin.ts blast store.ts
bun run src/bin.ts trace blastCommand blast
bun run src/bin.ts dead-code

# launch web UI
bun run src/bin.ts serve

# watch for changes and re-index automatically
bun run src/bin.ts watch --serve
```

for semantic search (natural language queries):

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
| `atlas index` | incremental index (`--full` for re-index, `--no-embed` to skip vector embeddings, `--no-summarize` to skip LLM summaries) |
| `atlas status` | index health, stats, staleness |
| `atlas search <query>` | find symbols by name (`--semantic` for natural language, `--kind` to filter) |
| `atlas deps <symbol>` | dependency tree (`--direction upstream/downstream/both`, `--depth N`) |
| `atlas blast <target>` | blast radius for a symbol or file (`--depth N`) |
| `atlas trace <from> <to>` | execution paths between two symbols (`--max-paths N`, `--depth N`) |
| `atlas dead-code` | unreferenced symbols (`--kind function`, `--path src/`) |
| `atlas serve` | start web UI + MCP HTTP (`--port 3000`, `--no-open`) |
| `atlas watch` | watch for changes and re-index (`--serve` to include web UI, `--no-embed`, `--no-summarize`) |
| `atlas mcp` | start MCP server (stdio transport) |
| `atlas duplicates` | semantically similar function/class pairs detected from embeddings |
| `atlas flows` | detected execution flows (LLM-named when ollama is available) |

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

atlas exposes 8 tools via the [Model Context Protocol](https://modelcontextprotocol.io):

`atlas_status`, `atlas_search`, `atlas_semantic_search`, `atlas_resolve_symbol`, `atlas_deps`, `atlas_blast_radius`, `atlas_trace`, `atlas_dead_code`

available via two transports:
- **stdio**: `atlas mcp` (for Claude Code, Cursor, etc.)
- **HTTP**: `atlas serve` exposes MCP at `http://localhost:3000/mcp` (streamable HTTP transport)

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

then ask: "what depends on AtlasEngine?", "what's the blast radius of changing store.ts?", "find code that handles errors"

## architecture

```
CLI (commander) --+
MCP (stdio/HTTP)--+--> engine.ts --> queries/ --> bun:sqlite + graphology
Web (hono)      --+                    |
                               indexer (tree-sitter + TS compiler API)
                               embeddings (Ollama + sqlite-vec)
                               watcher (chokidar)
```

- **storage**: bun:sqlite (single .atlas/atlas.db file). FTS5 for text search. sqlite-vec for vector search.
- **graph**: graphology MultiDirectedGraph loaded on-demand for traversals (BFS, DFS, path finding). budget-capped to prevent memory blowup.
- **indexing**: language-agnostic extractor registry. tree-sitter for fast syntax extraction. TypeScript compiler API for cross-file resolution (TS/JS only). incremental via git-aware change detection.
- **embeddings**: Ollama `nomic-embed-text` (768 dims). optional, graceful degradation when unavailable. embed text includes file context **and the actual source body** (not just metadata), capped to fit ollama's effective 2048-token embed context.
- **web**: Hono HTTP server, React 19 SPA (Tailwind CSS v4 dark theme, Cytoscape.js graph viz), bundled at startup by Bun.build.
- **watch**: chokidar file watcher with debounced re-indexing. `atlas watch --serve` combines continuous indexing with the web UI.

## development

```bash
bun run src/bin.ts       # run any command
bun test tests/          # unit + integration tests (~80 tests, ~2s, no Ollama)
bun run typecheck        # tsc --noEmit -p tsconfig.test.json (covers src + tests)
bun run dogfood          # perf regression test (indexes itself, benchmarks all queries)
bun run lint             # biome check
bun run format           # biome format
```

both `bun test tests/` and `bun run dogfood` should pass before any commit. tests cover correctness (store, queries, extractors, web routes via in-process Hono, MCP server via `InMemoryTransport`); dogfood covers perf regressions against a local baseline.

## project structure

```
src/
  bin.ts                          # entry point
  cli/                            # commander CLI
  mcp/                            # MCP server (8 tools, stdio + HTTP)
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
    engine-pool.ts                # per-project AtlasEngine cache (multi-project routing)
    storage/                      # bun:sqlite store, schema, migrations
    parser/
      parser-manager.ts           # language registry + tree-sitter cache
      extractor-registry.ts       # language-agnostic extractor dispatch
      extractors/                 # typescript.ts, python.ts
    indexer/                      # file discovery, change detection, TS resolver, watcher
    graph/                        # graphology wrapper, BFS, budget caps
    queries/                      # search, deps, blast, trace, dead-code, duplicates, flows, api-trace
    embeddings/                   # Ollama client, embed pipeline (source-body-aware)
    llm/                          # summary + flow naming pipelines
  shared/                         # types, config, logger, identity
tests/
  unit/                           # pure-function tests (identity, config, change-detector, extractors, embed-pipeline)
  integration/                    # tmp-store + fixture-engine tests (store, indexer, queries, web-routes, mcp-server)
  fixtures/tiny-project/          # 6 .ts files used by integration tests
  helpers/                        # setup, tmp-store, fixture-engine, parse
scripts/
  dogfood.ts                      # perf regression + benchmark script
```

## status

internal tool. not published to npm. phases 1-5 complete (multi-project, cross-project edges, API tracing, LLM summaries, duplicate detection), 4 deep reviews passed, ~80 unit + integration tests in place.

current dogfood stats (atlas indexing itself): 86 files, 729 symbols, 1735 edges in ~1.5s. all queries sub-millisecond.

## license

MIT
