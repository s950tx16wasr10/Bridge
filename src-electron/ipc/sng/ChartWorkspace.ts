/**
 * The .sng edit lifecycle: per-chart-path locks, extract → edit → validate →
 * repack → verify → atomically replace, plus crash-recovery sweeps.
 * See docs/sng-write-support-design.md §4/§5/§7.
 *
 * VALIDATE + PACK + VERIFY run on the main process with chunked processing and
 * `setImmediate` yields between files (the design's sanctioned fallback to
 * worker_threads, chosen for build simplicity). `scanChartFolder` itself is a
 * synchronous call that cannot yield internally; everything around it does.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { SngHeader, SngStream } from 'parse-sng'
import { scanChartFolder, ScannedChart } from 'scan-chart'
import { Readable } from 'stream'

import { tempPath } from '../../../src-shared/Paths.js'
import { hasAlbumName, hasChartExtension, hasIniExtension } from '../../../src-shared/UtilFunctions.js'
import { foldSongIni } from './sngIni.js'
import { ChartWorkspace, SngCommitResult, SngManifest, SngPackEntry } from './sng.interface.js'
import { packSngToFile, sanitizeSngMetadata } from './SngPacker.js'
import { extractSngToDir } from './SngReader.js'

export type { ChartWorkspace, SngCommitResult } from './sng.interface.js'

/** Mirrors ChartScanner's CONFIG.MAX_FILE_SIZE_BYTES (2GB). */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024
/** Mirrors ElectronUtilFunctions.hasVideoExtension (not imported: that module pulls in main.js/electron). */
const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.webm', '.ogv', '.mpeg']
/** folderIssues that never block a commit (mirrors the benign set in UtilFunctions.hasIssues); any other NEW issue type is a regression. */
const BENIGN_FOLDER_ISSUES = ['albumArtSize', 'invalidIni', 'multipleVideo', 'badIniLine']

const SCAN_WAIT_TIMEOUT_MS = 5 * 60 * 1000
const RENAME_RETRIES = 3
const RENAME_RETRY_DELAY_MS = 500
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Per-chart-path locks, held open() → discard(). In-process only; the lock dies with the process. */
const activeLocks = new Set<string>()

