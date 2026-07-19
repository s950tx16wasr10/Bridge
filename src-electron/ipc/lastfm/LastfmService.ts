/**
 * Bridge Last.fm Discover Module - Sync Orchestrator
 *
 * Pipeline per docs/lastfm-discover-design.md §9: fetch last.fm tracks (the
 * selected source plus always loved), plan stale artist buckets, fetch each
 * from Enchor with the §3 strategy, then always rebuild all matches locally.
 */

import { EventEmitter } from 'eventemitter3'

import {
	ArtistCacheStatus, ChartMatchType, LastfmSource, LastfmSyncProgress, MatchQuery, MatchResult, MatchRow, SlimChart, SyncOptions,
} from '../../../src-shared/interfaces/lastfm.interface.js'
import { getCatalogDb } from '../catalog/CatalogDatabase.js'
import { settings } from '../SettingsHandler.ipc.js'
import { EnchorClient, ENCHOR_PER_PAGE, RawEnchorChart } from './EnchorClient.js'
import { ArtistCacheRow, getLastfmDb, MatchInput, StoredChart, StoredTrack, TrackInput } from './LastfmDatabase.js'
import { LastfmApi } from './LastfmApi.js'
import { matchTitles, normalizeArtistKey, normalizeTitle, preprocessArtist, stripChartNoise, TitleMatch, verifyArtist } from './matching.js'

interface LastfmServiceEvents {
	progress: (progress: LastfmSyncProgress) => void
}

interface PlannedBucket {
	artistNorm: string
	queryValue: string
	trackNames: string[]
	trackNameNorms: string[]
}

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000
const OVERFLOW_LIMIT = 1000
const MAX_ARTIST_PAGES = 4
const PER_TRACK_QUERY_LIMIT = 10
// Bump to force a full Enchor cache refetch after matching-logic changes
const CACHE_VERSION = '2'
const INCREMENTAL_MATCH_INTERVAL = 8

class LastfmService extends EventEmitter<LastfmServiceEvents> {

	private api = new LastfmApi()
	private enchor = new EnchorClient()
	private running = false
	private shouldCancel = false
	private lastProgress: LastfmSyncProgress | null = null

	getSyncState(): LastfmSyncProgress | null {
		return this.lastProgress
	}

	cancelSync(): void {
		this.shouldCancel = true
	}

	async validateUser(username: string, apiKey: string) {
		return this.api.validateUser(username, apiKey)
	}

	startSync(options: SyncOptions): void {
		if (this.running) {
			console.warn('Last.fm sync already running; ignoring start request')
			return
		}
		this.running = true
		this.shouldCancel = false
		this.runSync(options)
			.catch(err => {
				console.error('Last.fm sync failed', err)
				this.progress({ phase: 'error', current: 0, total: 0, message: 'Sync failed', error: String(err instanceof Error ? err.message : err) })
			})
			.finally(() => {
				this.running = false
			})
	}

	private progress(progress: LastfmSyncProgress): void {
		this.lastProgress = progress
		this.emit('progress', progress)
	}

