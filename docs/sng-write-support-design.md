# .sng write support

Status: implemented (v3.5.0).

Chart-modifying features (lyrics injection and deletion, album art, background
generation, video download/import/delete, song.ini metadata edits) work identically for
`.sng` archives and chart folders. Read-side features (asset previews, audio preview,
asset detection) read archive contents without extraction.

## Background

`.sng` v1 is a single-file container: little-endian, uncompressed, no checksums. A
26-byte header (`SNGPKG` magic, uint32 version, 16 random XOR-mask bytes) is followed by
a metadata section, a file index, and contiguous XOR-masked file data. `song.ini` is not
stored as a file; its `[song]` keys are the metadata section, and `parse-sng` synthesizes
a `song.ini` on read when `generateSongIni` is set.

`parse-sng` (the reader Bridge already used for downloads and scanning) has no encoder,
so this module includes a packer written against the format spec
(github.com/mdsitton/SngFileFormat), its C# reference encoder, and `parse-sng`'s own
parsing code.

Archive detection is by path extension, not `chartType`: the scanner classifies a `.sng`
containing `notes.chart` as chartType `chart`, so `chartType === 'sng'` only means
"archive with no recognized chart file".

## Module layout (`src-electron/ipc/sng/`)

- `sng.interface.ts`: module-local types. No renderer exposure; the feature adds no IPC
  channels.
- `SngPacker.ts`: `buildSngHeader` (pure header math) and `packSngToFile` (streaming
  writer with chunked XOR and md5, bounded memory).
- `SngReader.ts`: `readSngFiles` (sequential extraction, parameterized so ChartScanner
  and IssueScanHandler keep their exact prior behavior), `extractSngToDir` (full
  extraction to disk for the workspace), `readSngHeader` (header only, without draining
  the data section), and `readSngEntries` (positional single-file reads at header
  offsets, used by asset previews so reading album art out of a video-bearing archive
  does not read the whole file).
- `sngIni.ts`: `song.ini` text to metadata map and back.
- `ChartWorkspace.ts`: the edit lifecycle, locks, atomic replacement, and temp cleanup.

Feature handlers use one pattern:

```ts
const ws = await openChartWorkspace(chart.path)
try {
	// existing folder logic, unchanged, against ws.dir
	if (serviceSucceeded) {
		const { changed } = await ws.commit()
		if (changed) await getChartScanner().rescanChart(chart.path)
	}
} finally { await ws.discard() }
```

For folder charts the workspace is a no-op wrapper around the real directory. For `.sng`
the workspace extracts the archive to a temp directory, the feature edits real files,
and `commit()` repacks. Handlers gate `commit()` on the service result because Bridge
services report failure by return value rather than by throwing; without the gate, a
failed video download would repack partial files into the archive.

After a changed commit, handlers await `rescanChart`, which re-derives every catalog
column. The per-feature `updateChartXStatus` flag flips were removed; the rescan is the
single source of truth for folders and archives alike.

## Packer format contract

- Magic `SNGPKG`, uint32 LE version 1, 16 bytes from `crypto.randomBytes(16)`.
- All length prefixes are UTF-8 byte counts (`Buffer.byteLength`), never `String.length`.
  Section length fields are byte-exact: YARG buffer-reads exactly `(len - 8)` bytes and
  `parse-sng` skips sections by them.
- File index entries: 1-byte name length, UTF-8 name, uint64 `contentsLen`, uint64
  absolute `contentsIndex`. `fileMetaLen` = 8 + sum of (1 + nameBytes + 16). All uint64
  values are written with `writeBigUInt64LE`.
- File data is contiguous, in file-index order, with no padding. `parse-sng` ignores
  `contentsIndex` and streams sequentially; YARG seeks by it. Both layouts must agree.
- Masking: `masked[i] = plain[i] ^ mask[i % 16] ^ (i & 0xFF)` with `i` resetting to 0 for
  each file. A global running offset corrupts every file after the first.
- Filenames are capped at 127 UTF-8 bytes. The spec allows 255, but `parse-sng` reads the
  length as a signed int8 and misparses longer names.
- `song.ini` is never packed as a file entry; its `[song]` keys become the metadata
  section. Keys containing `=`, `;`, or newlines are rejected. Newlines in values are
  stripped and reported in the commit result. Empty keys and values are skipped.
- Encoder policy matching the reference implementation: known filenames lowercased; junk
  excluded (`desktop.ini`, `.DS_Store`, `ps.dat`, `ch.dat`, `__MACOSX/`, nested `.sng`).
