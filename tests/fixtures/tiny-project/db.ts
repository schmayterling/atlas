export class Database {
	private connected = false

	connect(): void {
		this.connected = true
	}

	query<T>(_sql: string): T[] {
		if (!this.connected) throw new Error('not connected')
		return [] as T[]
	}

	close(): void {
		this.connected = false
	}
}

export function makeDatabase(): Database {
	return new Database()
}
