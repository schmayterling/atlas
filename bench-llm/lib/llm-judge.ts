// LLM-as-judge with verification tools. runs a separate (typically
// cheaper) model over each agent answer and asks it to score 0..1 with
// a one-sentence rationale. unlike a rubric-only judge, this judge gets
// read_file / grep / glob primitives so it can verify whether a claimed
// symbol or file actually exists in the corpus before crediting the
// answer. without verification a confident hallucination ("the function
// lives at crates/foo.rs::bar") can pass the rubric check; with it the
// judge can spot-check.
//
// design choices:
// - separate judge model from the agent model. defaults to
//   `openai/gpt-5.4-nano` for cost; override with --judge-model.
// - tools are TEXT primitives (read_file/grep/glob), not atlas tools.
//   giving the judge atlas tools would defeat the purpose; we want the
//   judge to verify against the corpus directly using primitives that
//   do not depend on atlas being correct.
// - judge sees the task intent + expected payload + agent answer.
//   NOT the agent's tool transcript: the judge scores the ANSWER, the
//   transcript is for human inspection only.
// - tool budget capped at maxIters = 4 to keep judge cost bounded.
// - if judge call fails (rate limit, network, bad json), returns
//   score=null and rationale=error. caller treats that as "judge
//   unavailable" rather than score=0.

import { runChat, type ChatMessage } from './openrouter.js'
import type { Expected } from '../../bench-eval/lib/judge.js'
import type { AgentAnswer } from '../../bench-eval/lib/judge.js'
import { TEXT_TOOLS, makeTextHandler } from './text-tools.js'

export interface JudgeResult {
	score: number | null
	rationale: string
	tokens: number
	cost: number
	// number of verification tool calls the judge made. surfaces in
	// results.json so we can audit which trials needed checking.
	verifyCalls: number
}

const SYSTEM_PROMPT_RUBRIC = `You are an impartial judge scoring an AI agent's answer to a structural code-intelligence task.

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

const SYSTEM_PROMPT_VERIFY = `${SYSTEM_PROMPT_RUBRIC}

You have read_file, grep, and glob tools available. USE THEM SPARINGLY (max 3 calls per scoring) to spot-check the agent's claims:
- if the agent claims a symbol lives at "crates/foo.rs::bar", grep -n "fn bar" crates/foo.rs to verify it exists
- if the agent claims a file count, glob the pattern and check the length
- if the agent's count looks suspicious (way off from a plausible value), spot-check one or two files

Penalize confidently-stated claims that fail verification. If you do not need to verify (the answer obviously matches the expected payload), do not call any tools — just emit the json block.`

export interface JudgeOptions {
	judgeModel: string
	taskIntent: string
	expected: Expected
	answer: AgentAnswer
	// when both `corpusRoot` AND `verify: true` are set, the judge gets
	// read_file/grep/glob tools scoped to this directory and verifies
	// claims before scoring. otherwise it runs in rubric-only mode (the
	// original behavior, comparable to published runs <= c222cba).
	// keeping verify behind an explicit flag means flipping it does NOT
	// silently invalidate prior baselines — they were rubric-only.
	corpusRoot?: string
	verify?: boolean
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
		opts.verify && opts.corpusRoot
			? 'Verify any claim that you are unsure about by calling a tool, then emit the json block.'
			: 'Reply with the json block as instructed.',
	].join('\n')

	const verifyMode = Boolean(opts.verify && opts.corpusRoot)
	const messages: ChatMessage[] = [
		{ role: 'system', content: verifyMode ? SYSTEM_PROMPT_VERIFY : SYSTEM_PROMPT_RUBRIC },
		{ role: 'user', content: userMsg },
	]

	const r = await runChat({
		model: opts.judgeModel,
		messages,
		temperature: 0,
		maxIters: verifyMode ? 4 : 1,
		maxOutputTokens: 512,
		tools: verifyMode ? TEXT_TOOLS : undefined,
		toolHandler: verifyMode ? makeTextHandler(opts.corpusRoot!) : undefined,
	})

	const verifyCalls = r.steps.reduce(
		(n, s) => n + (s.role === 'assistant' && s.tool_calls ? s.tool_calls.length : 0),
		0,
	)

	if (r.error || !r.finalMessage) {
		return { score: null, rationale: r.error ?? 'no response', tokens: r.usage.total_tokens, cost: r.cost, verifyCalls }
	}

	const fence = r.finalMessage.match(/```(?:json)?\s*([\s\S]+?)```/)
	const body = fence ? fence[1].trim() : r.finalMessage.trim()
	try {
		const parsed = JSON.parse(body) as { score?: unknown; rationale?: unknown }
		const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null
		const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 240) : ''
		return { score, rationale, tokens: r.usage.total_tokens, cost: r.cost, verifyCalls }
	} catch {
		return { score: null, rationale: `parse error: ${body.slice(0, 100)}`, tokens: r.usage.total_tokens, cost: r.cost, verifyCalls }
	}
}
