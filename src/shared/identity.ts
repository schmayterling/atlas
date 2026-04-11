import { createHash } from 'node:crypto'
import type { SymbolKind } from './types.js'

// generate a stable symbol key from its identity components.
// this key survives delete-and-reinsert because it derives from
// the symbol's identity, not its database rowid.
export function stableSymbolId(
	filePath: string,
	kind: SymbolKind,
	qualifiedName: string,
): string {
	const input = `${filePath}:${kind}:${qualifiedName}`
	return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

// generate a content hash for a file (for change detection)
export function contentHash(content: string | Buffer): string {
	return createHash('sha256')
		.update(content)
		.digest('hex')
}
