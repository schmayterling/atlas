// all SQL DDL, indexes, triggers, and migrations for the atlas database.

export const SCHEMA_VERSION = 1

export const CREATE_TABLES = `
-- metadata key-value store
CREATE TABLE IF NOT EXISTS atlas_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- files: unit of incremental update
CREATE TABLE IF NOT EXISTS files (
	id           INTEGER PRIMARY KEY,
	path         TEXT NOT NULL UNIQUE,
	content_hash TEXT NOT NULL,
	language     TEXT,
	indexed_at   INTEGER NOT NULL,
	size_bytes   INTEGER NOT NULL DEFAULT 0
);

-- symbols: every named declaration
CREATE TABLE IF NOT EXISTS symbols (
	id             INTEGER PRIMARY KEY,
	stable_id      TEXT NOT NULL UNIQUE,
	file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	name           TEXT NOT NULL,
	qualified_name TEXT NOT NULL,
	kind           TEXT NOT NULL,
	visibility     TEXT,
	is_exported    INTEGER NOT NULL DEFAULT 0,
	line_start     INTEGER NOT NULL,
	line_end       INTEGER NOT NULL,
	col_start      INTEGER NOT NULL DEFAULT 0,
	col_end        INTEGER NOT NULL DEFAULT 0,
	byte_start     INTEGER NOT NULL DEFAULT 0,
	byte_end       INTEGER NOT NULL DEFAULT 0,
	parent_id      TEXT,
	signature      TEXT,
	doc_comment    TEXT,
	metadata       TEXT
);

-- edges: relationships between symbols (uses stable_id)
CREATE TABLE IF NOT EXISTS edges (
	id          INTEGER PRIMARY KEY,
	source_id   TEXT NOT NULL,
	target_id   TEXT NOT NULL,
	kind        TEXT NOT NULL,
	file_id     INTEGER REFERENCES files(id) ON DELETE CASCADE,
	line        INTEGER,
	col         INTEGER,
	confidence  TEXT NOT NULL DEFAULT 'resolved',
	metadata    TEXT
);

-- references: every usage site of a symbol
CREATE TABLE IF NOT EXISTS "references" (
	id          INTEGER PRIMARY KEY,
	symbol_id   TEXT NOT NULL,
	file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	line        INTEGER NOT NULL,
	col         INTEGER NOT NULL DEFAULT 0,
	byte_offset INTEGER NOT NULL DEFAULT 0,
	kind        TEXT NOT NULL
);

-- imports: module-level dependency tracking
CREATE TABLE IF NOT EXISTS imports (
	id             INTEGER PRIMARY KEY,
	source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
	import_path    TEXT NOT NULL,
	is_type_only   INTEGER NOT NULL DEFAULT 0,
	line           INTEGER
);
`

export const CREATE_INDEXES = `
-- files
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

-- symbols
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qual ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind, is_exported);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);

-- edges
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_id);

-- references
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON "references"(symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_file ON "references"(file_id);

-- imports
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_target ON imports(target_file_id);
`

export const CREATE_FTS = `
-- full-text search over symbol names and docs
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
	name,
	qualified_name,
	doc_comment,
	content='symbols',
	content_rowid='id',
	tokenize='porter unicode61'
);
`

export const CREATE_TRIGGERS = `
-- keep FTS synchronized with symbols table
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
	INSERT INTO symbols_fts(rowid, name, qualified_name, doc_comment)
	VALUES (new.id, new.name, new.qualified_name, new.doc_comment);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
	INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, doc_comment)
	VALUES ('delete', old.id, old.name, old.qualified_name, old.doc_comment);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
	INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, doc_comment)
	VALUES ('delete', old.id, old.name, old.qualified_name, old.doc_comment);
	INSERT INTO symbols_fts(rowid, name, qualified_name, doc_comment)
	VALUES (new.id, new.name, new.qualified_name, new.doc_comment);
END;
`

export const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
`

interface Migration {
	version: number
	description: string
	up: string
}

export const MIGRATIONS: Migration[] = [
	{
		version: 2,
		description: 'add symbol_embeddings for semantic search',
		up: `
			CREATE VIRTUAL TABLE IF NOT EXISTS symbol_embeddings USING vec0(
				embedding float[384]
			);
			CREATE TABLE IF NOT EXISTS embedding_meta (
				symbol_stable_id TEXT PRIMARY KEY,
				symbol_id INTEGER NOT NULL,
				embed_text TEXT NOT NULL,
				embed_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_embedding_meta_id ON embedding_meta(symbol_id);
		`,
	},
	{
		version: 3,
		description: 'add api_endpoints for cross-language API tracing',
		up: `
			CREATE TABLE IF NOT EXISTS api_endpoints (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_path TEXT NOT NULL,
				path_pattern TEXT NOT NULL,
				http_method TEXT,
				symbol_stable_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('client', 'server')),
				framework TEXT,
				line INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_api_path ON api_endpoints(path_pattern);
			CREATE INDEX IF NOT EXISTS idx_api_role ON api_endpoints(role);
		`,
	},
	{
		version: 4,
		description: 'add cross_project_edges for federated queries',
		up: `
			CREATE TABLE IF NOT EXISTS cross_project_edges (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_project TEXT NOT NULL,
				source_stable_id TEXT NOT NULL,
				target_project TEXT NOT NULL,
				target_stable_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				confidence TEXT NOT NULL DEFAULT 'heuristic',
				metadata TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_xedge_source ON cross_project_edges(source_project, source_stable_id);
			CREATE INDEX IF NOT EXISTS idx_xedge_target ON cross_project_edges(target_project, target_stable_id);
		`,
	},
	{
		version: 5,
		description: 'add flows and duplicates tables',
		up: `
			CREATE TABLE IF NOT EXISTS flows (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				description TEXT,
				root_stable_id TEXT NOT NULL,
				symbol_ids TEXT NOT NULL,
				model TEXT,
				generated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_flows_root ON flows(root_stable_id);
			CREATE TABLE IF NOT EXISTS duplicates (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				symbol_a_id TEXT NOT NULL,
				symbol_b_id TEXT NOT NULL,
				similarity REAL NOT NULL,
				confirmed INTEGER DEFAULT 0,
				description TEXT,
				UNIQUE(symbol_a_id, symbol_b_id)
			);
			CREATE INDEX IF NOT EXISTS idx_dup_a ON duplicates(symbol_a_id);
			CREATE INDEX IF NOT EXISTS idx_dup_b ON duplicates(symbol_b_id);
		`,
	},
	{
		version: 6,
		description: 'add symbol_summaries for LLM-generated explanations',
		up: `
			CREATE TABLE IF NOT EXISTS symbol_summaries (
				symbol_stable_id TEXT PRIMARY KEY,
				summary TEXT NOT NULL,
				model TEXT NOT NULL,
				generated_at INTEGER NOT NULL,
				source_hash TEXT NOT NULL
			);
		`,
	},
]
