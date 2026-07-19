/**
 * Bridge Art Studio Module - IPC Handlers
 */

import * as path from 'path'
import * as fs from 'fs'
import {
	AlbumArtResult,
	ArtDownloadOptions,
	ArtDownloadProgress,
	BackgroundGenerateOptions,
	ChartArtMatch,
} from '../../../src-shared/interfaces/art-studio.interface.js'
import { getImageService } from './ImageService.js'
import { getCatalogDb } from '../catalog/CatalogDatabase.js'
import { getChartScanner } from '../catalog/ChartScanner.js'
import { openChartWorkspace, type ChartWorkspace } from '../sng/ChartWorkspace.js'
import { readSngEntries, readSngHeader } from '../sng/SngReader.js'
import { mainWindow } from '../../main.js'

// Initialize service event forwarding
let serviceInitialized = false

function initService() {
	if (serviceInitialized) return
	serviceInitialized = true

	const imageService = getImageService()
	imageService.on('progress', (progress: ArtDownloadProgress) => {
		try {
			mainWindow?.webContents.send('artDownloadProgress', progress)
		} catch {
			// Window might be closed
		}
	})
}

/**
 * Commit the workspace and rescan the chart when it changed
 */
async function commitAndRescan(ws: ChartWorkspace, chartPath: string): Promise<void> {
	const { changed } = await ws.commit()
	if (changed) {
		await getChartScanner().rescanChart(chartPath)
	}
}

/**
 * Same as commitAndRescan, but emits repack progress on the existing 'processing' phase for .sng archives
 */
async function commitAndRescanWithProgress(ws: ChartWorkspace, chartId: number, chartPath: string): Promise<void> {
	const imageService = getImageService()

	if (ws.isSng) {
		imageService.emit('progress', {
			phase: 'processing',
			percent: 99,
			message: 'Repacking .sng archive…',
			chartId,
		})
	}

	await commitAndRescan(ws, chartPath)

	// Emitted for folder charts too: the service's own 'complete' fires before the
	// rescan finishes, so renderer refreshes triggered by it read stale catalog data
	imageService.emit('progress', {
		phase: 'complete',
		percent: 100,
		message: 'Complete',
		chartId,
	})
}

/**
 * Search for album art
 */
export async function artSearchAlbumArt(input: { artist: string; album: string }): Promise<AlbumArtResult[]> {
	initService()
	const imageService = getImageService()
	return imageService.searchAlbumArt(input.artist, input.album)
}

/**
 * Download image to chart folder
 */
export async function artDownloadImage(options: ArtDownloadOptions): Promise<string> {
	initService()
	const imageService = getImageService()
	const db = getCatalogDb()

	const chart = db.getChart(options.chartId)
	if (!chart) {
		throw new Error(`Chart not found: ${options.chartId}`)
	}

	const ws = await openChartWorkspace(chart.path)
	try {
		// Always write into the workspace dir (ignore any renderer-supplied outputPath)
		const outputFile = await imageService.downloadImage({ ...options, outputPath: ws.dir })

		await commitAndRescanWithProgress(ws, options.chartId, chart.path)

		return outputFile
	} finally {
		await ws.discard()
	}
}

/**
 * Generate background from album art or solid color
 */
export async function artGenerateBackground(options: BackgroundGenerateOptions): Promise<string> {
	initService()
	const imageService = getImageService()
	const db = getCatalogDb()

	// Get chart info if not all provided
	const chart = db.getChart(options.chartId)
	if (!chart) {
		throw new Error(`Chart not found: ${options.chartId}`)
	}

	const ws = await openChartWorkspace(chart.path)
	try {
		// Always write into the workspace dir (ignore any renderer-supplied outputPath)
		options = { ...options, outputPath: ws.dir }

		// Always check for existing album art to use as base if not explicitly provided
		if (!options.albumArtPath) {
			try {
				const entries = await fs.promises.readdir(ws.dir)
				for (const entry of entries) {
					const lower = entry.toLowerCase()
					if (lower === 'album.png' || lower === 'album.jpg' || lower === 'album.jpeg') {
						options.albumArtPath = path.join(ws.dir, entry)
						break
					}
				}
			} catch (err) {
				console.error('Failed to read chart directory for album art:', err)
			}
		}

		const outputFile = await imageService.generateBackground(options)

		await commitAndRescanWithProgress(ws, options.chartId, chart.path)

		return outputFile
	} finally {
		await ws.discard()
	}
}

