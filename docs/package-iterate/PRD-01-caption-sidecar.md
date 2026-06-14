# PRD: Chunk-level caption sidecars (.srt + .vtt) at PACKAGE and import

## 1. Summary

video-vob plans timed on-screen captions (`scene.caption_segments[]`) and burns them into the rendered video, but ships no machine-readable caption file alongside the deliverable. This PRD emits `package/captions.srt` + `package/captions.vtt` — and a per-deliverable `.srt`/`.vtt` for every fan-out short and escape-hatch import — derived from `caption_segments[]` using the **same cumulative scene-target-duration cursor** already proven in `resolveThumbnailMoment` (`package-output.js:67-87`) and `chaptersFromStoryboard` (`package-output.js:107-125`). The derivation lives in one isolated, dependency-free module `mcp/lib/caption-sidecar.js`; the touch on the two contested hot files (`package-output.js`, `package-readme.js`) is a few lines each. The output is **chunk-level only** (one cue per `caption_segment`), timed off storyboard targets (the same known drift chapters already declare), with cue ends clamped to the probed final duration. This is the highest output-quality win in the batch and is parallel-safe with the other six refactors.

## 2. Problem & motivation

Captions are a first-class planned layer: `scene.caption_segments[]` is validated (`storyboard-schema.js:233-295` `validateCaptionSegment`), accessor-exported (`captionSegmentsOf`, `storyboard-schema.js:222-225`, listed in `module.exports` at `storyboard-schema.js:1969`), lint-bound, and re-timed onto the timeline by the composer (walker `compose()` re-times each at `m5-walker.js:305-316`). They are burned into the pixels at render.

But `vob_package_output` produces exactly four files — `final.mp4`, `thumbnail.jpg`, `manifest.json`, `README.md` (`package-output.js:476`, history `files: 4` at `package-output.js:438`) — and **no caption sidecar**. Consequences:

- A burned-in caption is not accessible-text. YouTube/social platforms cannot index, auto-translate, or render a soft caption track; viewers cannot toggle it; screen readers get nothing.
- The full caption transcript the storyboard already holds is discarded at the finish line.
- Fan-out shorts (recorded via `vob_import_deliverable`, `import-deliverable.js`) and escape-hatch imports get loudness normalization (`import-deliverable.js:286-297`) but no captions — the multi-short social path is exactly where soft captions matter most.

The cursor needed to time the cues already exists and is trusted twice in this same file: `resolveThumbnailMoment` walks `sb.scenes` accumulating `scene.target_duration_seconds` (`package-output.js:74-82`), and `chaptersFromStoryboard` does the identical accumulation over narrative segments (`package-output.js:113-123`). We reuse that cursor; we do not invent timing.

## 3. Goals / Non-goals

**Goals**

- Emit `package/captions.srt` and `package/captions.vtt` on every successful `vob_package_output` run, derived from `caption_segments[]` across all storyboard scenes in order.
- Mirror the same derivation into `vob_import_deliverable`'s pre-lock materialization so each fan-out short and each escape-hatch import gets a sibling `<stem>.srt` / `<stem>.vtt`.
- Cover the assembled-segmented case for free (assembly reaches `vob_package_output` post-assembly — the same code path).
- Declare the timing basis honestly in the manifest (`timing_basis:'storyboard_target'`, `level:'chunk'`) so the known scene-duration-vs-cut drift is visible, exactly as chapters already declare theirs.
- Skip scenes with no `caption_segments`; emit `null` (no files) when the whole storyboard has zero caption segments.
- Clamp every cue end to the probed final duration.

**Non-goals** (deferred, with reasons):

