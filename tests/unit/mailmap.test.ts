import { describe, expect, test } from 'bun:test'
import { applyMailmap, parseMailmap } from '../../src/core/indexer/mailmap.js'

describe('parseMailmap', () => {
	test('empty input returns empty maps', () => {
		const mm = parseMailmap('')
		expect(mm.byEmail.size).toBe(0)
		expect(mm.byPair.size).toBe(0)
	})

	test('skips comments and blank lines', () => {
		const mm = parseMailmap('# a comment\n\nAlice <alice@canonical.com>\n')
		expect(mm.byEmail.size).toBe(1)
		expect(mm.byEmail.get('alice@canonical.com')).toEqual({
			canonicalName: 'Alice',
			canonicalEmail: 'alice@canonical.com',
		})
	})

	test('form: Name <email> only stores by email', () => {
		const mm = parseMailmap('Bob Builder <bob@canonical.com>\n')
		expect(mm.byEmail.get('bob@canonical.com')).toEqual({
			canonicalName: 'Bob Builder',
			canonicalEmail: 'bob@canonical.com',
		})
	})

	test('form: Name <proper> <commit> maps commit email to canonical', () => {
		const mm = parseMailmap('Charlie <charlie@canonical.com> <charlie@old.com>\n')
		expect(mm.byEmail.get('charlie@old.com')).toEqual({
			canonicalName: 'Charlie',
			canonicalEmail: 'charlie@canonical.com',
		})
		// pair map not populated when there's no commit-side name
		expect(mm.byPair.size).toBe(0)
	})

	test('form: Name <proper> Wrong Name <commit> populates both pair and email', () => {
		const mm = parseMailmap('Dana <dana@canonical.com> D <dana@old.com>\n')
		expect(mm.byEmail.get('dana@old.com')).toEqual({
			canonicalName: 'Dana',
			canonicalEmail: 'dana@canonical.com',
		})
		expect(mm.byPair.get('d|dana@old.com')).toEqual({
			canonicalName: 'Dana',
			canonicalEmail: 'dana@canonical.com',
		})
	})

	test('ignores lines with too many emails', () => {
		const mm = parseMailmap('A <a@x> <b@y> <c@z>\n')
		expect(mm.byEmail.size).toBe(0)
		expect(mm.byPair.size).toBe(0)
	})
})

describe('applyMailmap', () => {
	test('returns input unchanged when mailmap is null', () => {
		const out = applyMailmap(null, 'Anyone', 'any@where.com')
		expect(out).toEqual({ name: 'Anyone', email: 'any@where.com' })
	})

	test('email-only lookup canonicalises both name and email', () => {
		const mm = parseMailmap('Eve <eve@canonical.com> <eve@old.com>\n')
		expect(applyMailmap(mm, 'Eve from Elsewhere', 'eve@old.com')).toEqual({
			name: 'Eve',
			email: 'eve@canonical.com',
		})
	})

	test('pair lookup takes precedence over email lookup', () => {
		const mm = parseMailmap(
			[
				'Frank Canonical <frank@new.com> Frank <frank@old.com>',
				'Other Canonical <other@new.com> <frank@old.com>',
			].join('\n'),
		)
		// with commit (name=Frank, email=frank@old.com), pair match wins
		expect(applyMailmap(mm, 'Frank', 'frank@old.com')).toEqual({
			name: 'Frank Canonical',
			email: 'frank@new.com',
		})
		// with a different commit name but same email, email match wins
		expect(applyMailmap(mm, 'Someone Else', 'frank@old.com')).toEqual({
			name: 'Other Canonical',
			email: 'other@new.com',
		})
	})

	test('case-insensitive email lookup', () => {
		const mm = parseMailmap('Gina <gina@canonical.com> <GINA@OLD.COM>\n')
		expect(applyMailmap(mm, 'Gina', 'gina@old.com')).toEqual({
			name: 'Gina',
			email: 'gina@canonical.com',
		})
		expect(applyMailmap(mm, 'Gina', 'Gina@Old.Com')).toEqual({
			name: 'Gina',
			email: 'gina@canonical.com',
		})
	})

	test('pass-through when nothing matches', () => {
		const mm = parseMailmap('Known <known@canonical.com> <known@old.com>\n')
		expect(applyMailmap(mm, 'Stranger', 'stranger@nowhere.com')).toEqual({
			name: 'Stranger',
			email: 'stranger@nowhere.com',
		})
	})
})
