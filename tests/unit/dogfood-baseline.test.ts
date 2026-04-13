import { describe, expect, test } from 'bun:test'
import { shouldWriteBaseline } from '../../scripts/dogfood.js'

// the dogfood runner used to write baseline.json unconditionally whenever the
// file was missing, which blessed failing regenerations as the new baseline.
// shouldWriteBaseline is the pure branch table that gates the write; these
// tests pin each cell so a future refactor can't silently reintroduce the
// footgun. covers #25.
describe('shouldWriteBaseline', () => {
	test('writes the initial baseline on a clean run', () => {
		expect(shouldWriteBaseline({ allPass: true, hasBaseline: false, refreshFlag: false })).toBe(true)
	})

	test('refuses to write the initial baseline when checks failed', () => {
		expect(shouldWriteBaseline({ allPass: false, hasBaseline: false, refreshFlag: false })).toBe(false)
	})

	test('leaves existing baseline alone without the refresh flag', () => {
		expect(shouldWriteBaseline({ allPass: true, hasBaseline: true, refreshFlag: false })).toBe(false)
	})

	test('refreshes the baseline when the flag is set and checks passed', () => {
		expect(shouldWriteBaseline({ allPass: true, hasBaseline: true, refreshFlag: true })).toBe(true)
	})

	test('refuses to refresh an existing baseline when checks failed', () => {
		expect(shouldWriteBaseline({ allPass: false, hasBaseline: true, refreshFlag: true })).toBe(false)
	})

	test('refuses to write even without baseline when checks failed, flag set', () => {
		expect(shouldWriteBaseline({ allPass: false, hasBaseline: false, refreshFlag: true })).toBe(false)
	})
})
