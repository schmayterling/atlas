// helpers shared between baseline + with-atlas agents. keeping these in
// one file stops the two agents from drifting on unrelated axes (e.g.
// one starts capitalizing identifier candidates while the other does
// not); the benchmark delta should only reflect retrieval capability.
// deep-review pass 7 codex flagged the duplication as noise that would
// contaminate future scoring runs.

const TARGET_PATTERNS = [
	/\bfunction\s+(\w+)/,
	/\bsymbol\s+(\w+)/,
	/`(\w+)`/,
	/\b([A-Z][A-Za-z0-9]{3,})\b/,
]

export function extractTarget(question: string): string | null {
	for (const p of TARGET_PATTERNS) {
		const m = question.match(p)
		if (m) return m[1]
	}
	return null
}