function getLockKey(chartPath: string): string {
	const resolved = path.resolve(chartPath)
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function acquireLock(lockKey: string): void {
	if (activeLocks.has(lockKey)) {
		throw new Error('This chart is being edited by another operation.')
	}
	activeLocks.add(lockKey)
}

function releaseLock(lockKey: string): void {
	activeLocks.delete(lockKey)
}

function hasVideoExtension(name: string): boolean {
	return VIDEO_EXTENSIONS.includes(path.parse(name.toLowerCase()).ext)
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Opens an edit workspace for `chartPath` and acquires its per-path lock.
 *
 * Folder charts get a passthrough workspace (`dir` is the chart folder itself);
 * `.sng` archives are extracted to a temp directory and repacked on commit().
 * Callers must `await ws.discard()` in a `finally` block.
 */
export async function openChartWorkspace(chartPath: string): Promise<ChartWorkspace> {
	const lockKey = getLockKey(chartPath)
	acquireLock(lockKey)

	if (!chartPath.toLowerCase().endsWith('.sng')) {
		return new FolderWorkspace(chartPath, lockKey)
	}

	try {
		await fs.promises.mkdir(tempPath, { recursive: true })

		const archiveStat = await fs.promises.stat(chartPath)
		await checkDiskSpace(chartPath, archiveStat.size)

		const id = crypto.randomBytes(6).toString('hex')
		const dir = path.join(tempPath, `sng-${id}`)
		try {
			const manifest = await extractSngToDir(chartPath, dir)
			const baseline = await scanWorkspaceDir(dir)
			return new SngWorkspace(chartPath, dir, id, lockKey, archiveStat, manifest, baseline)
		} catch (err) {
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
			throw err
		}
	} catch (err) {
		releaseLock(lockKey)
		throw err
	}
}

/**
 * Removes `tempPath/sng-*` workspace dirs and packed artifacts older than 24h
 * (crash leftovers). Called fire-and-forget at app startup. Never throws.
 */
export async function sweepSngTempArtifacts(): Promise<void> {
	try {
		const entries = await fs.promises.readdir(tempPath)
		const now = Date.now()
		for (const entry of entries) {
			if (!/^sng-[0-9a-f]{12}(\..+)?$/.test(entry)) continue
			const fullPath = path.join(tempPath, entry)
			try {
				const stat = await fs.promises.stat(fullPath)
				if (now - stat.mtimeMs > SWEEP_MAX_AGE_MS) {
					await fs.promises.rm(fullPath, { recursive: true, force: true })
				}
			} catch (err) {
				console.error(`Failed to sweep .sng temp artifact "${fullPath}":`, err)
			}
		}
	} catch {
		// Temp dir doesn't exist yet; nothing to sweep
	}
}

class FolderWorkspace implements ChartWorkspace {
	readonly isSng = false
	private open = true

	constructor(readonly dir: string, private lockKey: string) { }

	/** Folder charts write in place; commit() diffs nothing (handlers still gate on service success). */
	async commit(): Promise<SngCommitResult> {
		if (!this.open) throw new Error('This chart workspace has already been discarded.')
		return { changed: true }
	}

	async discard(): Promise<void> {
		if (!this.open) return
		this.open = false
		releaseLock(this.lockKey)
	}
}

class SngWorkspace implements ChartWorkspace {
	readonly isSng = true
	private open = true

	constructor(
		private chartPath: string,
		readonly dir: string,
		private id: string,
		private lockKey: string,
		private archiveStat: fs.Stats,
		private openManifest: SngManifest,
		private baseline: ScannedChart,
	) { }

	async commit(): Promise<SngCommitResult> {
		if (!this.open) throw new Error('This chart workspace has already been discarded.')

		// 0. No-change gate: re-walk ws.dir against the open() manifest
		const currentManifest = await computeDirManifest(this.dir)
		if (manifestsEqual(currentManifest, this.openManifest)) {
			return { changed: false }
		}

		// External-modification check (Clone Hero or a file manager touching the archive mid-edit)
		const stat = await fs.promises.stat(this.chartPath)
		if (stat.size !== this.archiveStat.size || stat.mtimeMs !== this.archiveStat.mtimeMs) {
			throw new Error('This chart was modified outside Bridge while editing; commit refused.')
		}

		// 0.5. Scan fence: wait for a running full library scan (bounded)
		await waitForScanIdle()

		// 1. Validate differentially against the open() baseline. scanChartFolder
		// reports problems in its return value rather than throwing.
		const current = await scanWorkspaceDir(this.dir)
		assertNoRegression(this.baseline, current)

		// 2. PACK to a temp artifact (streaming, chunked XOR/md5)
		let metadata = new Map<string, string>()
		try {
			metadata = foldSongIni(await fs.promises.readFile(path.join(this.dir, 'song.ini'), 'utf8'))
		} catch {
			// No song.ini in the workspace; pack with empty metadata
		}
		const { metadata: sanitizedMetadata, modifications } = sanitizeSngMetadata(metadata)
		const entries = await buildPackEntries(this.dir)
		const packedPath = path.join(tempPath, `sng-${this.id}.sng`)
		const packedManifest = await packSngToFile(entries, sanitizedMetadata, packedPath)

		// 3. VERIFY: re-parse the packed file with parse-sng (the app's own reader)
		await verifyPackedArchive(packedPath, packedManifest, sanitizedMetadata)

		// 4. REPLACE: copy → fsync → single atomic rename over the original
		await this.replaceArchive(packedPath)

		return { changed: true, modifications: modifications.length > 0 ? modifications : undefined }
	}

	async discard(): Promise<void> {
		if (!this.open) return
		this.open = false
		try {
			await fs.promises.rm(this.dir, { recursive: true, force: true })
		} catch (err) {
			console.error(`Failed to remove .sng workspace dir "${this.dir}" (will be swept at startup):`, err)
		}
		try {
			// The packed artifact lives outside the workspace dir: tempPath/sng-<id>.*
			const entries = await fs.promises.readdir(tempPath)
			for (const entry of entries) {
				if (!entry.startsWith(`sng-${this.id}.`)) continue
				await fs.promises.rm(path.join(tempPath, entry), { recursive: true, force: true })
					.catch(err => console.error(`Failed to remove .sng temp artifact "${entry}" (will be swept at startup):`, err))
			}
		} catch (err) {
			console.error('Failed to enumerate .sng temp artifacts:', err)
		}
		releaseLock(this.lockKey)
	}

	private async replaceArchive(packedPath: string): Promise<void> {
		const bridgeNewPath = `${this.chartPath}.bridge-new`
		try {
			// Copy to the chart's own directory (same volume) so the rename is atomic
			await fs.promises.copyFile(packedPath, bridgeNewPath)

			// fsync before rename: without this, a power loss after the rename can leave
			// a directory entry pointing at unflushed data
			const fd = await fs.promises.open(bridgeNewPath, 'r+')
			try {
				await fd.sync()
			} finally {
				await fd.close()
			}

			// ONE rename: atomic supersede on the same volume; there is no window where the chart is absent.
			// EBUSY/EPERM = AV/indexer holding the target without FILE_SHARE_DELETE; retried with backoff.
			let lastError: unknown = null
			for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
				if (attempt > 0) await delay(RENAME_RETRY_DELAY_MS)
				try {
					await fs.promises.rename(bridgeNewPath, this.chartPath)
					return
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code
					if (code !== 'EBUSY' && code !== 'EPERM') throw err
					lastError = err
				}
			}
			throw lastError
		} catch (err) {
			// Failure at any point = original untouched; delete the .bridge-new
			await fs.promises.rm(bridgeNewPath, { force: true }).catch(() => { /* swept by the scanner walk */ })
			throw err
		}
	}
}

/**
 * Disk preflight: require ≥ 2.2× the archive size free on the temp volume
 * (extract + packed artifact) and ≥ 1.1× on the chart's volume, before any work.
 * Skipped silently where `fs.statfs` is unavailable.
 */
async function checkDiskSpace(chartPath: string, archiveSize: number): Promise<void> {
	const checks: Array<{ target: string; requiredBytes: number }> = [
		{ target: tempPath, requiredBytes: Math.ceil(archiveSize * 2.2) },
		{ target: path.dirname(chartPath), requiredBytes: Math.ceil(archiveSize * 1.1) },
	]
	for (const { target, requiredBytes } of checks) {
		let freeBytes: number | null = null
		try {
			const stats = await fs.promises.statfs(target)
			freeBytes = Number(stats.bavail) * Number(stats.bsize)
		} catch {
			continue // statfs unsupported or target missing; don't block the edit on the preflight itself
		}
		if (freeBytes < requiredBytes) {
			const requiredGb = (requiredBytes / 1024 / 1024 / 1024).toFixed(2)
			throw new Error(`Not enough disk space to edit this .sng chart: need ~${requiredGb} GB free on "${target}".`)
		}
	}
}

interface WorkspaceFile {
	/** POSIX-relative name ('/'-separated), e.g. 'notes.chart' or 'sub/file.bin'. */
	name: string
	fullPath: string
	size: number
}

/** Recursively walks `dir`, emitting POSIX-relative names so nested files round-trip. */
async function listWorkspaceFiles(dir: string, prefix = ''): Promise<WorkspaceFile[]> {
	const files: WorkspaceFile[] = []
	const entries = await fs.promises.readdir(dir, { withFileTypes: true })
	entries.sort((a, b) => a.name.localeCompare(b.name))
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...await listWorkspaceFiles(fullPath, `${prefix}${entry.name}/`))
		} else if (entry.isFile()) {
			const stat = await fs.promises.stat(fullPath)
			files.push({ name: `${prefix}${entry.name}`, fullPath, size: stat.size })
		}
	}
	return files
}

