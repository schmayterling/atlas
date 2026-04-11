import pc from 'picocolors'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel) {
	currentLevel = level
}

export function resetLogLevel() {
	currentLevel = 'info'
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel]
}

function timestamp(): string {
	return new Date().toISOString().slice(11, 23)
}

export const log = {
	debug(msg: string, ...args: unknown[]) {
		if (shouldLog('debug')) {
			console.error(pc.dim(`[${timestamp()}] ${msg}`), ...args)
		}
	},

	info(msg: string, ...args: unknown[]) {
		if (shouldLog('info')) {
			console.error(pc.blue(`[${timestamp()}]`), msg, ...args)
		}
	},

	warn(msg: string, ...args: unknown[]) {
		if (shouldLog('warn')) {
			console.error(pc.yellow(`[${timestamp()}] warn:`), msg, ...args)
		}
	},

	error(msg: string, ...args: unknown[]) {
		if (shouldLog('error')) {
			console.error(pc.red(`[${timestamp()}] error:`), msg, ...args)
		}
	},
}