/**
 * Get charts missing album art
 */
export async function artGetChartsMissingAlbumArt(limit: number = 10000): Promise<ChartArtMatch[]> {
	const db = getCatalogDb()
	const charts = db.getCharts({
		hasAlbumArt: false,
		limit,
		sortBy: 'artist',
		sortDirection: 'asc',
	})

	return charts.map(chart => ({
		chartId: chart.id,
		chartName: chart.name,
		chartArtist: chart.artist,
		chartAlbum: chart.album || '',
		chartPath: chart.path,
		hasBackground: chart.hasBackground,
		hasAlbumArt: chart.hasAlbumArt,
		suggestedQuery: `${chart.artist} ${chart.album || chart.name}`.trim(),
	}))
}

/**
 * Get charts missing backgrounds
 */
export async function artGetChartsMissingBackground(limit: number = 10000): Promise<ChartArtMatch[]> {
	const db = getCatalogDb()
	const charts = db.getCharts({
		hasBackground: false,
		limit,
		sortBy: 'artist',
		sortDirection: 'asc',
	})

	return charts.map(chart => ({
		chartId: chart.id,
		chartName: chart.name,
		chartArtist: chart.artist,
		chartAlbum: chart.album || '',
		chartPath: chart.path,
		hasBackground: chart.hasBackground,
		hasAlbumArt: chart.hasAlbumArt,
		suggestedQuery: `${chart.artist} ${chart.album || chart.name}`.trim(),
	}))
}

/**
 * Check if album art exists for a chart
 */
export async function artCheckChartAssets(chartId: number): Promise<{ hasAlbumArt: boolean; hasBackground: boolean; albumArtPath?: string; backgroundPath?: string }> {
	const db = getCatalogDb()
	const chart = db.getChart(chartId)

	if (!chart) {
		throw new Error(`Chart not found: ${chartId}`)
	}

	const result = {
		hasAlbumArt: false,
		hasBackground: false,
		albumArtPath: undefined as string | undefined,
		backgroundPath: undefined as string | undefined,
	}

	if (chart.path.toLowerCase().endsWith('.sng')) {
		// List archive entries from the header only (no file paths exist for archive assets)
		const header = await readSngHeader(chart.path)
		for (const entry of header.fileMeta) {
			const lower = entry.filename.toLowerCase()
			if (lower === 'album.png' || lower === 'album.jpg' || lower === 'album.jpeg') {
				result.hasAlbumArt = true
			} else if (lower === 'background.png' || lower === 'background.jpg' || lower === 'background.jpeg') {
				result.hasBackground = true
			}
		}
		return result
	}

	// Check for album art
	for (const ext of ['png', 'jpg', 'jpeg']) {
		const artPath = path.join(chart.path, `album.${ext}`)
		if (fs.existsSync(artPath)) {
			result.hasAlbumArt = true
			result.albumArtPath = artPath
			break
		}
	}

	// Check for background
	for (const ext of ['png', 'jpg', 'jpeg']) {
		const bgPath = path.join(chart.path, `background.${ext}`)
		if (fs.existsSync(bgPath)) {
			result.hasBackground = true
			result.backgroundPath = bgPath
			break
		}
	}

	return result
}

/**
 * Batch fetch album art for multiple charts
 */
export async function artBatchFetchAlbumArt(chartIds: number[]): Promise<{ success: number; failed: number; skipped: number }> {
	initService()
	const imageService = getImageService()
	const db = getCatalogDb()

	let success = 0
	let failed = 0
	let skipped = 0

	for (const chartId of chartIds) {
		const chart = db.getChart(chartId)
		if (!chart) {
			skipped++
			continue
		}

		// Skip if already has album art (catalog flag covers folders and .sng archives)
		if (chart.hasAlbumArt) {
			skipped++
			continue
		}

		try {
			// Search for album art
			const results = await imageService.searchAlbumArt(chart.artist, chart.album || chart.name)

			if (results.length > 0) {
				// Download the first (best) result
				const ws = await openChartWorkspace(chart.path)
				try {
					await imageService.downloadImage({
						chartId,
						imageUrl: results[0].url,
						outputPath: ws.dir,
						type: 'album',
					})
					await commitAndRescanWithProgress(ws, chartId, chart.path)
				} finally {
					await ws.discard()
				}
				success++
			} else {
				failed++
			}
		} catch (err) {
			console.error(`Failed to fetch album art for ${chart.artist} - ${chart.name}:`, err)
			failed++
		}

		// Small delay to avoid rate limiting
		await new Promise(resolve => setTimeout(resolve, 500))
	}

	return { success, failed, skipped }
}