/**
 * Runs scanChartFolder over the workspace dir the way ChartScanner does:
 * chart/ini/album contents loaded, audio/video/oversized files passed as
 * empty-data placeholders, `includeMd5: false`. The extracted (or edited)
 * `song.ini` is a real file in the dir, so the scan sees the synthesized ini.
 */
async function scanWorkspaceDir(dir: string): Promise<ScannedChart> {
	const files: { fileName: string; data: Uint8Array }[] = []
	for (const file of await listWorkspaceFiles(dir)) {
		const shouldLoad = (hasChartExtension(file.name) || hasIniExtension(file.name) || hasAlbumName(file.name)) &&
			file.size < MAX_FILE_SIZE_BYTES &&
			!hasVideoExtension(file.name)
		if (shouldLoad) {
			files.push({ fileName: file.name, data: await fs.promises.readFile(file.fullPath) })
		} else {
			files.push({ fileName: file.name, data: new Uint8Array() })
		}
		await yieldToEventLoop()
	}
	return scanChartFolder(files, { includeMd5: false, includeBChart: false })
}

async function computeDirManifest(dir: string): Promise<SngManifest> {
	const manifest: SngManifest = new Map()
	for (const file of await listWorkspaceFiles(dir)) {
		manifest.set(file.name, { size: file.size, md5: await md5File(file.fullPath) })
		await yieldToEventLoop()
	}
	return manifest
}

function md5File(filePath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash('md5')
		const stream = fs.createReadStream(filePath)
		stream.on('data', chunk => hash.update(chunk))
		stream.on('error', reject)
		stream.on('end', () => resolve(hash.digest('hex')))
	})
}

