const SYMBOL_KINDS = [
	'function',
	'class',
	'method',
	'interface',
	'type',
	'variable',
	'module',
	'enum',
	'property',
] as const
export type SymbolKind = (typeof SYMBOL_KINDS)[number]

// phase 1 edge kinds (5 core types)
export const EDGE_KINDS = ['imports', 'calls', 'contains', 'extends', 'type_ref'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

// confidence levels for edge resolution
const CONFIDENCE_LEVELS = ['resolved', 'heuristic', 'unresolved'] as const
export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

// reference kinds: how a symbol is used at a site
const REFERENCE_KINDS = ['declaration', 'usage', 'type_usage', 'import'] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

// visibility levels
const VISIBILITY_LEVELS = ['public', 'private', 'protected', 'export'] as const
export type Visibility = (typeof VISIBILITY_LEVELS)[number]

// file record
export interface FileRecord {
	id: number
	path: string
	contentHash: string
	language: string
	indexedAt: number
	sizeBytes: number
}

// symbol record
export interface SymbolRecord {
	id: number
	stableId: string
	fileId: number
	name: string
	qualifiedName: string
	kind: SymbolKind
	visibility: Visibility | null
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
}

// edge record
export interface EdgeRecord {
	id: number
	sourceId: string
	targetId: string
	kind: EdgeKind
	fileId: number
	line: number | null
	col: number | null
	confidence: Confidence
	metadata: string | null
}

// reference record
export interface ReferenceRecord {
	id: number
	symbolId: string
	fileId: number
	line: number
	col: number
	byteOffset: number
	kind: ReferenceKind
}

// import record
export interface ImportRecord {
	id: number
	sourceFileId: number
	targetFileId: number | null
	importPath: string
	isTypeOnly: boolean
	line: number
}

// query result types
export interface SymbolResult {
	name: string
	qualifiedName: string
	kind: SymbolKind
	signature: string | null
	filePath: string
	lineStart: number
	lineEnd: number
	isExported: boolean
	docComment: string | null
	usageCount: number
	dependentCount: number
}

export interface DependencyNode {
	symbol: SymbolResult
	edgeKind: EdgeKind
	confidence: Confidence
	depth: number
	children: DependencyNode[]
}

export interface BlastRadiusResult {
	target: SymbolResult
	direct: AffectedItem[]
	transitive: AffectedItem[]
	affectedTests: { file: string; testCount: number }[]
	summary: {
		totalSymbols: number
		totalFiles: number
		totalTestFiles: number
		maxDepthReached: number
	}
	truncated: boolean
	truncationReason?: string
}

export interface AffectedItem {
	symbol: SymbolResult
	relationship: EdgeKind
	depth: number
}

export interface DependencyResult {
	symbol: SymbolResult
	upstream: DependencyNode[]
	downstream: DependencyNode[]
	stats: {
		totalNodes: number
		totalEdges: number
		maxDepthReached: number
	}
	truncated: boolean
	truncationReason?: string
}

export interface SearchResult {
	query: string
	total: number
	results: SymbolResult[]
}

export interface IndexResult {
	filesTotal: number
	filesAdded: number
	filesModified: number
	filesDeleted: number
	filesCached: number
	symbols: number
	edges: number
	references: number
	duration: number
	warnings: string[]
}

export interface StatusResult {
	projectRoot: string
	dbPath: string
	dbSizeBytes: number
	lastIndexedAt: number | null
	lastCommit: string | null
	lastBranch: string | null
	health: 'good' | 'stale' | 'outdated' | 'missing'
	staleFileCount: number
	stats: {
		files: number
		symbols: number
		edges: number
		references: number
	}
	languages: Record<string, number>
}

// subgraph budget for loadSubgraph
export interface SubgraphBudget {
	maxDepth: number
	maxNodes: number
	maxEdges: number
	edgeKinds: EdgeKind[]
	timeoutMs: number
}

// flow tracing
export interface FlowTraceResult {
	source: SymbolResult
	target: SymbolResult
	paths: FlowPath[]
	stats: {
		totalPaths: number
		maxLength: number
		truncated: boolean
	}
}

export interface FlowPath {
	nodes: SymbolResult[]
	edges: { from: string; to: string; kind: EdgeKind; line: number | null }[]
	length: number
}

// dead code detection
export interface DeadCodeResult {
	symbols: SymbolResult[]
	stats: {
		total: number
		byKind: Record<string, number>
		byFile: Record<string, number>
	}
}

// semantic search
export interface SemanticSearchResult {
	query: string
	results: (SymbolResult & { distance: number })[]
	embeddingsAvailable: boolean
}

// detected flows (LLM-generated from indexer step 9)
export interface DetectedFlow {
	id: number
	name: string
	description: string | null
	rootSymbol: SymbolResult | null
	symbols: SymbolResult[]
	generatedAt: number
}

// duplicate code pairs (embedding similarity)
export interface DuplicatePair {
	symbolA: SymbolResult
	symbolB: SymbolResult
	similarity: number
	confirmed: boolean
	description: string | null
}

export interface SubsystemSummary {
	id: string
	name: string
	description: string | null
	fileCount: number
	conductance: number
}

export interface SubsystemDetail {
	id: string
	name: string
	description: string | null
	conductance: number
	generatedAt: number
	files: { id: number; path: string; language: string | null }[]
	topSymbols: { name: string; kind: string; filePath: string }[]
}

// file info for web UI
export interface FileInfo {
	path: string
	language: string
	symbolCount: number
	sizeBytes: number
	indexedAt: number
}

// symbol detail for web UI
export interface SymbolDetail {
	symbol: SymbolResult
	summary?: string
	upstream: DependencyNode[]
	downstream: DependencyNode[]
	sourceCode?: string
}
