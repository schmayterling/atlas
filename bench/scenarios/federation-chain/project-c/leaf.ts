// terminal project. leaf() is the landing symbol for a->b->c traversal.
export function leaf(): string {
	return 'c-result'
}

export function backToA(): string {
	// intentionally named so the scenario can seed a c->a back-edge and
	// exercise cycle handling in findCrossProjectBoundaries.
	return 'cycle-seed'
}
