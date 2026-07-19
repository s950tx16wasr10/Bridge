/**
 * Pure `song.ini` text ⇄ .sng metadata map conversion.
 *
 * `unfoldSongIni` matches parse-sng's `generateIniFileText` output byte-for-byte
 * (same key ordering, same default-value dropping), so a fold/unfold round trip
 * through a packed archive is lossless for everything parse-sng can represent.
 * The documented lossiness (docs/sng-write-support-design.md §0): keys whose values
 * equal parse-sng's built-in defaults are dropped, empty values are dropped, keys
 * are reordered, and comments/non-`[song]` sections are not representable.
 */

/** Only newlines are stripped from values at pack time (see SngPacker.sanitizeSngMetadata). */

/**
 * Parses `song.ini` text into a .sng metadata map.
 *
 * Only the case-insensitive `[song]` section is read. Strips a leading BOM,
 * tolerates CRLF line endings, and ignores comment lines and other sections.
 */
export function foldSongIni(iniText: string): Map<string, string> {
	const metadata = new Map<string, string>()

	let text = iniText
	if (text.charCodeAt(0) === 0xFEFF) {
		text = text.slice(1)
	}

	let inSongSection = false
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (line.length === 0 || line.startsWith(';') || line.startsWith('#') || line.startsWith('//')) continue

		const sectionMatch = /^\[(.*)\]$/.exec(line)
		if (sectionMatch) {
			inSongSection = sectionMatch[1].trim().toLowerCase() === 'song'
			continue
		}
		if (!inSongSection) continue

		const equalsIndex = line.indexOf('=')
		if (equalsIndex === -1) continue

		const key = line.slice(0, equalsIndex).trim()
		const value = line.slice(equalsIndex + 1).trim()
		if (key.length === 0) continue
		metadata.set(key, value)
	}

	return metadata
}

/**
 * Generates `song.ini` text from a .sng metadata map, matching parse-sng's
 * `generateIniFileText` format exactly: `'[song]\n'` + `'key = value\n'` per pair,
 * known keys first (in parse-sng's order, dropping values equal to the reader
 * defaults below), then unknown keys in map order.
 */
export function unfoldSongIni(metadata: Map<string, string>): string {
	let iniText = '[song]\n'
	for (const key of DEFAULT_KEYS) {
		const value = metadata.get(key)
		if (value && value !== DEFAULT_METADATA[key]) {
			iniText += `${key} = ${value}\n`
		}
	}
	for (const [key, value] of metadata) {
		if (DEFAULT_KEYS.includes(key)) continue
		iniText += `${key} = ${value}\n`
	}
	return iniText
}

/** parse-sng's built-in metadata defaults (parse-sng/index.ts:354-390); values equal to these are dropped by `unfoldSongIni`. */
const DEFAULT_METADATA: { [key: string]: string } = {
	'name': 'Unknown Name',
	'artist': 'Unknown Artist',
	'album': 'Unknown Album',
	'genre': 'Unknown Genre',
	'year': 'Unknown Year',
	'charter': 'Unknown Charter',
	'song_length': '0',
	'diff_band': '-1',
	'diff_guitar': '-1',
	'diff_guitar_coop': '-1',
	'diff_rhythm': '-1',
	'diff_bass': '-1',
	'diff_drums': '-1',
	'diff_drums_real': '-1',
	'diff_keys': '-1',
	'diff_guitarghl': '-1',
	'diff_guitar_coop_ghl': '-1',
	'diff_rhythm_ghl': '-1',
	'diff_bassghl': '-1',
	'diff_vocals': '-1',
	'preview_start_time': '-1',
	'icon': '',
	'loading_phrase': '',
	'album_track': '16000',
	'playlist_track': '16000',
	'playlist': '',
	'modchart': 'False',
	'delay': '0',
	'hopo_frequency': '0',
	'eighthnote_hopo': 'False',
	'multiplier_note': '0',
	'video_start_time': '0',
	'five_lane_drums': 'False',
	'pro_drums': 'False',
	'end_events': 'True',
}
const DEFAULT_KEYS = Object.keys(DEFAULT_METADATA)
