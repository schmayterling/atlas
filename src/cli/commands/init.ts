import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { outputJson } from '../formatters/common.js'

export function initCommand(projectRoot: string, json: boolean) {
	const engine = new AtlasEngine(projectRoot)
	const result = engine.init()
	engine.close()

	if (json) {
		outputJson(result)
		return
	}

	if (result.created) {
		console.log(pc.green('created .atlas/ directory'))
	} else {
		console.log(pc.yellow('.atlas/ already exists'))
	}
	console.log(`  config: ${result.configPath}`)
	console.log(`  database: ${result.dbPath}`)
	console.log()
	console.log(`run ${pc.bold('atlas index')} to build the index.`)
}
