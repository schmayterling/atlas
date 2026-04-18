// pre-configure phase. runs once per (agent, corpus) before any LLM
// jobs start, so:
//   - atlas does its full structural index (with engine.index({ force }))
//   - cbm runs index_repository(corpus) so search/trace/etc. work
//   - chunkhound runs a no-op semantic_search to trigger embedding
//   - baseline does nothing (reads files on demand)
//
// without this, the FIRST task per (agent, corpus) eats all the
// indexing cost and looks artificially slow + expensive in the
// per-task table. moving it here makes per-task numbers comparable.

import pc from 'picocolors'
import { getOrCreateEngine } from '../../src/core/engine-pool.js'
import { openMcpAgent } from './mcp-client.js'
import type { McpAgentHandle } from './mcp-client.js'

export type AgentName = 'baseline' | 'atlas' | 'cbm' | 'chunkhound'

// keep the spawned mcp servers alive across the whole run so
// per-trial jobs reuse them. agents export their own close() helpers
// for teardown.
const cbmHandles = new Map<string, Promise<McpAgentHandle>>()
const chunkhoundHandles = new Map<string, Promise<McpAgentHandle>>()

const CBM_BIN = process.env.CODEBASE_MEMORY_MCP_BIN
	|| process.env.CBM_BIN
	|| 'codebase-memory-mcp'
const CHUNKHOUND_BIN = process.env.CHUNKHOUND_BIN || 'chunkhound'

export interface PreconfigStep {
	agent: AgentName
	corpus: string
	corpusRoot: string
	wallMs: number
	ok: boolean
	detail: string
}

export async function preconfigure(
	agents: AgentName[],
	corpora: { name: string; root: string }[],
	chunkhoundConfig: string,
): Promise<PreconfigStep[]> {
	const steps: PreconfigStep[] = []
	const total = agents.filter((a) => a !== 'baseline').length * corpora.length
	let i = 0
	const tick = (s: PreconfigStep) => {
		i++
		const status = s.ok ? pc.green('✓') : pc.red('✗')
		const time = pc.dim(`${s.wallMs}ms`)
		console.log(`  ${status} [${i}/${total}] ${pc.cyan(s.agent.padEnd(10))} ${pc.bold(s.corpus.padEnd(12))} ${time}  ${pc.dim(s.detail)}`)
	}

	for (const agent of agents) {
		if (agent === 'baseline') continue
		for (const c of corpora) {
			const t = performance.now()
			try {
				let detail = ''
				if (agent === 'atlas') {
					detail = await preconfigAtlas(c.root)
				} else if (agent === 'cbm') {
					detail = await preconfigCbm(c.root)
				} else if (agent === 'chunkhound') {
					detail = await preconfigChunkhound(c.root, chunkhoundConfig)
				}
				const step: PreconfigStep = { agent, corpus: c.name, corpusRoot: c.root, wallMs: Math.round(performance.now() - t), ok: true, detail }
				steps.push(step); tick(step)
			} catch (e) {
				const step: PreconfigStep = { agent, corpus: c.name, corpusRoot: c.root, wallMs: Math.round(performance.now() - t), ok: false, detail: e instanceof Error ? e.message.slice(0, 80) : String(e) }
				steps.push(step); tick(step)
			}
		}
	}
	return steps
}

async function preconfigAtlas(corpusRoot: string): Promise<string> {
	const engine = getOrCreateEngine(undefined, corpusRoot)
	const r = await engine.index({ force: true, noEmbed: true, noSummarize: true, withGitHub: false })
	return `${r.filesTotal} files, ${r.symbols} symbols, ${r.edges} edges`
}

async function preconfigCbm(corpusRoot: string): Promise<string> {
	const handle = await openMcpAgent({
		name: 'cbm',
		command: CBM_BIN,
		args: [],
	}, corpusRoot)
	cbmHandles.set(corpusRoot, Promise.resolve(handle))
	// cbm's index_repository takes `repo_path` (not `path`). on tool
	// errors cbm returns content[0].text with the message and sets
	// isError=true on the result; the mcp-client wrapper surfaces
	// these as plain text, so we have to detect them here.
	try {
		const out = await handle.handler({
			id: 'preconfig', type: 'function',
			function: { name: 'index_repository', arguments: JSON.stringify({ repo_path: corpusRoot }) },
		})
		if (/error|required|invalid|fail/i.test(out.split('\n')[0] ?? '')) {
			throw new Error(out.slice(0, 120))
		}
		const summary = out.split('\n').find((l) => /node|symbol|file/.test(l)) ?? out.slice(0, 80)
		return summary.slice(0, 100)
	} catch (e) {
		throw new Error(`index_repository failed: ${e instanceof Error ? e.message : String(e)}`)
	}
}

async function preconfigChunkhound(corpusRoot: string, configFile: string): Promise<string> {
	const handle = await openMcpAgent({
		name: 'chunkhound',
		command: CHUNKHOUND_BIN,
		args: ['mcp', '--stdio'],
		cwd: corpusRoot,
		env: { ...process.env, CHUNKHOUND_CONFIG_FILE: configFile } as Record<string, string>,
	}, corpusRoot)
	chunkhoundHandles.set(corpusRoot, Promise.resolve(handle))
	// trigger lazy indexing with a no-op semantic search. chunkhound
	// embeds the corpus on first query; we want that cost upfront, not
	// pinned to whichever task happens to run first.
	try {
		await handle.handler({
			id: 'preconfig', type: 'function',
			function: { name: 'semantic_search', arguments: JSON.stringify({ query: '__bench_warmup__', limit: 1 }) },
		})
		return 'embedding pipeline warm'
	} catch (e) {
		// some chunkhound versions name the tool differently; fall back
		// to listing tools so the runner still has a live handle.
		return `warmup attempted (${handle.tools.length} tools available)`
	}
}

export function getCbmHandle(corpusRoot: string): Promise<McpAgentHandle> | undefined {
	return cbmHandles.get(corpusRoot)
}

export function getChunkhoundHandle(corpusRoot: string): Promise<McpAgentHandle> | undefined {
	return chunkhoundHandles.get(corpusRoot)
}

export async function closePreconfiguredHandles(): Promise<void> {
	const all = [...cbmHandles.values(), ...chunkhoundHandles.values()]
	for (const p of all) {
		try { (await p).close() } catch { /* ignore */ }
	}
	cbmHandles.clear()
	chunkhoundHandles.clear()
}
