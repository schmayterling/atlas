import { Command } from 'commander'
import { setLogLevel } from '../shared/logger.js'
import { blastCommand } from './commands/blast.js'
import { deadCodeCommand } from './commands/dead-code.js'
import { depsCommand } from './commands/deps.js'
import { indexCommand } from './commands/index-cmd.js'
import { initCommand } from './commands/init.js'
import { mcpCommand } from './commands/mcp.js'
import { serveCommand } from './commands/serve.js'
import { searchCommand } from './commands/search.js'
import { statusCommand } from './commands/status.js'
import { traceCommand } from './commands/trace.js'
import { watchCommand } from './commands/watch.js'
import {
	projectsAdd,
	projectsBuildEdges,
	projectsClearEdges,
	projectsLink,
	projectsList,
	projectsRemove,
} from './commands/projects.js'
import { useCommand } from './commands/use.js'
import {
	churnCommand,
	historyCommand,
	contributorsCommand,
	coChangeCommand,
	subsystemsCommand,
	subsystemCommand,
} from './commands/git-cmds.js'
import { hotFragileCommand, hotspotsCommand, testsCommand, untestedCommand } from './commands/test-cmds.js'
import { channelsListCommand, channelsShowCommand } from './commands/channels.js'

const program = new Command()
	.name('atlas')
	.description('code intelligence for developers and agents')
	.version('0.1.0')
	.option('-p, --project <path>', 'project root directory', process.cwd())
	.option('--json', 'output as JSON')
	.option('-v, --verbose', 'verbose logging')

program.hook('preAction', () => {
	if (program.opts().verbose) {
		setLogLevel('debug')
	}
})

program
	.command('init')
	.description('initialize atlas for a project')
	.action(() => {
		const opts = program.opts()
		initCommand(opts.project, opts.json)
	})

program
	.command('index')
	.description('index the codebase (incremental by default)')
	.option('--full', 'force full re-index')
	.option('--dry-run', 'show what would be indexed without changes')
	.option('--no-embed', 'skip vector embedding generation')
	.option('--no-summarize', 'skip LLM summary generation')
	.option(
		'--no-cochange',
		'skip co-change weighting during subsystem clustering (default: on)',
	)
	.option(
		'--no-github',
		'skip github pr + issue ingestion (default: on; gracefully skips when gh cli or remote is unavailable)',
	)
	.option('--db <path>', 'override index db path (relative to project root or absolute)')
	.action(async (cmdOpts) => {
		const opts = program.opts()
		await indexCommand(opts.project, opts.json, {
			force: cmdOpts.full,
			dryRun: cmdOpts.dryRun,
			noEmbed: !cmdOpts.embed,
			noSummarize: !cmdOpts.summarize,
			// commander negates `--no-*` flags so `cmdOpts.cochange` is
			// false when --no-cochange is passed, true otherwise. mirror
			// the withCoChange / withGitHub engine opts to keep the
			// existing indexer plumbing working.
			withCoChange: cmdOpts.cochange,
			withGitHub: cmdOpts.github,
			db: cmdOpts.db,
		})
	})

program
	.command('status')
	.description('show index health and statistics')
	.action(() => {
		const opts = program.opts()
		statusCommand(opts.project, opts.json)
	})

program
	.command('search <query>')
	.description('search for symbols by name or meaning')
	.option('-k, --kind <kind>', 'filter by symbol kind')
	.option('-e, --exact', 'exact match only')
	.option('-s, --semantic', 'semantic search (natural language, requires embeddings)')
	.option('-n, --limit <n>', 'max results', '20')
	.option('--include-tests', 'include symbols from test files')
	.option('--all-projects', 'fan the search out across every registered atlas project')
	.option(
		'--linked',
		'fan the search out across projects reachable via the active project\'s link graph',
	)
	.action(async (query, cmdOpts) => {
		const opts = program.opts()
		await searchCommand(opts.project, query, opts.json, {
			kind: cmdOpts.kind,
			exact: cmdOpts.exact,
			semantic: cmdOpts.semantic,
			limit: Number(cmdOpts.limit),
			includeTests: cmdOpts.includeTests,
			allProjects: cmdOpts.allProjects,
			linked: cmdOpts.linked,
		})
	})

