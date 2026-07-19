/**
 * Shared helpers for the .sng module unit tests. Excluded from the electron build
 * (see tsconfig.electron.json); imports nothing electron-specific.
 */

import * as fs from 'fs'
import { SngHeader, SngStream } from 'parse-sng'
import { Readable } from 'stream'

import { SngPackEntry } from './sng.interface.js'

/** A minimal playable .chart file (verified: scan-chart parses it with playable: true). */
export const MINIMAL_CHART = `[Song]
{
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
[ExpertSingle]
{
  0 = N 0 0
  192 = N 1 0
  384 = N 2 0
  768 = N 0 96
}
`

export function packEntry(name: string, data: Buffer | string): SngPackEntry {
	const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
	return { name, size: buffer.length, stream: () => Readable.from([buffer]) }
}

export interface ParsedSng {
	header: SngHeader
	files: Map<string, Buffer>
}

/** Fully reads a .sng archive with parse-sng (the oracle reader). */
export async function parseSngArchive(sngPath: string, generateSongIni = false): Promise<ParsedSng> {
	const files = new Map<string, Buffer>()
	let header: SngHeader | null = null

	await new Promise<void>((resolve, reject) => {
		const sngStream = new SngStream(
			Readable.toWeb(fs.createReadStream(sngPath)) as ReadableStream<Uint8Array>,
			{ generateSongIni }
		)
		sngStream.on('header', h => {
			header = h
			if (h.fileMeta.length === 0) resolve() // No 'file' events will follow
		})
		sngStream.on('error', reject)
		sngStream.on('file', async (fileName, fileStream, nextFile) => {
			try {
				const chunks: Buffer[] = []
				const reader = fileStream.getReader()
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					chunks.push(Buffer.from(value))
				}
				files.set(fileName, Buffer.concat(chunks))
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

	if (header === null) throw new Error('No .sng header was parsed')
	return { header, files }
}
