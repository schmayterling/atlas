import { readFileSync, realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { log } from '../../shared/logger.js'
import type { ChannelHit } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'
import { shouldKeepIdentifier } from './channel-utils.js'

// queue-topic channel linker (#30). detects publish/subscribe sites
// across kafka, nats, rabbitmq, and redis pub/sub for both ts/js
// and go drivers. follows the sql-linker shape: walk every non-test
// source file already in the store, regex over the file body, gate
// each match through channel-utils.shouldKeepIdentifier, and write
// channel_hits rows with kind='queue_topic'. metadata records
// direction (pub/sub) and driver so the channels show ui can group
// pub-side and sub-side under the same topic value.
//
// scope: regex-based extraction. accepts string-literal topic
// arguments only — variable-derived topics (`topic: TOPIC_NAME`) are
// out of scope for the MVP because resolving the variable's value
// would require interpreter-level analysis. that's a known
// limitation, documented here.

interface QueuePattern {
	driver: string
	direction: 'pub' | 'sub'
	regex: RegExp
}

const QUEUE_PATTERNS: QueuePattern[] = [
	// kafka.js (typescript)
	{ driver: 'kafka', direction: 'pub', regex: /producer\.send\s*\(\s*\{[^}]*?topic\s*:\s*['"`]([\w.\-]+)['"`]/g },
	{ driver: 'kafka', direction: 'sub', regex: /consumer\.subscribe\s*\(\s*\{[^}]*?topic\s*:\s*['"`]([\w.\-]+)['"`]/g },
	// segmentio kafka-go (go)
	{ driver: 'kafka', direction: 'pub', regex: /Topic\s*:\s*['"`]([\w.\-]+)['"`]/g },
	{ driver: 'kafka', direction: 'pub', regex: /SetTopic\s*\(\s*['"`]([\w.\-]+)['"`]\s*\)/g },
	// nats (both ts and go)
	{ driver: 'nats', direction: 'pub', regex: /\.Publish\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	{ driver: 'nats', direction: 'sub', regex: /\.Subscribe\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	// amqplib / rabbitmq (ts) - publish to exchange/queue
	{ driver: 'rabbitmq', direction: 'pub', regex: /\.publish\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	{ driver: 'rabbitmq', direction: 'sub', regex: /\.consume\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	// streadway/amqp (go)
	{ driver: 'rabbitmq', direction: 'pub', regex: /\.Publish\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	{ driver: 'rabbitmq', direction: 'sub', regex: /\.Consume\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	// redis pubsub (ts/go)
	{ driver: 'redis', direction: 'pub', regex: /\.publish\s*\(\s*['"`]([\w.\-]+)['"`]/g },
	{ driver: 'redis', direction: 'sub', regex: /\.subscribe\s*\(\s*['"`]([\w.\-]+)['"`]/g },
]

// channel-specific extras: topic literals like `event` or `message`
// that show up in real code but are too generic to be useful.
const QUEUE_EXTRAS = new Set<string>([
	'event',
	'events',
	'message',
	'messages',
	'data',
	'msg',
	'topic',
	'topics',
])

export function linkQueueTopics(store: AtlasStore, projectRoot: string): { hits: number } {
	store.deleteChannelHitsByKind('queue_topic')

	const files = store.getAllFiles().filter((f) => !f.isTest)
	const hits: ChannelHit[] = []
	const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.go', '.py'])
	const rootReal = realpathOrNull(projectRoot) ?? projectRoot

	for (const f of files) {
		const dot = f.path.lastIndexOf('.')
		if (dot < 0) continue
		const ext = f.path.slice(dot)
		if (!allowedExtensions.has(ext)) continue

		const resolved = resolvePath(projectRoot, f.path)
		const resolvedReal = realpathOrNull(resolved)
		if (resolvedReal && !isUnderRoot(resolvedReal, rootReal)) continue

		let source: string
		try {
			source = readFileSync(resolved, 'utf-8')
		} catch (e) {
			log.warn(`queue-linker: read ${f.path}: ${e}`)
			continue
		}

		const lineOffsets = buildLineOffsets(source)

		for (const pat of QUEUE_PATTERNS) {
			for (const m of source.matchAll(pat.regex)) {
				const raw = m[1]
				const matchIndex = m.index
				if (!raw || matchIndex === undefined) continue
				if (!shouldKeepIdentifier(raw, { extras: QUEUE_EXTRAS })) continue

				const line = offsetToLine(lineOffsets, matchIndex) + 1
				const enclosing = store.getSymbolContainingByte(f.id, matchIndex)
				if (!enclosing) continue

				hits.push({
					symbolStableId: enclosing.stableId,
					fileId: f.id,
					kind: 'queue_topic',
					value: raw,
					line,
					metadata: JSON.stringify({ direction: pat.direction, driver: pat.driver }),
				})
			}
		}
	}

	if (hits.length > 0) store.insertChannelHits(hits)
	return { hits: hits.length }
}

function buildLineOffsets(source: string): number[] {
	const offsets = [0]
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) offsets.push(i + 1)
	}
	return offsets
}

function offsetToLine(offsets: number[], matchIndex: number): number {
	let lo = 0
	let hi = offsets.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (offsets[mid] <= matchIndex) lo = mid
		else hi = mid - 1
	}
	return lo
}

function realpathOrNull(p: string): string | null {
	try {
		return realpathSync(p)
	} catch {
		return null
	}
}

function isUnderRoot(abs: string, root: string): boolean {
	const normRoot = root.endsWith('/') ? root : `${root}/`
	return abs === root || abs.startsWith(normRoot)
}
