/**
 * Bridge Last.fm Discover Module - Last.fm API Client
 */

import Bottleneck from 'bottleneck'

import { LastfmSource, LastfmValidateResult } from '../../../src-shared/interfaces/lastfm.interface.js'

export interface LastfmTopTrack {
	artist: string
	name: string
	playcount: number
	rank: number
}

export interface LastfmLovedTrack {
	artist: string
	name: string
	lovedAt: number
}

interface LastfmErrorBody {
	error: number
	message: string
}

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/'
const USER_AGENT = 'Bridge-Discover/3.5.0 (+https://github.com/s950tx16wasr10/Bridge)'
const PAGE_SIZE = 200
// Safety backstop against absurd fetches (e.g. min plays 1 on a huge profile): 50k tracks
const MAX_TOP_TRACK_PAGES = 250
const MAX_RETRIES = 3
/** Last.fm error codes that are transient and safe to retry. */
const RETRYABLE_ERRORS = new Set([8, 11, 16, 29])

export class LastfmApiError extends Error {
	constructor(public code: number, message: string) {
		super(message)
	}
}

/** Last.fm returns single-item lists as a bare object instead of a one-element array. */
function asArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) return []
	return Array.isArray(value) ? value : [value]
}

/** All numbers in Last.fm JSON are strings. */
function asNumber(value: unknown): number {
	const parsed = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN
	return Number.isFinite(parsed) ? parsed : 0
}

export function lastfmPeriod(source: LastfmSource): string {
	switch (source) {
		case 'top_overall': return 'overall'
		case 'top_12month': return '12month'
		case 'top_6month': return '6month'
		case 'top_3month': return '3month'
		case 'top_1month': return '1month'
		case 'top_7day': return '7day'
		case 'loved': return 'overall'
	}
}

export class LastfmApi {

	private limiter = new Bottleneck({ minTime: 1000, maxConcurrent: 1 })

	private async request(params: Record<string, string>): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.limiter.schedule(async () => {
					const url = new URL(API_ROOT)
					for (const [key, value] of Object.entries(params)) {
						url.searchParams.set(key, value)
					}
					url.searchParams.set('format', 'json')
					const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
					const body = await response.json() as LastfmErrorBody | Record<string, unknown>
					if (body && typeof body === 'object' && 'error' in body) {
						throw new LastfmApiError(asNumber(body.error), String((body as LastfmErrorBody).message ?? 'Unknown Last.fm error'))
					}
					if (!response.ok) {
						throw new LastfmApiError(-1, `Last.fm returned HTTP ${response.status}`)
					}
					return body
				})
			} catch (err) {
				const retryable = err instanceof LastfmApiError ? RETRYABLE_ERRORS.has(err.code) : true
				if (!retryable || attempt >= MAX_RETRIES) throw err
				await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
			}
		}
	}

	async validateUser(username: string, apiKey: string): Promise<LastfmValidateResult> {
		try {
			const body = await this.request({ method: 'user.getinfo', user: username, api_key: apiKey }) as {
				user: { name: string; playcount?: unknown; url?: string; registered?: { unixtime?: unknown } }
			}
			return {
				ok: true,
				username: body.user.name,
				playcount: asNumber(body.user.playcount),
				url: body.user.url ?? `https://www.last.fm/user/${encodeURIComponent(username)}`,
				registeredAt: asNumber(body.user.registered?.unixtime),
			}
		} catch (err) {
			if (err instanceof LastfmApiError) {
				switch (err.code) {
					case 10: return { ok: false, code: 'badKey', message: 'Invalid API key. Check the key in Settings.' }
					case 6: return { ok: false, code: 'unknownUser', message: `Last.fm user "${username}" was not found.` }
					case 17: return { ok: false, code: 'private', message: 'This profile\'s listening data is private.' }
					case 29: return { ok: false, code: 'rateLimited', message: 'Last.fm rate limit exceeded. Try again in a minute.' }
				}
			}
			return { ok: false, code: 'network', message: `Could not reach Last.fm: ${err instanceof Error ? err.message : err}` }
		}
	}

	/**
	 * Fetches top tracks until playcount drops below `minPlaycount`. Top tracks
	 * arrive playcount-descending, so the first below-threshold track ends the walk.
	 */
	async getTopTracks(
		username: string,
		apiKey: string,
		source: LastfmSource,
		minPlaycount: number,
		onPage?: (fetchedCount: number) => void,
	): Promise<LastfmTopTrack[]> {
		const tracks: LastfmTopTrack[] = []
		for (let page = 1; page <= MAX_TOP_TRACK_PAGES; page++) {
			// The page size must stay constant across pages or the page indexing shifts
			const body = await this.request({
				method: 'user.gettoptracks',
				user: username,
				api_key: apiKey,
				period: lastfmPeriod(source),
				limit: String(PAGE_SIZE),
				page: String(page),
			}) as {
				toptracks: {
					'@attr'?: { totalPages?: unknown }
					track?: unknown
				}
			}
			const pageTracks = asArray(body.toptracks.track as { name: string; playcount?: unknown; artist?: { name?: string }; '@attr'?: { rank?: unknown } } | undefined)
			let reachedThreshold = false
			for (const track of pageTracks) {
				const playcount = asNumber(track.playcount)
				if (playcount < minPlaycount) {
					reachedThreshold = true
					break
				}
				tracks.push({
					artist: track.artist?.name ?? '',
					name: track.name,
					playcount,
					rank: asNumber(track['@attr']?.rank) || tracks.length + 1,
				})
			}
			onPage?.(tracks.length)
			const totalPages = asNumber(body.toptracks['@attr']?.totalPages)
			if (reachedThreshold || pageTracks.length === 0 || page >= totalPages) break
		}
		return tracks
	}

	async getLovedTracks(username: string, apiKey: string): Promise<LastfmLovedTrack[]> {
		const tracks: LastfmLovedTrack[] = []
		for (let page = 1; ; page++) {
			const body = await this.request({
				method: 'user.getlovedtracks',
				user: username,
				api_key: apiKey,
				limit: String(PAGE_SIZE),
				page: String(page),
			}) as {
				lovedtracks: {
					'@attr'?: { totalPages?: unknown }
					track?: unknown
				}
			}
			const pageTracks = asArray(body.lovedtracks.track as { name: string; artist?: { name?: string }; date?: { uts?: unknown } } | undefined)
			for (const track of pageTracks) {
				tracks.push({
					artist: track.artist?.name ?? '',
					name: track.name,
					lovedAt: asNumber(track.date?.uts),
				})
			}
			const totalPages = asNumber(body.lovedtracks['@attr']?.totalPages)
			if (pageTracks.length === 0 || page >= totalPages) break
		}
		return tracks
	}
}
