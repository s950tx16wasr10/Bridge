/**
 * Bridge Last.fm Discover Module - Chorus Encore API Client
 *
 * Talks to the same https://api.enchor.us backend the browse tab uses, but with
 * header-aware pacing: the rate-limit budget is shared with the renderer's own
 * searches, so this client adapts to X-Ratelimit-* headers instead of assuming
 * a fixed request cost.
 */

const API_ROOT = 'https://api.enchor.us'
const USER_AGENT = 'Bridge-Discover/3.5.0 (+https://github.com/s950tx16wasr10/Bridge)'
const BASELINE_GAP_MS = 2000
const MISSING_HEADERS_GAP_MS = 10000
const MAX_RETRIES = 3
const MAX_RATE_LIMIT_WAITS = 10
const DEFAULT_OBSERVED_COST = 10

export const ENCHOR_PER_PAGE = 250

export class EnchorBadRequestError extends Error { }

export interface RawEnchorChart {
	chartId: number
	name: string | null
	chartName: string | null
	artist: string | null
	album: string | null
	genre: string | null
	year: string | null
	charter: string | null
	md5: string
	albumArtMd5: string | null
	hasVideoBackground: boolean
	songId: number | null
	groupId: number | null
	song_length: number | null
	diff_guitar: number | null
	diff_bass: number | null
	diff_drums: number | null
	diff_keys: number | null
	diff_vocals: number | null
	modifiedTime: string | null
	notesData: { instruments?: string[] } | null
}

export interface EnchorSearchResult {
	found: number
	charts: RawEnchorChart[]
}

interface TextFilter {
	value: string
	exact: boolean
	exclude: boolean
}

const emptyFilter = (): TextFilter => ({ value: '', exact: false, exclude: false })

function advancedSearchBody(filters: { artist?: TextFilter; name?: TextFilter }, page: number) {
	return {
		instrument: null,
		difficulty: null,
		drumType: null,
		drumsReviewed: false,
		sort: null,
		source: 'bridge',
		per_page: ENCHOR_PER_PAGE,
		page,
		name: filters.name ?? emptyFilter(),
		artist: filters.artist ?? emptyFilter(),
		album: emptyFilter(),
		genre: emptyFilter(),
		year: emptyFilter(),
		charter: emptyFilter(),
		minLength: null,
		maxLength: null,
		minIntensity: null,
		maxIntensity: null,
		minAverageNPS: null,
		maxAverageNPS: null,
		minMaxNPS: null,
		maxMaxNPS: null,
		minYear: null,
		maxYear: null,
		modifiedAfter: null,
		hash: null,
		hasSoloSections: null,
		hasForcedNotes: null,
		hasOpenNotes: null,
		hasTapNotes: null,
		hasLyrics: null,
		hasVocals: null,
		hasRollLanes: null,
		has2xKick: null,
		hasIssues: null,
		hasVideoBackground: null,
		modchart: null,
	}
}

export class EnchorClient {

	private nextAllowedAt = 0
	private lastRemaining: number | null = null
	private observedCost = DEFAULT_OBSERVED_COST

	searchArtist(artist: string, exact: boolean, page: number): Promise<EnchorSearchResult> {
		return this.search({ artist: { value: artist, exact, exclude: false } }, page)
	}

	searchTrack(artist: string, name: string): Promise<EnchorSearchResult> {
		return this.search({
			artist: { value: artist, exact: false, exclude: false },
			name: { value: name, exact: false, exclude: false },
		}, 1)
	}

	private async search(filters: { artist?: TextFilter; name?: TextFilter }, page: number): Promise<EnchorSearchResult> {
		const body = JSON.stringify(advancedSearchBody(filters, page))
		let rateLimitWaits = 0
		for (let attempt = 0; ; ) {
			await this.pace()
			let response: Response
			try {
				response = await fetch(`${API_ROOT}/search/advanced`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
					body,
				})
			} catch (err) {
				if (attempt >= MAX_RETRIES) throw err
				attempt++
				this.nextAllowedAt = Date.now() + BASELINE_GAP_MS * attempt
				continue
			}

			this.updatePacing(response)

			if (response.status === 429) {
				// Sleeping until the reported reset does not consume the retry budget
				if (rateLimitWaits++ >= MAX_RATE_LIMIT_WAITS) {
					throw new Error('Enchor rate limit did not recover after repeated waits')
				}
				this.nextAllowedAt = this.resetTime(response)
				continue
			}
			if (response.status === 400) {
				throw new EnchorBadRequestError(`Enchor rejected the search request: ${await response.text()}`)
			}
			if (!response.ok) {
				if (attempt >= MAX_RETRIES) {
					throw new Error(`Enchor search failed with HTTP ${response.status}`)
				}
				attempt++
				this.nextAllowedAt = Date.now() + BASELINE_GAP_MS * attempt
				continue
			}

			const result = await response.json() as { found: number; data: RawEnchorChart[] }
			return { found: result.found, charts: result.data }
		}
	}

	private async pace(): Promise<void> {
		const wait = this.nextAllowedAt - Date.now()
		if (wait > 0) {
			await new Promise(resolve => setTimeout(resolve, wait))
		}
	}

	private resetTime(response: Response): number {
		const reset = parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10)
		const jitter = 500 + Math.floor(Math.random() * 1000)
		if (Number.isFinite(reset) && reset > 0) {
			return Math.max(reset * 1000 + jitter, Date.now() + BASELINE_GAP_MS)
		}
		return Date.now() + MISSING_HEADERS_GAP_MS + jitter
	}

	private updatePacing(response: Response): void {
		const remaining = parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10)
		if (!Number.isFinite(remaining) || remaining < 0) {
			// Missing or nonsensical headers (e.g. a CDN error page): assume the budget
			// is exhausted and re-probe after a conservative gap
			this.lastRemaining = null
			this.nextAllowedAt = Date.now() + MISSING_HEADERS_GAP_MS
			return
		}
		if (this.lastRemaining !== null && this.lastRemaining > remaining) {
			this.observedCost = this.lastRemaining - remaining
		}
		this.lastRemaining = remaining
		if (remaining < Math.max(this.observedCost * 1.5, 15)) {
			this.nextAllowedAt = this.resetTime(response)
			this.lastRemaining = null
		} else {
			this.nextAllowedAt = Date.now() + BASELINE_GAP_MS
		}
	}
}
