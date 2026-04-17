import { describe, expect, test } from 'bun:test'
import { shouldKeepIdentifier } from '../../src/core/queries/channel-utils.js'
import '../helpers/setup.js'

// covers #73: per-kind precision audits modeled on channel-utils-
// precision.test.ts. each linker passes its own `extras` denylist to
// shouldKeepIdentifier; these tests pin the per-kind rules so a
// future denylist edit can't silently regress on well-known junk.

const QUEUE_EXTRAS = new Set([
	'event',
	'events',
	'message',
	'messages',
	'data',
	'msg',
	'topic',
	'topics',
])

const ENV_EXTRAS = new Set([
	'path',
	'home',
	'user',
	'pwd',
	'shell',
	'lang',
	'tmp',
	'tmpdir',
	'temp',
])

describe('queue topic denylist (#73)', () => {
	test('drops generic literals that show up in every pub/sub codebase', () => {
		for (const junk of QUEUE_EXTRAS) {
			expect(shouldKeepIdentifier(junk, { extras: QUEUE_EXTRAS })).toBe(false)
		}
	})

	test('keeps real-looking topic names', () => {
		expect(shouldKeepIdentifier('user.created', { extras: QUEUE_EXTRAS })).toBe(true)
		expect(shouldKeepIdentifier('orders.confirmed', { extras: QUEUE_EXTRAS })).toBe(true)
		expect(shouldKeepIdentifier('payment-failed', { extras: QUEUE_EXTRAS })).toBe(true)
	})

	test('does not apply sql-reserved rejection (topics named "update" or "order" are fine)', () => {
		// queue linker never opts into sqlReserved, so these pass. if
		// this breaks, shouldKeepIdentifier's default changed and queue
		// linker must audit its call sites.
		expect(shouldKeepIdentifier('update', { extras: QUEUE_EXTRAS })).toBe(true)
		expect(shouldKeepIdentifier('order', { extras: QUEUE_EXTRAS })).toBe(true)
	})
})

describe('env var denylist (#73)', () => {
	test('drops ubiquitous shell env names', () => {
		for (const junk of ENV_EXTRAS) {
			expect(shouldKeepIdentifier(junk, { extras: ENV_EXTRAS })).toBe(false)
		}
	})

	test('keeps project-meaningful env names', () => {
		expect(shouldKeepIdentifier('STRIPE_KEY', { extras: ENV_EXTRAS })).toBe(true)
		expect(shouldKeepIdentifier('DATABASE_URL', { extras: ENV_EXTRAS })).toBe(true)
		expect(shouldKeepIdentifier('NODE_ENV', { extras: ENV_EXTRAS })).toBe(true)
	})
})

describe('graphql type denylist (#73)', () => {
	test('allows type names that collide with sql keywords (#66 regression)', () => {
		// graphql linker never passes sqlReserved, so these must pass.
		expect(shouldKeepIdentifier('Order')).toBe(true)
		expect(shouldKeepIdentifier('Update')).toBe(true)
		expect(shouldKeepIdentifier('Delete')).toBe(true)
	})

	test('rejects universal junk that happens to match a graphql ident regex', () => {
		expect(shouldKeepIdentifier('And')).toBe(false) // common stopword
		expect(shouldKeepIdentifier('The')).toBe(false)
		expect(shouldKeepIdentifier('Null')).toBe(false)
	})
})

describe('openapi schema denylist (#73)', () => {
	test('schema names that collide with sql keywords still pass (openapi is not sql)', () => {
		expect(shouldKeepIdentifier('Update')).toBe(true)
		expect(shouldKeepIdentifier('Delete')).toBe(true)
	})
})
