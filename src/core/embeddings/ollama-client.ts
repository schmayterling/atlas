import { log } from '../../shared/logger.js'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'nomic-embed-text'
const HEALTH_POLL_INTERVAL = 500
const HEALTH_POLL_MAX = 10

export class EmbedContextLengthError extends Error {
	constructor() {
		super('ollama embed: context length exceeded')
		this.name = 'EmbedContextLengthError'
	}
}

function previewText(text: string): string {
	return text.slice(0, 80).replace(/\n/g, ' ')
}

export class OllamaClient {
	private baseUrl: string
	private model: string

	constructor(baseUrl?: string, model?: string) {
		this.baseUrl = baseUrl ?? DEFAULT_BASE_URL
		this.model = model ?? DEFAULT_MODEL
	}

	async isRunning(): Promise<boolean> {
		try {
			const res = await fetch(this.baseUrl)
			return res.ok
		} catch {
			return false
		}
	}

	async ensureRunning(): Promise<void> {
		if (await this.isRunning()) return

		// check if ollama is installed
		const which = Bun.spawnSync(['which', 'ollama'], { stdout: 'pipe', stderr: 'pipe' })
		if (which.exitCode !== 0) {
			throw new Error(
				'ollama is not installed. install it first:\n' +
					'  macOS: brew install ollama\n' +
					'  linux: curl -fsSL https://ollama.com/install.sh | sh\n' +
					'  all:   https://ollama.com/download',
			)
		}

		log.info('starting ollama...')
		Bun.spawn(['ollama', 'serve'], { stdout: 'ignore', stderr: 'ignore' })

		for (let i = 0; i < HEALTH_POLL_MAX; i++) {
			await Bun.sleep(HEALTH_POLL_INTERVAL)
			if (await this.isRunning()) {
				log.info('ollama started')
				return
			}
		}

		throw new Error(
			`ollama failed to start within ${(HEALTH_POLL_INTERVAL * HEALTH_POLL_MAX) / 1000}s`,
		)
	}

	async ensureModel(): Promise<void> {
		try {
			const res = await fetch(`${this.baseUrl}/api/show`, {
				method: 'POST',
				body: JSON.stringify({ model: this.model }),
			})
			if (res.ok) return
		} catch {
			// model not found, pull it
		}

		log.info(`pulling ollama model ${this.model}...`)
		const result = Bun.spawnSync(['ollama', 'pull', this.model], {
			stdout: 'inherit',
			stderr: 'inherit',
		})
		if (result.exitCode !== 0) {
			throw new Error(`failed to pull ollama model ${this.model}`)
		}
	}

	async embed(texts: string[]): Promise<number[][]> {
		const res = await fetch(`${this.baseUrl}/api/embed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: this.model, input: texts, truncate: true }),
			signal: AbortSignal.timeout(60_000),
		})

		if (!res.ok) {
			const body = await res.text()
			if (res.status === 400 && /input length exceeds.*context length/i.test(body)) {
				throw new EmbedContextLengthError()
			}
			throw new Error(`ollama embed failed: ${res.status} ${body}`)
		}

		const data = (await res.json()) as { embeddings: number[][] }
		if (data.embeddings.length !== texts.length) {
			throw new Error(
				`ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs`,
			)
		}
		return data.embeddings
	}

	async embedBatched(
		texts: string[],
		batchSize = 64,
		onProgress?: (completed: number, total: number) => void,
	): Promise<(number[] | null)[]> {
		const results: (number[] | null)[] = new Array(texts.length).fill(null)
		const batchCount = Math.ceil(texts.length / batchSize)
		const budget = { remaining: Math.max(batchCount * 2, 16) }

		for (let i = 0; i < texts.length; i += batchSize) {
			const end = Math.min(i + batchSize, texts.length)
			await this.embedBatchRecoverable(texts, i, end, results, budget)
			if (onProgress) onProgress(end, texts.length)
		}

		return results
	}

	private async embedBatchRecoverable(
		texts: string[],
		start: number,
		end: number,
		results: (number[] | null)[],
		budget: { remaining: number },
	): Promise<void> {
		const batch = texts.slice(start, end)
		try {
			const embeddings = await this.embed(batch)
			for (let j = 0; j < embeddings.length; j++) {
				results[start + j] = embeddings[j]
			}
		} catch (e) {
			if (!(e instanceof EmbedContextLengthError)) throw e

			const count = end - start
			if (count === 1) {
				log.warn(`embedding failed for index ${start} (${previewText(texts[start])}...): context length exceeded`)
				return
			}

			if (budget.remaining <= 0) {
				log.warn(`retry budget exhausted, skipping batch [${start}..${end})`)
				return
			}

			if (count <= 4) {
				// probe individually — no budget cost
				for (let i = start; i < end; i++) {
					try {
						const [vec] = await this.embed([texts[i]])
						results[i] = vec
					} catch (inner) {
						if (!(inner instanceof EmbedContextLengthError)) throw inner
						log.warn(`embedding failed for index ${i} (${previewText(texts[i])}...): context length exceeded`)
					}
				}
			} else {
				budget.remaining--
				const mid = start + Math.floor(count / 2)
				log.debug(`batch [${start}..${end}) failed, splitting at ${mid}`)
				await this.embedBatchRecoverable(texts, start, mid, results, budget)
				await this.embedBatchRecoverable(texts, mid, end, results, budget)
			}
		}
	}

	async generate(prompt: string, model?: string): Promise<string> {
		await this.ensureRunning()
		const useModel = model ?? 'qwen2.5-coder:1.5b'
		const res = await fetch(`${this.baseUrl}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: useModel, prompt, stream: false }),
			signal: AbortSignal.timeout(60_000),
		})

		if (!res.ok) {
			throw new Error(`ollama generate failed: ${res.status} ${await res.text()}`)
		}

		const data = (await res.json()) as { response: string }
		return data.response
	}
}