- **Word-level / karaoke `.srt`.** Two unmet preconditions: (1) The source→output time remap that would place individual words accurately is `clean-cut.js::buildTimeline`, which is **computed and discarded** at INSPECT and is anyway the *wrong* transform — the real output cut comes from `clip-materialize` over each `source_clips[].in/out/speed`, not from clean-cut spans. (2) Accurate per-word timing requires whisperx forced alignment (`state.inspect.transcript_aligned === true`), which is **not installed** (the karaoke plan-lint warning at `storyboard-schema.js:1561` exists precisely because alignment is normally absent). Chunk-level cues, timed off storyboard scene targets, need neither and are honest about their drift. Word-level is revisited only if/when alignment is persisted.
- **Falling back to `scene.captions` when `caption_segments` is absent.** `scene.captions` is a **human-readable summary string** (validated as "a string or null" at `storyboard-schema.js:368-369`; the storyboard-schema comment at `:228-229` is explicit it stays the summary). Emitting it as a cue would burn a whole paragraph onto the timeline. We skip caption-less scenes outright — and because `captionSegmentsOf` returns **only plain-object segments** (the `isPlainObject` filter at `storyboard-schema.js:223-224`), a scene whose `caption_segments` holds string-form notes yields `[]` and is treated identically to a scene with no segments at all.
- **Per-scene `.vtt` cue styling / positioning, regions, or speaker labels.** `caption_segments` carries `position`/`style_ref`/`emphasis_words`, but a portable `.srt`/`.vtt` is plain text. Styling stays the composer's (burned-in) concern.
- **Posters and multi-aspect variants in the import mirror.** Per the fixed fan-out-mirror decision, captions + distribution + loudness mirror into import; posters and multi-aspect stay package-only.
- **Manifest version bump.** The captions block is additive via conditional spread; no internal consumer needs to distinguish a captioned manifest from a caption-less one.

## 4. Design

### 4.1 New module — `mcp/lib/caption-sidecar.js`

Pure Node stdlib, CommonJS, zero deps. Exports one function:

```
buildCaptionSidecar(storyboard, { durationSeconds }) -> { srt, vtt, segment_count } | null
```

**Algorithm** (one cursor, mirrors `package-output.js:74-82` / `:113-123`):

1. If `storyboard` is not a plain object or `Array.isArray(storyboard.scenes)` is false → return `null`. (Fan-out `shorts[]` storyboards never reach `package_output` — it refuses them at `package-output.js:153-160` — so the package path only ever sees single-timeline `scenes[]`. The import path handles fan-out per-deliverable; see 4.4.)
2. Walk `storyboard.scenes` in order, maintaining `cursor = 0` (output-time seconds).
   - For each scene, read `d = Number(scene.target_duration_seconds)`. If not finite or `<= 0`, **stop accumulating** (mirrors the `cursor = NaN; break` guard at `package-output.js:76`) — malformed durations mean we cannot trust downstream offsets; return what we have so far (or `null` if nothing collected).
   - **`caption_segments` carry SOURCE-time offsets** — `seg.start_seconds`/`end_seconds` are measured in the original take's timeline, not scene-relative (the schema comment is explicit: `(SOURCE-time)` at `storyboard-schema.js:227`; the composer re-times by **subtracting the scene's clip in-point** at `m5-walker.js:308`: `cursor + (seg.start_seconds - clip.in_seconds)`). We mirror that transform exactly. Read the scene's first source clip — `const clip = (Array.isArray(scene.source_clips) && scene.source_clips[0]) || {}; const inSec = Number(clip.in_seconds) || 0;` — and for each `seg` in `captionSegmentsOf(scene)` (imported from `storyboard-schema.js` — **zero change to that file**) place the cue at output time:
     - `cueStart = cursor + (seg.start_seconds - inSec)`
     - `cueEnd   = cursor + (seg.end_seconds - inSec)`
     - This is the load-bearing fix: omitting `- inSec` lands every cue `in_seconds` too late for any scene cut from the middle of a take (the normal case, `source_clips[0].in_seconds > 0`), and the `cueStart >= durationSeconds` guard below then silently drops them.
   - Clamp: `cueEnd = Math.min(cueEnd, durationSeconds)`; if `cueStart < 0` clamp `cueStart = 0`; skip the cue entirely if `cueStart >= durationSeconds` or `cueEnd <= cueStart` after clamping (the cursor can overrun the real cut — `durationSeconds` is the probed post-loudnorm final).
   - Push `{ index, start: cueStart, end: cueEnd, text: seg.text.trim() }`.
   - `cursor += d`.
3. If zero cues collected → return `null` (no files written; the caller spreads nothing).
4. Renumber cues 1..N and render two strings:
   - **SRT**: `\n`-joined blocks `${i}\n${stampSrt(start)} --> ${stampSrt(end)}\n${text}\n`.
   - **VTT**: `WEBVTT\n\n` + blocks `${stampVtt(start)} --> ${stampVtt(end)}\n${text}\n`.
