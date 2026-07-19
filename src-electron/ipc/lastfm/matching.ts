/**
 * Bridge Last.fm Discover Module - Matching Algorithms
 * Pure normalization and match-classification functions (no I/O)
 */

import type { ChartMatchType } from '../../../src-shared/interfaces/lastfm.interface.js'

export interface TitleMatch {
	matchType: ChartMatchType
	similarity: number
}

export interface ArtistQuery {
	/** The `norm1` form of `queryValue`; the bucket key. */
	artistNorm: string
	/** The raw string actually sent to Enchor. */
	queryValue: string
}

export interface NormalizedTitle {
	/** The `norm2` form of the title with trailing parenthetical/bracket/dash segments stripped. */
	base: string
	/** Stripped suffix segments classified as cosmetic (same recording). */
	cosmetic: string[]
	/** Stripped suffix segments classified as recording variants (musically different). */
	variants: string[]
}

const FEAT_PAREN_PATTERN = /[([](?:featuring|feat\.?|ft\.?)\s[^)\]]*[)\]]/gi
const FEAT_TRAILING_PATTERN = /\s+(?:featuring|feat\.?|ft\.?)\s.*$/i

const ARTIST_DENYLIST = new Set(['various artists', 'unknown artist', 'va', '[unknown]'])

const VARIANT_KEYWORD_PATTERN = /\b(?:remix|live|demo|acoustic|instrumental|cover)\b/

const COSMETIC_SEGMENT_PATTERN = new RegExp(
	'^(?:' + [
		'(?:\\d{4}\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?(?:\\s+version)?',
		'(?:single|album|radio)\\s+(?:version|edit|mix)',
		'mono',
		'stereo',
		'deluxe(?:\\s+(?:edition|version))?',
		'bonus\\s+track',
		'\\d{4}',
	].join('|') + ')$'
)

/** Chart-side-only noise: charter tags that appear inside Enchor `name` values. */
const CHART_NOISE = '(?:2x\\s*bass|co\\s*-?\\s*op|rb3\\s*port)'
const CHART_NOISE_BRACKETED_PATTERN = new RegExp(`[([]\\s*${CHART_NOISE}\\s*[)\\]]`, 'gi')
const CHART_NOISE_TRAILING_PATTERN = new RegExp(`\\s+-\\s*${CHART_NOISE}\\s*$`, 'i')

/**
 * Tier-1 normalization: Unicode NFKC, lowercase, trim, collapse whitespace,
 * straighten curly quotes and unicode dashes.
 */
