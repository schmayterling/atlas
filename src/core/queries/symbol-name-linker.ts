import type { AtlasStore } from '../storage/store.js'

// matches exported symbols across two project dbs by (name, kind) and
// writes a heuristic cross_project_edges row in BOTH dbs so federation
// fan-out works symmetrically. gated behind an explicit cli flag in
// `atlas projects build-edges --match-by-name` because name collisions
// are real in monorepos (think `authenticate`, `Validate`, `Run`); we
// do not auto-run this on every index. see #8b.
//
// the `kind` filter in listExportedSymbolsForLinking already excludes
// noisy categories (parameters, local variables). we further restrict
// to non-test files at the sql layer. the resulting heuristic edge
// always carries `confidence: 'heuristic'` so downstream queries can
// distinguish it from an api-route resolved edge.
export function buildCrossProjectEdgesBySymbolName(
	localStore: AtlasStore,
	localProjectId: string,
	remoteStore: AtlasStore,
	remoteProjectId: string,
): number {
	const localSymbols = localStore.listExportedSymbolsForLinking()
	const remoteSymbols = remoteStore.listExportedSymbolsForLinking()
	if (localSymbols.length === 0 || remoteSymbols.length === 0) return 0

	// index the remote side by (name|kind) so the local pass is linear
	// in localSymbols.length, not quadratic in symbol count. real-world
	// projects can have 50k+ exported symbols on each side and the
	// quadratic version would block the cli for tens of seconds.
	const remoteByKey = new Map<string, Array<{ stableId: string }>>()
	for (const r of remoteSymbols) {
		const key = `${r.name}|${r.kind}`
		const list = remoteByKey.get(key)
		if (list) list.push({ stableId: r.stableId })
		else remoteByKey.set(key, [{ stableId: r.stableId }])
	}

	let count = 0
	for (const local of localSymbols) {
		const matches = remoteByKey.get(`${local.name}|${local.kind}`)
		if (!matches) continue
		for (const match of matches) {
			const edge = {
				sourceProject: localProjectId,
				sourceStableId: local.stableId,
				targetProject: remoteProjectId,
				targetStableId: match.stableId,
				kind: 'name_match',
				confidence: 'heuristic',
			}
			localStore.insertCrossProjectEdge(edge)
			remoteStore.insertCrossProjectEdge(edge)
			count++
		}
	}

	return count
}