5. Return `{ srt, vtt, segment_count: cues.length }`.

**Timestamp helpers** — extend the existing `youtubeStamp` pattern (`package-output.js:94-102`) to millisecond precision. Define two small local helpers *in the new module* (keep `youtubeStamp` untouched — it is the chapter stamp and is also exported-by-use; do not repurpose it):

- `stampSrt(seconds)` → `HH:MM:SS,mmm` (comma fraction).
- `stampVtt(seconds)` → `HH:MM:SS.mmm` (dot fraction).

Both clamp to `>= 0`, compute `h/m/s` like `youtubeStamp` but always zero-pad hours, and append `,`/`.` + 3-digit milliseconds.

The module exports `{ buildCaptionSidecar }` (and may export `stampSrt`/`stampVtt` for the walker, but the walker can assert on file content instead).

### 4.2 Hook in `package-output.js` — one derive + two writes + manifest block

`durationSeconds` is already in scope (`package-output.js:266`, the post-loudnorm probe summary). `sbForGuard` is already the parsed single-timeline storyboard in scope (`package-output.js:143-148`, `:340`). Insert near the thumbnail/chapters block (after `chapters` is computed at `:340`, before the `manifest` object at `:345`):

```
const captionSidecar = buildCaptionSidecar(sbForGuard, { durationSeconds });
```

If non-null, write both files via `writeFileAtomic` (already imported, `package-output.js:20`) to the new path builders, and build the manifest block. Files are written into `pkgRoot` (created at `:227`, wiped-and-recreated every run at `:224-227`), so they are rebuilt every successful run like every other package file.

**Manifest block** — additive conditional spread (the established pattern, `package-output.js:354` `...(chapters ? {chapters} : {})`). The `manifest` object literal (`:345-413`) is edited by four siblings in this batch (captions, distribution, posters, aspect_variants); per the batch reconciliation, all four land their conditional spreads in the **fixed key order `chapters, captions, distribution, posters, video, aspect_variants`** so diffs stack and the literal merge is mechanical. The captions spread goes immediately after the `chapters` spread:

```
...(captionSidecar ? {
  captions: {
    srt_path: "captions.srt",
    vtt_path: "captions.vtt",
    segment_count: captionSidecar.segment_count,
    level: "chunk",
    source: "caption_segments",
    timing_basis: "storyboard_target",
  },
} : {}),
```

(Paths are package-relative bare filenames, matching `video.path:"final.mp4"` at `:367` and `thumbnail.path:"thumbnail.jpg"` at `:377`. **No `manifest_version` bump** — stays `"1.2"` at `:346`, consistent with the other three additive siblings.)

**State slot** — add to the `package:` object written under the lock (`package-output.js:421-430`). This slot is also touched by the posters and aspect-variants siblings; per the batch reconciliation the three additions are ordered identically here and in `summarizePackage` (captions fields first). Captions adds:

```
...(captionSidecar ? {
  captions_srt_path: sessionRelative(id, packageCaptionsSrtPath(id)),
  captions_vtt_path: sessionRelative(id, packageCaptionsVttPath(id)),
} : {}),
```

(session-relative, matching every sibling at `:423-427`.)

**History** — bump the files count and the artifact list. At `package-output.js:438`, `files: 4` → `files: captionSidecar ? 6 : 4`. Add `caption_segment_count: captionSidecar ? captionSidecar.segment_count : 0` to the same history entry for audit.

**`session_artifacts_written`** (tool metadata, `package-output.js:476`) — append `"package/captions.srt", "package/captions.vtt"` (declarative; harmless when none emitted).

### 4.3 Hook in `package-readme.js` — one conditional section

`renderPackageReadme(manifest)` reads only `manifest.*` (`package-readme.js:35`). The verified section layout is: `## Output` (:48), `## Thumbnail` (:56-67), `## Audio` (:70-82), `## Chapters` (:87-98), `## Target` (:100). Four siblings insert sections in this batch; to avoid the identical-anchor textual collision, the batch fixes a **canonical insertion order**: `## Posters` goes after `## Thumbnail` (after :67); then `## Captions`, `## Distribution`, `## Aspect variants` go after `## Chapters` (after :98, before `## Target` at :100) **in exactly that order**. This PRD inserts `## Captions` as the **first** of the post-Chapters block (immediately after the Chapters section, before Distribution and Aspect variants):