	private async runSync(options: SyncOptions): Promise<void> {
		const startedAt = Date.now()
		const db = getLastfmDb()

		// Snapshot credentials so mid-run settings edits can't produce hybrid data
		const username = settings.lastfmUsername.trim()
		const apiKey = settings.lastfmApiKey.trim()
		if (!username || !apiKey) {
			this.progress({ phase: 'error', current: 0, total: 0, message: 'Not configured', error: 'Set your Last.fm username and API key in Settings first.' })
			return
		}
		if (db.getMeta('username') !== username) {
			db.clearUserData()
			db.setMeta('username', username)
		}
		if (db.getMeta('cacheVersion') !== CACHE_VERSION) {
			db.clearEnchorCache()
			db.setMeta('cacheVersion', CACHE_VERSION)
		}

		// Phase: last.fm fetch
		this.progress({ phase: 'lastfm', current: 0, total: 1, message: `Fetching Last.fm history for ${username}...` })
		const validation = await this.api.validateUser(username, apiKey)
		if (!validation.ok) {
			this.progress({ phase: 'error', current: 0, total: 0, message: 'Last.fm rejected the request', error: validation.message })
			return
		}

		if (options.source !== 'loved') {
			const minPlaycount = Math.max(1, options.minPlaycount)
			const topTracks = await this.api.getTopTracks(username, apiKey, options.source, minPlaycount, fetched => {
				this.progress({
					phase: 'lastfm',
					current: fetched,
					total: 0,
					message: `Fetching Last.fm top tracks (${minPlaycount}+ plays)… ${fetched.toLocaleString()} so far`,
				})
			})
			db.replaceSourceTracks(options.source, topTracks.map(track => this.toTrackInput(track.artist, track.name, track.playcount, track.rank, null)))
			if (this.shouldCancel) return this.finishCancelled(startedAt)
		}
		// Loved tracks are always refreshed so the ♥ marker works for top-only users
		const lovedTracks = await this.api.getLovedTracks(username, apiKey)
		db.replaceSourceTracks('loved', lovedTracks.map((track, i) => this.toTrackInput(track.artist, track.name, null, i + 1, track.lovedAt)))
		if (this.shouldCancel) return this.finishCancelled(startedAt)

		// Phase: plan stale artist buckets
		this.progress({ phase: 'plan', current: 0, total: 1, message: 'Planning Enchor lookups...' })
		const allTracks = db.getAllTracks()
		const buckets = this.planBuckets(allTracks)
		const cache = db.getArtistCache()
		const staleBuckets = [...buckets.values()].filter(bucket => this.isStale(cache.get(bucket.artistNorm), bucket))

		// Phase: Enchor fetch, one artist at a time
		let fetched = 0
		for (const bucket of staleBuckets) {
			if (this.shouldCancel) break
			this.progress({
				phase: 'enchor',
				current: fetched + 1,
				total: staleBuckets.length,
				message: `Enchor: artist ${fetched + 1}/${staleBuckets.length} — ${bucket.queryValue}`,
			})
			await this.fetchArtistBucket(bucket)
			fetched++
			// Rebuild matches periodically so results appear in the table during the sync
			if (fetched % INCREMENTAL_MATCH_INTERVAL === 0) {
				this.rebuildAllMatches(allTracks)
			}
		}

		// Phase: match — ALWAYS runs over every bucket of the current track set,
		// so cancel/quit/new-tracks-for-cached-artists self-heal here
		this.progress({ phase: 'match', current: 0, total: 1, message: 'Matching tracks against cached charts...' })
		const matchedCount = this.rebuildAllMatches(allTracks)

		db.setMeta('lastSyncAt', new Date().toISOString())
		this.progress({
			phase: 'done',
			current: 1,
			total: 1,
			message: this.shouldCancel ? 'Sync cancelled — partial results saved' : 'Sync complete',
			summary: {
				trackCount: allTracks.length,
				matchedCount,
				artistCount: fetched,
				elapsedMs: Date.now() - startedAt,
			},
		})
	}

	private finishCancelled(startedAt: number): void {
		this.progress({
			phase: 'done',
			current: 1,
			total: 1,
			message: 'Sync cancelled',
			summary: { trackCount: 0, matchedCount: 0, artistCount: 0, elapsedMs: Date.now() - startedAt },
		})
	}

	private toTrackInput(artist: string, name: string, playcount: number | null, rank: number | null, lovedAt: number | null): TrackInput {
		return {
			artist,
			name,
			artistNorm: normalizeArtistKey(artist),
			nameNorm: normalizeTitle(name).base,
			bucketNorms: preprocessArtist(artist).map(query => query.artistNorm),
			playcount,
			rank,
			lovedAt,
		}
	}

	private planBuckets(tracks: StoredTrack[]): Map<string, PlannedBucket> {
		const buckets = new Map<string, PlannedBucket>()
		for (const track of tracks) {
			for (const query of preprocessArtist(track.artist)) {
				let bucket = buckets.get(query.artistNorm)
				if (!bucket) {
					bucket = { artistNorm: query.artistNorm, queryValue: query.queryValue, trackNames: [], trackNameNorms: [] }
					buckets.set(query.artistNorm, bucket)
				}
				if (!bucket.trackNameNorms.includes(track.nameNorm)) {
					bucket.trackNames.push(track.name)
					bucket.trackNameNorms.push(track.nameNorm)
				}
			}
		}
		return buckets
	}

	private isStale(cache: ArtistCacheRow | undefined, bucket: PlannedBucket): boolean {
		if (!cache) return true
		if (cache.status === 'error') return true
		if (Date.now() - Date.parse(cache.fetchedAt) > CACHE_TTL_MS) return true
		// Overflow rows only cover the tracks known at fetch time; new tracks are cache misses
		if (cache.status === 'overflow' && bucket.trackNameNorms.some(norm => !cache.queriedTracks.includes(norm))) return true
		return false
	}

