import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildSngHeader, isExcludedFromSngPack, normalizeSngFilename, packSngToFile, sanitizeSngMetadata } from './SngPacker.js'
import { packEntry, parseSngArchive } from './sngTestUtils.js'

let testDir: string

beforeAll(async () => {
	testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-sng-packer-test-'))
})

afterAll(async () => {
	await fs.promises.rm(testDir, { recursive: true, force: true })
})

const sequentialMask = () => Buffer.from(Array.from({ length: 16 }, (_, i) => i))

describe('buildSngHeader', () => {
	it('matches the hand-computed byte fixture for a 1-file archive', () => {
		const header = buildSngHeader([{ name: 'a.txt', size: 3 }], new Map([['name', 'X']]), sequentialMask())

		// Hand-computed: metadataLen = 8 + (4+4+4+1) = 21; fileMetaLen = 8 + (1+5+16) = 30;
		// headerSize = 26 + 8 + 21 + 8 + 30 + 8 = 101; first contentsIndex = 101; fileDataLen = 3
		const expected = Buffer.concat([
			Buffer.from('SNGPKG', 'latin1'),
			Buffer.from([1, 0, 0, 0]), // version
			sequentialMask(),
			Buffer.from([21, 0, 0, 0, 0, 0, 0, 0]), // metadataLen
			Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), // metadataCount
			Buffer.from([4, 0, 0, 0]), // keyLen
			Buffer.from('name', 'utf8'),
			Buffer.from([1, 0, 0, 0]), // valueLen
			Buffer.from('X', 'utf8'),
			Buffer.from([30, 0, 0, 0, 0, 0, 0, 0]), // fileMetaLen
			Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), // fileMetaCount
			Buffer.from([5]), // filenameLen
			Buffer.from('a.txt', 'utf8'),
			Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]), // contentsLen
			Buffer.from([101, 0, 0, 0, 0, 0, 0, 0]), // contentsIndex (absolute)
			Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]), // fileDataLen
		])
		expect(header.length).toBe(101)
		expect(header.equals(expected)).toBe(true)
	})

	it('matches the hand-computed byte fixture for a 0-file archive with empty metadata', () => {
		const header = buildSngHeader([], new Map(), sequentialMask())

		// Hand-computed: metadataLen = 8; fileMetaLen = 8; headerSize = 26 + 8 + 8 + 8 + 8 + 8 = 66
		const expected = Buffer.concat([
			Buffer.from('SNGPKG', 'latin1'),
			Buffer.from([1, 0, 0, 0]),
			sequentialMask(),
			Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]), // metadataLen
			Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // metadataCount
			Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]), // fileMetaLen
			Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // fileMetaCount
			Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // fileDataLen
		])
		expect(header.length).toBe(66)
		expect(header.equals(expected)).toBe(true)
	})

	it('chains absolute contentsIndex offsets across a 3-file archive', () => {
		// Hand-computed: fileMetaLen = 8 + (1+1+16) + (1+2+16) + (1+3+16) = 65;
		// headerSize = 26 + 8 + 8 + 8 + 65 + 8 = 123
		const header = buildSngHeader(
			[{ name: 'a', size: 10 }, { name: 'bb', size: 0 }, { name: 'ccc', size: 256 }],
			new Map(),
			sequentialMask(),
		)
		expect(header.length).toBe(123)
		expect(header.readBigUInt64LE(26)).toBe(8n) // metadataLen
		expect(header.readBigUInt64LE(42)).toBe(65n) // fileMetaLen
		expect(header.readBigUInt64LE(50)).toBe(3n) // fileMetaCount
		// Entry 1 ('a', 10 bytes) at offset 58
		expect(header.readInt8(58)).toBe(1)
		expect(header.readBigUInt64LE(60)).toBe(10n)
		expect(header.readBigUInt64LE(68)).toBe(123n) // first file starts right after the header
		// Entry 2 ('bb', 0 bytes) at offset 76
		expect(header.readInt8(76)).toBe(2)
		expect(header.readBigUInt64LE(79)).toBe(0n)
		expect(header.readBigUInt64LE(87)).toBe(133n) // 123 + 10
		// Entry 3 ('ccc', 256 bytes) at offset 95
		expect(header.readInt8(95)).toBe(3)
		expect(header.readBigUInt64LE(99)).toBe(256n)
		expect(header.readBigUInt64LE(107)).toBe(133n) // 133 + 0
		// fileDataLen at offset 115
		expect(header.readBigUInt64LE(115)).toBe(266n)
	})

	it('uses UTF-8 byte lengths for names and metadata, never String.length', () => {
		const name = '東方.txt' // 4 chars + suffix, but 10 UTF-8 bytes
		const header = buildSngHeader([{ name, size: 1 }], new Map([['name', 'Fábio']]), sequentialMask())
		// metadataLen = 8 + (4 + 4 + 4 + 6) = 26 ('Fábio' is 6 UTF-8 bytes)
		expect(header.readBigUInt64LE(26)).toBe(26n)
		// fileMetaLen = 8 + (1 + 10 + 16) = 35
		expect(header.readBigUInt64LE(26 + 8 + 26)).toBe(35n)
		// filenameLen prefix is the byte length
		expect(header.readInt8(26 + 8 + 26 + 8 + 8)).toBe(10)
	})

	it('rejects filenames longer than 127 UTF-8 bytes, naming the file', () => {
		const longName = 'x'.repeat(128)
		expect(() => buildSngHeader([{ name: longName, size: 1 }], new Map(), sequentialMask())).toThrow(longName)
		// 127 bytes is fine
		expect(() => buildSngHeader([{ name: 'x'.repeat(127), size: 1 }], new Map(), sequentialMask())).not.toThrow()
		// The limit is bytes, not chars: 43 chars of '東' are 129 bytes
		expect(() => buildSngHeader([{ name: '東'.repeat(43), size: 1 }], new Map(), sequentialMask())).toThrow()
	})

	it('hard-rejects metadata keys containing =, ;, or newlines', () => {
		for (const badKey of ['a=b', 'a;b', 'a\nb', 'a\rb']) {
			expect(() => buildSngHeader([], new Map([[badKey, 'value']]), sequentialMask())).toThrow(/Invalid \.sng metadata key/)
		}
	})

	it('rejects unsanitized metadata values containing newlines', () => {
		expect(() => buildSngHeader([], new Map([['key', 'line1\nline2']]), sequentialMask())).toThrow(/newline/)
	})

	it('skips empty metadata keys and values', () => {
		const header = buildSngHeader([], new Map([['', 'value'], ['key', ''], ['kept', 'yes']]), sequentialMask())
		expect(header.readBigUInt64LE(34)).toBe(1n) // metadataCount: only 'kept'
	})
})