```
if (manifest.captions && typeof manifest.captions === "object") {
  lines.push("## Captions");
  lines.push("");
  lines.push(`- **SRT:** \`${manifest.captions.srt_path}\``);
  lines.push(`- **VTT:** \`${manifest.captions.vtt_path}\``);
  lines.push(`- **Cues:** ${manifest.captions.segment_count} (chunk-level, timed from storyboard targets)`);
  lines.push("");
}
```

No other change to `package-readme.js`.

### 4.4 Mirror in `import-deliverable.js` — per-deliverable sidecars

In the **pre-lock materialization loop** (`import-deliverable.js:273-324`), after `finalAbs` is settled and (optionally) loudnorm'd and copied/deduped (`:276-302` — the copy, the `normalize:true` loudnorm pass at `:286-297`, and the post-dedup probe `meta` at `:302`) the sidecar derive hooks in once `finalAbs` is final (settled at `:284`, post-probe at `:302`), **before** the per-deliverable record is pushed (`:298-323`). The storyboard is already read safely (`readStoryboardSafe`, `import-deliverable.js:70-77`, called at `:112`).

For each record:

1. Determine the scenes view:
   - **Fan-out** (`fanOut === true`, `import-deliverable.js:113`): resolve this deliverable's timeline by `item.short_id` via `findTimeline(storyboard, item.short_id)` and pass `{ scenes: timeline.scenes }` to `buildCaptionSidecar`. **`findTimeline` is NOT currently imported** — `import-deliverable.js:20` destructures only `storyboardHasShorts, storyboardTimelines` from `storyboard-schema.js`. Add `findTimeline` to that destructure (it is defined at `storyboard-schema.js:774` and already exported at `:1975`). This shares the import line with the distribution sibling, which extracts a `distributionFromStoryboard` helper from the same module; coordinate the destructure-add.
   - **Single-deliverable / escape-hatch** (no `shorts[]`): pass the storyboard's top-level `scenes[]` if present; if the import is a pure escape-hatch with no storyboard, `readStoryboardSafe` returns `null` → `buildCaptionSidecar` returns `null` → no sidecar (correct: there is nothing to caption).
2. `durationSeconds` = `meta.duration_seconds` (the probed deliverable duration, `import-deliverable.js:302`/`describeVideo:62`); if null, skip the sidecar (no clamp basis).
3. If `buildCaptionSidecar(...)` is non-null, write `<destDir>/<stem>.srt` and `<destDir>/<stem>.vtt`, where `stem = path.basename(finalAbs, finalExt)` (the post-dedup id, `import-deliverable.js:304`) — the `-n` suffix reaches the sidecar names, so cross-identity collisions never clobber each other's captions.
4. Add to the per-deliverable record (`import-deliverable.js:298-323`), conditional-spread:

```
...(captionSidecar ? {
  captions: {
    srt_path: sessionRelative(id, srtAbs),
    vtt_path: sessionRelative(id, vttAbs),
    segment_count: captionSidecar.segment_count,
    level: "chunk",
    source: "caption_segments",
    timing_basis: "storyboard_target",
  },
} : {}),
```

The sidecars live under `destDir` (the session `deliverables/` dir, `import-deliverable.js:148-149`) — **never under `package/`**, so the package wipe can't reach them; they ride into `deliverables/manifest.json` via the record (`import-deliverable.js:359`). This is the **same materialize loop and same `deliverables/manifest.json` regen** the distribution sibling edits: distribution adds a **top-level** `manifest.distribution` in the regen literal (`:352-360`), captions add a **per-record** `record.captions` inside the loop — distinct sinks, adjacent edits, serialize the two import-side commits. A superseded short's old sidecars are siblings of its superseded `.mp4`; extend the supersede cleanup (`import-deliverable.js:346-348`) to also `rmSync` the `<oldStem>.srt`/`.vtt` best-effort (derive from the superseded `.mp4` rel path).

**History** — in the locked `external_deliverables_imported` entry (`import-deliverable.js:369-380`), add `caption_segment_counts: records.map(r => r.captions ? r.captions.segment_count : 0)`.

**`session_artifacts_written`** (`import-deliverable.js:450`) — already `["deliverables/*", "state.json"]`; the glob covers the new sidecars. No change needed (note it in the PR description).

### 4.5 Resulting manifest shape (package, single-timeline)

```json
{
  "manifest_version": "1.2",
  "...": "...",
  "chapters": [ ... ],
  "captions": {
    "srt_path": "captions.srt",
    "vtt_path": "captions.vtt",
    "segment_count": 7,
    "level": "chunk",
    "source": "caption_segments",
    "timing_basis": "storyboard_target"
  },
  "video": { ... }
}
```

### 4.6 SRT/VTT output (literal)

```
captions.srt:
1
00:00:03,200 --> 00:00:04,400
walker caption one

