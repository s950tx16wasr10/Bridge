# Discover: last.fm → Enchor recommendations for Bridge

**Status:** Design v2 — reviewed (fact-checked against the codebase; adversarial design
review applied). Not yet implemented.
**Goal:** A new "Discover" tab in Bridge that uses your last.fm listening history
to surface charts on enchor.us that you actually want to play:
your most-played and loved songs that have charts, ranked by how much you listen to them,
with already-owned charts flagged and one-click download for the rest.

---

## 1. Feature vs. plugin — decision

**Decision: built-in feature module on this fork, not a plugin.**

Bridge has **no plugin or extension system** (verified: every "plugin" hit in the repo is
build tooling — tailwind/daisyui/postcss/eslint). Modules are compile-time wired through
`src-shared/interfaces/ipc.interface.ts` → `src-electron/IpcHandler.ts` → `src-electron/preload.ts`.
Inventing a plugin loader would cost far more than the feature itself and fight the app's
fully-typed IPC design.

Instead, the feature is built as a **self-contained module** following the exact pattern of
the existing `lyrics` module (`src-electron/ipc/lyrics/` + `src-angular/app/core/services/lyrics.service.ts`):
its own folder in `src-electron/ipc/lastfm/`, its own SQLite database file, its own Angular
service and route component. Touches to shared files are limited to registration points,
so rebasing onto upstream Bridge stays cheap.

## 2. How it works — one paragraph

You paste your last.fm username and a (free) last.fm API key into Settings. The Discover tab
has a **Sync** button: the Electron main process fetches your top tracks (selectable period)
plus your loved tracks from last.fm, batches them **by artist**, runs one Enchor search per
unique artist, caches slim results in a local SQLite database, then matches your tracks
against the cached charts locally (exact / fuzzy / different-version tiers). The tab shows a
ranked table: track, playcount / loved badge, match quality, charts, in-library badge, and a
Download button that feeds Bridge's existing download queue. Re-syncs are fast because
artist results are cached with a TTL.

## 3. Core strategy: artist-batched fetch, local matching

The naive approach — one Enchor search per track — fails on rate limits (measured:
`X-Ratelimit-Limit: 50` per short window, ~10 units per search) and re-downloads popular
artists' data repeatedly (each result embeds ~100 KB of `notesData`). Your top 500 tracks
collapse to roughly 150–300 unique artists, so the unit of network work is the **artist**;
title matching then happens locally, for free. This also enables the artist-level fallback
display ("no chart for this song, but the artist has N charts") — important because
indie/art-pop coverage on Enchor is sparser than rock/metal.

Per artist, after preprocessing (§7.1):

1. **Primary query — non-exact:** `POST /search/advanced` with
   `artist: { value, exact: false, exclude: false }`, `per_page: 250`, page 1.
   Non-exact is primary because *exact* search silently returns partial coverage — e.g.
   exact `The Beatles` misses charts tagged `Beatles, The` or `Beatles`, and nothing in the
   response signals the gap. Non-exact over-fetches instead, and the **local artist
   verification** step (§7.2) filters the noise. Over-fetching is detectable; under-fetching
   is not.
2. **If `found ≤ 1000`:** fetch remaining pages (≤ 4 total), keep charts passing artist
   verification, discard `notesData` immediately, write the artist bucket (§6).
3. **If `found > 1000`** (common-word artist names — "Low", "Girls", "Health" — or
   mega-charted artists): discard, run one **exact** artist query instead (paginate ≤ 4
   pages, verification still applied). Then, for this artist's tracks that remain matchless
   after the match phase, issue **per-track** queries (`name` non-exact + the artist's most
   distinctive token, 1 page each) — but only when that costs fewer requests than the
   pagination it replaces (`trackCount < ceil(found/250)` guard is inverted here: per-track
   only for ≤ 10 matchless tracks). The cache row records which `nameNorm`s were queried
   this way, so tracks added by a later sync are cache *misses*, not silently unmatched
   (§6, `queriedTracks`).
4. **Short-circuit:** if page 1 of the primary query yields zero verification-passing
   charts, record status `empty` without fetching further pages.

## 4. Architecture

