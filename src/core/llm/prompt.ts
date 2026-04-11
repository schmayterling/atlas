import type { SymbolResult, DependencyNode } from '../../shared/types.js'

export function buildSummaryPrompt(
	symbol: SymbolResult,
	sourceCode: string | undefined,
	upstream: DependencyNode[],
	downstream: DependencyNode[],
): string {
	let prompt = `Explain what this ${symbol.kind} does in 2-3 sentences. Be concise and technical.\n\n`
	prompt += `Name: ${symbol.name}\n`
	prompt += `File: ${symbol.filePath}\n`
	if (symbol.signature) prompt += `Signature: ${symbol.signature}\n`
	if (symbol.docComment) prompt += `Documentation: ${symbol.docComment}\n`

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
