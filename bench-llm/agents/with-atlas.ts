// with-atlas LLM agent: atlas tools ONLY (no text fallback).
// earlier runs showed the LLM using grep/glob/read_file 44% of the time
// even when atlas alternatives existed, which meant the measured atlas
// advantage was partly carried by grep. removing the fallback forces a
// clean measurement of atlas's own tool surface, matching how cbm and
// chunkhound are isolated for their own comparisons.
//
// atlas tools (from ATLAS_TOOLS): atlas_search, atlas_semantic_search,
// atlas_overview, atlas_deps, atlas_blast_radius, atlas_trace,
// atlas_call_sites, atlas_test_coverage, atlas_files.

import type { AtlasEngine } from '../../src/core/engine.js'
import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { ATLAS_TOOLS, makeAtlasHandler } from '../lib/atlas-tools.js'

export async function runWithAtlasAgent(opts: {
	model: string
	task: LlmTaskInput
	corpusRoot: string
	engine: AtlasEngine
}): Promise<LlmAgentResult> {
	const atlasHandler = makeAtlasHandler(opts.engine)
	return runLlmAgent({
		model: opts.model,
		task: opts.task,
		tools: ATLAS_TOOLS,
		toolHandler: atlasHandler,
	})
}
