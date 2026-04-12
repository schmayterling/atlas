import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { heading, outputJson } from '../formatters/common.js'

export function churnCommand(
	projectRoot: string,
	json: boolean,
	opts: { limit?: number; path?: string; sinceDays?: number },
) {
	const engine = new AtlasEngine(projectRoot)
	try {
		const since = opts.sinceDays ? Date.now() - opts.sinceDays * 86400_000 : undefined
		const rows = engine.churn({ limit: opts.limit ?? 20, pathPrefix: opts.path, since })

		if (json) {
			outputJson(rows)
			return
		}

		heading(`hot files (${rows.length})`)
		if (rows.length === 0) {
			console.log(pc.dim('  no git history. run `atlas index` in a git repo.'))
			return
		}
		console.log()
		for (const r of rows) {
			const date = new Date(r.lastTouchedAt).toISOString().slice(0, 10)
			console.log(
				`  ${pc.bold(String(r.commits).padStart(4))} commits  ${pc.dim(date)}  ${pc.dim(r.topAuthor.padEnd(20))}  ${r.filePath}`,
			)
		}
	} finally {
		engine.close()
	}
}

export function historyCommand(projectRoot: string, json: boolean, file: string) {
	const engine = new AtlasEngine(projectRoot)
	try {
		const rows = engine.fileHistory(file)
		if (json) {
			outputJson(rows)
			return
		}
		heading(`history of ${file} (${rows.length} commits)`)
		if (rows.length === 0) {
			console.log(
				pc.dim('  no history for this file. run `atlas index` in a git repo or check the path.'),
			)
			return
		}
		console.log()
		for (const r of rows) {
			const date = new Date(r.authoredAt).toISOString().slice(0, 10)
			console.log(
				`  ${pc.dim(date)}  ${pc.dim(r.hash.slice(0, 7))}  ${r.status}  ${pc.bold(r.authorName)}  ${r.subject}`,
			)
		}
	} finally {
		engine.close()
	}
}

export function contributorsCommand(projectRoot: string, json: boolean, file?: string) {
	const engine = new AtlasEngine(projectRoot)
	try {
		const rows = engine.contributors(file)
		if (json) {
			outputJson(rows)
			return
		}
		heading(file ? `contributors to ${file}` : 'top contributors')
		if (rows.length === 0) {
			console.log(
				pc.dim(file ? '  no history for this file' : '  no git history. run `atlas index` in a git repo.'),
			)
			return
		}
		console.log()
		for (const r of rows) {
			console.log(
				`  ${pc.bold(String(r.commits).padStart(4))} commits  ${r.authorName}  ${pc.dim(`<${r.authorEmail}>`)}`,
			)
		}
	} finally {
		engine.close()
	}
}

export function coChangeCommand(
	projectRoot: string,
	json: boolean,
	opts: { file?: string; limit?: number; minCount?: number },
) {
	const engine = new AtlasEngine(projectRoot)
	try {
		const rows = engine.coChange({
			filePath: opts.file,
			limit: opts.limit ?? 20,
			minCount: opts.minCount ?? 2,
		})
		if (json) {
			outputJson(rows)
			return
		}
		heading(opts.file ? `files that change with ${opts.file}` : 'top co-changing file pairs')
		if (rows.length === 0) {
			console.log(pc.dim('  no co-change pairs (need at least 2 commits touching both files)'))
			return
		}
		console.log()
		for (const r of rows) {
			console.log(
				`  ${pc.bold(String(r.count).padStart(4))} commits  jaccard ${r.jaccard.toFixed(2)}  ${r.fileA} ${pc.dim('<->')} ${r.fileB}`,
			)
		}
	} finally {
		engine.close()
	}
}

export function subsystemsCommand(projectRoot: string, json: boolean) {
	const engine = new AtlasEngine(projectRoot)
	try {
		const rows = engine.subsystems()
		if (json) {
			outputJson(rows)
			return
		}
		heading(`subsystems (${rows.length})`)
		if (rows.length === 0) {
			console.log(
				pc.dim('  no subsystems detected. run `atlas index` to cluster the file graph.'),
			)
			return
		}
		console.log()
		for (const r of rows) {
			console.log(
				`  ${pc.dim(r.id)}  ${String(r.fileCount).padStart(3)} files  conductance ${r.conductance.toFixed(2)}  ${pc.bold(r.name)}`,
			)
			if (r.description) console.log(`    ${pc.dim(r.description)}`)
		}
	} finally {
		engine.close()
	}
}

export function subsystemCommand(projectRoot: string, json: boolean, id: string) {
	const engine = new AtlasEngine(projectRoot)
	try {
		const detail = engine.subsystem(id)
		if (!detail) {
			console.error(pc.red(`subsystem ${id} not found`))
			process.exitCode = 1
			return
		}
		if (json) {
			outputJson(detail)
			return
		}
		heading(detail.name)
		if (detail.description) console.log(`  ${pc.dim(detail.description)}`)
		console.log(
			`  conductance ${detail.conductance.toFixed(2)} · ${detail.files.length} files`,
		)
		console.log()
		console.log(pc.bold('files:'))
		for (const f of detail.files) console.log(`  ${f.path}`)
		if (detail.topSymbols.length > 0) {
			console.log()
			console.log(pc.bold('top exported symbols:'))
			for (const s of detail.topSymbols) {
				console.log(`  ${pc.dim(s.kind.padEnd(10))} ${s.name}  ${pc.dim(s.filePath)}`)
			}
		}
	} finally {
		engine.close()
	}
}