export function norm1(text: string): string {
	return text
		.normalize('NFKC')
		.replace(/[‘’‚‛′]/g, '\'')
		.replace(/[“”„‟″]/g, '"')
		.replace(/[‐-―−]/g, '-')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Removes `feat.` / `ft.` / `featuring` clauses (parenthesized anywhere, or bare trailing).
 */
export function stripFeat(text: string): string {
	return text
		.replace(FEAT_PAREN_PATTERN, ' ')
		.replace(FEAT_TRAILING_PATTERN, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Tier-2 normalization: `norm1` + NFKD-strip diacritics, strip feat clauses,
 * `&` → `and`, remove remaining punctuation.
 */
export function norm2(text: string): string {
	return stripFeat(norm1(text))
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Sørensen–Dice coefficient over character bigram multisets.
 */
export function diceCoefficient(a: string, b: string): number {
	if (a === b) return 1
	if (a.length < 2 || b.length < 2) return 0
	const bigrams = new Map<string, number>()
	for (let i = 0; i < a.length - 1; i++) {
		const bigram = a.substring(i, i + 2)
		bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1)
	}
	let intersection = 0
	for (let i = 0; i < b.length - 1; i++) {
		const bigram = b.substring(i, i + 2)
		const count = bigrams.get(bigram) ?? 0
		if (count > 0) {
			bigrams.set(bigram, count - 1)
			intersection++
		}
	}
	return (2 * intersection) / (a.length - 1 + b.length - 1)
}

/**
 * The `norm1` bucket key for a track's artist (feat clauses stripped).
 */
export function normalizeArtistKey(artist: string): string {
	return norm1(stripFeat(artist))
}

/**
 * Artist preprocessing: strips feat clauses, splits compound artists on
 * ` & ` / `, ` / ` x ` / ` + ` into component bucket queries (the full compound
 * string is also kept as the first bucket), and filters the denylist.
 */
export function preprocessArtist(artist: string): ArtistQuery[] {
	const results: ArtistQuery[] = []
	const seen = new Set<string>()
	const add = (value: string) => {
		const queryValue = value.replace(/\s+/g, ' ').trim()
		const artistNorm = norm1(queryValue)
		if (!queryValue || !artistNorm || seen.has(artistNorm) || ARTIST_DENYLIST.has(artistNorm)) return
		seen.add(artistNorm)
		results.push({ artistNorm, queryValue })
	}

	const full = stripFeat(artist)
	add(full)
	const components = full.split(/\s+&\s+|,\s+|\s+x\s+|\s+\+\s+/i)
	if (components.length > 1) {
		for (const component of components) {
			add(component)
		}
	}
	return results
}

/**
 * The comparison form used for artist verification: `norm2` after stripping
 * a leading `the ` / trailing `, the`.
 */
function artistCompareForm(artist: string): string {
	let text = norm1(stripFeat(artist))
	text = text.replace(/^the\s+/, '').replace(/,\s*the$/, '')
	return norm2(text)
}

function artistTokensEqual(a: string, b: string): boolean {
	if (a === b) return true
	return a.split(' ').sort().join(' ') === b.split(' ').sort().join(' ')
}

/**
 * Composite segments of an artist string: parenthesized/bracketed chunks plus the
 * delimiter-separated parts of the remainder. Returns [] for non-composite strings,
 * so a segment can never be a mere substring of a longer artist name.
 */
function artistSegments(artist: string): string[] {
	const text = norm1(stripFeat(artist))
	const segments: string[] = []
	const parenPattern = /[([]([^()[\]]+)[)\]]/g
	let match: RegExpExecArray | null
	while ((match = parenPattern.exec(text)) !== null) {
		segments.push(match[1])
	}
	const remainder = text.replace(/[([][^()[\]]*[)\]]/g, ' ')
	const parts = remainder.split(/\s*[,/;]\s*/)
	if (segments.length === 0 && parts.length <= 1) return []
	segments.push(...parts)
	return segments
		.map(segment => artistCompareForm(segment))
		.filter(segment => segment !== '' && segment !== 'the')
}

/**
 * Artist verification for non-exact Enchor results: accepts a chart into a bucket when
 * its artist matches the query artist under order-insensitive rules: token-multiset
 * equality, whole-side equality with a composite segment of the other side (catches
 * `Native (Romaji)` tags and `A / B` collab tags), or Sørensen–Dice bigrams >= 0.9.
 * Plain substring containment is deliberately NOT accepted: `Television` must not
 * match `Los Trabajadores De La Television Y La Radio`.
 */
export function verifyArtist(queryArtist: string, chartArtist: string): boolean {
	const a = artistCompareForm(queryArtist)
	const b = artistCompareForm(chartArtist)
	if (!a || !b) return false
	if (artistTokensEqual(a, b)) return true

	for (const segment of artistSegments(chartArtist)) {
		if (artistTokensEqual(segment, a)) return true
	}
	for (const segment of artistSegments(queryArtist)) {
		if (artistTokensEqual(segment, b)) return true
	}

	return diceCoefficient(a, b) >= 0.9
}

/**
 * Strips chart-side-only noise (charter tags like `2x bass`, `co-op`, `rb3 port`)
 * from an Enchor chart name before title comparison.
 */
export function stripChartNoise(name: string): string {
	return name
		.replace(CHART_NOISE_BRACKETED_PATTERN, ' ')
		.replace(CHART_NOISE_TRAILING_PATTERN, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Classifies one stripped suffix segment as cosmetic or recording-variant.
 * Unrecognized segments are conservatively treated as recording variants.
 */
function classifySegment(segment: string, into: NormalizedTitle): void {
	const normalized = norm2(segment)
	if (!normalized) return
	if (VARIANT_KEYWORD_PATTERN.test(normalized)) {
		into.variants.push(normalized)
	} else if (COSMETIC_SEGMENT_PATTERN.test(normalized)) {
		into.cosmetic.push(normalized)
	} else {
		into.variants.push(normalized)
	}
}

/**
 * Computes the `norm2` base of a title with trailing parenthetical/bracket/dash
 * segments stripped and classified (cosmetic vs recording-variant).
 */
export function normalizeTitle(title: string): NormalizedTitle {
	const result: NormalizedTitle = { base: '', cosmetic: [], variants: [] }
	let work = stripFeat(norm1(title))

	let changed = true
	while (changed) {
		changed = false
		let match = work.match(/^(.*\S)\s*\(([^()]*)\)$/) ?? work.match(/^(.*\S)\s*\[([^[\]]*)\]$/)
		if (match) {
			classifySegment(match[2], result)
			work = match[1].trim()
			changed = true
			continue
		}
		match = work.match(/^(.*\S)\s+-\s+([^-]+)$/)
		if (match) {
			classifySegment(match[2], result)
			work = match[1].trim()
			changed = true
		}
	}

	result.base = norm2(work)
	if (!result.base) {
		// The entire title was stripped as suffixes; fall back to the unstripped form
		result.base = norm2(title)
		result.cosmetic = []
		result.variants = []
	}
	return result
}

function variantSetsEqual(a: string[], b: string[]): boolean {
	const aSorted = [...new Set(a)].sort()
	const bSorted = [...new Set(b)].sort()
	return aSorted.length === bSorted.length && aSorted.every((value, i) => value === bSorted[i])
}

/**
 * Matches one last.fm track title against a bucket of Enchor chart titles.
 *
 * Tiers: `norm1` equality ⇒ exact 1.0; `norm2` base equality ⇒ fuzzy 0.95, or
 * variant capped at 0.75 when the recording-variant suffix sets differ; gated
 * Sørensen–Dice ⇒ fuzzy at the Dice score (only charts of the top-scoring title
 * are kept).
 *
 * @returns a map from index in `chartTitles` to the match classification.
 */
export function matchTitles(trackTitle: string, chartTitles: (string | null)[]): Map<number, TitleMatch> {
	const results = new Map<number, TitleMatch>()
	const trackNorm1 = norm1(trackTitle)
	const trackNorm = normalizeTitle(trackTitle)

	const tier3Candidates: { index: number; base: string; score: number; variantMismatch: boolean }[] = []

	chartTitles.forEach((rawTitle, index) => {
		if (rawTitle === null || rawTitle === '') return
		const chartTitle = stripChartNoise(rawTitle)

		// Tier 1: exact
		if (norm1(chartTitle) === trackNorm1) {
			results.set(index, { matchType: 'exact', similarity: 1 })
			return
		}

		// Tier 2: norm2 base equality
		const chartNorm = normalizeTitle(chartTitle)
		if (trackNorm.base && trackNorm.base === chartNorm.base) {
			if (variantSetsEqual(trackNorm.variants, chartNorm.variants)) {
				results.set(index, { matchType: 'fuzzy', similarity: 0.95 })
			} else {
				results.set(index, { matchType: 'variant', similarity: 0.75 })
			}
			return
		}

		// Tier 3: gated Dice fuzzy
		if (!trackNorm.base || !chartNorm.base) return
		const minLength = Math.min(trackNorm.base.length, chartNorm.base.length)
		if (minLength < 5) return
		if (trackNorm.base.split(' ')[0] !== chartNorm.base.split(' ')[0]) return
		const threshold = minLength < 8 ? 0.9 : 0.85
		const score = diceCoefficient(trackNorm.base, chartNorm.base)
		if (score >= threshold) {
			tier3Candidates.push({
				index,
				base: chartNorm.base,
				score,
				variantMismatch: !variantSetsEqual(trackNorm.variants, chartNorm.variants),
			})
		}
	})

	if (tier3Candidates.length > 0) {
		// When multiple distinct titles pass tier 3, keep only charts of the top-scoring title
		const bestScoreByBase = new Map<string, number>()
		for (const candidate of tier3Candidates) {
			bestScoreByBase.set(candidate.base, Math.max(bestScoreByBase.get(candidate.base) ?? 0, candidate.score))
		}
		let topBase = ''
		let topScore = -1
		for (const [base, score] of bestScoreByBase) {
			if (score > topScore) {
				topScore = score
				topBase = base
			}
		}
		for (const candidate of tier3Candidates) {
			if (candidate.base !== topBase) continue
			if (candidate.variantMismatch) {
				results.set(candidate.index, { matchType: 'variant', similarity: Math.min(0.75, candidate.score) })
			} else {
				results.set(candidate.index, { matchType: 'fuzzy', similarity: candidate.score })
			}
		}
	}

	return results
}
