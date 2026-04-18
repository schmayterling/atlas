// the three tools every llm-eval agent gets: read_file, grep, glob.
// these are what a "no-atlas" baseline would use to explore a codebase.
// the with-atlas agent gets these PLUS atlas mcp tools.
//
// implementations are intentionally simple: bun.glob + spawn rg + read.
// caps on bytes returned so a misbehaving agent can't blow the context.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { OpenRouterTool, ToolCall } from './openrouter.js'

const MAX_FILE_BYTES = 32_000        // ~8k tokens per single read
const MAX_GREP_LINES = 200            // keeps responses bounded

export const TEXT_TOOLS: OpenRouterTool[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read the full contents of a file relative to the project root. Use this when you know the exact path you want.',
			parameters: {
				type: 'object',
				required: ['path'],
				properties: {
					path: { type: 'string', description: 'project-relative file path' },
					start_line: { type: 'integer', description: 'optional 1-based line to start from' },
					end_line: { type: 'integer', description: 'optional 1-based line to end at (inclusive)' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'grep',
			description: 'Search file contents for a regex pattern. Returns matching lines with file:line prefix. Use this when you need to find code by literal text or regex.',
			parameters: {
				type: 'object',
				required: ['pattern'],
				properties: {
					pattern: { type: 'string', description: 'regex pattern, ripgrep-compatible' },
					glob: { type: 'string', description: 'optional file glob to scope search (e.g. "*.ts")' },
					case_sensitive: { type: 'boolean', description: 'default true' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'glob',
			description: 'List files matching a glob pattern (e.g. "src/**/*.ts"). Use this to enumerate files when you do not know exact paths.',
			parameters: {
				type: 'object',
				required: ['pattern'],
				properties: {
					pattern: { type: 'string', description: 'glob pattern relative to project root' },
				},
			},
		},
	},
]

export function makeTextHandler(corpusRoot: string) {
	return async (call: ToolCall): Promise<string> => {
		const args = (() => { try { return JSON.parse(call.function.arguments) } catch { return {} } })() as Record<string, unknown>
		switch (call.function.name) {
			case 'read_file': return handleRead(corpusRoot, args)
			case 'grep':      return handleGrep(corpusRoot, args)
			case 'glob':      return handleGlob(corpusRoot, args)
			default:          return `error: unknown tool '${call.function.name}'`
		}
	}
}

async function handleRead(root: string, args: Record<string, unknown>): Promise<string> {
	const path = String(args.path ?? '')
	if (!path) return 'error: path required'
	const abs = join(root, path)
	try {
		const text = await Bun.file(abs).text()
		const start = typeof args.start_line === 'number' ? args.start_line : 1
		const end = typeof args.end_line === 'number' ? args.end_line : Infinity
		const lines = text.split('\n').slice(Math.max(0, start - 1), end).join('\n')
		return lines.length > MAX_FILE_BYTES ? `${lines.slice(0, MAX_FILE_BYTES)}\n[truncated at ${MAX_FILE_BYTES} bytes]` : lines
	} catch (e) {
		return `error: ${e instanceof Error ? e.message : String(e)}`
	}
}

function handleGrep(root: string, args: Record<string, unknown>): string {
	const pattern = String(args.pattern ?? '')
	if (!pattern) return 'error: pattern required'
	const rgArgs = ['--no-heading', '--with-filename', '--line-number', '--no-messages', '--max-count', '50']
	if (args.case_sensitive === false) rgArgs.push('-i')
	if (args.glob) rgArgs.push('--glob', String(args.glob))
	rgArgs.push(pattern)
	const r = spawnSync('rg', rgArgs, { cwd: root, encoding: 'utf-8' })
	if (r.status !== 0 && r.status !== 1) return `error: rg exit ${r.status}: ${r.stderr ?? ''}`
	const lines = (r.stdout ?? '').split('\n').filter(Boolean).slice(0, MAX_GREP_LINES)
	if (lines.length === 0) return 'no matches'
	return lines.join('\n')
}

function handleGlob(root: string, args: Record<string, unknown>): string {
	const pattern = String(args.pattern ?? '')
	if (!pattern) return 'error: pattern required'
	try {
		const glob = new Bun.Glob(pattern)
		const files: string[] = []
		for (const f of glob.scanSync({ cwd: root })) {
			files.push(f)
			if (files.length >= 200) break
		}
		return files.length === 0 ? 'no matches' : files.join('\n')
	} catch (e) {
		return `error: ${e instanceof Error ? e.message : String(e)}`
	}
}