```
┌─ Renderer (Angular) ──────────────────────────────────────────────┐
│ DiscoverComponent (route /discover, toolbar tab after Library)    │
│   └─ LastfmService (signals: syncProgress, matches, filters)      │
│        invoke.lastfmValidateUser / lastfmGetMatches /             │
│        invoke.lastfmGetSyncState                                  │
│        emit.lastfmSync {action:'start'|'cancel', options}         │
│        on.lastfmSyncProgress (throttled re-query)                 │
│ SettingsComponent — username + API key fields, Test connection    │
└──────────────────────────────┬────────────────────────────────────┘
                               │ typed IPC (ipc.interface.ts)
┌─ Main process (Electron) ────▼────────────────────────────────────┐
│ LastfmHandler.ipc.ts  — thin channel functions + progress forward │
│ LastfmService.ts      — singleton sync orchestrator (EventEmitter)│
│   ├─ LastfmApi.ts     — ws.audioscrobbler.com client (Bottleneck) │
│   ├─ EnchorClient.ts  — api.enchor.us client (header-aware pace)  │
│   ├─ matching.ts      — pure normalization + match classifier     │
│   └─ LastfmDatabase.ts— better-sqlite3 @ dataPath/lastfm.db       │
│ CatalogDatabase.checkSongsExist(pairs)  ← small new method,       │
│   called main-process-only from lastfmGetMatches (no IPC channel) │
└───────────────────────────────────────────────────────────────────┘
```

