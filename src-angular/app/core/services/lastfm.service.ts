import { Injectable, signal } from '@angular/core'

import { Instrument } from 'scan-chart'
import {
	LastfmSource,
	LastfmSyncProgress,
	LastfmValidateResult,
	MatchQuery,
	MatchResult,
	MatchSortColumn,
} from 'src-shared/interfaces/lastfm.interface'

@Injectable({
	providedIn: 'root',
})
export class LastfmService {

	readonly syncProgress = signal<LastfmSyncProgress | null>(null)
	readonly matches = signal<MatchResult | null>(null)

	// Filter state, persisted under "discover."-prefixed localStorage keys (never the bare browse keys)
	readonly source = signal<LastfmSource>((localStorage.getItem('discover.source') ?? 'top_overall') as LastfmSource)
	readonly syncMinPlays = signal<number>(Number(localStorage.getItem('discover.syncMinPlays') ?? '3'))
	readonly instrument = signal<Instrument | null>(
		(localStorage.getItem('discover.instrument') === 'null' ? null : localStorage.getItem('discover.instrument')) as Instrument | null
	)
	readonly hideOwned = signal<boolean>((localStorage.getItem('discover.hideOwned') ?? 'false') === 'true')
	readonly hideMissingArtists = signal<boolean>((localStorage.getItem('discover.hideMissingArtists') ?? 'true') === 'true')
	readonly hideUnmatchedSongs = signal<boolean>((localStorage.getItem('discover.hideUnmatchedSongs') ?? 'true') === 'true')
	readonly minPlaycount = signal<number | null>(
		localStorage.getItem('discover.minPlaycount') === null || localStorage.getItem('discover.minPlaycount') === 'null'
			? null
			: Number(localStorage.getItem('discover.minPlaycount'))
	)
	readonly textFilter = signal<string>(localStorage.getItem('discover.textFilter') ?? '')
	readonly sort = signal<{ column: MatchSortColumn; direction: 'asc' | 'desc' } | null>(null)

	private lastMatchesRefresh = 0
	private matchesRefreshTimeout: ReturnType<typeof setTimeout> | null = null

	constructor() {
		this.setupIpcListeners()
		this.reattachToRunningSync()
	}

	private setupIpcListeners(): void {
		window.electron.on.lastfmSyncProgress((progress: LastfmSyncProgress) => {
			this.syncProgress.set(progress)
			if (progress.phase === 'done') {
				this.refreshMatchesNow()
			} else {
				this.throttledRefreshMatches()
			}
		})
		// In-library pills are computed from catalog.db, so refresh matches after a scan completes
		window.electron.on.catalogScanProgress(progress => {
			if (progress.phase === 'complete') {
				this.refreshMatches()
			}
		})
	}

	/**
	 * Re-attaches to a sync that is still running in the main process after a renderer reload.
	 */
	private async reattachToRunningSync(): Promise<void> {
		try {
			const state = await window.electron.invoke.lastfmGetSyncState()
			if (state !== null) {
				this.syncProgress.set(state)
			}
		} catch (err) {
			console.error('Failed to get Last.fm sync state:', err)
		}
	}

	/**
	 * Trailing-edge throttle: re-queries matches at most once every 2 seconds during a sync.
	 */
	private throttledRefreshMatches(): void {
		if (this.matchesRefreshTimeout !== null) { return }
		const delay = Math.max(0, 2000 - (Date.now() - this.lastMatchesRefresh))
		this.matchesRefreshTimeout = setTimeout(() => {
			this.matchesRefreshTimeout = null
			this.refreshMatches()
		}, delay)
	}

	private refreshMatchesNow(): void {
		if (this.matchesRefreshTimeout !== null) {
			clearTimeout(this.matchesRefreshTimeout)
			this.matchesRefreshTimeout = null
		}
		this.refreshMatches()
	}

	async refreshMatches(): Promise<void> {
		this.lastMatchesRefresh = Date.now()
		try {
			const result = await window.electron.invoke.lastfmGetMatches(this.buildMatchQuery())
			this.matches.set(result)
		} catch (err) {
			console.error('Failed to get Last.fm matches:', err)
			this.matches.set({ rows: [], totalTracks: 0, matchedTracks: 0, lastSyncAt: null })
		}
	}

	private buildMatchQuery(): MatchQuery {
		return {
			source: this.source(),
			instrument: this.instrument(),
			hideOwned: this.hideOwned(),
			hideMissingArtists: this.hideMissingArtists(),
			hideUnmatchedSongs: this.hideUnmatchedSongs(),
			minPlaycount: this.minPlaycount(),
			text: this.textFilter(),
			sort: this.sort(),
		}
	}

	startSync(): void {
		window.electron.emit.lastfmSync({ action: 'start', options: { source: this.source(), minPlaycount: this.syncMinPlays() } })
	}

	cancelSync(): void {
		window.electron.emit.lastfmSync({ action: 'cancel' })
	}

	async validateUser(username: string, apiKey: string): Promise<LastfmValidateResult> {
		try {
			return await window.electron.invoke.lastfmValidateUser({ username, apiKey })
		} catch (err) {
			console.error('Last.fm user validation failed:', err)
			return { ok: false, code: 'network', message: String(err) }
		}
	}

	setSource(value: LastfmSource) {
		this.source.set(value)
		localStorage.setItem('discover.source', value)
		this.refreshMatches()
	}

	setSyncMinPlays(value: number) {
		this.syncMinPlays.set(value)
		localStorage.setItem('discover.syncMinPlays', `${value}`)
	}

	setInstrument(value: Instrument | null) {
		this.instrument.set(value)
		localStorage.setItem('discover.instrument', `${value}`)
		this.refreshMatches()
	}

	setHideOwned(value: boolean) {
		this.hideOwned.set(value)
		localStorage.setItem('discover.hideOwned', `${value}`)
		this.refreshMatches()
	}

	setHideMissingArtists(value: boolean) {
		this.hideMissingArtists.set(value)
		localStorage.setItem('discover.hideMissingArtists', `${value}`)
		this.refreshMatches()
	}

	setHideUnmatchedSongs(value: boolean) {
		this.hideUnmatchedSongs.set(value)
		localStorage.setItem('discover.hideUnmatchedSongs', `${value}`)
		this.refreshMatches()
	}

	setMinPlaycount(value: number | null) {
		this.minPlaycount.set(value)
		localStorage.setItem('discover.minPlaycount', `${value}`)
		this.refreshMatches()
	}

	setTextFilter(value: string) {
		this.textFilter.set(value)
		localStorage.setItem('discover.textFilter', value)
		this.refreshMatches()
	}

	setSort(value: { column: MatchSortColumn; direction: 'asc' | 'desc' } | null) {
		this.sort.set(value)
		this.refreshMatches()
	}
}
