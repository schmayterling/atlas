import { log } from '../../shared/logger.js'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'all-minilm'
const HEALTH_POLL_INTERVAL = 500
const HEALTH_POLL_MAX = 10

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
			body: JSON.stringify({ model: this.model, input: texts }),
		})

		if (!res.ok) {
			throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`)
		}

		const data = (await res.json()) as { embeddings: number[][] }
		return data.embeddings
	}

	async embedBatched(texts: string[], batchSize = 64): Promise<number[][]> {
		const results: number[][] = []

		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize)
			const embeddings = await this.embed(batch)
			results.push(...embeddings)
		}

		return results
	}

	async generate(prompt: string, model?: string): Promise<string> {
		await this.ensureRunning()
		const useModel = model ?? 'qwen2.5-coder:1.5b'
		const res = await fetch(`${this.baseUrl}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: useModel, prompt, stream: false }),
		})

		if (!res.ok) {
			throw new Error(`ollama generate failed: ${res.status} ${await res.text()}`)
		}

		const data = (await res.json()) as { response: string }
		return data.response
	}
}
