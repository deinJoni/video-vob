# PRD: Poster set — generalize the single thumbnail to N output-time frames

## 1. Summary

`vob_package_output` extracts exactly one thumbnail (`package/thumbnail.jpg`) at the storyboard hook-scene midpoint (`mcp/lib/tools/package-output.js:270-297`). This PRD generalizes that single extract into a **poster set**: `poster_0` stays `thumbnail.jpg` (the existing fatal extract, byte-for-byte unchanged), and `poster_1..n` are extracted into `package/posters/poster_<k>.jpg` at a curated, ordered list of output-time moments — the hook midpoint, each narrative-segment chapter start, and evenly-spaced percent stops — capped at `min(chapter_count+1, 5)` (or `3` with no chapters), overridable via a `VOB_POSTER_COUNT` env knob. The extra extracts run in a **separate, individually try/catch-wrapped loop** whose failures append to a `posters_warnings[]` array and **never** call `cleanupOnFailure` — an extra-poster failure can never sink an otherwise-good package. The result is surfaced via a conditional-spread `posters` manifest block (no `manifest_version` bump), a `## Posters` README section, a `package/posters_dir` state slot, and `posters_count` in `summarizePackage`. Zero new tools, zero new state schema beyond the slot, zero dependency on the in-flight `video-types.js` refactor. It is the cheapest add in the 1–7 batch and ships first.

## 2. Problem & motivation

Today a packaged single-timeline video ships exactly one still. `resolveThumbnailMoment` (`package-output.js:67-87`) computes one moment — hook-scene midpoint in output time, else a platform percent fallback — and `packageOutput` does one fatal ffmpeg extract for it (`package-output.js:270-297`). Every failure path in that extract calls `cleanupOnFailure(pkgRoot)` (`package-output.js:127-131`, invoked at :282, :289-290), which `fs.rmSync(pkgRoot, {recursive:true,force:true})` — i.e. **a thumbnail failure destroys the entire package**. That is the correct, load-bearing behavior for the *canonical* thumbnail (a package with no thumbnail is incomplete), but it is exactly the behavior we must NOT extend to optional extra posters.

Concretely, the gap:
- **One still is not enough for real distribution.** A long-form / chaptered video wants a poster per chapter for the YouTube description, A/B testing, and social cards. The storyboard already exposes chapter starts (`chaptersFromStoryboard`, `package-output.js:107-125`, returns `{segment_id,title,start_seconds,youtube_stamp,...}`) and the hook midpoint (`resolveThumbnailMoment`), but `packageOutput` consumes only the single hook moment and discards the rest.
- **No safe extraction path exists.** The only extract path in the file is fatal-on-failure. There is no loop, no `posters/` directory (`paths.js` has `packageThumbnailPath` at :331-333 but no posters builder), and no warning channel in the result.

This PRD adds the missing N-frame extraction on a non-fatal path, reusing the moment-resolution logic already in the file.

## 3. Goals / Non-goals

**Goals**
- Extract a curated, ordered, deduped set of output-time posters into `package/posters/poster_<k>.jpg`, with `poster_0` being the existing canonical `thumbnail.jpg`.
- Make `poster_1..n` extraction strictly non-fatal: any failure appends to `posters_warnings[]` and the package still completes successfully.
- Surface the set in the manifest (conditional-spread block, no version bump), the README (`## Posters`), the state package slot (`posters_dir`), and the tool result.
- Derive the poster count with zero new state/schema: default `min(chapter_count+1, 5)` when chapters exist else `3`, overridable by `VOB_POSTER_COUNT`.
- Single-timeline only — fan-out is explicitly out of scope per the locked product decision.

**Non-goals (and why)**
- **No `package_contract` / `video-types.js` preset field for the count.** Deferred because the v3-P1 `video-types.js` refactor that the concurrent 1–7 work is touching would collide with a new preset field; the count lives in a `VOB_POSTER_COUNT` env knob instead (matches the existing `VOB_*` per-process convention, zero new state). If a per-preset poster policy is ever wanted, it lands *after* the video-types refactor settles.
- **No fan-out / multi-short posters, no multi-aspect variants.** Per the locked decision, the fan-out mirror set is captions + distribution + loudness via `import-deliverable.js`; posters stay **package-only**. `packageOutput` already refuses fan-out before any work (`package-output.js:153-160`), so the poster loop is naturally single-timeline-only — no extra guarding needed.
- **No `manifest_version` bump.** The `posters` block is additive and conditional-spread; no internal consumer must distinguish a poster-aware manifest from a legacy one (README renders posters only `if` the block is present). Bumping would be churn.
- **No new tool, no new FSM edge, no gate change.** This is an additive optional output inside an existing tool on an existing phase; `ALLOWED_TRANSITIONS` / `GATES` are untouched.

