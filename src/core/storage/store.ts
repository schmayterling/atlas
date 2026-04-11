import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from '../../shared/logger.js'
import { isVectorSearchAvailable, loadVecExtension } from './sqlite-ext.js'
import type {
	Confidence,
	EdgeKind,
	EdgeRecord,
	FileRecord,
	SymbolKind,
	SymbolRecord,
	SymbolResult,
} from '../../shared/types.js'
import {
	CREATE_FTS,
	CREATE_INDEXES,
	CREATE_TABLES,
	CREATE_TRIGGERS,
	MIGRATIONS,
	PRAGMAS,
	SCHEMA_VERSION,
} from './schema.js'

const SYMBOL_SELECT = `SELECT id, stable_id as stableId, file_id as fileId, name, qualified_name as qualifiedName,
	kind, visibility, is_exported as isExported, line_start as lineStart, line_end as lineEnd,
	col_start as colStart, col_end as colEnd, byte_start as byteStart, byte_end as byteEnd,
	parent_id as parentId, signature, doc_comment as docComment, metadata
	FROM symbols`

export class AtlasStore {
	private db: Database
	private dbPath: string

	// cached prepared statements for hot paths
	private stmtGetSymbol!: ReturnType<Database['query']>
	private stmtEdgesFrom!: ReturnType<Database['query']>
	private stmtEdgesFromKind!: ReturnType<Database['query']>
	private stmtEdgesTo!: ReturnType<Database['query']>
	private stmtEdgesToKind!: ReturnType<Database['query']>
	private stmtFindSymbolInFile!: ReturnType<Database['query']>
	private stmtFindSymbolInFileKind!: ReturnType<Database['query']>

	constructor(dbPath: string) {
		const dir = dirname(dbPath)
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}