	private async fetchArtistBucket(bucket: PlannedBucket): Promise<void> {
		const db = getLastfmDb()
		const fetchedAt = new Date().toISOString()
		try {
			const first = await this.enchor.searchArtist(bucket.queryValue, false, 1)
			const verifiedFirst = first.charts.filter(chart => verifyArtist(bucket.queryValue, chart.artist ?? ''))

			if (first.found > OVERFLOW_LIMIT) {
				await this.fetchOverflowBucket(bucket, fetchedAt)
				return
			}
			if (verifiedFirst.length === 0) {
				// Short-circuit: no verification-passing charts on page 1
				db.replaceArtistBucket({
					artistNorm: bucket.artistNorm, queryValue: bucket.queryValue, strategy: 'nonexact',
					chartCount: 0, queriedTracks: [], status: 'empty', fetchedAt,
				}, [])
				return
			}

			const verified = [...verifiedFirst]
			const totalPages = Math.min(MAX_ARTIST_PAGES, Math.ceil(first.found / ENCHOR_PER_PAGE))
			for (let page = 2; page <= totalPages; page++) {
				if (this.shouldCancel) return
				const result = await this.enchor.searchArtist(bucket.queryValue, false, page)
				verified.push(...result.charts.filter(chart => verifyArtist(bucket.queryValue, chart.artist ?? '')))
			}

			const charts = this.dedupeCharts(verified).map(chart => this.toStoredChart(chart))
			db.replaceArtistBucket({
				artistNorm: bucket.artistNorm, queryValue: bucket.queryValue, strategy: 'nonexact',
				chartCount: charts.length, queriedTracks: [], status: charts.length > 0 ? 'ok' : 'empty', fetchedAt,
			}, charts)
		} catch (err) {
			console.error(`Enchor fetch failed for artist "${bucket.queryValue}"`, err)
			db.upsertArtistCache({
				artistNorm: bucket.artistNorm, queryValue: bucket.queryValue, strategy: 'nonexact',
				chartCount: 0, queriedTracks: [], status: 'error', fetchedAt,
			})
		}
	}

	/**
	 * Overflow strategy (§3): the non-exact result set is too large (common-word
	 * artist names or mega-charted artists), so run an exact query instead, then
	 * per-track queries for this bucket's still-uncovered tracks.
	 */
	private async fetchOverflowBucket(bucket: PlannedBucket, fetchedAt: string): Promise<void> {
		const db = getLastfmDb()
		const verified: RawEnchorChart[] = []

		const first = await this.enchor.searchArtist(bucket.queryValue, true, 1)
		verified.push(...first.charts.filter(chart => verifyArtist(bucket.queryValue, chart.artist ?? '')))
		const totalPages = Math.min(MAX_ARTIST_PAGES, Math.ceil(first.found / ENCHOR_PER_PAGE))
		for (let page = 2; page <= totalPages; page++) {
			if (this.shouldCancel) return
			const result = await this.enchor.searchArtist(bucket.queryValue, true, page)
			verified.push(...result.charts.filter(chart => verifyArtist(bucket.queryValue, chart.artist ?? '')))
		}

		// Per-track queries for tracks the exact fetch didn't cover
		const titles = verified.map(chart => chart.name)
		const uncovered = bucket.trackNames.filter(name => matchTitles(name, titles).size === 0)
		if (uncovered.length <= PER_TRACK_QUERY_LIMIT) {
			for (const trackName of uncovered) {
				if (this.shouldCancel) return
				const result = await this.enchor.searchTrack(bucket.queryValue, trackName)
				verified.push(...result.charts.filter(chart => verifyArtist(bucket.queryValue, chart.artist ?? '')))
			}
		}

		const charts = this.dedupeCharts(verified).map(chart => this.toStoredChart(chart))
		db.replaceArtistBucket({
			artistNorm: bucket.artistNorm, queryValue: bucket.queryValue, strategy: 'pertrack',
			chartCount: charts.length,
			// Record every covered nameNorm so future new tracks register as cache misses
			queriedTracks: bucket.trackNameNorms,
			status: 'overflow', fetchedAt,
		}, charts)
	}

	private dedupeCharts(charts: RawEnchorChart[]): RawEnchorChart[] {
		const seen = new Set<number>()
		return charts.filter(chart => {
			if (seen.has(chart.chartId)) return false
			seen.add(chart.chartId)
			return true
		})
	}

