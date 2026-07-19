import { Component, ElementRef, HostBinding, ViewChild, computed, inject, signal } from '@angular/core'
import { Router, RouterLink } from '@angular/router'
import { FormsModule } from '@angular/forms'
import { DatePipe, NgClass } from '@angular/common'

import _ from 'lodash'
import { Instrument } from 'scan-chart'
import { SearchService } from 'src-angular/app/core/services/search.service'
import { ChartMatchType, LastfmSource, MatchRow, MatchSortColumn, SlimChart } from 'src-shared/interfaces/lastfm.interface'
import { AdvancedSearch } from 'src-shared/interfaces/search.interface'
import { instrumentDisplay, instruments, shortInstrumentDisplay } from 'src-shared/UtilFunctions'

import { DownloadService } from '../../core/services/download.service'
import { LastfmService } from '../../core/services/lastfm.service'
import { SettingsService } from '../../core/services/settings.service'

const matchTypeRank: Record<ChartMatchType, number> = { exact: 3, fuzzy: 2, variant: 1 }

@Component({
	selector: 'app-discover',
	standalone: true,
	imports: [FormsModule, NgClass, DatePipe, RouterLink],
	templateUrl: './discover.component.html',
})
export class DiscoverComponent {
	lastfmService = inject(LastfmService)
	settingsService = inject(SettingsService)
	downloadService = inject(DownloadService)
	private searchService = inject(SearchService)
	private router = inject(Router)

	@HostBinding('class.contents') contents = true

	@ViewChild('libraryDirectoryErrorModal') libraryDirectoryErrorModal: ElementRef<HTMLDialogElement>

	instruments = instruments
	instrumentDisplay = instrumentDisplay

	readonly sources: { value: LastfmSource; label: string }[] = [
		{ value: 'top_overall', label: 'Top tracks: all time' },
		{ value: 'top_12month', label: 'Top tracks: last 12 months' },
		{ value: 'top_6month', label: 'Top tracks: last 6 months' },
		{ value: 'top_3month', label: 'Top tracks: last 3 months' },
		{ value: 'top_1month', label: 'Top tracks: last month' },
		{ value: 'top_7day', label: 'Top tracks: last 7 days' },
		{ value: 'loved', label: 'Loved tracks' },
	]
	readonly syncMinPlaysOptions = [2, 3, 5, 10, 25]

	// Expansion is keyed by trackId so it survives re-queries; multiple rows can be open at once
	expandedTracks = signal<Set<number>>(new Set<number>())

	matches = this.lastfmService.matches

	isConfigured = computed(() => !!this.settingsService.lastfmUsername.trim() && !!this.settingsService.lastfmApiKey.trim())

	isSyncing = computed(() => {
		const progress = this.lastfmService.syncProgress()
		return progress !== null && progress.phase !== 'done' && progress.phase !== 'error'
	})

	syncError = computed(() => {
		const progress = this.lastfmService.syncProgress()
		return progress?.phase === 'error' ? progress.error ?? progress.message : null
	})

	downloadedMd5s = computed(() => new Set(this.downloadService.downloads().filter(d => d.type === 'done').map(d => d.md5)))

	sortColumn = computed(() => this.lastfmService.sort()?.column ?? null)
	sortDirection = computed(() => this.lastfmService.sort()?.direction ?? 'asc')

	constructor() {
		if (this.isConfigured()) {
			this.lastfmService.refreshMatches()
		}
	}

	onColClicked(column: MatchSortColumn) {
		const current = this.lastfmService.sort()
		if (current?.column !== column) {
			this.lastfmService.setSort({ column, direction: 'asc' })
		} else if (current.direction === 'asc') {
			this.lastfmService.setSort({ column, direction: 'desc' })
		} else {
			this.lastfmService.setSort(null)
		}
	}

	toggleExpanded(trackId: number) {
		this.expandedTracks.update(set => {
			const newSet = new Set(set)
			if (newSet.has(trackId)) {
				newSet.delete(trackId)
			} else {
				newSet.add(trackId)
			}
			return newSet
		})
	}

