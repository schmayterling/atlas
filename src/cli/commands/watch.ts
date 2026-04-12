import { getDbPath, loadConfig } from '../../shared/config.js'
import { log } from '../../shared/logger.js'
import { Indexer } from '../../core/indexer/indexer.js'
import { AtlasStore } from '../../core/storage/store.js'
import { startWatcher } from '../../core/indexer/watcher.js'
import { startWebServer } from '../../web/server.js'

export async function watchCommand(
	projectRoot: string,
	opts: { serve: boolean; port: number; noEmbed: boolean; noSummarize: boolean },
) {
	const config = loadConfig(projectRoot)
	const dbPath = getDbPath(projectRoot, config)
	const store = new AtlasStore(dbPath)

	// run initial index
	log.info('running initial index...')
	const indexer = new Indexer(projectRoot, config, store)
	const result = await indexer.index({ noEmbed: opts.noEmbed, noSummarize: opts.noSummarize })
	log.info(`indexed ${result.filesTotal} files (${result.symbols} symbols, ${result.edges} edges)`)

	// start file watcher
	startWatcher(projectRoot, config, store, { noEmbed: opts.noEmbed, noSummarize: opts.noSummarize })

	// optionally start web server
	if (opts.serve) {
		await startWebServer(projectRoot, { port: opts.port, open: true })
	} else {
		// keep process alive
		await new Promise(() => {})
	}
}