## 4. Design

### 4.1 Moment resolution — generalize `resolveThumbnailMoment`

`resolveThumbnailMoment({projectId,durationSeconds,state})` (`package-output.js:67-87`) stays the canonical-moment authority and its return shape (`{seconds,strategy,hook_scene_id,...}`) is **unchanged** — `poster_0` / the `thumbnail` manifest block depend on it verbatim (`package-output.js:267-268, 377-386`). Add a sibling helper `resolvePosterMoments({projectId,durationSeconds,state,count})` in the same file that returns an **ordered, deduped** moment list:

```
resolvePosterMoments → [
  { seconds, strategy, label },   // poster_0 = the canonical thumbnail moment
  { seconds, strategy, label },   // chapter starts, then percent stops
  ...
]
```

Algorithm (pure, no I/O beyond the one storyboard read it already does):
1. Seed with the canonical moment from `resolveThumbnailMoment(...)` (so `poster_0`'s moment == `thumbnail.jpg`'s moment exactly). Strategy carried through (`hook_scene_midpoint` or `percent`).
2. Append chapter starts: read the storyboard once, call the existing `chaptersFromStoryboard(sb)` (`package-output.js:107-125`); for each chapter push `{seconds: ch.start_seconds, strategy:"chapter_start", label: ch.title}`. `null` (no segments / malformed) → skip, no error.
3. Append evenly-spaced percent stops (e.g. 25/50/75% of `durationSeconds`) tagged `strategy:"percent_stop"` — these fill the list when there are few/no chapters so the count target is reachable on any video.
4. **Clamp** each `seconds` to `[0, durationSeconds - 0.01]` (mirrors the existing clamp at `package-output.js:78, 85`).
5. **Dedupe** within ~0.5s (first-wins, preserving order) so a chapter start that coincides with the hook midpoint doesn't double-extract.
6. **Cap** the list at `count`. `poster_0` is always retained (index 0, never dropped).

`count` is resolved by a small helper `resolvePosterCount(chapters)`:
- `const env = parseInt(process.env.VOB_POSTER_COUNT, 10)` — if a finite integer `≥1`, use it (clamp to a sane ceiling, e.g. ≤12, to bound ffmpeg invocations).
- else `chapters && chapters.length > 0 ? Math.min(chapters.length + 1, 5) : 3`.

### 4.2 Extraction — `poster_0` fatal (unchanged), `poster_1..n` non-fatal

The existing canonical extract block (`package-output.js:270-297`) is **untouched** — same `-ss/-i/-vframes 1/-q:v 2` ffmpeg call, same `cleanupOnFailure` on timeout/non-zero. That IS `poster_0` and remains fatal.

After it succeeds, add a **new, separate** loop over `resolvePosterMoments(...)` indices `1..n`:
- `fs.mkdirSync(packagePostersDir(id), {recursive:true})` once before the loop.
- For each moment `k` (k≥1): build `posterPath = path.join(packagePostersDir(id), \`poster_${k}.jpg\`)`, run the same `runFfmpegBlocking([...])` shape into `posterPath`, wrapped in `try/catch`:
  - On `timed_out`, non-zero `exit_code`, missing output file, or thrown error → `postersWarnings.push({ index:k, at_seconds, strategy, label, reason })` and `continue`. **Never** call `cleanupOnFailure`.
  - On success → push a poster record `{ path:\`posters/poster_${k}.jpg\`, index:k, extracted_at_seconds, extracted_at_percent, strategy, label, file_size_bytes }`.
- `poster_0`'s record is synthesized from the already-extracted `thumbnail.jpg` (path `"thumbnail.jpg"`, index 0, the canonical moment fields) so the manifest `posters[]` is a complete ordered set including the canonical still.

