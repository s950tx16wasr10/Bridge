/**
 * Shared streaming .sng extraction, replacing the two divergent copies that lived in
 * ChartScanner and IssueScanHandler. Behavior is parameterized on three axes
 * (which contents load / whether unloaded entries are omitted / error semantics)
 * so both call sites stay bit-identical. See docs/sng-write-support-design.md §2.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { SngHeader, SngStream } from 'parse-sng'
import { Readable } from 'stream'

import { ReadSngOptions, SngManifest } from './sng.interface.js'

/**
 * Reads the files inside a .sng archive, including a generated `song.ini`
 * synthesized from the archive's metadata section.
 */
export async function readSngFiles(sngPath: string, opts: ReadSngOptions = {}): Promise<Array<{ fileName: string; data: Uint8Array }>> {
	const loadData = opts.loadData ?? (() => true)
	const files: { fileName: string; data: Uint8Array }[] = []

	try {
		await new Promise<void>((resolve, reject) => {
			const sngStream = new SngStream(
				Readable.toWeb(fs.createReadStream(sngPath)) as ReadableStream<Uint8Array>,
				{ generateSongIni: true }
			)

			let header: SngHeader | null = null
			let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
			sngStream.on('header', h => {
				header = h
				opts.onHeader?.(h)
			})
			sngStream.on('error', err => {
				// Unhang any file handler blocked on reader.read() so it settles and
				// releases its resources instead of leaking until app exit
				currentReader?.cancel().catch(() => { /* already errored */ })
				reject(err)
			})

			sngStream.on('file', async (fileName, fileStream, nextFile) => {
				try {
					const fileMeta = header?.fileMeta.find(f => f.filename === fileName)
					const fileSize = fileMeta ? Number(fileMeta.contentsLen) : 0

					if (fileMeta && loadData(fileName, fileSize)) {
						const data = new Uint8Array(fileSize)
						let offset = 0
						const reader = fileStream.getReader()
						currentReader = reader
						while (true) {
							const { done, value } = await reader.read()
							if (done) break
							data.set(value, offset)
							offset += value.length
						}
						files.push({ fileName, data: offset === fileSize ? data : data.subarray(0, offset) })
					} else {
						// Drain the stream so the next file can be read
						const reader = fileStream.getReader()
						currentReader = reader
						while (true) {
							const { done } = await reader.read()
							if (done) break
						}
						if (!opts.omitUnloaded) {
							files.push({ fileName, data: new Uint8Array() })
						}
					}
					currentReader = null

					if (nextFile) {
						nextFile()
					} else {
						resolve()
					}
				} catch (err) {
					reject(err)
				}
			})

			sngStream.start()
		})
	} catch (err) {
		if (opts.swallowErrors) {
			// .sng parsing failed, return the partial list
			console.error('Failed to parse .sng file:', err)
		} else {
			throw err
		}
	}

	return files
}

/**
 * Reads only the header of a .sng archive (file listing + metadata) without
 * draining the file data section. Listing a video-bearing archive costs a few
 * KB of I/O instead of the whole file.
 */
export function readSngHeader(sngPath: string): Promise<SngHeader> {
	return new Promise((resolve, reject) => {
		const source = fs.createReadStream(sngPath)
		const sngStream = new SngStream(
			Readable.toWeb(source) as ReadableStream<Uint8Array>,
			{ generateSongIni: true }
		)
		let settled = false
		sngStream.on('header', header => {
			settled = true
			source.destroy()
			resolve(header)
		})
		sngStream.on('error', err => {
			if (!settled) reject(err)
		})
		sngStream.on('file', (_fileName, fileStream) => {
			// Resolution happens on 'header'; stop the pipeline instead of draining
			fileStream.cancel().catch(() => { /* source already destroyed */ })
		})
		sngStream.start()
	})
}

/**
 * Reads selected entries via positional reads at their header offsets, so a
 * single small file costs its own size in I/O rather than the whole archive.
 * Falls back to the sequential reader when the archive's offsets don't match
 * the contiguous layout (parse-sng ignores offsets, so such files exist only
 * from nonconforming packers, but they would parse fine sequentially).
 */
export async function readSngEntries(
	sngPath: string,
	wanted: (fileName: string, size: number) => boolean,
): Promise<Array<{ fileName: string; data: Uint8Array }>> {
	const header = await readSngHeader(sngPath)

	// Validate the offset chain describes the contiguous layout the format requires
	let expected: bigint | null = null
	for (const meta of header.fileMeta) {
		if (meta.contentsIndex < 0n) continue // synthesized song.ini has no stored bytes
		if (expected !== null && meta.contentsIndex !== expected) {
			return readSngFiles(sngPath, { loadData: wanted, omitUnloaded: true })
		}
		expected = meta.contentsIndex + meta.contentsLen
	}

	const results: Array<{ fileName: string; data: Uint8Array }> = []
	const fd = await fs.promises.open(sngPath, 'r')
	try {
		for (const meta of header.fileMeta) {
			const size = Number(meta.contentsLen)
			if (!wanted(meta.filename, size)) continue
			if (meta.contentsIndex < 0n) {
				// The synthesized song.ini exists only as header metadata
				results.push({ fileName: meta.filename, data: new TextEncoder().encode(generateIniText(header)) })
				continue
			}
			const data = Buffer.alloc(size)
			await fd.read(data, 0, size, Number(meta.contentsIndex))
			for (let i = 0; i < size; i++) {
				data[i] = data[i] ^ header.xorMask[i % 16] ^ (i & 0xff)
			}
			results.push({ fileName: meta.filename, data: new Uint8Array(data) })
		}
	} finally {
		await fd.close()
	}
	return results
}

