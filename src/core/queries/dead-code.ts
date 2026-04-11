import type { DeadCodeResult, SymbolKind, SymbolResult } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

export function findDeadCode(
	store: AtlasStore,
	opts?: { path?: string; kind?: SymbolKind },
): DeadCodeResult {
	// build parameterized query to avoid SQL injection
	let sql = `SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.is_exported = 0
			AND s.kind IN ('function', 'class', 'method', 'interface', 'type', 'enum')
			AND s.name != 'constructor'
			AND s.stable_id NOT IN (
				SELECT DISTINCT target_id FROM edges WHERE kind != 'contains'
			)`

	const params: (string | number)[] = []

	if (opts?.path) {
		const escapedPath = opts.path.replace(/%/g, '\\%').replace(/_/g, '\\_')
		sql += ` AND f.path LIKE ? ESCAPE '\\'`
		params.push(`%${escapedPath}%`)
	}

	if (opts?.kind) {
		sql += ' AND s.kind = ?'
		params.push(opts.kind)
	}

	sql += ' ORDER BY f.path, s.line_start'

	const rows = store.queryRawWithParams<{
		name: string
		qualifiedName: string
		kind: string
		signature: string | null
		filePath: string
		lineStart: number
		lineEnd: number
		isExported: number
		docComment: string | null
	}>(sql, ...params)

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
