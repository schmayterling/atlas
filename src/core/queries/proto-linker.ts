import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// first channel of the general cross-language linker (#10). proto files
// are the cleanest case because the schema is authoritative for both
// client and server: any ts or go symbol named after a proto message or
// service maps to the proto definition. we walk .proto files in the
// project, extract (kind, name) pairs, and store them in a lightweight
// in-memory index that the linker uses to match symbols across languages.
//
// scope:
// - finds .proto files under the project root, excluding the usual dirs
// - extracts message + service + rpc names via regex (no full parser)
// - matches against existing symbols table rows by exact name
// - emits cross_project_edges with source_project = target_project = 'local'
//   and kind = 'proto_ref'
//
// out of scope for this pass:
// - grpc call-site resolution (needs language-specific parsers)
// - graphql, sql tables, queue topics, env vars (separate channels)
// - external proto files pulled from go_package or buf deps

const PROTO_SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.atlas',
	'vendor',
	'target',
])

const MESSAGE_RE = /^\s*message\s+(\w+)/gm
const SERVICE_RE = /^\s*service\s+(\w+)/gm
const RPC_RE = /^\s*rpc\s+(\w+)\s*\(/gm

export interface ProtoSymbol {
	kind: 'message' | 'service' | 'rpc'
	name: string
	protoPath: string
	line: number
}

export function findProtoSymbols(projectRoot: string): ProtoSymbol[] {
	const out: ProtoSymbol[] = []
	walk(projectRoot, projectRoot, out)
	return out
}

function walk(root: string, dir: string, out: ProtoSymbol[]): void {
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return
	}
	for (const entry of entries) {
		if (PROTO_SKIP_DIRS.has(entry)) continue
		const abs = join(dir, entry)
		let stat
		try {
			stat = statSync(abs)
		} catch {
			continue
		}
		if (stat.isDirectory()) {
			walk(root, abs, out)
			continue
		}
		if (!entry.endsWith('.proto')) continue
		try {
			const content = readFileSync(abs, 'utf-8')
			const relPath = relative(root, abs)
			parseProto(relPath, content, out)
		} catch {
			// unreadable proto file; silently skip so one bad file
			// doesn't abort the whole channel.
		}
	}
}

function parseProto(protoPath: string, content: string, out: ProtoSymbol[]): void {
	for (const match of content.matchAll(MESSAGE_RE)) {
		out.push({
			kind: 'message',
			name: match[1],
			protoPath,
			line: content.slice(0, match.index ?? 0).split('\n').length,
		})
	}
	for (const match of content.matchAll(SERVICE_RE)) {
		out.push({
			kind: 'service',
			name: match[1],
			protoPath,
			line: content.slice(0, match.index ?? 0).split('\n').length,
		})
	}
	for (const match of content.matchAll(RPC_RE)) {
		out.push({
			kind: 'rpc',
			name: match[1],
			protoPath,
			line: content.slice(0, match.index ?? 0).split('\n').length,
		})
	}
}

// scan proto files + symbols table, emit cross_project_edges rows for
// every symbol whose name matches a proto message / service / rpc.
// idempotent: clears its own 'proto_ref' rows before repopulating.
export function linkProtoSymbols(
	store: AtlasStore,
	projectRoot: string,
): { edgesCreated: number } {
	const protoSymbols = findProtoSymbols(projectRoot)
	if (protoSymbols.length === 0) return { edgesCreated: 0 }

	store.runRaw(
		`DELETE FROM cross_project_edges WHERE kind = 'proto_ref'`,
	)

	const names = new Map<string, ProtoSymbol[]>()
	for (const sym of protoSymbols) {
		const bucket = names.get(sym.name) ?? []
		bucket.push(sym)
		names.set(sym.name, bucket)
	}

	let created = 0
	for (const [name, protoSyms] of names) {
		const matches = store.queryRawWithParams<{ stableId: string }>(
			`SELECT stable_id as stableId FROM symbols WHERE name = ? AND kind IN ('class','interface','type','function','method')`,
			name,
		)
		if (matches.length === 0) continue
		// synthesise a stable id for the proto symbol so cross_project_edges
		// has both ends. the proto side id is deterministic by path + name.
		for (const protoSym of protoSyms) {
			const protoStableId = `proto::${protoSym.protoPath}::${protoSym.name}`
			for (const m of matches) {
				store.insertCrossProjectEdge({
					sourceProject: 'local',
					sourceStableId: m.stableId,
					targetProject: 'local',
					targetStableId: protoStableId,
					kind: 'proto_ref',
				})
				created++
			}
		}
	}

	if (created > 0) log.info(`proto linker: ${created} edges from ${protoSymbols.length} proto symbols`)
	return { edgesCreated: created }
}
