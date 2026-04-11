import type { SymbolRecord, SymbolResult } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

// resolve a symbol query (name, file:name, or qualified name) to a record
export function resolveSymbolQuery(store: AtlasStore, query: string): SymbolRecord | null {
	return store.resolveSymbol(query)
}

// convert a symbol record to a result with file path
export function symbolRecordToResult(store: AtlasStore, sym: SymbolRecord): SymbolResult {
	return store.symbolToResult(sym)
}
