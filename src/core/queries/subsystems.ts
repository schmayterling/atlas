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
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		conductance: row.conductance,
		generatedAt: row.generatedAt,
		files,
		topSymbols,
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
