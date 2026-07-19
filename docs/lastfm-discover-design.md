# Discover: Last.fm integration

Status: implemented (v3.5.0).

The Discover tab matches a Last.fm listening history against the Chorus Encore chart
database. It lists the user's most-played and loved songs that have charts, ranked by
playcount, flags charts already in the library, and downloads through the existing
download queue.

## Module layout

Discover is a self-contained module following the pattern of the `lyrics` module: its own
folder under `src-electron/ipc/lastfm/`, its own SQLite database, and its own Angular
service and route component. Bridge has no plugin system; modules are compile-time wired
through `ipc.interface.ts`, `IpcHandler.ts`, and `preload.ts`, and Discover touches those
shared files only at the registration points.

```
Renderer (Angular)
  DiscoverComponent          route /discover, toolbar tab after Library
  LastfmService              signals: syncProgress, matches, filters (localStorage)
  SettingsComponent          username + API key fields, Test connection button
        | typed IPC (ipc.interface.ts)
Main process (Electron)
  LastfmHandler.ipc.ts       channel functions, progress forwarding
  LastfmService.ts           singleton sync orchestrator (eventemitter3)
    LastfmApi.ts             ws.audioscrobbler.com client (Bottleneck, 1 req/s)
    EnchorClient.ts          api.enchor.us client (header-aware pacing)
    matching.ts              pure normalization and match classification
    LastfmDatabase.ts        better-sqlite3 at dataPath/lastfm.db
  CatalogDatabase.checkSongsExist   called from lastfmGetMatches; no IPC channel
```

The sync runs in the main process rather than the renderer because it is a long batch job
that must survive tab switches and renderer reloads, needs a custom `User-Agent`, writes
to SQLite, and joins against `catalog.db`.

IPC channels: `lastfmValidateUser`, `lastfmGetMatches`, `lastfmGetSyncState` (invoke),
`lastfmSync` (emit to main), `lastfmSyncProgress` (emit from main). DTOs are defined in
`src-shared/interfaces/lastfm.interface.ts`.

## Sync scope

`SyncOptions.minPlaycount` (UI default 3) controls how much history a sync covers.
Last.fm returns top tracks in descending playcount order, so `LastfmApi.getTopTracks`
pages through the list (200 tracks per page) and stops at the first track below the
threshold. A 250-page backstop (50,000 tracks) guards against runaway fetches. Loved
tracks are always fetched in full regardless of the selected source, because the loved
marker on top-track rows joins against them.

## Artist-batched fetching

One Enchor search per track does not scale: `api.enchor.us` enforces a rate limit
(`X-Ratelimit-Limit: 50` per short window; one search consumed about 10 units in
testing), and each result embeds roughly 100 KB of `notesData`. Tracks are therefore
grouped by artist and Enchor is queried once per unique artist. Title matching happens
locally against the cached results.

Per artist, after preprocessing:

1. Non-exact `POST /search/advanced` on the artist field, `per_page: 250`, page 1.
   Non-exact is the primary query because exact search returns partial coverage without
   any signal: exact `The Beatles` misses charts tagged `Beatles, The`. Over-fetching is
   filtered by local artist verification; under-fetching is undetectable.
2. If `found <= 1000`: fetch remaining pages (4 max), keep charts passing artist
   verification, discard `notesData`, write the artist bucket.
3. If `found > 1000` (common-word artist names such as "Low", or heavily charted
   artists): run one exact artist query instead (4 pages max), then issue per-track
   queries for up to 10 tracks that remain uncovered. The cache row records which
   `nameNorm` values were queried this way, so tracks added by a later sync register as
   cache misses instead of silently staying unmatched.
4. If page 1 of the primary query yields no verification-passing charts, record status
   `empty` without fetching further pages.

Artist buckets are cached for 14 days. Rows with status `error`, and overflow rows whose
track set gained new titles, are always treated as stale. Switching the period selector
reuses the same artist cache, so only the Last.fm fetch repeats.

