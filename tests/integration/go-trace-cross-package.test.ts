import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #45: atlas trace returns 0 paths on go cross-package
// queries on prod. deps finds the same symbols so edges exist —
// trace is just not walking them. reproduces a three-file call
// chain so the failing mode can be debugged on a minimal fixture:
// cmd/main.go -> pkg/handler.go -> pkg/db.go.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-go-trace-'))
	mkdirSync(join(projectRoot, 'cmd'), { recursive: true })
	mkdirSync(join(projectRoot, 'handler'), { recursive: true })
	mkdirSync(join(projectRoot, 'db'), { recursive: true })
	writeFileSync(join(projectRoot, 'go.mod'), 'module example.com/trace\n\ngo 1.21\n')

	writeFileSync(
		join(projectRoot, 'db/db.go'),
		`package db

func Connect() string {
	return "connected"
}
`,
	)

	writeFileSync(
		join(projectRoot, 'handler/handler.go'),
		`package handler

import "example.com/trace/db"

func New() string {
	return db.Connect()
}
`,
	)

	writeFileSync(
		join(projectRoot, 'cmd/main.go'),
		`package main

import "example.com/trace/handler"

func main() {
	_ = handler.New()
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

describe('go cross-package trace', () => {
	test('trace New -> Connect finds a path', () => {
		const result = engine.trace('New', 'Connect')
		expect(result).not.toBeNull()
		expect(result?.stats.totalPaths ?? 0).toBeGreaterThan(0)
	})

	test('resolved cross-file calls edge from handler.New to db.Connect exists', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'calls'
			 AND e.confidence = 'resolved'
			 AND src.name = 'New'
			 AND tgt.name = 'Connect'`,
		)
		expect(rows[0]?.count ?? 0).toBeGreaterThan(0)
	})
})
