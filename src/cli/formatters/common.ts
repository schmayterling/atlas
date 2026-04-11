import pc from 'picocolors'

export function isJsonMode(): boolean {
	return !process.stdout.isTTY || process.env.ATLAS_JSON === '1'
}

export function outputJson(data: unknown) {
	console.log(JSON.stringify(data, null, 2))
}

export function heading(text: string) {
	console.log(pc.bold(text))
	console.log(pc.dim('─'.repeat(Math.min(text.length + 10, 60))))
}

export function label(key: string, value: string | number) {
	console.log(`  ${pc.dim(key + ':')}  ${value}`)
}

export function badge(kind: string): string {
	const colors: Record<string, (s: string) => string> = {
		function: pc.blue,
		class: pc.yellow,
		interface: pc.green,
		type: pc.cyan,
		enum: pc.magenta,
		variable: pc.white,
		method: pc.blue,
		property: pc.dim,
		module: pc.red,
	}
	const colorFn = colors[kind] ?? pc.white
	return colorFn(kind.toUpperCase().padEnd(10))
}

export function fileRef(filePath: string, line: number): string {
	return pc.dim(`${filePath}:${line}`)
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
