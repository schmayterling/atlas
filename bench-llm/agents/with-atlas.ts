// with-atlas LLM agent: tools = read_file + grep + glob + atlas_*.
// the atlas tools wrap engine methods (atlas_search, atlas_overview,
// atlas_deps, atlas_blast_radius, atlas_trace, atlas_call_sites,
// atlas_test_coverage, atlas_files).

import type { AtlasEngine } from '../../src/core/engine.js'
import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { TEXT_TOOLS, makeTextHandler } from '../lib/text-tools.js'
import { ATLAS_TOOLS, makeAtlasHandler } from '../lib/atlas-tools.js'
import type { ToolCall } from '../lib/openrouter.js'

export async function runWithAtlasAgent(opts: {
	model: string
	task: LlmTaskInput
	corpusRoot: string
	engine: AtlasEngine
}): Promise<LlmAgentResult> {
	const textHandler = makeTextHandler(opts.corpusRoot)
	const atlasHandler = makeAtlasHandler(opts.engine)
	const handler = async (call: ToolCall) => {
		if (call.function.name.startsWith('atlas_')) return atlasHandler(call)
		return textHandler(call)
	}
	return runLlmAgent({
		model: opts.model,
		task: opts.task,
		tools: [...TEXT_TOOLS, ...ATLAS_TOOLS],
		toolHandler: handler,
	})
}
