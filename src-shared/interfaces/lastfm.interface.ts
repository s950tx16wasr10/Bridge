import { Instrument } from 'scan-chart'

export type LastfmSource = 'top_overall' | 'top_12month' | 'top_6month' | 'top_3month' | 'top_1month' | 'top_7day' | 'loved'

export type LastfmValidateResult =
	| { ok: true; username: string; playcount: number; url: string; registeredAt: number }
	| { ok: false; code: 'badKey' | 'unknownUser' | 'private' | 'rateLimited' | 'network'; message: string }

export interface SyncOptions {
	source: LastfmSource // Loved tracks are always synced in addition to this source
	minPlaycount: number // Fetch top tracks until playcount drops below this (top tracks arrive playcount-descending)
}

export interface LastfmSyncProgress {
	phase: 'lastfm' | 'plan' | 'enchor' | 'match' | 'done' | 'error'
	current: number
	total: number
	message: string
	summary?: { trackCount: number; matchedCount: number; artistCount: number; elapsedMs: number }
	error?: string
}

export type MatchSortColumn = 'track' | 'artist' | 'plays' | 'match' | 'charts' | 'artistCharts' | 'inLibrary'

export interface MatchQuery {
	source: LastfmSource
	instrument: Instrument | null
	hideOwned: boolean
	hideMissingArtists: boolean // Hide tracks whose artist has no charts on Enchor at all
	hideUnmatchedSongs: boolean // Hide tracks whose artist has charts, but not this song
	minPlaycount: number | null
	text: string
	sort: { column: MatchSortColumn; direction: 'asc' | 'desc' } | null
}

export type ChartMatchType = 'exact' | 'fuzzy' | 'variant'

export interface SlimChart {
	chartId: number
	artist: string | null
	name: string | null
	charter: string | null
	md5: string
	albumArtMd5: string | null
	hasVideoBackground: boolean
	songId: number | null
	groupId: number | null
	songLength: number | null
	instruments: string[]
	diffGuitar: number | null
	diffBass: number | null
	diffDrums: number | null
	diffKeys: number | null
	diffVocals: number | null
	album: string | null
	genre: string | null
	year: string | null
	modifiedTime: string | null
	matchType: ChartMatchType
	similarity: number
}

export type ArtistCacheStatus = 'ok' | 'empty' | 'overflow' | 'error' | 'pending'

export interface MatchRow {
	trackId: number
	artist: string
	name: string
	playcount: number | null
	rank: number | null
	lovedAt: number | null
	isLoved: boolean
	matchType: ChartMatchType | null // `null` when no chart matched this track
	inLibrary: boolean
	artistChartCount: number
	artistStatus: ArtistCacheStatus
	charts: SlimChart[]
}

export interface MatchResult {
	rows: MatchRow[]
	totalTracks: number
	matchedTracks: number
	lastSyncAt: string | null
}

export type LastfmSyncAction =
	| { action: 'start'; options: SyncOptions }
	| { action: 'cancel' }
