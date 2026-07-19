import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ChartWorkspace resolves its temp dir from the electron-backed Paths module
vi.mock('../../../src-shared/Paths.js', async () => {
	const osModule = await import('os')
	const pathModule = await import('path')
	const dataPath = pathModule.join(osModule.tmpdir(), `bridge-sng-ws-test-${process.pid}`)
	return {
		dataPath,
		libraryPath: pathModule.join(dataPath, 'library.db'),
		settingsPath: pathModule.join(dataPath, 'settings.json'),
		tempPath: pathModule.join(dataPath, 'temp'),
		themesPath: pathModule.join(dataPath, 'themes'),
	}
})

// The commit scan fence lazily imports the scanner, which pulls in the catalog database
vi.mock('../catalog/ChartScanner.js', () => ({
	getChartScanner: () => ({
		isScanning: () => false,
		whenScanIdle: () => Promise.resolve(),
	}),
}))

import { dataPath, tempPath } from '../../../src-shared/Paths.js'
import { openChartWorkspace, sweepSngTempArtifacts } from './ChartWorkspace.js'
import { packSngToFile } from './SngPacker.js'
import { MINIMAL_CHART, packEntry, parseSngArchive } from './sngTestUtils.js'

let libraryDir: string

beforeEach(async () => {
	libraryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-sng-ws-lib-'))
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.promises.rm(libraryDir, { recursive: true, force: true })
})

afterAll(async () => {
	await fs.promises.rm(dataPath, { recursive: true, force: true })
})

async function createTestArchive(fileName = 'test.sng', chartData: string = MINIMAL_CHART): Promise<string> {
	const archivePath = path.join(libraryDir, fileName)
	await packSngToFile(
		[
			packEntry('notes.chart', chartData),
			packEntry('song.ogg', 'OggS fake audio bytes'),
			packEntry('album.png', 'fake png bytes'),
		],
		new Map([['name', 'Test Song'], ['artist', 'Test Artist'], ['charter', 'Tester']]),
		archivePath,
	)
	return archivePath
}

async function renameSongInWorkspace(dir: string, from: string, to: string): Promise<void> {
	const iniPath = path.join(dir, 'song.ini')
	const iniText = await fs.promises.readFile(iniPath, 'utf8')
	await fs.promises.writeFile(iniPath, iniText.replace(from, to))
}

describe('openChartWorkspace (.sng backend)', () => {
	it('extracts the archive, including a synthesized song.ini', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		try {
			expect(ws.isSng).toBe(true)
			expect((await fs.promises.readFile(path.join(ws.dir, 'notes.chart'), 'utf8'))).toBe(MINIMAL_CHART)
			expect((await fs.promises.readFile(path.join(ws.dir, 'song.ini'), 'utf8'))).toContain('name = Test Song')
			expect(fs.existsSync(path.join(ws.dir, 'song.ogg'))).toBe(true)
		} finally {
			await ws.discard()
		}
	})

	it('fails fast when the chart is already being edited, and releases the lock on discard', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		try {
			await expect(openChartWorkspace(archivePath)).rejects.toThrow(/another operation/)
		} finally {
			await ws.discard()
		}
		const ws2 = await openChartWorkspace(archivePath)
		await ws2.discard()
	})

	it('releases the lock when open() itself fails', async () => {
		const missingPath = path.join(libraryDir, 'missing.sng')
		await expect(openChartWorkspace(missingPath)).rejects.toThrow()
		// A second attempt hits the same ENOENT, not the lock
		const secondError = await openChartWorkspace(missingPath).then(() => null, err => err as Error)
		expect(secondError).not.toBeNull()
		expect(secondError!.message).not.toContain('another operation')
	})
})

