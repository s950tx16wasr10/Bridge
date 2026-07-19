/**
 * Streaming .sng v1 packer.
 *
 * Byte-level format contract verified against parse-sng 4.0.3 (Bridge's own reader) and
 * the SngFileFormat spec / SngCli reference encoder. See docs/sng-write-support-design.md §3.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'

import { hasAlbumName, hasAudioName, hasChartName, hasVideoName } from '../../../src-shared/UtilFunctions.js'
import { SngManifest, SngPackEntry } from './sng.interface.js'

/** parse-sng reads the filename length prefix as a SIGNED int8 (index.ts:312), so 255-byte spec names would corrupt. */
const MAX_FILENAME_BYTES = 127

/** Junk files excluded at pack time (SngCli encoder policy). Compared case-insensitively against the basename. */
const JUNK_FILENAMES = ['desktop.ini', '.ds_store', 'ps.dat', 'ch.dat']

const HEADER_PREFIX_LEN = 6 + 4 + 16 // magic + version + xorMask

/**
 * @returns `name` with `\` separators normalized to `/`, and the basename lowercased
 * if its lowercase form is a known chart filename (SngCli encoder policy).
 */
export function normalizeSngFilename(name: string): string {
	const normalized = name.replace(/\\/g, '/')
	const segments = normalized.split('/')
	const basename = segments[segments.length - 1]
	const lowerBasename = basename.toLowerCase()
	const isKnown =
		hasChartName(lowerBasename) ||
		lowerBasename === 'song.ini' ||
		hasAlbumName(lowerBasename) ||
		hasAudioName(lowerBasename) ||
		hasVideoName(lowerBasename) ||
		(['background', 'highway'].includes(lowerBasename.split('.')[0]) && ['png', 'jpg', 'jpeg'].includes(lowerBasename.split('.').pop() ?? ''))
	if (isKnown && basename !== lowerBasename) {
		segments[segments.length - 1] = lowerBasename
		return segments.join('/')
	}
	return normalized
}

/**
 * @returns `true` if `normalizedName` should never be packed into a .sng archive:
 * junk files, `__MACOSX/` entries, nested `.sng` archives, and `song.ini`
 * (its `[song]` keys are folded into the metadata section instead).
 */
export function isExcludedFromSngPack(normalizedName: string): boolean {
	const lowerName = normalizedName.toLowerCase()
	const segments = lowerName.split('/')
	const basename = segments[segments.length - 1]
	if (JUNK_FILENAMES.includes(basename)) return true
	if (segments.includes('__macosx')) return true
	if (basename.endsWith('.sng')) return true
	if (lowerName === 'song.ini') return true
	return false
}

/**
 * Keys containing `=`, `;`, or newlines are rejected (throws, naming the key).
 * Newlines break the generated song.ini, so they are stripped from values and
 * every such modification is reported to the caller. Empty keys and values are
 * skipped (parse-sng drops them at read time regardless).
 */
export function sanitizeSngMetadata(metadata: Map<string, string>): { metadata: Map<string, string>; modifications: string[] } {
	const sanitized = new Map<string, string>()
	const modifications: string[] = []
	for (const [key, value] of metadata) {
		if (/[=;\r\n]/.test(key)) {
			throw new Error(`Invalid .sng metadata key "${key}": keys must not contain '=', ';', or newlines`)
		}
		let newValue = value
		if (/[\r\n]/.test(value)) {
			newValue = value.replace(/[\r\n]+/g, ' ').trim()
			modifications.push(`Newlines were removed from the value of metadata key "${key}"`)
		}
		if (key.length === 0 || newValue.length === 0) continue
		sanitized.set(key, newValue)
	}
	return { metadata: sanitized, modifications }
}

/**
 * Pure, unit-testable header math (magic/mask/metadata/fileMeta/offset chain).
 *
 * All length prefixes use `Buffer.byteLength` (UTF-8 bytes), never `String.length`.
 * `contentsIndex` values are absolute file offsets. Entry order is preserved; file
 * contents must be written contiguously in the same order, without padding.
 *
 * `entries` and `metadata` are packed as given; apply `normalizeSngFilename`,
 * `isExcludedFromSngPack`, and `sanitizeSngMetadata` first (packSngToFile does).
 */
