import type { SymbolResult, DependencyNode } from '../../shared/types.js'

export function buildSummaryPrompt(
	symbol: SymbolResult,
	sourceCode: string | undefined,
	upstream: DependencyNode[],
	downstream: DependencyNode[],
	flowNames?: string[],
): string {
	let prompt = `Explain what this ${symbol.kind} does in 2-3 sentences. Be concise and technical.\n\n`
	prompt += `Name: ${symbol.name}\n`
	prompt += `File: ${symbol.filePath}\n`
	if (symbol.signature) prompt += `Signature: ${symbol.signature}\n`
	if (symbol.docComment) prompt += `Documentation: ${symbol.docComment}\n`

	if (flowNames && flowNames.length > 0) {
		prompt += `\nPart of flow(s): ${flowNames.join(', ')}\n`
		prompt += `Explain how this symbol fits into the bigger picture of these flows.\n`
	}

	if (sourceCode) {
		const truncated = sourceCode.length > 2000 ? sourceCode.slice(0, 2000) + '\n...(truncated)' : sourceCode
		prompt += `\nSource code:\n\`\`\`\n${truncated}\n\`\`\`\n`
	}

	if (upstream.length > 0) {
		prompt += `\nDependencies: ${upstream.map((d) => `${d.symbol.name} (${d.edgeKind})`).join(', ')}\n`
	}
	if (downstream.length > 0) {
		prompt += `\nUsed by: ${downstream.map((d) => `${d.symbol.name} (${d.edgeKind})`).join(', ')}\n`
	}

	prompt += `\nRespond with only the explanation, no preamble.`
	return prompt
}

export function buildFileSummaryPrompt(
	filePath: string,
	symbolNames: string[],
	symbolKinds: string[],
): string {
	let prompt = `Summarize what this file does in 2-3 sentences. Be concise and technical.\n\n`
	prompt += `File: ${filePath}\n`
	prompt += `Contains: ${symbolNames.map((n, i) => `${symbolKinds[i]} ${n}`).join(', ')}\n`
	prompt += `\nRespond with only the summary, no preamble.`
	return prompt
}
