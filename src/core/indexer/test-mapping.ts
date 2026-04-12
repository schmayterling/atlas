import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// step 6.5 of the indexer pipeline. populates the test_links table by
// joining each test file's resolved imports (and outgoing calls edges) to
// the source symbols they reference.
//
// pass 1 ('imported'): for each test file, mark every exported symbol of
// every imported file as 'imported'. broad signal: it just means a test
// imported the module, not that the test exercises any specific symbol.
// barrel re-exports inflate this set, so 'imported' coverage is treated
// as a weak signal by downstream queries (untestedSymbols and hotFragile
// only count 'called' coverage).
//
// pass 2 ('called'): for each calls edge whose source symbol lives in a
// test file and target symbol lives in a non-test file, INSERT OR REPLACE
// the row with confidence 'called'. the composite PK collides on
// (test_file_id, source_symbol_stable_id) and 'called' wins.
//
// load-bearing invariant: pass 2 reads `edges` rows produced by step 6
// (cross-file resolution). that step uses store.findSymbolInFile (the
// stmtFindSymbolInFile/Kind prepared statements). those statements MUST NOT
// filter by files.is_test, otherwise pass 2 produces zero rows.
//
// the entire pipeline runs inside a single bulkInsert transaction so a
// failure mid-rebuild rolls back to the prior committed state instead of
// leaving test_links half-populated.
export function runTestMapping(store: AtlasStore): { testFiles: number; imported: number; called: number } {
	const testFileCount = store.queryRaw<{ count: number }>(
		'SELECT COUNT(*) as count FROM files WHERE is_test = 1',
	)[0]?.count ?? 0

	let importedCount = 0
	let calledCount = 0

	store.bulkInsert(() => {
		// always clear inside the transaction, even with zero test files:
		// a user reclassifying tests as production must not see stale rows.
		store.clearAllTestLinks()

		if (testFileCount === 0) return

		const importedPairs = store.getTestImportedSymbolPairs()
		store.insertTestLinks(
			importedPairs.map((p) => ({
				testFileId: p.testFileId,
				symbolStableId: p.symbolStableId,
				confidence: 'imported' as const,
			})),
		)
		importedCount = importedPairs.length

		const calledPairs = store.getTestCalledSymbolPairs()
		store.insertTestLinks(
			calledPairs.map((p) => ({
				testFileId: p.testFileId,
				symbolStableId: p.symbolStableId,
				confidence: 'called' as const,
			})),
		)
		calledCount = calledPairs.length
	})

	if (testFileCount === 0) {
		log.info('test-mapping: no test files; skipped')
	} else {
		if (importedCount > 0 && calledCount === 0) {
			// most diagnostic-worthy state: imports resolved but no call edges
			// crossed file boundaries from any test file. usually means
			// cross-file resolution (step 6) didn't run, or the
			// stmtFindSymbolInFile invariant was accidentally filtered.
			log.warn(
				'test-mapping: imported rows exist but zero called edges resolved. coverage will be import-only. check that step 6 cross-file resolution ran successfully.',
			)
		}
		log.info(
			`test-mapping: ${testFileCount} test files, ${importedCount} imported, ${calledCount} called`,
		)
	}

	return { testFiles: testFileCount, imported: importedCount, called: calledCount }
}