	/**
	 * The charts of this row that pass the active instrument filter.
	 */
	visibleCharts(row: MatchRow): SlimChart[] {
		const instrument = this.lastfmService.instrument()
		if (instrument === null) { return row.charts }
		return row.charts.filter(c => c.instruments.includes(instrument))
	}

	/**
	 * The best chart for the row-level download: highest matchType (exact > fuzzy > variant),
	 * then similarity, tie-break most-recent modifiedTime.
	 */
	bestChart(row: MatchRow): SlimChart | null {
		return _.orderBy(
			this.visibleCharts(row),
			[c => matchTypeRank[c.matchType], c => c.similarity, c => c.modifiedTime ?? ''],
			['desc', 'desc', 'desc']
		)[0] ?? null
	}

	rowAlbumArtMd5(row: MatchRow): string | null {
		return row.charts.find(c => !!c.albumArtMd5)?.albumArtMd5 ?? null
	}

	artistStatusTip(row: MatchRow): string {
		switch (row.artistStatus) {
			case 'empty': return 'Artist not found on Enchor'
			case 'error': return 'Enchor lookup failed. Retries on the next sync.'
			case 'pending': return 'Not checked yet. Run a sync to look this artist up.'
			default: return 'No charts for this artist'
		}
	}

	isDownloaded(row: MatchRow): boolean {
		const downloaded = this.downloadedMd5s()
		return row.charts.some(c => downloaded.has(c.md5))
	}

	instrumentBadges(chart: SlimChart): { label: string; diff: number | null }[] {
		const diffs: Record<string, number | null> = {
			guitar: chart.diffGuitar,
			bass: chart.diffBass,
			drums: chart.diffDrums,
			keys: chart.diffKeys,
			vocals: chart.diffVocals,
		}
		return chart.instruments.map(instrument => ({
			label: shortInstrumentDisplay(instrument as Instrument) ?? _.capitalize(instrument),
			diff: diffs[instrument] ?? null,
		}))
	}

	onMinPlaycountChange(value: number | null) {
		this.lastfmService.setMinPlaycount(typeof value === 'number' && !isNaN(value) ? value : null)
	}

	onDownloadRow(row: MatchRow) {
		const chart = this.bestChart(row)
		if (chart) {
			this.downloadChart(chart)
		}
	}

	downloadChart(chart: SlimChart) {
		if (this.settingsService.libraryDirectory) {
			this.downloadService.addDownload({
				md5: chart.md5,
				hasVideoBackground: chart.hasVideoBackground,
				name: chart.name,
				artist: chart.artist,
				album: chart.album,
				genre: chart.genre,
				year: chart.year,
				charter: chart.charter,
			})
		} else {
			this.libraryDirectoryErrorModal.nativeElement.showModal()
		}
	}

	openInBrowse(row: MatchRow) {
		const chart = this.bestChart(row)
		const search = chart !== null && chart.name !== null
			? this.buildBrowseSearch(chart.artist ?? row.artist, chart.name)
			: this.buildBrowseSearch(row.artist)
		this.searchService.advancedSearch(search).subscribe()
		this.router.navigateByUrl('/browse')
	}

	/**
	 * Builds a complete `AdvancedSearch`: the Enchor chart's canonical name (exact) for matched
	 * rows, or artist-only for unmatched rows. All other filters are unused defaults.
	 */
	private buildBrowseSearch(artist: string, name?: string): AdvancedSearch {
		const emptyText = () => ({ value: '', exact: false, exclude: false })
		return {
			instrument: this.searchService.instrument(),
			difficulty: this.searchService.difficulty(),
			drumType: this.searchService.drumType(),
			drumsReviewed: this.searchService.drumsReviewed(),
			sort: null,
			source: 'bridge',
			name: name !== undefined ? { value: name, exact: true, exclude: false } : emptyText(),
			artist: { value: artist, exact: false, exclude: false },
			album: emptyText(),
			genre: emptyText(),
			year: emptyText(),
			charter: emptyText(),
			minLength: null,
			maxLength: null,
			minIntensity: null,
			maxIntensity: null,
			minAverageNPS: null,
			maxAverageNPS: null,
			minMaxNPS: null,
			maxMaxNPS: null,
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

	openUrl(url: string) {
		window.electron.emit.openUrl(url)
	}
}