The loop runs **before** the manifest is assembled (`package-output.js:345`) so `posters` and `posters_warnings` can be folded in, and after the loudnorm re-probe (the authoritative `summary`/`durationSeconds` at `package-output.js:266`). The fan-out refusal (`package-output.js:153-160`) and the package wipe (`package-output.js:224-227`) both precede the canonical extract (`:264`), so the poster loop is reached only on a single-timeline project with a freshly-built `pkgRoot` — confirmed safe.

### 4.3 Manifest shape (conditional-spread, no version bump)

Inserted into the `manifest` object literal (`package-output.js:345-413`), spread conditionally next to `thumbnail`:

```jsonc
"thumbnail": { "path": "thumbnail.jpg", ... },        // unchanged
// spread ONLY when posters has ≥1 entry (poster_0 always present ⇒ effectively always,
// but conditional keeps a degenerate empty set out of the manifest):
"posters": {
  "count": 3,
  "dir": "posters",
  "items": [
    { "path": "thumbnail.jpg",        "index": 0, "extracted_at_seconds": 1.50, "extracted_at_percent": 12.5, "strategy": "hook_scene_midpoint", "label": null,         "file_size_bytes": 84211 },
    { "path": "posters/poster_1.jpg", "index": 1, "extracted_at_seconds": 5.00, "extracted_at_percent": 41.7, "strategy": "chapter_start",      "label": "The Payoff", "file_size_bytes": 79002 },
    { "path": "posters/poster_2.jpg", "index": 2, "extracted_at_seconds": 9.00, "extracted_at_percent": 75.0, "strategy": "percent_stop",       "label": null,         "file_size_bytes": 80114 }
  ],
  // spread only when non-empty:
  "warnings": [ { "index": 3, "at_seconds": 11.9, "strategy": "percent_stop", "reason": "ffmpeg exit 1: ..." } ]
}
```

Spread idiom matches the existing `...(chapters ? {chapters} : {})` (`package-output.js:354`): `...(postersItems.length > 0 ? { posters: { count, dir:"posters", items: postersItems, ...(postersWarnings.length ? { warnings: postersWarnings } : {}) } } : {})`.

**Batch key order (manifest literal, :345-413).** This literal is edited additively by sibling PRDs 1 (captions), 3 (distribution), 5 (aspect_variants) too. All four keep `manifest_version "1.2"` (no bump). To stack the diffs cleanly, the agreed conditional-spread key order is **chapters, captions, distribution, posters, video, aspect_variants** — `posters` lands after `distribution` and before `video`. Spreads are order-independent semantically; this only fixes the textual layout so the four edits to the same lines merge mechanically rather than conflicting.

### 4.4 README `## Posters` section

In `renderPackageReadme` (`mcp/lib/package-readme.js`), add a `## Posters` block, rendered only `if (manifest.posters && Array.isArray(manifest.posters.items) && manifest.posters.items.length > 0)`:

```markdown
## Posters

- **poster_0** `thumbnail.jpg` — 1.50s (12.5%, hook scene midpoint)
- **poster_1** `posters/poster_1.jpg` — 5.00s (41.7%, chapter: The Payoff)
- **poster_2** `posters/poster_2.jpg` — 9.00s (75.0%, 75% stop)
```

Reuse `fmtSeconds` (`package-readme.js:3-9`). If `manifest.posters.warnings` is non-empty, append one italic line: `_(N extra poster(s) could not be extracted and were skipped.)_`.

**Insertion point + cross-cutting README order.** The `## Thumbnail` section ends at `package-readme.js:67`, immediately followed by the blank line at `:68` and `## Audio` at `:70`. Insert the `## Posters` block **between :67 and :69** (i.e. into the blank-line gap right after `## Thumbnail`, before `## Audio`) — Posters belongs adjacent to its sibling still. This file is a 4-way section-insertion site across the batch; to avoid a textual collision at the shared `## Chapters` (ends :98) → `## Target` (:100) anchor that PRDs 1/3/5 all target, the batch fixes one canonical section order: **Output → Thumbnail → Posters (this PRD, after Thumbnail) → Audio → Chapters → Captions → Distribution → Aspect variants → Target**. Posters is the only batch insertion at the Thumbnail anchor; Captions (PRD 1), Distribution (PRD 3), and Aspect variants (PRD 5) all insert after `## Chapters` in that order. All four authors cite this same sequence.

### 4.5 State slot, paths, history, summary