	private toStoredChart(chart: RawEnchorChart): StoredChart {
		return {
			chartId: chart.chartId,
			artist: chart.artist,
			name: chart.name,
			chartName: chart.chartName,
			nameNorm: normalizeTitle(stripChartNoise(chart.name ?? chart.chartName ?? '')).base,
			charter: chart.charter,
			md5: chart.md5,
			albumArtMd5: chart.albumArtMd5,
			hasVideoBackground: chart.hasVideoBackground,
			songId: chart.songId,
			groupId: chart.groupId,
			songLength: chart.song_length,
			instruments: chart.notesData?.instruments ?? [],
			diffGuitar: chart.diff_guitar,
			diffBass: chart.diff_bass,
			diffDrums: chart.diff_drums,
			diffKeys: chart.diff_keys,
			diffVocals: chart.diff_vocals,
			album: chart.album,
			genre: chart.genre,
			year: chart.year,
			modifiedTime: chart.modifiedTime,
		}
	}

	/** Classifies one track against its bucket charts, falling through to chartName when name fails. */
	private classifyTrackCharts(trackName: string, charts: StoredChart[]): Map<number, TitleMatch> {
		const primary = matchTitles(trackName, charts.map(chart => chart.name))
		const chartNameTitles = charts.map((chart, i) =>
			!primary.has(i) && chart.chartName && chart.chartName !== chart.name ? chart.chartName : null)
		const secondary = chartNameTitles.some(title => title !== null) ? matchTitles(trackName, chartNameTitles) : new Map<number, TitleMatch>()
		const result = new Map<number, TitleMatch>()
		charts.forEach((chart, i) => {
			const match = primary.get(i) ?? secondary.get(i)
			if (match) result.set(i, match)
		})
		return result
	}

	private rebuildAllMatches(tracks: StoredTrack[]): number {
		const db = getLastfmDb()
		const bucketNorms = [...new Set(tracks.flatMap(track => track.bucketNorms))]
		const bucketCharts = db.getBucketCharts(bucketNorms)
		const matches: MatchInput[] = []
		const matchedTrackKeys = new Set<string>()

		for (const track of tracks) {
			const charts = this.dedupeStoredCharts(track.bucketNorms.flatMap(norm => bucketCharts.get(norm) ?? []))
			if (charts.length === 0) continue
			const classified = this.classifyTrackCharts(track.name, charts)
			for (const [index, match] of classified) {
				matches.push({ trackId: track.id, chartId: charts[index].chartId, matchType: match.matchType, similarity: match.similarity })
				matchedTrackKeys.add(`${track.artistNorm}|${track.nameNorm}`)
			}
		}

		db.rebuildMatches(matches)
		return matchedTrackKeys.size
	}

	private dedupeStoredCharts(charts: StoredChart[]): StoredChart[] {
		const seen = new Set<number>()
		return charts.filter(chart => {
			if (seen.has(chart.chartId)) return false
			seen.add(chart.chartId)
			return true
		})
	}

