// no consumers — used by dead-code tests
export function neverCalled(): void {
	console.log('this is dead')
}

export const ORPHAN_CONST = 42
