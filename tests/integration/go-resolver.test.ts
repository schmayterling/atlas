import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #3: the go cross-file resolver MVP. exercises the happy path
// (cross-package call resolves to confidence=resolved) and the two
// explicit out-of-scope cases (receiver-method calls on typed
// variables; external/stdlib imports) which must stay heuristic and
// never surface a bogus `resolved` edge.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-go-resolver-'))
	mkdirSync(join(projectRoot, 'pkg'), { recursive: true })
	mkdirSync(join(projectRoot, 'cmd'), { recursive: true })

	writeFileSync(
		join(projectRoot, 'go.mod'),
		'module example.com/demo\n\ngo 1.21\n',
	)

	// pkg/foo.go: package name == directory name, which is the
	// dominant go convention. the resolver uses the last path
	// component of the import path as the local binding when no
	// explicit alias is present, so this fixture lines up with the
	// MVP scope. the unconventional "directory != package" case
	// would need a package-clause lookup in the target file, which
	// the resolver does not do today.
	writeFileSync(
		join(projectRoot, 'pkg/foo.go'),
		`package pkg

type Widget struct {
	Name string
}

func Foo() int {
	return 42
}
`,
	)

	// cmd/main.go imports the package and exercises:
	//  - a resolvable package-qualified call (`pkg.Foo()`)
	//  - a resolvable package-qualified type ref (`pkg.Widget`)
	//  - an external-package call (`fmt.Println`) which must stay heuristic
	//  - a receiver-method call (`w.Name`) out of scope for the MVP
	writeFileSync(
		join(projectRoot, 'cmd/main.go'),
		`package main

import (
	"fmt"

	"example.com/demo/pkg"
)

func describe(w pkg.Widget) string {
	return w.Name
}

func run() {
	fmt.Println("hello")
	n := pkg.Foo()
	fmt.Println(n)
}
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false, withCoChange: false })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('go-resolver MVP', () => {
	test('resolves a cross-package function call with confidence=resolved', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			count: number
		}>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 JOIN files tgtf ON tgtf.id = tgt.file_id
			 WHERE e.kind = 'calls'
			 AND e.confidence = 'resolved'
			 AND e.file_id IS NULL
			 AND tgt.name = 'Foo'
			 AND tgtf.path = 'pkg/foo.go'`,
		)
		expect(rows[0]?.count ?? 0).toBeGreaterThan(0)
	})

	test('resolves a cross-package type reference with confidence=resolved', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			count: number
		}>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 JOIN files tgtf ON tgtf.id = tgt.file_id
			 WHERE e.kind = 'type_ref'
			 AND e.confidence = 'resolved'
			 AND e.file_id IS NULL
			 AND tgt.name = 'Widget'
			 AND tgtf.path = 'pkg/foo.go'`,
		)
		expect(rows[0]?.count ?? 0).toBeGreaterThan(0)
	})

	test('leaves stdlib external calls (fmt.Println) heuristic', () => {
		const store = engine.getStoreForCrossProject()
		// no `resolved` cross-file edge should point at a non-existent
		// Println symbol: the stdlib is not indexed, so there is no
		// target file for the go-resolver to bind to.
		const rows = store.queryRaw<{
			count: number
		}>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'calls'
			 AND e.confidence = 'resolved'
			 AND tgt.name = 'Println'`,
		)
		expect(rows[0]?.count ?? 0).toBe(0)
	})

	test('upgrades the null-target imports row to a resolved target_file_id', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			targetFileId: number | null
			importPath: string
		}>(
			`SELECT i.target_file_id as targetFileId, i.import_path as importPath
			 FROM imports i
			 JOIN files f ON f.id = i.source_file_id
			 WHERE f.path = 'cmd/main.go'`,
		)
		const intraRepo = rows.find((r) => r.importPath === 'example.com/demo/pkg')
		expect(intraRepo).toBeDefined()
		expect(intraRepo?.targetFileId).not.toBeNull()
	})

	test('leaves external imports (fmt) with null target_file_id', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			targetFileId: number | null
			importPath: string
		}>(
			`SELECT i.target_file_id as targetFileId, i.import_path as importPath
			 FROM imports i
			 JOIN files f ON f.id = i.source_file_id
			 WHERE f.path = 'cmd/main.go' AND i.import_path = 'fmt'`,
		)
		expect(rows.length).toBeGreaterThanOrEqual(1)
		expect(rows[0]?.targetFileId).toBeNull()
	})
})
