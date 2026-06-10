# WP3 spec — inspect-media (D5: INSPECT v2 — cheaper images, richer signal)

Status: implementation-ready. Branch `v2/fable-rework`. Wave 1 (runs parallel to WP1; zero shared files).
Owner files (per DESIGN-BRIEF ownership map): `mcp/lib/inspect.js`, `mcp/lib/tools/inspect-source.js`,
`mcp/lib/segment-signals.js`, `mcp/lib/segment-model.js`, `mcp/lib/silence-detector.js`,
`mcp/lib/clean-cut.js` (exports only), `mcp/lib/asr-backend.js`, `mcp/lib/asr/*`,
`mcp/lib/classification-schema.js`, `mcp/lib/tools/save-classification.js`, `mcp/lib/paths.js`.
New WP3-owned file: `mcp/lib/inspect-digest.js`.

Files this spec deliberately does NOT touch (other WPs own them): `ffmpeg-runner.js`,
`spawn-with-shutdown.js`, `tools/snapshot-keyframes.js` (full-res stills stay — WP4),
`transcript-summary.js` (unowned in v2 — unchanged), `scene-detector.js` (unchanged),
`doctor.js`, `tools/ingest-file.js`, all adapter files.

Hard invariants preserved (verified against current code, cited inline below): manifest additive
merge; heavy work outside the session lock; inspect re-run resets `user_acknowledged:false`;
detection cache at session root survives `clearInspectDir` (inspect.js:94-100); skip-scene runs never
claim scene authority (inspect.js:249-252, 297-341); `buildSegments` stays pure; canonical transcript
shape `[{text,start,end}]` stays valid (new fields are ADDITIVE/optional); all VOB_ASR_* knobs
unchanged; `vob_save_classification` keeps `additionalProperties:true` on the three pool objects
(save-classification.js:157-166 — the recorded bug); ZERO new MCP tools.

On-host verification already performed while writing this spec (ffmpeg 8.1.1, macOS):
- the chained `silencedetect,ebur128,…,astats,ametadata` pass parses correctly (exit 0, both
  silence lines and the ebur128 summary present, energy log file written at exactly 0.5 s windows);
- concat-demuxer + `tile` strip build works on per-segment JPEGs (9 frames → 2048×864 strip, 132 KB);
- `scale=480:-2` thumb: 12.2 KB vs 60.7 KB full-res on a 720p fixture (real 1080×1920 keyframes are
  227 KB → expect ~15–25 KB at 512 w);