- `paths.js`: add `packagePostersDir(projectId) → path.join(packageDir(projectId), "posters")` (next to `packageThumbnailPath` at `:331-333`) and export it (alongside the `package*` exports at `:404-407`).
- `package-output.js` state slot (`:421-430`): add `posters_dir: sessionRelative(id, packagePostersDir(id))` (session-relative, matching every other `package.*` field). Also add `posters_count: postersItems.length`. (Same slot region is appended by PRDs 1 `captions_*_path` and 5 `variants[]`; order the additions identically here and in `summarizePackage` so the two regions stay in lockstep.)
- History entry (`:438`): the literal `files: 4` becomes a computed count — the existing 4 files (final/thumbnail/manifest/README) **plus** the successfully-extracted `poster_1..n`, i.e. `4 + (postersItems.length - 1)` (correct because `poster_0` IS `thumbnail.jpg`, already in the base 4). Add `posters_count` to the history record for audit.
- `session_artifacts_written` metadata array (`:476`): add `"package/posters/"`.
- `summarizePackage` (`session-state.js:489-501`): add `posters_dir: strOrNull(p.posters_dir)` and `posters_count: intOr(p.posters_count, 0)` (append in the same order as the slot adds, before/after the sibling-PRD fields per the batch slot order).
- Tool result return (`package-output.js:446-454`): add `posters_dir: packagePostersDir(id)` (absolute, matching the absolute-path return convention) and `posters_count: postersItems.length`.
- Tool `description` (`:460`): fix the stale `manifest.json (v1.1)` string → `manifest.json (v1.2)` and mention the poster set.

## 5. Seam-level change list

| File:line | Change |
|---|---|
| `mcp/lib/paths.js:333` | NEW `packagePostersDir(projectId)` after `packageThumbnailPath`. |
| `mcp/lib/paths.js:404-407` | Export `packagePostersDir` in the `package*` export group. |
| `mcp/lib/tools/package-output.js:14` | Import `packagePostersDir` from `../paths.js`. |
| `mcp/lib/tools/package-output.js:87` | NEW `resolvePosterCount(chapters)` + `resolvePosterMoments({projectId,durationSeconds,state,count})` helpers after `resolveThumbnailMoment` (which is **unchanged**). |
| `mcp/lib/tools/package-output.js:298` | NEW non-fatal poster loop (after the canonical extract at :270-297): `mkdirSync(posters/)`, iterate moments `1..n`, each `try/catch` → success record or `posters_warnings[]`; **no `cleanupOnFailure`**. Synthesize `poster_0` record from `thumbnail.jpg`. |
| `mcp/lib/tools/package-output.js:354` | Conditional-spread `...(postersItems.length>0 ? {posters:{...}} : {})` in the manifest literal, after `distribution` and before `video` per the batch key order. **No `manifest_version` bump** (stays `"1.2"` at :346). |
| `mcp/lib/tools/package-output.js:422-430` | Add `posters_dir` (session-relative) + `posters_count` to the `package` state slot. |
| `mcp/lib/tools/package-output.js:438` | History entry: `files: 4` → `files: 4 + (postersItems.length - 1)`; add `posters_count`. |
| `mcp/lib/tools/package-output.js:446-454` | Add `posters_dir` (absolute) + `posters_count` to the tool result. |
| `mcp/lib/tools/package-output.js:460` | Fix description `v1.1`→`v1.2`; note the poster set. |
| `mcp/lib/tools/package-output.js:476` | Add `"package/posters/"` to `session_artifacts_written`. |
| `mcp/lib/package-readme.js:67-69` | NEW `## Posters` section inserted into the blank-line gap after `## Thumbnail` (ends :67) and before `## Audio` (:70), rendered only when `manifest.posters.items` non-empty; warning footnote when applicable. |
| `mcp/lib/session-state.js:493-500` | `summarizePackage`: add `posters_dir`, `posters_count`. |
| `scripts/m5-walker.js:2480-2497` | `package`/`all` phase: assert `posters` manifest block, `posters/` dir, `## Posters` README, `posters_count` in summary. |
| `scripts/m5-walker.js:1635-1649` | `longform` phase: assert chaptered posters (count == `min(2+1,5)=3`, one `chapter_start` per chapter). |