describe('commit', () => {
	it('returns { changed: false } from the no-change gate and leaves the archive untouched', async () => {
		const archivePath = await createTestArchive()
		const before = await fs.promises.readFile(archivePath)
		const ws = await openChartWorkspace(archivePath)
		try {
			expect(await ws.commit()).toEqual({ changed: false })
			expect((await fs.promises.readFile(archivePath)).equals(before)).toBe(true)
		} finally {
			await ws.discard()
		}
	})

	it('detects a one-byte change and repacks; an untouched reopen reports no change', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		try {
			await renameSongInWorkspace(ws.dir, 'Test Song', 'Renamed Song')
			const result = await ws.commit()
			expect(result.changed).toBe(true)
		} finally {
			await ws.discard()
		}

		// The replaced archive re-parses with the app's own reader and reflects the edit
		const { header, files } = await parseSngArchive(archivePath)
		expect(header.metadata['name']).toBe('Renamed Song')
		expect(header.metadata['artist']).toBe('Test Artist')
		expect(files.get('notes.chart')!.toString('utf8')).toBe(MINIMAL_CHART)

		// A fresh workspace with no edits hits the no-change gate
		const ws2 = await openChartWorkspace(archivePath)
		try {
			expect(await ws2.commit()).toEqual({ changed: false })
		} finally {
			await ws2.discard()
		}
	})

	it('packs newly added files into the archive', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		try {
			await fs.promises.writeFile(path.join(ws.dir, 'background.png'), 'fake background bytes')
			expect((await ws.commit()).changed).toBe(true)
		} finally {
			await ws.discard()
		}
		const { files } = await parseSngArchive(archivePath)
		expect(files.get('background.png')!.toString('utf8')).toBe('fake background bytes')
	})

	it('refuses to commit when the archive was modified externally mid-edit', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		try {
			await fs.promises.appendFile(archivePath, Buffer.from([1, 2, 3]))
			await fs.promises.writeFile(path.join(ws.dir, 'newfile.txt'), 'x')
			await expect(ws.commit()).rejects.toThrow(/outside Bridge/)
		} finally {
			await ws.discard()
		}
	})

	it('refuses an edit that corrupts the chart (differential validate) and keeps the original', async () => {
		const archivePath = await createTestArchive()
		const before = await fs.promises.readFile(archivePath)
		const ws = await openChartWorkspace(archivePath)
		try {
			await fs.promises.writeFile(path.join(ws.dir, 'notes.chart'), 'garbage, not a chart')
			await expect(ws.commit()).rejects.toThrow(/Commit refused/)
		} finally {
			await ws.discard()
		}
		expect((await fs.promises.readFile(archivePath)).equals(before)).toBe(true)
	})

	it('still allows editing a chart that was already broken (the gate is differential, not absolute)', async () => {
		const archivePath = await createTestArchive('broken.sng', 'garbage, not a chart')
		const ws = await openChartWorkspace(archivePath)
		try {
			await renameSongInWorkspace(ws.dir, 'Test Song', 'Still Broken, Renamed')
			expect((await ws.commit()).changed).toBe(true)
		} finally {
			await ws.discard()
		}
		const { header } = await parseSngArchive(archivePath)
		expect(header.metadata['name']).toBe('Still Broken, Renamed')
	})

	it('throws after discard', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		await ws.discard()
		await expect(ws.commit()).rejects.toThrow(/discarded/)
	})
})

describe('the replace state machine (failure injection)', () => {
	const ebusyError = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })

	it('keeps the original and deletes .bridge-new when every rename attempt fails', async () => {
		const archivePath = await createTestArchive()
		const before = await fs.promises.readFile(archivePath)
		const ws = await openChartWorkspace(archivePath)
		try {
			await renameSongInWorkspace(ws.dir, 'Test Song', 'Never Lands')
			const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(ebusyError())
			await expect(ws.commit()).rejects.toThrow(/EBUSY/)
			expect(renameSpy).toHaveBeenCalledTimes(3)
			renameSpy.mockRestore()
		} finally {
			await ws.discard()
		}
		// Original intact, never absent, no stray artifact
		expect((await fs.promises.readFile(archivePath)).equals(before)).toBe(true)
		expect(fs.existsSync(`${archivePath}.bridge-new`)).toBe(false)
	}, 15000)

	it('retries a transient EBUSY rename and then commits', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		try {
			await renameSongInWorkspace(ws.dir, 'Test Song', 'Second Try')
			const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(ebusyError())
			expect((await ws.commit()).changed).toBe(true)
			expect(renameSpy).toHaveBeenCalledTimes(2)
		} finally {
			await ws.discard()
		}
		const { header } = await parseSngArchive(archivePath)
		expect(header.metadata['name']).toBe('Second Try')
		expect(fs.existsSync(`${archivePath}.bridge-new`)).toBe(false)
	}, 15000)

	it('does not retry non-EBUSY rename errors', async () => {
		const archivePath = await createTestArchive()
		const before = await fs.promises.readFile(archivePath)
		const ws = await openChartWorkspace(archivePath)
		try {
			await renameSongInWorkspace(ws.dir, 'Test Song', 'Never Lands')
			const enoentError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
			const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(enoentError)
			await expect(ws.commit()).rejects.toThrow(/ENOENT/)
			expect(renameSpy).toHaveBeenCalledTimes(1)
			renameSpy.mockRestore()
		} finally {
			await ws.discard()
		}
		expect((await fs.promises.readFile(archivePath)).equals(before)).toBe(true)
		expect(fs.existsSync(`${archivePath}.bridge-new`)).toBe(false)
	})

	it('keeps the original when the copy to .bridge-new fails', async () => {
		const archivePath = await createTestArchive()
		const before = await fs.promises.readFile(archivePath)
		const ws = await openChartWorkspace(archivePath)
		try {
			await renameSongInWorkspace(ws.dir, 'Test Song', 'No Space')
			const copySpy = vi.spyOn(fs.promises, 'copyFile')
				.mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
			await expect(ws.commit()).rejects.toThrow(/ENOSPC/)
			copySpy.mockRestore()
		} finally {
			await ws.discard()
		}
		expect((await fs.promises.readFile(archivePath)).equals(before)).toBe(true)
		expect(fs.existsSync(`${archivePath}.bridge-new`)).toBe(false)
	})
})

