// intermediate project. owns the hop between a and c. invokeLeaf is
// the anchor target for cross_project_edges seeded by the scenario.
export function middle(): string {
	return invokeLeaf()
}

export function invokeLeaf(): string {
	return 'b->c'
}
