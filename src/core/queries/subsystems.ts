import type { SubsystemDetail, SubsystemSummary } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

interface SubsystemRow {
	id: string
	name: string
	description: string | null
	memberFileIds: string
	conductance: number
}

interface SubsystemRowWithGenerated extends SubsystemRow {
	generatedAt: number
}

function rowToSummary(row: SubsystemRow): SubsystemSummary {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		fileCount: (JSON.parse(row.memberFileIds) as number[]).length,
		conductance: row.conductance,
	}
}

export function listSubsystems(store: AtlasStore): SubsystemSummary[] {
	const rows = store.queryRaw<SubsystemRow>(
		`SELECT id, name, description, member_file_ids as memberFileIds, conductance
		 FROM subsystems
		 ORDER BY conductance ASC`,
	)
	return rows.map(rowToSummary)
}

export function getSubsystem(store: AtlasStore, id: string): SubsystemDetail | null {
	const row = store.queryRawWithParams<SubsystemRowWithGenerated>(
		`SELECT id, name, description, member_file_ids as memberFileIds, conductance,
		        generated_at as generatedAt
		 FROM subsystems WHERE id = ?`,
		id,
	)[0]
	if (!row) return null
	const memberFileIds = JSON.parse(row.memberFileIds) as number[]
	if (memberFileIds.length === 0) {
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			conductance: row.conductance,
			generatedAt: row.generatedAt,
			files: [],
			topSymbols: [],
		}
	}
	const placeholders = memberFileIds.map(() => '?').join(',')
	const files = store.queryRawWithParams<{ id: number; path: string; language: string | null }>(
		`SELECT id, path, language FROM files WHERE id IN (${placeholders})`,
		...memberFileIds,
	)
	const topSymbols = store.queryRawWithParams<{
		name: string
		kind: string
		filePath: string
	}>(
		`SELECT s.name, s.kind, f.path as filePath
		 FROM symbols s JOIN files f ON f.id = s.file_id
		 WHERE s.file_id IN (${placeholders}) AND s.is_exported = 1
		 ORDER BY s.name LIMIT 20`,
		...memberFileIds,
	)

	// entry points: exported symbols inside this subsystem ranked by
	// inbound edges. excludes property/module noise. used by the web
	// article — cli/mcp consumers fall back to topSymbols.
	const topExports = store.queryRawWithParams<{
		name: string
		qualifiedName: string
		kind: string
		filePath: string
		dependentCount: number
	}>(
		`SELECT s.name, s.qualified_name as qualifiedName, s.kind, f.path as filePath,
		        (SELECT COUNT(DISTINCT e.source_id) FROM edges e WHERE e.target_id = s.stable_id AND e.kind != 'field_access') as dependentCount
		 FROM symbols s JOIN files f ON f.id = s.file_id
		 WHERE s.file_id IN (${placeholders}) AND s.is_exported = 1
		   AND s.kind IN ('function', 'class', 'interface', 'type', 'enum')
		 ORDER BY dependentCount DESC, s.name
		 LIMIT 8`,
		...memberFileIds,
	)

	// outbound cross-edges: imports from this subsystem's files into
	// files belonging to other subsystems, rolled up by destination
	// subsystem. surfaces architectural seams.
	const crossEdges = store.queryRawWithParams<{
		otherSubsystemId: string
		otherSubsystemName: string
		edgeCount: number
		fileCount: number
	}>(
		`SELECT s2.id as otherSubsystemId, s2.name as otherSubsystemName,
		        COUNT(*) as edgeCount, COUNT(DISTINCT i.target_file_id) as fileCount
		 FROM imports i
		 JOIN files tf ON tf.id = i.target_file_id
		 JOIN subsystems s2 ON s2.id = tf.subsystem_id
		 WHERE i.source_file_id IN (${placeholders}) AND s2.id != ?
		 GROUP BY s2.id, s2.name
		 ORDER BY edgeCount DESC
		 LIMIT 12`,
		...memberFileIds, id,
	)

	return {
		id: row.id,
		name: row.name,
		description: row.description,
		conductance: row.conductance,
		generatedAt: row.generatedAt,
		files,
		topSymbols,
		topExports,
		crossEdges,
	}
}

export function getSymbolSubsystem(
	store: AtlasStore,
	stableId: string,
): SubsystemSummary | null {
	const row = store.queryRawWithParams<SubsystemRow>(
		`SELECT s2.id, s2.name, s2.description, s2.member_file_ids as memberFileIds, s2.conductance
		 FROM symbols s
		 JOIN files f ON f.id = s.file_id
		 JOIN subsystems s2 ON s2.id = f.subsystem_id
		 WHERE s.stable_id = ?`,
		stableId,
	)[0]
	return row ? rowToSummary(row) : null
}