2
00:00:04,500 --> 00:00:05,800
walker caption two
```

```
captions.vtt:
WEBVTT

00:00:03.200 --> 00:00:04.400
walker caption one

00:00:04.500 --> 00:00:05.800
walker caption two
```

## 5. Seam-level change list

| File | Anchor | Change |
|---|---|---|
| `mcp/lib/caption-sidecar.js` | **NEW** | `buildCaptionSidecar(storyboard,{durationSeconds})`; local `stampSrt`/`stampVtt`; imports `captionSegmentsOf` from `storyboard-schema.js`. Reads `scene.source_clips[0].in_seconds` and re-times `cursor + (seg.start_seconds - in_seconds)`. Pure stdlib, zero deps. |
| `mcp/lib/paths.js` | after `:333` (`packageThumbnailPath`) | Add `packageCaptionsSrtPath(projectId)` → `path.join(packageDir(projectId), "captions.srt")` and `packageCaptionsVttPath` → `"captions.vtt"`. Add both to `module.exports` (`:366`, near `:407`). |
| `mcp/lib/tools/package-output.js` | import block `:14-19` | Add `packageCaptionsSrtPath, packageCaptionsVttPath` to the `paths.js` destructure; add `const { buildCaptionSidecar } = require("../caption-sidecar.js");`. |
| `mcp/lib/tools/package-output.js` | after `:340` (`chapters`) | `const captionSidecar = buildCaptionSidecar(sbForGuard, { durationSeconds });` + two `writeFileAtomic` writes to the new paths when non-null. |
| `mcp/lib/tools/package-output.js` | `manifest` literal `:345-413` | Add conditional-spread `captions` block in the fixed key order (after `chapters`, before `distribution`/`posters`/`video`/`aspect_variants`). **No `manifest_version` bump.** |
| `mcp/lib/tools/package-output.js` | `package:` slot `:421-430` | Add conditional-spread `captions_srt_path`/`captions_vtt_path` (session-relative); ordered identically to `summarizePackage` (captions first, ahead of posters/variants siblings). |
| `mcp/lib/tools/package-output.js` | history `:438` | `files: 4` → `files: captionSidecar ? 6 : 4`; add `caption_segment_count`. |
| `mcp/lib/tools/package-output.js` | metadata `:476` | Append `"package/captions.srt", "package/captions.vtt"` to `session_artifacts_written`. |
| `mcp/lib/package-readme.js` | after `:98` (Chapters), before `:100` (Target) | Add `## Captions` as the FIRST post-Chapters section (before the distribution/aspect-variants siblings, per the canonical insertion order). |
| `mcp/lib/tools/import-deliverable.js` | import `:7-14`, `:20` | Add `buildCaptionSidecar` require; add `findTimeline` to the `storyboard-schema.js` destructure (`:20` — currently only `storyboardHasShorts, storyboardTimelines`). |
| `mcp/lib/tools/import-deliverable.js` | materialize loop `:273-324` | Per-record sidecar derivation after `finalAbs` settles (`:284`/`:302`), before the record push (`:298-323`): fan-out via `findTimeline(item.short_id)`, else top-level scenes; write `<stem>.srt`/`.vtt` to `destDir`; conditional-spread `captions` into the record. |
| `mcp/lib/tools/import-deliverable.js` | supersede cleanup `:346-348` | Also `rmSync` old `.srt`/`.vtt` best-effort. |
| `mcp/lib/tools/import-deliverable.js` | history `:369-380` | Add `caption_segment_counts`. |
| `mcp/lib/session-state.js` | `summarizePackage` `:489-501` | Add `captions_srt_path: strOrNull(p.captions_srt_path)`, `captions_vtt_path: strOrNull(p.captions_vtt_path)` — ordered identically to the package slot, ahead of the posters/variants siblings. |
| `scripts/m5-walker.js` | `package` phase `:2480-2489`; `longform` `:1635-1649`; `fanout` `:575+` | New assertions (§8). |

