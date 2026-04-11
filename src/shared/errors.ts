export class AtlasError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AtlasError'
	}
}

export class IndexNotFoundError extends AtlasError {
	constructor(dbPath: string) {
		super(`atlas index not found at ${dbPath}. run 'atlas init' first.`)
		this.name = 'IndexNotFoundError'
	}
}

export class SymbolNotFoundError extends AtlasError {
	constructor(query: string) {
		super(`no symbol found matching '${query}'`)
		this.name = 'SymbolNotFoundError'
	}
}

export class ParseError extends AtlasError {
	constructor(filePath: string, reason: string) {
		super(`failed to parse ${filePath}: ${reason}`)
		this.name = 'ParseError'
	}
}

export class ConfigError extends AtlasError {
	constructor(reason: string) {
		super(`config error: ${reason}`)
		this.name = 'ConfigError'
	}
}