- this host's Homebrew ffmpeg has **no `drawtext` filter at all** (`ffmpeg -filters | grep -c
  drawtext` → 0; no fontconfig/freetype in buildconf). Burned-in strip timestamps are therefore
  **rejected**: the design is legend-JSON-only (§3.4).

---

## 1. paths.js — new helpers (WP3 owns ALL paths.js additions for v2)

Add after `segmentCachePath` (paths.js:123-128), following existing patterns
(`assertNonNegativeInt` at paths.js:170-175 for index args, safe-hash guard mirrored from
`segmentCachePath` at paths.js:124-126). Export every one from the `module.exports` block.

```js
// --- WP3: INSPECT v2 artifacts ---------------------------------------------
function inspectTranscriptsDir(projectId) {
  return path.join(inspectDir(projectId), "transcripts");
}
function inspectFileTranscriptPath(projectId, fileIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  return path.join(inspectTranscriptsDir(projectId), `file_${fi}.json`);
}
function inspectDigestPath(projectId) {
  return path.join(inspectDir(projectId), "digest.md");
}
function inspectStripsDir(projectId) {
  return path.join(inspectDir(projectId), "strips");
}
function inspectStripPath(projectId, fileIndex, stripIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  const si = assertNonNegativeInt(stripIndex, "strip_index");
  return path.join(inspectStripsDir(projectId), `file_${fi}_strip_${si}.jpg`);
}
function inspectStripListPath(projectId, fileIndex, stripIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  const si = assertNonNegativeInt(stripIndex, "strip_index");
  return path.join(inspectStripsDir(projectId), `file_${fi}_strip_${si}.ffconcat`);
}
function inspectStripsLegendPath(projectId) {
  return path.join(inspectStripsDir(projectId), "legend.json");
}
function inspectAudioFeaturesDir(projectId) {
  return path.join(inspectDir(projectId), "audio_features");
}
function inspectEnergyLogPath(projectId, fileIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  return path.join(inspectAudioFeaturesDir(projectId), `file_${fi}_rms.log`);
}
function inspectFeaturesStderrLogPath(projectId, fileIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  return path.join(inspectAudioFeaturesDir(projectId), `file_${fi}_detect.stderr.log`);
}
// Transcript cache lives at the SESSION ROOT (sibling of segment_cache/) so it
// survives clearInspectDir — same rationale as segmentCacheDir (paths.js:115-121).
function transcriptCacheDir(projectId) {
  return path.join(sessionDir(projectId), "transcript_cache");
}
function transcriptCachePath(projectId, fileHash) {
  if (typeof fileHash !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileHash)) {
    throw new Error(`transcriptCachePath requires a safe hash string, got ${fileHash}`);
  }
  return path.join(transcriptCacheDir(projectId), `${fileHash}.json`);
}
// --- requested by WP4 (D6: preview stderr tee, parity with render-full) -----
// render-full.js:78-79 builds renders/render-<ts>.log ad hoc; WP4's preview tee
// uses this helper. kind ∈ {"render","preview"}; stamp = caller's timestamp slug.
function renderStderrLogPath(projectId, kind, stamp) {
  if (kind !== "render" && kind !== "preview") {
    throw new Error(`renderStderrLogPath kind must be "render"|"preview", got ${kind}`);
  }
  if (typeof stamp !== "string" || !/^[A-Za-z0-9._-]+$/.test(stamp)) {
    throw new Error(`renderStderrLogPath requires a safe stamp, got ${stamp}`);
  }
  return path.join(rendersDir(projectId), `${kind}-${stamp}.log`);
}
```

Path-helper requests from other packages — audited against the brief, resolution:

| Requestor | Need | Resolution |
|---|---|---|
| WP4 D6 preview log tee | `renders/preview-<ts>.log` | `renderStderrLogPath` above. WP4 may also migrate render-full's ad-hoc join; optional. |
| WP4 D7 font kit | `compose/fonts/`, `compose/fonts.css` | **No paths.js change.** Verified: compose subpaths are ad-hoc joins by convention (`source-symlink.js:125` does `path.join(composeRoot, SOURCE_SUBDIR)`; render tools do `path.join(composeRoot, "index.html")`). WP4 adds a `FONTS_SUBDIR` const in its own files. Repo asset dir `mcp/assets/fonts/` is not a session path — out of paths.js scope. |
| WP2 D4 clean-speech straddle warning | `inspect/clean_speech.json` | Already exists: `inspectCleanSpeechPath` (paths.js:62-64, exported). No addition. |
| WP1 D1 lean returns | none | No path needs. |
| WP6 walker | none | Consumes tool returns only. |
| WP3 itself | transcripts, digest, strips, legend, audio-features logs, transcript cache | Added above. |

Back-compat: pure additions; no existing helper changes name, signature, or output.

---

## 2. Image diet — exact ffmpeg argv changes

### 2.1 Thumbnails (inspect.js:102-138, `extractThumbnailsForFile`)

Current argv (inspect.js:108-115):
`["-y", ...inputAutorotateArgs(), "-i", sourcePath, "-vf", `fps=1/${intervalSeconds}`, "-q:v", "3", pattern]`

New argv — change exactly two tokens:

```js
"-vf", `fps=1/${intervalSeconds},scale=480:-2`,
"-q:v", "4",
```

- `scale=480:-2`: width 480, height preserves aspect rounded to even (locked by brief D5).
  Portrait sources become 480×~854; landscape 480×270.
- `-q:v 4` (was 3): thumbs are orientation/triage frames, not classification evidence; q4 at 480 w
  is visually clean and ~20 % smaller than q3.
- `inputAutorotateArgs()` placement unchanged (input side, before `-i` — the
  VOB_DISABLE_AUTOROTATE invariant, ffmpeg-runner.js:76-82).

Timeout fix (same function): replace the fixed `THUMB_TIMEOUT_MS` at inspect.js:116 with a
duration-aware value. `extractThumbnailsForFile` gains a `durationSeconds` param (caller at
inspect.js:398-403 passes `Number(manifest.files[i].duration_seconds) || null`):

```js
const timeoutMs = durationAwareTimeout({
  baseMs: THUMB_TIMEOUT_MS,            // 120s floor, unchanged const
  durationSeconds,
  perSecondMs: 500,                    // same rate as scene detect (whole-stream decode)
  ceilingMs: SCENE_DETECT_CEILING_MS,  // 60 min
  envVar: "VOB_THUMB_TIMEOUT_MS",      // NEW env override, additive
});
```

> **Superseded in implementation (post-live-run fix):** the single `fps=1/N` pass still decoded
> the whole stream, which timed out on an 18-min/35Mbps HEVC source regardless of this timeout.
> `extractThumbnailsForFile` is now seek-based — one input-side `-ss` single-frame extract per
> grid slot (O(thumb count), grid capped at 400/file), failed slots filled with stand-in
> neighbor copies (grid-true `frame_%04d` numbering preserved), and the whole pass is non-fatal
> (degrades to `warnings[]`). `VOB_THUMB_TIMEOUT_MS` survives as the pass's **soft deadline**
> (skips remaining seeks instead of throwing); `VOB_THUMB_SEEK_TIMEOUT_MS` bounds each seek
> (default 60s).

Contact sheet (inspect.js:140-172): **two changes** (the orchestrator's mandatory grounding must
stay readable after the vision pipeline's ~1.15 MP downscale — a single 600-cell tile collapses
to ~50 px smears on a 30-min source, which would make spine rule 12's grounding nominal):

1. **Chunked sheets, ≤40 cells each** (`CONTACT_SHEET_MAX_CELLS = 40`, 5 cols × ≤8 rows).
   `buildContactSheet` splits a file's thumbs into chunks of ≤40 in frame order; a single chunk
   keeps today's name `contact_sheet_file_<i>.jpg` (back-compat), multiple chunks write
   `contact_sheet_file_<i>_<k>.jpg` (k 0-based). ALL sheet paths ride in the existing
   `contact_sheet_paths` array — already an array of one-per-file, so NO shape change for any
   consumer; the array just grows. Same `scale=320:-1,tile=<cols>x<rows>` filter and 120 s
   timeout per chunk (input is small JPEGs).
2. **Duration-scaled default thumb interval.** When the caller does not pass
   `thumb_interval_seconds`, the default becomes
   `Math.max(DEFAULT_THUMB_INTERVAL_SECONDS, Math.ceil((durationSeconds || 0) / 120))`
   (i.e. 3 s floor, capping thumbs at ~120/file → ≤3 sheets/file; a 30-min source gets a 15 s
   interval). An EXPLICIT `thumb_interval_seconds` arg is honored verbatim, as today. The chosen
   interval is already recorded in `thumb_interval_seconds` (summary + state) — consumers see
   what was used.

Expected deltas (per frame): 1080p `-q:v 3` full-res ≈ 120–300 KB → 480 w `-q:v 4` ≈ 10–25 KB
(~10×); 4K ≈ 25–30×. Fixture measured: 60.7 KB → 12.2 KB at 720p. Orchestrator image-token cost for
a 7-thumb sample: ~8–11 k → ~1.2–1.6 k (Claude vision ≈ w·h/750: 480×270 ≈ 173 t, 480×854 ≈ 547 t).

### 2.2 Segment keyframes (segment-signals.js:99-101, `extractSegmentKeyframes`)

Current argv (segment-signals.js:101):
`["-y", ...inputAutorotateArgs(), "-ss", String(midpoint(seg)), "-i", sourcePath, "-frames:v", "1", "-q:v", "3", outPath]`

New argv — insert one `-vf` pair after `-frames:v 1`:

```js
["-y", ...inputAutorotateArgs(), "-ss", String(midpoint(seg)), "-i", sourcePath,
 "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "3", outPath]
```

- `scale=512:-2` locked by brief. `-q:v 3` stays (these are the inspector's classification
  evidence; keep quality headroom).
- Everything else (midpoint seek, silence/audio-only → `keyframe_path:null`, `maxKeyframes` cap
  with explicit truncation counts at segment-signals.js:85-112) unchanged.

Expected deltas: real-session 1080×1920 keyframes are 227 KB → 512×910 ≈ 15–25 KB. Single-frame
Read: ~1,590 → ~620 image tokens (≈2.5×); via strips (§3) ≈ 205 t/frame (≈7.7×).

`DEFAULT_MAX_KEYFRAMES = 80` unchanged. Serial extraction loop unchanged (bounded-pool
parallelism deliberately out of scope — see open issues).

---

## 3. Contact strips for segment keyframes (new)

### 3.1 Builder — `buildSegmentStrips` in segment-signals.js (new export)

```js
/**
 * Tile a file's per-segment keyframes into contact strips (≤ STRIP_MAX_CELLS
 * cells each, STRIP_COLS columns, row-major). Zero-dep: concat demuxer + tile
 * filter. Returns legend entries; never throws on build failure (fallback =
 * inspector reads downscaled singles).
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {number} args.fileIndex
 * @param {Array}  args.segments   enriched segments (post-extractSegmentKeyframes;
 *                                 entries with keyframe_path:null are skipped)
 * @returns {Promise<{strips: StripLegendEntry[], failed: number}>}
 */
async function buildSegmentStrips({ projectId, fileIndex, segments })
```

Constants (top of segment-signals.js):

```js
const STRIP_COLS_LANDSCAPE = 4;
const STRIP_COLS_PORTRAIT = 3;       // portrait cells are tall: 3 cols keeps each cell ≥~300px
                                     // wide after the vision pipeline's ~1.15MP downscale
const STRIP_MAX_CELLS_LANDSCAPE = 12; // brief D5: ≤ ~12 cells per strip
const STRIP_MAX_CELLS_PORTRAIT = 9;   // 3×3 for portrait (within the brief's "≤ ~12")
const STRIP_MIN_CELLS = 2;           // <2 keyframes → no strip (read the single)
const STRIP_TIMEOUT_MS = 60 * 1000;  // per strip; input is ≤12 small JPEGs
```

Orientation pick: probe the FIRST cell's keyframe dimensions (the manifest file's
`resolution`/`rotation` is already in scope at the call site — or `ffprobe` the first jpg);
`portrait = height > width`. One orientation per file (cells from the same file share it).

Algorithm:
1. `cells = segments.filter(s => typeof s.keyframe_path === "string")`, in segment-index order.
   If `cells.length < STRIP_MIN_CELLS` → return `{ strips: [], failed: 0 }`.
2. Chunk into groups of ≤ `STRIP_MAX_CELLS_*` for the file's orientation (12 landscape / 9
   portrait). For chunk `k`:
   a. Write list file `inspectStripListPath(projectId, fileIndex, k)` (plain `fs.writeFileSync`;
      it is a derived temp artifact under inspect/, wiped each run):
      ```
      ffconcat version 1.0
      file '<abs keyframe_path>'      ← one line per cell, single-quoted,
      ...                                embedded ' escaped as '\''
      ```
   b. `const stripCols = portrait ? STRIP_COLS_PORTRAIT : STRIP_COLS_LANDSCAPE;`
      `rows = Math.ceil(chunk.length / stripCols)`; `cols = Math.min(stripCols, chunk.length)`.
   c. Run (via `runFfmpegBlocking`, `{ timeoutMs: STRIP_TIMEOUT_MS }`):
      ```js
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
       "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "3", stripPath]
      ```
      No rescale needed — keyframes are already 512 w from §2.2; same file ⇒ same cell size.
      (`tile` pads a partial last row with black; the legend marks valid cells.)
   d. On `timed_out || exit_code !== 0 || !fs.existsSync(stripPath)`: increment `failed`, skip the
      chunk (do NOT throw), continue with remaining chunks.
3. Legend entry per successful strip:

```js
// StripLegendEntry
{
  file_index: number,
  strip_index: number,            // 0-based
  path: string,                   // abs strip jpg
  cols: number, rows: number,
  cell_count: number,             // valid cells (rest of grid is black padding)
  cells: [{
    cell: number,                 // 0-based, row-major reading order
    row: number, col: number,     // 0-based
    segment_index: number,
    timestamp_seconds: number,    // the midpoint frame's source time, 3 decimals
    start_seconds: number,        // segment window, 3 decimals
    end_seconds: number,
  }]
}
```

### 3.2 Wiring (inspect.js)

In `segmentSourceFiles` (inspect.js:274-372), after `extractSegmentKeyframes` (line 351):

```js
const strips = hasVideo
  ? await buildSegmentStrips({ projectId, fileIndex: i, segments })
  : { strips: [], failed: 0 };
```

Accumulate `allStripEntries.push(...strips.strips)` and `stripFailures += strips.failed` at the
function level; add both to the function's return object (`{ fileSummaries, totalSegments,
totalKeyframes, truncatedKeyframes, stripEntries, stripFailures }`).

`runInspect` then writes the single legend (only when `stripEntries.length > 0`):

```js
// inspect/strips/legend.json
{
  "schema_version": "1.0",
  "project_id": "<id>",
  "generated_at": "<iso>",
  "cell_width": 512,
  "strip_count": <n>,
  "strips": [ ...StripLegendEntry, ordered by (file_index, strip_index) ]
}
```

`mkdirSync(inspectStripsDir(id), { recursive: true })` before the first strip build (do it inside
`buildSegmentStrips`, like extractSegmentKeyframes does for its dir at segment-signals.js:82-83).

### 3.3 Failure fallback (normative)

A strip failure is NEVER fatal and never blocks INSPECT: segments keep their `keyframe_path`
singles (now 512 w), `legend.json` simply lacks that strip, and `strip_count` reflects reality. The
inspector contract (WP5 hand-off, §10) is: "read strips when present; for any segment not covered
by a strip, Read its keyframe_path directly." `inspect.json` records `strip_failures` (int) so the
orchestrator can mention degraded mode.

### 3.4 Burned-in timestamps — DECIDED: NO (legend-JSON-only)

`drawtext` requires libfreetype and, without an explicit `fontfile=`, fontconfig. Evidence: the
reference host's Homebrew ffmpeg 8.1.1 ships **without** the filter entirely (`-filters` lists no
drawtext; buildconf has no freetype/fontconfig). A fontfile fallback would need a vendored TTF —
D7's kit vendors woff2 (not loadable by drawtext) and lives in WP4's package. Therefore: cell→
timestamp mapping lives ONLY in `legend.json`; the agent prompt (WP5) instructs reading the legend
alongside each strip. No drawtext anywhere in WP3.

### 3.5 Per-clip-window bracketing strips — DECIDED: OMITTED in v2

Brief D5 marks them OPTIONAL. Clip windows exist only after `vob_save_storyboard` (PLAN), where
generating media would require either a new tool (banned) or a heavy side effect inside WP2's
save tool (crosses ownership; save must stay fast for the 3×-retry loop). Fallback per brief: the
storyboarder Reads downscaled singles/thumbs — already ~5× cheaper after §2. Documented here so
WP5 writes the storyboarder grounding procedure against thumbs + per-file strips.

---

## 4. Audio features — chained into the existing per-file silencedetect pass

### 4.1 silence-detector.js — `detectSilences` gains a `features` option

New signature (additive; all existing call sites remain valid):

```js
async function detectSilences(filePath, {
  noiseDb = -30,
  minSilenceSeconds = 0.5,
  durationSeconds = null,
  timeoutMs = FFMPEG_TIMEOUT_MS,
  features = null,   // NEW: { energyLogPath: string, stderrLogPath: string } | null
} = {})
```

When `features` is null (default, and always for the clean-speech −40 dB pass at inspect.js:523):
behavior is byte-for-byte today's.

When `features` is set AND `process.env.VOB_DISABLE_AUDIO_FEATURES` is not truthy
(`1|on|true|yes`, same parse as `inputAutorotateArgs`, ffmpeg-runner.js:77-79):

```js
const filter =
  `silencedetect=noise=${noiseDb}dB:d=${minSilenceSeconds}`
  + `,ebur128=peak=true`
  + `,aformat=channel_layouts=mono,aresample=8000,asetnsamples=n=4000`
  + `,astats=metadata=1:reset=1`
  + `,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${escapeFilterPath(features.energyLogPath)}`;
```

- Verified working end-to-end on ffmpeg 8.1.1 (see preamble). One decode pass; the chain adds
  <15 % CPU to an audio-only decode (fixture: 30 s stereo AAC, full chain at 108× realtime).
- `asetnsamples=n=4000` after `aresample=8000` ⇒ exact **0.5 s** windows; `pts_time` in the energy
  log is the window START in seconds.
- `escapeFilterPath(p)` (new local helper, exported for tests): ffmpeg filter-option escaping —
  `p.replace(/\\/g, "\\\\").replace(/'/g, "\\\\'").replace(/:/g, "\\:")` then wrap in `'…'`.
  (Project ids can't contain `/`/`..` (paths.js:7-16) but a homedir may contain spaces — quoted
  form handles it; colon escaping covers exotic prefixes.)
- Pass `stderrLogPath: features.stderrLogPath` through to `runFfmpegBlocking` (ffmpeg-runner.js:84
  already forwards it; spawn-with-shutdown.js:163-166 tees the FULL stream to the file, uncapped —
  verified). **Parse the log FILE, not `result.stderr`**: ebur128 prints a ~150-byte momentary line
  at 10 Hz (≈1.7 KB/s measured), which overflows the 4 MB in-memory cap at ~40 min and would
  truncate late silencedetect lines. Read the file with `fs.readFileSync(path, "utf8")` inside a
  try/catch; fall back to `result.stderr` if the read fails.

Parsing (all on the teed stderr text):
- Silences: existing `parseSilenceLog` unchanged.
- Loudness — take the LAST match of each (momentary lines carry running values; the summary block
  is last, so last-match = summary when present, best-effort running value when truncated):
  ```js
  const LUFS_RE = /I:\s*(-?[0-9.]+|nan)\s*LUFS/g;        // "I:         -21.9 LUFS"
  const LRA_RE  = /LRA:\s*(-?[0-9.]+|nan)\s*LU(?![A-Z])/g; // "LRA:         7.0 LU"
  const TPK_RE  = /(?:^|\s)Peak:\s*(-?[0-9.]+|nan)\s*dBFS/gm; // summary-only "Peak:" line
  ```
  `nan` / no match → `null` for that field.
- Energy windows — parse `features.energyLogPath` (verified format):
  ```
  frame:0    pts:0       pts_time:0
  lavfi.astats.Overall.RMS_level=-21.068451
  ```
  Pair each `pts_time:(\S+)` with the following `RMS_level=(\S+)`. `-inf`/non-finite → `-99`.
  Emit `{ t: <window start s>, rms_db: <1-decimal> }`.

New return field (only when features were requested; absent key otherwise — back-compat):

```js
{
  ok, silences, noiseDb, minSilenceSeconds, note?,
  features: {
    loudness: { lufs_integrated: number|null, lra_lu: number|null, true_peak_dbtp: number|null },
    energy_windows: [{ t: number, rms_db: number }],
    window_seconds: 0.5,
  } | null   // null = chain ran but produced nothing parseable
}
```

Graceful-degradation retry (normative): if the features-enabled run yields `ok:false` AND
`parsed.silences.length === 0` AND stderr matches
`/No such filter|Error reinitializing filters|Error initializing filter/i`
(exotic build missing ebur128/astats), re-run ONCE with the plain silencedetect filter (today's
argv) and return its result with `features: null`. This guarantees the v1 silence contract can
never regress on a weird ffmpeg build.

### 4.2 segment-signals.js — pure attach helpers

```js
// Per-segment energy aggregates from 0.5s RMS windows. Pure. A window covers
// [t, t+windowSeconds); it belongs to a segment when its midpoint falls inside
// [start_seconds, end_seconds). Segments with zero windows get nulls.
function attachAudioFeatures(segments, energyWindows, windowSeconds = 0.5) {
  // returns segments.map(seg => ({ ...seg,
  //   energy_rms_db:  <mean of window rms_db, 1 decimal> | null,
  //   energy_peak_db: <max  of window rms_db, 1 decimal> | null }))
}
```

Extend `attachTranscriptOverlap` (segment-signals.js:33-49) — add one derived field to its
returned objects:

```js
speech_rate_wpm: hits.length > 0 && seg.duration_seconds > 0
  ? Math.round((hits.length / seg.duration_seconds) * 60 * 10) / 10
  : null,
```

Units: words-per-minute over the whole segment window (dead air inside the segment lowers it —
that is the signal: a low-wpm "speech" segment is padded delivery). Export `attachAudioFeatures`.

### 4.3 inspect.js — wiring + detection-cache extension

Constants: keep `SEGMENT_SCHEMA_VERSION = "1.0"` for the CACHE check (renaming/bumping it would
invalidate every existing cache and force re-running the expensive scene decode — forbidden). Add:

```js
const SEGMENTS_DOC_VERSION = "1.1";   // stamped into segments.json (additive fields)
const FEATURES_VERSION = 1;           // audio_features cache slot version
```

`segmentSourceFiles` loop changes (current logic at inspect.js:302-342):

```js
let audioFeatures = null;
const cachedHasFeatures = cached && cached.audio_features
  && cached.audio_features.features_version === FEATURES_VERSION;
if (hasAudio && (!cached || !cachedHasFeatures)) {
  fs.mkdirSync(inspectAudioFeaturesDir(projectId), { recursive: true });
  const sd = await detectSilences(file.path, {
    noiseDb: SILENCE_NOISE_DB, minSilenceSeconds: SILENCE_MIN_SECONDS,
    durationSeconds: duration, timeoutMs: silenceTimeoutMs,
    features: {
      energyLogPath: inspectEnergyLogPath(projectId, i),
      stderrLogPath: inspectFeaturesStderrLogPath(projectId, i),
    },
  });
  silences = sd.ok ? sd.silences : (cached ? cached.silences : []);
  audioFeatures = sd.features || null;
} else if (cached) {
  silences = cached.silences;
  audioFeatures = cachedHasFeatures ? cached.audio_features : null;
}
```

(Note the behavior change: a v1 cache hit that lacks features re-runs the AUDIO pass — cheap,
~real-time÷100 — while still honoring cached `scene_detected` authority. Scene decode is never
re-run because of features.)

Cache write condition (replaces inspect.js:340-342):
`if (!cached || (sceneDetected && !cached.scene_detected) || (audioFeatures && !cachedHasFeatures))`.
`writeDetectionCache` gains an `audioFeatures` arg and writes, additively:

```js
audio_features: audioFeatures
  ? { features_version: 1, window_seconds: 0.5,
      loudness: audioFeatures.loudness, energy_windows: audioFeatures.energy_windows }
  : null,
```

`readDetectionCache` passes `doc.audio_features` through untouched (validation is the
`features_version` check at the call site). The three-param equality check (inspect.js:243-247)
is unchanged — old caches stay valid for silences/scenes.

Segment enrichment order (replaces inspect.js:344-352):

```js
let segments = buildSegments({ ... });                                  // unchanged
segments = attachTranscriptOverlap(segments, transcriptsByFile.get(i) || null);  // §6.3
segments = attachAudioFeatures(segments, audioFeatures ? audioFeatures.energy_windows : null);
const kf = await extractSegmentKeyframes({ ... });                      // unchanged
const strips = ...;                                                     // §3.2
```

Per-file summary additions (inspect.js:357-368 object):

```js
loudness: audioFeatures ? audioFeatures.loudness : null,
energy_window_seconds: audioFeatures ? 0.5 : null,
transcript_path: <per-file transcript abs path or null>,    // §6
transcript_word_count: <int>,                               // §6
```

Energy windows are deliberately NOT written into segments.json (5,280 windows on a 44-min source
≈ 100 KB+ of pretty JSON read whole by the inspector). They live in the detection cache and are
passed in-memory to hook ranking (§7). `segmentSourceFiles` returns them:
`featuresByFile: Map<fileIndex, {loudness, energy_windows, window_seconds}>`.

### 4.4 segments.json — exact new per-segment fields

| field | type | units | producer | null when |
|---|---|---|---|---|
| `energy_rms_db` | number\|null | dBFS, mean of overlapped 0.5 s windows, 1 dp | attachAudioFeatures | no audio / features unavailable |
| `energy_peak_db` | number\|null | dBFS, max window, 1 dp | attachAudioFeatures | same |
| `speech_rate_wpm` | number\|null | words/min over segment window, 1 dp | attachTranscriptOverlap | no transcript overlap |

Per-file entries gain `loudness: {lufs_integrated, lra_lu, true_peak_dbtp} | null`,
`energy_window_seconds: 0.5|null`, `transcript_path`, `transcript_word_count`.
Top-level `schema_version` becomes `"1.1"` (`SEGMENTS_DOC_VERSION`). No consumer checks it
(save-classification.js reads `files[]` only) — purely informative.

### 4.5 Cost on a 30-min source (analysis, normative budget)

The −30 dB silencedetect pass already decodes the full audio stream. Measured chain overhead on
the fixture: ≤15 % of an audio-only decode that runs >100× realtime ⇒ a 30-min source's audio pass
stays well under ~60 s wall on the M1 reference host. New disk: energy log ≈ 410 KB
(3,600 windows × 2 lines), stderr tee ≈ 3.1 MB (both under `inspect/audio_features/`, wiped each
run; the durable copy in segment_cache is the parsed windows ≈ 70 KB compact). Zero additional
decode passes; the clean-speech −40 dB pass and scene detection are untouched.

---

## 5. clean_speech wiring (state + return; consumption is WP2/WP5)

`runInspect` already computes `inspect/clean_speech.json` (inspect.js:508-541) and records it ONLY
in inspect.json (inspect.js:587). Changes:

1. `runInspect` keeps a parsed handle: after writing, retain `cleanSpeechDoc = { keep_spans,
   removed, stats }` in scope for the digest (§7). Also capture `cleanStats = clean.stats`.
2. Summary (inspect.json) — already has `clean_speech_path`; ADD `clean_speech_stats:
   clean.stats | null` (the exact `stats` object from clean-cut.js:186-198).
3. `tools/inspect-source.js`: state slot + return additions in §8.

clean-cut.js — **exports only** (per ownership): add ONE convenience export for WP2's D4 straddle
warning; no behavioral change to existing functions:

```js
// Removed (non-kept) time inside [start,end], from a keep_spans list.
// For WP2 plan lint: an a_roll clip straddles a removed span when seconds > threshold.
function removedWithin(keepSpans, start, end) {
  if (!Array.isArray(keepSpans) || !isNum(start) || !isNum(end) || end <= start) {
    return { intervals: [], seconds: 0 };
  }
  const intervals = subtractIntervals([{ start, end }], keepSpans);
  const seconds = +intervals.reduce((a, i) => a + (i.end - i.start), 0).toFixed(3);
  return { intervals, seconds };
}
```

Add `removedWithin` to module.exports (clean-cut.js:229).

---

## 6. ASR: word confidence, transcript cache, per-file transcripts

### 6.1 Word confidence in the drivers (mcp/lib/asr/*)

Canonical transcript entry becomes `{text, start, end, p?}` — `p` OPTIONAL, float in [0,1],
3 decimals, word-level ASR confidence. Verified safe: every consumer filters/maps on
`text/start/end` only (clean-cut.js:88-89, segment-signals.js:19-28, transcript-summary.js:17-21);
unknown keys pass through untouched.

`faster_whisper_transcribe.py` — in the word loop (lines 65-69), after `"end"`:

```python
p = getattr(w, "probability", None)
if isinstance(p, (int, float)):
    entry["p"] = round(float(p), 3)
```

(Restructure the dict-literal append into `entry = {...}; ...; words.append(entry)`. The
segment-level fallback branch (lines 70-77) emits NO `p`.)

`openai_whisper_transcribe.py` — same, lines 48-56:

```python
p = w.get("probability")
if isinstance(p, (int, float)):
    entry["p"] = round(float(p), 3)
```

hyperframes backend: emits no `p` (opaque); field stays absent — consumers must treat missing `p`
as "confidence unknown", never as 0.

### 6.2 asr-backend.js — params export (cache key source; knobs unchanged)

Add and export:

```js
// The resolved ASR configuration that determines transcript CONTENT — used as
// the transcript-cache key. Knob semantics unchanged (VOB_ASR_BACKEND/MODEL/LANGUAGE).
function resolvedAsrParams() {
  return {
    backend: configuredBackend(),               // "auto" | name | "none"
    model: configuredModel(null),               // e.g. "small.en"
    language: configuredLanguage(null) || "auto",
  };
}
```

No other asr-backend.js change. Note (documented behavior): with `backend:"auto"`, a host that
switches engines between runs reuses the cache — acceptable because every backend writes the same
canonical contract.

### 6.3 inspect.js — per-file transcripts + content-hash cache + multi-file overlap fix

Replaces the transcription block at inspect.js:415-481 and the `transcribedFileIndex` gate at
inspect.js:350.

Local cache helpers (mirror `readDetectionCache`/`writeDetectionCache`, inspect.js:234-269):

```js
const TRANSCRIPT_CACHE_VERSION = "1.0";
function readTranscriptCache(projectId, hash, params)
  // null unless: file exists, JSON parses, doc.schema_version === "1.0",
  // doc.params.{backend,model,language} all === params.*, Array.isArray(doc.words).
  // → { words, word_count: doc.word_count|words.length, backend_used: doc.backend_used|null }
function writeTranscriptCache(projectId, hash, params, words, backendUsed)
  // mkdir transcriptCacheDir; writeFileAtomic(transcriptCachePath(projectId, hash),
  //   JSON.stringify({ schema_version:"1.0", file_hash:hash, params,
  //     backend_used:backendUsed, word_count:words.length, words, created_at:nowIso() }) + "\n")
  // words stored COMPACT (no indent) — a 6k-word transcript ≈ 350 KB.
```

Invalidation: keyed by manifest `file.hash` (content sha256, ingest-file.js:136) — a changed file
gets a new key; params mismatch (model/language/backend) → miss; `VOB_ASR_BACKEND=none` → the
order is empty so no transcription and no cache writes; cache stores SUCCESSES only.

New transcription flow (full replacement of the `else` branch at inspect.js:447-481):

```js
audioPresent = true;
const asrParams = resolvedAsrParams();
fs.mkdirSync(inspectTranscriptsDir(projectId), { recursive: true });
const tmpRoot = path.join(inspectRootAbs, ".transcribe-tmp");
const perFile = new Map();   // idx -> { ok, path, words, word_count, backend, from_cache,
                             //          reason, attempts, wav }
for (const idx of audioFileIndices) {
  const file = manifest.files[idx];
  const outPath = inspectFileTranscriptPath(projectId, idx);
  const cached = readTranscriptCache(projectId, file.hash, asrParams);
  if (cached) {
    writeFileAtomic(outPath, `${JSON.stringify(cached.words)}\n`);
    perFile.set(idx, { ok: true, path: outPath, words: cached.words,
      word_count: cached.word_count, backend: cached.backend_used,
      from_cache: true, reason: null, attempts: null, wav: null });
    continue;
  }
  const tmpDir = path.join(tmpRoot, `file_${idx}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpWav = path.join(tmpDir, "audio.wav");
  const fileDuration = Number(file.duration_seconds);
  await extractAudio({ sourcePath: file.path, outPath: tmpWav, durationSeconds: fileDuration });
  const tr = await transcribeAudio({ audioPath: tmpWav, inspectDirAbs: tmpDir,
    expectedTranscriptPath: outPath, durationSeconds: fileDuration });
  let words = null;
  if (tr.ok) {
    try { const w = readJsonFile(outPath); if (Array.isArray(w)) words = w; } catch { words = null; }
    if (words) writeTranscriptCache(projectId, file.hash, asrParams, words, tr.backend);
  }
  perFile.set(idx, { ok: tr.ok && !!words, path: tr.ok && words ? outPath : null, words,
    word_count: words ? words.length : 0, backend: tr.backend || null,
    from_cache: false, reason: tr.ok ? null : (tr.reason || "transcription_failed"),
    attempts: tr.attempts || null, wav: tmpWav });
}
// Winner: most-worded, FIRST on ties (preserves inspect.js:460 `wc > best.wordCount` semantics).
let winnerIdx = audioFileIndices[0];
for (const idx of audioFileIndices) {
  if ((perFile.get(idx).word_count || 0) > (perFile.get(winnerIdx).word_count || 0)) winnerIdx = idx;
}
transcribedFileIndex = winnerIdx;
const win = perFile.get(winnerIdx);
asrBackend = win.backend; asrAttempts = win.attempts;
// audio.wav: copy the winner's temp wav, or (cache hit ⇒ no wav) extract it now.
if (win.wav && fs.existsSync(win.wav)) {
  try { fs.copyFileSync(win.wav, audioAbs); audioPathOut = audioAbs; } catch { audioPathOut = null; }
} else {
  try {
    await extractAudio({ sourcePath: manifest.files[winnerIdx].path, outPath: audioAbs,
      durationSeconds: Number(manifest.files[winnerIdx].duration_seconds) });
    audioPathOut = audioAbs;
  } catch { audioPathOut = null; }
}
if (win.ok) {
  fs.copyFileSync(win.path, transcriptAbs);   // canonical inspect/transcript.json (back-compat)
  transcriptPathOut = transcriptAbs;
  wordCount = win.word_count;
  speechDetected = wordCount > 0;
} else {
  skippedReason = win.reason || "transcription_failed";
}
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
```

(Per-file transcripts are no longer deleted — the inspect.js:480 `rm -rf` now removes ONLY temp
wavs.) Wrap the per-file `extractAudio`/`transcribeAudio` pair in try/catch so one corrupt file
records `{ ok:false, reason }` instead of killing the whole INSPECT run for the other files —
this is a deliberate hardening over today's throw-through behavior; the winner selection then
operates on whatever succeeded, and if ALL fail the existing `skippedReason` path reports it.

**Hard-gate fix (inspect.js:350):** `segmentSourceFiles` signature changes —
`{ projectId, manifest, transcriptsByFile, skipSceneDetection }` where `transcriptsByFile:
Map<int, Array<word>>` is built from `perFile` (`idx → words` for `ok` entries; empty Map when
transcription was skipped/failed). Line 350 becomes:

```js
segments = attachTranscriptOverlap(segments, transcriptsByFile.get(i) || null);
```

Every speech-bearing file now gets real `transcript_text/word_count/has_speech/speech_rate_wpm` on
its segments. `transcribedFileIndex` (winner) is still threaded to runInspect for the clean-speech
pass and summary fields — unchanged semantics there.

`skip_transcription` path (inspect.js:437-446): UNCHANGED (first audio file's wav extracted,
`user_opt_out`, no per-file transcripts, `transcriptsByFile` empty).

Summary (inspect.json) gains:

```js
transcripts: audioFileIndices.map((idx) => ({
  file_index: idx,
  path: perFile.get(idx).path,          // null on failure
  word_count: perFile.get(idx).word_count,
  backend: perFile.get(idx).backend,
  from_cache: perFile.get(idx).from_cache === true,
})),                                     // [] when skipped/no audio
transcript_cache_hits: <count of from_cache entries>,
```

---

## 7. Hook candidates + digest — new module `mcp/lib/inspect-digest.js`

Pure module (no I/O, no requires beyond nothing — keep it dependency-free) exporting
`rankHookCandidates` and `buildInspectDigest`. inspect.js calls both at the end of `runInspect`
(after segmentation; before writing inspect.json) and writes `inspect/digest.md` via
`writeFileAtomic(inspectDigestPath(projectId), markdown)`.

### 7.1 `rankHookCandidates({ words, paragraphs, energyWindows, durationSeconds })`

Inputs: winner-file canonical words (`[{text,start,end,p?}]` or null), paragraphs
(`[{n,start,end,text}]` from buildTranscriptSummary, or `[]`), the winner file's energy windows
(or null), source duration (number|null). Returns `[]` when `words` is null/empty.

Step 1 — sentence assembly: walk words in start order, accumulating; flush a sentence when the
current word's text matches `/[.?!]["')\]]*$/`, OR the gap to the next word `> 1.0` s, OR the
sentence reaches 30 words. Sentence record: `{ text, start, end, word_count }` (text =
space-joined, whitespace-collapsed). Discard sentences with `word_count < 3`.

Step 2 — energy stats (skip the energy term entirely when windows are null/empty): file mean μ and
population std σ over all `rms_db`; per-sentence mean over windows whose midpoint `t + 0.25` lies
in `[start, end)`; `z = σ > 0 ? (sentenceMean − μ) / σ : 0`.

Step 3 — score (sum; weights are normative):

| signal code | test (on sentence text unless noted) | weight |
|---|---|---|
| `question` | ends with `?` OR first word matches `/^(who|what|when|where|why|how|did|do|does|is|are|can|could|would|should|have|has|will)$/i` | +2.0 |
| `number` | `/\d/` OR `/\b(hundred|thousand|million|billion|percent|half|double|triple|times)\b/i` | +1.0 |
| `claim` | distinct matches of `/\b(never|always|nobody|no one|everyone|every|biggest|worst|best|only|secret|mistake|wrong|stop|truth|insane|crazy|free|hate|love|guarantee|warning|problem|nothing|impossible)\b/gi` | +1.0 each, cap +2.0 |
| `second_person` | `/\byou(r|rs)?\b/i` | +0.5 |
| `paragraph_start` | `start ≤ p.start + 0.75` for some paragraph p | +0.75 |
| `early` | `durationSeconds` finite AND `start ≤ 0.2 × durationSeconds` | +0.5 |
| `energy_high` | `z ≥ 1.0` | +1.0 |
| `energy_above_avg` | `0 ≤ z < 1.0` | +0.5 |
| `short_penalty` | `word_count < 5` | −1.0 |
| `long_penalty` | `word_count > 25` | −0.5 |
| `greeting_penalty` | `/^(hi|hey|hello|welcome|what's up|good (morning|afternoon|evening)|today (i|we)|in this video|so today|my name is|i('m| am) (going to|gonna))/i` | −3.0 |

Step 4 — emit: sort score desc (ties: earlier start first); keep entries with `score ≥ 1.0`;
return at most **5**:

```js
{
  rank: 1..5,
  score: <2 decimals>,
  start_seconds: <3 dp>, end_seconds: <3 dp>,
  paragraph: <n | null>,             // paragraph containing start, if any
  text: <≤200 chars, hard-truncated with "…">,
  signals: ["question","energy_high", ...]   // triggered codes, penalties included
}
```

### 7.2 `buildInspectDigest(input)` → markdown string

```js
buildInspectDigest({
  projectId, generatedAt,                       // strings
  manifestFiles,                                // manifest.files (path/duration/prior/resolution/fps)
  fileSummaries,                                // segmentSourceFiles output (incl. loudness)
  transcripts,                                  // §6.3 summary array
  paragraphs,                                   // [{n,start,end,text}] | []
  cleanSpeechStats,                             // clean-cut stats | null
  hookCandidates,                               // §7.1 output
  strips: { stripCount, legendPath, failures }, // legend info
  lowConfidenceWords,                           // see below
  asr: { backend, skippedReason },              // winner backend | skip reason
  sceneDetectionSkipped,                        // bool
})
```

`lowConfidenceWords` (computed in inspect.js from the winner words): distinct `text` values, with
`p` present and `p < 0.55`, `length ≥ 3` chars after stripping punctuation, first-seen order, max
15, each `{ text, at_seconds }`. Empty array when no `p` data.

Full digest.md template (sections in this exact order; omit a section's body line-items when its
input is null/empty, but keep the heading with a one-line "n/a — <reason>" note so consumers can
rely on section presence):

```markdown
# INSPECT digest — <projectId>

*Generated <generatedAt>. Machine-readable: inspect.json · segments.json ·
strips/legend.json · transcripts/ · clean_speech.json.*

## Files
| # | file | duration | res@fps | prior | segments | speech | LUFS | notes |
|---|------|----------|---------|-------|----------|--------|------|-------|
| 0 | <basename> | 4:12 | 3840x2160@30 | narration | 14 (3 silent) | 812 w | -19.3 | scene detection skipped |
<one row per manifest file. duration mm:ss; "speech" = transcript_word_count + " w" or "—";
LUFS = loudness.lufs_integrated or "—"; notes joins: "scene detection skipped",
"transcription failed: <reason>", "audio-only", "no audio", "from cache">

## Transcript map
<one line per paragraph, max 30 paragraphs (then "(+N more — see transcript_summary.md)"):>
- ¶3 [01:24–02:01] First sentence of the paragraph, truncated to 120 chars…
<n/a line when no transcript: "n/a — <skipped_reason>">

## Clean speech (filler/dead-air removal)
kept 312.4s of 388.1s (80%) · 41 spans · 37 fillers · 2 retakes · 19 gaps cut
Plan a_roll cuts on keep-span boundaries: clean_speech.json `keep_spans` (source time).

## Hook candidates
<one block per candidate:>
1. **[00:42.1–00:46.9]** (¶2, score 4.25; question, energy_high, early)
   "what if I told you the entire render pipeline fits in one file?"
<n/a when none scored ≥1.0 or no transcript.>

## Segment table
### file 0 — <basename>
| seg | span | dur | type | energy | wpm | words |
|-----|------|-----|------|--------|-----|-------|
| 0 | 00:00.0–00:14.2 | 14.2 | speech | -21.3 | 142.1 | "so the first thing you notice…" (24w) |
| 1 | 00:14.2–00:16.0 | 1.8 | silence | -54.0 | — | |
<type = "silence" if is_silence else "speech" if has_speech else "visual";
energy = energy_rms_db or "—"; words = transcript_text truncated to 60 chars + count.
Max 40 non-silence rows per file, then "(+N more — see segments.json)". Silence rows
are collapsed: consecutive silences print as one row with the merged span.>

## Visual index
- strips: 4 strips (≤12 cells each) at inspect/strips/ — cell→segment legend: strips/legend.json
- per-segment stills (512w): segment_keyframes/file_<i>/seg_<n>.jpg
- full thumbs (480w, every 3s): thumbs/file_<i>/ · contact sheets: contact_sheet_file_<i>.jpg
<when strip failures > 0: "WARNING: N strip(s) failed to build — read the listed
segment keyframes individually.">

## Caption risk (low-confidence words)
"hyperframes" (00:12) · "Mushanghai" (01:44) · …
Verify spellings with the user before captions burn them in.
<n/a when no confidence data.>
```

Budget: ≤ ~4 k tokens for a 40-min source (caps above enforce it: 30 paragraph lines, 40 segment
rows/file, 5 hooks, 15 caption-risk words).

### 7.3 inspect.js integration

```js
const winnerWords = transcriptsByFile.get(transcribedFileIndex) || null;
const winnerFeatures = segmentation.featuresByFile.get(transcribedFileIndex) || null;
const hookCandidates = rankHookCandidates({
  words: winnerWords, paragraphs,
  energyWindows: winnerFeatures ? winnerFeatures.energy_windows : null,
  durationSeconds: fileWithAudio ? Number(fileWithAudio.duration_seconds) : null,
});
const digestMarkdown = buildInspectDigest({ ... });
writeFileAtomic(inspectDigestPath(projectId), digestMarkdown);
```

Digest build is wrapped in try/catch → on failure `digest_path:null` (best-effort derived
artifact, same posture as transcript_summary at inspect.js:502-505). Hook candidates and digest
are computed even when scene detection was skipped; with `skip_transcription` the digest still
renders (Files/Visual index sections) with n/a markers — REQUIRED for the walker smoke (WP6 runs
skip_transcription).

`summary` object (inspect.js:568-595) additions:

```js
digest_path: <abs|null>,
clean_speech_stats: <stats|null>,            // §5
transcripts: [...], transcript_cache_hits: n, // §6.3
strips_legend_path: <abs|null>, strip_count: n, strip_failures: n,
hook_candidates: [...full §7.1 list...],
hook_candidate_count: n,
```

---

## 8. tools/inspect-source.js — state slot, return, metadata

### 8.1 `state.inspect` additions (write block at inspect-source.js:77-101)

Append after `skipped_reason`:

```js
clean_speech_path: summary.clean_speech_path || null,
digest_path: summary.digest_path || null,
strips_legend_path: summary.strips_legend_path || null,
strip_count: summary.strip_count || 0,
transcripts: summary.transcripts || [],          // [{file_index,path,word_count,backend,from_cache}]
hook_candidate_count: summary.hook_candidate_count || 0,
```

Back-compat: additive only. Old sessions' state.inspect lacks these keys — every reader (WP1
summary, WP5 prompts) must treat missing as `null/0/[]`. No state migration.

### 8.2 Tool return additions (return block at inspect-source.js:118-142)

Keep EVERY existing field (SKILL.md:130 enumerates them; WP5 rewrites the consumer in wave 3 —
during wave 1 the v1 skill must keep working). Append:

```js
digest_path: next.inspect.digest_path,
clean_speech_path: next.inspect.clean_speech_path,
clean_speech_stats: summary.clean_speech_stats || null,
strips_legend_path: next.inspect.strips_legend_path,
strip_count: next.inspect.strip_count,
transcripts: next.inspect.transcripts,
transcript_cache_hits: summary.transcript_cache_hits || 0,
hook_candidate_count: next.inspect.hook_candidate_count,
hook_candidates_top: (summary.hook_candidates || []).slice(0, 3)
  .map(({ rank, start_seconds, end_seconds, text }) => ({ rank, start_seconds, end_seconds, text })),
```

History entry (inspect-source.js:105-113): add `digest_built: Boolean(summary.digest_path)` and
`transcript_cache_hits` — two small scalars, audit-useful.

### 8.3 Description + metadata (token diet, contract-only)

Replace the 1,187-char description (inspect-source.js:148) with (≤700 chars):

> "Analyze ingested sources: thumbnails (480w grid + contact sheet per file), per-file word-level
> transcripts (pluggable ASR, content-hash cached in transcript_cache/), clean-speech keep-spans,
> per-file segments (scene cuts + silence + per-segment energy/speech-rate) with 512w keyframes
> tiled into contact strips (strips/legend.json maps cells to segments), hook candidates, and
> inspect/digest.md — the compact INSPECT handoff. Re-running overwrites artifacts and resets
> user_acknowledged. Requires phase INSPECT. Long-running; timeouts scale with duration.
> skip_scene_detection:true skips the slowest pass; skip_transcription:true skips ASR."

inputSchema: unchanged fields; shorten `skip_scene_detection`'s 420-char description to:
`"Skip whole-stream scene-cut detection (the slowest pass; recommended for 30+ min single-shot
sources). Never poisons the cache for a later full run."`

`session_artifacts_written` (inspect-source.js:177-189) — add:
`"inspect/transcripts/file_*.json"`, `"inspect/strips/*"`, `"inspect/digest.md"`,
`"inspect/clean_speech.json"` (today written but undeclared — fix), `"inspect/audio_features/*"`,
`"transcript_cache/*.json"`.

---

## 9. Classification: structured visual fields

### 9.1 classification-schema.js

Constants (top of file, exported):

```js
const SHOT_TYPES = Object.freeze(["extreme_closeup", "closeup", "medium", "wide", "screen", "graphic", "other"]);
const SUBJECT_POSITIONS = Object.freeze(["left", "center", "right", "none"]);
```

In `validateRef` (classification-schema.js:47-75) — shared by all three pools — add after the
`confidence` check, all OPTIONAL (validated only when present; back-compat with v1 payloads and
the m5-walker fixture):

```js
if (entry.shot_type !== undefined && !SHOT_TYPES.includes(entry.shot_type)) {
  errors.push(`${where}.shot_type must be one of ${SHOT_TYPES.join("|")} when present`);
}
if (entry.subject_position !== undefined && !SUBJECT_POSITIONS.includes(entry.subject_position)) {
  errors.push(`${where}.subject_position must be one of ${SUBJECT_POSITIONS.join("|")} when present`);
}
if (entry.framing_ok_for_vertical !== undefined && typeof entry.framing_ok_for_vertical !== "boolean") {
  errors.push(`${where}.framing_ok_for_vertical must be a boolean when present`);
}
```

In `validateArollPool` (after `is_best_take`, classification-schema.js:97-99):

```js
if (seg && seg.hook_candidate !== undefined && typeof seg.hook_candidate !== "boolean") {
  errors.push(`${where}.hook_candidate must be a boolean when present`);
}
```

Export `SHOT_TYPES`, `SUBJECT_POSITIONS`.

Field semantics (normative, for the WP5/WP6 prompt contract):
- `shot_type` — dominant framing of the segment's keyframe; `screen` = screen-recording/UI,
  `graphic` = title card/slide/chart.
- `subject_position` — horizontal position of the primary subject; `none` for empty/abstract
  frames.
- `framing_ok_for_vertical` — true iff a 9:16 center crop keeps the subject and any on-frame text
  fully visible (the "can we post this vertical without reframing" bit).
- `hook_candidate` (aroll only) — inspector's tag that this segment could open the video cold;
  refines the server-side heuristic list (digest `hook_candidates`).

### 9.2 tools/save-classification.js

Result additions (returned object built at save-classification.js:116-126; also goes into
`state.inspect.classification` — additive):

```js
visual_coverage: {
  aroll_tagged: <count of aroll segments with BOTH shot_type AND framing_ok_for_vertical present>,
  aroll_total: arollCount,
  broll_tagged: <same predicate over broll clips>,
  broll_total: brollCount,
},
hook_tagged_count: <count of aroll segments with hook_candidate === true>,
```

(Two small pure counters next to `countBestTakes`.) History entry gains `hook_tagged_count`.

Description (save-classification.js:152, currently 624 chars) — replace with (≤600 chars; net
change is the new-field mention, not length):

> "Persist the inspector's three classification pools validated against inspect/segments.json
> (hallucinated {file_index,segment_index} refs are rejected): aroll_pool (take_group/is_best_take/
> hook_candidate), broll_index (description/tags/has_motion/has_usable_audio), review. Entries
> should carry the structured visual fields shot_type, subject_position, framing_ok_for_vertical —
> the return's visual_coverage reports how many do. Requires phase INSPECT after vob_inspect_source.
> Inspector's only write tool."

inputSchema: UNCHANGED (pools stay `{type:"object", additionalProperties:true}` — load-bearing,
see save-classification.js:157-166 comment).

### 9.3 Inspector contract impact — hand-off (consumed by WP5/WP6, enforced where)

Engine validates types only; **presence is enforced socially via prompts** (making the fields
required server-side would break every pre-v2 payload, the walker fixture, and the OpenCode
inspector mid-migration). WP5's inspector.md v2 MUST state: "fill shot_type,
subject_position, framing_ok_for_vertical on every aroll/broll entry; tag hook_candidate on
A-roll openers; the save result's visual_coverage is checked by the orchestrator." WP5's SKILL.md
INSPECT step: after the inspector returns, if `visual_coverage.aroll_tagged <
visual_coverage.aroll_total` surface it as a quality note (do NOT loop the inspector for it).
WP6 mirrors in the OpenCode inspector agent (tool name `vob_vob_save_classification`).

---

## 10. Hand-offs to other packages (exact)

| To | What WP3 provides | What they do with it |
|---|---|---|
| **WP1** (read-state-summary, D1) | state.inspect now carries `clean_speech_path`, `digest_path`, `strips_legend_path`, `strip_count`, `transcripts[]`, `hook_candidate_count` (§8.1), `classification.visual_coverage`/`hook_tagged_count` (§9.2). | AGREED (WP1 §1.4.2 includes them verbatim): the summary inspect digest carries `digest_path`, `strips_legend_path`, `strip_count`, `transcripts[]` (verbatim), `hook_candidate_count`, plus `classification.visual_coverage`/`hook_tagged_count` — all defaulting `null`/`0`/`[]` on legacy sessions at read time. |
| **WP2** (plan lint, D4) | `clean_speech.json` shape: `keep_spans:[{start,end,text}]` source-time seconds (clean-cut.js:178-180); helper `removedWithin(keepSpans, start, end) → {intervals, seconds}` (§5). Locate via `state.inspect.clean_speech_path` (null ⇒ skip the check) or `inspectCleanSpeechPath(id)`. | AGREED threshold (matches WP2 §2.4.2 `straddle_removed_min_s` and the storyboarder's <0.8s merge rule): D4 WARNING only when an a_roll clip's `removedWithin(...).seconds > 0.8`, or a single interior removed span is ≥0.8s — sanctioned keep-span merges under 0.8s are lint-silent. Also: storyboard `target` may use digest hook candidates; no code dependency. |
| **WP4** (D6/D7) | `renderStderrLogPath(projectId, kind, stamp)` (§1). Confirmation that WP3 does NOT touch ffmpeg-runner.js / snapshot-keyframes.js; `vob_snapshot_keyframes` stills stay full-res per brief (no change originates here). Fonts: verified no paths.js helper needed (§1 table). | Preview tee uses the helper. |
| **WP5** (claude adapter, D8) | New artifacts + return fields (§8.2): orchestrator INSPECT step v2 = Read `digest_path` + per-file `contact_sheet_paths` (NOT 7 thumb singles); INTENT shows digest "Hook candidates" + "Transcript map" instead of full transcript_summary verbatim for long sources. Inspector spawn data adds: `strips legend: <strips_legend_path or 'none'>`, `digest: <digest_path>`, per-file transcripts dir. Inspector procedure: legend.json → Read each strip image → classify; Read singles (`keyframe_path`) only for ambiguous cells or strip failures; fill §9.3 fields. Storyboarder spawn data adds: `clean_speech: <clean_speech_path or 'none'>` (snap a_roll cuts to keep_spans), `digest: <digest_path>`, `transcripts: inspect/transcripts/file_<i>.json per file`. | All wording/UX is WP5's. WP3 fields are stable contract. |
| **WP6** (sync, D9) | Same contract as WP5 for the OpenCode agents (`vob_vob_*` names). m5-walker: assert `digest_path` non-null, `strip_count ≥ 0`, `transcripts` array present on the inspect return; walker runs `skip_transcription` ⇒ digest must still build (§7.3 guarantees it). | Mirror + smoke. |
| **WP7** (docs) | CLAUDE.md updates: clean_speech is now WIRED (state + return + digest); INSPECT images downscaled (480/512); per-file transcripts persist; transcript_cache/ exists at session root; VOB_THUMB_TIMEOUT_MS + VOB_DISABLE_AUDIO_FEATURES knobs. | Doc text. |

Files other WPs own that WP3 reads but does not modify: `storage.js` (writeFileAtomic/readJsonFile),
`ffmpeg-runner.js` (runFfmpegBlocking + inputAutorotateArgs), `envelope.js` (ToolError),
`session-state.js` (readSessionStateStrict). No signature changes requested from any of them.
Ordering note vs WP1: WP1 edits `tools/ingest-file.js` (return shape) and read tools — zero file
overlap with WP3; both land in wave 1 independently.

---

## 11. Back-compat matrix (normative)

| Scenario | Behavior after WP3 |
|---|---|
| Old session (pre-v2 state.json) resumed past INSPECT | Nothing re-runs; readers of the new state.inspect keys get undefined → must default (WP1/WP5 contract). No gate reads any new field. |
| Old session re-entering INSPECT (back-edge) | `vob_inspect_source` re-runs: detection cache (v1, no `audio_features`) keeps scenes/silences; audio pass re-runs once to add features; transcript cache cold → ASR runs once, then cached. |
| `skip_scene_detection:true` | Unchanged semantics (inspect.js:314, 340 cache-authority logic untouched); strips/digest/features all still produced; skip-run still never writes scene authority. |
| `skip_transcription:true` | Unchanged path (§6.3); no per-file transcripts, no hooks, no caption-risk; digest renders with n/a sections; clean_speech absent (as today). |
| No-ASR host (`no_asr_backend` / all backends fail) | Same as today plus: failures recorded per file in `transcripts[]` (`path:null`), digest Files column says "transcription failed: <reason>"; segments fall back to empty transcript fields. No throw. |
| ffmpeg build missing ebur128/astats | Features chain auto-falls back to plain silencedetect (§4.1 retry); `features:null`; energy/loudness fields null; everything else intact. `VOB_DISABLE_AUDIO_FEATURES=1` forces this preemptively. |
| Audio-only file in a multi-file drop | Keyframes/strips skipped for it (`hasVideo` false); energy + transcript features fully computed; loudness recorded. |
| Strip build failure | Non-fatal; singles fallback (§3.3). |
| v1 consumer of the tool return (current SKILL.md) | Every v1 field preserved verbatim (§8.2). |
| `vob_save_classification` v1 payload (no visual fields) | Validates exactly as before; `visual_coverage` reports 0-tagged. |

---

## 12. Verification (commands + fixtures; run from repo root)

1. **Syntax:** `node --check` on: `mcp/lib/paths.js inspect.js segment-signals.js
   silence-detector.js clean-cut.js asr-backend.js inspect-digest.js classification-schema.js
   tools/inspect-source.js tools/save-classification.js`. Python: `python3 -m py_compile
   mcp/lib/asr/*.py`.
2. **Boot:** `node mcp/server.js` ≤2 s to "ready" line; registry integrity passes (no tool
   added/renamed).
3. **Fixture asset** (same recipe verified in this spec):
   ```bash
   ffmpeg -f lavfi -i "testsrc2=duration=30:size=1280x720:rate=30" \
     -f lavfi -i "sine=frequency=440:duration=30:sample_rate=48000" \
     -filter_complex "[1:a]volume='if(lt(mod(t,10),7),1,0.001)':eval=frame[a]" \
     -map 0:v -map "[a]" -c:v libx264 -preset ultrafast -c:a aac -shortest /tmp/vob-fix/test.mp4
   ```
4. **Unit (pure fns, `node -e`):**
   - `attachAudioFeatures([{start_seconds:0,end_seconds:2,...}], [{t:0,rms_db:-20},{t:0.5,rms_db:-30}])`
     → `energy_rms_db:-25`, `energy_peak_db:-20`.
   - `attachTranscriptOverlap` on a 10 s segment with 20 words → `speech_rate_wpm:120`.
   - `rankHookCandidates` with words spelling "Hi everyone welcome to my channel." then "What if
     you could cut your render time by 90 percent?" → second sentence ranks #1 with signals
     containing `question`+`number`; greeting sentence scores < 1.0 (excluded or last).
   - `removedWithin([{start:0,end:5},{start:8,end:12}], 4, 9)` → `seconds:3`.
   - `escapeFilterPath("/a b/c:d'e")` round-trips into a parseable filter string (assert no throw
     from a live `ffmpeg -af "ametadata=mode=print:key=x:file=<escaped>" `-style dry run).
5. **detectSilences features (live):** call `detectSilences('/tmp/vob-fix/test.mp4', {features:
   {energyLogPath:..., stderrLogPath:...}})` → `ok:true`, 2–3 silences ≈ [7–10] & [17–20] &
   [27–30], `features.energy_windows.length ≈ 60`, `loudness.lufs_integrated` ≈ −22±2,
   `true_peak_dbtp` finite. Then with `VOB_DISABLE_AUDIO_FEATURES=1` → `features` absent, silences
   identical.
6. **TOOL_HANDLERS smoke (no MCP transport)** — temp project, mirroring the walker pattern:
   init → ingest `/tmp/vob-fix/test.mp4` → transition INSPECT → `vob_inspect_source {}`. Assert on
   the return: `digest_path` exists on disk; `strip_count ≥ 1` and legend.json parses with
   `cells[].segment_index` all present in segments.json; `transcripts.length === 1` (or
   `skipped_reason` set on a no-ASR host — both acceptable); segments.json entries carry
   `energy_rms_db` (number) and silence segments `energy_rms_db < -45`; thumbs are ≤480 px wide and
   keyframes ≤512 (ffprobe width check); every `contact_sheet_paths` entry tiles ≤40 cells (run
   once with `thumb_interval_seconds: 0.5` on the 30 s fixture → 60 thumbs → exactly 2 sheets
   `contact_sheet_file_0_0.jpg` + `_1.jpg`); `clean_speech_path` + `clean_speech_stats` non-null
   when ASR ran.
   - **Cache:** re-run `vob_inspect_source` → `transcript_cache_hits === transcripts.length`,
     wall-time drop on the ASR step to ~0; `transcript_cache/<hash>.json` exists; detection cache
     hit (no scene re-decode — verify via timing or strace-free by asserting unchanged
     `detected_at` in segment_cache).
   - **Skip paths:** `{skip_transcription:true}` → digest exists with "n/a" transcript map, no
     transcripts dir entries, no clean_speech; `{skip_scene_detection:true}` → unchanged cache
     authority semantics (segment_cache doc `scene_detected:false` on a cold run).
7. **Multi-file:** ingest a directory holding test.mp4 + a copy with different audio (re-encode
   with `-af atempo=1.05`) → both `inspect/transcripts/file_0.json` and `file_1.json` exist;
   segments of BOTH files have `has_speech:true` rows (the inspect.js:350 fix).
8. **Classification:** `vob_save_classification` with (a) a v1 payload → ok, `visual_coverage`
   zeros; (b) entries with `shot_type:"medium", subject_position:"center",
   framing_ok_for_vertical:true, hook_candidate:true` → ok, counters correct; (c)
   `shot_type:"selfie"` → INVALID_ARGUMENTS with the exact §9.1 message.
9. **Driver confidence:** on a host with faster-whisper, transcribe the fixture and assert
   transcript entries carry `p` in [0,1]; `computeCleanSpans` on that transcript still returns the
   same spans as without `p` (field ignored).
10. **Token/size accounting (for docs/v2/RESULTS.md, WP7):** record before/after byte sizes of a
    sample thumb, keyframe, and the per-run image-read plan (7 full thumbs + N full keyframes vs
    digest + strips); record the two tool descriptions' char counts (1,187→≤700; 624→≤600).

---

## 13. Open issues / explicitly deferred

- `has_motion` remains single-frame-judged (physically blind). Strips don't fix it (one cell per
  segment). A 3-frame-per-segment strip or ffmpeg motion score was considered and NOT locked by
  the brief; deferred to v2.1. Prompts (WP5) should phrase it as "apparent motion (single-frame
  inference)".
- Serial keyframe extraction (≤80 ffmpeg spawns/file) left as-is; bounded-pool via concurrency.js
  would cross into shared infra not listed for WP3.
- ebur128 stderr tee file (~3 MB / 30 min) is wiped per run but counts toward the unaddressed
  session-disk-GC gap the critique flagged repo-wide.
- Transcript cache keyed on resolved params with `backend:"auto"`: engine swap under auto reuses
  the cache (accepted; canonical contract identical across backends).
