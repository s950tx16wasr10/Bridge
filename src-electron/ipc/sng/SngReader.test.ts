import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { packSngToFile } from './SngPacker.js'
import { extractSngToDir, readSngFiles } from './SngReader.js'
import { packEntry, parseSngArchive } from './sngTestUtils.js'

let testDir: string
let archivePath: string

const CHART_DATA = Buffer.from('chart contents', 'utf8')
const ALBUM_DATA = Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
const AUDIO_DATA = Buffer.from('OggS fake audio bytes', 'utf8')
const VIDEO_DATA = Buffer.from('fake video bytes', 'utf8')
const NESTED_DATA = Buffer.from([7, 8, 9])
const METADATA = new Map([['name', 'Reader Test'], ['artist', 'Someone']])

beforeAll(async () => {
	testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-sng-reader-test-'))
	archivePath = path.join(testDir, 'reader.sng')
	await packSngToFile(
		[
			packEntry('notes.chart', CHART_DATA),
			packEntry('album.png', ALBUM_DATA),
			packEntry('song.ogg', AUDIO_DATA),
			packEntry('video.mp4', VIDEO_DATA),
			packEntry('sub/dir/nested.bin', NESTED_DATA),
		],
		METADATA,
		archivePath,
	)
})

afterAll(async () => {
	await fs.promises.rm(testDir, { recursive: true, force: true })
})

describe('readSngFiles', () => {
	it('loads every file plus a generated song.ini by default', async () => {
		const files = await readSngFiles(archivePath)
		const byName = new Map(files.map(f => [f.fileName, f.data]))
		expect(byName.size).toBe(6)
		expect(Buffer.from(byName.get('notes.chart')!).equals(CHART_DATA)).toBe(true)
		expect(Buffer.from(byName.get('video.mp4')!).equals(VIDEO_DATA)).toBe(true)
		const iniText = Buffer.from(byName.get('song.ini')!).toString('utf8')
		expect(iniText).toContain('[song]')
		expect(iniText).toContain('name = Reader Test')
	})

	it('keeps unloaded entries as empty-data placeholders by default (ChartScanner behavior)', async () => {
		const files = await readSngFiles(archivePath, {
			loadData: fileName => fileName === 'notes.chart',
		})
		const byName = new Map(files.map(f => [f.fileName, f.data]))
		expect(byName.size).toBe(6)
		expect(Buffer.from(byName.get('notes.chart')!).equals(CHART_DATA)).toBe(true)
		expect(byName.get('song.ogg')!.length).toBe(0)
		expect(byName.get('video.mp4')!.length).toBe(0)
	})

	it('omits unloaded entries when omitUnloaded is set (IssueScan behavior)', async () => {
		const files = await readSngFiles(archivePath, {
			loadData: fileName => fileName === 'notes.chart',
			omitUnloaded: true,
		})
		expect(files.map(f => f.fileName)).toEqual(['notes.chart'])
	})

	it('passes the header file size to the loadData predicate', async () => {
		const seen = new Map<string, number>()
		await readSngFiles(archivePath, {
			loadData: (fileName, size) => {
				seen.set(fileName, size)
				return false
			},
			omitUnloaded: true,
		})
		expect(seen.get('notes.chart')).toBe(CHART_DATA.length)
		expect(seen.get('video.mp4')).toBe(VIDEO_DATA.length)
	})

	it('emits the parsed header through onHeader before any file is read', async () => {
		let fileMetaCount = 0
		await readSngFiles(archivePath, {
			onHeader: header => { fileMetaCount = header.fileMeta.length },
		})
		// The generated song.ini is unshifted into fileMeta by parse-sng
		expect(fileMetaCount).toBe(6)
	})

	it('rejects on a corrupt archive by default', async () => {
		const corruptPath = path.join(testDir, 'corrupt.sng')
		await fs.promises.writeFile(corruptPath, Buffer.from('not an sng file at all'))
		await expect(readSngFiles(corruptPath)).rejects.toThrow()
	})

	it('swallows errors and returns a partial list when swallowErrors is set', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { })
		try {
			const corruptPath = path.join(testDir, 'corrupt2.sng')
			await fs.promises.writeFile(corruptPath, Buffer.from('still not an sng file'))
			const files = await readSngFiles(corruptPath, { swallowErrors: true })
			expect(files).toEqual([])
			expect(errorSpy).toHaveBeenCalled()
		} finally {
			errorSpy.mockRestore()
		}
	})
})

describe('extractSngToDir', () => {
	it('extracts everything (video included) plus the generated song.ini, creating nested dirs', async () => {
		const destDir = path.join(testDir, 'extract-all')
		const manifest = await extractSngToDir(archivePath, destDir)

		expect([...manifest.keys()].sort()).toEqual(['album.png', 'notes.chart', 'song.ini', 'song.ogg', 'sub/dir/nested.bin', 'video.mp4'])
		expect((await fs.promises.readFile(path.join(destDir, 'notes.chart'))).equals(CHART_DATA)).toBe(true)
		expect((await fs.promises.readFile(path.join(destDir, 'video.mp4'))).equals(VIDEO_DATA)).toBe(true)
		expect((await fs.promises.readFile(path.join(destDir, 'sub', 'dir', 'nested.bin'))).equals(NESTED_DATA)).toBe(true)

		// Manifest sizes and md5s describe the extracted plain contents
		expect(manifest.get('notes.chart')?.size).toBe(CHART_DATA.length)
		expect(manifest.get('sub/dir/nested.bin')?.size).toBe(NESTED_DATA.length)
	})

	it('round-trips extract → repack → parse with byte equality', async () => {
		const destDir = path.join(testDir, 'extract-roundtrip')
		const manifest = await extractSngToDir(archivePath, destDir)

		const entries = [...manifest.keys()]
			.filter(name => name !== 'song.ini')
			.map(name => ({
				name,
				size: manifest.get(name)!.size,
				stream: () => fs.createReadStream(path.join(destDir, name)),
			}))
		const repackedPath = path.join(testDir, 'repacked.sng')
		await packSngToFile(entries, METADATA, repackedPath)

		const original = await parseSngArchive(archivePath)
		const repacked = await parseSngArchive(repackedPath)
		expect(repacked.header.metadata).toEqual(original.header.metadata)
		expect([...repacked.files.keys()].sort()).toEqual([...original.files.keys()].sort())
		for (const [name, data] of original.files) {
			expect(repacked.files.get(name)!.equals(data), `byte equality for ${name}`).toBe(true)
		}
	})

	it('rejects path traversal names instead of writing outside the destination', async () => {
		const evilPath = path.join(testDir, 'evil.sng')
		await packSngToFile([packEntry('../evil.txt', 'gotcha')], new Map(), evilPath)

		const destDir = path.join(testDir, 'extract-evil', 'inner')
		await expect(extractSngToDir(evilPath, destDir)).rejects.toThrow(/traversal/)
		expect(fs.existsSync(path.join(testDir, 'extract-evil', 'evil.txt'))).toBe(false)
	})
})