## External API behavior

### Last.fm (`https://ws.audioscrobbler.com/2.0/`, `format=json`)

The `user.*` methods used (`getInfo`, `getTopTracks`, `getLovedTracks`) need only an
`api_key`; no user authentication. Keys are free at
`https://www.last.fm/api/account/create` and are stored in `settings.json`. The app does
not ship a shared key: keys in public repositories get abused and suspended.

Response quirks the client handles:

- Every number is a JSON string (`"playcount": "42"`).
- A single-item list may arrive as an object instead of a one-element array.
- Errors arrive as `{ error: number, message: string }`: 6 bad params or unknown user,
  10 bad key, 17 private data, 29 rate limited, 8/11/16 transient (retried up to 3 times
  with backoff).
- `getLovedTracks` has no playcount; it has `date.uts`.

The client paces at one request per second and sends an identifying `User-Agent`. The
Discover tab footer links to Last.fm, per the API terms' attribution requirement.

### Chorus Encore (`https://api.enchor.us`)

- `POST /search/advanced` with text filters `{ value, exact, exclude }`. Exact matching
  is case-insensitive. All six text-filter objects must be present (empty `value` when
  unused). `per_page` max 250, 1-based `page`. Success status is HTTP 201, so the client
  accepts any 2xx.
- Rate limiting is header-driven and the budget is shared with the Browse tab's own
  searches. The client reads `X-Ratelimit-Remaining` and `X-Ratelimit-Reset` on every
  response, derives per-request cost from remaining-count deltas, pauses until the reset
  time when the remaining budget is low, and keeps a 2-second baseline gap. On HTTP 429
  it sleeps until the reset time without consuming the retry budget. Missing or negative
  rate headers are treated as an exhausted budget. HTTP 400 means a malformed request and
  is never retried.

## Local database (`dataPath/lastfm.db`)

Separate file from `catalog.db` so the scanner's orphan deletion cannot touch it. Opened
with WAL and `PRAGMA foreign_keys = ON` (better-sqlite3 defaults foreign keys off).

- `lastfm_tracks`: one row per (source, artistNorm, nameNorm). `source` is
  `top_overall` … `top_7day` or `loved`. `bucketNorms` stores the artist buckets the
  track belongs to (newline-separated), since compound artists map to several buckets.
- `enchor_artist_cache`: per-bucket fetch state (`queryValue`, `strategy`, `chartCount`,
  `queriedTracks`, `status`, `fetchedAt`). Status is `ok`, `empty`, `overflow`, or
  `error`.
- `enchor_charts`: slim chart rows keyed by `chartId`. Columns cover exactly what the UI
  and `DownloadService.addDownload` need, plus `chartName` and `nameNorm` for matching.
- `artist_charts`: junction table (bucket, chartId). A chart can belong to several
  buckets (collaborations, spelling variants); a plain artist column on `enchor_charts`
  would let one bucket's upsert remove another's membership.
- `matches`: (trackId, chartId, matchType, similarity), rebuilt wholesale by each match
  pass.
- `lastfm_meta`: key-value store (username, cacheVersion, lastSyncAt).

An artist re-fetch is authoritative for its bucket: memberships absent from the fresh
result are deleted in the same transaction, and charts with no remaining memberships are
garbage-collected. Otherwise charts removed from Enchor would be offered for download
forever and 404.

`cacheVersion` in `lastfm_meta` forces a full cache refetch when the matching logic
changes in a way that invalidates cached buckets.

## Matching

Artist preprocessing strips featuring clauses, splits compound artists (`A & B`,
comma-separated lists) into component buckets while keeping the full compound as its own
bucket, and skips a denylist (`various artists`, `unknown artist`).

