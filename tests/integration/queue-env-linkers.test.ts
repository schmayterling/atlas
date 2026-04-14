import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #30a: queue_topic + env_var channel linkers. uses tiny
// multi-language fixtures (TS publisher + Go consumer matching on
// `user.created`; multiple files reading STRIPE_KEY in different
// languages) and asserts the channel_hits table groups them
// correctly. mirrors the sql-linker.test.ts shape.

let queueRoot: string
let envRoot: string
let queueEngine: AtlasEngine
let envEngine: AtlasEngine

beforeAll(async () => {
	queueRoot = mkdtempSync(join(tmpdir(), 'atlas-queue-fixture-'))
	envRoot = mkdtempSync(join(tmpdir(), 'atlas-env-fixture-'))

	// queue fixture: a TS kafka producer + a Go nats consumer pointing
	// at the same `user.created` topic, plus a TS subscriber to verify
	// pub/sub direction metadata round-trips.
	writeFileSync(
		join(queueRoot, 'producer.ts'),
		`import { Kafka } from 'kafkajs'

export async function publishUserCreated(producer: any, user: any) {
	await producer.send({
		topic: 'user.created',
		messages: [{ value: JSON.stringify(user) }],
	})
}
`,
	)
	writeFileSync(
		join(queueRoot, 'subscriber.ts'),
		`import { Kafka } from 'kafkajs'

export async function subscribeToUserCreated(consumer: any) {
	await consumer.subscribe({ topic: 'user.created', fromBeginning: true })
}
`,
	)
	writeFileSync(
		join(queueRoot, 'consumer.go'),
		`package consumer

import "github.com/nats-io/nats.go"

func StartUserConsumer(nc *nats.Conn) error {
	_, err := nc.Subscribe("user.updated", func(m *nats.Msg) {})
	return err
}
`,
	)

	// env fixture: STRIPE_KEY read from three different languages
	writeFileSync(
		join(envRoot, 'config.ts'),
		`export function getStripeKey(): string {
	return process.env.STRIPE_KEY ?? ''
}
`,
	)
	writeFileSync(
		join(envRoot, 'config.go'),
		`package config

import "os"

func GetStripeKey() string {
	return os.Getenv("STRIPE_KEY")
}
`,
	)
	writeFileSync(
		join(envRoot, 'config.py'),
		`import os

def get_stripe_key() -> str:
    return os.environ.get('STRIPE_KEY', '')
`,
	)

	queueEngine = new AtlasEngine(queueRoot)
	envEngine = new AtlasEngine(envRoot)
	await queueEngine.index({ noEmbed: true, noSummarize: true, force: true })
	await envEngine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterAll(() => {
	queueEngine.close()
	envEngine.close()
	rmSync(queueRoot, { recursive: true, force: true })
	rmSync(envRoot, { recursive: true, force: true })
})

describe('queue_topic linker (#30a)', () => {
	test('detects kafka producer and consumer on the same topic', () => {
		const store = queueEngine.getStoreForCrossProject()
		const rows = store.queryRaw<{ value: string; metadata: string | null }>(
			`SELECT value, metadata FROM channel_hits WHERE kind = 'queue_topic'`,
		)
		const topics = rows.map((r) => r.value)
		expect(topics).toContain('user.created')
		expect(topics).toContain('user.updated')

		// pub/sub direction lands in metadata
		const userCreatedRows = rows.filter((r) => r.value === 'user.created')
		const directions = userCreatedRows
			.map((r) => (r.metadata ? JSON.parse(r.metadata).direction : null))
			.filter(Boolean)
		expect(directions).toContain('pub')
		expect(directions).toContain('sub')
	})

	test('groups multiple symbols under the same topic via listChannels', () => {
		const groups = queueEngine.listChannels('queue_topic')
		const userCreated = groups.find((g) => g.value === 'user.created')
		// should have at least 2 distinct symbols (publishUserCreated + subscribeToUserCreated)
		expect(userCreated).toBeDefined()
		expect(userCreated!.symbolStableIds.length).toBeGreaterThanOrEqual(2)
	})
})

describe('env_var linker (#30a)', () => {
	test('detects STRIPE_KEY across ts, go, and python', () => {
		const store = envEngine.getStoreForCrossProject()
		const rows = store.queryRaw<{ value: string; metadata: string | null }>(
			`SELECT value, metadata FROM channel_hits WHERE kind = 'env_var'`,
		)
		const vars = rows.map((r) => r.value)
		expect(vars).toContain('STRIPE_KEY')

		// each row records its source idiom in metadata
		const sources = rows
			.map((r) => (r.metadata ? JSON.parse(r.metadata).source : null))
			.filter(Boolean)
		expect(sources).toContain('node')
		expect(sources).toContain('go')
		expect(sources).toContain('python')
	})

	test('groups env var hits under listChannels', () => {
		const groups = envEngine.listChannels('env_var')
		const stripe = groups.find((g) => g.value === 'STRIPE_KEY')
		expect(stripe).toBeDefined()
		// three files, three symbols touching STRIPE_KEY
		expect(stripe!.symbolStableIds.length).toBeGreaterThanOrEqual(2)
	})
})