- Entry names use `/` separators. Extraction normalizes `\`, creates parent directories,
  and rejects traversal segments, names resolving outside the workspace, names Windows
  cannot store faithfully (trailing dot or space, reserved device names, illegal
  characters), and case-insensitive duplicates. Rejecting is deliberate: NTFS would
  silently merge or rename such entries in the workspace and the corruption would then be
  repacked into the archive.

Known lossiness, accepted: `parse-sng`'s generated `song.ini` drops keys whose values
equal its built-in defaults and reorders keys, so metadata round trips are semantic, not
byte-identical. Comments and non-`[song]` sections in an extracted `song.ini` are dropped
on repack. A repack always changes the archive's md5 (fresh random mask), so the local
file stops matching Chorus Encore's published md5; in-library detection is
metadata-based and unaffected.

## Workspace lifecycle

`openChartWorkspace(chartPath)` for an archive:

1. Acquires the per-chart-path lock, failing fast if another operation holds it. The
   lock is held until `discard()`. A commit-only lock would allow a lost update: two
   overlapping edits each extract a pre-edit snapshot and the second commit would revert
   the first's changes.
2. Records the archive's size and mtime for an external-modification check at commit.
3. Checks free disk space (`fs.statfs`) on the temp volume and the chart's volume, and
   rejects with the required sizes before any work runs.
4. Rejects extraction paths that would exceed the Windows path-length limit, naming the
   file. The temp directory name is kept short (`sng-<12 hex>`).
5. Extracts everything, including video, and records a manifest (name, size, md5).
6. Runs a baseline `scanChartFolder` over the extracted files (with the synthesized
   `song.ini` and empty placeholders for audio/video, matching the scanner's own usage)
   for the differential validation gate.

`commit()`:

1. No-change gate: if the directory matches the manifest, return `{ changed: false }`
   without packing. Also refuses if the on-disk archive changed since `open()` ("modified
   outside Bridge").
2. Scan fence: waits for an active full library scan (bounded at 5 minutes) instead of
   refusing, so a finished long download is not thrown away.
3. Differential validation: `scanChartFolder` never throws; it reports issues in its
   return value. The gate compares against the baseline and refuses only on regression
   (notesData becoming null, playable true to false, new blocklisted folder issues). A
   chart that was already broken stays editable, since the edit may be the repair.
4. Pack to a temp file, then verify by re-parsing the packed archive with `parse-sng` and
   comparing per-file md5s and metadata against the workspace.
5. Replace: copy the packed file to `<chart>.sng.bridge-new` in the chart's directory
   (same volume), fsync it (without this, power loss after the rename can leave a
   directory entry pointing at unflushed data), then a single `fs.rename` over the
   original. On NTFS this is `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`: atomic, and
   the chart file exists at every instant. `EBUSY`/`EPERM` on the rename (an antivirus or
   indexer holding the target) is retried three times with backoff; on failure the
   `.bridge-new` file is deleted and the original is untouched.

Validation, packing, and verification process data in chunks with `setImmediate` yields
so a large repack does not block the main-process event loop.

`discard()` is best-effort and never throws (it runs in `finally` and must not mask
commit errors): it removes the workspace directory and sibling temp artifacts and
releases the lock.

Crash recovery: `sweepSngTempArtifacts()` runs at app startup and removes
`tempPath/sng-*` entries older than 24 hours. The scanner's directory walk and
`rescanChart` delete stray `*.sng.bridge-new` files, but only when older than one hour;
a fresh one belongs to an in-flight commit's replace step. The suffix does not end in
`.sng`, so the scanner never misclassifies artifacts as charts.

Stream error handling: every write stream in the packer and extractor has an `error`
listener. Without one, a failed write (disk full, I/O error) emits an unhandled `error`
event and crashes the whole process. A mid-file source failure also cancels the active
reader so the file handle closes and the temp directory can be removed.

## Concurrency

| Surface | Handling |
|---|---|
| Two edits of the same chart | per-path lock held from open to discard; the second open fails fast |
| External modification during an edit | size/mtime check at commit |
| Full library scan | replacement is a single atomic rename (a scan sees the old or new file, never a partial or missing one); commits wait for active scans |
| Concurrent `rescanChart` | covered by rename atomicity |
| Issue scan | read-only; covered by rename atomicity and the rename retry |
| Download queue | disjoint by construction: downloads refuse existing destinations at start, and repacks target only existing charts |
| Chart previews | never open local files (they stream from files.enchor.us) |

## Failure modes

| Failure | Behavior |
|---|---|
| Service failed without throwing, or the edit was a no-op | commit skipped or `{ changed: false }`; original untouched; no rescan |
| Edit regresses the chart | commit refused with the specific regression; original untouched |
| Chart already broken before the edit | still editable (differential gate) |
| Packed-archive verify mismatch | commit refused; original untouched |
| Crash during extract, pack, or verify | original untouched; temp swept at startup |
| Crash after copy, before rename | stray `.bridge-new` deleted by the age-guarded sweep |
| Power loss around the rename | fsync before rename; NTFS journals the rename |
| Disk full | preflight refuses up front; a mid-pack failure leaves the original untouched |
| Rename blocked by another process | three retries, then error; original intact |
| App closed with a workspace open | no commit, so no archive change; temp swept at startup |

## Testing

`src-electron/ipc/sng/*.test.ts` (vitest, `npm test`) covers: pack/parse round trips
using `parse-sng` as the oracle, hand-computed header fixtures for 0/1/3-file archives,
masking vectors including the per-file index reset and the 256-byte wraparound,
non-ASCII metadata and filenames (a `String.length` implementation passes ASCII-only
tests and corrupts everything else), `song.ini` fold/unfold including BOM, CRLF,
comments, and default-value lossiness, nested paths and traversal rejection,
filename-length and unsafe-name rejection, the no-change gate, and failure injection
across the replace sequence.

Clone Hero is closed source, so its parser cannot be verified in code. The packer's
output matches the reference encoder and is verified against the two readers with
available source (`parse-sng` and YARG). Loading a repacked chart in Clone Hero itself
remains a manual check.
