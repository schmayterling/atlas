// no consumers — used by dead-code tests
export function neverCalled(): void {
	console.log('this is dead')
}

export const ORPHAN_CONST = 42

// non-exported helpers that nothing else references. dead-code under
// the recursive reachability model (#41) should flag these: they are
// not exported, not reached from any exported root, and not touched
// by any test. a mutually-recursive pair (deadA / deadB) must also
// appear so the fixture pins the specific bug class the NOT IN check
// missed.
function deadA(): number {
	return deadB() + 1
}
function deadB(): number {
	return deadA() + 1
}

// eslint: keep these from being flagged as unused at the TS level.
// they are intentionally unreachable from the atlas engine POV but
// still parse as valid TS.
void deadA
void deadB
