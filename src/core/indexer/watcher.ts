import { watch } from 'chokidar'
import type { AtlasConfig } from '../../shared/config.js'
import { log } from '../../shared/logger.js'
import { Indexer } from './indexer.js'
import type { AtlasStore } from '../storage/store.js'

export function startWatcher(
	projectRoot: string,
	config: AtlasConfig,
	store: AtlasStore,
	opts?: { debounceMs?: number; noEmbed?: boolean },
) {
	const debounceMs = opts?.debounceMs ?? 500
	let timer: ReturnType<typeof setTimeout> | null = null
	let indexing = false

	// build extension set from config
	const extensions = new Set<string>()
	for (const lang of Object.values(config.languages)) {
		for (const ext of lang.extensions) extensions.add(ext)
	}

	// build ignore patterns from config.exclude
	const ignored = [
		'**/node_modules/**',
		'**/.git/**',
		'**/.atlas/**',
		...config.exclude,
	]

	const reindex = async () => {
		if (indexing) return
		indexing = true
		try {
			const indexer = new Indexer(projectRoot, config, store)
			const result = await indexer.index({ noEmbed: opts?.noEmbed })
			const changed = result.filesAdded + result.filesModified + result.filesDeleted
			if (changed > 0) {
				log.info(
					`re-indexed: +${result.filesAdded} ~${result.filesModified} -${result.filesDeleted} (${result.symbols} symbols, ${result.edges} edges, ${result.duration}ms)`,
				)
			}
		} catch (e) {
			log.error(`watch re-index failed: ${e}`)
		} finally {
			indexing = false
		}
	}

	const scheduleReindex = () => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(reindex, debounceMs)
	}

	const watcher = watch(projectRoot, {
		ignored,
		persistent: true,
		ignoreInitial: true,
		awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
	})

	watcher
		.on('add', (path) => {
			if (!matchesExtensions(path, extensions)) return
			log.debug(`file added: ${path}`)
			scheduleReindex()
		})
		.on('change', (path) => {
			if (!matchesExtensions(path, extensions)) return
			log.debug(`file changed: ${path}`)
			scheduleReindex()
		})
		.on('unlink', (path) => {
			if (!matchesExtensions(path, extensions)) return
			log.debug(`file deleted: ${path}`)
			scheduleReindex()
		})

	log.info(`watching ${projectRoot} for changes (${[...extensions].join(', ')})`)

	return watcher
}

function matchesExtensions(path: string, extensions: Set<string>): boolean {
	for (const ext of extensions) {
		if (path.endsWith(ext)) return true
	}
	return false
}
