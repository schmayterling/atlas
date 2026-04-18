// minimal swr-like cache. keyed by string. dedupes inflight requests,
// returns cached data immediately while revalidating in the background.
// no abort, no focus revalidation: ~80 lines, fits the wiki-reading model
// where data is mostly static between re-indexes.

import { useEffect, useRef, useState } from 'react'

type Entry<T> = {
	data: T | undefined
	error: Error | undefined
	promise: Promise<T> | undefined
	timestamp: number
	subs: Set<() => void>
}

const cache = new Map<string, Entry<any>>()
const TTL_MS = 30_000

function getEntry<T>(key: string): Entry<T> {
	let e = cache.get(key)
	if (!e) {
		e = { data: undefined, error: undefined, promise: undefined, timestamp: 0, subs: new Set() }
		cache.set(key, e)
	}
	return e as Entry<T>
}

function notify(e: Entry<any>) {
	for (const cb of e.subs) cb()
}

async function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
	const e = getEntry<T>(key)
	if (e.promise) return e.promise
	e.promise = fetcher()
		.then((data) => { e.data = data; e.error = undefined; e.timestamp = Date.now(); return data })
		.catch((err) => { e.error = err instanceof Error ? err : new Error(String(err)); throw err })
		.finally(() => { e.promise = undefined; notify(e) })
	return e.promise
}

export function useQuery<T>(
	key: string | null,
	fetcher: () => Promise<T>,
): { data: T | undefined; error: Error | undefined; loading: boolean; refetch: () => void } {
	const [, force] = useState(0)
	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher

	useEffect(() => {
		if (!key) return
		const e = getEntry<T>(key)
		const cb = () => force((n) => n + 1)
		e.subs.add(cb)
		const stale = Date.now() - e.timestamp > TTL_MS
		if (stale && !e.promise) revalidate(key, fetcherRef.current).catch(() => {})
		return () => { e.subs.delete(cb) }
	}, [key])

	if (!key) return { data: undefined, error: undefined, loading: false, refetch: () => {} }
	const e = getEntry<T>(key)
	return {
		data: e.data,
		error: e.error,
		loading: e.promise !== undefined && e.data === undefined,
		refetch: () => { e.timestamp = 0; revalidate(key, fetcherRef.current).catch(() => {}) },
	}
}

export function invalidate(prefix?: string) {
	if (!prefix) { cache.clear(); return }
	for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}