program
	.command('deps <symbol>')
	.description('show dependency graph for a symbol')
	.option('-d, --direction <dir>', 'upstream, downstream, or both', 'both')
	.option('--depth <n>', 'max traversal depth', '3')
	.option('--all-projects', 'fan out across cross_project_edges (requires --project to anchor)')
	.option('--project <id>', 'project id to anchor the starting symbol when using --all-projects')
	.action((symbol, cmdOpts) => {
		const opts = program.opts()
		depsCommand(opts.project, symbol, opts.json, {
			direction: cmdOpts.direction,
			depth: Number(cmdOpts.depth),
			allProjects: cmdOpts.allProjects,
			project: cmdOpts.project,
		})
	})

program
	.command('blast <target>')
	.description('show blast radius for a file or symbol')
	.option('--depth <n>', 'max propagation depth', '5')
	.option('--no-tests', 'exclude affected test files')
	.option('--all-projects', 'fan out across cross_project_edges (requires --project to anchor)')
	.option('--project <id>', 'project id to anchor the starting target when using --all-projects')
	.action((target, cmdOpts) => {
		const opts = program.opts()
		blastCommand(opts.project, target, opts.json, {
			depth: Number(cmdOpts.depth),
			tests: cmdOpts.tests !== false,
			allProjects: cmdOpts.allProjects,
			project: cmdOpts.project,
		})
	})

program
	.command('mcp')
	.description('start MCP server (stdio transport, for AI agent integration)')
	.action(async () => {
		const opts = program.opts()
		await mcpCommand(opts.project)
	})

program
	.command('trace <from> <to>')
	.description('trace execution paths between two symbols')
	.option('--max-paths <n>', 'max paths to show', '5')
	.option('--depth <n>', 'max path depth inside a project', '10')
	.option('--hops <n>', 'max cross-project boundary hops (default 3, max 5)', '3')
	.option('--from-project <id>', 'project id where the <from> symbol lives (required for cross-project trace)')
	.option('--to-project <id>', 'project id where the <to> symbol lives (required for cross-project trace)')
	.action((from, to, cmdOpts) => {
		const opts = program.opts()
		traceCommand(opts.project, from, to, opts.json, {
			maxPaths: Number(cmdOpts.maxPaths),
			depth: Number(cmdOpts.depth),
			hops: Number(cmdOpts.hops),
			fromProject: cmdOpts.fromProject,
			toProject: cmdOpts.toProject,
		})
	})

program
	.command('dead-code')
	.description('find unreferenced symbols')
	.option('-k, --kind <kind>', 'filter by symbol kind')
	.option('--path <path>', 'filter by file path')
	.option('--include-tests', 'include symbols from test files')
	.option('--all-projects', 'union dead-code across every registered project')
	.action((cmdOpts) => {
		const opts = program.opts()
		deadCodeCommand(opts.project, opts.json, {
			kind: cmdOpts.kind,
			path: cmdOpts.path,
			includeTests: cmdOpts.includeTests,
			allProjects: cmdOpts.allProjects,
		})
	})

program
	.command('flows')
	.description('show detected execution flows')
	.action(async () => {
		const opts = program.opts()
		const { getOrCreateEngine } = await import('../core/engine-pool.js')
		const pc = (await import('picocolors')).default
		const engine = getOrCreateEngine(undefined, opts.project)
		const flows = engine.flows()
		if (opts.json) {
			console.log(JSON.stringify(flows, null, 2))
			engine.close()
			return
		}
		if (flows.length === 0) {
			console.log('no flows detected. run `atlas index` with Ollama to detect flows.')
			engine.close()
			return
		}
		console.log(pc.bold(`${flows.length} flow${flows.length > 1 ? 's' : ''} detected\n`))
		for (const f of flows) {
			console.log(`  ${pc.cyan(f.name)}${f.description ? `: ${f.description}` : ''}`)
			console.log(`    ${f.symbols.map((s) => s.name).join(' -> ')}`)
			console.log()
		}
		engine.close()
	})

