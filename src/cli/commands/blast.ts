import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { badge, fileRef, heading, outputJson } from '../formatters/common.js'

export function blastCommand(
	projectRoot: string,
	target: string,
	json: boolean,
	opts: { depth?: number; tests?: boolean },
) {
	const engine = new AtlasEngine(projectRoot)

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
