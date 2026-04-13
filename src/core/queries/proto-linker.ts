import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// first channel of the general cross-language linker. proto files are
// the cleanest case because the schema is authoritative for both client
// and server: any ts/go symbol named after a proto message or service
// maps to the proto definition. we walk .proto files in the project,
// extract (kind, name) pairs, and write one cross_project_edges row per
// matched pair.

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

// symbol kinds that can plausibly correspond to a proto definition.
// `message` → class/interface/type; `service`/`rpc` → classes + methods.
// functions are excluded because a plain ts function named `User` is
// noise against every proto User message in the tree.
const MESSAGE_KINDS = ['class', 'interface', 'type']
const SERVICE_KINDS = ['class', 'interface']
const RPC_KINDS = ['method']

interface ProtoSymbol {
	kind: 'message' | 'service' | 'rpc'
	name: string
	protoPath: string
}

export function findProtoSymbols(projectRoot: string): ProtoSymbol[] {
	const out: ProtoSymbol[] = []
	const rootReal = safeRealpath(projectRoot) ?? projectRoot
	walk(rootReal, rootReal, out)
	return out
}

function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p)
	} catch {
		return null
	}
}

function walk(root: string, dir: string, out: ProtoSymbol[]): void {
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch (e) {
		log.warn(`proto linker: readdir ${dir}: ${e}`)
		return
	}
	for (const entry of entries) {
		if (PROTO_SKIP_DIRS.has(entry)) continue
		const abs = join(dir, entry)
		// lstat + realpath guard: reject symlinks whose target escapes
		// the project root so a malicious repo can't pull in external
		// .proto files via a planted symlink.
		let lstat
		try {
			lstat = lstatSync(abs)
		} catch {
			continue
		}
		if (lstat.isSymbolicLink()) {
			const real = safeRealpath(abs)
			if (!real || !isUnderRoot(real, root)) continue
		}
		if (lstat.isDirectory() || lstat.isSymbolicLink()) {
			// recurse into directories AND symlinks-to-dirs (when they
			// resolved to something inside root).
			let isDir = lstat.isDirectory()
			if (lstat.isSymbolicLink()) {
				try {
					isDir = lstatSync(realpathSync(abs)).isDirectory()
				} catch {
					isDir = false
				}
			}
			if (isDir) {
				walk(root, abs, out)
				continue
			}
		}
		if (!entry.endsWith('.proto')) continue
		try {
			const content = readFileSync(abs, 'utf-8')
			const relPath = relative(root, abs)
			parseProto(relPath, content, out)
		} catch (e) {
			log.warn(`proto linker: read ${abs}: ${e}`)
		}
	}
}

function isUnderRoot(abs: string, root: string): boolean {
	const normRoot = root.endsWith('/') ? root : `${root}/`
	return abs === root || abs.startsWith(normRoot)
}

function parseProto(protoPath: string, content: string, out: ProtoSymbol[]): void {
	for (const match of content.matchAll(MESSAGE_RE)) {
		out.push({ kind: 'message', name: match[1], protoPath })
	}
	for (const match of content.matchAll(SERVICE_RE)) {
		out.push({ kind: 'service', name: match[1], protoPath })
	}
	for (const match of content.matchAll(RPC_RE)) {
		out.push({ kind: 'rpc', name: match[1], protoPath })
	}
}

// scan proto files + symbols table, emit cross_project_edges rows for
// every symbol whose (name, kind) matches a proto definition. always
// clears prior 'proto_ref' rows before writing so the link set stays
// consistent when .proto files are deleted.
export function linkProtoSymbols(
	store: AtlasStore,
	projectRoot: string,
): { edgesCreated: number } {
	store.runRaw(`DELETE FROM cross_project_edges WHERE kind = 'proto_ref'`)

	const protoSymbols = findProtoSymbols(projectRoot)
	if (protoSymbols.length === 0) return { edgesCreated: 0 }

	// group by name + kind-class so the symbols lookup can run as a
	// single batched query. kind-class keys let us enforce that ts/go
	// classes only link to proto messages, methods to rpcs, etc. this
	// stops `User` the ts class from linking to every proto message
	// called User via a runtime type-check.
	type KindClass = 'message' | 'service' | 'rpc'
	const byName = new Map<string, Array<ProtoSymbol & { kindClass: KindClass }>>()
	for (const sym of protoSymbols) {
		const bucket = byName.get(sym.name) ?? []
		bucket.push({ ...sym, kindClass: sym.kind })
		byName.set(sym.name, bucket)
	}

	const uniqueNames = Array.from(byName.keys())
	if (uniqueNames.length === 0) return { edgesCreated: 0 }

	// one batched select for all names, filtered by the union of
	// symbol kinds we care about. caller dedupes by kind class below.
	const allKinds = Array.from(new Set([...MESSAGE_KINDS, ...SERVICE_KINDS, ...RPC_KINDS]))
	const namePlaceholders = uniqueNames.map(() => '?').join(',')
	const kindPlaceholders = allKinds.map(() => '?').join(',')
	const rows = store.queryRawWithParams<{ stableId: string; name: string; kind: string }>(
		`SELECT stable_id as stableId, name, kind FROM symbols
		 WHERE name IN (${namePlaceholders}) AND kind IN (${kindPlaceholders})`,
		...uniqueNames,
		...allKinds,
	)

	const matchesByName = new Map<string, Array<{ stableId: string; kind: string }>>()
	for (const r of rows) {
		const bucket = matchesByName.get(r.name) ?? []
		bucket.push({ stableId: r.stableId, kind: r.kind })
		matchesByName.set(r.name, bucket)
	}

	let created = 0
	for (const [name, protoSyms] of byName) {
		const matches = matchesByName.get(name)
		if (!matches || matches.length === 0) continue
		for (const protoSym of protoSyms) {
			const eligibleKinds =
				protoSym.kindClass === 'message'
					? MESSAGE_KINDS
					: protoSym.kindClass === 'service'
						? SERVICE_KINDS
						: RPC_KINDS
			const protoStableId = `proto::${protoSym.protoPath}::${protoSym.name}`
			for (const m of matches) {
				if (!eligibleKinds.includes(m.kind)) continue
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

	if (created > 0) {
		log.info(`proto linker: ${created} edges from ${protoSymbols.length} proto symbols`)
	}
	return { edgesCreated: created }
}
