# .sng Write Support: system design

**Status:** Design v2 — v1 was adversarially reviewed (3 independent passes: codebase
fact-check, failure-mode attack, completeness audit); every finding is resolved below.
**Goal:** Every chart-modifying feature in Bridge (lyrics inject/delete, album art,
background generate/blur, video download/import/delete, song.ini metadata edits) works
identically for `.sng` archives and chart folders — plus the read-side features
(asset previews, audio preview, asset detection) stop reporting `.sng` assets as missing.

---

## 0. Assumptions and constraints

- **Clone Hero is closed-source.** Its `.sng` parser cannot be code-verified. The design
  compensates by (a) emitting output byte-compatible with the reference encoder
  (`SngCli`/`SngLib`) and readable by both open readers we *can* verify — parse-sng
  (Bridge's own reader, locally verified against `node_modules/parse-sng/index.ts`) and
  YARG (externally sourced: YARC-Official/YARG.Core `SngFile.cs`) — and (b) making a
  manual "CH loads the repacked chart" check an explicit acceptance gate per phase.
  Claims marked *[external]* below come from the spec/YARG/SngCli sources, not local code.
- A repacked `.sng` **always changes the file's md5** (fresh random XOR mask). Bridge's
  "already in library" detection is metadata-based, so unaffected; the local file simply
  stops matching Enchor's published md5. Accepted.
- Pre-existing non-atomic *folder* writes (`notes.chart` rewritten in place,
  `LyricsService.ts:224`) are out of scope — not made worse, not fixed here.
- No `.bak` backups: originals are re-downloadable from Enchor, and the single-rename
  replace (§4) never has a moment where the original is at risk without a verified
  replacement in place.
- **Metadata lossiness accepted and documented:** `.sng` metadata→`song.ini`→metadata
  round trips through parse-sng drop keys whose values equal parse-sng's built-in
  defaults, drop empty values, and reorder keys (`generateIniFileText`,
  `parse-sng/index.ts:337-352`). Consequence: *clearing* a key whose reader-default is
  non-empty (e.g. `album_track`) is not reliably representable — the default resurrects
  at read time. Bridge's metadata editor touches only name/artist/album/genre/year/charter,
  where this is harmless. Comments and non-`[song]` sections in extracted `song.ini` are
  likewise unrepresentable in the archive and are dropped on repack (Clone Hero reads only
  `[song]`; a `.sng` round trip could never preserve them anyway).

## 1. The two facts that shape everything

**Fact 1 — the format is easy; the lifecycle is the system.** `.sng` v1 is little-endian,
uncompressed, checksum-free. A streaming packer is small. The engineering is:
extract → edit → validate → repack → atomically replace → rescan, safely, under
concurrency, for five feature modules.

**Fact 2 — every mutation feature assumes a folder.** Complete inventory (recon-verified
refs): lyrics inject `LyricsService.ts:284/224`, lyrics delete `:616-655`, album art +
background `ImageService.ts:128/165/224`, background delete `ArtStudioHandler.ipc.ts:331`,
album art delete `:374`, video download/import/delete `YouTubeService.ts:188/325/444`,
`VideoSyncHandler.ipc.ts:130/291`, song.ini rewrite `CatalogHandler.ipc.ts:119-180`.
All operate on `chart.path`, which for an archive is the `.sng` *file* → `ENOTDIR`.
One abstraction fixes all of them.

**Corollary: archive detection is by extension, not chartType.**
`ChartScanner.convertToChartRecord` (`ChartScanner.ts:433-441`) classifies a `.sng`
containing `notes.chart` as chartType `'chart'`. Every check in this design uses
`path.toLowerCase().endsWith('.sng')`.

## 2. Architecture

```
┌─ Feature handlers (lyrics / art-studio / video-sync / catalog metadata) ─┐
│   const ws = await openChartWorkspace(chart.path)     // acquires lock   │
│   try {                                                                  │
│     ...existing folder logic, unchanged, against ws.dir...               │
│     if (serviceResultIndicatesSuccess) {                                 │
│       const { changed } = await ws.commit()                              │
│       if (changed) await getChartScanner().rescanChart(chart.path)       │
│     }                                                                    │
│   } finally { await ws.discard() }                     // releases lock  │
└──────────────────────────────┬────────────────────────────────────────---┘
                               │
┌─ src-electron/ipc/sng/ (new module, main-process only) ────────────────--┐
│ sng.interface.ts    module-local types (no renderer exposure — §6 adds   │
│                     zero IPC channels, so src-shared is the wrong home)  │
│ SngPacker.ts        streaming packer (pure header math + chunked I/O)    │
│ SngReader.ts        shared streaming extraction (refactor of the two     │
│                     existing copies, behavior parameterized — see below) │
│ sngIni.ts           song.ini text ⇄ metadata map (pure)                  │
│ ChartWorkspace.ts   the edit lifecycle + locks + replace + sweep         │
└─────────────────────────────────────────────────────────────────────────-┘
```

### Module signatures (the contract phase 1–2 implements)

```ts
// SngPacker.ts
interface SngPackEntry { name: string; size: number; stream(): NodeJS.ReadableStream }
/** Pure, unit-testable header math (magic/mask/metadata/fileMeta/offset chain). */
function buildSngHeader(entries: Array<{ name: string; size: number }>, metadata: Map<string, string>, xorMask: Buffer): Buffer
/** Streaming writer: O(chunk) memory, chunked XOR + md5, never a whole-archive Buffer. */
function packSngToFile(entries: SngPackEntry[], metadata: Map<string, string>, destPath: string): Promise<void>

// SngReader.ts — replaces the two divergent copies. The existing copies differ on THREE
// axes (verified): which contents load (ChartScanner: chart/ini/album only, video and
// oversized files become EMPTY-DATA PLACEHOLDERS, ChartScanner.ts:352-380; IssueScan:
// everything except video with its own size-truncation heuristic and skipped files
// OMITTED from the list, IssueScanHandler.ipc.ts:113-140) and error semantics
// (ChartScanner swallows → partial list, ChartScanner.ts:394-397; IssueScan rejects).
// Predicate injection + flags keep both call sites bit-identical after the refactor:
interface ReadSngOptions {
	loadData?: (fileName: string, size: number) => boolean  // false → entry with empty data
	omitUnloaded?: boolean                                  // true = IssueScan behavior
	swallowErrors?: boolean                                 // true = ChartScanner behavior
}
function readSngFiles(sngPath: string, opts?: ReadSngOptions): Promise<Array<{ fileName: string; data: Uint8Array }>>
/** Streams EVERYTHING (video included) to disk; workspace-only. */
function extractSngToDir(sngPath: string, destDir: string): Promise<SngManifest>
type SngManifest = Map<string, { size: number; md5: string }>

// ChartWorkspace.ts
interface ChartWorkspace {
	readonly dir: string
	readonly isSng: boolean
	/** No-op returning { changed: false } when the dir matches the open() manifest. */
	commit(): Promise<{ changed: boolean }>
	/** Best-effort cleanup + lock release. Never throws (would mask commit errors in finally). */
	discard(): Promise<void>
}
function openChartWorkspace(chartPath: string): Promise<ChartWorkspace>
function sweepSngTempArtifacts(): Promise<void>   // called at app startup
```

Folder charts: `dir = chart.path`, `commit()` diffs nothing and returns
`{ changed: true }` trivially cheap (handlers still gate on service success), `discard()`
releases the lock. Zero overhead, one code path per feature.

## 3. SngPacker — binary format contract

Locally verified against parse-sng 4.0.3 source; *[external]* items verified against the
spec (mdsitton/SngFileFormat README), the reference encoder (`SngSerializer.cs`), and
YARG's reader (`SngFile.cs`).

1. `SNGPKG` magic, uint32 LE version **= 1**, 16 bytes from `crypto.randomBytes(16)`.
2. Metadata section: `metadataLen` u64 = 8 + Σ(4 + keyBytes + 4 + valueBytes); count u64;
   pairs int32-LE-length-prefixed UTF-8. **All length prefixes are
   `Buffer.byteLength(s, 'utf8')` — never `s.length`** (a `.length` implementation passes
   ASCII tests and corrupts every archive containing 'Fábio' or '東方Project').
   Section lengths must be byte-exact: YARG buffer-reads exactly `(len − 8)` *[external]*;
   parse-sng skips by them (`index.ts:117-130`).
3. File index: per file, 1-byte name length + UTF-8 name, u64 `contentsLen`, u64
   **absolute** `contentsIndex` (first file = 26 + 8 + metadataLen + 8 + fileMetaLen + 8,
   then previous + previous length). `fileMetaLen` = 8 (count) + Σ(1 + nameBytes + 16).
   All u64 written via `Buffer.writeBigUInt64LE(BigInt(n))`. YARG seeks by contentsIndex
   *[external]*; parse-sng ignores it and streams sequentially (`index.ts:201-248`).
4. `fileDataLen` u64 = Σ contentsLen; file bytes **contiguous, in fileMeta order, no
   padding** — required by parse-sng's sequential reader.
5. XOR mask each file with the index **resetting to 0 per file**:
   `masked[i] = plain[i] ^ mask[i % 16] ^ (i & 0xFF)` (parse-sng `index.ts:250-279`).
   A global running offset is the classic corruption bug — only the first file decodes.
6. **Filenames ≤ 127 UTF-8 bytes** — spec allows 255 *[external]*, but parse-sng reads the
   length as a *signed* int8 (`index.ts:312`). Pack-time hard error naming the file.
7. Never pack `song.ini` as a file — `sngIni.ts` folds its `[song]` keys into metadata
   (parse-sng with `generateSongIni` would otherwise emit a duplicate). Fold rules:
   parse only the case-insensitive `[song]` section, strip BOM, tolerate CRLF, ignore
   comment lines and other sections (dropped — see §0 lossiness).
8. Metadata sanitization: **keys** containing `=`, `;`, or newlines are hard-rejected
   (commit fails with the key named). **Values**: only newlines are stripped (the one
   thing that actually breaks the ini round trip); any such modification is reported in
   the commit result, never silent. Empty keys/values are skipped (parse-sng drops them
   at read time regardless).
9. Encoder policy copied from SngCli *[external]*: lowercase known filenames; exclude
   junk (`desktop.ini`, `.DS_Store`, `ps.dat`, `ch.dat`, `__MACOSX/`, nested `*.sng`).
10. Subfolder entries: names use `/` separators. Extraction normalizes `\` → `/`,
    creates parent dirs, and **rejects** (fails `open()`) any name resolving outside the
    workspace dir or containing `..` segments (path traversal). Repack walks `ws.dir`
    recursively emitting POSIX-relative names, so nested files round-trip. Feature logic
    stays top-level-only (`readdir` non-recursive) — identical to today's folder-chart
    behavior; that parity is deliberate.

## 4. ChartWorkspace lifecycle

### open(chartPath) — `.sng` backend
1. **Acquire the per-chart-path lock** (see §5) with a short timeout — if another
   operation holds it, fail fast: "This chart is being edited by another operation."
   The lock is held until `discard()`. This closes the lost-update race review found:
   with a commit-only lock, two overlapping opens would silently revert each other's
   committed changes (both extracts are pre-edit snapshots; the second commit wins).
2. **Record the archive's size + mtime** for the external-modification check at commit
   (Clone Hero or a file manager touching the file mid-edit).
3. **Disk preflight:** `fs.statfs` on `tempPath` — require ≥ 2.2× archive size free
   (extract + packed artifact) — and on the chart's volume (≥ 1.1×). Refuse with
   "need ~X GB free on Y" *before* any work (in particular before yt-dlp downloads).
4. **MAX_PATH precheck (win32):** temp dir is `tempPath/sng-<12 hex>/` (short on
   purpose); if any entry's extraction path would exceed ~250 chars, fail `open()`
   naming the file.
5. Extract everything — **including video files** (`ChartScanner.getFilesFromSng` skips
   video *contents* for scanning; the workspace must not) — via `extractSngToDir`,
   `generateSongIni: true`. Keep the returned manifest.
6. Run a **baseline scan**: `scanChartFolder` over the extracted list (with the
   synthesized song.ini included; `includeMd5: false`; audio/video passed as empty-data
   placeholders exactly as ChartScanner does). Store the baseline result for the
   differential validation gate.

### commit() — `.sng` backend
```
0. no-change gate  re-walk ws.dir against the open() manifest (size+md5); identical
                   ⇒ return { changed: false } without validate/pack/replace. This is
                   the manifest's single purpose. Also: stat the on-disk archive —
                   if size/mtime differ from open(), refuse: "chart was modified
                   outside Bridge while editing".
0.5 scan fence     if a full library scan is running, WAIT for it (progress message
                   "Waiting for library scan…", bounded 5 min then error) — refusing
                   would throw away completed work (a 2 GB finished video download).
                   Ordering is acyclic: commits wait for scans; scans never wait for
                   commits (the replace step is atomic, §4-REPLACE, so a scan can
                   safely run concurrently — the fence exists to avoid hash-churn
                   noise, not for correctness).
1. VALIDATE        scanChartFolder over the current dir listing, WITH the synthesized
                   song.ini (validating without it parses under default ini modifiers
                   — wrong semantics — and always flags noMetadata) and empty-data
                   audio/video placeholders. scanChartFolder NEVER throws — bad charts
                   come back as playable:false / notesData:null / folderIssues
                   ('badChart', …) — so the gate reads fields, not exceptions.
                   The gate is DIFFERENTIAL against the open() baseline: refuse only on
                   regression — notesData non-null→null, playable true→false, or NEW
                   blocklisted folderIssues. A chart that was already broken stays
                   editable (the edit may be the repair); noAudio-class issues from
                   placeholder data exist in the baseline too and thus never trip it.
2. PACK            packSngToFile → tempPath/sng-<id>.sng (streaming, chunked XOR/md5).
3. VERIFY          re-parse the packed file with parse-sng (the app's own reader),
                   streaming; compare per-file md5 + metadata map against ws.dir.
4. REPLACE         copy packed → `<chart>.sng.bridge-new` (same dir ⇒ same volume);
                   open + fsync the copy (FlushFileBuffers — without this, a power
                   loss after rename can leave a directory entry pointing at unflushed
                   data: the classic write-temp-then-rename bug);
                   then ONE rename: `<chart>.sng.bridge-new` → `<chart>.sng`.
                   On Windows/libuv this is MoveFileExW + MOVEFILE_REPLACE_EXISTING:
                   atomic supersede on the same NTFS volume. There is NO window where
                   the chart is absent (v1's three-step dance had one, which a
                   concurrent rescanChart turns into catalog-row deletion), no .old
                   file ever exists (v1's recovery rule would have deleted USER-made
                   `Song.sng.old` backups — suffix squatting on files we don't own),
                   and failure at any point = original untouched, delete the .bridge-new.
                   EBUSY/EPERM on the rename (AV/indexer holding the target without
                   FILE_SHARE_DELETE; Bridge's own readers use libuv = share-delete)
                   is retried 3× with 500ms backoff, then: delete .bridge-new, error.
5. (caller)        handler awaits rescanChart(chartPath) when changed === true.
```
VALIDATE + PACK + VERIFY run in a **worker_thread**: `scanChartFolder` is synchronous
(blake3 hashing, image work) and a chunked XOR over hundreds of MB would otherwise block
the main-process event loop — freezing the renderer and, ironically, the very progress
events announcing the repack. The workspace API is already async; callers don't change.
(Fallback if worker packaging fights the build: chunked processing with `setImmediate`
yields — decided in phase 2, worker preferred.)

### discard()
Best-effort, **never throws** (it runs in `finally` and must not mask commit errors):
remove the workspace dir *and* any `tempPath/sng-<id>.*` sibling artifacts (the packed
file is outside the dir), release the lock, log failures (EBUSY from a straggling
ffmpeg/AV handle) and leave them to the sweep.

### Crash recovery & sweeps (exact hook points)
- `sweepSngTempArtifacts()` — exported from `ChartWorkspace.ts`, called fire-and-forget
  in `app.on('ready')` after `createBridgeWindow()` (same pattern as `retryUpdate`,
  `main.ts:24-29`): removes `tempPath/sng-*` entries older than 24h.
- Library-side strays: `ChartScanner`'s directory walk and `rescanChart` delete any
  `*.sng.bridge-new` they encounter (crash before the rename; the commit never reported
  success, so roll-back-by-deletion is correct — stated as a choice). The suffix is
  unmistakably Bridge-owned; nothing else is ever swept. Neither `.bridge-new` nor any
  temp name ends in `.sng`, so `hasSngExtension` (`UtilFunctions.ts:192`, last
  dot-segment) can't misclassify them as charts — verified.

## 5. Concurrency model

| Surface | Risk | Mitigation |
|---|---|---|
| Two edits, same chart (incl. overlapping open windows) | lost update — second commit repacks from a stale extract, silently reverting the first | per-chart-path lock held **open→discard** (not commit-only); second open fails fast with a clear message |
| External modification (CH, file manager) during an edit | same lost-update, from outside the app | size+mtime check at commit step 0 |
| Full library scan | hash/stream churn | replace is a single atomic rename (scan sees old *or* new, never half, never absent); commits additionally wait for active scans (§4 step 0.5, bounded) |
| `rescanChart` from another feature | v1 risk was the absent-file window deleting the catalog row (`ChartScanner.ts:638-644`) — gone with single-rename; residual id-churn | route `rescanChart` through the same per-path lock (one-line await) |
| Issue scan (own reader, own Bottleneck, zero coordination) | reads mid-replace | covered by rename atomicity + EBUSY retry (read-only) |
| Download queue | destination collision | downloads refuse existing destinations **when the download starts** (`checkFilesystem`, `ChartDownload.ts:141-146` — a start-time check, not queue-time; and `transferChart` moves with `overwrite: true`, `ChartDownload.ts:233`). Disjoint in practice: repacks require an existing chart, which the download pre-check refuses. Documented, not coded |
| Chart preview | none | verified: previews stream from `files.enchor.us`, never local files |

Needed scanner additions (exact edits — the v1 "1-line getter" collides with the
existing private field name): rename private `isScanning` → `scanning`
(`ChartScanner.ts:52` + its ~3 internal references), add
`isScanning(): boolean { return this.scanning }` and a `whenScanIdle(): Promise<void>`
resolved by the existing scan-completion path.

## 6. Feature integration

**The composition rule:** one workspace per chart per *user-level operation*. A
"replace background" (delete old + write new) or "album art + background" action makes
all its edits inside a single open→commit — never two unpack/repack cycles. Batch loops
open→commit per chart, serially (bounds temp-space and I/O), with per-chart progress.

**Handlers own the workspace; services keep taking a directory** (`ws.dir`). Handlers
always resolve the chart from the DB and pass `ws.dir` downstream, **ignoring any
renderer-supplied `outputPath`** (lyricsDownload, videoDownload, videoImportLocal all
accept one today; `videoImportLocal`'s copy even lives inline in the handler,
`VideoSyncHandler.ipc.ts:130` — wrapped the same way).

**Commit discipline (review blocker):** Bridge services signal failure by *returning*
`{ success: false }`, not throwing (`LyricsService.ts:236-263`, and yt-dlp failures
leave `.part` junk in the output dir). Handlers therefore call `commit()` only on
service-reported success; `commit()` itself is additionally self-defending via the
no-change gate. Without both, a failed video download would repack partial junk *into*
the archive.

**Rescan discipline — uniform, both backends:** after `{ changed: true }`, every handler
(all five features, folder and `.sng` alike, every batch iteration) **awaits**
`rescanChart(chart.path)`, and **all nine** `updateChartXStatus` flag-flip sites are
deleted: `LyricsHandler.ipc.ts:75/154/197`, `VideoSyncHandler.ipc.ts:78/94/133`,
`ArtStudioHandler.ipc.ts:243/305/342/380`. The rescan is the single source of truth
(`detectAssets` for folders, `getAssetsFromSngFiles` for archives) — this also retires
the pre-existing stale-flag bug class for folder charts. `commit()` never rescans
(keeps the lock scope minimal).

**Write touchpoints:**
1. `catalogUpdateChart`/`updateSongIni` (`CatalogHandler.ipc.ts:81-95/119-180`) — first
   consumer; already awaits `rescanChart`.
2. Lyrics: `downloadAndInjectLyrics` (`LyricsService.ts:230`), `deleteLyrics` (`:616`).
   Replace the batch guard `chartType !== 'chart'` (`LyricsHandler.ipc.ts:129`) with a
   real capability check (`.mid` injection stays unsupported, as today).
3. Art studio: `downloadImage` (`ImageService.ts:113`), `generateBackground` (`:211`),
   deletes (`ArtStudioHandler.ipc.ts:319/357`), three batch loops. Batch "already has
   asset" checks move from `existsSync` (`:226/:282` — always false for `.sng`, causing
   endless re-attempts) to catalog flags.
4. Video sync: `videoDownload`/`videoDownloadFromUrl`/`videoImportLocal`/
   `videoDeleteFromChart` (`VideoSyncHandler.ipc.ts:60/86/122/274`). yt-dlp/ffmpeg write
   into `ws.dir` unchanged. Video inside `.sng` is CH v1.1+ supported *[external]*.

**Read touchpoints** (the "archive assets shown as missing" fix):
5. `artGetAlbumArtDataUrl`/`artGetBackgroundDataUrl`/`artCheckChartAssets`, and
   `lyricsGetAudioPath` (`LyricsHandler.ipc.ts:209` → `LyricsService.getAudioAsDataUrl`,
   `LyricsService.ts:709`) — via `readSngFiles(path, { loadData: nameMatch })`.

**UI copy (concrete list — v1's "if any exists" was wrong):**
`chart-sidebar-menu.component.html:92` claims ".sng files will not work with the latest
CH version" — stale, update it. Optional cosmetics: the library Type filter offers only
.chart/.mid (`library.component.html:146-150`, `library.component.ts:390`) and the Type
badge styles only mid/chart (`library.component.html:335`) — cosmetic, since most `.sng`
archives classify as chartType 'chart' anyway.

**Progress:** reuse each feature's existing late-stage phase literal with a new message
("Repacking .sng archive…"): lyrics `'writing'`, art `'processing'`, video
`'converting'` — genuinely zero type/renderer changes (the phase unions are closed
string literals in src-shared, so a new literal would ripple). Accepted for v1: catalog
metadata edits show no repack progress (the renderer already awaits the invoke).

## 7. Failure modes → behavior

| Failure | Behavior |
|---|---|
| Service failed without throwing / edit was a no-op | handler skips commit / commit returns `{ changed: false }`; original untouched; no rescan |
| Edit regresses the chart (differential validate) | commit refused with the specific regression; original untouched |
| Chart already broken before the edit | still editable — gate is differential, not absolute |
| Packer verify mismatch | commit refused; loud log (packer bug); original untouched |
| Crash during extract/pack/verify | original untouched; temp swept at startup |
| Crash after copy, before rename | stray `.sng.bridge-new` deleted by scanner walk / startup; original untouched |
| Power loss around the rename | fsync before rename ⇒ the renamed file's data is durable; NTFS journals the rename itself |
| Disk full | preflight refuses up front with sizes; mid-pack ENOSPC → original untouched |
| EBUSY on rename (AV/indexer) | 3 retries; then delete `.bridge-new`, surface error; original intact |
| Archive modified externally mid-edit | commit refused: "modified outside Bridge" |
| Concurrent edit of the same chart | second `open()` fails fast |
| Commit while a full scan runs | waits (progress message), bounded 5 min |
| Filename > 127 UTF-8 bytes / traversal name / MAX_PATH overflow | refused at pack/open time naming the file |
| App closed with workspace open | lock dies with the process; temp swept at startup; no commit ⇒ no archive change |

## 8. Testing strategy

**Unit (vitest, `src-electron/ipc/sng/*.test.ts`):**
- Pack → parse with parse-sng → per-file byte equality + metadata equality (the app's own
  reader as oracle).
- Hand-computed header byte fixtures for 0/1/3-file archives (locks the length/offset
  math against an oracle that isn't the packer itself); empty-metadata edge.
- Masking known-answer vector: crafted mask, per-file index reset across 2 files, the
  i=256 wraparound.
- **Non-ASCII everywhere:** metadata values ('Fábio', '東方Project', typographic quotes)
  and a multi-byte filename — round trip through parse-sng (catches `.length` vs
  `byteLength` — ASCII-only fixtures would pass a broken packer).
- `sngIni` fold/unfold: BOM, CRLF, comments, second section, default-value lossiness
  modeled explicitly; value-newline strip reported.
- Nested-path round trip + traversal-name rejection; filename-length rejection;
  junk-file exclusion; empty key/value skipping.
- Replace-sequence state machine: failure injected at copy / fsync / rename / cleanup;
  assert original-intact or committed — never neither.
- No-change gate: open → commit asserts `{ changed: false }`; touch one byte → `{ changed: true }`.
- Fixture provenance: **one small real `.sng` (< 2 MB, audio-light, video-free) vendored
  into `src-electron/ipc/sng/fixtures/`** with a README recording its Enchor URL and
  original md5; tests never download. Everything else uses tiny synthetic archives
  built in-test.

**Integration:** each phase gate below. **Manual acceptance gate:** one designated small
CH-check chart, drag-dropped into Clone Hero once per phase 2–6 (the closed-source
residual risk, made explicit and cheap).

## 9. Implementation plan

1. **`sng/` module: SngPacker + sngIni + SngReader + unit tests.** ChartScanner and
   IssueScanHandler switch to `readSngFiles` passing their existing predicates/flags
   verbatim. *Gate:* `npm test` green incl. real-fixture round-trip and non-ASCII cases;
   scan the same library before/after and **diff the catalog DB** — identical row count
   and identical (path, folderHash, asset-flag) sets.
2. **ChartWorkspace: locks, preflights, differential validate, worker-thread pack,
   single-rename replace, sweeps, scanner `scanning` rename + `isScanning()`/
   `whenScanIdle()`.** *Gate:* dev-console script opens a real `.sng`, edits one
   metadata value, commits ⇒ `{ changed: true }`, archive re-parses, rescan upserts;
   second commit with no edit ⇒ `{ changed: false }`; kill-mid-commit leaves either the
   old or the new archive, never neither; CH loads the result (manual gate #1).
3. **Wire `catalogUpdateChart`.** *Gate:* edit `.sng` metadata in the Library tab;
   fields persist through rescan; CH shows the rename (manual gate #2).
4. **Wire lyrics (single, delete, batch guard → capability check).** *Gate:* fixture
   mini-library of exactly four charts (folder+.chart, sng+.chart, folder+.mid,
   sng+.mid); batch run reports success:2, skipped:2 (the .mid pair); injected lyrics
   visible in CH (manual gate #3); delete removes them.
5. **Wire art studio (writes, deletes, batches, flag-based skip checks).** *Gate:*
   album art + generated background land inside the archive, render in CH (manual gate
   #4), flags correct after rescan; batch over the 4-chart fixture library touches only
   charts missing assets.
6. **Wire video sync.** *Gate:* video downloads into a `.sng` and plays as CH background
   (manual gate #5); delete shrinks the archive; disk preflight message appears when
   temp space is artificially constrained.
7. **Read paths.** *Gate:* a `.sng` chart's existing album art displays in library/art
   views; audio preview plays in the lyrics sync tool.
8. **Polish:** stale `.sng` UI copy (`chart-sidebar-menu.component.html:92`), progress
   messages, doc status flip to "implemented".

Every phase compiles, tests green, and ships user-visible value on its own.

## 10. Explicitly out of scope

- Making folder-chart writes atomic (pre-existing, unchanged).
- `.sng ⇄ folder` conversion tools (buildable on ChartWorkspace later: open → emit as
  the other format).
- Surgical header-only rewrites for metadata edits (one uniform path until profiling
  says otherwise), compression, format v2 speculation.
- Representing "cleared" metadata keys whose reader-default is non-empty (§0 lossiness).