**Zero changes to** `storyboard-schema.js` (`captionSegmentsOf` already exported at `:1969`; `findTimeline` already exported at `:1975` — only its destructure in `import-deliverable.js:20` is added), `loudnorm.js`, the FSM (`ALLOWED_TRANSITIONS`, `GATES`), the tool registry, SKILL.md, settings.json, opencode.json. **No new tool, no new arg** → `verifyAdapterToolReferences` is untouched, `port-adapter-docs.js` need not run.

**New manifest key:** `manifest.captions` (additive). **New state keys:** `package.captions_srt_path`, `package.captions_vtt_path`; per-deliverable `record.captions`. **New paths.js builders:** `packageCaptionsSrtPath`, `packageCaptionsVttPath`.

## 6. Invariants preserved

- **`package_output` refusals before the wipe.** No new code runs before the fan-out guard (`package-output.js:153-160`) or the unassembled-segmented guard (`:166-184`). `buildCaptionSidecar` is invoked at `:340`-ish — far after both refusals and after the `pkgRoot` wipe/recreate (`:224-227`). A refused project loses nothing.
- **`package/` fully wiped + regenerated every run.** Sidecars are written into `pkgRoot` after the wipe, so they are rebuilt every successful run, never appended. They live and die with `package/`.
- **`deliverables/` is session-level, never under `package/`.** Import sidecars are written to `destDir = deliverablesDir(id)` (`import-deliverable.js:148`, `paths.js:347-349`), which the package wipe (`package-output.js:224-225`, scoped to `packageDir`) never touches.
- **Import merge identity + no-clobber.** Sidecar names derive from `path.basename(finalAbs, finalExt)` — the **post-dedup** id (`import-deliverable.js:304`), the same source the record `id` derives from. The `-n` suffix from `resolveDestAbs` (`:165-186`) reaches the sidecar names, so cross-identity captions never overwrite each other; superseded sidecars are cleaned alongside the superseded `.mp4` (`:346-348`).
- **Back-edge auto-archive.** Sidecars sit inside `package/`; a back-edge out of PACKAGE moves `package/` into `archive/v<N>/` wholesale (`archival.js`), so the captioned package is archived intact, never destroyed.
- **`state.json`/`manifest.json` written only by `vob_*` tools.** All writes go through `writeFileAtomic` inside the existing `vob_package_output` / `vob_import_deliverable` handlers; the sidecar `.srt`/`.vtt` are derived artifacts (like `thumbnail.jpg`), not authoritative state.
- **FSM untouched / no forward skip.** Read-only-shaped change: no edge added or removed, no gate added. `ALLOWED_TRANSITIONS` and `GATES` are not edited.
- **Manifest additive, no version bump.** `captions` is conditional-spread; `manifest_version` stays `"1.2"` (`package-output.js:346`). No internal consumer distinguishes captioned manifests.

## 7. Data dependencies & availability

