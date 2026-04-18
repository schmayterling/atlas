// LLM-as-judge. runs a separate (typically cheaper) model over each
// agent answer and asks it to score 0..1 with a one-sentence rationale.
// useful as a cross-check against the deterministic bench-eval judge:
// when the two disagree, either the task expected is too narrow OR
// the deterministic judge's predicates are wrong. either way, that's
// a real signal worth surfacing.
//
// design choices:
// - distinct judge model from the agent model. defaults to
//   `anthropic/claude-haiku-4.5` for cost/quality balance. override
//   with --judge-model.
// - judge sees the task intent + expected payload + raw agent answer
//   (parsed AgentAnswer). NOT the agent's tool transcript — we score
//   the answer, not the process.
// - returns score in [0, 1] (allows partial credit) plus a short
//   rationale string that's stored in the results json for review.
// - if the judge call fails (rate limit, network), returns score=null
//   and rationale=error. caller treats that as "judge unavailable"
//   rather than score=0.

import { runChat } from './openrouter.js'
import type { Expected } from '../../bench-eval/lib/judge.js'
import type { AgentAnswer } from '../../bench-eval/lib/judge.js'

export interface JudgeResult {
	score: number | null
	rationale: string
	tokens: number
	cost: number
}

const SYSTEM_PROMPT = `You are an impartial judge scoring an AI agent's answer to a structural code-intelligence task.

You will be given:
1. The task intent (what was asked)
2. The expected answer payload (typed: symbol-set, count, file-path, or structural)
3. The agent's actual answer payload

Score the answer on a 0.0 to 1.0 scale:
- 1.0 = fully correct, matches expected
- 0.5-0.9 = partially correct (e.g., found some but not all expected symbols, or count was close but not exact)
- 0.0-0.4 = mostly wrong or empty
- 0.0 = wrong, malformed, or empty

Your final reply MUST be a single \`\`\`json fenced block:
{"score": 0.85, "rationale": "found 4 of 5 expected symbols, missed handleAuth"}

Be strict but fair. Reward semantically equivalent answers (e.g. different qualified-name styles, off-by-1-line counts within a small tolerance) but penalize hallucinations (symbols/files that don't exist).`

export interface JudgeOptions {
	judgeModel: string
	taskIntent: string
	expected: Expected
	answer: AgentAnswer
}

export async function judgeWithLlm(opts: JudgeOptions): Promise<JudgeResult> {
	const userMsg = [
		`Task intent: ${opts.taskIntent}`,
		'',
		`Expected (typed):`,
		'```json',
		JSON.stringify(opts.expected, null, 2),
		'```',
		'',
		`Agent answer (parsed):`,
		'```json',
		JSON.stringify(opts.answer, null, 2),
		'```',
		'',
		'Reply with the json block as instructed.',
	].join('\n')

	const r = await runChat({
		model: opts.judgeModel,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: userMsg },
		],
		temperature: 0,
		maxIters: 1,
		maxOutputTokens: 256,
	})

	if (r.error || !r.finalMessage) {
		return { score: null, rationale: r.error ?? 'no response', tokens: r.usage.total_tokens, cost: r.cost }
	}

	const fence = r.finalMessage.match(/```(?:json)?\s*([\s\S]+?)```/)
	const body = fence ? fence[1].trim() : r.finalMessage.trim()
	try {
		const parsed = JSON.parse(body) as { score?: unknown; rationale?: unknown }
		const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null
		const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 240) : ''
		return { score, rationale, tokens: r.usage.total_tokens, cost: r.cost }
	} catch {
		return { score: null, rationale: `parse error: ${body.slice(0, 100)}`, tokens: r.usage.total_tokens, cost: r.cost }
	}
}
