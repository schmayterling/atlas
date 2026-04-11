import type { DeadCodeResult, SymbolKind, SymbolResult } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

export function findDeadCode(
	store: AtlasStore,
	opts?: { path?: string; kind?: SymbolKind },
): DeadCodeResult {
	// pure SQL: symbols with no inbound edges (excluding 'contains' edges),
	// that are not exported and not module-level
	const pathFilter = opts?.path
		? `AND f.path LIKE '%${opts.path.replace(/%/g, '\\%').replace(/_/g, '\\_')}%' ESCAPE '\\'`
		: ''
	const kindFilter = opts?.kind ? `AND s.kind = '${opts.kind}'` : ''

	const rows = store.queryRaw<{
		name: string
		qualifiedName: string
		kind: string
		signature: string | null
		filePath: string
		lineStart: number
		lineEnd: number
		isExported: number
		docComment: string | null
	}>(
		`SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.is_exported = 0
			AND s.kind IN ('function', 'class', 'method', 'interface', 'type', 'enum')
			AND s.stable_id NOT IN (
				SELECT DISTINCT target_id FROM edges WHERE kind != 'contains'
			)
			${pathFilter}
			${kindFilter}
		ORDER BY f.path, s.line_start`,
	)

	const symbols: SymbolResult[] = rows.map((r) => ({
		name: r.name,
		qualifiedName: r.qualifiedName,
		kind: r.kind as SymbolKind,
		signature: r.signature,
		filePath: r.filePath,
		lineStart: r.lineStart,
		lineEnd: r.lineEnd,
		isExported: false,
		docComment: r.docComment,
		usageCount: 0,
		dependentCount: 0,
	}))

	// build stats
	const byKind: Record<string, number> = {}
	const byFile: Record<string, number> = {}
	for (const sym of symbols) {
		byKind[sym.kind] = (byKind[sym.kind] ?? 0) + 1
		byFile[sym.filePath] = (byFile[sym.filePath] ?? 0) + 1
	}

	return {
		symbols,
		stats: { total: symbols.length, byKind, byFile },
	}
}
