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
import { projectsCommand } from './commands/projects.js'

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
	.option('--no-embed', 'skip embedding generation')
	.action(async (cmdOpts) => {
		const opts = program.opts()
		await indexCommand(opts.project, opts.json, {
			force: cmdOpts.full,
			dryRun: cmdOpts.dryRun,
			noEmbed: !cmdOpts.embed,
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
	.action(async (query, cmdOpts) => {
		const opts = program.opts()
		await searchCommand(opts.project, query, opts.json, {
			kind: cmdOpts.kind,
			exact: cmdOpts.exact,
			semantic: cmdOpts.semantic,
			limit: Number(cmdOpts.limit),
		})
	})

program
	.command('deps <symbol>')
	.description('show dependency graph for a symbol')
	.option('-d, --direction <dir>', 'upstream, downstream, or both', 'both')
	.option('--depth <n>', 'max traversal depth', '3')
	.action((symbol, cmdOpts) => {
		const opts = program.opts()
		depsCommand(opts.project, symbol, opts.json, {
			direction: cmdOpts.direction,
			depth: Number(cmdOpts.depth),
		})
	})

program
	.command('blast <target>')
	.description('show blast radius for a file or symbol')
	.option('--depth <n>', 'max propagation depth', '5')
	.option('--no-tests', 'exclude affected test files')
	.action((target, cmdOpts) => {
		const opts = program.opts()
		blastCommand(opts.project, target, opts.json, {
			depth: Number(cmdOpts.depth),
			tests: cmdOpts.tests !== false,
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
	.option('--depth <n>', 'max path depth', '10')
	.action((from, to, cmdOpts) => {
		const opts = program.opts()
		traceCommand(opts.project, from, to, opts.json, {
			maxPaths: Number(cmdOpts.maxPaths),
			depth: Number(cmdOpts.depth),
		})
	})

program
	.command('dead-code')
	.description('find unreferenced symbols')
	.option('-k, --kind <kind>', 'filter by symbol kind')
	.option('--path <path>', 'filter by file path')
	.action((cmdOpts) => {
		const opts = program.opts()
		deadCodeCommand(opts.project, opts.json, {
			kind: cmdOpts.kind,
			path: cmdOpts.path,
		})
	})

program
	.command('flows')
	.description('show detected execution flows')
	.action(() => {
		const opts = program.opts()
		const { AtlasEngine } = require('../core/engine.js')
		const engine = new AtlasEngine(opts.project)
		const flows = engine.flows()
		if (opts.json) { console.log(JSON.stringify(flows, null, 2)); engine.close(); return }
		if (flows.length === 0) { console.log('no flows detected. run `atlas index` with Ollama to detect flows.'); engine.close(); return }
		const pc = require('picocolors')
		console.log(pc.bold(`${flows.length} flow${flows.length > 1 ? 's' : ''} detected\n`))
		for (const f of flows) {
			console.log(`  ${pc.cyan(f.name)}${f.description ? ` — ${f.description}` : ''}`)
			console.log(`    ${f.symbols.map((s: any) => s.name).join(' → ')}`)
			console.log()
		}
		engine.close()
	})

program
	.command('duplicates')
	.description('show potential duplicate code')
	.action(() => {
		const opts = program.opts()
		const { AtlasEngine } = require('../core/engine.js')
		const engine = new AtlasEngine(opts.project)
		const dups = engine.duplicates()
		if (opts.json) { console.log(JSON.stringify(dups, null, 2)); engine.close(); return }
		if (dups.length === 0) { console.log('no duplicates detected. run `atlas index` with embeddings to detect duplicates.'); engine.close(); return }
		const pc = require('picocolors')
		console.log(pc.bold(`${dups.length} potential duplicate${dups.length > 1 ? 's' : ''}\n`))
		for (const d of dups) {
			console.log(`  ${pc.yellow((d.similarity * 100).toFixed(0) + '%')} ${d.symbolA.name} ↔ ${d.symbolB.name}`)
			console.log(`    ${d.symbolA.filePath}:${d.symbolA.lineStart}  ↔  ${d.symbolB.filePath}:${d.symbolB.lineStart}`)
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
	.option('--no-embed', 'skip embedding generation')
	.action(async (cmdOpts) => {
		const opts = program.opts()
		await watchCommand(opts.project, {
			serve: !!cmdOpts.serve,
			port: Number(cmdOpts.port),
			noEmbed: !cmdOpts.embed,
		})
	})

program
	.command('projects <action> [args...]')
	.description('manage projects (list, add <path>, remove <id>, link <from> <to>)')
	.action((action, args) => {
		const opts = program.opts()
		projectsCommand(action, args, opts.json)
	})

export { program }