**Why the sync runs in the main process** (not the renderer like `SearchService`):
it's a long-running batch job (first sync: minutes) that must survive tab switches and
renderer reloads, needs polite rate limiting with a custom `User-Agent` (renderer fetch
can't always set one), writes to SQLite, and joins against `catalog.db`. This mirrors how
`LyricsService` does LRCLIB HTTP calls and how downloads run in `DownloadQueue` with
progress events streamed back.

## 5. External API contracts (verified live 2026-07-16)

### last.fm (`https://ws.audioscrobbler.com/2.0/`, always `format=json`)

- **No user authentication needed** — public-profile data with just `api_key`.
  Methods used: `user.getInfo` (validation), `user.getTopTracks` (params: `user`, `period`
  ∈ `overall|7day|1month|3month|6month|12month`, `limit`, `page`), `user.getLovedTracks`.
- API key: free + instant at `https://www.last.fm/api/account/create` (requires last.fm login).
  Stored in Bridge's `settings.json` like other local config; never committed to the repo.
  We do **not** ship a shared key (public-repo keys get abused → suspended for everyone).
- **Quirks that must be handled:**
  - Every number is a JSON **string** (`"playcount": "42"`) — parse explicitly.
  - A single-item list may arrive as an **object, not a 1-element array**.
  - Errors come as `{ error: number, message: string }` (often with HTTP 4xx): `6` bad
    params/unknown user, `10` bad key, `17` private data, `29` rate limited, `8/11/16`
    transient (retry ≤ 3 with backoff).
  - `getLovedTracks` has **no playcount** — it has `date.uts` (when loved).
  - No documented max `limit` for top-tracks — paginate via `@attr.totalPages`,
    request `limit=200` per page, cap total via the track-limit option (default 500).
- Politeness: ≤ 1 req/s (Bottleneck), identifiable `User-Agent`. ToS requires attribution —
  the tab footer shows "Powered by Last.fm" linking to the user's profile.

### Enchor (`https://api.enchor.us`) — same API Bridge already uses

- `POST /search/advanced` — text filters `{ value, exact, exclude }` for
  name/artist/album/genre/year/charter; **exact is case-insensitive** (verified:
  `DragonForce` matched `Dragonforce`). Include all six text-filter objects with
  `value: ''` when unused (the schema Bridge uses requires them). `per_page` ≤ 250,
  `page` 1-based, response `{ found, data: ChartData[] }`. **Success status is HTTP 201** —
  accept any 2xx.
- **Rate limiting — the budget is shared and contested.** Headers: `X-Ratelimit-Limit: 50`,
  `X-Ratelimit-Remaining`, `X-Ratelimit-Reset` (unix seconds). Two live samples showed
  ~10 units per search, but the client must **not** assume constant cost: it derives
  per-request cost from consecutive `Remaining` deltas and pauses until `Reset` (+ 0.5–1.5s
  jitter) when `Remaining < max(observedCost × 1.5, 15)`. Baseline ≥ 2s gap between
  requests. Crucially, the renderer's Browse tab hits the same limit from the same IP —
  and `search-bar.component.ts` fires a search **per keystroke with no debounce** (the
  comment at `onSearchInput` claims one; it isn't implemented). So:
  - **Explicit 429 branch:** sleep until `X-Ratelimit-Reset` + jitter and re-issue; a 429
    does **not** count against the retry budget and does **not** mark the artist `error`.
  - Missing or negative rate headers (CDN error pages): treat as exhausted — fall back to
    baseline pacing and re-probe.
  - Recommended prerequisite (small upstream-file fix): add a ~300 ms debounce to the
    Browse search input, implementing its existing comment.
- HTTP 400 = schema bug on our side — never retried (mirrors `SearchService`'s rule).
  Other failures retry ≤ 3 with ≥ 2s delay.
- Send `source: 'bridge'` and a distinct `User-Agent` so the Enchor operator can identify
  the traffic.

## 6. Local database — `dataPath/lastfm.db` (better-sqlite3)

Own file, not `catalog.db`, so the scanner's orphan-deletion and upstream schema changes
can never collide with it. Opened with `journal_mode = WAL` **and `PRAGMA foreign_keys = ON`**
(better-sqlite3 defaults FKs off; without the pragma the cascade below silently no-ops).

```sql
lastfm_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- 'top_overall' | 'top_7day' | ... | 'loved'
  artist TEXT NOT NULL, name TEXT NOT NULL,
  artistNorm TEXT NOT NULL, nameNorm TEXT NOT NULL,   -- norm1 forms (§7)
  playcount INTEGER,                 -- null for loved
  rank INTEGER, lovedAt INTEGER,     -- lovedAt = date.uts, null for top
  fetchedAt TEXT NOT NULL,
  UNIQUE(source, artistNorm, nameNorm)
);

enchor_artist_cache (
  artistNorm TEXT PRIMARY KEY,       -- normalized *query* artist (last.fm side)
  queryValue TEXT NOT NULL,          -- raw string actually sent to Enchor
  strategy TEXT NOT NULL,            -- 'nonexact' | 'exact' | 'pertrack'
  chartCount INTEGER NOT NULL,
  queriedTracks TEXT NOT NULL DEFAULT '',  -- csv of nameNorms queried per-track (overflow path)
  status TEXT NOT NULL,              -- 'ok' | 'empty' | 'overflow' | 'error'
  fetchedAt TEXT NOT NULL            -- TTL 14 days; status='error' rows are ALWAYS stale
);

enchor_charts (                      -- pure chart identity, slim ChartData subset
  chartId INTEGER PRIMARY KEY,
  artist TEXT, name TEXT, nameNorm TEXT NOT NULL,
  charter TEXT, md5 TEXT NOT NULL, albumArtMd5 TEXT,
  hasVideoBackground INTEGER NOT NULL DEFAULT 0,
  songId INTEGER, groupId INTEGER,
  songLength INTEGER,                -- from ChartData.song_length
  instruments TEXT NOT NULL DEFAULT '',   -- notesData.instruments.join(',')
  diffGuitar INTEGER, diffBass INTEGER, diffDrums INTEGER,
  diffKeys INTEGER, diffVocals INTEGER,   -- from snake_case diff_* fields
  album TEXT, genre TEXT, year TEXT,
  modifiedTime TEXT
);

artist_charts (                      -- junction: bucket membership
  artistNorm TEXT NOT NULL,          -- the *query* artistNorm (matches lastfm_tracks)
  chartId INTEGER NOT NULL REFERENCES enchor_charts(chartId) ON DELETE CASCADE,
  PRIMARY KEY (artistNorm, chartId)
);

matches (                            -- rebuilt wholesale by every match phase (§9)
  trackId INTEGER NOT NULL REFERENCES lastfm_tracks(id) ON DELETE CASCADE,
  chartId INTEGER NOT NULL REFERENCES enchor_charts(chartId) ON DELETE CASCADE,
  matchType TEXT NOT NULL,           -- 'exact' | 'fuzzy' | 'variant'
  similarity REAL NOT NULL,
  PRIMARY KEY (trackId, chartId)
);
```

Design notes locked in by review:

- **Junction table, not an `artistNorm` column on charts.** A chart can belong to several
  user-artist buckets (collabs, "Bruno Mars" + "Silk Sonic", charts reached from two
  spelling variants). A single column made the second upsert overwrite the first artist's
  membership — silently corrupting buckets depending on processing order. The junction is
  keyed by the *query* artistNorm so bucket lookups from `lastfm_tracks.artistNorm` always
  hit, regardless of how the chart's own artist string is spelled.
- **Artist re-fetch is authoritative for its bucket.** Inside the per-artist transaction:
  delete `artist_charts` rows for this artistNorm absent from the fresh result, then
  garbage-collect `enchor_charts` rows with no remaining memberships. Otherwise takedowns
  on Enchor leave zombie rows whose Download 404s at `files.enchor.us` forever.
- The slim chart columns are exactly what the UI and download path need:
  `DownloadService.addDownload` reads only `md5`, `hasVideoBackground`, and
  name/artist/album/genre/year/charter (verified at `download.service.ts:69-94`;
  the main-process `ChartDownload` needs nothing else from the payload).
- **"In library"** is computed at query time inside `lastfmGetMatches` (never cached): a new
  `CatalogDatabase.checkSongsExist(pairs: Array<{ artist: string; name: string }>): Map<string, boolean>`,
  a mechanical copy of the existing `checkChartsExist` temp-table join
  (`CatalogDatabase.ts:453-509`) minus the charter column, keyed
  `${artist.toLowerCase().trim()}|${name.toLowerCase().trim()}`. Main-process-only —
  **no new catalog IPC channel** (nothing in the renderer would call it).

## 7. Matching algorithm (`matching.ts` — pure functions, unit-testable)

### 7.1 Artist preprocessing (before bucketing and querying)

- Strip `feat.` / `ft.` / `featuring` clauses from artist strings (last.fm often reports
  "Artist feat. Other" while charts tag the primary artist).
- Split compound artists on ` & `, `, `, ` x `, ` + ` into components; each component
  becomes its own bucket query, verified by token-subset containment (§7.2). The full
  compound string is also kept as one bucket (some charts tag the compound).
- Denylist skipped without spending requests: `various artists`, `unknown artist`, `va`,
  `[unknown]`.

### 7.2 Artist verification (filtering non-exact results)

A returned chart is accepted into the bucket when its artist and the query artist compare
equal under **order-insensitive** rules on `norm2` (below), after stripping a leading
`the ` / trailing `, the`:

1. sorted-token-multiset equality (`beatles the` == `the beatles`), or
2. one whole side equals a **composite segment** of the other — segments are
   parenthesized/bracketed chunks plus `,`/`/`/`;`-delimited parts (catches
   "Native (Romaji)" tags and "A / B" collab tags), or
3. Sørensen–Dice bigrams ≥ 0.9 (typo/diacritic residue).

Plain `norm1`/`norm2` equality would reject exactly the variants ("Beatles, The",
"Beyoncé"/"Beyonce") the non-exact query exists to catch — this was a review blocker.
Blanket token-set containment is deliberately NOT used (a v1.0 field bug: it accepted
"Los Trabajadores De La Television Y La Radio" into the "Television" bucket).

### 7.3 Title normalization — two tiers, three match classes

- **norm1**: Unicode NFKC, lowercase, trim, collapse whitespace, straighten curly
  quotes/dashes. Equality ⇒ **exact**, similarity 1.0.
- **norm2**: norm1 + NFKD-strip diacritics, strip `feat./ft.` clauses, `&` → `and`, remove
  remaining punctuation, and strip trailing parenthetical/bracket/dash segments — but the
  stripped suffixes are **classified, not discarded**:
  - **Cosmetic** (same recording, safe): `remaster(ed)`, `single/album/radio version|edit|mix`,
    `mono|stereo`, `deluxe`, `bonus track`, a bare year. norm2 equality with only cosmetic
    suffix differences ⇒ **fuzzy**, similarity 0.95.
  - **Recording-variant** (musically different, different note chart!): `remix`, `live`,
    `demo`, `acoustic`, `instrumental`, `cover`. If the two sides' variant sets differ
    (e.g. last.fm "Song (Skrillex Remix)" vs chart "Song"), similarity is capped at 0.75
    and matchType is **`variant`** — the UI badges it "different version" (amber) so
    one-click Download never silently fetches a chart for a recording you don't listen to.
  - Chart-side-only noise stripped before comparing: charter tags like `2x bass`, `co-op`,
    `rb3 port` that appear inside Enchor `name` values.
- **Tier 3 — Dice fuzzy**, gated (review: bare 0.85 admits `dream`/`dreams`,
  `angel`/`angels` — *different songs*): requires `norm2.length ≥ 5`; threshold 0.85, raised
  to 0.9 when `norm2.length < 8`; and the first token must be identical. Shorter titles must
  match at tier 1/2. When multiple distinct `nameNorm`s pass tier 3 for one track, only
  charts of the top-scoring `nameNorm` are kept (all charts of that title are kept —
  they're versions of the same song).

Charts are matched against Enchor's canonical `name` field; when `name` fails entirely,
fall through once to `chartName` (charters sometimes put the real title there).

### 7.4 Known v1 limitation — CJK / cross-script artists

last.fm tags 東京事変 in native script; chart sites usually use romaji. No normalization
bridges scripts, so these artists come back `empty`. Mitigations: the containment rule in
§7.2 catches "Native (Romaji)" composite tags, and the UI distinguishes **"artist not found
on Enchor"** from **"artist found, song not charted"** so script-mismatch failures are at
least diagnosable, not silent. A romanization pass is future work (§14).

## 8. IPC contract and DTOs (`src-shared/interfaces/lastfm.interface.ts`)

```
IpcInvokeEvents:
  lastfmValidateUser: { input: { username: string; apiKey: string }, output: LastfmValidateResult }
  lastfmGetMatches:   { input: MatchQuery,  output: MatchResult }
  lastfmGetSyncState: { input: void,        output: LastfmSyncProgress | null }
IpcToMainEmitEvents:
  lastfmSync: { action: 'start'; options: SyncOptions } | { action: 'cancel' }
IpcFromMainEmitEvents:
  lastfmSyncProgress: LastfmSyncProgress
```

```ts
type LastfmSource = 'top_overall' | 'top_12month' | 'top_6month' | 'top_3month'
  | 'top_1month' | 'top_7day' | 'loved'

type LastfmValidateResult =
  | { ok: true; username: string; playcount: number; url: string; registeredAt: number }
  | { ok: false; code: 'badKey' | 'unknownUser' | 'private' | 'rateLimited' | 'network'; message: string }

interface SyncOptions { source: LastfmSource; trackLimit: number }   // loved is ALWAYS also synced (§9)

interface LastfmSyncProgress {
  phase: 'lastfm' | 'plan' | 'enchor' | 'match' | 'done' | 'error'
  current: number; total: number
  message: string                       // e.g. 'Enchor: artist 37/181 — Stereolab'
  summary?: { trackCount: number; matchedCount: number; artistCount: number; elapsedMs: number }
  error?: string
}

interface MatchQuery {
  source: LastfmSource
  instrument: Instrument | null         // src-shared/UtilFunctions.ts Instrument
  hideOwned: boolean; hideUnmatched: boolean
  minPlaycount: number | null; text: string
  sort: { column: 'track' | 'artist' | 'plays' | 'match' | 'charts' | 'inLibrary'; direction: 'asc' | 'desc' } | null
}

interface SlimChart {                   // mirrors enchor_charts columns
  chartId: number; artist: string | null; name: string | null; charter: string | null
  md5: string; albumArtMd5: string | null; hasVideoBackground: boolean
  songId: number | null; groupId: number | null; songLength: number | null
  instruments: string[]; diffGuitar: number | null; diffBass: number | null
  diffDrums: number | null; diffKeys: number | null; diffVocals: number | null
  album: string | null; genre: string | null; year: string | null; modifiedTime: string | null
  matchType: 'exact' | 'fuzzy' | 'variant'; similarity: number
}

interface MatchRow {
  trackId: number; artist: string; name: string
  playcount: number | null; rank: number | null; lovedAt: number | null; isLoved: boolean
  matchType: 'exact' | 'fuzzy' | 'variant' | null   // null = unmatched track
  inLibrary: boolean
  artistChartCount: number              // 0 + artistStatus distinguishes the two no-match cases
  artistStatus: 'ok' | 'empty' | 'overflow' | 'error' | 'pending'
  charts: SlimChart[]                   // grouped/sorted; empty for unmatched
}

interface MatchResult { rows: MatchRow[]; totalTracks: number; matchedTracks: number; lastSyncAt: string | null }
```

**No pagination in v1** — `lastfmGetMatches` returns all filtered rows in one call
(≤ trackLimit ≤ 500 slim rows, comfortably within IPC size), which is also what keeps the
re-query-on-progress-tick model trivial (full replace of one signal).

`isLoved` for top-source rows is
`EXISTS (SELECT 1 FROM lastfm_tracks l2 WHERE l2.source='loved' AND l2.artistNorm=t.artistNorm AND l2.nameNorm=t.nameNorm)`.

## 9. Sync pipeline (main process, singleton)

```
start(options)  — REJECTED with progress error if a sync is already running
                  (UI: Sync button disabled while phase ∉ {done, error, null})
 0. snapshot username/apiKey from settings into the run (mid-run settings edits
    can't produce hybrid data; a username change cancels the run first, then clears
    lastfm_tracks/matches after the orchestrator confirms it stopped)
 1. validate settings nonempty, else progress:error
 2. lastfm fetch  — getInfo; top tracks for options.source (200/page, ≤1 req/s);
                    loved tracks ALWAYS refreshed too (1-2 requests for 171 loved —
                    otherwise the ♥ marker silently never works for top-only users);
                    upsert lastfm_tracks per source, delete stale rows per source
                    (explicit deletes in the same transaction — not FK cascades)
 3. plan          — unique preprocessed artistNorms across ALL current lastfm_tracks,
                    minus fresh cache entries (TTL 14 days; status='error' rows and
                    overflow rows with unqueried tracks are always treated as stale)
 4. enchor fetch  — per artist: strategy of §3, header-aware pacing (§5), explicit
                    429-sleep branch; per-artist transaction writes enchor_charts +
                    authoritative artist_charts + cache row; progress tick per artist;
                    individual artist errors → status='error', run continues
 5. match         — ALWAYS runs, over EVERY artist bucket referenced by the current
                    track set — not just artists fetched this run. Purely local and
                    cheap (≤500 tracks × avg bucket). Truncate-and-rebuild the whole
                    matches table in one transaction. It ALSO runs incrementally every
                    8 fetched artists during step 4, so matches appear in the table
                    while a long first sync is still running (field feedback: a
                    match-only-at-the-end sync looks broken for its whole duration). This decoupling is what makes
                    quit-mid-run, cancel, and new-tracks-for-cached-artists all
                    self-heal on the next sync instead of stranding matchless artists
                    until TTL expiry. It also keeps every source consistent (matches
                    are per-track across all sources, recomputed together).
 6. progress: done with summary
cancel — sets a flag checked between requests AND stops/recreates the Bottleneck
         limiter (the full ChartScanner.cancelScan pattern, ChartScanner.ts:191-198,
         so queued-but-unstarted jobs are dropped too)
```

First-sync duration, top 500 overall + loved: ~180–300 Enchor requests. At the *observed*
budget that's **roughly 10–30 minutes in the background — an unvalidated estimate** until a
full-scale sync has run (the unit cost was sampled twice; the client adapts dynamically,
§5). Re-syncs touch only new/expired artists: typically seconds. Switching period reuses
the same artist cache, so trying "3month" after "overall" is nearly free.

## 10. UI

### Settings page — new "Last.fm" section

Username + API key text inputs (existing FormControl-per-setting pattern), plus a
**Test connection** button → `invoke.lastfmValidateUser` → shows
"✓ username — 154,133 scrobbles" or the specific mapped error (bad key / unknown user /
private / network).

New `Settings` fields: `lastfmUsername: string`, `lastfmApiKey: string` (defaults `''`).
All four standard touch points (interface+default, service get/set pair, component
FormControl, template row).

### Discover tab

Route `/discover` with `data: { shouldReuse: true }`; toolbar button **immediately after
Library (before Video)**; `@HostBinding('class.contents')`; daisyUI table conventions
(`table table-zebra table-pin-rows`), Bootstrap Icons.

**States** (three — there is deliberately no "no library folders" state: sync, table, and
Open in Browse all work without a library; In-library pills are simply absent; only
Download is guarded, with Discover's own copy of the chart-sidebar's library-directory
error `<dialog>`):

1. **Not configured** — hero card explaining the feature, link-buttons to Settings and
   last.fm's API-key page.
2. **Syncing** — daisyUI progress bar fed by the progress signal, Cancel button. Matches
   appear incrementally; the Angular service **throttles re-queries** (trailing-edge, ≥ 2s,
   plus one final on `done`) — an unthrottled per-tick re-query floods synchronous
   better-sqlite3 queries on the very event loop running the sync (worst on re-syncs where
   cached artists tick hundreds of times in seconds). Default sort is `rank asc`, which is
   stable across ticks, so rows don't reshuffle under the cursor; new rows insert in place.
3. **Results table** — **one row per track** (matched or not):

   | Column | Content |
   |---|---|
   | Track / Artist | last.fm strings; album art `https://files.enchor.us/{albumArtMd5}.jpg` (same pattern as chart-sidebar), skeleton placeholder when null |
   | Plays | `playcount`, or ♥ + loved date for the loved source; ♥ marker on top rows via `isLoved` |
   | Match | exact (green) / fuzzy (blue, tooltip shows the Enchor title) / **variant (amber, "different version")** / — |
   | Charts | count; chevron expands **inline colspan child rows**, one per chart: charter, chartName override if present, instrument+difficulty badges, modifiedTime, match badge, per-chart Download. Multiple rows expandable at once; expansion keyed by trackId in the component so it survives re-queries; not persisted. Unmatched rows show `0 — artist has N charts` (artistStatus `ok`/`overflow`) or `artist not on Enchor` (`empty`/`error`) |
   | In library | green pill (browse-row styling); optimistic **"Downloaded"** marker when the chart's md5 reaches type `done` in `DownloadService.downloads` (a fresh download isn't in catalog.db until the next scan — without this the pill's absence reads as a bug) |
   | Actions | **Download** best chart; **Open in Browse** |

**Best chart** for the row-level Download: highest matchType (exact > fuzzy > variant),
then similarity, tie-break most-recent `modifiedTime` (mirrors the chart-sidebar's version
ordering). If the instrument filter is active, only charts passing it are eligible.
Download goes through `DownloadService.addDownload` — its parameter is narrowed to
`Pick<ChartData, 'md5' | 'hasVideoBackground' | 'name' | 'artist' | 'album' | 'genre' | 'year' | 'charter'>`
(a one-line, behavior-neutral change; it already reads only those fields). Dedup-by-md5 and
the optimistic queue entry come free.

**Open in Browse**: a `buildBrowseSearch(artist, name?)` helper returns a *complete*
`AdvancedSearch` (all six text filters with `value: ''`/`exclude: false` when unused;
instrument/difficulty/drumType/drumsReviewed from the SearchService signals; min/max,
booleans, sort null; `source: 'bridge'`). Matched rows use the **Enchor chart's canonical
name** (not the last.fm title) with `exact: true` so it hits; unmatched rows send
artist-only. Call `searchService.advancedSearch(built).subscribe()` (it returns a cold
Observable — without subscribe no request fires), then `router.navigateByUrl('/browse')`.
Caveat, accepted for v1: this replaces the user's current Browse results and the advanced
form won't reflect the injected criteria.

**Controls** above the table: source selector, track-limit, instrument filter, hide-owned,
hide-unmatched, min-playcount, free-text filter.

- The source selector is a **cache query switch** — instant, no network. If the selected
  source has never been synced: empty state "Not synced yet for this period" + Sync button.
  Sync always syncs the selected source (+ loved); track-limit applies to the next sync
  (noted next to the control).
- The instrument filter matches `enchor_charts.instruments` in SQL
  (`',' || instruments || ',' LIKE '%,<instrument>,%'`); diff columns are display-only.
  A row stays visible if ≥ 1 chart passes; count/expansion/best-chart are restricted to
  passing charts; unmatched rows are hidden while the filter is active. Options are the
  same `Instrument` values Browse offers.
- Filters persist to localStorage under **prefixed keys**: `discover.source`,
  `discover.trackLimit`, `discover.instrument`, `discover.hideOwned`,
  `discover.hideUnmatched`, `discover.minPlaycount`, `discover.textFilter` — read in the
  Angular service constructor with SearchService's null-string handling. **Do not reuse the
  bare browse keys** (`instrument`, `difficulty`, …): SearchService owns those and sharing
  them would silently clobber the Browse filters.

**Sorting** happens in SQL inside `lastfmGetMatches`. Defaults: `rank asc` for top sources,
`lovedAt desc` for loved. Sortable: Track, Artist, Plays, Match (exact > fuzzy > variant >
none, then similarity), Charts (count), In library. Secondary tie-break always `rank asc`.
Header-click UI copies the browse result-table convention.

**Refresh triggers** for `lastfmGetMatches`: (a) Discover route activation, (b) throttled
sync progress ticks, (c) `catalogScanProgress` completion (subscribed once in the Angular
service constructor — this is how In-library pills update after a scan), (d) filter/sort
changes. Tab-switch survival is free: `shouldReuse` + `TabPersistStrategy` keep the
component alive, and the root-provided service keeps receiving progress events. **Renderer
reload mid-sync** (Ctrl+R, crash-restore) is covered by `lastfmGetSyncState`, invoked in
the service constructor to re-attach to a running sync.

## 11. Error handling & edge cases

- last.fm error envelope parsed on every response; codes 8/11/16/29 retried (≤ 3, backoff),
  6/10/17 surfaced immediately with human-readable messages.
- Enchor: 400 never retried; 429 sleeps until Reset (doesn't consume retries or mark
  artists `error`); other failures retry ≤ 3. Per-artist failures mark the cache row
  `error` (always-stale) and the run continues; only last.fm auth errors or cancel abort
  the run.
- App quit mid-sync: per-artist transactions + the always-run match phase (§9 step 5) mean
  the next sync self-heals; no stranded state.
- Concurrent syncs impossible (singleton reject); mid-run settings edits can't corrupt
  data (snapshot + cancel-then-clear on username change).
- Zoneless Angular: all state through signals; IPC listeners subscribed once in the Angular
  service constructor (the listener API is add-only — the established constraint).

## 12. Files

**New:**
```
src-shared/interfaces/lastfm.interface.ts
src-electron/ipc/lastfm/LastfmHandler.ipc.ts
src-electron/ipc/lastfm/LastfmService.ts
src-electron/ipc/lastfm/LastfmApi.ts
src-electron/ipc/lastfm/EnchorClient.ts
src-electron/ipc/lastfm/LastfmDatabase.ts
src-electron/ipc/lastfm/matching.ts
src-electron/ipc/lastfm/matching.test.ts        (vitest — see step 4)
src-angular/app/core/services/lastfm.service.ts
src-angular/app/components/discover/discover.component.ts / .html
```

**Touched (registration/config only):**
```
src-shared/interfaces/ipc.interface.ts      (+5 channels, module banner comment)
src-electron/IpcHandler.ts                  (+3 invoke, +1 emit registration)
src-electron/preload.ts                     (+5 entries)
src-shared/Settings.ts                      (+2 fields + defaults)
src-angular/app/core/services/settings.service.ts   (+2 get/set pairs)
src-angular/app/components/settings/settings.component.ts/.html  (Last.fm section)
src-angular/app/app.routes.ts               (+1 route, after library)
src-angular/app/components/toolbar/toolbar.component.html  (+1 tab after Library)
src-electron/ipc/catalog/CatalogDatabase.ts (+checkSongsExist — main-process-only)
src-angular/app/core/services/download.service.ts  (narrow addDownload param to Pick<…>)
package.json                                (+vitest devDependency, +test script)
src-angular/app/components/browse/search-bar/search-bar.component.ts
                                            (optional prerequisite: 300ms debounce)
```

Electron-side imports use explicit `.js` extensions (ESM); tabs, single quotes, no
semicolons; channel ordering kept consistent across the three IPC files.

## 13. Implementation plan (each step independently verifiable)

1. **Settings + validation** — fields, UI section, `lastfmValidateUser` (first IPC channel
   end-to-end).
   *Verify:* Test connection with a real key + username shows the scrobble count; a wrong
   key and a wrong username show distinct messages.
2. **LastfmApi + track fetch + LastfmDatabase + sync channel skeleton** — register
   `lastfmSync`, `lastfmSyncProgress`, and `lastfmGetSyncState` now, with the enchor/match
   phases stubbed to no-ops, so this step is verifiable without inventing a harness.
   *Verify:* from devtools, `window.electron.emit.lastfmSync({action:'start', options:{source:'top_overall', trackLimit:500}})`;
   inspect `dataPath/lastfm.db` with the sqlite3 CLI — 500 top + 171 loved rows,
   playcounts spot-checked against the website; progress events observed.
3. **EnchorClient + artist fetch phase** — strategies, verification filtering, slimming,
   authoritative bucket writes, pacing/429 branch, cache statuses.
   *Verify:* sync a 10-artist slice; junction + chart rows correct in the DB; logs show
   header-aware pacing and adaptive cost; re-run skips cached artists; an artist with a
   comma/`&` variant still lands charts (e.g. a "Beatles, The"-style case).
4. **matching.ts + match phase + tests** — add vitest (the repo has no test infra; matching
   is pure and import-safe, so this is cheap and survives as regression cover). Fixtures:
   `Song (2011 Remaster)`↔`Song` ⇒ fuzzy 0.95 · `Song (Skrillex Remix)`↔`Song` ⇒ variant ≤0.75 ·
   `Beyoncé`↔`Beyonce` artist-verify pass · `The Beatles`↔`Beatles, The` verify pass ·
   `Don’t Stop`↔`Don't Stop` ⇒ exact · `A feat. B` artist-strip · `Dream`↔`Dreams` ⇒ NO match ·
   `Us` (short title) ⇒ tier-3 refused · first-token gate case · chart-side `Song (2x Bass)` ⇒ match.
   *Verify:* `npm test` green; a full sync then produces a `matches` table where a
   known-charted top track of yours matches exact.
5. **Discover tab**, split:
   - **5a — route/tab/states + table + sort.** *Verify:* sync top-200 3month; rows appear
     incrementally without jank; headers sort; state 1 shows when settings empty.
   - **5b — filters + localStorage + unmatched rows.** *Verify:* each filter changes the
     row set; values survive app restart; Browse filters unaffected; unmatched row shows
     artist chart count vs "artist not on Enchor" correctly.
   - **5c — download + in-library + cancel.** *Verify:* download a chart end-to-end into
     the library; optimistic "Downloaded" appears at once, green pill after a rescan;
     cancel mid-sync leaves a resumable state (next sync completes the remainder).
   - **5d — Open in Browse.** *Verify:* matched row lands on the exact song in Browse with
     the sidebar working; artist-only row lands on the artist's charts.
6. **Polish** — attribution footer, error surfaces, empty states, (optional) the search-bar
   debounce prerequisite if not done earlier.

## 14. Future ideas (explicitly out of scope for v1)

- `artist.getSimilar` — charts for artists *similar* to your top artists (true
  recommendations beyond history matching).
- `user.getRecentTracks` "current obsessions" weighting (recency-decayed playcounts).
- Romanization pass for CJK artists (§7.4).
- Auto-sync on app start; notify when a newly-uploaded chart matches your history
  (`modifiedAfter` polling).
- ListenBrainz as an alternative scrobble source.
