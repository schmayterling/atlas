import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #50: go interface dispatch edges. a concrete struct method
// that satisfies an interface method in the same file used to show
// up as dead code because nothing directly called it. the extractor
// now emits a dispatches_to edge from the interface method to every
// concrete method whose (name, param count, return count) matches.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-go-dispatch-'))
	mkdirSync(join(projectRoot, 'pkg'), { recursive: true })
	writeFileSync(join(projectRoot, 'go.mod'), 'module example.com/dispatch\n\ngo 1.21\n')

	writeFileSync(
		join(projectRoot, 'pkg/storage.go'),
		`package storage

type Database interface {
	Query(id string) string
	Close() error
}

type Postgres struct {
	dsn string
}

func (p *Postgres) Query(id string) string {
	return "row:" + id + " from " + p.dsn
}

func (p *Postgres) Close() error {
	return nil
}

// a method that does NOT satisfy any interface — should not get
// a dispatches_to edge.
func (p *Postgres) Unrelated() int {
	return 42
}
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('go interface dispatch', () => {
	test('emits dispatches_to edges from interface methods to concrete methods by signature', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			sourceName: string
			targetName: string
		}>(
			`SELECT src.name as sourceName, tgt.name as targetName
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'dispatches_to'
			 ORDER BY tgt.name`,
		)
		const pairs = rows.map((r) => `${r.sourceName}->${r.targetName}`)
		expect(pairs).toContain('Close->Close')
		expect(pairs).toContain('Query->Query')
	})

	test('does not emit dispatch edges for unrelated methods', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'dispatches_to'
			 AND tgt.name = 'Unrelated'`,
		)
		expect(rows[0]?.count ?? 0).toBe(0)
	})

	test('concrete methods satisfying an interface are NOT reported dead', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		// Query and Close are methods on Postgres (an exported class)
		// AND they have dispatches_to edges from Database's interface
		// methods. neither is dead under reachability.
		expect(names).not.toContain('Query')
		expect(names).not.toContain('Close')
	})
})
