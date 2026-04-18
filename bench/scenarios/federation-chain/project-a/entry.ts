// entry point in project a. re-exports invokeMiddle so the scenario
// can anchor on a known symbol. callers are test-only via bench.
export function entry(): string {
	return invokeMiddle()
}

export function invokeMiddle(): string {
	return 'a->b'
}
