import { Command } from 'commander'
import { setLogLevel } from '../shared/logger.js'
import { blastCommand } from './commands/blast.js'
import { deadCodeCommand } from './commands/dead-code.js'
import { depsCommand } from './commands/deps.js'
import { indexCommand } from './commands/index-cmd.js'
import { initCommand } from './commands/init.js'
import { mcpCommand } from './commands/mcp.js'
import { searchCommand } from './commands/search.js'
import { statusCommand } from './commands/status.js'
import { traceCommand } from './commands/trace.js'

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
			noEmbed: cmdOpts.noEmbed ?? !cmdOpts.embed,
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
	.description('search for symbols by name')
	.option('-k, --kind <kind>', 'filter by symbol kind')
	.option('-e, --exact', 'exact match only')
	.option('-n, --limit <n>', 'max results', '20')
	.action((query, cmdOpts) => {
		const opts = program.opts()
		searchCommand(opts.project, query, opts.json, {
			kind: cmdOpts.kind,
			exact: cmdOpts.exact,
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
	.option('--tests', 'include affected test files', true)
	.action((target, cmdOpts) => {
		const opts = program.opts()
		blastCommand(opts.project, target, opts.json, {
			depth: Number(cmdOpts.depth),
			tests: cmdOpts.tests,
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

export { program }
