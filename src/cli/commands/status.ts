import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { formatBytes, heading, label, outputJson } from '../formatters/common.js'

export function statusCommand(projectRoot: string, json: boolean) {
	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		const result = engine.status()

		if (json) {
			outputJson(result)
			return
		}

		heading('atlas index status')
		console.log()
		label('project', result.projectRoot)
		label('database', `${result.dbPath} (${formatBytes(result.dbSizeBytes)})`)

		const healthColors: Record<string, (s: string) => string> = {
			good: pc.green,
			stale: pc.yellow,
			outdated: pc.red,
			missing: pc.red,
		}
		const healthFn = healthColors[result.health] ?? pc.white
		label('health', healthFn(result.health))

		if (result.lastIndexedAt) {
			const ago = formatTimeAgo(result.lastIndexedAt)
			label('last index', ago)
		}
		if (result.lastCommit) {
			label('commit', result.lastCommit.slice(0, 8))
		}
		if (result.lastBranch) {
			label('branch', result.lastBranch)
		}

		console.log()
		label('files', String(result.stats.files))
		label('symbols', String(result.stats.symbols))
		label('edges', String(result.stats.edges))

		if (Object.keys(result.languages).length > 0) {
			console.log()
			for (const [lang, count] of Object.entries(result.languages)) {
				label(lang, String(count))
			}
		}
	} finally {
		engine.close()
	}
}

function formatTimeAgo(timestamp: number): string {
	const diff = Date.now() - timestamp
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}