		this.dbPath = dbPath
		this.db = new Database(dbPath)
		loadVecExtension(this.db)
		this.initialize()
		this.prepareStatements()
	}

	private prepareStatements() {
		this.stmtGetSymbol = this.db.query(`${SYMBOL_SELECT} WHERE stable_id = ?`)
		this.stmtEdgesFrom = this.db.query(
			`SELECT id, source_id as sourceId, target_id as targetId, kind,
			file_id as fileId, line, col, confidence, metadata
			FROM edges WHERE source_id = ?`,
		)
		this.stmtEdgesFromKind = this.db.query(
			`SELECT id, source_id as sourceId, target_id as targetId, kind,
			file_id as fileId, line, col, confidence, metadata
			FROM edges WHERE source_id = ? AND kind = ?`,
		)
		this.stmtEdgesTo = this.db.query(
			`SELECT id, source_id as sourceId, target_id as targetId, kind,
			file_id as fileId, line, col, confidence, metadata
			FROM edges WHERE target_id = ?`,
		)
		this.stmtEdgesToKind = this.db.query(
			`SELECT id, source_id as sourceId, target_id as targetId, kind,
			file_id as fileId, line, col, confidence, metadata
			FROM edges WHERE target_id = ? AND kind = ?`,
		)
		this.stmtFindSymbolInFile = this.db.query(
			`${SYMBOL_SELECT} WHERE file_id = (SELECT id FROM files WHERE path = ?) AND name = ? ORDER BY line_start LIMIT 1`,
		)
		this.stmtFindSymbolInFileKind = this.db.query(
			`${SYMBOL_SELECT} WHERE file_id = (SELECT id FROM files WHERE path = ?) AND name = ? AND kind = ? ORDER BY line_start LIMIT 1`,
		)
	}

	private initialize() {
		// set pragmas (must be before schema creation)
		for (const line of PRAGMAS.trim().split('\n')) {
			const trimmed = line.trim()
			if (trimmed && !trimmed.startsWith('--')) {
				this.db.run(trimmed)
			}
		}

		this.db.run(CREATE_TABLES)
		this.db.run(CREATE_INDEXES)
		this.db.run(CREATE_FTS)
		this.db.run(CREATE_TRIGGERS)

		// set initial schema version if new DB, then apply any pending migrations
		const existing = this.db
			.query<{ value: string }, []>("SELECT value FROM atlas_meta WHERE key = 'schema_version'")
			.get()
		if (!existing) {
			this.db.run("INSERT INTO atlas_meta (key, value) VALUES ('schema_version', ?)", [
				String(SCHEMA_VERSION),
			])
		}
		this.applyMigrations(Number(existing?.value ?? SCHEMA_VERSION))
	}

	private applyMigrations(currentVersion: number) {
		const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
			(a, b) => a.version - b.version,
		)
		if (pending.length === 0) return

		for (const m of pending) {
			try {
				log.info(`applying migration v${m.version}: ${m.description}`)
				// use db.exec for multi-statement SQL; not transactional
				// because CREATE VIRTUAL TABLE can't run inside transactions
				this.db.run('BEGIN')
				try {
					// split and run statements individually
					for (const stmt of m.up.split(';').map((s) => s.trim()).filter(Boolean)) {
						this.db.run(stmt)
					}
					this.db.run("UPDATE atlas_meta SET value = ? WHERE key = 'schema_version'", [
						String(m.version),
					])
					this.db.run('COMMIT')
				} catch (innerErr) {
					this.db.run('ROLLBACK')
					throw innerErr
				}
			} catch (e) {
				// vec0 migration may fail if sqlite-vec extension isn't loaded; skip and try next
				log.debug(`migration v${m.version} failed (non-fatal): ${e}`)
				continue
			}
		}
	}

	close() {
		this.db.close()
	}

	// --- metadata ---

	getMeta(key: string): string | null {
		const row = this.db
			.query<{ value: string }, [string]>('SELECT value FROM atlas_meta WHERE key = ?')
			.get(key)
		return row?.value ?? null
	}

	setMeta(key: string, value: string) {
		this.db.run(
			'INSERT OR REPLACE INTO atlas_meta (key, value) VALUES (?, ?)',
			[key, value],
		)
	}

	// --- files ---

	getFile(id: number): FileRecord | null {
		return this.db
			.query<FileRecord, [number]>(
				'SELECT id, path, content_hash as contentHash, language, indexed_at as indexedAt, size_bytes as sizeBytes FROM files WHERE id = ?',
			)
			.get(id)
	}

	getFileByPath(path: string): FileRecord | null {
		return this.db
			.query<FileRecord, [string]>(
				'SELECT id, path, content_hash as contentHash, language, indexed_at as indexedAt, size_bytes as sizeBytes FROM files WHERE path = ?',
			)
			.get(path)
	}

	getAllFiles(): FileRecord[] {
		return this.db
			.query<FileRecord, []>(
				'SELECT id, path, content_hash as contentHash, language, indexed_at as indexedAt, size_bytes as sizeBytes FROM files',
			)
			.all()
	}

	getFileCount(): number {
		return (
			this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM files').get()?.count ?? 0
		)
	}

	getSymbolCountByFile(): Map<number, number> {
		const rows = this.db
			.query<{ fileId: number; count: number }, []>(
				'SELECT file_id as fileId, COUNT(*) as count FROM symbols GROUP BY file_id',
			)
			.all()
		const result = new Map<number, number>()
		for (const r of rows) result.set(r.fileId, r.count)
		return result
	}

	getSymbolsByFilePath(filePath: string): SymbolResult[] {
		return this.db
			.query<SymbolResult, [string]>(
				`SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
				f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
				s.is_exported as isExported, s.doc_comment as docComment,
				0 as usageCount, 0 as dependentCount
				FROM symbols s JOIN files f ON s.file_id = f.id
				WHERE f.path = ? ORDER BY s.line_start`,
			)
			.all(filePath)
	}

	// --- symbols ---

	getSymbolByStableId(stableId: string): SymbolRecord | null {
		return (this.stmtGetSymbol as any).get(stableId) as SymbolRecord | null
	}

	getSymbolsByStableIds(stableIds: string[]): Map<string, SymbolRecord> {
		if (stableIds.length === 0) return new Map()
		const result = new Map<string, SymbolRecord>()
		for (let i = 0; i < stableIds.length; i += 500) {
			const chunk = stableIds.slice(i, i + 500)
			const placeholders = chunk.map(() => '?').join(',')
			const rows = this.db
				.query<SymbolRecord, string[]>(`${SYMBOL_SELECT} WHERE stable_id IN (${placeholders})`)
				.all(...chunk)
			for (const r of rows) result.set(r.stableId, r)
		}
		return result
	}

	findSymbolsByName(name: string): SymbolRecord[] {
		return this.db
			.query<SymbolRecord, [string]>(`${SYMBOL_SELECT} WHERE name = ?`)
			.all(name)
	}

	findSymbolInFile(filePath: string, name: string, kind?: SymbolKind): SymbolRecord | null {
		if (kind) {
			return (this.stmtFindSymbolInFileKind as any).get(filePath, name, kind) as SymbolRecord | null
		}
		return (this.stmtFindSymbolInFile as any).get(filePath, name) as SymbolRecord | null
	}

	getSymbolCount(): number {
		return (
			this.db
				.query<{ count: number }, []>('SELECT COUNT(*) as count FROM symbols')
				.get()?.count ?? 0
		)
	}

	getEdgeCount(): number {
		return (
			this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM edges').get()?.count ?? 0
		)
	}

	getReferenceCount(): number {
		return (
			this.db
				.query<{ count: number }, []>('SELECT COUNT(*) as count FROM "references"')
				.get()?.count ?? 0
		)
	}

	// --- search ---

	searchSymbols(query: string, limit = 20): SymbolResult[] {
		// sanitize FTS5 query: strip operators, keep only alphanumeric and underscore
		const sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, '')
		if (!sanitized.trim()) return []
		const ftsQuery = `${sanitized}*`

		try {
			return this.db
				.query<SymbolResult, [string, number]>(
					`SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
					f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
					s.is_exported as isExported, s.doc_comment as docComment,
					(SELECT COUNT(*) FROM "references" r WHERE r.symbol_id = s.stable_id) as usageCount,
					(SELECT COUNT(DISTINCT e.source_id) FROM edges e WHERE e.target_id = s.stable_id) as dependentCount
					FROM symbols_fts
					JOIN symbols s ON s.id = symbols_fts.rowid
					JOIN files f ON f.id = s.file_id
					WHERE symbols_fts MATCH ?
					ORDER BY rank
					LIMIT ?`,
				)
				.all(ftsQuery, limit)
		} catch {
			// fall back to exact search on FTS parse error
			return this.searchSymbolsExact(query, undefined, limit)
		}
	}

	searchSymbolsExact(name: string, kind?: SymbolKind, limit = 20): SymbolResult[] {
		const kindClause = kind ? 'AND s.kind = ?' : ''
		const params = kind ? [name, kind, limit] : [name, limit]

		return this.db
			.query<SymbolResult, (string | number)[]>(
				`SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
				f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
				s.is_exported as isExported, s.doc_comment as docComment,
				(SELECT COUNT(*) FROM "references" r WHERE r.symbol_id = s.stable_id) as usageCount,
				(SELECT COUNT(DISTINCT e.source_id) FROM edges e WHERE e.target_id = s.stable_id) as dependentCount
				FROM symbols s
				JOIN files f ON f.id = s.file_id
				WHERE s.name = ? ${kindClause}
				ORDER BY s.is_exported DESC, s.name
				LIMIT ?`,
			)
			.all(...params)
	}

	// --- edges ---

	getDirectEdgesFrom(stableId: string, kind?: EdgeKind): EdgeRecord[] {
		if (kind) {
			return (this.stmtEdgesFromKind as any).all(stableId, kind) as EdgeRecord[]
		}
		return (this.stmtEdgesFrom as any).all(stableId) as EdgeRecord[]
	}

	getDirectEdgesTo(stableId: string, kind?: EdgeKind): EdgeRecord[] {
		if (kind) {
			return (this.stmtEdgesToKind as any).all(stableId, kind) as EdgeRecord[]
		}
		return (this.stmtEdgesTo as any).all(stableId) as EdgeRecord[]
	}

	// --- language stats ---

	getLanguageStats(): Record<string, number> {
		const rows = this.db
			.query<{ language: string; count: number }, []>(
				'SELECT language, COUNT(*) as count FROM files GROUP BY language',
			)
			.all()
		const stats: Record<string, number> = {}
		for (const row of rows) {
			if (row.language) stats[row.language] = row.count
		}
		return stats
	}

	// --- bulk write operations (used by indexer) ---

	deleteCrossFileEdgesForSources(sourceStableIds: string[]) {
		if (sourceStableIds.length === 0) return
		// batch in chunks of 500 to avoid SQLite variable limit
		for (let i = 0; i < sourceStableIds.length; i += 500) {
			const chunk = sourceStableIds.slice(i, i + 500)
			const placeholders = chunk.map(() => '?').join(',')
			this.db.run(
				`DELETE FROM edges WHERE file_id IS NULL AND source_id IN (${placeholders})`,
				chunk,
			)
		}
	}


	deleteFilesByPaths(paths: string[]) {
		if (paths.length === 0) return
		const del = this.db.prepare('DELETE FROM files WHERE path = ?')
		const tx = this.db.transaction(() => {
			for (const p of paths) del.run(p)
		})
		tx()
	}

	insertFile(
		path: string,
		contentHash: string,
		language: string,
		sizeBytes: number,
	): number {
		const now = Date.now()
		const result = this.db.run(
			'INSERT INTO files (path, content_hash, language, indexed_at, size_bytes) VALUES (?, ?, ?, ?, ?)',
			[path, contentHash, language, now, sizeBytes],
		)
		return Number(result.lastInsertRowid)
	}

	insertSymbol(sym: {
		stableId: string
		fileId: number
		name: string
		qualifiedName: string
		kind: SymbolKind
		visibility: string | null
		isExported: boolean
		lineStart: number
		lineEnd: number
		colStart: number
		colEnd: number
		byteStart: number
		byteEnd: number
		parentId: string | null
		signature: string | null
		docComment: string | null
		metadata: string | null
	}) {
		this.db.run(
			`INSERT OR REPLACE INTO symbols (stable_id, file_id, name, qualified_name, kind, visibility,
			is_exported, line_start, line_end, col_start, col_end, byte_start, byte_end,
			parent_id, signature, doc_comment, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				sym.stableId,
				sym.fileId,
				sym.name,
				sym.qualifiedName,
				sym.kind,
				sym.visibility,
				sym.isExported ? 1 : 0,
				sym.lineStart,
				sym.lineEnd,
				sym.colStart,
				sym.colEnd,
				sym.byteStart,
				sym.byteEnd,
				sym.parentId,
				sym.signature,
				sym.docComment,
				sym.metadata,
			],
		)
	}

	insertEdge(edge: {
		sourceId: string
		targetId: string
		kind: EdgeKind
		fileId: number | null
		line: number | null
		col: number | null
		confidence: Confidence
		metadata: string | null
	}) {
		this.db.run(
			`INSERT INTO edges (source_id, target_id, kind, file_id, line, col, confidence, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				edge.sourceId,
				edge.targetId,
				edge.kind,
				edge.fileId,
				edge.line,
				edge.col,
				edge.confidence,
				edge.metadata,
			],
		)
	}


	insertImport(imp: {
		sourceFileId: number
		targetFileId: number | null
		importPath: string
		isTypeOnly: boolean
		line: number
	}) {
		this.db.run(
			'INSERT INTO imports (source_file_id, target_file_id, import_path, is_type_only, line) VALUES (?, ?, ?, ?, ?)',
			[imp.sourceFileId, imp.targetFileId, imp.importPath, imp.isTypeOnly ? 1 : 0, imp.line],
		)
	}

	// bulk insert with transaction
	bulkInsert(operations: () => void) {
		this.db.transaction(operations)()
	}

	// run an arbitrary read query
	queryRaw<T>(sql: string): T[] {
		return this.db.query<T, []>(sql).all()
	}

	// run a read query with parameters
	queryRawWithParams<T>(sql: string, ...params: any[]): T[] {
		return (this.db.query(sql) as any).all(...params) as T[]
	}

	// run an arbitrary write statement with params
	runRaw(sql: string, ...params: unknown[]) {
		this.db.run(sql, params as any[])
	}

	// --- api endpoints ---

	insertApiEndpoint(endpoint: {
		filePath: string
		pathPattern: string
		httpMethod: string | null
		symbolStableId: string
		role: 'client' | 'server'
		framework: string | null
		line: number
	}) {
		this.db.run(
			'INSERT INTO api_endpoints (file_path, path_pattern, http_method, symbol_stable_id, role, framework, line) VALUES (?, ?, ?, ?, ?, ?, ?)',
			[endpoint.filePath, endpoint.pathPattern, endpoint.httpMethod, endpoint.symbolStableId, endpoint.role, endpoint.framework, endpoint.line],
		)
	}

	deleteApiEndpointsForFile(filePath: string) {
		this.db.run('DELETE FROM api_endpoints WHERE file_path = ?', [filePath])
	}

	findApiEndpoints(pathPattern?: string, role?: 'client' | 'server'): {
		filePath: string
		pathPattern: string
		httpMethod: string | null
		symbolStableId: string
		role: string
		framework: string | null
		line: number
	}[] {
		let sql = 'SELECT file_path as filePath, path_pattern as pathPattern, http_method as httpMethod, symbol_stable_id as symbolStableId, role, framework, line FROM api_endpoints WHERE 1=1'
		const params: string[] = []
		if (pathPattern) {
			sql += ' AND path_pattern LIKE ?'
			params.push(`%${pathPattern}%`)
		}
		if (role) {
			sql += ' AND role = ?'
			params.push(role)
		}
		return this.db.query(sql).all(...params) as any[]
	}

	getDbSize(): number {
		try {
			return statSync(this.dbPath).size
		} catch {
			return 0
		}
	}

	// resolve a symbol query (name or file:name) to a SymbolRecord
	resolveSymbol(query: string): SymbolRecord | null {
		// try "file:name" format (split on first single colon, skip :: which is a qualified name separator)
		const colonIdx = query.indexOf(':')
		if (colonIdx > 0 && query[colonIdx + 1] !== ':') {
			const filePart = query.slice(0, colonIdx)
			const namePart = query.slice(colonIdx + 1)
			// escape LIKE wildcards in user input
			const escapedFile = filePart.replace(/%/g, '\\%').replace(/_/g, '\\_')
			const results = this.db
				.query<SymbolRecord, [string, string]>(
					`SELECT s.id, s.stable_id as stableId, s.file_id as fileId, s.name,
					s.qualified_name as qualifiedName, s.kind, s.visibility,
					s.is_exported as isExported, s.line_start as lineStart, s.line_end as lineEnd,
					s.col_start as colStart, s.col_end as colEnd, s.byte_start as byteStart,
					s.byte_end as byteEnd, s.parent_id as parentId, s.signature,
					s.doc_comment as docComment, s.metadata
					FROM symbols s
					JOIN files f ON f.id = s.file_id
					WHERE f.path LIKE ? ESCAPE '\\' AND s.name = ?
					LIMIT 1`,
				)
				.all(`%${escapedFile}%`, namePart)
			if (results.length > 0) return results[0]
		}

		// try exact name match
		const byName = this.findSymbolsByName(query)
		if (byName.length > 0) return byName[0]

		// try qualified name match (escape LIKE wildcards)
		const escapedQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_')
		const byQual = this.db
			.query<SymbolRecord, [string]>(
				`SELECT id, stable_id as stableId, file_id as fileId, name, qualified_name as qualifiedName,
				kind, visibility, is_exported as isExported, line_start as lineStart, line_end as lineEnd,
				col_start as colStart, col_end as colEnd, byte_start as byteStart, byte_end as byteEnd,
				parent_id as parentId, signature, doc_comment as docComment, metadata
				FROM symbols WHERE qualified_name LIKE ? ESCAPE '\\'
				LIMIT 1`,
			)
			.get(`%${escapedQuery}%`)
		return byQual ?? null
	}

	// convert a symbol record to a result (without N+1 count queries)
	symbolToResult(sym: SymbolRecord): SymbolResult {
		const file = this.getFile(sym.fileId)
		return {
			name: sym.name,
			qualifiedName: sym.qualifiedName,
			kind: sym.kind,
			signature: sym.signature,
			filePath: file?.path ?? '<unknown>',
			lineStart: sym.lineStart,
			lineEnd: sym.lineEnd,
			isExported: Boolean(sym.isExported),
			docComment: sym.docComment,
			usageCount: 0,
			dependentCount: 0,
		}
	}

	// batch convert symbols to results with counts in 2 bulk queries instead of 2N
	symbolsToResults(syms: SymbolRecord[]): SymbolResult[] {
		if (syms.length === 0) return []

		// batch prefetch files (single query instead of N)
		const fileIds = [...new Set(syms.map((s) => s.fileId))]
		const fileMap = new Map<number, string>()
		for (let i = 0; i < fileIds.length; i += 500) {
			const chunk = fileIds.slice(i, i + 500)
			const ph = chunk.map(() => '?').join(',')
			const rows = this.db
				.query<{ id: number; path: string }, number[]>(
					`SELECT id, path FROM files WHERE id IN (${ph})`,
				)
				.all(...chunk)
			for (const r of rows) fileMap.set(r.id, r.path)
		}

		// batch dependent counts (chunked for SQLite variable limit)
		const stableIds = syms.map((s) => s.stableId)
		const depMap = new Map<string, number>()
		for (let i = 0; i < stableIds.length; i += 500) {
			const chunk = stableIds.slice(i, i + 500)
			const ph = chunk.map(() => '?').join(',')
			const depCounts = this.db
				.query<{ targetId: string; count: number }, string[]>(
					`SELECT target_id as targetId, COUNT(DISTINCT source_id) as count
					FROM edges WHERE target_id IN (${ph})
					GROUP BY target_id`,
				)
				.all(...chunk)
			for (const r of depCounts) depMap.set(r.targetId, r.count)
		}

		return syms.map((sym) => ({
			name: sym.name,
			qualifiedName: sym.qualifiedName,
			kind: sym.kind,
			signature: sym.signature,
			filePath: fileMap.get(sym.fileId) ?? '<unknown>',
			lineStart: sym.lineStart,
			lineEnd: sym.lineEnd,
			isExported: Boolean(sym.isExported),
			docComment: sym.docComment,
			usageCount: 0, // references table not populated yet
			dependentCount: depMap.get(sym.stableId) ?? 0,
		}))
	}
}
