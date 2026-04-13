import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { anchorSymbol, fanOutDownstream } from '../../core/federation/federated-engine.js'
import { getProject } from '../../core/registry.js'
import { badge, fileRef, heading, outputJson } from '../formatters/common.js'

export function blastCommand(
	projectRoot: string,
	target: string,
	json: boolean,
	opts: { depth?: number; tests?: boolean; allProjects?: boolean; project?: string },
) {
	if (opts.allProjects) {
		blastAllProjects(target, json, opts)
		return
	}

	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		const result = engine.blast(target, {
			depth: opts.depth,
			includeTests: opts.tests,
		})

		if (!result) {
			console.error(pc.red(`symbol not found: ${target}`))
			process.exit(1)
		}

		if (json) {
			outputJson(result)
			return
		}

		const sym = result.target
		heading(`blast radius for ${sym.name} (${sym.filePath}:${sym.lineStart})`)

		if (result.truncated) {
			console.log(pc.yellow(`  (truncated: ${result.truncationReason})`))
		}

		if (result.direct.length > 0) {
			console.log()
			console.log(
				pc.bold(`direct (${result.direct.length} symbols)`),
			)
			for (const item of result.direct) {
				const kindBadge = badge(item.symbol.kind)
				const name = pc.bold(item.symbol.name)
				const ref = fileRef(item.symbol.filePath, item.symbol.lineStart)
				const rel = pc.dim(`[${item.relationship}]`)
				console.log(`  ${pc.green('●')} ${kindBadge} ${name} ${ref} ${rel}`)
			}
		}

		if (result.transitive.length > 0) {
			console.log()
			console.log(
				pc.bold(
					`transitive (${result.transitive.length} symbols, depth 2-${result.summary.maxDepthReached})`,
				),
			)
			for (const item of result.transitive.slice(0, 20)) {
				const kindBadge = badge(item.symbol.kind)
				const name = item.symbol.name
				const ref = fileRef(item.symbol.filePath, item.symbol.lineStart)
				const depth = pc.dim(`(depth ${item.depth})`)
				console.log(`  ${pc.dim('○')} ${kindBadge} ${name} ${ref} ${depth}`)
			}
			if (result.transitive.length > 20) {
				console.log(
					pc.dim(`  ...and ${result.transitive.length - 20} more`),
				)
			}
		}

		if (result.affectedTests.length > 0) {
			console.log()
			console.log(
				pc.bold(`affected tests (${result.affectedTests.length} files)`),
			)
			for (const test of result.affectedTests) {
				console.log(`  ${pc.magenta('◆')} ${test.file}`)
			}
		}

		console.log()
		console.log(
			`summary: ${result.summary.totalSymbols} symbols, ${result.summary.totalFiles} files, ${result.summary.totalTestFiles} test files`,
		)
	} finally {
		engine.close()
	}
}

// federated blast: anchor the target symbol in --project <id>, run
// local blast, then fan out across cross_project_edges (inbound edges
// — "what would break if I changed this") to surface remote consumers.
function blastAllProjects(
	target: string,
	json: boolean,
	opts: { depth?: number; tests?: boolean; project?: string },
) {
	if (!opts.project) {
		console.error(
			pc.red(
				'blast --all-projects requires --project <id> to anchor the starting target. ambiguous resolution across projects is not supported; pick a starting project.',
			),
		)
		process.exit(1)
	}
	const anchorProject = getProject(opts.project)
	if (!anchorProject) {
		console.error(pc.red(`unknown project id: ${opts.project}`))
		process.exit(1)
	}
	const anchorEngine = getOrCreateEngine(anchorProject.id, anchorProject.root)
	const anchor = anchorSymbol(anchorEngine, target)
	if (!anchor) {
		console.error(pc.red(`symbol not found in project "${anchorProject.id}": ${target}`))
		process.exit(1)
	}

	const local = anchorEngine.blast(target, {
		depth: opts.depth,
		includeTests: opts.tests,
	})
	const remoteResults = fanOutDownstream(
		anchorEngine,
		anchorProject.id,
		anchor.stableId,
		'inbound',
		// stable-id-keyed remote blast preserves the exact symbol the
		// boundary edge resolved to. the prior name-based lookup could
		// land on a same-named sibling in the remote project.
		(remoteEngine, remoteStableId) =>
			remoteEngine.blastByStableId(remoteStableId, {
				depth: opts.depth,
				includeTests: opts.tests,
			}),
	)

	if (json) {
		outputJson({
			anchor: { project: anchorProject.id, ...anchor },
			local,
			remotes: remoteResults,
		})
		return
	}

	if (!local) {
		console.error(pc.red(`local blast failed for ${target}`))
		process.exit(1)
	}
	const sym = local.target
	heading(`${pc.magenta(`[${anchorProject.id}]`)} blast radius for ${sym.name} (${sym.filePath}:${sym.lineStart})`)
	console.log()
	console.log(
		`local: ${local.summary.totalSymbols} symbols, ${local.summary.totalFiles} files, ${local.summary.totalTestFiles} tests`,
	)
	if (remoteResults.length === 0) {
		console.log()
		console.log(pc.dim('no cross-project consumers found.'))
		return
	}
	for (const remote of remoteResults) {
		console.log()
		const tag = pc.magenta(`[${remote.project}]`)
		if (!remote.result) {
			console.log(`${tag} ${pc.dim('symbol not resolvable in remote project')}`)
			continue
		}
		console.log(
			`${tag} ${remote.result.summary.totalSymbols} symbols, ${remote.result.summary.totalFiles} files, ${remote.result.summary.totalTestFiles} tests`,
		)
		for (const item of remote.result.direct.slice(0, 10)) {
			const kindBadge = badge(item.symbol.kind)
			const name = pc.bold(item.symbol.name)
			const ref = fileRef(item.symbol.filePath, item.symbol.lineStart)
			console.log(`  ${pc.green('●')} ${kindBadge} ${name} ${ref}`)
		}
	}
}
