import { SngHeader } from 'parse-sng'

/**
 * Module-local types for the .sng read/write support module.
 * The module adds no IPC channels, so these types are not in src-shared.
 */

export interface SngPackEntry {
	name: string
	size: number
	stream(): NodeJS.ReadableStream
}

export interface ReadSngOptions {
	/** Return `false` to keep the entry in the result with empty data. Default: load everything. */
	loadData?: (fileName: string, size: number) => boolean
	/** `true` = unloaded entries are omitted from the result entirely (IssueScan behavior). Default: `false` (empty-data placeholders, ChartScanner behavior). */
	omitUnloaded?: boolean
	/** `true` = parse errors are logged and a partial list is returned (ChartScanner behavior). Default: `false` (errors reject). */
	swallowErrors?: boolean
	/** Called once when the .sng header has been parsed, before any file entries are read. */
	onHeader?: (header: SngHeader) => void
}

/** Normalized ('/'-separated) file name → size and md5 of the plain (unmasked) contents. */
export type SngManifest = Map<string, { size: number; md5: string }>

export interface SngCommitResult {
	changed: boolean
	/** Human-readable descriptions of any sanitization changes made during packing (e.g. stripped newlines in metadata values). */
	modifications?: string[]
}

export interface ChartWorkspace {
	readonly dir: string
	readonly isSng: boolean
	/** No-op returning `{ changed: false }` when the dir matches the open() manifest. */
	commit(): Promise<SngCommitResult>
	/** Best-effort cleanup + lock release. Never throws (would mask commit errors in `finally`). */
	discard(): Promise<void>
}
