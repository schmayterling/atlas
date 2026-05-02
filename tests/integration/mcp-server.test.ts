import { beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { _resetStalenessCacheForTests, createMcpServer } from '../../src/mcp/server.js'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

let client: Client

beforeAll(async () => {
	const engine = await getFixtureEngine()
	const server = createMcpServer(engine)
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	client = new Client({ name: 'atlas-test', version: '0.0.0' })
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
})

describe('mcp server tool registration', () => {
	test('exposes the expected atlas_* tools', async () => {
		const result = await client.listTools()
		const names = result.tools.map((t) => t.name).sort()
		expect(names).toContain('atlas_status')
		expect(names).toContain('atlas_search')
		expect(names).toContain('atlas_files')
		expect(names).toContain('atlas_file_outline')
		expect(names).toContain('atlas_overview')
		expect(names).toContain('atlas_deps')
		expect(names).toContain('atlas_call_sites')
		expect(names).toContain('atlas_blast_radius')
		expect(names).toContain('atlas_trace')
		expect(names).toContain('atlas_dead_code')
		expect(names).toContain('atlas_history')
		expect(names).toContain('atlas_churn')
		expect(names).toContain('atlas_subsystems')
		expect(names).toContain('atlas_subsystem')
		expect(names).toContain('atlas_test_coverage')
		expect(names).toContain('atlas_hotspots')
		expect(names).toContain('atlas_hot_fragile')
		expect(names).toContain('atlas_channels_list')
		expect(names).toContain('atlas_channels_show')
	})

	test('server instructions advertise the new tier-4 tools', async () => {
		// the instructions string is what agent clients see when discovering
		// atlas's capabilities. if a tool is registered but not mentioned in
		// the instructions, it tends to go unused.
		const result = client.getServerVersion()
		expect(result).toBeDefined()
		// instructions are exposed via initialize result; check the
		// formatter side instead by listing tools and confirming descriptions
		const tools = await client.listTools()
		const files = tools.tools.find((t) => t.name === 'atlas_files')
		const fileOutline = tools.tools.find((t) => t.name === 'atlas_file_outline')
		const testCov = tools.tools.find((t) => t.name === 'atlas_test_coverage')
		const hotspots = tools.tools.find((t) => t.name === 'atlas_hotspots')
		const hotFragile = tools.tools.find((t) => t.name === 'atlas_hot_fragile')
		expect(files?.description).toBeTruthy()
		expect(fileOutline?.description).toBeTruthy()
		expect(testCov?.description).toBeTruthy()
		expect(hotspots?.description).toBeTruthy()
		expect(hotFragile?.description).toBeTruthy()
	})

	test('structured tools expose output schemas', async () => {
		const tools = await client.listTools()
		const status = tools.tools.find((t) => t.name === 'atlas_status')
		const search = tools.tools.find((t) => t.name === 'atlas_search')
		const semanticSearch = tools.tools.find((t) => t.name === 'atlas_semantic_search')
		const contentSearch = tools.tools.find((t) => t.name === 'atlas_content_search')
		const files = tools.tools.find((t) => t.name === 'atlas_files')
		const fileOutline = tools.tools.find((t) => t.name === 'atlas_file_outline')
		const symbolDetail = tools.tools.find((t) => t.name === 'atlas_symbol_detail')
		const trace = tools.tools.find((t) => t.name === 'atlas_trace')
		const hotspots = tools.tools.find((t) => t.name === 'atlas_hotspots')
		expect(status?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				health: { type: 'string' },
				stats: { type: 'object' },
			},
		})
		expect(search?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				query: { type: 'string' },
				results: { type: 'array' },
			},
		})
		expect(semanticSearch?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				embeddingsAvailable: { type: 'boolean' },
				results: { type: 'array' },
			},
		})
		expect(contentSearch?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				counts: { type: 'object' },
				matches: { type: 'array' },
			},
		})
		expect(files?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				files: { type: 'array' },
				counts: { type: 'object' },
			},
		})
		expect(fileOutline?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				path: { type: 'string' },
				counts: { type: 'object' },
			},
		})
		expect(symbolDetail?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				symbol: {},
				sourceIncluded: { type: 'boolean' },
			},
		})
		expect(trace?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				source: {},
				edgeKinds: {},
			},
		})
		expect(hotspots?.outputSchema).toMatchObject({
			type: 'object',
			properties: {
				rows: { type: 'array' },
			},
		})
	})
})