/**
 * Batch generate backgrounds from album art
 */
export async function artBatchGenerateBackgrounds(chartIds: number[]): Promise<{ success: number; failed: number; skipped: number }> {
	initService()
	const imageService = getImageService()
	const db = getCatalogDb()

	let success = 0
	let failed = 0
	let skipped = 0

	for (const chartId of chartIds) {
		const chart = db.getChart(chartId)
		if (!chart) {
			skipped++
			continue
		}

		// Skip if already has background (catalog flag covers folders and .sng archives)
		if (chart.hasBackground) {
			skipped++
			continue
		}

		try {
			const ws = await openChartWorkspace(chart.path)
			try {
				// Check for album art to use as base
				let albumArtPath: string | undefined
				for (const ext of ['png', 'jpg', 'jpeg']) {
					const artPath = path.join(ws.dir, `album.${ext}`)
					if (fs.existsSync(artPath)) {
						albumArtPath = artPath
						break
					}
				}

				await imageService.generateBackground({
					chartId,
					outputPath: ws.dir,
					style: albumArtPath ? 'blur' : 'gradient',
					albumArtPath,
				})

				await commitAndRescanWithProgress(ws, chartId, chart.path)
			} finally {
				await ws.discard()
			}
			success++
		} catch (err) {
			console.error(`Failed to generate background for ${chart.artist} - ${chart.name}:`, err)
			failed++
		}
	}

	return { success, failed, skipped }
}

/**
 * Delete background image from chart folder
 */