function generateIniText(header: SngHeader): string {
	let text = '[song]\n'
	for (const [key, value] of Object.entries(header.metadata)) {
		text += `${key} = ${value}\n`
	}
	return text
}

/**
 * Streams EVERYTHING in the archive (video included, plus the generated `song.ini`)
 * to disk under `destDir`; workspace-only.
 *
 * Names are normalized `\` → `/` and parent directories are created. Any name
 * containing a `..` segment or resolving outside `destDir` is rejected (path
 * traversal). On win32, extraction paths longer than ~250 chars are rejected
 * (MAX_PATH), naming the file.
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\x00-\x1f]/

/**
 * Rejects entry names that Windows would silently mangle: on NTFS a trailing dot
 * or space is stripped and lookups are case-insensitive, so such entries would
 * collide or rename themselves in the workspace and the corruption would then be
 * repacked into the archive.
 */
function assertSafeEntryName(fileName: string, normalized: string): void {
	for (const segment of normalized.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment.endsWith('.') || segment.endsWith(' ')) {
			throw new Error(`.sng entry "${fileName}" has a name segment ending in a dot or space, which Windows cannot store faithfully`)
		}
		const stem = segment.split('.')[0]
		if (WINDOWS_RESERVED_NAMES.test(stem)) {
			throw new Error(`.sng entry "${fileName}" uses the reserved Windows device name "${stem}"`)
		}
		if (WINDOWS_ILLEGAL_CHARS.test(segment)) {
			throw new Error(`.sng entry "${fileName}" contains characters Windows does not allow in file names`)
		}
	}
}

export async function extractSngToDir(sngPath: string, destDir: string): Promise<SngManifest> {
	const manifest: SngManifest = new Map()
	const resolvedDest = path.resolve(destDir)
	await fs.promises.mkdir(resolvedDest, { recursive: true })

	const seenNames = new Set<string>()

	await new Promise<void>((resolve, reject) => {
		const sngStream = new SngStream(
			Readable.toWeb(fs.createReadStream(sngPath)) as ReadableStream<Uint8Array>,
			{ generateSongIni: true }
		)

		let currentOutput: fs.WriteStream | null = null
		let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
		sngStream.on('error', err => {
			// Unhang any file handler blocked on reader.read() and close its file
			// handle, otherwise the workspace dir can't be removed until app exit
			currentReader?.cancel().catch(() => { /* already errored */ })
			currentOutput?.destroy()
			reject(err)
		})

		sngStream.on('file', async (fileName, fileStream, nextFile) => {
			let output: fs.WriteStream | null = null
			try {
				const normalized = fileName.replace(/\\/g, '/')
				if (normalized.split('/').some(segment => segment === '..')) {
					throw new Error(`.sng entry "${fileName}" contains a path traversal segment`)
				}
				assertSafeEntryName(fileName, normalized)
				const lowerName = normalized.toLowerCase()
				if (seenNames.has(lowerName)) {
					throw new Error(`.sng archive contains entries that differ only by letter case ("${fileName}"), which Windows cannot store as separate files`)
				}
				seenNames.add(lowerName)
				const destPath = path.resolve(resolvedDest, normalized)
				if (destPath === resolvedDest || !destPath.startsWith(resolvedDest + path.sep)) {
					throw new Error(`.sng entry "${fileName}" resolves outside the extraction directory`)
				}
				if (process.platform === 'win32' && destPath.length > 250) {
					throw new Error(`Extraction path for .sng entry "${fileName}" is ${destPath.length} characters, which exceeds the Windows path length limit`)
				}

				await fs.promises.mkdir(path.dirname(destPath), { recursive: true })

				const md5 = crypto.createHash('md5')
				let size = 0
				output = fs.createWriteStream(destPath)
				currentOutput = output
				// Without a listener, a failed write (ENOSPC/EIO) also emits 'error'
				// with no handler and crashes the whole process
				let streamError: Error | null = null
				output.on('error', err => { streamError = streamError ?? err })
				const reader = fileStream.getReader()
				currentReader = reader
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					md5.update(value)
					size += value.length
					const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
					await new Promise<void>((resolveWrite, rejectWrite) => {
						output!.write(chunk, err => err ? rejectWrite(err) : resolveWrite())
					})
					if (streamError) throw streamError
				}
				await new Promise<void>((resolveEnd, rejectEnd) => {
					output!.once('close', () => streamError ? rejectEnd(streamError) : resolveEnd())
					output!.end()
				})
				if (streamError) throw streamError
				currentOutput = null
				currentReader = null
				output = null

				manifest.set(normalized, { size, md5: md5.digest('hex') })

				if (nextFile) {
					nextFile()
				} else {
					resolve()
				}
			} catch (err) {
				output?.destroy()
				reject(err)
			}
		})

		sngStream.start()
	})

	return manifest
}
