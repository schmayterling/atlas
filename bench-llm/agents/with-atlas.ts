// with-atlas agent: baseline + atlas tool surface. phase 1 stub that
// queries the engine directly (no llm in the loop). phase 2 replaces
// with a real llm-driven agent using the anthropic sdk + mcp. see #84.

import type { AgentAnswer, Question } from '../run.js'
import { getOrCreateEngine } from '../../src/core/engine-pool.js'
import { extractTarget } from './shared.js'

export async function runWithAtlasAgent(q: Question, corpusRoot: string): Promise<AgentAnswer> {
	// phase 1: no llm. resolve the question directly against atlas so
	// the scoring pipeline is exercised end-to-end. deep-review pass 8
	// flagged direct `new AtlasEngine` construction; pool membership
	// matters once phase 2 routes this through MCP against the same
	// corpus. assumes the corpus was indexed beforehand (atlas-pinned
	// == the repo, which the runner expects to be indexed).
	const target = extractTarget(q.question)
	if (!target) return { symbols: [], toolCalls: 0 }
	const engine = getOrCreateEngine(undefined, corpusRoot)
	if (q.capability === 'symbol-locate' || q.capability === 'symbol-set') {
		const search = engine.search(target, { limit: 20 })
		const symbols = search.results.map((r) => `${r.filePath}::${r.name}`)
		return { symbols, text: symbols.join('\n'), toolCalls: 1 }
	}
	if (
		q.capability === 'dependency-trace' ||
		q.capability === 'impact-analysis' ||
		q.capability === 'test-coverage'
	) {
		const deps = engine.deps(target, { direction: 'upstream', depth: 3 })
		if (!deps) return { symbols: [], text: '', toolCalls: 1 }
		const symbols = deps.upstream.map((n) => `${n.symbol.filePath}::${n.symbol.name}`)
		return { symbols, text: symbols.join('\n'), toolCalls: 1 }
	}
	if (q.capability === 'cross-language' || q.capability === 'architecture') {
		const search = engine.search(target, { limit: 10 })
		const symbols = search.results.map((r) => `${r.filePath}::${r.name}`)
		return { symbols, text: symbols.join('\n'), toolCalls: 1 }
	}
	return { symbols: [], text: '', toolCalls: 0 }
}