export async function artDeleteBackground(chartId: number): Promise<{ success: boolean; error?: string }> {
	const db = getCatalogDb()
	const chart = db.getChart(chartId)

	if (!chart) {
		return { success: false, error: 'Chart not found' }
	}

	const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
	let deleted = false

	try {
		const ws = await openChartWorkspace(chart.path)
		try {
			const entries = await fs.promises.readdir(ws.dir)

			for (const entry of entries) {
				const lower = entry.toLowerCase()
				if (lower.startsWith('background') && imageExtensions.some(ext => lower.endsWith(ext))) {
					await fs.promises.unlink(path.join(ws.dir, entry))
					deleted = true
				}
			}

			if (deleted) {
				await commitAndRescan(ws, chart.path)
			}

			return { success: true }
		} finally {
			await ws.discard()
		}
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Delete album art from chart folder
 */
export async function artDeleteAlbumArt(chartId: number): Promise<{ success: boolean; error?: string }> {
	const db = getCatalogDb()
	const chart = db.getChart(chartId)

	if (!chart) {
		return { success: false, error: 'Chart not found' }
	}

	const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
	let deleted = false

	try {
		const ws = await openChartWorkspace(chart.path)
		try {
			const entries = await fs.promises.readdir(ws.dir)

			for (const entry of entries) {
				const lower = entry.toLowerCase()
				if (lower.startsWith('album') && imageExtensions.some(ext => lower.endsWith(ext))) {
					await fs.promises.unlink(path.join(ws.dir, entry))
					deleted = true
				}
			}

			if (deleted) {
				await commitAndRescan(ws, chart.path)
			}

			return { success: true }
		} finally {
			await ws.discard()
		}
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Batch delete backgrounds
 */
export async function artBatchDeleteBackgrounds(chartIds: number[]): Promise<{ success: number; failed: number }> {
	const results = { success: 0, failed: 0 }

	for (const chartId of chartIds) {
		const result = await artDeleteBackground(chartId)
		if (result.success) {
			results.success++
		} else {
			results.failed++
		}
	}

	return results
}

/**
 * Batch regenerate backgrounds with custom blur
 */
export async function artBatchRegenerateBackgrounds(
	input: { chartIds: number[]; blurAmount: number }
): Promise<{ success: number; failed: number; skipped: number }> {
	initService()
	const imageService = getImageService()
	const db = getCatalogDb()

	const { chartIds, blurAmount = 50 } = input

	let success = 0
	let failed = 0
	let skipped = 0

	for (const chartId of chartIds) {
		const chart = db.getChart(chartId)
		if (!chart) {
			failed++
			continue
		}

		try {
			// One workspace per chart: delete + regenerate inside a single open→commit
			const ws = await openChartWorkspace(chart.path)
			try {
				// Check for album art to use as base (skip before touching anything)
				let albumArtPath: string | undefined
				for (const ext of ['png', 'jpg', 'jpeg']) {
					const artPath = path.join(ws.dir, `album.${ext}`)
					if (fs.existsSync(artPath)) {
						albumArtPath = artPath
						break
					}
				}

				if (!albumArtPath) {
					// No album art, skip or use gradient
					skipped++
					continue
				}

				// Delete existing background first
				const entries = await fs.promises.readdir(ws.dir)
				for (const entry of entries) {
					const lower = entry.toLowerCase()
					if (lower.startsWith('background') && ['.png', '.jpg', '.jpeg'].some(ext => lower.endsWith(ext))) {
						await fs.promises.unlink(path.join(ws.dir, entry))
					}
				}

				await imageService.generateBackground({
					chartId,
					outputPath: ws.dir,
					style: 'blur',
					albumArtPath,
					blurAmount,
				})

				await commitAndRescanWithProgress(ws, chartId, chart.path)
			} finally {
				await ws.discard()
			}
			success++
		} catch (err) {
			console.error(`Failed to regenerate background for ${chart.artist} - ${chart.name}:`, err)
			failed++
		}
	}

	return { success, failed, skipped }
}

/**
 * Get album art as a base64 data URL
 * Used for displaying thumbnails in the renderer without file:// protocol issues
 */
export async function artGetAlbumArtDataUrl(
	input: { chartPath: string; maxSize?: number }
): Promise<string | null> {
	const { chartPath, maxSize = 150 } = input

	try {
		if (chartPath.toLowerCase().endsWith('.sng')) {
			// Read the album art directly out of the archive
			const wanted = ['album.png', 'album.jpg', 'album.jpeg']
			const files = await readSngEntries(chartPath, fileName => wanted.includes(fileName.toLowerCase()))
			const entry = files.find(f => wanted.includes(f.fileName.toLowerCase()) && f.data.length > 0)
			if (!entry) return null

			const mimeType = path.extname(entry.fileName).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
			return `data:${mimeType};base64,${Buffer.from(entry.data).toString('base64')}`
		}

		// Find the album art file
		const entries = await fs.promises.readdir(chartPath)
		let albumArtFile: string | null = null

		for (const entry of entries) {
			const lower = entry.toLowerCase()
			if (lower === 'album.png' || lower === 'album.jpg' || lower === 'album.jpeg') {
				albumArtFile = path.join(chartPath, entry)
				break
			}
		}

		if (!albumArtFile) return null

		// Read the file
		const buffer = await fs.promises.readFile(albumArtFile)
		const ext = path.extname(albumArtFile).toLowerCase()
		const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'

		// Convert to base64 data URL
		const base64 = buffer.toString('base64')
		return `data:${mimeType};base64,${base64}`
	} catch (err) {
		console.error('Failed to get album art data URL:', err)
		return null
	}
}

/**
 * Get background as a base64 data URL
 * Used for displaying thumbnails in the renderer without file:// protocol issues
 */
export async function artGetBackgroundDataUrl(
	input: { chartPath: string; maxSize?: number }
): Promise<string | null> {
	const { chartPath, maxSize = 150 } = input

	try {
		if (chartPath.toLowerCase().endsWith('.sng')) {
			// Read the background directly out of the archive
			const isBackground = (name: string) => {
				const lower = name.toLowerCase()
				return lower.startsWith('background') &&
					(lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
			}
			const files = await readSngEntries(chartPath, fileName => isBackground(fileName))
			const entry = files.find(f => isBackground(f.fileName) && f.data.length > 0)
			if (!entry) return null

			const mimeType = path.extname(entry.fileName).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
			return `data:${mimeType};base64,${Buffer.from(entry.data).toString('base64')}`
		}

		// Find the background file
		const entries = await fs.promises.readdir(chartPath)
		let backgroundFile: string | null = null

		for (const entry of entries) {
			const lower = entry.toLowerCase()
			if (lower.startsWith('background') &&
				(lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) {
				backgroundFile = path.join(chartPath, entry)
				break
			}
		}

		if (!backgroundFile) return null

		// Read the file
		const buffer = await fs.promises.readFile(backgroundFile)
		const ext = path.extname(backgroundFile).toLowerCase()
		const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'

		// Convert to base64 data URL
		const base64 = buffer.toString('base64')
		return `data:${mimeType};base64,${base64}`
	} catch (err) {
		console.error('Failed to get background data URL:', err)
		return null
	}
}
