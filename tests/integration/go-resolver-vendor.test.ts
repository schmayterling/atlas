import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #29: vendor-only external go resolver. drops a tiny vendored
// dependency under ./vendor/example.com/widget/ and asserts the
// go-resolver resolves cross-file edges into vendor symbols. external
// module-cache resolution is intentionally out of scope (see go-
// resolver.ts:resolveImportPath comment header).

let root: string
let engine: AtlasEngine

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'atlas-go-vendor-'))

	writeFileSync(
		join(root, 'go.mod'),
		`module example.com/host

go 1.22

require example.com/widget v1.0.0
`,
	)

	mkdirSync(join(root, 'vendor', 'example.com', 'widget'), { recursive: true })
	writeFileSync(
		join(root, 'vendor', 'example.com', 'widget', 'widget.go'),
		`package widget

type Greeter struct{}

func New() *Greeter {
	return &Greeter{}
}

func (g *Greeter) Hello(name string) string {
	return "hello " + name
}
`,
	)

	writeFileSync(
		join(root, 'main.go'),
		`package main

import (
	"fmt"

	"example.com/widget"
)

func main() {
	g := widget.New()
	fmt.Println(g.Hello("world"))
}
`,
	)

	engine = new AtlasEngine(root)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterAll(() => {
	engine.close()
	rmSync(root, { recursive: true, force: true })
})

describe('go vendor resolution (#29)', () => {
	test('imports table resolves the vendored package to a target file', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			source_file_id: number
			target_file_id: number | null
			import_path: string
		}>(
			`SELECT source_file_id, target_file_id, import_path FROM imports`,
		)
		const widgetImport = rows.find((r) => r.import_path === 'example.com/widget')
		expect(widgetImport).toBeDefined()
		// target_file_id was null for external imports before #29; vendor
		// resolution makes it non-null.
		expect(widgetImport!.target_file_id).not.toBeNull()
	})

	test('cross-package call edges resolve into vendored symbols', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ kind: string; confidence: string }>(
			`SELECT e.kind, e.confidence FROM edges e
			 JOIN symbols src ON e.source_id = src.stable_id
			 JOIN symbols tgt ON e.target_id = tgt.stable_id
			 WHERE tgt.name = 'New' OR tgt.name = 'Hello'`,
		)
		expect(rows.length).toBeGreaterThan(0)
		// at least one edge must be 'resolved' against the vendored sym
		const resolved = rows.filter((r) => r.confidence === 'resolved')
		expect(resolved.length).toBeGreaterThan(0)
	})
})
