import { describe, expect, it } from 'vitest'

import { diceCoefficient, matchTitles, normalizeArtistKey, preprocessArtist, stripChartNoise, verifyArtist } from './matching.js'

describe('matchTitles', () => {
	it('matches curly-quote differences as exact', () => {
		const result = matchTitles('Don’t Stop', ['Don\'t Stop'])
		expect(result.get(0)).toEqual({ matchType: 'exact', similarity: 1 })
	})

	it('matches cosmetic remaster suffixes as fuzzy 0.95', () => {
		const result = matchTitles('Song (2011 Remaster)', ['Song'])
		expect(result.get(0)).toEqual({ matchType: 'fuzzy', similarity: 0.95 })
	})

	it('caps remix mismatches as variant', () => {
		const result = matchTitles('Song (Skrillex Remix)', ['Song'])
		expect(result.get(0)?.matchType).toBe('variant')
		expect(result.get(0)?.similarity).toBeLessThanOrEqual(0.75)
	})

	it('caps live-version charts of a studio track as variant', () => {
		const result = matchTitles('One', ['One (Live)'])
		expect(result.get(0)?.matchType).toBe('variant')
	})

	it('strips feat clauses at tier 2', () => {
		const result = matchTitles('Song (feat. Someone)', ['Song'])
		expect(result.get(0)?.matchType).toBe('fuzzy')
	})

	it('does not match different songs with singular/plural titles', () => {
		const result = matchTitles('Dream', ['Dreams'])
		expect(result.size).toBe(0)
	})

	it('refuses tier-3 fuzzy matching for very short titles', () => {
		const result = matchTitles('Us', ['Use Somebody'])
		expect(result.size).toBe(0)
	})

	it('still matches short titles exactly', () => {
		const result = matchTitles('Us', ['Us'])
		expect(result.get(0)).toEqual({ matchType: 'exact', similarity: 1 })
	})

	it('requires an identical first token at tier 3', () => {
		const result = matchTitles('Hello World', ['World Hello'])
		expect(result.size).toBe(0)
	})

	it('matches chart-side noise tags like (2x Bass)', () => {
		const result = matchTitles('Song', ['Song (2x Bass)'])
		expect(result.get(0)).toEqual({ matchType: 'exact', similarity: 1 })
	})

	it('matches punctuation-only differences at tier 2 and rejects longer unrelated titles', () => {
		const result = matchTitles('Holidays in the Sun', ['Holidays in the Sun!', 'Holidays in the Sunshine Land'])
		expect(result.get(0)?.matchType).toBe('fuzzy')
		expect(result.has(1)).toBe(false)
	})

	it('ignores null and empty chart titles', () => {
		const result = matchTitles('Song', [null, ''])
		expect(result.size).toBe(0)
	})
})

describe('verifyArtist', () => {
	it('accepts diacritic variants', () => {
		expect(verifyArtist('Beyoncé', 'Beyonce')).toBe(true)
	})

	it('accepts comma-inverted article forms', () => {
		expect(verifyArtist('The Beatles', 'Beatles, The')).toBe(true)
	})

	it('accepts composite tags via parenthesized segments', () => {
		expect(verifyArtist('東京事変', '東京事変 (Tokyo Jihen)')).toBe(true)
	})

	it('accepts slash-delimited collab tags containing the artist', () => {
		expect(verifyArtist('Daft Punk', 'Daft Punk / Pharrell Williams')).toBe(true)
	})

	it('rejects artists whose name merely contains the query tokens', () => {
		expect(verifyArtist('Television', 'Los Trabajadores De La Television Y La Radio')).toBe(false)
		expect(verifyArtist('Television', 'Television Personalities')).toBe(false)
	})

	it('rejects unrelated artists', () => {
		expect(verifyArtist('Stereolab', 'Dragonforce')).toBe(false)
	})

	it('accepts ampersand versus and spellings', () => {
		expect(verifyArtist('Simon & Garfunkel', 'Simon and Garfunkel')).toBe(true)
	})
})

describe('preprocessArtist', () => {
	it('strips feat clauses from artist strings', () => {
		const result = preprocessArtist('A feat. B')
		expect(result.map(a => a.queryValue)).toEqual(['A'])
	})

	it('splits compound artists while keeping the full string first', () => {
		const result = preprocessArtist('Kendrick Lamar & SZA')
		expect(result.map(a => a.queryValue)).toEqual(['Kendrick Lamar & SZA', 'Kendrick Lamar', 'SZA'])
	})

	it('skips denylisted artists without queries', () => {
		expect(preprocessArtist('Various Artists')).toEqual([])
	})
})

describe('helpers', () => {
	it('normalizeArtistKey produces the norm1 form without feat clauses', () => {
		expect(normalizeArtistKey('Artist feat. Other')).toBe('artist')
	})

	it('stripChartNoise removes trailing charter tags', () => {
		expect(stripChartNoise('Song - 2x Bass')).toBe('Song')
	})

	it('diceCoefficient is 1 for identical strings and 0 for single characters', () => {
		expect(diceCoefficient('abc', 'abc')).toBe(1)
		expect(diceCoefficient('a', 'b')).toBe(0)
	})
})