- **`scene.caption_segments[]`** — present and exported. `captionSegmentsOf` (`storyboard-schema.js:222-225`, export at `:1969`) returns **only object-form segments** (the `isPlainObject` filter at `:223-224`); each carries `text`, `start_seconds`, `end_seconds` (validated `storyboard-schema.js:239-247`). String-form caption notes are filtered out and the scene is treated as caption-less. **Confirmed.**
- **`scene.source_clips[0].in_seconds`** — the SOURCE-time offset the cue re-time subtracts (`m5-walker.js:308`). Optional; defaults to `0` when absent (a scene clipped from the head of the take). **Confirmed.**
- **`scene.target_duration_seconds`** — the cursor input; already consumed identically at `package-output.js:75` and `:113-120`. **Confirmed.**
- **Probed final duration** — `durationSeconds` in scope at `package-output.js:266` (post-loudnorm `summary`); for import, `meta.duration_seconds` from `describeVideo` (`import-deliverable.js:62`, `:302`). **Confirmed.**
- **Fan-out per-short scenes** — `findTimeline(storyboard, short_id)` defined at `storyboard-schema.js:774`, exported at `:1975`, returns the short's `scenes[]`. `item.short_id` is on each record (`import-deliverable.js:265`). Requires adding `findTimeline` to the destructure at `import-deliverable.js:20`. **Confirmed.**
- **Word-level timing / forced alignment** — `state.inspect.transcript_aligned` and `clean-cut.js::buildTimeline` — **blocked** (alignment not installed; remap discarded and is the wrong transform). Drives the word-level Non-goal; chunk-level needs none of it.

## 8. Verification

**Walker — `package` phase (`m5-walker.js:2480-2489`).** The main-run storyboard's beat scene already carries two `caption_segments` (`m5-walker.js:225-227`), and the `payoff`/`hook` scenes carry none — so this exercises both the emit path and the skip-caption-less-scene path. After `vob_package_output` succeeds, add a block:
- `const manifest = JSON.parse(fs.readFileSync(pkg.manifest_path, "utf8"));`
- `assert(manifest.captions && manifest.captions.level === "chunk" && manifest.captions.timing_basis === "storyboard_target", "captions manifest block missing/wrong");`
- `assert(manifest.captions.segment_count === 2, "expected 2 caption cues from the beat scene");`
- `const srt = fs.readFileSync(path.join(pkg.directory_path, "captions.srt"), "utf8");`
- **Assert the actual cue START timestamp, not just the count** (the count would pass even with the `- in_seconds` bug; the timestamp is what the bug corrupts). Compute the expected output start from the fixture: `cursor` for the beat scene = sum of prior scenes' `target_duration_seconds`, and `cueStart = cursor + (seg.start_seconds - beatClip.in_seconds)`. Assert cue 1's stamp equals `stampSrt(expectedStart)` exactly: `assert(srt.includes(\`1\n${expectedStamp} --> \`), \`SRT cue 1 start ${expectedStamp} missing — likely the in_seconds re-time bug\`);`. **If the beat fixture's `source_clips[0].in_seconds` is small/zero (which masks the bug), bump it to a non-zero value (e.g. 5s) in `m5-walker.js:225-227` so the subtraction is load-bearing in the assertion.**
- `assert(/^1\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\nwalker caption one/m.test(srt), "SRT cue 1 shape malformed");`
- `const vtt = fs.readFileSync(path.join(pkg.directory_path, "captions.vtt"), "utf8");`
- `assert(/^WEBVTT/.test(vtt) && /\d\d:\d\d:\d\d\.\d\d\d --> /.test(vtt), "VTT header/stamp malformed");`
- `const readme = fs.readFileSync(pkg.readme_path, "utf8"); assert(/## Captions/.test(readme) && /captions\.srt/.test(readme), "README captions section missing");`

**Walker — `longform` phase (`m5-walker.js:1635-1649`).** The assembled-segmented project reaches `package_output`; assert `manifest.captions` is present (or `undefined` if the longform fixture scenes carry no `caption_segments` — assert whichever the fixture produces; if absent, `assert(manifest.captions === undefined)` proves the skip path on a caption-less storyboard). This confirms the assembled-segmented case takes the same path with no regression to the existing chapter assertions.

**Walker — `fanout` phase (`m5-walker.js:575+`).** The fanout fixture's scenes carry `captions: null` and no `caption_segments` (`m5-walker.js:533`), so the import sidecars are correctly absent. To exercise the import mirror, add one `caption_segments` entry (with a non-zero `source_clips[0].in_seconds` on its scene) to one short's scene in `fanoutStoryboard` (`:522-540`) and, after the import-with-normalize record (`m5-walker.js:848-864`), assert the recorded deliverable carries `record.captions.segment_count >= 1`, that `<stem>.srt` exists under the deliverables dir (read `imp1.deliverables[0].captions.srt_path`, resolve against `sessionDir`), and that its cue-1 start reflects the `- in_seconds` subtraction (same timestamp assertion as the package phase, against the fan-out timeline resolved by `findTimeline`). **Target the assertion at the short whose scene actually carries `caption_segments`** — a string-form `captions: null` scene yields `[]` from `captionSegmentsOf` and contributes no cue.

