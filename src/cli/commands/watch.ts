import { loadConfig } from '../../shared/config.js'
import { log } from '../../shared/logger.js'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { startWatcher } from '../../core/indexer/watcher.js'
import { startWebServer } from '../../web/server.js'

export async function watchCommand(
	projectRoot: string,
	opts: { serve: boolean; port: number; noEmbed: boolean; noSummarize: boolean },
) {
	const config = loadConfig(projectRoot)
	// route everything through the engine pool so watcher writes and web
	// reads go through the same AtlasStore connection. otherwise --serve
	// would open a separate store and see stale data after a re-index.
	const engine = getOrCreateEngine(undefined, projectRoot)

	log.info('running initial index...')
	const result = await engine.index({ noEmbed: opts.noEmbed, noSummarize: opts.noSummarize })
	log.info(`indexed ${result.filesTotal} files (${result.symbols} symbols, ${result.edges} edges)`)

	startWatcher(projectRoot, config, engine, {
		noEmbed: opts.noEmbed,
		noSummarize: opts.noSummarize,
	})

	if (opts.serve) {
		await startWebServer(projectRoot, { port: opts.port, open: true })
	} else {
		await new Promise(() => {})
	}
}
