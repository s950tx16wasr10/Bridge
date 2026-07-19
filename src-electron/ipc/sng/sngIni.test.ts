import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { packSngToFile } from './SngPacker.js'
import { readSngFiles } from './SngReader.js'
import { foldSongIni, unfoldSongIni } from './sngIni.js'
import { packEntry } from './sngTestUtils.js'

let testDir: string

beforeAll(async () => {
	testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-sng-ini-test-'))
})

afterAll(async () => {
	await fs.promises.rm(testDir, { recursive: true, force: true })
})

describe('foldSongIni', () => {
	it('parses simple key = value pairs from the [song] section', () => {
		const metadata = foldSongIni('[song]\nname = Test\nartist = Someone\n')
		expect(metadata.get('name')).toBe('Test')
		expect(metadata.get('artist')).toBe('Someone')
	})

	it('strips a leading BOM', () => {
		const metadata = foldSongIni('﻿[song]\nname = Test\n')
		expect(metadata.get('name')).toBe('Test')
	})

	it('tolerates CRLF line endings', () => {
		const metadata = foldSongIni('[song]\r\nname = Test\r\nartist = Someone\r\n')
		expect(metadata.get('name')).toBe('Test')
		expect(metadata.get('artist')).toBe('Someone')
	})

	it('matches the [song] section header case-insensitively', () => {
		expect(foldSongIni('[Song]\nname = A\n').get('name')).toBe('A')
		expect(foldSongIni('[SONG]\nname = B\n').get('name')).toBe('B')
	})

	it('ignores comment lines', () => {
		const metadata = foldSongIni('[song]\n; a comment\n# another\n// and another\nname = Test\n')
		expect(metadata.size).toBe(1)
		expect(metadata.get('name')).toBe('Test')
	})

	it('drops keys from other sections', () => {
		const metadata = foldSongIni('[other]\nbefore = 1\n[song]\nname = Test\n[second]\nafter = 2\n')
		expect(metadata.size).toBe(1)
		expect(metadata.get('name')).toBe('Test')
	})

	it('ignores lines without = and skips empty keys', () => {
		const metadata = foldSongIni('[song]\nnot a pair\n= orphan value\nname = Test\n')
		expect(metadata.size).toBe(1)
	})

	it('preserves values containing = signs', () => {
		const metadata = foldSongIni('[song]\nloading_phrase = a = b = c\n')
		expect(metadata.get('loading_phrase')).toBe('a = b = c')
	})
})

describe('unfoldSongIni', () => {
	it('generates parse-sng ini format: [song] header plus key = value lines', () => {
		const text = unfoldSongIni(new Map([['name', 'Test'], ['artist', 'Someone']]))
		expect(text).toBe('[song]\nname = Test\nartist = Someone\n')
	})

	it('drops keys whose values equal the parse-sng reader defaults (documented lossiness)', () => {
		const text = unfoldSongIni(new Map([
			['name', 'Unknown Name'], // equals the default → dropped
			['album_track', '16000'], // equals the default → dropped
			['artist', 'Real Artist'],
		]))
		expect(text).toBe('[song]\nartist = Real Artist\n')
	})

	it('drops empty values for known keys (documented lossiness)', () => {
		const text = unfoldSongIni(new Map([['icon', ''], ['name', 'Test']]))
		expect(text).toBe('[song]\nname = Test\n')
	})

	it('orders known keys in parse-sng order before unknown keys', () => {
		const text = unfoldSongIni(new Map([['custom_key', 'v'], ['charter', 'C'], ['name', 'N']]))
		expect(text).toBe('[song]\nname = N\ncharter = C\ncustom_key = v\n')
	})

	it('fold(unfold(m)) round-trips everything except reader-default values', () => {
		const original = new Map([
			['name', 'Kept'],
			['diff_guitar', '-1'], // default → lost, resurrects at read time
			['custom', 'also kept'],
		])
		const roundTripped = foldSongIni(unfoldSongIni(original))
		expect(roundTripped.get('name')).toBe('Kept')
		expect(roundTripped.get('custom')).toBe('also kept')
		expect(roundTripped.has('diff_guitar')).toBe(false)
	})

	it('matches the song.ini text parse-sng itself generates from a packed archive (oracle)', async () => {
		const metadata = new Map([
			['name', '東方Project'],
			['artist', 'Fábio'],
			['charter', 'Tester'],
			['custom_tag', 'value'],
		])
		const archivePath = path.join(testDir, 'ini-oracle.sng')
		await packSngToFile([packEntry('notes.chart', 'x')], metadata, archivePath)

		const files = await readSngFiles(archivePath)
		const generatedIni = Buffer.from(files.find(f => f.fileName === 'song.ini')!.data).toString('utf8')
		expect(unfoldSongIni(metadata)).toBe(generatedIni)
		// And folding parse-sng's generated ini returns the original metadata
		expect(Object.fromEntries(foldSongIni(generatedIni))).toEqual(Object.fromEntries(metadata))
	})
})