describe('packSngToFile', () => {
	it('masks with a per-file index reset and the i=256 wraparound', async () => {
		// Zero-filled plaintext makes the masked bytes equal the keystream itself
		const destPath = path.join(testDir, 'masking.sng')
		await packSngToFile(
			[packEntry('first.bin', Buffer.alloc(300)), packEntry('second.bin', Buffer.alloc(20))],
			new Map(),
			destPath,
		)

		const raw = await fs.promises.readFile(destPath)
		const mask = raw.subarray(10, 26)
		const metadataLen = Number(raw.readBigUInt64LE(26))
		const fileMetaLen = Number(raw.readBigUInt64LE(26 + 8 + metadataLen))
		const dataStart = 26 + 8 + metadataLen + 8 + fileMetaLen + 8

		const keystream = (i: number) => mask[i % 16] ^ (i % 256)

		// Whole first file follows the known-answer formula
		for (let i = 0; i < 300; i++) {
			expect(raw[dataStart + i]).toBe(keystream(i))
		}
		// i=256 wraparound: the cyclic index returns to 0
		expect(raw[dataStart + 256]).toBe(mask[0] ^ 0)
		expect(raw[dataStart + 257]).toBe(mask[1] ^ 1)
		// Per-file reset: the second file's keystream starts from index 0 again
		for (let i = 0; i < 20; i++) {
			expect(raw[dataStart + 300 + i]).toBe(keystream(i))
		}
	})

	it('round-trips non-ASCII metadata, non-ASCII filenames, and nested paths through parse-sng', async () => {
		const destPath = path.join(testDir, 'roundtrip.sng')
		const noteData = Buffer.from('note data here', 'utf8')
		const nestedData = Buffer.from([0, 1, 2, 250, 251, 252])
		const unicodeData = Buffer.from('こんにちは', 'utf8')
		const metadata = new Map([
			['name', '東方Project — “Fábio’s” chart'],
			['artist', 'Zuñiga'],
			['charter', 'Tester'],
		])

		await packSngToFile(
			[
				packEntry('notes.chart', noteData),
				packEntry('sub/dir/nested.bin', nestedData),
				packEntry('Fábio – 東方.txt', unicodeData),
			],
			metadata,
			destPath,
		)

		const { header, files } = await parseSngArchive(destPath)
		expect(header.metadata).toEqual(Object.fromEntries(metadata))
		expect(files.size).toBe(3)
		expect(files.get('notes.chart')?.equals(noteData)).toBe(true)
		expect(files.get('sub/dir/nested.bin')?.equals(nestedData)).toBe(true)
		expect(files.get('Fábio – 東方.txt')?.equals(unicodeData)).toBe(true)
	})

	it('returns a manifest with the md5 of the plain contents', async () => {
		const destPath = path.join(testDir, 'manifest.sng')
		const data = Buffer.from('hello world', 'utf8')
		const manifest = await packSngToFile([packEntry('file.txt', data)], new Map(), destPath)
		expect(manifest.size).toBe(1)
		// md5('hello world')
		expect(manifest.get('file.txt')).toEqual({ size: 11, md5: '5eb63bbbe01eeed093cb22bb8f5acdc3' })
	})

	it('excludes junk files, nested .sng archives, __MACOSX entries, and song.ini', async () => {
		const destPath = path.join(testDir, 'junk.sng')
		await packSngToFile(
			[
				packEntry('notes.chart', 'chart'),
				packEntry('desktop.ini', 'junk'),
				packEntry('.DS_Store', 'junk'),
				packEntry('ps.dat', 'junk'),
				packEntry('ch.dat', 'junk'),
				packEntry('__MACOSX/album.png', 'junk'),
				packEntry('nested.sng', 'junk'),
				packEntry('song.ini', '[song]\nname = X\n'),
			],
			new Map([['name', 'X']]),
			destPath,
		)
		const { files } = await parseSngArchive(destPath)
		expect([...files.keys()]).toEqual(['notes.chart'])
	})

	it('lowercases known chart filenames but leaves unknown names alone', async () => {
		const destPath = path.join(testDir, 'lowercase.sng')
		await packSngToFile(
			[
				packEntry('Notes.Chart', 'chart'),
				packEntry('Album.PNG', 'image'),
				packEntry('GUITAR.OGG', 'audio'),
				packEntry('MyCustomFile.TXT', 'other'),
			],
			new Map(),
			destPath,
		)
		const { files } = await parseSngArchive(destPath)
		expect([...files.keys()].sort()).toEqual(['MyCustomFile.TXT', 'album.png', 'guitar.ogg', 'notes.chart'])
	})

	it('rejects entries whose actual size differs from the declared size', async () => {
		const destPath = path.join(testDir, 'badsize.sng')
		const entry = { ...packEntry('file.bin', 'four'), size: 99 }
		await expect(packSngToFile([entry], new Map(), destPath)).rejects.toThrow(/changed size/)
	})
})

