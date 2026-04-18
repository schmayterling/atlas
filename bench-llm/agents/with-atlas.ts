// with-atlas agent: baseline + atlas MCP tools. phase 1 stub that
// calls the engine directly (no llm in the loop). phase 2 replaces
// with a real llm-driven agent using the anthropic sdk + mcp. see #84.

import type { AgentAnswer, Question } from '../run.js'
import { AtlasEngine } from '../../src/core/engine.js'

export async function runWithAtlasAgent(q: Question, corpusRoot: string): Promise<AgentAnswer> {
	// phase 1: no llm. resolve a query directly against atlas so the
	// scoring pipeline is exercised end-to-end and so reviewers can see
	// the shape a real agent's answer will take.
	const target = extractTarget(q.question)
	if (!target) return { symbols: [], toolCalls: 0 }
	const engine = new AtlasEngine(corpusRoot)
	try {
		if (q.capability === 'symbol-locate' || q.capability === 'symbol-set') {
			const search = engine.search(target, { limit: 20 })
			return {
				symbols: search.results.map((r) => `${r.filePath}::${r.name}`),
				toolCalls: 1,
			}
		}
		if (
			q.capability === 'dependency-trace' ||
			q.capability === 'impact-analysis' ||
			q.capability === 'test-coverage'
		) {
			const deps = engine.deps(target, { direction: 'upstream', depth: 3 })
			if (!deps) return { symbols: [], toolCalls: 1 }
			const symbols = deps.upstream.map((n) => `${n.symbol.filePath}::${n.symbol.name}`)
			return { symbols, toolCalls: 1 }
		}
		return { symbols: [], toolCalls: 0 }
	} finally {
		engine.close()
	}
}

function extractTarget(question: string): string | null {
	const patterns = [/\bfunction\s+(\w+)/, /\bsymbol\s+(\w+)/, /`(\w+)`/, /\b([A-Z][A-Za-z0-9]{3,})\b/]
	for (const p of patterns) {
		const m = question.match(p)
		if (m) return m[1]
	}
	return null
}