program
	.command('duplicates')
	.description('show potential duplicate code')
	.option('--include-tests', 'include duplicate pairs in test files')
	.action(async (cmdOpts) => {
		const opts = program.opts()
		const { getOrCreateEngine } = await import('../core/engine-pool.js')
		const pc = (await import('picocolors')).default
		const engine = getOrCreateEngine(undefined, opts.project)
		const dups = engine.duplicates({ includeTests: cmdOpts.includeTests })
		if (opts.json) {
			console.log(JSON.stringify(dups, null, 2))
			engine.close()
			return
		}
		if (dups.length === 0) {
			console.log('no duplicates detected. run `atlas index` with embeddings to detect duplicates.')
			engine.close()
			return
		}
		console.log(pc.bold(`${dups.length} potential duplicate${dups.length > 1 ? 's' : ''}\n`))
		for (const d of dups) {
			console.log(`  ${pc.yellow((d.similarity * 100).toFixed(0) + '%')} ${d.symbolA.name} <-> ${d.symbolB.name}`)
			console.log(`    ${d.symbolA.filePath}:${d.symbolA.lineStart}  <->  ${d.symbolB.filePath}:${d.symbolB.lineStart}`)
			if (d.description) console.log(`    ${d.description}`)
			console.log()
		}
		engine.close()
	})

program
	.command('serve')
	.description('start web UI server')
	.option('--port <port>', 'server port', '3000')
	.option('--no-open', 'do not auto-open browser')
	.action(async (cmdOpts) => {
		const opts = program.opts()
		await serveCommand(opts.project, {
			port: Number(cmdOpts.port),
			open: cmdOpts.open !== false,
		})
	})

program
	.command('watch')
	.description('watch for file changes and re-index automatically')
	.option('--serve', 'also start web UI server')
	.option('--port <port>', 'web UI port (with --serve)', '3000')
	.option('--no-embed', 'skip vector embedding generation')
	.option('--no-summarize', 'skip LLM summary generation')
	.action(async (cmdOpts) => {
		const opts = program.opts()
		await watchCommand(opts.project, {
			serve: !!cmdOpts.serve,
			port: Number(cmdOpts.port),
			noEmbed: !cmdOpts.embed,
			noSummarize: !cmdOpts.summarize,
		})
	})

// projects subcommand group. each action is a real Commander
// subcommand so flag validation (required values, missing pairs,
// unknown flags) is handled by the library instead of hand-rolled
// args.indexOf probes. see #69.
const projects = program
	.command('projects')
	.description('manage projects (list, add, remove, link, build-edges, clear-edges)')

projects
	.command('list')
	.description('list registered projects and their links')
	.action(() => {
		projectsList(program.opts().json)
	})

projects
	.command('add [root] [name]')
	.description('register a project at <root> with an optional display name')
	.action((root?: string, name?: string) => {
		projectsAdd(root, name, program.opts().json)
	})

projects
	.command('remove <id>')
	.description('unregister a project by id')
	.action((id: string) => {
		projectsRemove(id, program.opts().json)
	})

projects
	.command('link <from-id> <to-id>')
	.description('link two projects so federated queries fan out between them')
	.action((from: string, to: string) => {
		projectsLink(from, to, program.opts().json)
	})

projects
	.command('build-edges')
	.description('build cross_project_edges between linked project pairs')
	.option('--all', 'use every cartesian pair of registered projects')
	.option('--from <id>', 'project id of the source (requires --to)')
	.option('--to <id>', 'project id of the target (requires --from)')
	.option('--match-by-name', 'also run the heuristic symbol-name linker')
	.action((cmdOpts: { all?: boolean; from?: string; to?: string; matchByName?: boolean }) => {
		projectsBuildEdges(program.opts().json, cmdOpts)
	})

projects
	.command('clear-edges [ids...]')
	.description('clear cross_project_edges (pass project ids to limit, or empty to clear every project)')
	.action((ids: string[]) => {
		projectsClearEdges(ids, program.opts().json)
	})

program
	.command('use [id]')
	.description('set or show the active registered project (cli, mcp, web all follow)')
	.option('--list', 'list registered projects and mark the active one')
	.option('--clear', 'unset the active project')
	.action((id: string | undefined, cmdOpts: { list?: boolean; clear?: boolean }) => {
		useCommand(id, cmdOpts)
	})

program
	.command('churn')
	.description('show files ranked by commit count')
	.option('-l, --limit <n>', 'max files to show', (v) => Number.parseInt(v, 10), 20)
	.option('--path <prefix>', 'only files starting with this path prefix')
	.option('--since-days <n>', 'only count commits from the last N days', (v) => Number.parseInt(v, 10), 0)
	.option('--include-tests', 'include test files')
	.option('--branch <name>', 'only count commits reachable along first-parent from <branch>')
	.action((cmdOpts) => {
		const opts = program.opts()
		churnCommand(opts.project, opts.json, {
			limit: cmdOpts.limit,
			path: cmdOpts.path,
			sinceDays: cmdOpts.sinceDays,
			includeTests: cmdOpts.includeTests,
			branch: cmdOpts.branch,
		})
	})