	getMatches(query: MatchQuery): MatchResult {
		const db = getLastfmDb()
		const tracks = db.getTracksForSource(query.source)
		const trackMatches = db.getMatchesForTracks(tracks.map(track => track.id))
		const lovedKeys = query.source === 'loved' ? null : db.getLovedKeys()
		const cache = db.getArtistCache()
		const bucketCounts = db.getBucketChartCounts()

		// "In library" is computed at query time against the catalog, never cached.
		// Matched charts are checked by THEIR names too: a downloaded chart's song.ini
		// carries the chart's title, which can differ from the last.fm track title
		// (feat. suffixes, remasters, fuzzy/variant matches).
		const songPairs: Array<{ artist: string; name: string }> = tracks.map(track => ({ artist: track.artist, name: track.name }))
		for (const entries of trackMatches.values()) {
			for (const entry of entries) {
				songPairs.push({ artist: entry.chart.artist ?? '', name: entry.chart.name ?? '' })
				if (entry.chart.chartName && entry.chart.chartName !== entry.chart.name) {
					songPairs.push({ artist: entry.chart.artist ?? '', name: entry.chart.chartName })
				}
			}
		}
		const inLibraryMap = getCatalogDb().checkSongsExist(songPairs)
		const pairKey = (artist: string | null, name: string | null) =>
			`${(artist ?? '').toLowerCase().trim()}|${(name ?? '').toLowerCase().trim()}`
		const libraryKey = (track: StoredTrack) => pairKey(track.artist, track.name)

		const matchRank: Record<ChartMatchType, number> = { exact: 3, fuzzy: 2, variant: 1 }
		const allRows: MatchRow[] = tracks.map(track => {
			const chartEntries = (trackMatches.get(track.id) ?? []).sort((a, b) =>
				matchRank[b.matchType] - matchRank[a.matchType]
				|| b.similarity - a.similarity
				|| (b.chart.modifiedTime ?? '').localeCompare(a.chart.modifiedTime ?? ''))
			const charts: SlimChart[] = chartEntries.map(entry => {
				// Strip the DB-only columns from the stored chart shape
				const { nameNorm: _nameNorm, chartName: _chartName, ...slim } = entry.chart
				return { ...slim, matchType: entry.matchType, similarity: entry.similarity }
			})
			const inLibrary = (inLibraryMap.get(libraryKey(track)) ?? false)
				|| chartEntries.some(entry =>
					(inLibraryMap.get(pairKey(entry.chart.artist, entry.chart.name)) ?? false)
					|| (entry.chart.chartName !== null && (inLibraryMap.get(pairKey(entry.chart.artist, entry.chart.chartName)) ?? false)))
			return {
				trackId: track.id,
				artist: track.artist,
				name: track.name,
				playcount: track.playcount,
				rank: track.rank,
				lovedAt: track.lovedAt,
				isLoved: lovedKeys === null ? true : lovedKeys.has(`${track.artistNorm}|${track.nameNorm}`),
				matchType: charts.length > 0 ? charts[0].matchType : null,
				inLibrary,
				artistChartCount: Math.max(0, ...track.bucketNorms.map(norm => bucketCounts.get(norm) ?? 0)),
				artistStatus: this.combineArtistStatus(track.bucketNorms.map(norm => cache.get(norm)?.status)),
				charts,
			}
		})

		const matchedTracks = allRows.filter(row => row.matchType !== null).length
		let rows = allRows
		if (query.hideOwned) rows = rows.filter(row => !row.inLibrary)
		if (query.hideMissingArtists) rows = rows.filter(row => row.artistChartCount > 0)
		if (query.hideUnmatchedSongs) rows = rows.filter(row => row.matchType !== null)
		if (query.minPlaycount !== null) rows = rows.filter(row => (row.playcount ?? 0) >= query.minPlaycount!)
		if (query.text.trim() !== '') {
			const needle = query.text.trim().toLowerCase()
			rows = rows.filter(row => row.artist.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
		}
		if (query.instrument !== null) {
			// Unmatched rows are hidden while an instrument filter is active
			rows = rows.filter(row => row.charts.some(chart => chart.instruments.includes(query.instrument!)))
		}

		rows = this.sortRows(rows, query)
		return { rows, totalTracks: tracks.length, matchedTracks, lastSyncAt: db.getMeta('lastSyncAt') }
	}

	private combineArtistStatus(statuses: Array<ArtistCacheStatus | undefined>): ArtistCacheStatus {
		if (statuses.some(status => status === 'ok')) return 'ok'
		if (statuses.some(status => status === 'overflow')) return 'overflow'
		if (statuses.some(status => status === 'empty')) return 'empty'
		if (statuses.some(status => status === 'error')) return 'error'
		return 'pending'
	}

	private sortRows(rows: MatchRow[], query: MatchQuery): MatchRow[] {
		const matchRank = (row: MatchRow) => row.matchType === 'exact' ? 3 : row.matchType === 'fuzzy' ? 2 : row.matchType === 'variant' ? 1 : 0
		const rankAsc = (a: MatchRow, b: MatchRow) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
		if (query.sort === null) {
			return [...rows].sort(query.source === 'loved' ? (a, b) => (b.lovedAt ?? 0) - (a.lovedAt ?? 0) : rankAsc)
		}
		const direction = query.sort.direction === 'desc' ? -1 : 1
		const compare = (a: MatchRow, b: MatchRow): number => {
			switch (query.sort!.column) {
				case 'track': return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
				case 'artist': return a.artist.toLowerCase().localeCompare(b.artist.toLowerCase())
				case 'plays': return (a.playcount ?? a.lovedAt ?? 0) - (b.playcount ?? b.lovedAt ?? 0)
				case 'match': return (matchRank(a) - matchRank(b)) || ((a.charts[0]?.similarity ?? 0) - (b.charts[0]?.similarity ?? 0))
				case 'charts': return a.charts.length - b.charts.length
				case 'artistCharts': return a.artistChartCount - b.artistChartCount
				case 'inLibrary': return Number(a.inLibrary) - Number(b.inLibrary)
			}
		}
		return [...rows].sort((a, b) => direction * compare(a, b) || rankAsc(a, b))
	}
}

// Singleton instance
let instance: LastfmService | null = null

export function getLastfmService(): LastfmService {
	if (!instance) {
		instance = new LastfmService()
	}
	return instance
}
