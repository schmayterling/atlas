import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import { findFlowRoots, traceFlowChain, storeFlow, clearFlows } from '../queries/flow-detection.js'

export async function runFlowPipeline(
	store: AtlasStore,
	opts?: { skipLLM?: boolean; excludeFileIds?: Set<number> },
): Promise<{ detected: number; named: number }> {
	// check if flows table exists
	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='flows'",
	)
	if (tables.length === 0) return { detected: 0, named: 0 }

	// find flow roots (exported functions not called by anything)
	const roots = findFlowRoots(store, { excludeFileIds: opts?.excludeFileIds })
	if (roots.length === 0) return { detected: 0, named: 0 }

	// trace chains from each root
	const flows: { rootId: string; chain: string[]; rootName: string }[] = []
	for (const root of roots) {
		const chain = traceFlowChain(store, root.stableId, 5)
		// only interesting flows: at least 2 symbols in the chain
		if (chain.length >= 2) {
			flows.push({ rootId: root.stableId, chain, rootName: root.name })
		}
	}

	if (flows.length === 0) return { detected: 0, named: 0 }

	// try to name flows with LLM (skip when caller opts out, e.g. tests)
	const client = new OllamaClient()
	let chatModel: string | null = null
	try {
		const running = !opts?.skipLLM && (await client.isRunning())
		if (running) {
			const res = await fetch('http://127.0.0.1:11434/api/tags')
			if (res.ok) {
				const data = (await res.json()) as { models: { name: string }[] }
				const candidates = data.models.map((m) => m.name).filter((n) => !n.includes('minilm') && !n.includes('embed'))
				if (candidates.length > 0) chatModel = candidates[0]
			}
		}
	} catch {
		// no LLM available
	}

	clearFlows(store)
	let named = 0

	for (const flow of flows) {
		// resolve symbol names for the chain
		const names = flow.chain
			.map((id) => store.getSymbolByStableId(id))
			.filter((s) => s !== null)
			.map((s) => s!.name)

		let flowName = flow.rootName
		let description: string | null = null

		if (chatModel && names.length >= 2) {
			try {
				const prompt = `Given this function call chain: ${names.join(' -> ')}\n\nWhat user-facing flow or feature does this implement? Answer with a short name (2-4 words) on the first line, then a one-sentence description on the second line. Example:\nuser authentication\nauthenticates users via email and password, creates a session.`
				const response = await client.generate(prompt, chatModel)
				const lines = response.trim().split('\n')
				if (lines.length >= 1) flowName = lines[0].trim().toLowerCase()
				if (lines.length >= 2) description = lines.slice(1).join(' ').trim()
				named++
			} catch (e) {
				log.warn(`failed to name flow ${flow.rootName}: ${e}`)
			}
		}

		storeFlow(store, flowName, description, flow.rootId, flow.chain, chatModel)
	}

	return { detected: flows.length, named }
}
