import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import type { AtlasEngine } from '../../src/core/engine.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'

// covers #65: multi-module monorepo with per-service vendor dirs. when
// services/a and services/b each vendor a different version of the
// same package, resolveImportPath must pick the copy from the nearest
// enclosing go module (matching go's toolchain behaviour) rather than
// iterating over goModules and returning the first match.

let root: string
let engine: AtlasEngine

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'atlas-go-multi-vendor-'))

	// module A vendors widget with type tag "A"
	mkdirSync(join(root, 'services', 'a', 'vendor', 'example.com', 'widget'), { recursive: true })
	writeFileSync(
		join(root, 'services', 'a', 'go.mod'),
		`module example.com/a

go 1.22

require example.com/widget v1.0.0
`,
	)
	writeFileSync(
		join(root, 'services', 'a', 'vendor', 'example.com', 'widget', 'widget.go'),
		`package widget

type Widget struct{ Tag string }

func New() *Widget { return &Widget{Tag: "A"} }
`,
	)
	writeFileSync(
		join(root, 'services', 'a', 'main.go'),
		`package main

import "example.com/widget"

func main() {
	_ = widget.New()
}
`,
	)

	// module B vendors widget with type tag "B" - different source, same import path
	mkdirSync(join(root, 'services', 'b', 'vendor', 'example.com', 'widget'), { recursive: true })
	writeFileSync(
		join(root, 'services', 'b', 'go.mod'),
		`module example.com/b

go 1.22

require example.com/widget v2.0.0
`,
	)
	writeFileSync(
		join(root, 'services', 'b', 'vendor', 'example.com', 'widget', 'widget.go'),
		`package widget

type Widget struct{ Tag string }

func New() *Widget { return &Widget{Tag: "B"} }
`,
	)
	writeFileSync(
		join(root, 'services', 'b', 'main.go'),
		`package main

import "example.com/widget"

func main() {
	_ = widget.New()
}
`,
	)

	const project = addProject(root)
	engine = getOrCreateEngine(project.id, root)
	await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false })
})

afterAll(() => {
	closeAll()
	rmSync(root, { recursive: true, force: true })
})

describe('go resolver multi-module vendor (#65)', () => {
	test('services/b/main.go resolves widget through services/b/vendor', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ source_path: string; target_path: string | null }>(
			`SELECT sf.path AS source_path, tf.path AS target_path
			 FROM imports i
			 JOIN files sf ON sf.id = i.source_file_id
			 LEFT JOIN files tf ON tf.id = i.target_file_id
			 WHERE i.import_path = 'example.com/widget'`,
		)
		const bRow = rows.find((r) => r.source_path === 'services/b/main.go')
		expect(bRow).toBeDefined()
		expect(bRow!.target_path).toBe('services/b/vendor/example.com/widget/widget.go')
	})

	test('services/a/main.go resolves widget through services/a/vendor', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ source_path: string; target_path: string | null }>(
			`SELECT sf.path AS source_path, tf.path AS target_path
			 FROM imports i
			 JOIN files sf ON sf.id = i.source_file_id
			 LEFT JOIN files tf ON tf.id = i.target_file_id
			 WHERE i.import_path = 'example.com/widget'`,
		)
		const aRow = rows.find((r) => r.source_path === 'services/a/main.go')
		expect(aRow).toBeDefined()
		expect(aRow!.target_path).toBe('services/a/vendor/example.com/widget/widget.go')
	})
})