**Manual check (optional, no env):** Run `node scripts/m5-walker.js package` (requires `VOB_WALKER_SOURCE`, ffmpeg, hyperframes) and open `package/captions.srt` / `.vtt` in a player to confirm cues track the burned-in captions within the declared storyboard-target drift.

## 9. Parallel-safety & sequencing

**Collision surface.** The only hot shared files are `package-output.js` and `package-readme.js` (and `paths.js`, `session-state.js::summarizePackage`, `import-deliverable.js`). The isolated-module design shrinks every touch on the contested files to a few lines:
- `package-output.js`: one require, one derive line, two writes, one manifest spread, one slot spread, one history-count tweak — all in distinct regions (imports `:14`, post-chapters `:340`, manifest `:354`, slot `:422`, history `:438`). The big package logic (guards, loudnorm, thumbnail) is untouched.
- `package-readme.js`: one self-contained `if` block, inserted between two existing sections.
- `import-deliverable.js`: additions inside the existing materialize loop and supersede cleanup; no change to dedup/identity logic.

**Shared-file reconciliation (batch-wide).** Four siblings (captions, distribution, posters, aspect_variants) edit the same four regions of `package-output.js` — the manifest literal (`:345-413`), the package state slot (`:421-430`), the history files count (`:438`), and `session_artifacts_written` (`:476`) — plus the README section list. These cannot be developed on the same lines in parallel; the batch serializes them on a shared package branch in order **posters → distribution → captions → aspect_variants**, each rebasing the manifest/slot/README edits onto the prior. The agreed canonical orders all four authors cite:
- **Manifest key order:** `chapters, captions, distribution, posters, video, aspect_variants`.
- **README section order:** `Posters` after `Thumbnail`; then `Captions, Distribution, Aspect variants` after `Chapters`, before `Target`.
- **Package slot + `summarizePackage` field order:** identical in both files (captions `_path` fields ahead of posters/variants siblings).

**Shared NEW module.** `caption-sidecar.js` is the only genuinely-shared new module in the batch, reused by **both** `package-output.js` and `import-deliverable.js` via one `buildCaptionSidecar` — no second copy. Its `- in_seconds` re-time fix is load-bearing at **both** call sites; the package fixture (small `in_seconds`) would otherwise mask the bug, which is why §8 asserts the cue start timestamp, not just the count.

**Import-side coordination.** The materialize loop (`:273-324`) and the `deliverables/manifest.json` regen (`:352-360`) are also edited by the distribution sibling: captions add a **per-record** `record.captions`, distribution adds a **top-level** `manifest.distribution` — distinct sinks, adjacent edits, so serialize the two import-side commits (small merge). The loudness mirror (`normalize:true`) already lives at `:286-297` — no PRD adds it. Both mirror PRDs add `findTimeline` / a `distributionFromStoryboard` helper from `storyboard-schema.js`; coordinate the single destructure-add at `:20`.

**Sibling-PRD dependencies.** No upstream dependency on any other sibling, and **no downstream dependency either** — the distribution sibling's `chapters_paste_block` reuses `chaptersFromStoryboard`, not `manifest.captions`, so the previously-stated "land captions first so distribution can read `manifest.captions`" dependency is **spurious and dropped**. Captions and distribution are independent on the package side; they only co-locate (distinct sinks) in the import materialize loop and the README/manifest insertion sequence, handled by the canonical orders above.

**Recommended boundaries.** One branch, three commits: (1) `caption-sidecar.js` + `paths.js` builders (no behavior change yet); (2) `package-output.js` + `package-readme.js` + `session-state.js` wiring + `package`/`longform` walker assertions; (3) `import-deliverable.js` mirror + `fanout` walker assertion. Each commit leaves the walker green. **Highest output-quality win in the batch — ship first within the package-branch serialization (the manifest/slot/README rebases are mechanical given the fixed orders above).**
