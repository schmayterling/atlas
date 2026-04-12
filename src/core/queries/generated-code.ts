import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AtlasStore } from '../storage/store.js'

// path patterns that identify codegen output without opening the file. these
// cover gomock (fake_*.go, *_mock.go), counterfeiter fakes, and the usual
// mocks/fakes subdirectories that ship across go, ts, and python stacks.
const GENERATED_PATH_RE =
	/(^|\/)(fake_[^/]+|mock_[^/]+|[^/]+_mock)\.(go|ts|tsx|js|jsx|py)$|(^|\/)(mocks|fakes|__generated__)\//

// "code generated ... do not edit" is a de-facto standard header emitted by
// protoc, gomock, sqlc, swagger, openapi, and many others. matched against
// the first 4kb of the file so we don't scan huge blobs just to check.
const GENERATED_HEADER_RE = /Code generated.*DO NOT EDIT/i

export function isGeneratedPath(path: string): boolean {
	return GENERATED_PATH_RE.test(path)
}

// returns true when the first 4kb of the file contains the standard
// "code generated ... do not edit" header. silently returns false on read
// errors (file may have been deleted between indexing and query time).
export function hasGeneratedHeader(absPath: string): boolean {
	try {
		const text = readFileSync(absPath, 'utf-8').slice(0, 4096)
		return GENERATED_HEADER_RE.test(text)
	} catch {
		return false
	}
}

// precompute the set of file ids whose path or leading content identifies
// them as generated. callers filter duplicate / flow-root queries through
// this set so codegen output doesn't dominate their results.
//
// path match short-circuits before any i/o, so only files that slip past
// the path filter pay the header-read cost.
export function findGeneratedFileIds(
	store: AtlasStore,
	projectRoot: string,
): Set<number> {
	const ids = new Set<number>()
	for (const f of store.getAllFiles()) {
		if (isGeneratedPath(f.path)) {
			ids.add(f.id)
			continue
		}
		if (hasGeneratedHeader(join(projectRoot, f.path))) {
			ids.add(f.id)
		}
	}
	return ids
}
