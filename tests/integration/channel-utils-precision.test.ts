import { describe, expect, test } from 'bun:test'
import {
	getEnclosingLiteralContent,
	shouldKeepIdentifier,
} from '../../src/core/queries/channel-utils.js'
import '../helpers/setup.js'

// covers the #30 precursor channel-utils precision fix. before the
// shared helper, sql-linker matched table names in prose strings like
// `'from and to project IDs required'` and surfaced groups like
// `and`, `the`, `sqlite_master` in `atlas channels list --kind
// sql_table` on atlas itself. these tests pin the rules so future
// channel linkers (queue, env, graphql, openapi) can compose the
// same guards without reinventing them.

describe('shouldKeepIdentifier', () => {
	test('rejects english stopwords', () => {
		expect(shouldKeepIdentifier('and')).toBe(false)
		expect(shouldKeepIdentifier('the')).toBe(false)
		expect(shouldKeepIdentifier('with')).toBe(false)
		expect(shouldKeepIdentifier('THIS')).toBe(false)
	})

	test('rejects sql reserved words', () => {
		expect(shouldKeepIdentifier('select')).toBe(false)
		expect(shouldKeepIdentifier('UPDATE')).toBe(false)
		expect(shouldKeepIdentifier('null')).toBe(false)
	})

	test('rejects sqlite internal tables', () => {
		expect(shouldKeepIdentifier('sqlite_master')).toBe(false)
		expect(shouldKeepIdentifier('SQLITE_SEQUENCE')).toBe(false)
	})

	test('rejects identifiers shorter than 3 chars', () => {
		expect(shouldKeepIdentifier('a')).toBe(false)
		expect(shouldKeepIdentifier('id')).toBe(false)
		expect(shouldKeepIdentifier('  ')).toBe(false)
	})

	test('rejects pure numeric identifiers', () => {
		expect(shouldKeepIdentifier('123')).toBe(false)
		expect(shouldKeepIdentifier('42')).toBe(false)
	})

	test('accepts plausible table / topic / env names', () => {
		expect(shouldKeepIdentifier('users')).toBe(true)
		expect(shouldKeepIdentifier('order_items')).toBe(true)
		expect(shouldKeepIdentifier('STRIPE_KEY')).toBe(true)
		expect(shouldKeepIdentifier('user_v2')).toBe(true)
	})

	test('respects channel-specific extras', () => {
		const extras = new Set(['event', 'message'])
		expect(shouldKeepIdentifier('event', { extras })).toBe(false)
		expect(shouldKeepIdentifier('user.created', { extras })).toBe(true)
	})

	test('respects custom min length', () => {
		expect(shouldKeepIdentifier('ab', { minLength: 2 })).toBe(true)
		expect(shouldKeepIdentifier('a', { minLength: 2 })).toBe(false)
	})
})

describe('getEnclosingLiteralContent', () => {
	test('returns the literal contents inside single quotes', () => {
		const src = `const q = 'SELECT * FROM users WHERE id = 1'`
		const content = getEnclosingLiteralContent(src, src.indexOf('users'))
		expect(content).toBe('SELECT * FROM users WHERE id = 1')
	})

	test('returns the literal contents inside double quotes', () => {
		const src = `const q = "SELECT * FROM users"`
		const content = getEnclosingLiteralContent(src, src.indexOf('users'))
		expect(content).toBe('SELECT * FROM users')
	})

	test('returns null for prose outside a string literal', () => {
		const src = `// FROM users`
		const content = getEnclosingLiteralContent(src, src.indexOf('users'))
		expect(content).toBeNull()
	})
})