**No** edits to: `index.js` (TOOL_MODULES), `SKILL.md` (allowed-tools), `settings.json` (permissions.allow), `opencode.json`, `scripts/port-adapter-docs.js`. This is an additive arg-less change to an existing tool — `verifyAdapterToolReferences` tracks tool *names*, not output shapes, so no drift guard fires.

**NEW state/manifest keys:** `state.package.posters_dir`, `state.package.posters_count`; `manifest.posters{count,dir,items[],warnings?}`. No schema-version bump anywhere.

## 6. Invariants preserved

- **`package_output`'s fan-out + unassembled-segmented refusals fire BEFORE any wipe and before any poster work.** Both throw `STATE_CONFLICT` at `package-output.js:153-160` and `:177-183`, well before `pkgRoot` is wiped (`:224-227`). All new poster code runs *after* the existing canonical extract (`:270-297`), i.e. strictly after both refusals and the wipe. A refused project never reaches the poster loop and never loses its prior package.
- **`package/` fully wiped + regenerated every run.** `package/posters/` lives *under* `pkgRoot` (`packagePostersDir = packageDir/posters`), so it is swept by the existing `fs.rmSync(pkgRoot)` at `:225` and rebuilt every run by the new `mkdirSync`. Posters are re-derived each run like the manifest/README — never appended.
- **`deliverables/` (session-level) is never touched.** Posters write only under `pkgRoot`; the wipe and the poster loop never reach `deliverablesDir` (`paths.js:347-349`).
- **No fatal coupling of optional output to package success.** This is the load-bearing requirement: `poster_1..n` are wrapped in `try/catch` and on any failure push to `posters_warnings[]` and `continue` — they **never** call `cleanupOnFailure` (`:127-131`). Only `poster_0` (the canonical `thumbnail.jpg`, unchanged at `:270-297`) keeps the fatal `cleanupOnFailure` path.
- **`state.json`/`manifest.json` written only by `vob_*` tools, atomically under the lock.** No new writers. The manifest/README writes stay at `:415-416`; the slot write stays inside `withSessionLock` at `:418-444` via `writeFileAtomic`. `posters_dir` is stored session-relative (matching `final_mp4_path`/`thumbnail_path` at `:425-426`); the tool *return* is absolute (matching `:449-451`).
- **FSM untouched.** No edge added/removed → `ALLOWED_TRANSITIONS` and `GATES` are not edited. No new blocker → no override-tier change.
- **Manifest additive-via-conditional-spread, no version bump.** Follows the `...(chapters ? {chapters} : {})` precedent (`:354`); `manifest_version` stays `"1.2"`.

## 7. Data dependencies & availability

- **Probed output duration** — `durationSeconds` from the post-loudnorm re-probe (`package-output.js:266`). Confirmed present; the existing thumbnail already clamps to it.
- **Canonical moment** — `resolveThumbnailMoment` (`:67-87`). Confirmed present; reused verbatim for `poster_0`.
- **Chapter starts** — `chaptersFromStoryboard(sbForGuard)` (`:107-125, 340`) returns `{segment_id,title,start_seconds,youtube_stamp,duration_seconds}` from narrative segments, or `null`. Confirmed present and already computed in-scope at `:340` for the chapters manifest block. Posters reuse it; `null` is handled (skip).
- **`VOB_POSTER_COUNT`** — read from `process.env` per-process, no upstream dependency. Matches existing `VOB_*` knobs (`VOB_NO_LOUDNORM`, `VOB_RENDER_WORKERS`, etc.).
- **ffmpeg** — already required and live-checked for the canonical thumbnail (`:208-221, 270`). No new dependency; posters reuse `runFfmpegBlocking`.

Nothing is blocked.

## 8. Verification

**Walker — `package` / `all` phase** (`scripts/m5-walker.js:2480-2497`). The walker source is a short single clip with a single hook scene (no narrative segments), so `chaptersFromStoryboard` returns `null` and the count defaults to `3`. Add after the existing package step:
- `const manifest = JSON.parse(fs.readFileSync(pkg.manifest_path,"utf8"))` — assert `manifest.posters && Array.isArray(manifest.posters.items)` and `manifest.posters.items.length >= 1`.
- Assert `manifest.posters.items[0].path === "thumbnail.jpg"` and `manifest.posters.items[0].index === 0` (canonical poster_0 is the thumbnail).
- Assert `fs.existsSync(path.join(pkg.directory_path,"posters"))` and that each non-zero-index item's file exists on disk.
- Assert `manifest.manifest_version === "1.2"` (unchanged — no bump).
- README: `const readme = fs.readFileSync(pkg.readme_path,"utf8")` → assert `/## Posters/.test(readme)`.
- Summary: after the `vob_read_state_summary` call (`:2499`), assert `final.package.posters_count >= 1` and `typeof final.package.posters_dir === "string"`.
- Assert `pkg.posters_count` and `pkg.posters_dir` present in the tool result.

