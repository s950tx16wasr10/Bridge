/**
 * Bridge Last.fm Discover Module - Database Service
 * Handles SQLite operations for the Last.fm track/chart match cache
 */

import Database from 'better-sqlite3'
import * as path from 'path'

import { ArtistCacheStatus, ChartMatchType, LastfmSource, SlimChart } from '../../../src-shared/interfaces/lastfm.interface.js'
import { dataPath } from '../../../src-shared/Paths.js'

export interface StoredTrack {
	id: number
	source: LastfmSource
	artist: string
	name: string
	artistNorm: string
	nameNorm: string
	bucketNorms: string[]
	playcount: number | null
	rank: number | null
	lovedAt: number | null
}

export interface TrackInput {
	artist: string
	name: string
	artistNorm: string
	nameNorm: string
	bucketNorms: string[]
	playcount: number | null
	rank: number | null
	lovedAt: number | null
}

export interface ArtistCacheRow {
	artistNorm: string
	queryValue: string
	strategy: 'nonexact' | 'exact' | 'pertrack'
	chartCount: number
	queriedTracks: string[]
	status: Exclude<ArtistCacheStatus, 'pending'>
	fetchedAt: string
}

/** The enchor_charts row shape: SlimChart minus match info, plus chartName for matching fall-through. */
export type StoredChart = Omit<SlimChart, 'matchType' | 'similarity'> & { nameNorm: string; chartName: string | null }

export interface MatchInput {
	trackId: number
	chartId: number
	matchType: ChartMatchType
	similarity: number
}

const boolToInt = (val: boolean): number => val ? 1 : 0

class LastfmDatabase {
	private db: Database.Database

	constructor() {
		this.db = new Database(path.join(dataPath, 'lastfm.db'))
		this.db.pragma('journal_mode = WAL')
		this.db.pragma('foreign_keys = ON')
		this.initializeSchema()
	}