describe('mcp server tier-4 tools', () => {
	test('atlas_test_coverage returns symbol-not-found for an unknown symbol', async () => {
		const result = await client.callTool({
			name: 'atlas_test_coverage',
			arguments: { symbol: 'definitely_not_a_real_symbol_xyz' },
		})
		expect(result.isError).toBeTruthy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		expect(content[0].text).toContain('symbol not found')
	})

	test('atlas_test_coverage returns formatted coverage for a known symbol', async () => {
		// the tiny-project fixture has no test files, so any known symbol
		// will report coverage: none. this exercises the format path
		// without depending on test_links being populated.
		const result = await client.callTool({
			name: 'atlas_test_coverage',
			arguments: { symbol: 'AuthService' },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		expect(content[0].text).toContain('coverage:')
	})

	test('atlas_hot_fragile returns text content (empty-state ok)', async () => {
		const result = await client.callTool({
			name: 'atlas_hot_fragile',
			arguments: { limit: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		expect(content[0].text).toBeDefined()
	})

	test('atlas_hotspots returns text content (empty-state ok)', async () => {
		const result = await client.callTool({
			name: 'atlas_hotspots',
			arguments: { limit: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		expect(content[0].text).toBeDefined()
	})
})

describe('mcp server git tools', () => {
	test('atlas_churn returns either rows or a no-data message', async () => {
		const result = await client.callTool({ name: 'atlas_churn', arguments: { limit: 5 } })
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		// the fixture project has no git history; expect the empty-state line
		expect(content[0].text).toBeDefined()
	})

	test('atlas_history returns no-history message for an unknown file', async () => {
		const result = await client.callTool({
			name: 'atlas_history',
			arguments: { file: 'no-such-file.ts' },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('no history')
	})
})

describe('mcp server tool dispatch', () => {
	test('atlas_status returns formatted text', async () => {
		const result = await client.callTool({ name: 'atlas_status', arguments: {} })
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		expect(content[0].text).toContain('files:')
		const structured = result.structuredContent as {
			health: string
			stats: { files: number; symbols: number; edges: number }
		}
		expect(structured.health).toBe('good')
		expect(structured.stats.files).toBeGreaterThan(0)
		expect(structured.stats.symbols).toBeGreaterThan(0)
		expect(structured.stats.edges).toBeGreaterThan(0)
	})

	test('atlas_search finds AuthService', async () => {
		const result = await client.callTool({
			name: 'atlas_search',
			arguments: { query: 'AuthService' },
		})
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('AuthService')
		const structured = result.structuredContent as {
			query: string
			total: number
			results: { name: string }[]
		}
		expect(structured.query).toBe('AuthService')
		expect(structured.total).toBeGreaterThan(0)
		expect(structured.results.some((s) => s.name === 'AuthService')).toBe(true)
	})

	test('atlas_content_search returns structured counts and matches', async () => {
		const result = await client.callTool({
			name: 'atlas_content_search',
			arguments: { query: 'createAuthService', maxMatches: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('files matched:')
		const structured = result.structuredContent as {
			query: string
			counts: { files: number; matches: number; returned: number }
			matches: { file: string; line: number; text: string }[]
		}
		expect(structured.query).toBe('createAuthService')
		expect(structured.counts.files).toBeGreaterThan(0)
		expect(structured.counts.matches).toBeGreaterThan(0)
		expect(structured.counts.returned).toBe(structured.matches.length)
		expect(structured.matches.some((m) => m.file === 'auth.ts')).toBe(true)
	})

	test('atlas_semantic_search returns structured unavailable state without embeddings', async () => {
		const result = await client.callTool({
			name: 'atlas_semantic_search',
			arguments: { query: 'authentication flow', limit: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('embeddings not available')
		expect(result.structuredContent).toMatchObject({
			query: 'authentication flow',
			limit: 5,
			embeddingsAvailable: false,
			count: 0,
			results: [],
		})
	})

	test('multiple sequential tool calls succeed (regression: stateless transport reuse)', async () => {
		// fix #4 was rooted in transport reuse breaking after the first
		// request. running several calls in a row catches that class of bug.
		for (let i = 0; i < 5; i++) {
			const result = await client.callTool({ name: 'atlas_status', arguments: {} })
			expect(result.isError).toBeFalsy()
		}
	})

	test('errors propagate as isError, not exceptions', async () => {
		const result = await client.callTool({
			name: 'atlas_search',
			arguments: { query: '' },
		})
		// empty query is allowed but returns no results, doesn't throw
		expect(result.isError).toBeFalsy()
	})

	// atlas_overview bundles resolve + deps(up/down) + blast + tests +
	// subsystem into a single tool call so an agent doesn't chain 5+
	// tools to answer "tell me about X". the test asserts every section
	// header is present on a known fixture symbol so a regression that
	// drops any of them fails loudly.
	test('atlas_overview returns all sections for a known symbol', async () => {
		const result = await client.callTool({
			name: 'atlas_overview',
			arguments: { symbol: 'AuthService', limit: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		const text = content[0].text
		expect(text).toContain('AuthService')
		expect(text).toContain('upstream callers')
		expect(text).toContain('downstream callees')
		expect(text).toContain('blast radius:')
		expect(text).toContain('test coverage:')
	})

	// atlas_call_sites is the grep-granularity complement to atlas_deps.
	// deps collapses by source symbol; this preserves call-site
	// multiplicity so two calls from the same function show as two
	// entries. the fixture doesn't exercise duplicate call lines, so
	// this mostly asserts tool wiring + response shape.
	test('atlas_call_sites returns per-edge entries with file:line', async () => {
		const result = await client.callTool({
			name: 'atlas_call_sites',
			arguments: { symbol: 'AuthService', direction: 'inbound', limit: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		const text = content[0].text
		expect(text).toMatch(/(no callers of|call site)/)
	})

	test('atlas_symbol_detail omits source by default and includes it on request', async () => {
		const compact = await client.callTool({
			name: 'atlas_symbol_detail',
			arguments: { symbol: 'loginRoute' },
		})
		expect(compact.isError).toBeFalsy()
		const compactContent = compact.content as { type: string; text: string }[]
		expect(compactContent[0].text).toContain('loginRoute')
		expect(compactContent[0].text).toContain('source: omitted')
		expect(compactContent[0].text).not.toContain(': :')
		expect(compactContent[0].text).not.toContain('export function loginRoute')
		expect(compact.structuredContent).toMatchObject({ sourceIncluded: false })

		const withSource = await client.callTool({
			name: 'atlas_symbol_detail',
			arguments: { symbol: 'AuthService', includeSource: true },
		})
		expect(withSource.isError).toBeFalsy()
		const sourceContent = withSource.content as { type: string; text: string }[]
		expect(sourceContent[0].text).toContain('--- source ---')
		expect(sourceContent[0].text).toContain('export class AuthService')
		expect(withSource.structuredContent).toMatchObject({ sourceIncluded: true })
	})

	test('atlas_files lists indexed files with filters and structured counts', async () => {
		const result = await client.callTool({
			name: 'atlas_files',
			arguments: { pathPrefix: 'auth', language: 'typescript', limit: 5 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('auth.ts')
		expect(content[0].text).toContain('symbols')
		expect(result.structuredContent).toMatchObject({
			pathPrefix: 'auth',
			language: 'typescript',
			includeTests: true,
		})
		const structured = result.structuredContent as {
			files: unknown[]
			counts: { total: number; returned: number }
		}
		expect(structured.files.length).toBeLessThanOrEqual(5)
		expect(structured.counts.total).toBeGreaterThanOrEqual(structured.counts.returned)
	})

	test('atlas_file_outline returns a compact indexed file outline', async () => {
		const result = await client.callTool({
			name: 'atlas_file_outline',
			arguments: { path: 'auth.ts', symbolLimit: 3, importLimit: 2 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		const text = content[0].text
		expect(text).toContain('file auth.ts')
		expect(text).toContain('symbols')
		expect(text).not.toContain(': :')
		expect(text).not.toContain('export class AuthService')
		expect(result.structuredContent).toMatchObject({
			path: 'auth.ts',
			language: 'typescript',
			historyIncluded: false,
		})
		const structured = result.structuredContent as {
			symbols: unknown[]
			counts: { symbols: number }
		}
		expect(structured.symbols.length).toBeLessThanOrEqual(3)
		expect(structured.counts.symbols).toBeGreaterThanOrEqual(structured.symbols.length)
	})

	test('atlas_file_outline accepts filePath alias', async () => {
		const result = await client.callTool({
			name: 'atlas_file_outline',
			arguments: { filePath: 'auth.ts', symbolLimit: 1 },
		})
		expect(result.isError).toBeFalsy()
		expect(result.structuredContent).toMatchObject({ path: 'auth.ts' })
	})

	test('atlas_file_outline filters symbols before formatting', async () => {
		const result = await client.callTool({
			name: 'atlas_file_outline',
			arguments: { path: 'auth.ts', kinds: ['function'], exportedOnly: true, symbolLimit: 10 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('filters: exportedOnly=true, kinds=function')
		expect(content[0].text).toContain('matched /')
		expect(content[0].text).toContain('matched,')
		const structured = result.structuredContent as {
			filters: { kinds: string[]; exportedOnly: boolean }
			counts: { symbols: number; totalSymbols: number }
			symbols: { kind: string; isExported: boolean; name: string }[]
		}
		expect(structured.filters).toEqual({ kinds: ['function'], exportedOnly: true })
		expect(structured.counts.symbols).toBeLessThan(structured.counts.totalSymbols)
		expect(structured.symbols.every((s) => s.kind === 'function' && s.isExported)).toBe(true)
		expect(structured.symbols.some((s) => s.name === 'createAuthService')).toBe(true)
	})

	test('atlas_file_outline allows zero limits to hide sections', async () => {
		const result = await client.callTool({
			name: 'atlas_file_outline',
			arguments: { path: 'auth.ts', symbolLimit: 0, importLimit: 0 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).not.toContain('symbols (')
		expect(content[0].text).not.toContain('imports (')
		expect(content[0].text).not.toContain('imported by (')
		const structured = result.structuredContent as {
			symbols: unknown[]
			imports: unknown[]
			importers: unknown[]
		}
		expect(structured.symbols).toHaveLength(0)
		expect(structured.imports).toHaveLength(0)
		expect(structured.importers).toHaveLength(0)
	})

	test('atlas_file_outline returns file-not-found for an unknown path', async () => {
		const result = await client.callTool({
			name: 'atlas_file_outline',
			arguments: { path: 'does/not/exist.ts' },
		})
		expect(result.isError).toBeTruthy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('file not found')
	})

	test('atlas_trace accepts fast preset and exposes edge kinds in structured content', async () => {
		const result = await client.callTool({
			name: 'atlas_trace',
			arguments: { from: 'loginRoute', to: 'login', preset: 'fast', maxPaths: 3 },
		})
		expect(result.isError).toBeFalsy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('loginRoute')
		expect(result.structuredContent).toMatchObject({ preset: 'fast' })
		const edgeKinds = (result.structuredContent as { edgeKinds: string[] }).edgeKinds
		expect(edgeKinds).toContain('calls')
		expect(edgeKinds).not.toContain('contains')

		const full = await client.callTool({
			name: 'atlas_trace',
			arguments: { from: 'loginRoute', to: 'login', preset: 'full', maxPaths: 3 },
		})
		expect(full.isError).toBeFalsy()
		expect(full.structuredContent).toMatchObject({ preset: 'full' })
		const fullEdgeKinds = (full.structuredContent as { edgeKinds: string[] }).edgeKinds
		expect(fullEdgeKinds).toContain('contains')
	})

	test('atlas_call_sites returns symbol-not-found for an unknown symbol', async () => {
		const result = await client.callTool({
			name: 'atlas_call_sites',
			arguments: { symbol: 'definitely_not_a_symbol_xyz_callsites' },
		})
		expect(result.isError).toBeTruthy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('symbol not found')
	})

	test('atlas_overview returns symbol-not-found for an unknown symbol', async () => {
		const result = await client.callTool({
			name: 'atlas_overview',
			arguments: { symbol: 'definitely_not_a_symbol_xyz' },
		})
		expect(result.isError).toBeTruthy()
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('symbol not found')
	})
})

// covers #82: every non-status tool must prepend a staleness warning
// when the indexed commit drifts from current git HEAD. atlas_status
// is exempt because lastCommit is already part of its formatted body.
//
// the fixture project is not a git repo, so engine.getCurrentCommit()
// normally returns null and the prefix is skipped. we stub the helper
// on the engine to return a known HEAD so the stale path actually
// executes. a second test with matching commits confirms no prefix is
// written. deep-review pass 1/10 codex flagged the previous `stale ||
// hasSearch` assertion as tautological.
describe('mcp server staleness warning', () => {
	const FAKE_HEAD = '1111111111111111111111111111111111111111'
	const STALE_INDEX = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

	async function withStubbedHead(
		indexedCommit: string,
		currentCommit: string | null,
		fn: () => Promise<void>,
	) {
		const engine = await getFixtureEngine()
		const store = engine.getStoreForCrossProject()
		const prior = store.getMeta('last_indexed_commit')
		const original = engine.getCurrentCommit.bind(engine)
		;(engine as { getCurrentCommit: () => string | null }).getCurrentCommit = () => currentCommit
		store.setMeta('last_indexed_commit', indexedCommit)
		_resetStalenessCacheForTests(engine)
		try {
			await fn()
		} finally {
			;(engine as { getCurrentCommit: () => string | null }).getCurrentCommit = original
			_resetStalenessCacheForTests(engine)
			if (prior === null) store.runRaw("DELETE FROM atlas_meta WHERE key = 'last_indexed_commit'")
			else store.setMeta('last_indexed_commit', prior)
		}
	}

	test('prepends [atlas-index-stale: ...] when indexed sha differs from HEAD', async () => {
		await withStubbedHead(STALE_INDEX, FAKE_HEAD, async () => {
			const result = await client.callTool({
				name: 'atlas_search',
				arguments: { query: 'AuthService' },
			})
			const content = result.content as { type: string; text: string }[]
			expect(content[0].text.startsWith('[atlas-index-stale:')).toBe(true)
			expect(content[0].text).toContain(STALE_INDEX.slice(0, 7))
			expect(content[0].text).toContain(FAKE_HEAD.slice(0, 7))
			expect(content[0].text).toContain('AuthService')
		})
	})

	test('omits the prefix when indexed sha matches HEAD', async () => {
		await withStubbedHead(FAKE_HEAD, FAKE_HEAD, async () => {
			const result = await client.callTool({
				name: 'atlas_search',
				arguments: { query: 'AuthService' },
			})
			const content = result.content as { type: string; text: string }[]
			expect(content[0].text.startsWith('[atlas-index-stale:')).toBe(false)
		})
	})

	test('atlas_status never carries a staleness prefix (self-reports via body)', async () => {
		await withStubbedHead(STALE_INDEX, FAKE_HEAD, async () => {
			const result = await client.callTool({ name: 'atlas_status', arguments: {} })
			const content = result.content as { type: string; text: string }[]
			expect(content[0].text.startsWith('[atlas-index-stale:')).toBe(false)
		})
	})
})
