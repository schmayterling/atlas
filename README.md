# atlas

code intelligence for developers and agents. indexes TypeScript/JavaScript codebases and answers structural questions about dependencies, blast radius, execution flow, and dead code. zero hallucination; every answer comes from the actual code graph.

## what it does

- **index** a codebase incrementally using tree-sitter (syntax) + TypeScript compiler API (resolution)
- **search** symbols by name (FTS5) or meaning (semantic search via Ollama embeddings)
- **deps** shows what a symbol depends on and what depends on it
- **blast** computes blast radius: what code is affected if a symbol changes
- **trace** finds execution paths between two symbols
- **dead-code** finds unreferenced symbols
- **MCP server** exposes all of the above as tools for AI agents (Claude Code, Cursor, etc.)

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
```

for semantic search (natural language queries):

```bash
# install ollama if you don't have it
brew install ollama   # macOS
# or: curl -fsSL https://ollama.com/install.sh | sh   # linux

# index with embeddings (auto-pulls all-minilm model, ~50MB)
bun run src/bin.ts index

# search by meaning
bun run src/bin.ts search --semantic "validates user input"
```

## CLI commands

| command | description |
|---------|-------------|
| `atlas init` | create .atlas/ directory with config |
| `atlas index` | incremental index (`--full` for re-index, `--no-embed` to skip embeddings) |
| `atlas status` | index health, stats, staleness |
| `atlas search <query>` | find symbols by name (`--semantic` for natural language, `--kind` to filter) |
| `atlas deps <symbol>` | dependency tree (`--direction upstream/downstream/both`, `--depth N`) |
| `atlas blast <target>` | blast radius for a symbol or file (`--depth N`) |
| `atlas trace <from> <to>` | execution paths between two symbols (`--max-paths N`, `--depth N`) |
| `atlas dead-code` | unreferenced symbols (`--kind function`, `--path src/`) |
| `atlas mcp` | start MCP server (stdio transport) |

all commands support `--json` for machine-readable output. piped output auto-detects non-TTY and defaults to JSON.

## MCP server (for AI agents)

atlas exposes 8 tools via the [Model Context Protocol](https://modelcontextprotocol.io):

`atlas_status`, `atlas_search`, `atlas_semantic_search`, `atlas_resolve_symbol`, `atlas_deps`, `atlas_blast_radius`, `atlas_trace`, `atlas_dead_code`

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
MCP (stdio)     --+--> engine.ts --> queries/ --> bun:sqlite + graphology
                                       |
                               indexer (tree-sitter + TS compiler API)
                               embeddings (Ollama + sqlite-vec)
```

- **storage**: bun:sqlite (single .atlas/atlas.db file). FTS5 for text search. sqlite-vec for vector search.
- **graph**: graphology MultiDirectedGraph loaded on-demand for traversals (BFS, DFS, path finding). budget-capped to prevent memory blowup.
- **indexing**: tree-sitter for fast syntax extraction, TypeScript compiler API for cross-file resolution (module resolution, symbol binding, re-export chains). incremental via git-aware change detection.
- **embeddings**: Ollama all-minilm model (384 dims). optional, graceful degradation when unavailable.

## development

```bash
bun run src/bin.ts       # run any command
bun run dogfood          # regression test (indexes itself, benchmarks all queries)
make lint                # biome check
make format              # biome format
```

## project structure

```
src/
  bin.ts                          # entry point
  cli/                            # commander CLI (9 commands)
  mcp/                            # MCP server (8 tools)
  core/
    engine.ts                     # query facade
    storage/                      # bun:sqlite store, schema, migrations
    parser/                       # tree-sitter parsing + TS/JS extractors
    indexer/                      # file discovery, change detection, TS resolver
    graph/                        # graphology wrapper, BFS, budget caps
    queries/                      # search, deps, blast radius, flow trace, dead code
    embeddings/                   # Ollama client, embedding pipeline
  shared/                         # types, config, logger, identity
scripts/
  dogfood.ts                      # regression + benchmark script
```

## status

internal tool. not published to npm. phases 1 and 2 complete, 3 deep reviews passed.

current dogfood stats (indexes itself): 40 files, 451 symbols, 959 edges in 0.9s. all queries sub-millisecond.

## license

MIT