describe('discard', () => {
	it('removes the workspace dir and any packed sibling artifacts, and never throws', async () => {
		const archivePath = await createTestArchive()
		const ws = await openChartWorkspace(archivePath)
		await renameSongInWorkspace(ws.dir, 'Test Song', 'Discard Me')
		await ws.commit() // Creates tempPath/sng-<id>.sng

		const workspaceId = path.basename(ws.dir) // 'sng-<12 hex>'
		await ws.discard()

		expect(fs.existsSync(ws.dir)).toBe(false)
		const tempEntries = await fs.promises.readdir(tempPath)
		expect(tempEntries.filter(entry => entry.startsWith(workspaceId))).toEqual([])

		// Discard is idempotent
		await ws.discard()
	})
})

describe('folder backend', () => {
	it('passes the chart folder through and trivially reports changed', async () => {
		const folderPath = path.join(libraryDir, 'folder-chart')
		await fs.promises.mkdir(folderPath)
		await fs.promises.writeFile(path.join(folderPath, 'notes.chart'), MINIMAL_CHART)

		const ws = await openChartWorkspace(folderPath)
		try {
			expect(ws.isSng).toBe(false)
			expect(ws.dir).toBe(folderPath)
			await expect(openChartWorkspace(folderPath)).rejects.toThrow(/another operation/)
			expect(await ws.commit()).toEqual({ changed: true })
		} finally {
			await ws.discard()
		}

		// Folder contents are untouched (no temp extraction happened)
		expect(await fs.promises.readdir(folderPath)).toEqual(['notes.chart'])
	})
})

describe('sweepSngTempArtifacts', () => {
	it('removes only Bridge-owned sng-* artifacts older than 24 hours', async () => {
		await fs.promises.mkdir(tempPath, { recursive: true })
		const oldDir = path.join(tempPath, 'sng-aaaaaaaaaaaa')
		const oldFile = path.join(tempPath, 'sng-bbbbbbbbbbbb.sng')
		const freshDir = path.join(tempPath, 'sng-cccccccccccc')
		const unrelatedFile = path.join(tempPath, 'unrelated.txt')

		await fs.promises.mkdir(oldDir, { recursive: true })
		await fs.promises.writeFile(path.join(oldDir, 'leftover.bin'), 'x')
		await fs.promises.writeFile(oldFile, 'x')
		await fs.promises.mkdir(freshDir, { recursive: true })
		await fs.promises.writeFile(unrelatedFile, 'x')

		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
		await fs.promises.utimes(oldDir, twoDaysAgo, twoDaysAgo)
		await fs.promises.utimes(oldFile, twoDaysAgo, twoDaysAgo)

		await sweepSngTempArtifacts()

		expect(fs.existsSync(oldDir)).toBe(false)
		expect(fs.existsSync(oldFile)).toBe(false)
		expect(fs.existsSync(freshDir)).toBe(true)
		expect(fs.existsSync(unrelatedFile)).toBe(true)

		await fs.promises.rm(freshDir, { recursive: true, force: true })
		await fs.promises.rm(unrelatedFile, { force: true })
	})
})