export function buildSngHeader(entries: Array<{ name: string; size: number }>, metadata: Map<string, string>, xorMask: Buffer): Buffer {
	if (xorMask.length !== 16) {
		throw new Error(`.sng xor mask must be 16 bytes; got ${xorMask.length}`)
	}

	const metadataPairs: Array<{ keyBuffer: Buffer; valueBuffer: Buffer }> = []
	for (const [key, value] of metadata) {
		if (/[=;\r\n]/.test(key)) {
			throw new Error(`Invalid .sng metadata key "${key}": keys must not contain '=', ';', or newlines`)
		}
		if (/[\r\n]/.test(value)) {
			throw new Error(`.sng metadata value for key "${key}" contains a newline; sanitize metadata before packing`)
		}
		if (key.length === 0 || value.length === 0) continue // parse-sng drops empty keys/values at read time regardless
		metadataPairs.push({ keyBuffer: Buffer.from(key, 'utf8'), valueBuffer: Buffer.from(value, 'utf8') })
	}

	const fileEntries = entries.map(entry => {
		const nameBuffer = Buffer.from(entry.name, 'utf8')
		if (nameBuffer.length > MAX_FILENAME_BYTES) {
			throw new Error(`.sng filename "${entry.name}" is ${nameBuffer.length} UTF-8 bytes; the maximum is ${MAX_FILENAME_BYTES}`)
		}
		return { nameBuffer, size: entry.size }
	})

	const metadataLen = 8 + metadataPairs.reduce((sum, p) => sum + 4 + p.keyBuffer.length + 4 + p.valueBuffer.length, 0)
	const fileMetaLen = 8 + fileEntries.reduce((sum, f) => sum + 1 + f.nameBuffer.length + 16, 0)
	const headerSize = HEADER_PREFIX_LEN + 8 + metadataLen + 8 + fileMetaLen + 8
	const fileDataLen = fileEntries.reduce((sum, f) => sum + f.size, 0)

	const header = Buffer.alloc(headerSize)
	let offset = 0
	offset += header.write('SNGPKG', offset, 'latin1')
	offset = header.writeUInt32LE(1, offset)
	offset += xorMask.copy(header, offset)

	offset = header.writeBigUInt64LE(BigInt(metadataLen), offset)
	offset = header.writeBigUInt64LE(BigInt(metadataPairs.length), offset)
	for (const pair of metadataPairs) {
		offset = header.writeInt32LE(pair.keyBuffer.length, offset)
		offset += pair.keyBuffer.copy(header, offset)
		offset = header.writeInt32LE(pair.valueBuffer.length, offset)
		offset += pair.valueBuffer.copy(header, offset)
	}

	offset = header.writeBigUInt64LE(BigInt(fileMetaLen), offset)
	offset = header.writeBigUInt64LE(BigInt(fileEntries.length), offset)
	let contentsIndex = headerSize // First file starts immediately after the header (26 + 8 + metadataLen + 8 + fileMetaLen + 8)
	for (const file of fileEntries) {
		offset = header.writeInt8(file.nameBuffer.length, offset)
		offset += file.nameBuffer.copy(header, offset)
		offset = header.writeBigUInt64LE(BigInt(file.size), offset)
		offset = header.writeBigUInt64LE(BigInt(contentsIndex), offset)
		contentsIndex += file.size
	}

	header.writeBigUInt64LE(BigInt(fileDataLen), offset)

	return header
}

/**
 * Streaming writer: O(chunk) memory, chunked XOR + md5, never a whole-archive Buffer.
 *
 * Applies the encoder policy before packing: names are normalized via
 * `normalizeSngFilename`, and junk/`song.ini` entries are excluded (fold `song.ini`
 * into `metadata` via sngIni.ts before calling). `metadata` must already be
 * sanitized (see `sanitizeSngMetadata`); invalid keys/values throw.
 *
 * The XOR mask is 16 fresh bytes from `crypto.randomBytes`, applied with the byte
 * index resetting to 0 for each file: `masked[i] = plain[i] ^ mask[i % 16] ^ (i % 256)`.
 *
 * @returns a manifest of the packed files (normalized name → size + md5 of the plain contents).
 */
export async function packSngToFile(entries: SngPackEntry[], metadata: Map<string, string>, destPath: string): Promise<SngManifest> {
	const packedEntries = entries
		.map(entry => ({ ...entry, name: normalizeSngFilename(entry.name) }))
		.filter(entry => !isExcludedFromSngPack(entry.name))

	const xorMask = crypto.randomBytes(16)
	const header = buildSngHeader(packedEntries.map(e => ({ name: e.name, size: e.size })), metadata, xorMask)
	const manifest: SngManifest = new Map()

	const output = fs.createWriteStream(destPath)
	// Without a listener, a failed write (ENOSPC/EIO) also emits 'error' with no
	// handler and crashes the whole process as an uncaughtException
	let streamError: Error | null = null
	output.on('error', err => { streamError = streamError ?? err })
	try {
		await writeToStream(output, header)

		for (const entry of packedEntries) {
			const md5 = crypto.createHash('md5')
			let cyclicIndex = 0 // Resets to 0 per file; a global running offset would corrupt every file after the first
			let bytesWritten = 0

			for await (const chunk of entry.stream()) {
				const plain = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
				md5.update(plain)
				const masked = Buffer.allocUnsafe(plain.length)
				for (let i = 0; i < plain.length; i++) {
					masked[i] = plain[i] ^ xorMask[cyclicIndex % 16] ^ cyclicIndex
					cyclicIndex = (cyclicIndex + 1) % 256
				}
				await writeToStream(output, masked)
				bytesWritten += plain.length
			}

			if (bytesWritten !== entry.size) {
				throw new Error(`File "${entry.name}" changed size while packing (header says ${entry.size} bytes; read ${bytesWritten})`)
			}
			if (streamError) throw streamError
			manifest.set(entry.name, { size: bytesWritten, md5: md5.digest('hex') })
		}

		await new Promise<void>((resolve, reject) => {
			output.once('close', () => streamError ? reject(streamError) : resolve())
			output.end()
		})
		if (streamError) throw streamError
	} catch (err) {
		output.destroy()
		await fs.promises.rm(destPath, { force: true }).catch(() => { /* best-effort cleanup */ })
		throw err
	}

	return manifest
}

/** Writes `chunk` and waits for it to be flushed from the internal buffer (backpressure-aware). */
function writeToStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		stream.write(chunk, err => err ? reject(err) : resolve())
	})
}
