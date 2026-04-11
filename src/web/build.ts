import { join } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { log } from '../shared/logger.js'

function needsRebuild(clientDir: string, outFile: string): boolean {
	try {
		const outMtime = statSync(outFile).mtimeMs
		// check all files in client dir, not just the entrypoint
		return hasNewerFiles(clientDir, outMtime)
	} catch {
		return true
	}
}

function hasNewerFiles(dir: string, threshold: number): boolean {
	try {
		const { readdirSync } = require('node:fs')
		for (const entry of readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as any[]) {
			const fullPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (hasNewerFiles(fullPath, threshold)) return true
			} else if (statSync(fullPath).mtimeMs > threshold) {
				return true
			}
		}
	} catch { /* ignore */ }
	return false
}

export async function buildClient(projectRoot: string): Promise<string> {
	const outDir = join(projectRoot, '.atlas', 'web-dist')
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

	const clientDir = join(import.meta.dir, 'client')
	const entrypoint = join(clientDir, 'index.tsx')

	if (!existsSync(entrypoint)) {
		log.warn('no client source found, skipping frontend build')
		return outDir
	}

	const outJs = join(outDir, 'index.js')
	if (!needsRebuild(clientDir, outJs)) {
		log.debug('client build: output up to date, skipping')
		return outDir
	}

	const start = performance.now()

	// compile tailwind CSS (async to avoid blocking)
	const inputCss = join(clientDir, 'styles.css')
	const outputCss = join(outDir, 'styles.css')
	let twPromise: Promise<void> | null = null
	if (existsSync(inputCss)) {
		twPromise = (async () => {
			const tw = Bun.spawn(
				['bunx', '@tailwindcss/cli', '-i', inputCss, '-o', outputCss, '--minify'],
				{
					cwd: projectRoot,
					stderr: 'pipe',
				},
			)
			const exitCode = await tw.exited
			if (exitCode !== 0) {
				const stderr = await new Response(tw.stderr).text()
				log.warn(`tailwind build failed: ${stderr}`)
			}
		})()
	}

	// bundle react app
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
		log.error('client build failed, UI will not function')
	}

	// wait for tailwind if still running
	if (twPromise) await twPromise

	// copy index.html
	const indexHtml = join(clientDir, 'index.html')
	if (existsSync(indexHtml)) {
		const html = await Bun.file(indexHtml).text()
		await Bun.write(join(outDir, 'index.html'), html)
	}

	log.debug(`client build: ${(performance.now() - start).toFixed(0)}ms`)
	return outDir
}