	private initializeSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS lastfm_tracks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				artist TEXT NOT NULL,
				name TEXT NOT NULL,
				artistNorm TEXT NOT NULL,
				nameNorm TEXT NOT NULL,
				bucketNorms TEXT NOT NULL DEFAULT '',
				playcount INTEGER,
				rank INTEGER,
				lovedAt INTEGER,
				fetchedAt TEXT NOT NULL,
				UNIQUE(source, artistNorm, nameNorm)
			);

			CREATE TABLE IF NOT EXISTS enchor_artist_cache (
				artistNorm TEXT PRIMARY KEY,
				queryValue TEXT NOT NULL,
				strategy TEXT NOT NULL,
				chartCount INTEGER NOT NULL,
				queriedTracks TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL,
				fetchedAt TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS enchor_charts (
				chartId INTEGER PRIMARY KEY,
				artist TEXT,
				name TEXT,
				chartName TEXT,
				nameNorm TEXT NOT NULL,
				charter TEXT,
				md5 TEXT NOT NULL,
				albumArtMd5 TEXT,
				hasVideoBackground INTEGER NOT NULL DEFAULT 0,
				songId INTEGER,
				groupId INTEGER,
				songLength INTEGER,
				instruments TEXT NOT NULL DEFAULT '',
				diffGuitar INTEGER,
				diffBass INTEGER,
				diffDrums INTEGER,
				diffKeys INTEGER,
				diffVocals INTEGER,
				album TEXT,
				genre TEXT,
				year TEXT,
				modifiedTime TEXT
			);

			CREATE TABLE IF NOT EXISTS artist_charts (
				artistNorm TEXT NOT NULL,
				chartId INTEGER NOT NULL REFERENCES enchor_charts(chartId) ON DELETE CASCADE,
				PRIMARY KEY (artistNorm, chartId)
			);

			CREATE TABLE IF NOT EXISTS matches (
				trackId INTEGER NOT NULL REFERENCES lastfm_tracks(id) ON DELETE CASCADE,
				chartId INTEGER NOT NULL REFERENCES enchor_charts(chartId) ON DELETE CASCADE,
				matchType TEXT NOT NULL,
				similarity REAL NOT NULL,
				PRIMARY KEY (trackId, chartId)
			);

			CREATE TABLE IF NOT EXISTS lastfm_meta (
				key TEXT PRIMARY KEY,
				value TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_artist_charts_chartId ON artist_charts(chartId);
			CREATE INDEX IF NOT EXISTS idx_lastfm_tracks_source ON lastfm_tracks(source);
		`)
	}

	getMeta(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM lastfm_meta WHERE key = ?').get(key) as { value: string } | undefined
		return row?.value ?? null
	}

	setMeta(key: string, value: string): void {
		this.db.prepare('INSERT INTO lastfm_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
	}

	/**
	 * Replaces all tracks for one source. Match rows for removed tracks are
	 * deleted explicitly in the same transaction.
	 */
	replaceSourceTracks(source: LastfmSource, tracks: TrackInput[]): void {
		const replace = this.db.transaction(() => {
			this.db.prepare('DELETE FROM matches WHERE trackId IN (SELECT id FROM lastfm_tracks WHERE source = ?)').run(source)
			this.db.prepare('DELETE FROM lastfm_tracks WHERE source = ?').run(source)
			const insert = this.db.prepare(`
				INSERT OR IGNORE INTO lastfm_tracks (source, artist, name, artistNorm, nameNorm, bucketNorms, playcount, rank, lovedAt, fetchedAt)
				VALUES (@source, @artist, @name, @artistNorm, @nameNorm, @bucketNorms, @playcount, @rank, @lovedAt, @fetchedAt)
			`)
			const fetchedAt = new Date().toISOString()
			for (const track of tracks) {
				insert.run({
					source,
					artist: track.artist,
					name: track.name,
					artistNorm: track.artistNorm,
					nameNorm: track.nameNorm,
					bucketNorms: track.bucketNorms.join('\n'),
					playcount: track.playcount,
					rank: track.rank,
					lovedAt: track.lovedAt,
					fetchedAt,
				})
			}
		})
		replace()
	}

	getAllTracks(): StoredTrack[] {
		const rows = this.db.prepare('SELECT * FROM lastfm_tracks').all() as Array<Record<string, unknown>>
		return rows.map(row => this.rowToTrack(row))
	}

	/** Deletes all user-specific data (tracks and matches) after a username change. */
	clearUserData(): void {
		const clear = this.db.transaction(() => {
			this.db.prepare('DELETE FROM matches').run()
			this.db.prepare('DELETE FROM lastfm_tracks').run()
			this.db.prepare('DELETE FROM lastfm_meta').run()
		})
		clear()
	}

	/** Deletes the whole Enchor-side cache, forcing a refetch on the next sync. */
	clearEnchorCache(): void {
		const clear = this.db.transaction(() => {
			this.db.prepare('DELETE FROM matches').run()
			this.db.prepare('DELETE FROM artist_charts').run()
			this.db.prepare('DELETE FROM enchor_charts').run()
			this.db.prepare('DELETE FROM enchor_artist_cache').run()
		})
		clear()
	}

	getArtistCache(): Map<string, ArtistCacheRow> {
		const rows = this.db.prepare('SELECT * FROM enchor_artist_cache').all() as Array<Record<string, unknown>>
		const result = new Map<string, ArtistCacheRow>()
		for (const row of rows) {
			result.set(row.artistNorm as string, {
				artistNorm: row.artistNorm as string,
				queryValue: row.queryValue as string,
				strategy: row.strategy as ArtistCacheRow['strategy'],
				chartCount: row.chartCount as number,
				queriedTracks: (row.queriedTracks as string) === '' ? [] : (row.queriedTracks as string).split('\n'),
				status: row.status as ArtistCacheRow['status'],
				fetchedAt: row.fetchedAt as string,
			})
		}
		return result
	}

	/**
	 * Authoritatively replaces one artist bucket: upserts the fresh charts, replaces
	 * the bucket's memberships, garbage-collects charts no longer referenced by any
	 * bucket, and writes the cache row — all in one transaction.
	 */
	replaceArtistBucket(cache: ArtistCacheRow, charts: StoredChart[]): void {
		const replace = this.db.transaction(() => {
			const upsert = this.db.prepare(`
				INSERT INTO enchor_charts (chartId, artist, name, chartName, nameNorm, charter, md5, albumArtMd5, hasVideoBackground,
					songId, groupId, songLength, instruments, diffGuitar, diffBass, diffDrums, diffKeys, diffVocals,
					album, genre, year, modifiedTime)
				VALUES (@chartId, @artist, @name, @chartName, @nameNorm, @charter, @md5, @albumArtMd5, @hasVideoBackground,
					@songId, @groupId, @songLength, @instruments, @diffGuitar, @diffBass, @diffDrums, @diffKeys, @diffVocals,
					@album, @genre, @year, @modifiedTime)
				ON CONFLICT(chartId) DO UPDATE SET
					artist = excluded.artist, name = excluded.name, chartName = excluded.chartName, nameNorm = excluded.nameNorm,
					charter = excluded.charter, md5 = excluded.md5, albumArtMd5 = excluded.albumArtMd5,
					hasVideoBackground = excluded.hasVideoBackground, songId = excluded.songId, groupId = excluded.groupId,
					songLength = excluded.songLength, instruments = excluded.instruments,
					diffGuitar = excluded.diffGuitar, diffBass = excluded.diffBass, diffDrums = excluded.diffDrums,
					diffKeys = excluded.diffKeys, diffVocals = excluded.diffVocals,
					album = excluded.album, genre = excluded.genre, year = excluded.year, modifiedTime = excluded.modifiedTime
			`)
			for (const chart of charts) {
				upsert.run({
					chartId: chart.chartId,
					artist: chart.artist,
					name: chart.name,
					chartName: chart.chartName,
					nameNorm: chart.nameNorm,
					charter: chart.charter,
					md5: chart.md5,
					albumArtMd5: chart.albumArtMd5,
					hasVideoBackground: boolToInt(chart.hasVideoBackground),
					songId: chart.songId,
					groupId: chart.groupId,
					songLength: chart.songLength,
					instruments: chart.instruments.join(','),
					diffGuitar: chart.diffGuitar,
					diffBass: chart.diffBass,
					diffDrums: chart.diffDrums,
					diffKeys: chart.diffKeys,
					diffVocals: chart.diffVocals,
					album: chart.album,
					genre: chart.genre,
					year: chart.year,
					modifiedTime: chart.modifiedTime,
				})
			}

			this.db.prepare('DELETE FROM artist_charts WHERE artistNorm = ?').run(cache.artistNorm)
			const insertMembership = this.db.prepare('INSERT OR IGNORE INTO artist_charts (artistNorm, chartId) VALUES (?, ?)')
			for (const chart of charts) {
				insertMembership.run(cache.artistNorm, chart.chartId)
			}
			this.db.prepare('DELETE FROM enchor_charts WHERE chartId NOT IN (SELECT DISTINCT chartId FROM artist_charts)').run()

			this.db.prepare(`
				INSERT INTO enchor_artist_cache (artistNorm, queryValue, strategy, chartCount, queriedTracks, status, fetchedAt)
				VALUES (@artistNorm, @queryValue, @strategy, @chartCount, @queriedTracks, @status, @fetchedAt)
				ON CONFLICT(artistNorm) DO UPDATE SET
					queryValue = excluded.queryValue, strategy = excluded.strategy, chartCount = excluded.chartCount,
					queriedTracks = excluded.queriedTracks, status = excluded.status, fetchedAt = excluded.fetchedAt
			`).run({
				artistNorm: cache.artistNorm,
				queryValue: cache.queryValue,
				strategy: cache.strategy,
				chartCount: cache.chartCount,
				queriedTracks: cache.queriedTracks.join('\n'),
				status: cache.status,
				fetchedAt: cache.fetchedAt,
			})
		})
		replace()
	}

	/** Writes a cache row without touching the bucket (used for error/empty statuses). */
	upsertArtistCache(cache: ArtistCacheRow): void {
		this.db.prepare(`
			INSERT INTO enchor_artist_cache (artistNorm, queryValue, strategy, chartCount, queriedTracks, status, fetchedAt)
			VALUES (@artistNorm, @queryValue, @strategy, @chartCount, @queriedTracks, @status, @fetchedAt)
			ON CONFLICT(artistNorm) DO UPDATE SET
				queryValue = excluded.queryValue, strategy = excluded.strategy, chartCount = excluded.chartCount,
				queriedTracks = excluded.queriedTracks, status = excluded.status, fetchedAt = excluded.fetchedAt
		`).run({
			artistNorm: cache.artistNorm,
			queryValue: cache.queryValue,
			strategy: cache.strategy,
			chartCount: cache.chartCount,
			queriedTracks: cache.queriedTracks.join('\n'),
			status: cache.status,
			fetchedAt: cache.fetchedAt,
		})
	}

	getBucketCharts(artistNorms: string[]): Map<string, StoredChart[]> {
		const result = new Map<string, StoredChart[]>()
		if (artistNorms.length === 0) return result
		const placeholders = artistNorms.map(() => '?').join(',')
		const rows = this.db.prepare(`
			SELECT ac.artistNorm as bucketNorm, ec.*
			FROM artist_charts ac
			INNER JOIN enchor_charts ec ON ec.chartId = ac.chartId
			WHERE ac.artistNorm IN (${placeholders})
		`).all(...artistNorms) as Array<Record<string, unknown>>
		for (const row of rows) {
			const bucketNorm = row.bucketNorm as string
			const charts = result.get(bucketNorm) ?? []
			charts.push(this.rowToStoredChart(row))
			result.set(bucketNorm, charts)
		}
		return result
	}

	getBucketChartCounts(): Map<string, number> {
		const rows = this.db.prepare('SELECT artistNorm, COUNT(*) as count FROM artist_charts GROUP BY artistNorm').all() as Array<{ artistNorm: string; count: number }>
		return new Map(rows.map(row => [row.artistNorm, row.count]))
	}

	/** Truncates and rebuilds the whole matches table in one transaction. */
	rebuildMatches(matches: MatchInput[]): void {
		const rebuild = this.db.transaction(() => {
			this.db.prepare('DELETE FROM matches').run()
			const insert = this.db.prepare('INSERT OR IGNORE INTO matches (trackId, chartId, matchType, similarity) VALUES (?, ?, ?, ?)')
			for (const match of matches) {
				insert.run(match.trackId, match.chartId, match.matchType, match.similarity)
			}
		})
		rebuild()
	}

	getTracksForSource(source: LastfmSource): StoredTrack[] {
		const rows = this.db.prepare('SELECT * FROM lastfm_tracks WHERE source = ?').all(source) as Array<Record<string, unknown>>
		return rows.map(row => this.rowToTrack(row))
	}

	/** Normalized (artistNorm, nameNorm) pairs of the loved source, for the ♥ marker. */
	getLovedKeys(): Set<string> {
		const rows = this.db.prepare('SELECT artistNorm, nameNorm FROM lastfm_tracks WHERE source = ?').all('loved') as Array<{ artistNorm: string; nameNorm: string }>
		return new Set(rows.map(row => `${row.artistNorm}|${row.nameNorm}`))
	}

	getMatchesForTracks(trackIds: number[]): Map<number, Array<{ chart: StoredChart; matchType: ChartMatchType; similarity: number }>> {
		const result = new Map<number, Array<{ chart: StoredChart; matchType: ChartMatchType; similarity: number }>>()
		if (trackIds.length === 0) return result
		const placeholders = trackIds.map(() => '?').join(',')
		const rows = this.db.prepare(`
			SELECT m.trackId, m.matchType, m.similarity, ec.*
			FROM matches m
			INNER JOIN enchor_charts ec ON ec.chartId = m.chartId
			WHERE m.trackId IN (${placeholders})
		`).all(...trackIds) as Array<Record<string, unknown>>
		for (const row of rows) {
			const trackId = row.trackId as number
			const list = result.get(trackId) ?? []
			list.push({
				chart: this.rowToStoredChart(row),
				matchType: row.matchType as ChartMatchType,
				similarity: row.similarity as number,
			})
			result.set(trackId, list)
		}
		return result
	}

	private rowToTrack(row: Record<string, unknown>): StoredTrack {
		return {
			id: row.id as number,
			source: row.source as LastfmSource,
			artist: row.artist as string,
			name: row.name as string,
			artistNorm: row.artistNorm as string,
			nameNorm: row.nameNorm as string,
			bucketNorms: (row.bucketNorms as string) === '' ? [] : (row.bucketNorms as string).split('\n'),
			playcount: row.playcount as number | null,
			rank: row.rank as number | null,
			lovedAt: row.lovedAt as number | null,
		}
	}

	private rowToStoredChart(row: Record<string, unknown>): StoredChart {
		return {
			chartId: row.chartId as number,
			artist: row.artist as string | null,
			name: row.name as string | null,
			chartName: row.chartName as string | null,
			nameNorm: row.nameNorm as string,
			charter: row.charter as string | null,
			md5: row.md5 as string,
			albumArtMd5: row.albumArtMd5 as string | null,
			hasVideoBackground: Boolean(row.hasVideoBackground),
			songId: row.songId as number | null,
			groupId: row.groupId as number | null,
			songLength: row.songLength as number | null,
			instruments: (row.instruments as string) === '' ? [] : (row.instruments as string).split(','),
			diffGuitar: row.diffGuitar as number | null,
			diffBass: row.diffBass as number | null,
			diffDrums: row.diffDrums as number | null,
			diffKeys: row.diffKeys as number | null,
			diffVocals: row.diffVocals as number | null,
			album: row.album as string | null,
			genre: row.genre as string | null,
			year: row.year as string | null,
			modifiedTime: row.modifiedTime as string | null,
		}
	}
}

// Singleton instance
let instance: LastfmDatabase | null = null

export function getLastfmDb(): LastfmDatabase {
	if (!instance) {
		instance = new LastfmDatabase()
	}
	return instance
}
