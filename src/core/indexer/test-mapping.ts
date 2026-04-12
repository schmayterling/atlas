import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// step 6.5 of the indexer pipeline. populates the test_links table by
// joining each test file's resolved imports (and outgoing calls edges) to
// the source symbols they reference.
//
// pass 1 ('imported'): walk imports rows for the test file, fetch all
// exported symbols in the imported file, insert one (test_file_id, stable_id,
// 'imported') row per symbol.
//
// pass 2 ('called'): for each calls edge whose source symbol lives in the
// test file and target symbol lives in a different file, INSERT OR REPLACE
// the row with confidence 'called'. the composite PK collides on
// (test_file_id, source_symbol_stable_id) and 'called' wins.
//
// load-bearing invariant: pass 2 reads `edges` rows produced by step 6
// (cross-file resolution). that step uses store.findSymbolInFile (the
// stmtFindSymbolInFile/Kind prepared statements). those statements MUST NOT
// filter by files.is_test, otherwise pass 2 produces zero rows.
export function runTestMapping(store: AtlasStore): { testFiles: number; imported: number; called: number } {
	const testFiles = store.queryRaw<{ id: number; path: string }>(
		'SELECT id, path FROM files WHERE is_test = 1',
	)
	if (testFiles.length === 0) {
		return { testFiles: 0, imported: 0, called: 0 }
	}

	store.clearAllTestLinks()

	const importedRows: { testFileId: number; symbolStableId: string; confidence: 'imported' | 'called' }[] = []
	const calledRows: { testFileId: number; symbolStableId: string; confidence: 'imported' | 'called' }[] = []

	for (const tf of testFiles) {
		const imports = store.getImportsByFileId(tf.id)
		for (const imp of imports) {
			if (imp.targetFileId == null) continue
			const exported = store.queryRawWithParams<{ stableId: string }>(
				'SELECT stable_id as stableId FROM symbols WHERE file_id = ? AND is_exported = 1',
				imp.targetFileId,
			)
			for (const sym of exported) {
				importedRows.push({ testFileId: tf.id, symbolStableId: sym.stableId, confidence: 'imported' })
			}
		}

		// pass 2: calls edges from any symbol in this test file to a symbol
		// in any other file. edges.source_id and edges.target_id are TEXT
		// stable_ids, so we join symbols twice to filter by file_id.
		const calls = store.queryRawWithParams<{ targetStableId: string }>(
			`SELECT DISTINCT tgt.stable_id as targetStableId
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'calls' AND src.file_id = ? AND tgt.file_id != ?`,
			tf.id,
			tf.id,
		)
		for (const c of calls) {
			calledRows.push({ testFileId: tf.id, symbolStableId: c.targetStableId, confidence: 'called' })
		}
	}

	if (importedRows.length > 0) store.insertTestLinks(importedRows)
	// pass 2 second so 'called' overwrites 'imported' on PK collision
	if (calledRows.length > 0) store.insertTestLinks(calledRows)

	log.info(
		`test-mapping: ${testFiles.length} test files, ${importedRows.length} imported, ${calledRows.length} called`,
	)

	return { testFiles: testFiles.length, imported: importedRows.length, called: calledRows.length }
}
