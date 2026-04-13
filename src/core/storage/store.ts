import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { stableSymbolId } from '../../shared/identity.js'
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

interface CrossProjectEdgeRow {
	sourceProject: string
	sourceStableId: string
	targetProject: string
	targetStableId: string
	kind: string
}

// split a multi-statement DDL bundle into individual statements while
// preserving BEGIN ... END blocks (e.g. trigger bodies) as a single unit.
function splitDdl(ddl: string): string[] {
	const stmts: string[] = []
	let current = ''
	let depth = 0
	for (const rawLine of ddl.split('\n')) {
		const line = rawLine.replace(/--.*$/, '')
		if (!line.trim()) {
			if (current) current += '\n'
			continue
		}
		current += `${line}\n`
		if (/\bBEGIN\b/i.test(line)) depth++
		if (/\bEND\b/i.test(line) && depth > 0) depth--
		if (depth === 0 && /;\s*$/.test(line)) {
			const trimmed = current.trim()
			if (trimmed) stmts.push(trimmed)
			current = ''
		}
	}
	if (current.trim()) stmts.push(current.trim())
	return stmts
}

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
		// invariant: stmtFindSymbolInFile and stmtFindSymbolInFileKind must
		// not filter by files.is_test. the TS resolver uses them to build
		// the cross-file edges that test-mapping (step 6.5) reads to upgrade
		// imported -> called confidence. filtering here would silently
		// produce zero 'called' rows.
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

		// bun:sqlite's db.run() executes only the first statement of a
		// multi-statement string, so split each DDL bundle on ';' and run
		// the statements individually. splitDdl preserves BEGIN ... END
		// blocks (trigger bodies have semicolons inside).
		this.runDdl(CREATE_TABLES, 'CREATE_TABLES')
		this.runDdl(CREATE_INDEXES, 'CREATE_INDEXES')
		this.runDdl(CREATE_FTS, 'CREATE_FTS')
		this.runDdl(CREATE_TRIGGERS, 'CREATE_TRIGGERS')

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

	private runDdl(ddl: string, label = 'ddl') {
		const statements = splitDdl(ddl)
		for (let i = 0; i < statements.length; i++) {
			const stmt = statements[i]
			try {
				this.db.run(stmt)
			} catch (e) {
				const preview = stmt.replace(/\s+/g, ' ').slice(0, 120)
				throw new Error(
					`${label} statement ${i + 1}/${statements.length} failed: ${preview}${stmt.length > 120 ? '...' : ''} :: ${e}`,
					{ cause: e },
				)
			}
		}
	}

	private applyMigrations(currentVersion: number) {
		const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
			(a, b) => a.version - b.version,
		)
		if (pending.length === 0) return

		// migrations whose failure is recoverable. v2 introduces vec0 (sqlite-vec
		// extension may be unavailable). v7 recreates the same vec0 table at a
		// new dimension. all other migrations introduce required tables and
		// must fail loudly.
		const OPTIONAL_MIGRATIONS = new Set([2, 7])

		for (const m of pending) {
			try {
				log.info(`applying migration v${m.version}: ${m.description}`)
				this.db.run('BEGIN')
				try {
					this.runDdl(m.up, `migration v${m.version}`)
					this.db.run("UPDATE atlas_meta SET value = ? WHERE key = 'schema_version'", [
						String(m.version),
					])
					this.db.run('COMMIT')
				} catch (innerErr) {
					this.db.run('ROLLBACK')
					throw innerErr
				}
			} catch (e) {
				if (!OPTIONAL_MIGRATIONS.has(m.version)) throw e
				log.debug(`migration v${m.version} failed (non-fatal, optional): ${e}`)
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
				'SELECT id, path, content_hash as contentHash, language, indexed_at as indexedAt, size_bytes as sizeBytes, is_test as isTest FROM files WHERE id = ?',
			)
			.get(id)
	}

	getFileByPath(path: string): FileRecord | null {
		return this.db
			.query<FileRecord, [string]>(
				'SELECT id, path, content_hash as contentHash, language, indexed_at as indexedAt, size_bytes as sizeBytes, is_test as isTest FROM files WHERE path = ?',
			)
			.get(path)
	}

	getAllFiles(): FileRecord[] {
		return this.db
			.query<FileRecord, []>(
				'SELECT id, path, content_hash as contentHash, language, indexed_at as indexedAt, size_bytes as sizeBytes, is_test as isTest FROM files',
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

	searchSymbols(query: string, limit = 20, includeTests = false): SymbolResult[] {
		// sanitize FTS5 query: strip operators, keep only alphanumeric and underscore
		const sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, '')
		if (!sanitized.trim()) return []
		const ftsQuery = `${sanitized}*`

		const testClause = includeTests ? '' : 'AND f.is_test = 0'

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
					WHERE symbols_fts MATCH ? ${testClause}
					ORDER BY rank
					LIMIT ?`,
				)
				.all(ftsQuery, limit)
		} catch {
			// fall back to exact search on FTS parse error
			return this.searchSymbolsExact(query, undefined, limit, includeTests)
		}
	}

	searchSymbolsExact(name: string, kind?: SymbolKind, limit = 20, includeTests = false): SymbolResult[] {
		const kindClause = kind ? 'AND s.kind = ?' : ''
		const testClause = includeTests ? '' : 'AND f.is_test = 0'
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
				WHERE s.name = ? ${kindClause} ${testClause}
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

	// --- repo modules (intra-repo package boundaries) ---

	upsertRepoModule(mod: {
		id: string
		name: string
		kind: string
		manifestPath: string
		rootDir: string
		modulePath: string | null
	}): void {
		this.db.run(
			`INSERT INTO repo_modules (id, name, kind, manifest_path, root_dir, module_path)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   kind = excluded.kind,
			   manifest_path = excluded.manifest_path,
			   root_dir = excluded.root_dir,
			   module_path = excluded.module_path`,
			[mod.id, mod.name, mod.kind, mod.manifestPath, mod.rootDir, mod.modulePath],
		)
	}

	deleteRepoModulesNotIn(ids: string[]): void {
		if (ids.length === 0) {
			this.db.run('DELETE FROM repo_modules')
			return
		}
		const placeholders = ids.map(() => '?').join(',')
		this.db.run(`DELETE FROM repo_modules WHERE id NOT IN (${placeholders})`, ids)
	}

	setFileRepoModule(fileId: number, moduleId: string | null): void {
		this.db.run('UPDATE files SET repo_module_id = ? WHERE id = ?', [moduleId, fileId])
	}

	// rewrites stable-id columns across every FK table that references a
	// symbol stable_id, then updates files.path in place. used when git
	// reports a rename so the pre-rename identity survives: edges, test
	// links, api endpoints, embeddings, summaries, flows and duplicates
	// all keep pointing at the same logical symbols under their new path.
	//
	// returns the number of distinct (old → new) stable_id rewrites applied.
	//
	// how the mapping is computed: the store already has one symbol row per
	// old-path symbol with a known (kind, qualified_name). the qualified
	// name starts with "oldPath::" (atlas qname format, see indexer.ts and
	// CLAUDE.md). we substitute the path prefix, recompute the stable_id
	// with stableSymbolId(newPath, kind, newQname), and feed the resulting
	// pairs into rewriteSymbolStableIdPairs.
	//
	// step 4/5 still re-parse the renamed file after this step runs. for
	// symbols whose (kind, local-name) survived the rename unchanged, the
	// re-parse emits the same predicted stable_id, so the FK targets line
	// up with the fresh symbol rows and nothing orphans. symbols that were
	// renamed inside the file during the same commit fall through to the
	// existing delete+insert path and lose identity; same behaviour as
	// before the rename step existed.
	rewriteStableIdsForRename(oldPath: string, newPath: string): number {
		// load old symbols up front so the UPDATE on files.path (which
		// changes what the symbols join to) can't race the mapping build.
		const oldSymbols = this.db
			.query<
				{ stableId: string; kind: string; qualifiedName: string; parentId: string | null },
				[string]
			>(
				`SELECT s.stable_id as stableId, s.kind, s.qualified_name as qualifiedName, s.parent_id as parentId
				 FROM symbols s JOIN files f ON f.id = s.file_id
				 WHERE f.path = ?`,
			)
			.all(oldPath)

		if (oldSymbols.length === 0) {
			// no symbols for the old path (e.g. file was never indexed, or
			// previously failed to parse). still rename the file row so
			// file_changes + co-change inherit the prior history.
			this.db.run('UPDATE files SET path = ? WHERE path = ?', [newPath, oldPath])
			return 0
		}

		const mapping = new Map<string, string>()
		const newQnames = new Map<string, string>()
		const skipped: Array<{ stableId: string; qualifiedName: string }> = []
		const oldPrefix = `${oldPath}::`
		const newPrefix = `${newPath}::`

		for (const sym of oldSymbols) {
			if (!sym.qualifiedName.startsWith(oldPrefix)) {
				// non-standard qname shape: extractor didn't emit
				// relPath::Name. we can't compute the new stable_id without
				// risking collision, so record the skip and keep going.
				// caller logs the list so the operator can see it.
				skipped.push({ stableId: sym.stableId, qualifiedName: sym.qualifiedName })
				continue
			}
			const newQname = newPrefix + sym.qualifiedName.slice(oldPrefix.length)
			const newStableId = stableSymbolId(newPath, sym.kind as SymbolKind, newQname)
			if (newStableId === sym.stableId) continue
			mapping.set(sym.stableId, newStableId)
			newQnames.set(sym.stableId, newQname)
		}

		if (skipped.length > 0) {
			log.warn(
				`rename ${oldPath} -> ${newPath}: ${skipped.length} symbols with unexpected qname shape were not rewritten (stale refs may remain). first: ${skipped[0].qualifiedName}`,
			)
		}

		if (mapping.size === 0) {
			this.db.run('UPDATE files SET path = ? WHERE path = ?', [newPath, oldPath])
			return 0
		}

		const updates = Array.from(mapping.entries())

		// runs inside one transaction so a failure rolls back cleanly.
		// order matters: symbols first so parent_id rewrites see the new
		// ids, then aux tables, then files.path last so queries above that
		// joined on oldPath still matched the row.
		const tx = this.db.transaction(() => {
			const updateSym = this.db.prepare(
				'UPDATE symbols SET stable_id = ?, qualified_name = ? WHERE stable_id = ?',
			)
			for (const [oldId, newId] of updates) {
				updateSym.run(newId, newQnames.get(oldId)!, oldId)
			}

			// parent_id in symbols can reference the renamed ids; rewrite
			// independently of the above in case a child's parent lives in
			// the same rewritten set.
			const updateParent = this.db.prepare(
				'UPDATE symbols SET parent_id = ? WHERE parent_id = ?',
			)
			for (const [oldId, newId] of updates) updateParent.run(newId, oldId)

			const updateEdgeSrc = this.db.prepare(
				'UPDATE edges SET source_id = ? WHERE source_id = ?',
			)
			const updateEdgeTgt = this.db.prepare(
				'UPDATE edges SET target_id = ? WHERE target_id = ?',
			)
			for (const [oldId, newId] of updates) {
				updateEdgeSrc.run(newId, oldId)
				updateEdgeTgt.run(newId, oldId)
			}

			const updateApiSym = this.db.prepare(
				'UPDATE api_endpoints SET symbol_stable_id = ? WHERE symbol_stable_id = ?',
			)
			for (const [oldId, newId] of updates) updateApiSym.run(newId, oldId)
			this.db.run('UPDATE api_endpoints SET file_path = ? WHERE file_path = ?', [
				newPath,
				oldPath,
			])

			// test_links, embedding_meta, symbol_summaries, duplicates:
			// these have UNIQUE / PK constraints on the stable_id column
			// we're rewriting. a plain UPDATE can collide when the
			// destination id already exists (rare, but possible when the
			// new path was previously indexed and the row survived an
			// earlier rewrite). OR IGNORE would leave the old row behind
			// pointing at a stale id, so DELETE the conflicting new row
			// first, THEN rewrite. this way the row survives the rename
			// under exactly one stable_id.
			const delTestLinks = this.db.prepare(
				'DELETE FROM test_links WHERE source_symbol_stable_id = ?',
			)
			const updTestLinks = this.db.prepare(
				'UPDATE test_links SET source_symbol_stable_id = ? WHERE source_symbol_stable_id = ?',
			)
			for (const [oldId, newId] of updates) {
				delTestLinks.run(newId)
				updTestLinks.run(newId, oldId)
			}

			const delEmbed = this.db.prepare(
				'DELETE FROM embedding_meta WHERE symbol_stable_id = ?',
			)
			const updEmbed = this.db.prepare(
				'UPDATE embedding_meta SET symbol_stable_id = ? WHERE symbol_stable_id = ?',
			)
			for (const [oldId, newId] of updates) {
				delEmbed.run(newId)
				updEmbed.run(newId, oldId)
			}

			const delSumm = this.db.prepare(
				'DELETE FROM symbol_summaries WHERE symbol_stable_id = ?',
			)
			const updSumm = this.db.prepare(
				'UPDATE symbol_summaries SET symbol_stable_id = ? WHERE symbol_stable_id = ?',
			)
			for (const [oldId, newId] of updates) {
				delSumm.run(newId)
				updSumm.run(newId, oldId)
			}

			const updateFlowRoot = this.db.prepare(
				'UPDATE flows SET root_stable_id = ? WHERE root_stable_id = ?',
			)
			for (const [oldId, newId] of updates) updateFlowRoot.run(newId, oldId)

			// flows.symbol_ids is a json array of stable_ids; scan each
			// row and rewrite in-place where any mapping key appears.
			const flowRows = this.db
				.query<{ id: number; symbolIds: string }, []>(
					'SELECT id, symbol_ids as symbolIds FROM flows',
				)
				.all()
			const updateFlowBlob = this.db.prepare('UPDATE flows SET symbol_ids = ? WHERE id = ?')
			for (const row of flowRows) {
				let ids: unknown
				try {
					ids = JSON.parse(row.symbolIds)
				} catch {
					continue
				}
				if (!Array.isArray(ids)) continue
				let changed = false
				const next = ids.map((raw) => {
					if (typeof raw !== 'string') return raw
					const mapped = mapping.get(raw)
					if (mapped) {
						changed = true
						return mapped
					}
					return raw
				})
				if (changed) updateFlowBlob.run(JSON.stringify(next), row.id)
			}

			// duplicates has UNIQUE(symbol_a_id, symbol_b_id). collision
			// semantics: drop the conflicting destination row first, then
			// rewrite. same reasoning as the aux tables above.
			const delDupA = this.db.prepare(
				'DELETE FROM duplicates WHERE symbol_a_id = ?',
			)
			const delDupB = this.db.prepare(
				'DELETE FROM duplicates WHERE symbol_b_id = ?',
			)
			const updDupA = this.db.prepare(
				'UPDATE duplicates SET symbol_a_id = ? WHERE symbol_a_id = ?',
			)
			const updDupB = this.db.prepare(
				'UPDATE duplicates SET symbol_b_id = ? WHERE symbol_b_id = ?',
			)
			for (const [oldId, newId] of updates) {
				delDupA.run(newId)
				delDupB.run(newId)
				updDupA.run(newId, oldId)
				updDupB.run(newId, oldId)
			}

			const updateXSrc = this.db.prepare(
				'UPDATE cross_project_edges SET source_stable_id = ? WHERE source_stable_id = ?',
			)
			const updateXTgt = this.db.prepare(
				'UPDATE cross_project_edges SET target_stable_id = ? WHERE target_stable_id = ?',
			)
			for (const [oldId, newId] of updates) {
				updateXSrc.run(newId, oldId)
				updateXTgt.run(newId, oldId)
			}

			this.db.run('UPDATE files SET path = ? WHERE path = ?', [newPath, oldPath])
		})
		tx()

		return mapping.size
	}

	insertFile(
		path: string,
		contentHash: string,
		language: string,
		sizeBytes: number,
		isTest = false,
	): number {
		const now = Date.now()
		const result = this.db.run(
			'INSERT OR REPLACE INTO files (path, content_hash, language, indexed_at, size_bytes, is_test) VALUES (?, ?, ?, ?, ?, ?)',
			[path, contentHash, language, now, sizeBytes, isTest ? 1 : 0],
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

	// --- cross-project edges ---

	insertCrossProjectEdge(edge: {
		sourceProject: string
		sourceStableId: string
		targetProject: string
		targetStableId: string
		kind: string
		confidence?: string
	}) {
		this.db.run(
			'INSERT OR IGNORE INTO cross_project_edges (source_project, source_stable_id, target_project, target_stable_id, kind, confidence) VALUES (?, ?, ?, ?, ?, ?)',
			[edge.sourceProject, edge.sourceStableId, edge.targetProject, edge.targetStableId, edge.kind, edge.confidence ?? 'heuristic'],
		)
	}

	getCrossProjectEdgesFrom(project: string, stableId: string): CrossProjectEdgeRow[] {
		return this.queryCrossProjectEdges('source', project, stableId)
	}

	getCrossProjectEdgesTo(project: string, stableId: string): CrossProjectEdgeRow[] {
		return this.queryCrossProjectEdges('target', project, stableId)
	}

	private queryCrossProjectEdges(
		field: 'source' | 'target',
		project: string,
		stableId: string,
	): CrossProjectEdgeRow[] {
		const projectCol = `${field}_project`
		const stableIdCol = `${field}_stable_id`
		return this.db
			.query(
				`SELECT source_project as sourceProject, source_stable_id as sourceStableId,
				target_project as targetProject, target_stable_id as targetStableId, kind
				FROM cross_project_edges WHERE ${projectCol} = ? AND ${stableIdCol} = ?`,
			)
			.all(project, stableId) as CrossProjectEdgeRow[]
	}

	deleteCrossProjectEdgesForProject(project: string) {
		this.db.run('DELETE FROM cross_project_edges WHERE source_project = ? OR target_project = ?', [project, project])
	}

	// reconcile files.is_test against the current testPatterns from the
	// caller's perspective. used by the indexer at the start of each run so
	// that schema migrations (v11 added is_test defaulted to 0) and
	// testPatterns config changes both get reflected without requiring a
	// full re-index. only writes rows whose flag actually changes.
	syncFileIsTest(updates: { path: string; isTest: boolean }[]) {
		if (updates.length === 0) return
		const stmt = this.db.prepare(
			'UPDATE files SET is_test = ? WHERE path = ? AND is_test != ?',
		)
		this.bulkInsert(() => {
			for (const u of updates) {
				const value = u.isTest ? 1 : 0
				stmt.run(value, u.path, value)
			}
		})
	}

	// --- test links (test ↔ source mapping) ---

	// returns one row per (test file, exported source symbol) where the
	// test file transitively imports the source symbol's containing file via
	// the `imports` graph. used by step 6.5 to populate the 'imported'
	// confidence rows in a single query.
	//
	// the walk is a recursive CTE keyed on `(test_id, file_id)` — NOT on
	// `(test_id, file_id, depth)` — so cycle dedupe happens on the real
	// identity. keeping `depth` in the tuple would make the same
	// (test, file) pair visible at depths 1 and 2 look like distinct rows to
	// `UNION`, defeating cycle termination. sqlite terminates the recursion
	// when no new `(test, file)` pair appears on an iteration.
	//
	// the transitive walk matters because tests often reach their
	// under-test subject through a helper file (e.g. `createTempStore` in
	// tests/helpers/tmp-store.ts → src/core/storage/store.ts), so a
	// one-hop imports join misses symbols the test exercises end-to-end.
	// covers #23.
	getTestImportedSymbolPairs(): { testFileId: number; symbolStableId: string }[] {
		return this.db
			.query<{ testFileId: number; symbolStableId: string }, []>(
				`WITH RECURSIVE reach(test_id, file_id) AS (
					SELECT i.source_file_id, i.target_file_id
					FROM imports i
					JOIN files tf ON tf.id = i.source_file_id
					WHERE tf.is_test = 1 AND i.target_file_id IS NOT NULL
				  UNION
					SELECT r.test_id, i2.target_file_id
					FROM reach r
					JOIN imports i2 ON i2.source_file_id = r.file_id
					WHERE i2.target_file_id IS NOT NULL
				)
				SELECT DISTINCT r.test_id as testFileId, s.stable_id as symbolStableId
				FROM reach r
				JOIN files f ON f.id = r.file_id
				JOIN symbols s ON s.file_id = f.id
				WHERE f.is_test = 0 AND s.is_exported = 1`,
			)
			.all()
	}

	// returns one row per (test file, source symbol) where a calls edge
	// originates from a symbol in the test file and points at a symbol in
	// a non-test file. used by step 6.5 to populate the 'called' confidence
	// rows in a single query.
	getTestCalledSymbolPairs(): { testFileId: number; symbolStableId: string }[] {
		return this.db
			.query<{ testFileId: number; symbolStableId: string }, []>(
				`SELECT DISTINCT src.file_id as testFileId, tgt.stable_id as symbolStableId
				 FROM edges e
				 JOIN symbols src ON src.stable_id = e.source_id
				 JOIN symbols tgt ON tgt.stable_id = e.target_id
				 JOIN files srcf ON srcf.id = src.file_id
				 JOIN files tgtf ON tgtf.id = tgt.file_id
				 WHERE e.kind = 'calls'
				 AND srcf.is_test = 1
				 AND tgtf.is_test = 0`,
			)
			.all()
	}

	insertTestLinks(rows: { testFileId: number; symbolStableId: string; confidence: 'imported' | 'called' }[]) {
		if (rows.length === 0) return
		const stmt = this.db.prepare(
			'INSERT OR REPLACE INTO test_links (test_file_id, source_symbol_stable_id, confidence) VALUES (?, ?, ?)',
		)
		this.bulkInsert(() => {
			for (const row of rows) {
				stmt.run(row.testFileId, row.symbolStableId, row.confidence)
			}
		})
	}

	clearAllTestLinks() {
		this.db.run('DELETE FROM test_links')
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