program
	.command('history <file>')
	.description('show git commit history for a file')
	.option('--branch <name>', 'only commits reachable along first-parent from <branch>')
	.action((file, cmdOpts) => {
		const opts = program.opts()
		historyCommand(opts.project, opts.json, file, { branch: cmdOpts.branch })
	})

program
	.command('contributors [file]')
	.description('list top contributors (overall or for one file)')
	.action((file) => {
		const opts = program.opts()
		contributorsCommand(opts.project, opts.json, file)
	})

program
	.command('co-change')
	.description('show file pairs that change together (from git history)')
	.option('--file <path>', 'only pairs involving this file')
	.option('-l, --limit <n>', 'max pairs to show', (v) => Number.parseInt(v, 10), 20)
	.option('--min-count <n>', 'minimum joint commit count', (v) => Number.parseInt(v, 10), 2)
	.option('--include-tests', 'include pairs involving test files')
	.action((cmdOpts) => {
		const opts = program.opts()
		coChangeCommand(opts.project, opts.json, {
			file: cmdOpts.file,
			limit: cmdOpts.limit,
			minCount: cmdOpts.minCount,
			includeTests: cmdOpts.includeTests,
		})
	})

program
	.command('subsystems')
	.description('list detected subsystems (high-level modules from graph clustering)')
	.action(() => {
		const opts = program.opts()
		subsystemsCommand(opts.project, opts.json)
	})

program
	.command('subsystem <id>')
	.description('show detail for one subsystem (members, top symbols)')
	.action((id) => {
		const opts = program.opts()
		subsystemCommand(opts.project, opts.json, id)
	})

program
	.command('tests <symbol>')
	.description('show test files that cover a symbol (imported or called)')
	.action((symbol) => {
		const opts = program.opts()
		testsCommand(opts.project, opts.json, symbol)
	})

program
	.command('untested')
	.description('list exported symbols with no test coverage')
	.option('-k, --kind <kind>', 'filter by symbol kind')
	.option('-l, --limit <n>', 'max symbols to show', (v) => Number.parseInt(v, 10), 100)
	.action((cmdOpts) => {
		const opts = program.opts()
		untestedCommand(opts.project, opts.json, { kind: cmdOpts.kind, limit: cmdOpts.limit })
	})

program
	.command('hot-fragile')
	.description('rank files by churn × untested-symbol count')
	.option('-l, --limit <n>', 'max files to show', (v) => Number.parseInt(v, 10), 20)
	.action((cmdOpts) => {
		const opts = program.opts()
		hotFragileCommand(opts.project, opts.json, { limit: cmdOpts.limit })
	})

program
	.command('hotspots')
	.description('rank exported symbols by fanin × churn × (1 - coverage)')
	.option('-l, --limit <n>', 'max symbols to show', (v) => Number.parseInt(v, 10), 20)
	.option('--coverage <level>', 'filter by coverage (called|imported|none)')
	.action((cmdOpts) => {
		const opts = program.opts()
		const coverage =
			cmdOpts.coverage === 'called' || cmdOpts.coverage === 'imported' || cmdOpts.coverage === 'none'
				? (cmdOpts.coverage as 'called' | 'imported' | 'none')
				: undefined
		hotspotsCommand(opts.project, opts.json, { limit: cmdOpts.limit, coverage })
	})

// channels subcommand group. #31 surfaces the channel_hits table
// populated by #10's sql-linker and the future graphql/queue/env/
// openapi linkers. list defaults to sql_table when no --kind is
// passed.
const channels = program
	.command('channels')
	.description('list and inspect cross-language channel groups')

channels
	.command('list')
	.description('list (kind, value) groups with 2+ symbols touching them')
	.option('--kind <kind>', 'channel kind to list (default sql_table)')
	.action((cmdOpts) => {
		const opts = program.opts()
		channelsListCommand(opts.project, opts.json, { kind: cmdOpts.kind })
	})

channels
	.command('show <kind> <value>')
	.description('list every symbol that touched the given channel value')
	.action((kind: string, value: string) => {
		const opts = program.opts()
		channelsShowCommand(opts.project, opts.json, kind, value)
	})

export { program }