Artist verification decides whether a chart returned by a non-exact search belongs to a
bucket. After normalizing and stripping a leading "the" or trailing ", the", a chart is
accepted on: token-multiset equality; a composite segment of one side (parenthesized
chunk, or a part split on `,`/`/`/`;`) equal to the whole other side; or a
Sorensen-Dice bigram score of at least 0.9. Plain token containment is deliberately not
used: it accepted "Los Trabajadores De La Television Y La Radio" into the "Television"
bucket.

Title matching uses two normalization tiers and three match classes:

- `norm1`: NFKC, lowercase, trimmed, collapsed whitespace, straightened quotes and
  dashes. Equality means an exact match (similarity 1.0).
- `norm2`: `norm1` plus diacritic stripping, featuring-clause removal, `&` to `and`,
  punctuation removal, and stripping of trailing parenthetical/bracket/dash segments.
  Stripped segments are classified: cosmetic (remaster, radio edit, mono/stereo, deluxe,
  bonus track, a bare year) or recording-variant (remix, live, demo, acoustic,
  instrumental, cover). Equal `norm2` with matching variant sets is a fuzzy match
  (similarity 0.95); with differing variant sets it is a `variant` match capped at 0.75,
  shown in the UI as "Different version", because a remix or live recording has a
  different note chart than the studio version.
- Dice-coefficient fallback, gated to avoid false positives on short titles: requires
  `norm2` length of at least 5, threshold 0.85 (0.9 under 8 characters), and an identical
  first token. "Dream" vs "Dreams" (0.889) is correctly rejected. When several distinct
  titles pass, only charts of the top-scoring title are kept.

Charter tags that appear inside Enchor titles ("2x bass", "co-op", "rb3 port") are
stripped from the chart side before comparison. When a chart's `name` fails entirely,
matching falls through once to its `chartName` override.

Matching is not reliable across scripts: an artist scrobbled as 東京事変 will not match
charts tagged "Tokyo Jihen" unless the chart tag contains the native script as a
composite segment. Such artists come back `empty` and the UI distinguishes "artist not
found" from "artist found, song not charted".

## Sync pipeline

`startSync` is rejected while a sync runs (the UI also disables the button). Credentials
are snapshotted at start; a username change cancels any run and clears user-specific
tables before the next one.

1. Validate the username and key with `user.getInfo`.
2. Fetch top tracks for the selected source down to the playcount threshold, plus all
   loved tracks. Replace those sources' rows.
3. Plan: collect stale artist buckets for the current track set.
4. Fetch each stale bucket from Enchor (strategy above), one artist per progress tick.
   Individual artist failures mark the cache row `error` and the run continues.
5. Rebuild the whole `matches` table from every bucket referenced by the current track
   set, not only buckets fetched this run. This makes cancellation, crashes, and new
   tracks for cached artists self-heal on the next sync. The rebuild also runs every 8
   fetched artists so results appear in the table during a long first sync.

Cancellation sets a flag checked between requests. Every write is transactional per
artist, so a killed sync leaves no partial bucket.

`lastfmGetMatches` computes rows on demand: charts per track (sorted exact > fuzzy >
variant, then similarity, then modified time), the loved marker, artist chart counts,
and in-library state. In-library is checked against `catalog.db` at query time by
normalized (artist, name) pairs for both the Last.fm track title and each matched
chart's title, since a downloaded chart's `song.ini` carries the chart's title, which
can differ from the scrobbled title. Filtering and sorting happen in the same call;
results are not paginated.

The renderer service re-queries matches on route activation, on throttled sync progress
(at most every 2 seconds), on catalog scan completion, and on filter changes.
`lastfmGetSyncState` returns the last progress event so a reloaded renderer can reattach
to a running sync.

## Testing

`src-electron/ipc/lastfm/matching.test.ts` (vitest, `npm test`) covers the normalization
tiers, variant classification, Dice gating, artist verification (including the
"Television" rejection cases), compound-artist preprocessing, and chart-side tag
stripping.