describe('normalizeSngFilename', () => {
	it('normalizes backslashes to forward slashes', () => {
		expect(normalizeSngFilename('sub\\dir\\file.bin')).toBe('sub/dir/file.bin')
	})

	it('lowercases only the basename of known files in nested paths', () => {
		expect(normalizeSngFilename('Sub/NOTES.CHART')).toBe('Sub/notes.chart')
		expect(normalizeSngFilename('Sub/Other.TXT')).toBe('Sub/Other.TXT')
	})
})

describe('isExcludedFromSngPack', () => {
	it('flags junk, nested archives, and song.ini case-insensitively', () => {
		expect(isExcludedFromSngPack('Desktop.INI')).toBe(true)
		expect(isExcludedFromSngPack('song.ini')).toBe(true)
		expect(isExcludedFromSngPack('SONG.INI')).toBe(true)
		expect(isExcludedFromSngPack('sub/inner.sng')).toBe(true)
		expect(isExcludedFromSngPack('__MACOSX/._album.png')).toBe(true)
		expect(isExcludedFromSngPack('notes.chart')).toBe(false)
		expect(isExcludedFromSngPack('sub/song.ini')).toBe(false) // Only the top-level song.ini is the metadata carrier
	})
})

describe('sanitizeSngMetadata', () => {
	it('hard-rejects invalid keys, naming the key', () => {
		expect(() => sanitizeSngMetadata(new Map([['bad=key', 'v']]))).toThrow('bad=key')
		expect(() => sanitizeSngMetadata(new Map([['bad;key', 'v']]))).toThrow('bad;key')
	})

	it('strips newlines from values and reports the modification', () => {
		const { metadata, modifications } = sanitizeSngMetadata(new Map([['loading_phrase', 'line one\r\nline two']]))
		expect(metadata.get('loading_phrase')).toBe('line one line two')
		expect(modifications).toHaveLength(1)
		expect(modifications[0]).toContain('loading_phrase')
	})

	it('passes clean values through unchanged with no modifications reported', () => {
		const { metadata, modifications } = sanitizeSngMetadata(new Map([['name', 'Fine Value']]))
		expect(metadata.get('name')).toBe('Fine Value')
		expect(modifications).toEqual([])
	})

	it('skips empty keys and values', () => {
		const { metadata } = sanitizeSngMetadata(new Map([['', 'v'], ['key', ''], ['kept', 'yes']]))
		expect([...metadata.keys()]).toEqual(['kept'])
	})
})