function manifestsEqual(a: SngManifest, b: SngManifest): boolean {
	if (a.size !== b.size) return false
	for (const [name, entry] of a) {
		const other = b.get(name)
		if (!other || other.size !== entry.size || other.md5 !== entry.md5) return false
	}
	return true
}

/** If a full library scan is running, wait for it (bounded); refusing would throw away completed work. */
async function waitForScanIdle(): Promise<void> {
	// Imported lazily: ChartScanner pulls in the catalog database, which unit tests mock out
	const { getChartScanner } = await import('../catalog/ChartScanner.js')
	const scanner = getChartScanner()
	if (!scanner.isScanning()) return

	console.log('Waiting for the library scan to finish before repacking the .sng archive...')
	let timer: NodeJS.Timeout | undefined
	try {
		await Promise.race([
			scanner.whenScanIdle(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out waiting for the library scan to finish; try again after the scan completes.')), SCAN_WAIT_TIMEOUT_MS)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

/**
 * The differential validation gate: refuse only regressions relative to the
 * open() baseline. A chart that was already broken stays editable (the edit
 * may be the repair), and placeholder-induced issues exist in the baseline
 * too, so they never trip it.
 */
function assertNoRegression(baseline: ScannedChart, current: ScannedChart): void {
	if (baseline.notesData && !current.notesData) {
		throw new Error('Commit refused: the chart data no longer parses after this edit.')
	}
	if (baseline.playable && !current.playable) {
		throw new Error('Commit refused: the chart would no longer be playable after this edit.')
	}
	const baselineIssues = new Set(baseline.folderIssues.map(issue => issue.folderIssue))
	for (const issue of current.folderIssues) {
		if (!BENIGN_FOLDER_ISSUES.includes(issue.folderIssue) && !baselineIssues.has(issue.folderIssue)) {
			throw new Error(`Commit refused: this edit introduces a new chart issue (${issue.folderIssue}: ${issue.description})`)
		}
	}
}

async function buildPackEntries(dir: string): Promise<SngPackEntry[]> {
	const files = await listWorkspaceFiles(dir)
	return files.map(file => ({
		name: file.name,
		size: file.size,
		stream: () => fs.createReadStream(file.fullPath),
	}))
}

/**
 * Re-parses the packed archive with parse-sng and compares per-file md5s and the
 * metadata map against what was packed from ws.dir. A mismatch indicates a packer
 * bug: the commit is refused and the original archive stays untouched.
 */
async function verifyPackedArchive(packedPath: string, expectedFiles: SngManifest, expectedMetadata: Map<string, string>): Promise<void> {
	const actualFiles: SngManifest = new Map()
	let header: SngHeader | null = null

	await new Promise<void>((resolve, reject) => {
		const sngStream = new SngStream(
			Readable.toWeb(fs.createReadStream(packedPath)) as ReadableStream<Uint8Array>,
			{ generateSongIni: false }
		)
		sngStream.on('header', h => {
			header = h
			if (h.fileMeta.length === 0) resolve() // No 'file' events will follow
		})
		sngStream.on('error', reject)
		sngStream.on('file', async (fileName, fileStream, nextFile) => {
			try {
				const md5 = crypto.createHash('md5')
				let size = 0
				const reader = fileStream.getReader()
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					md5.update(value)
					size += value.length
				}
				actualFiles.set(fileName, { size, md5: md5.digest('hex') })

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

	if (header === null) {
		throw new Error('Packed .sng verification failed: no header was parsed.')
	}
	const actualMetadata = (header as SngHeader).metadata
	for (const [key, value] of expectedMetadata) {
		if (actualMetadata[key] !== value) {
			throw new Error(`Packed .sng verification failed: metadata key "${key}" reads back as "${actualMetadata[key]}" instead of "${value}".`)
		}
	}
	for (const key of Object.keys(actualMetadata)) {
		if (!expectedMetadata.has(key)) {
			throw new Error(`Packed .sng verification failed: unexpected metadata key "${key}" in the packed archive.`)
		}
	}

	if (actualFiles.size !== expectedFiles.size) {
		throw new Error(`Packed .sng verification failed: expected ${expectedFiles.size} files but the packed archive contains ${actualFiles.size}.`)
	}
	for (const [name, expected] of expectedFiles) {
		const actual = actualFiles.get(name)
		if (!actual) {
			throw new Error(`Packed .sng verification failed: file "${name}" is missing from the packed archive.`)
		}
		if (actual.size !== expected.size || actual.md5 !== expected.md5) {
			throw new Error(`Packed .sng verification failed: file "${name}" does not read back identically (packer bug).`)
		}
	}
}
