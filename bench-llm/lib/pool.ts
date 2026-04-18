// minimal concurrency pool for bench-llm. takes a list of work items
// and a worker fn; runs up to N workers in parallel. preserves the
// order of results to match input.
//
// design choices:
//  - no deps, ~30 lines
//  - exceptions are captured per-item (so one failed LLM call doesn't
//    take down the whole bench)
//  - calls onProgress when each item completes — so the runner can
//    print a "X/Y done" counter without buffering everything
//
// not a general-purpose primitive — only what bench-llm needs.

export interface PoolResult<T> {
	value?: T
	error?: Error
	index: number
}

export async function runPool<I, O>(
	items: I[],
	concurrency: number,
	worker: (item: I, index: number) => Promise<O>,
	onProgress?: (done: number, total: number, last: PoolResult<O>) => void,
): Promise<PoolResult<O>[]> {
	const results: PoolResult<O>[] = new Array(items.length)
	let next = 0
	let done = 0
	const limit = Math.max(1, concurrency)

	async function pump(): Promise<void> {
		while (true) {
			const i = next++
			if (i >= items.length) return
			let r: PoolResult<O>
			try {
				const value = await worker(items[i], i)
				r = { value, index: i }
			} catch (e) {
				r = { error: e instanceof Error ? e : new Error(String(e)), index: i }
			}
			results[i] = r
			done++
			onProgress?.(done, items.length, r)
		}
	}

	await Promise.all(Array.from({ length: limit }, () => pump()))
	return results
}
