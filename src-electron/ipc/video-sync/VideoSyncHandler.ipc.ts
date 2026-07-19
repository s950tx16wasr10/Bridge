/**
 * Bridge Video Sync Module - IPC Handlers
 */

import * as fs from 'fs'
import * as path from 'path'
import { dialog } from 'electron'
import { VideoDownloadOptions, VideoDownloadProgress, YouTubeSearchResult } from '../../../src-shared/interfaces/video-sync.interface.js'
import { getYouTubeService } from './YouTubeService.js'
import { getCatalogDb } from '../catalog/CatalogDatabase.js'
import { getChartScanner } from '../catalog/ChartScanner.js'
import { openChartWorkspace, type ChartWorkspace } from '../sng/ChartWorkspace.js'
import { mainWindow } from '../../main.js'

// Initialize YouTube service event forwarding
let serviceInitialized = false

function initService() {
	if (serviceInitialized) return
	serviceInitialized = true

	const ytService = getYouTubeService()
	ytService.on('downloadProgress', (progress: VideoDownloadProgress) => {
		try {
			mainWindow?.webContents.send('videoDownloadProgress', progress)
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
 * Same as commitAndRescan, but emits repack progress on the existing 'converting' phase for .sng archives
 */
async function commitAndRescanWithProgress(ws: ChartWorkspace, chartId: number, chartPath: string, videoId?: string): Promise<void> {
	const ytService = getYouTubeService()

	if (ws.isSng) {
		ytService.emit('downloadProgress', {
			phase: 'converting',
			percent: 99,
			message: 'Repacking .sng archive…',
			chartId,
			videoId,
		})
	}

	await commitAndRescan(ws, chartPath)

	// Emitted for folder charts too: the service's own 'complete' fires before the
	// rescan finishes, so renderer refreshes triggered by it read stale catalog data
	ytService.emit('downloadProgress', {
		phase: 'complete',
		percent: 100,
		message: 'Complete',
		chartId,
		videoId,
	})
}

/**
 * Search YouTube for videos
 */
export async function videoSearchYouTube(query: string): Promise<YouTubeSearchResult[]> {
	initService()
	const ytService = getYouTubeService()
	return ytService.searchVideos(query, 10)
}

/**
 * Search multiple video sources
 */
export async function videoSearch([query, source]: [string, string]): Promise<YouTubeSearchResult[]> {
	initService()
	const ytService = getYouTubeService()
	return ytService.searchVideos(query, 10, source)
}

/**
 * Get info about a specific video
 */
export async function videoGetInfo(videoId: string): Promise<YouTubeSearchResult | null> {
	initService()
	const ytService = getYouTubeService()
	return ytService.getVideoInfo(videoId)
}

/**
 * Download video to chart folder
 */
export async function videoDownload(options: VideoDownloadOptions): Promise<string> {
	initService()
	const ytService = getYouTubeService()
	const db = getCatalogDb()

	const chart = db.getChart(options.chartId)
	if (!chart) {
		throw new Error(`Chart not found: ${options.chartId}`)
	}

	const ws = await openChartWorkspace(chart.path)
	try {
		// Always download into the workspace dir (ignore any renderer-supplied outputPath)
		const outputFile = await ytService.downloadVideo({ ...options, outputPath: ws.dir })

		// downloadVideo throws on failure, so reaching here means success
		await commitAndRescanWithProgress(ws, options.chartId, chart.path, options.videoId)

		return outputFile
	} finally {
		await ws.discard()
	}
}

/**
 * Download video from any URL supported by yt-dlp
 */
export async function videoDownloadFromUrl(options: { chartId: number; url: string; outputPath: string }): Promise<string> {
	initService()
	const ytService = getYouTubeService()
	const db = getCatalogDb()

	const chart = db.getChart(options.chartId)
	if (!chart) {
		throw new Error(`Chart not found: ${options.chartId}`)
	}

	const ws = await openChartWorkspace(chart.path)
	try {
		// Always download into the workspace dir (ignore any renderer-supplied outputPath)
		const outputFile = await ytService.downloadFromUrl(options.url, ws.dir, options.chartId)

		// downloadFromUrl throws on failure, so reaching here means success
		await commitAndRescanWithProgress(ws, options.chartId, chart.path)

		return outputFile
	} finally {
		await ws.discard()
	}
}

/**
 * Open file dialog to select a local video file
 */
export async function videoSelectLocalFile(): Promise<string | null> {
	const result = await dialog.showOpenDialog(mainWindow!, {
		title: 'Select Video File',
		filters: [
			{ name: 'Video Files', extensions: ['mp4', 'avi', 'webm', 'mkv', 'mov', 'wmv', 'flv'] },
			{ name: 'All Files', extensions: ['*'] },
		],
		properties: ['openFile'],
	})

	if (result.canceled || result.filePaths.length === 0) {
		return null
	}

	return result.filePaths[0]
}

/**
 * Import a local video file into the chart folder
 */
export async function videoImportLocal(options: { chartId: number; sourcePath: string; outputPath: string }): Promise<string> {
	const db = getCatalogDb()

	const chart = db.getChart(options.chartId)
	if (!chart) {
		throw new Error(`Chart not found: ${options.chartId}`)
	}

	const ws = await openChartWorkspace(chart.path)
	try {
		// Determine output filename - keep original extension or use mp4
		// Always copy into the workspace dir (ignore any renderer-supplied outputPath)
		const ext = path.extname(options.sourcePath).toLowerCase() || '.mp4'
		const outputFile = path.join(ws.dir, `video${ext}`)

		// Copy the file
		await fs.promises.copyFile(options.sourcePath, outputFile)

		await commitAndRescanWithProgress(ws, options.chartId, chart.path)

		return outputFile
	} finally {
		await ws.discard()
	}
}

/**
 * Cancel active download
 */
export async function videoCancelDownload(videoId: string): Promise<boolean> {
	const ytService = getYouTubeService()
	return ytService.cancelDownload(videoId)
}

/**
 * Check if required tools are installed
 */
export async function videoCheckTools(): Promise<{ ytDlp: boolean; ffmpeg: boolean }> {
	const ytService = getYouTubeService()
	const [ytDlp, ffmpeg] = await Promise.all([
		ytService.checkYtDlp(),
		ytService.checkFfmpeg(),
	])
	return { ytDlp, ffmpeg }
}

/**
 * Get charts missing videos for batch processing
 */
export async function videoGetChartsMissingVideo(limit: number = 10000): Promise<Array<{
	id: number
	name: string
	artist: string
	path: string
	songLength: number | null
	suggestedQuery: string
}>> {
	const db = getCatalogDb()
	const charts = db.getCharts({
		hasVideo: false,
		limit,
		sortBy: 'artist',
		sortDirection: 'asc',
	})

	return charts.map(chart => ({
		id: chart.id,
		name: chart.name,
		artist: chart.artist,
		path: chart.path,
		songLength: chart.songLength,
		suggestedQuery: `${chart.artist} - ${chart.name} official video`,
	}))
}

/**
 * Build search query suggestion for a chart
 */
export async function videoBuildSearchQuery(chartId: number): Promise<string> {
	const db = getCatalogDb()
	const chart = db.getChart(chartId)

	if (!chart) {
		throw new Error(`Chart not found: ${chartId}`)
	}

	// Build smart query - prioritize official videos
	return `${chart.artist} - ${chart.name} official video`
}

/**
 * Batch download videos - search and download first result for each chart
 */
export async function videoBatchDownload(chartIds: number[]): Promise<{
	success: number
	failed: number
	skipped: number
	errors: Array<{ chartId: number; error: string }>
}> {
	initService()
	const ytService = getYouTubeService()
	const db = getCatalogDb()

	const results = {
		success: 0,
		failed: 0,
		skipped: 0,
		errors: [] as Array<{ chartId: number; error: string }>,
	}

	for (const chartId of chartIds) {
		const chart = db.getChart(chartId)
		if (!chart) {
			results.failed++
			results.errors.push({ chartId, error: 'Chart not found' })
			continue
		}

		if (chart.hasVideo) {
			results.skipped++
			continue
		}

		try {
			// Search for video
			const query = `${chart.artist} - ${chart.name} official video`
			const searchResults = await ytService.searchVideos(query, 3)

			if (searchResults.length === 0) {
				results.failed++
				results.errors.push({ chartId, error: 'No videos found' })
				continue
			}

			// Download first result
			const video = searchResults[0]
			const ws = await openChartWorkspace(chart.path)
			try {
				await ytService.downloadVideo({
					videoId: video.videoId,
					outputPath: ws.dir,
					chartId: chart.id,
				})

				// downloadVideo throws on failure, so reaching here means success
				await commitAndRescanWithProgress(ws, chartId, chart.path, video.videoId)
			} finally {
				await ws.discard()
			}

			results.success++

			// Small delay between downloads
			await new Promise(resolve => setTimeout(resolve, 1000))
		} catch (err) {
			results.failed++
			results.errors.push({
				chartId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return results
}

/**
 * Delete video from a chart folder
 */
export async function videoDeleteFromChart(chartId: number): Promise<{ success: boolean; error?: string }> {
	const db = getCatalogDb()
	const chart = db.getChart(chartId)

	if (!chart) {
		return { success: false, error: 'Chart not found' }
	}

	const videoExtensions = ['.mp4', '.avi', '.webm', '.mkv', '.mov']
	let deleted = false

	try {
		const ws = await openChartWorkspace(chart.path)
		try {
			const entries = await fs.promises.readdir(ws.dir)

			for (const entry of entries) {
				const lower = entry.toLowerCase()
				if (lower.startsWith('video') && videoExtensions.some(ext => lower.endsWith(ext))) {
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