**Walker — `longform` phase** (`scripts/m5-walker.js:1632-1649`). This project has 2 narrative segments (chapters at 0s and 5s). Add to the existing manifest assertions:
- `manifest.posters.count === Math.min(2+1,5)` (== 3).
- At least one `manifest.posters.items` entry with `strategy === "chapter_start"` whose `extracted_at_seconds === 5` and `label === "The Payoff"` (matches the existing chapter assertion at `:1640, 1646`).
- `## Posters` present in the README.

**Manual check (non-fatal proof):** set `VOB_POSTER_COUNT=12` on a short clip so percent stops crowd past the real frame count / near duration end, confirm the package still completes (`pkg` returned, `manifest.posters.warnings` may be populated, `final.mp4`+`thumbnail.jpg` intact) — proving an extra-poster failure does not sink the package.

## 9. Parallel-safety & sequencing

**Hot shared files with the 1–7 batch:**
- `mcp/lib/tools/package-output.js` — the **single hottest file**: PRDs 1 (captions), 2 (posters, this), 3 (distribution), 5 (aspect_variants) all edit the manifest literal (`:345-413`), the package state slot (`:421-430`), the history files count (`:438`), and `session_artifacts_written` (`:476`). These four cannot share those lines in parallel without serialization. The batch fixes a **serial order on a shared package branch: PRD 2 (posters, cheapest, no deps) → PRD 3 (distribution) → PRD 1 (captions) → PRD 5 (aspect_variants)**; each rebases its manifest/slot/README/history edits onto the prior. As ordered, this PRD lands **first** and defines the slot/manifest/README layout the others rebase onto (manifest key order chapters/captions/distribution/posters/video/aspect_variants; README order Thumbnail→Posters then Chapters→Captions→Distribution→Aspect variants→Target). This PRD's own edits are *localized*: a new helper after `:87`, a new loop after `:297`, one conditional-spread key at `:354`, slot/result/history/metadata adds — none touch the fan-out/segmented refusal blocks (`:138-184`) or the loudnorm block (`:255-264`).
- `mcp/lib/paths.js` — append-only `package*` builder + export; trivially mergeable.
- `mcp/lib/session-state.js::summarizePackage` (`:489-501`) — two added fields; append-only. Shared append region with PRDs 1 (`captions_*_path`) and 5 (`variants[]`); order the additions identically in the slot and here. (Distinct function from `buildStateSummary` at `:505-517`, which PRD 6 edits — no overlap.)
- `mcp/lib/package-readme.js` — one new `## Posters` section after `## Thumbnail`; 4-way section-insertion site, reconciled to the canonical section order above so the insertions don't textually collide.
- `scripts/m5-walker.js` — two phase blocks (`package`, `longform`); additive assertions.

**Dependency cut (the key to parallel-safety):** the count uses a `VOB_POSTER_COUNT` env knob, **not** a `video-types.js` / `platform-profiles.js` preset field — so this PRD has **zero** dependency on the in-flight v3-P1 video-types refactor that the batch is touching. `resolveActiveVideoType` (`:339`) is read but not modified.

**Sibling-PRD dependencies:** none. This PRD does not consume any output of PRDs 1 or 3–7, and produces nothing they require. It does not touch `import-deliverable.js` (the captions/distribution fan-out mirror site) or `transition-phase.js` / `transitionPhase` (the PRD 6/7 collision region).

**Sequencing:** ship **first** in the batch — it is the cheapest add, has no sibling dependency, and the env-knob design removes the only collision risk (the video-types field). Recommended branch off `v3/general-video`, single self-contained commit: paths.js + package-output.js + package-readme.js + session-state.js + walker assertions together (the manifest/README/state shapes must change atomically or the walker's new assertions fail).
