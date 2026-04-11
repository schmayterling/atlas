import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { log } from '../shared/logger.js'

export async function buildClient(projectRoot: string): Promise<string> {
	const outDir = join(projectRoot, '.atlas', 'web-dist')
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

	const clientDir = join(import.meta.dir, 'client')
	const entrypoint = join(clientDir, 'index.tsx')

	if (!existsSync(entrypoint)) {
		log.warn('no client source found, skipping frontend build')
		return outDir
	}

	const start = performance.now()

	// step 1: compile Tailwind CSS
	const inputCss = join(clientDir, 'styles.css')
	const outputCss = join(outDir, 'styles.css')
	if (existsSync(inputCss)) {
		const tw = Bun.spawnSync(['bunx', '@tailwindcss/cli', '-i', inputCss, '-o', outputCss, '--minify'], {
			cwd: projectRoot,
			stderr: 'pipe',
		})
		if (tw.exitCode !== 0) {
			log.warn(`tailwind build failed: ${tw.stderr.toString()}`)
		}
	}

	// step 2: bundle React app
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir: outDir,
		minify: true,
		target: 'browser',
		define: {
			'process.env.NODE_ENV': '"production"',
		},
	})

	if (!result.success) {
		for (const msg of result.logs) log.warn(`build: ${msg}`)
	}

	// step 3: copy index.html
	const indexHtml = join(clientDir, 'index.html')
	if (existsSync(indexHtml)) {
		const html = await Bun.file(indexHtml).text()
		await Bun.write(join(outDir, 'index.html'), html)
	}

	log.debug(`client build: ${(performance.now() - start).toFixed(0)}ms`)
	return outDir
}
