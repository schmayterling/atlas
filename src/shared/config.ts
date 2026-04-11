import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const ConfigSchema = z.object({
	include: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']),
	exclude: z
		.array(z.string())
		.default([
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/.git/**',
			'**/*.test.*',
			'**/*.spec.*',
		]),
	languages: z
		.record(z.object({ extensions: z.array(z.string()) }))
		.default({
			typescript: { extensions: ['.ts', '.tsx'] },
			javascript: { extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
		}),
	indexPath: z.string().default('.atlas/atlas.db'),
})

export type AtlasConfig = z.infer<typeof ConfigSchema>

export function loadConfig(projectRoot: string): AtlasConfig {
	const configPath = join(projectRoot, '.atlas', 'config.json')
	if (existsSync(configPath)) {
		const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
		return ConfigSchema.parse(raw)
	}
	return ConfigSchema.parse({})
}

export function getDbPath(projectRoot: string, config: AtlasConfig): string {
	return join(projectRoot, config.indexPath)
}
