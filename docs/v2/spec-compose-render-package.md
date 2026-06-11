# WP4 spec — compose-render-package (D6 composition QC + render verification, D7 font kit engine side)

Binding scope: `docs/v2/DESIGN-BRIEF.md` D6, D7-engine, plus the D2 runner items assigned to WP4
(net::ERR retry fix, stderr ring buffer, source-symlink stale comment). Baseline = current code on
`v2/fable-rework`; all line refs below are against that baseline.

## 0. File inventory

Owned (edited) by WP4:
- `mcp/lib/composition-qc.js` — NEW
- `mcp/lib/render-verify.js` — NEW
- `mcp/lib/tools/save-composition.js` (QC pre-check + font injection; applied AFTER WP1's confirm-reset edit)
- `mcp/lib/composition-files.js` (no behavior change; one new export — see §3.6)
- `mcp/lib/tools/lint-composition.js` (QC merge)
- `mcp/lib/lint-report.js` (`source` field on findings)
- `mcp/lib/tools/snapshot-keyframes.js` (storyboard-default timecodes, tail previews)
- `mcp/lib/tools/render-preview.js` (verification, duration-aware timeout, stderr log)
- `mcp/lib/tools/render-full.js` (verification, duration-aware timeout, quality default)
- `mcp/lib/hyperframes-runner.js` (renderTimeoutMs, defaultRenderQuality, retry classifier)
- `mcp/lib/ffmpeg-runner.js` (buildClipCutArgv rework, loudnorm builders)
- `mcp/lib/spawn-with-shutdown.js` (head+tail ring buffer, `stderrTail` helper)
- `mcp/lib/clip-materialize.js` (bounded-parallel cuts; **signature stable**)
- `mcp/lib/source-symlink.js` (font-kit injection, stale-comment fix)
- `mcp/lib/tools/package-output.js` (hook thumbnail, loudnorm, manifest v1.1)
- `mcp/lib/package-readme.js` (Audio section)
- `mcp/assets/fonts/*` (already on disk, untracked — commit as part of WP4) + `mcp/assets/fonts.css` — NEW
- `mcp/lib/overlay-compositor.js` — NO functional change (listed for ownership only; the
  `stderrTail` call-site update in §9.3 applies)

Read-only dependencies (NOT edited): `mcp/lib/concurrency.js`, `mcp/lib/ffprobe.js`,
`mcp/lib/storyboard-schema.js`, `mcp/lib/paths.js` (WP3-owned; WP4 requests **nothing** — the
preview log path is computed inline, §7.3), `mcp/lib/phase-gates.js` (WP1), `mcp/lib/storage.js`,
`mcp/lib/envelope.js`.

## 1. Cross-WP hand-offs (exact)

| Touch point | Owner | Hand-off |
|---|---|---|
| `save-composition.js` preview/render confirm reset | WP1 edits first | WP1 adds `preview`/`render` reset fields inside the `next` object (save-composition.js:75-103). WP4 edits the same function but only: (a) inserts the QC pre-check between `validateCompositionFiles` (line 34) and `withSessionLock` (line 43); (b) inserts `injectFontKit` after `recreateSourceSymlinks` (line 66); (c) adds `qc` and `fonts` keys to the `composition` slot. WP4 must not touch the `preview`/`render` keys WP1 writes. Merge order: WP1's diff lands, then WP4's. |
| `render-preview.js` / `render-full.js` `composition_revision_rendered` stamp | WP1 | WP1 adds one field to the committed `preview`/`render` slot. WP4 adds `verification` (object), `stderr_log_path` (preview), `quality` (render) to the SAME slot. Field-disjoint; same merge order (WP1 then WP4). Final slot shapes in §8.4. |
| `phase-gates.js` | WP1 | WP4 does NOT edit gates. The missing scene-clip-resolution check that source-symlink.js:158-161 falsely claims exists is implemented as QC error `vob/source_ref_target_missing` at save and lint time (§3.3 E2b) — gates stay as-is. WP4 fixes the comment (§11.2). |
| ≤10 findings inline (D1) | WP1 owns D1 generally | The lint/save inline-findings cap is implemented HERE (lint-composition.js is WP4-owned). WP1 must not also edit lint-composition.js. |
| Composer/orchestrator consumption of QC rejects, verification fields, snapshot defaults | WP5 | Contract in §13. WP5 writes the prose; WP4 guarantees the shapes. |
| OpenCode prompt mirror, m5-walker fixtures | WP6 | Walker composition fixture must be QC-clean (§14.3 checklist). Return-shape deltas the walker asserts: save result gains `qc`, lint result `findings_summary` capped at 10 + gains `qc_*` counts, render results gain `verification`. |
| NOTICE font attribution | WP7 | Exact text block in §12.4. WP7 appends it to `NOTICE`. |
| `paths.js` additions | WP3 | None requested. Preview log path = `path.join(rendersDir(id), "preview-<ts>.log")` computed inline (mirrors render-full.js:79's inline `render-<ts>.log`). |

## 2. Design rationale — what is robustly statically checkable

Checkable (zero-dep, deterministic over machine-generated HTML):
- attribute presence/values on tags (Rule-of-Three, `data-media-start`, `class="clip"`) — composer
  output is flat attribute-bearing HTML; a tag/attr regex scan is reliable on it.
- `./source/<name>` reference resolution — the expected name set is computable from
  `resolveSourceLinks`/`resolveSceneClipLinks` (source-symlink.js:43-108) and target existence is an
  `fs.existsSync`.
- counts (`<video>` elements), numeric comparisons (master `data-duration` vs Σ scene durations).

NOT checkable statically (dropped; covered by snapshot self-QC in D8/WP5 instead): contrast,
safe-band placement (needs layout), overlay collisions, black frames, animation correctness,
cascade-resolved computed styles.

Heuristic, kept at WARN only: caption font-size. Strategy (§3.4 W3): match `font-size: <N>px`
declarations whose selector contains a caption-marked class, in linked `.css` files, `<style>`
blocks, and inline `style=""` attrs. px-only; `rem`/`em`/`vw`/`clamp()` are skipped (not evaluated
— no false positives from unit math). No caption-classed element or no px declaration → silence.
This can false-positive only when a LATER cascade rule overrides upward — acceptable at warn level;
it can never block.

## 3. NEW `mcp/lib/composition-qc.js`

Pure functions, Node stdlib only (`fs`, `path`). No state reads, no locks.

### 3.1 Exports

```js
module.exports = {
  QC_VIDEO_HARD_CAP,        // 8
  QC_VIDEO_BUDGET,          // 6
  QC_MASTER_DURATION_TOLERANCE_S, // 0.5
  QC_MEDIA_START_TOLERANCE_S,     // 0.05
  QC_MIN_CAPTION_FONT_PX_VERTICAL, // 56
  extractTags,              // (html) => Tag[]
  runCompositionQc,         // (input) => QcResult
};
```

### 3.2 HTML/CSS parse helpers

```js
// Tag = { name: string (lowercased), attrs: { [lowerAttrName]: string }, index: number, line: number }
function extractTags(html)
```
- Opening-tag regex: `/<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g` (tolerates
  multiline attribute blocks; quoted `>` inside attr values does not terminate the tag).
- Attribute regex over capture 2: `/([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g`.
  Valueless attrs (e.g. `muted`) get value `""`. Attr names lowercased; first occurrence wins.
- `line` = 1 + count of `\n` in `html.slice(0, index)`.
- Skips `<!-- -->` comment bodies: strip comments (`/<!--[\s\S]*?-->/g`, replacing with equal-length
  whitespace-preserving filler containing the same number of `\n`) BEFORE tag scan so line numbers
  stay true.

### 3.3 `runCompositionQc(input)` — input/output contract

```js
runCompositionQc({
  files,            // [{ relPath: string, content: string }] — .html and .css entries only are inspected
  storyboard,       // parsed storyboard.json object | null (caller reads it; null = unreadable/missing)
  sourceLinks,      // resolveSourceLinks(id) tuples   (may be [])
  sceneClipLinks,   // resolveSceneClipLinks(id) tuples (may be [])
  checkTargetsOnDisk, // boolean — when true, fs.existsSync each referenced link target
}) => {
  findings: [{ severity: "error"|"warning", rule: string, message: string,
               file: string|null, line: number|null, column: null, source: "vob" }],
  error_count: number,
  warning_count: number,
}
```

Master root = the FIRST tag in `index.html` carrying `data-composition-id`. Sub-roots = any other
tag with `data-composition-id` in any `.html` file. Scene-clip ref = a `src` attribute on a
`video|audio|img|source` tag matching `/^\.\/source\/(.+)$/`.

If `storyboard` is `null`: emit ONE warning `vob/storyboard_unreadable`
("storyboard.json missing or unparseable — skipped storyboard-conformance checks (E2, E4, E5)") and
skip E2/E4/E5 entirely (the expected-name set would be wrong). E1/E3/E6/W1–W4 still run.

### 3.4 Check list — exact rules, severities, messages

ERRORS (reject the save; block lint):

| rule | trigger | message template |
|---|---|---|
| `vob/missing_root_attr` | master root (or any sub-root) lacks one of `data-composition-id`\*, `data-width`, `data-height`; master root additionally lacking a finite positive `data-duration`. One finding per missing attr. \*If NO tag in index.html has `data-composition-id`, emit a single finding with message variant (b). | (a) `composition root <tag@line N> is missing required attribute "<attr>" (Rule of Three / master duration)` (b) `index.html has no element with data-composition-id — hyperframes cannot discover the composition` |
| `vob/unresolved_source_ref` | a `./source/<name>` ref where `<name>` ∉ (basenames of `sourceLinks`) ∪ (`<scene_id>-<clip_index>.mp4` names of `sceneClipLinks`) | `src "./source/<name>" (<file>:<line>) does not match any manifest source or storyboard scene clip — it will 404 at render (net::ERR_FILE_NOT_FOUND)` |
| `vob/source_ref_target_missing` | (only when `checkTargetsOnDisk`) ref name IS expected but the link target (`clip_abs` / `source_abs`) does not exist on disk | `src "./source/<name>" (<file>:<line>) refers to scene clip <scene_id>-<k> whose pre-cut file is missing at <clip_abs> — re-enter COMPOSE to materialize clips` |
| `vob/absolute_src_path` | any `src` attr on `video|audio|img|source` starting with `/` or matching `/^file:/i` or `/^[A-Za-z]:\\\\/` | `src "<value>" (<file>:<line>) is an absolute filesystem path — compositions must reference ./source/ (or ./fonts/) relative paths only` |
| `vob/master_duration_short` | master `data-duration` parses finite AND storyboard present AND `masterDuration < sumSceneDurations - 0.5` where `sumSceneDurations = Σ scenes[].target_duration_seconds` | `master data-duration <D>s is shorter than the storyboard scene total <S>s by more than 0.5s — the timeline will truncate and the tail is silently dropped` |
| `vob/scene_missing_clip` | a storyboard scene with `source_clips.length > 0` whose `scene_id` has NO `./source/<scene_id>-` prefixed ref in any `.html`. Overlay-only scenes (empty `source_clips`) exempt. **OVERLAY-MODE EXEMPTION:** when the composition contains ZERO `<video>` tags across all `.html` files (the overlay-over-base signature — SKILL.md's documented escape hatch renders graphics as a transparent overlay with no `<video>`, cuts the base with ffmpeg, and composites via `vob_import_deliverable`), this check emits NO errors; instead emit ONE warning `vob/overlay_scene_missing_clip` (below). A composition WITH `<video>` elements that covers only a subset of scenes still errors per uncovered scene (deliberate — partial coverage with clips is a real authoring bug, not the overlay path). | `storyboard scene "<scene_id>" (sequence <n>) has no clip element referencing ./source/<scene_id>-*.mp4 — the scene would be missing from the render` |
| `vob/video_count_exceeds_hard_cap` | total `<video>` tag count across all `.html` files > 8 | `composition has <N> <video> elements (hard cap 8) — headless Chrome on the reference host cannot survive this; concatenate the A-roll spine into one clip` |

WARNINGS (ride into result + state + lint report; never block):

| rule | trigger | message template |
|---|---|---|
| `vob/video_count_over_budget` | video count in (7..8] | `composition has <N> <video> elements (budget 6 on a low-RAM host) — consider concatenating spine clips` |
| `vob/scene_clip_media_start_nonzero` | a `video|audio` tag whose `src` matches a scene-clip name AND `Number(data-media-start) > 0.05` | `<file>:<line> scene clip "<name>" has data-media-start="<v>" — pre-cut clips are already trimmed; non-zero offsets re-introduce the deep-seek failure mode` |
| `vob/timed_element_missing_clip_class` | tag with BOTH `data-start` and `data-duration`, WITHOUT `data-composition-id`, whose `class` attr is absent or fails `/\bclip\b/` | `<file>:<line> <<tag>> has data-start/data-duration but no class="clip" — it will render static for the whole composition (pre-empting hyperframes lint timed_element_missing_clip_class)` |
| `vob/caption_font_size_small` | vertical composition (master `data-height` > `data-width`) AND a caption font-size detection (below) finds a px value < 56 | `caption selector "<sel>" sets font-size <N>px (<file>:<line>) — below the 56px floor for vertical/short-form legibility` |
| `vob/overlay_scene_missing_clip` | the overlay-mode exemption above fired: zero `<video>` elements AND N ≥ 1 storyboard scenes with `source_clips` have no `./source/<scene_id>-*` ref. ONE finding total (not per scene). | `overlay composition: <N> storyboard scene(s) have no clip element — confirm this is the overlay-over-base path (transparent overlay rendered here, base cut with ffmpeg, composited via vob_import_deliverable); if you meant to cut the timeline in hyperframes, add the scene clip elements` |

Caption font-size detection (W3) exact algorithm:
1. Collect "caption classes": every class token containing the substring `caption`
   (case-insensitive) on any tag in any `.html` file. If none → done, no finding.
2. Scan declarations in (a) every `.css` file content, (b) every `<style>...</style>` block in
   `.html` files, with regex per caption class `C`:
   `new RegExp("([^{}]*\\." + escapeRegExp(C) + "[^{}]*)\\{([^}]*)\\}", "g")`, then within the body
   `/font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/i`.
3. Also scan inline `style` attrs of tags whose `class` contains a caption class with the same
   `font-size` regex.
4. Report each match with px < 56. Non-px units: skipped silently.

### 3.5 What was deliberately dropped
- CSS cascade/specificity resolution, `var()`/`clamp()` evaluation — fragile; would need a CSS
  engine. Snapshot self-QC (WP5) covers the rendered truth.
- Safe-band position checks (`bottom:`/`top:` offsets) — requires resolved layout; same coverage.
- JS-driven `src` assignment scanning — composer contract is static HTML; not scanned.

### 3.6 `composition-files.js` change
Add one export (no behavior change): `htmlAndCssEntries(normalized)` → filters the validator's
`normalized` array to `relPath` ending `.html`/`.css` and maps to `{ relPath, content }` — the
exact `files` input for `runCompositionQc` at save time. (Keeps the QC module free of validator
coupling; lint-time callers build the same shape from disk.)

## 4. `mcp/lib/tools/save-composition.js`

### 4.1 QC pre-check (insert between line 41 and line 43, BEFORE the lock/wipe)

```js
const { runCompositionQc } = require("../composition-qc.js");
const { htmlAndCssEntries } = require("../composition-files.js");
const { resolveSceneClipLinks, resolveSourceLinks, injectFontKit } = require("../source-symlink.js");
const { storyboardPath } = require("../paths.js");

// after validateCompositionFiles passes:
let storyboard = null;
try { storyboard = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8")); } catch { storyboard = null; }
if (storyboard && (typeof storyboard !== "object" || Array.isArray(storyboard))) storyboard = null;

const qc = runCompositionQc({
  files: htmlAndCssEntries(verdict.normalized),
  storyboard,
  sourceLinks: resolveSourceLinks(id),
  sceneClipLinks: resolveSceneClipLinks(id),
  checkTargetsOnDisk: true,   // clips were materialized at COMPOSE entry; missing = real problem
});
if (qc.error_count > 0) {
  throw new ToolError(
    ERROR_CODES.INVALID_ARGUMENTS,
    `composition QC failed: ${qc.error_count} error(s) — ${qc.findings
      .filter((f) => f.severity === "error").slice(0, 3).map((f) => f.rule).join(", ")}. Fix and re-save.`,
    { qc_findings: qc.findings.slice(0, 10), qc_error_count: qc.error_count, qc_warning_count: qc.warning_count },
  );
}
```
Key property: rejection happens BEFORE `wipeComposeDir` — a QC-failing save leaves the prior
composition (and its lint status) fully intact, exactly like a schema-failing save today.

### 4.2 Font injection (after `recreateSourceSymlinks`, line 66)

```js
const fontResult = injectFontKit(composeRoot, { skipCss: writtenRelPaths.includes("fonts.css") });
```
(§11.1 defines `injectFontKit`.) Its `warnings` are appended to `symlinkResult.warnings` before the
`source_link_warnings` spread at lines 84-86.

### 4.3 State + result additions
`composition` slot gains (alongside WP1's preview/render resets, which live OUTSIDE this slot):
```js
qc: { error_count: 0, warning_count: qc.warning_count, findings: qc.findings.slice(0, 10) }, // errors never stored — they reject
fonts: { linked: fontResult.linked, css_path: fontResult.linked ? "fonts.css" : null },
```
Tool result gains the same `qc` object and `fonts_linked: boolean`. History `composition_saved`
entry gains `qc_warning_count`.

Back-compat: legacy `state.composition` without `qc`/`fonts` keys — no reader requires them; all
consumers (`lint-composition`, WP5 prose) treat absence as "no QC data" / "no fonts".

### 4.4 Description rewrite (token: 1065 → ≤460 chars)
DELETE the entire current description string (save-composition.js:118). REPLACE with:
> "Save the hyperframes composition: map of relative-path → content (index.html required; .html/.css/.js/.json/.svg; ≤64 files, ≤256KiB each, ≤1MiB total). Fully replacing. The engine recreates ./source/ symlinks and the ./fonts.css font kit, runs static QC (errors reject with details.qc_findings), resets lint_status to 'unknown' and preview/render confirmation, and bumps revision_count."

`inputSchema` unchanged.

## 5. `mcp/lib/tools/lint-composition.js` + `mcp/lib/lint-report.js`

### 5.1 lint-report.js
`normalizeFinding` (lint-report.js:23-45) gains `source: "hyperframes"` in both return branches.
No other change. Finding object is now canonically:
`{ severity, rule, message, file, line, column, source }` with `source ∈ {"vob","hyperframes"}`.

### 5.2 lint-composition.js — QC re-run + merge (insert after `parseLintReport` succeeds, line 88)

```js
const compositionFiles = composition.files.filter((rel) => /\.(html|css)$/i.test(rel));
const qcFiles = [];
for (const rel of compositionFiles) {
  try { qcFiles.push({ relPath: rel, content: fs.readFileSync(path.join(composeRoot, rel), "utf8") }); } catch {}
}
let storyboard = null;
try { storyboard = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8")); } catch { storyboard = null; }
const qc = runCompositionQc({
  files: qcFiles, storyboard,
  sourceLinks: resolveSourceLinks(id), sceneClipLinks: resolveSceneClipLinks(id),
  checkTargetsOnDisk: true,
});
const findings = [...qc.findings, ...report.findings];   // vob findings first (more actionable)
const errorCount = report.error_count + qc.error_count;
const warningCount = report.warning_count + qc.warning_count;
const infoCount = report.info_count;
const lintStatus = errorCount > 0 ? "errors" : warningCount > 0 ? "warnings_only" : "clean";
```
`lintStatusFromReport` is no longer called here (counts are merged); it stays exported for any
other caller. Rationale for re-running QC at lint despite the save-time gate: lint re-checks DISK
truth — clips deleted since save, storyboard changed via PLAN back-edge without a re-save, or a
legacy pre-v2 save all surface here. The overlay-mode exemption (§3.4 `vob/scene_missing_clip` →
`vob/overlay_scene_missing_clip`) lives inside `runCompositionQc`, so it applies identically at
save time and lint time — a zero-`<video>` overlay composition lints `warnings_only` (or clean)
and can pass COMPOSE→PREVIEW.

### 5.3 Report file format (compose/lint-report.json) — version 2
```js
{
  report_version: 2,                       // NEW (absent = v1)
  lint_status, error_count, warning_count, info_count,   // MERGED counts
  findings,                                // merged list, every finding carries `source`
  qc: { error_count, warning_count },      // NEW — engine-side split
  hyperframes: { error_count: report.error_count, warning_count: report.warning_count, info_count: report.info_count }, // NEW
  raw: report.raw, exit_code, stderr_preview, ran_at,
}
```
Readers of v1 reports (none programmatic; humans + WP5 prose) are unaffected — all v1 fields keep
their names; counts simply now include QC findings.

### 5.4 Result + state + history
- `findings_summary`: **errors first, then warnings, then info; `vob` before `hyperframes` within a
  class; sliced to 10** (was unordered slice 20 at line 148) — implements D1's ≤10 cap.
- Result gains `qc_error_count`, `qc_warning_count`.
- `lint_ran` history entry gains `qc_error_count`, `qc_warning_count`.
- Timed-out / unparseable branches: unchanged except previews switch to `stderrTail` (§9.3).

### 5.5 Description rewrite (token: ~575 → ≤340 chars)
DELETE current description (line 156). REPLACE:
> "Run hyperframes lint plus the engine's static QC over compose/ and merge both into one findings report (compose/lint-report.json; findings carry source:'vob'|'hyperframes'). Sets composition.lint_status — errors block COMPOSE->PREVIEW, warnings are accept-or-fix. Returns merged counts + first 10 findings + report_path."

## 6. `mcp/lib/tools/snapshot-keyframes.js`

### 6.1 Preconditions — verified, one loosening needed: none
Current preconditions (lines 30-47): `compose/index.html` on disk + `state.composition.files`
non-empty. There is NO phase check, NO lint check, NO preview requirement — the tool is already
callable in COMPOSE immediately after a successful save. **No precondition code change.** Add a
comment above the handler stating this explicitly (replacing the current comment's "the user
catches" framing):
```
// Callable in COMPOSE the moment a composition is saved — deliberately NOT
// gated on lint or preview. It is the orchestrator's pre-render self-QC tool
// (snapshot ~10-60s vs minutes for a draft render).
```

### 6.2 Storyboard-default timecodes (replaces the bare `frames` fallback path)
When `args.timecodes` is absent/empty: attempt storyboard defaults before falling back to evenly
spaced frames.
```js
function storyboardDefaultTimecodes(projectId) {
  let sb = null;
  try { sb = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8")); } catch { return null; }
  if (!sb || !Array.isArray(sb.scenes) || sb.scenes.length === 0) return null;
  const out = [];
  let cursor = 0;
  for (const scene of sb.scenes) {
    const d = Number(scene && scene.target_duration_seconds);
    if (!Number.isFinite(d) || d <= 0) return null;       // malformed -> no defaults
    out.push(Math.round((cursor + Math.min(0.5, d / 2)) * 1000) / 1000); // just inside each scene
    cursor += d;
  }
  return out.slice(0, MAX_FRAMES);
}
```
Selection order: explicit `timecodes` → `storyboardDefaultTimecodes()` → `--frames N` (N =
`args.frames` or 5). Result gains `timecode_source: "explicit"|"storyboard_scenes"|"even_spacing"`.
The `keyframes_snapshotted` history entry gains the same field.
Rationale for `start + min(0.5, dur/2)`: a frame exactly ON a scene boundary is ambiguous (either
scene may render); 0.5s inside shows the scene's settled state including entrance-animated
captions, and the hook frame lands at ≈0.5s — the cold-open moment D8's checklist inspects.

### 6.3 Error previews
Lines 82, 86, 90: replace `(result.stderr || "").trim().slice(0, 2000|1000)` with
`stderrTail(result.stderr, 2000|1000)` (§9.3).

### 6.4 Description rewrite (token: ~810 → ≤420 chars)
DELETE current description (line 144). REPLACE:
> "Render full-resolution PNG stills + contact-sheet.jpg of the CURRENT composition via hyperframes snapshot. Callable in COMPOSE right after a save — no lint/preview required; this is the pre-render visual QC tool. timecodes (seconds) win; default = one frame just inside each storyboard scene; else `frames` evenly spaced. BLOCKING ~10–60s. Next save wipes compose/snapshots/."

`inputSchema` unchanged.

## 7. Render timeouts, preview log, quality default — `hyperframes-runner.js` + render tools

### 7.1 `renderTimeoutMs` (NEW in hyperframes-runner.js; export it)
```js
const RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS = 20 * 1000;       // preview (draft)
const FULL_RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS = 40 * 1000;  // full
const RENDER_TIMEOUT_CEILING_MS = 2 * 60 * 60 * 1000;             // preview ceiling 2h
const FULL_RENDER_TIMEOUT_CEILING_MS = 3 * 60 * 60 * 1000;        // full ceiling 3h

// kind: "preview" | "full". durationSeconds: storyboard total or null.
// Env override (positive int ms) wins outright: VOB_RENDER_TIMEOUT_MS (preview),
// VOB_FULL_RENDER_TIMEOUT_MS (full). Otherwise scale by composition duration,
// FLOORED at today's fixed caps (15/30 min) and ceilinged to keep a runaway
// storyboard from creating a day-long wall.
function renderTimeoutMs(kind, durationSeconds) {
  const envName = kind === "full" ? "VOB_FULL_RENDER_TIMEOUT_MS" : "VOB_RENDER_TIMEOUT_MS";
  const env = Number.parseInt((process.env[envName] || "").trim(), 10);
  if (Number.isInteger(env) && env > 0) return env;
  const floor = kind === "full" ? FULL_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS;
  const perSec = kind === "full" ? FULL_RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS : RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS;
  const ceiling = kind === "full" ? FULL_RENDER_TIMEOUT_CEILING_MS : RENDER_TIMEOUT_CEILING_MS;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return floor;
  return Math.min(ceiling, Math.max(floor, Math.round(durationSeconds * perSec)));
}
```
`RENDER_TIMEOUT_MS`/`FULL_RENDER_TIMEOUT_MS` constants stay exported (they are the floors).

### 7.2 `defaultRenderQuality` (NEW in hyperframes-runner.js; export it)
```js
// Final-render quality default, gated like renderWorkerArgs:
//   VOB_RENDER_QUALITY = "high"|"standard" -> that value;  "default" -> null (omit flag)
//   unset: >=10 GB RAM -> "high"; low-RAM host -> null (hyperframes' standard)
function defaultRenderQuality() {
  const raw = (process.env.VOB_RENDER_QUALITY || "").trim().toLowerCase();
  if (raw === "high" || raw === "standard") return raw;
  if (raw === "default") return null;
  let totalmem = 0;
  try { totalmem = os.totalmem(); } catch { totalmem = 0; }
  if (totalmem >= LOW_RAM_BYTES) return "high";
  return null;
}
```

### 7.3 `render-preview.js` changes
- Read storyboard total once (safe): `let sbTotal = null; try { sbTotal = Number(JSON.parse(fs.readFileSync(storyboardPath(id), "utf8")).total_target_duration_seconds) || null; } catch {}`
- `const timeoutMs = renderTimeoutMs("preview", sbTotal);` — replaces `RENDER_TIMEOUT_MS` at line 53.
- Stderr log (parity with render-full): `const ts0 = filenameSafeTimestamp();`
  `const outPath = path.join(rendersRoot, \`preview-${ts0}.mp4\`);`
  `const stderrLogPath = path.join(rendersRoot, \`preview-${ts0}.log\`);` and pass
  `{ timeoutMs, stderrLogPath, maxAttempts: 3 }` to `runHyperframesWithRetry`.
- Timeout/failure ToolError messages gain `— partial log at ${stderrLogPath}` and details gain
  `stderr_log_path`; previews switch to `stderrTail`.
- After success: `const verification = verifyRenderedMp4({ mp4Path: outPath, expectedDurationSeconds: sbTotal });` (§8).
- Committed `preview` slot and result gain `stderr_log_path` and `verification` (§8.4).
- `session_artifacts_written` gains `"renders/preview-*.log"`.
- Description rewrite (≤360 chars), DELETE current (line 128), REPLACE:
> "Render a draft MP4 to renders/preview-<ts>.mp4, teeing stderr to renders/preview-<ts>.log. BLOCKING; timeout scales with storyboard duration (≥15 min; VOB_RENDER_TIMEOUT_MS overrides). Success returns render_path + ffprobe `verification` (duration drift vs storyboard, dims, audio) and resets preview confirmation. Failure throws without touching state."

### 7.4 `render-full.js` changes
- Quality: `const quality = args && args.quality != null ? String(args.quality) : defaultRenderQuality();`
  (validation against `RENDER_QUALITIES` unchanged; `null` still omits the flag). Delete the
  comment block lines 33-37 (now wrong) and replace with one line:
  `// Quality: explicit arg wins; else defaultRenderQuality() (high on >=10GB hosts). Docker is never an option.`
- `const timeoutMs = renderTimeoutMs("full", sbTotal);` (same storyboard read as preview) —
  replaces `FULL_RENDER_TIMEOUT_MS` at line 113.
- After success: `verification` via `verifyRenderedMp4` (§8).
- Committed `render` slot and result gain `verification` and `quality` (string|null = engine
  default). `render_started` history entry: `expected_quality` value becomes the resolved quality
  string or `"standard(default)"` when null (was the literal `"full"` — a misnomer; WP6's walker
  does not assert it).
- Error previews → `stderrTail`.
- Description rewrite (≤500 chars), DELETE current (line 194), REPLACE:
> "Render the final MP4 to renders/final-<ts>.mp4, teeing stderr to renders/render-<ts>.log (tail -f for progress). Requires preview.confirmed:true. quality: explicit 'standard'|'high', else defaults to 'high' on ≥10GB-RAM hosts (VOB_RENDER_QUALITY overrides). BLOCKING; timeout scales with storyboard duration (≥30 min; VOB_FULL_RENDER_TIMEOUT_MS overrides). Success returns mp4_path, file_size_bytes, stderr_log_path + ffprobe `verification`, and resets render confirmation. Failure leaves only the render_started audit entry."

## 8. NEW `mcp/lib/render-verify.js`

```js
"use strict";
const { probeFile, summarizeProbe } = require("./ffprobe.js");

const DURATION_DRIFT_THRESHOLD_S = 0.5;

// Post-render verification: ffprobe the MP4 and compare to the storyboard
// expectation. NEVER throws — a probe failure must not fail a succeeded render.
function verifyRenderedMp4({ mp4Path, expectedDurationSeconds = null }) {
  try {
    const summary = summarizeProbe(mp4Path, probeFile(mp4Path));
    const dur = Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null;
    const expected = Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : null;
    const drift = dur !== null && expected !== null ? Math.round((dur - expected) * 1000) / 1000 : null;
    return {
      probed: true,
      error: null,
      duration_seconds: dur,
      width: summary.primary_video ? summary.primary_video.width : null,
      height: summary.primary_video ? summary.primary_video.height : null,
      has_audio: summary.has_audio === true,
      expected_duration_seconds: expected,
      duration_drift_seconds: drift,
      drift_exceeds_threshold: drift !== null && Math.abs(drift) > DURATION_DRIFT_THRESHOLD_S,
    };
  } catch (error) {
    return {
      probed: false, error: String((error && error.message) || error),
      duration_seconds: null, width: null, height: null, has_audio: null,
      expected_duration_seconds: Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : null,
      duration_drift_seconds: null, drift_exceeds_threshold: false,
    };
  }
}

module.exports = { DURATION_DRIFT_THRESHOLD_S, verifyRenderedMp4 };
```

### 8.4 Final state-slot shapes (combined WP1+WP4; field ownership marked)
```js
preview: {
  render_path, rendered_at, render_duration_seconds,          // existing
  confirmed: false, confirmed_at: null, revision_count,        // existing
  stderr_log_path,                                             // WP4
  composition_revision_rendered,                               // WP1
  verification: { ...§8 shape },                               // WP4
}
render: {
  mp4_path, rendered_at, render_duration_seconds, file_size_bytes, stderr_log_path, // existing
  confirmed: false, confirmed_at: null, revision_count,        // existing
  quality,                                                     // WP4 (string|null)
  composition_revision_rendered,                               // WP1
  verification: { ...§8 shape },                               // WP4
}
```
History: `preview_rendered` / `render_completed` entries gain `duration_drift_seconds`
(`verification.duration_drift_seconds`, may be null). Legacy sessions: all new fields absent —
no gate reads `verification`/`quality`/`stderr_log_path` (advisory), so reads/transitions are
unaffected (brief's back-compat constraint holds).

## 9. `mcp/lib/spawn-with-shutdown.js` — ring buffer + tail helper; retry classifier fix

### 9.1 Head+tail ring buffer (replaces the head-only capper, lines 146-179, and the file-readback
truncation, lines 81-84)
Per stream, with `half = Math.floor(maxOutputBytes / 2)`:
```js
function makeCapper(half) {
  const head = []; let headBytes = 0;
  const tail = []; let tailBytes = 0; let dropped = 0;
  return {
    push(chunk) {
      if (headBytes < half) {
        const take = Math.min(chunk.length, half - headBytes);
        head.push(chunk.subarray(0, take)); headBytes += take;
        chunk = chunk.subarray(take);
        if (chunk.length === 0) return;
      }
      tail.push(chunk); tailBytes += chunk.length;
      while (tailBytes > half && tail.length > 0) {
        const first = tail[0];
        const excess = tailBytes - half;
        if (first.length <= excess) { tail.shift(); tailBytes -= first.length; dropped += first.length; }
        else { tail[0] = first.subarray(excess); tailBytes -= excess; dropped += excess; }
      }
    },
    truncated() { return dropped > 0; },
    toBuffer() {
      if (dropped === 0) return Buffer.concat([...head, ...tail]);
      const marker = Buffer.from(`\n[... ${dropped} bytes elided ...]\n`, "utf8");
      return Buffer.concat([...head, marker, ...tail]);
    },
  };
}
```
- stdout pipe path and stderr path each use one capper; `*_truncated` = `capper.truncated()`.
- stderr tee to the log file is UNCHANGED (full stream still written before capping, lines 163-166).
- `finalizeStdoutFile`: when `buf.length > maxOutputBytes`, return
  `Buffer.concat([buf.subarray(0, half), Buffer.from(marker), buf.subarray(buf.length - half)])`
  with the same marker text; set `stdoutTruncated = true`. (A truncated lint JSON fails parse
  either way; lint-composition.js:74-80 already classifies that distinctly.)
- Effect on retry classification: `runHyperframesWithRetry`'s `blob` (hyperframes-runner.js:374)
  now always contains the TERMINAL stderr, so a transient crash after >4MiB of progress output
  matches `RETRYABLE_PATTERNS` again.

### 9.2 The marker must not create false retry matches
The marker text contains no pattern words. Add a one-line comment noting markers must stay free of
`net::ERR`/`Protocol error`-class substrings.

### 9.3 `stderrTail` helper (NEW export)
```js
// Tail-slice for error previews: a long render's stderr starts with banner +
// progress spam; the real error is at the END.
function stderrTail(stderr, maxLen = 2000) {
  const s = (stderr || "").trim();
  if (s.length <= maxLen) return s || null;
  return `…${s.slice(s.length - maxLen)}`;
}
```
Call-site conversions (all `slice(0, N)` previews become `stderrTail(x, N)`), WP4-owned files only:
`render-preview.js` (3 sites), `render-full.js` (4), `snapshot-keyframes.js` (3),
`lint-composition.js` (2 — the `stderr_preview` in the report body and the parse-failure branch),
`clip-materialize.js` (2), `package-output.js` (2), `overlay-compositor.js` (its failure preview).
WP1 owns envelope.js — untouched.

### 9.4 Retry classifier fix (hyperframes-runner.js)
Insert into `NON_RETRYABLE_PATTERNS` (line 340-347), BEFORE the existing entries (order within the
array is irrelevant — the array is checked before RETRYABLE — but keep them grouped with a
comment):
```js
  // Deterministic resource failures: a missing/broken file path in the
  // composition can never succeed on retry. Must out-rank the generic
  // /net::ERR/i transient pattern below.
  /net::ERR_FILE_NOT_FOUND/i,
  /net::ERR_FILE_ACCESS_DENIED/i,
  /net::ERR_INVALID_URL/i,
```
`/net::ERR/i` STAYS in `RETRYABLE_PATTERNS` (still catches `ERR_NETWORK_CHANGED`,
`ERR_CONNECTION_RESET` from the local file server under memory pressure). No other pattern change.

## 10. Clip pre-cut — `ffmpeg-runner.js` + `clip-materialize.js`

### 10.1 `buildClipCutArgv` rework (ffmpeg-runner.js:98-131)
Replace the comment (lines 99-102) and argv with:
```js
// Input-side -ss (fast seek): ffmpeg seeks to the nearest preceding keyframe,
// then decodes-and-DISCARDS up to the exact timestamp — frame-accurate under
// re-encode (the "lands on the previous keyframe" corruption applies only to
// stream-copy, which we never do here). This turns COMPOSE entry on a 30-40 min
// source from O(sum of clip end-times) decode into O(sum of clip durations).
// -t (duration) is used instead of -to because input-side -ss resets the
// timeline to 0 at the seek point.
function buildClipCutArgv({ src, out, inSeconds, outSeconds, dropAudio }) {
  const argv = [
    "-y",
    ...inputAutorotateArgs(),
    "-ss", String(inSeconds),
    "-i", src,
    "-t", (outSeconds - inSeconds).toFixed(3),
    "-c:v", "libx264",
    "-preset", "medium",   // was fast — clips are short + sidecar-cached; spend the
    "-crf", "18",          // encode time once. crf 20->18 + medium cuts the double-
                           // generation loss on the A-roll (clip is re-encoded again
                           // by the hyperframes capture).
    // dense-keyframe block UNCHANGED (-g 30 -keyint_min 30 + existing comment)
    "-g", "30",
    "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  if (dropAudio) argv.push("-an");
  else argv.push("-c:a", "aac", "-b:a", "192k");   // was 128k — voice intermediate headroom
  argv.push(out);
  return argv;
}
```
Exact deltas: `-ss` moves before `-i`; `-to <out>` becomes `-t <(out-in).toFixed(3)>`;
`preset fast→medium`; `crf 20→18`; `aac 128k→192k`. Everything else identical.

### 10.2 Cache invalidation — verified, no code change needed
The sidecar key already includes `ffmpeg_argv_hash` = sha256 of `argv.join(" ")`
(clip-materialize.js:25-27, 153-158) and `sidecarMatches` compares it (line 56). Every clip's argv
changes under §10.1 (different flag order AND values), so every pre-v2 sidecar mismatches and every
clip re-cuts exactly once. `SIDECAR_SCHEMA_VERSION` stays `"1.0"` — do NOT bump (a bump would be
redundant with the hash and would imply a shape change that didn't happen).

### 10.3 Bounded-parallel materialization (clip-materialize.js)
**Signature stable**: `materializeSceneClips({ projectId, storyboard = null, audioTreatment = DEFAULT_AUDIO_TREATMENT })`
— WP1's `transitionPhase` call site (session-state.js:193-196) is untouched.

Rework the body (lines 107-234):
1. First pass (serial, cheap): iterate scenes/clips exactly as today, performing ALL validation
   (missing scene_id, malformed clip, missing source file — same ToolErrors, thrown before any cut
   starts), cache checks, and building `tasks = [{ sceneId, clipIndex, clip, clipRole, clipDropAudio, clipAbs, sidecarAbs, srcPath, srcMtimeMs, inSeconds, outSeconds, argv, argvHash }]`
   for cache misses. Cache hits are recorded into a per-`(sceneId,clipIndex)` result map
   immediately (`status:"cached"`, same fields as today).
2. Second pass: `const limit = recommendedHeavyEncodeConcurrency();`
   `await mapWithConcurrency(tasks, limit, async (task) => { ...cutClip + sidecar write, same error handling as today... })`
   (require `recommendedHeavyEncodeConcurrency`, `mapWithConcurrency` from `./concurrency.js`).
   Each task writes its sidecar on success (identical JSON body, lines 204-217) and pushes its
   result into the map. A task throw rejects the whole call (mapWithConcurrency semantics) — same
   first-error-aborts behavior as the serial loop; a clip that finished without a sidecar simply
   re-cuts next entry (sidecar is written only after a successful cut, so no torn cache).
3. Assembly: rebuild `summary.scenes` in storyboard order from the result map (per scene:
   `{ scene_id, clips: [...] }` ordered by clip_index; skipped scenes as today). `summary.summary`
   counts unchanged in meaning. Add `summary.concurrency = limit` (new field, additive).
On the 8GB reference host `recommendedHeavyEncodeConcurrency()` = 1 (concurrency.js:22-31) →
behavior is byte-identical to the serial loop. `VOB_ENCODE_CONCURRENCY` already overrides.

## 11. `mcp/lib/source-symlink.js` — font injection + comment fix

### 11.1 `injectFontKit(composeRoot, { skipCss = false } = {})` (NEW export)
```js
const FONT_ASSETS_DIR = path.resolve(__dirname, "..", "assets", "fonts");
const FONT_CSS_SRC = path.resolve(__dirname, "..", "assets", "fonts.css");

// Inject the vendored font kit into compose/: symlink compose/fonts -> mcp/assets/fonts
// (same mechanism as ./source/ — hyperframes' file server follows symlinks; the
// scene-clip symlinks prove it on every render today) and COPY fonts.css to
// compose/fonts.css (tiny; keeps url("./fonts/...") resolution trivial).
// Graceful when assets are absent: warn + return linked:false — compositions
// fall back to system fonts; QC does not enforce font usage.
function injectFontKit(composeRoot, { skipCss = false } = {}) {
  const warnings = [];
  const linkAbs = path.join(composeRoot, "fonts");
  if (!fs.existsSync(FONT_ASSETS_DIR)) {
    return { linked: false, warnings: [`font kit not found at ${FONT_ASSETS_DIR}; compositions fall back to system fonts`] };
  }
  try {
    let st = null;
    try { st = fs.lstatSync(linkAbs); } catch {}
    if (st && st.isSymbolicLink()) fs.unlinkSync(linkAbs);
    else if (st) {
      // composer wrote real files under fonts/ — respect them, skip the kit dir
      warnings.push("compose/fonts exists as a real directory (composer-supplied); font kit dir not linked");
      return { linked: false, warnings };
    }
    fs.symlinkSync(FONT_ASSETS_DIR, linkAbs);
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      warnings.push(`could not link font kit: ${err.code}`);
      return { linked: false, warnings };
    }
    throw err;
  }
  if (!skipCss) {
    try { fs.copyFileSync(FONT_CSS_SRC, path.join(composeRoot, "fonts.css")); }
    catch { warnings.push(`fonts.css missing at ${FONT_CSS_SRC}; linked fonts/ without a stylesheet`); }
  }
  return { linked: true, warnings };
}
```
Called from saveComposition (§4.2) on EVERY save (the wipe removed the previous link).
`skipCss: true` when the composer supplied its own `fonts.css` in the file map (composer override
wins — its file was already written). Note `wipeComposeDir` (save-composition.js:17-30) uses
`fs.rmSync` on the entry — on a symlinked dir entry from `readdirSync(withFileTypes)`,
`entry.isDirectory()` is false for symlinks, so the symlink itself is removed, never the kit's
contents. Add a test for this in §15.7. Also note `composition-files.js` path validation already
prevents the composer writing `fonts/...` paths? It does NOT (subdirs allowed) — hence the
real-dir guard above.

### 11.2 Stale comment fix (lines 155-161)
Replace the sentence "the gate already blocks PREVIEW until clips resolve." with:
"a missing clip here surfaces as a warning, and composition QC (`vob/source_ref_target_missing`,
run at save and lint) blocks the pipeline if the composition actually references it."

## 12. Font kit assets — D7

### 12.1 Files (`mcp/assets/fonts/`, tracked) — built by `scripts/build-fonts.js`
The kit is **23 families as self-hosted `.woff2`**, vendored from @fontsource and built
reproducibly by `scripts/build-fonts.js` (the source of truth for both the font files and
`fonts.css`). Run `node scripts/build-fonts.js` to (re)download every family and regenerate the
stylesheet + `fonts/LICENSES.md`; `--css-only` regenerates the CSS alone. The manifest in that
script carries each family's @fontsource package (variable vs static), subset, weights, and license.

The set is a **superset of hyperframes' own embedded families** — Inter, Montserrat, Poppins,
Outfit, Open Sans, Lato, Roboto, Oswald, Archivo Black, League Gothic, EB Garamond, JetBrains Mono,
IBM Plex Mono, Source Code Pro, Space Mono, Noto Sans JP, Playfair Display, Nunito — **plus** Anton
and Bebas Neue, **plus** the house-style faces **Hanken Grotesk** and **Noto Serif SC / Noto Sans
SC** (Simplified Chinese 中文). Variable families ship one wght-axis woff2 (100–900); static and CJK
families ship one woff2 per weight. Total ≈ 7.8 MiB (the three CJK families dominate at ~1–1.5 MiB
each; they lazy-load only when CJK text actually renders). All OFL 1.1 except Roboto (Apache-2.0).

### 12.2 `mcp/assets/fonts.css` — GENERATED, do not hand-edit
`fonts.css` is emitted by `scripts/build-fonts.js` from the same manifest, so the `@font-face` rules
can never drift from the files on disk. One rule per woff2 (variable family → one rule spanning
`font-weight: 100 900`; static/CJK → one rule per weight), each `font-display: block`. Composer
usage: `<link rel="stylesheet" href="./fonts.css">` then `font-family: "Anton", sans-serif;` etc.
The hyperframes font lint passes because `@font-face` declarations exist in a linked stylesheet
within the compose root — its only font rule, `google_fonts_import`, fires only on a
`fonts.googleapis.com` link/`@import`, which the kit never uses.

### 12.3 Serving mechanism — decision: symlink dir + copied css
`./source/` file symlinks pointing OUTSIDE the compose root (to `transcoded/clips/` and arbitrary
source paths) are served by hyperframes on every render today (live-verified pipeline runs) ⇒ the
file server follows symlinks out of the root. A single dir symlink `compose/fonts →
mcp/assets/fonts` uses the same resolution path and avoids copying ~1.6MB per save. `fonts.css` is
copied (2KB) so `compose/` is self-describing. §15.7 verifies serving empirically before relying
on it.

### 12.4 NOTICE hand-off (WP7 appends verbatim)
```
This template bundles the following font software under mcp/assets/fonts/,
each licensed under the SIL Open Font License, Version 1.1
(https://openfontlicense.org):

- Inter — Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
- Anton — Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git)
- Bebas Neue — Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue)
- Playfair Display — Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display)
- Nunito — Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)

The fonts are aggregated, not modified; the OFL applies to the font files only,
not to the rest of this repository (Apache-2.0).
```
Additionally WP4 commits `mcp/assets/fonts/OFL.txt` containing the standard OFL 1.1 license text
(fetch: `curl -L -o mcp/assets/fonts/OFL.txt https://raw.githubusercontent.com/google/fonts/main/ofl/anton/OFL.txt` — any family's copy carries the full license body; the per-family copyright lines live in NOTICE).

## 13. WP5 hand-off — exact contracts the adapter prose consumes

1. **QC save rejection (composer-side retry).** `vob_save_composition` can now fail with
   `INVALID_ARGUMENTS`, message prefix `composition QC failed:`, and
   `details: { qc_findings: Finding[≤10], qc_error_count, qc_warning_count }`. The composer agent
   doc must say: *"If vob_save_composition rejects with qc_findings, fix exactly those findings and
   call vob_save_composition again. The single-write contract means one SUCCESSFUL save per
   invocation — a rejected call wrote nothing and does not count."* This keeps QC fixes inside one
   Task spawn (no orchestrator re-spawn, no token re-bill).
   **Overlay exemption (composer.md + phases/PACKAGE.md must state it):** a composition with zero
   `<video>` elements (the overlay-over-base escape hatch) is NOT rejected for uncovered
   storyboard scenes — `vob/scene_missing_clip` downgrades to the single warning
   `vob/overlay_scene_missing_clip` at save AND lint, keeping the documented
   overlay → ffmpeg-base → `vob_import_deliverable` procedure executable end-to-end.
2. **Lint result.** `findings_summary` is ≤10, ordered errors→warnings→info with `source:"vob"`
   first; result carries `qc_error_count`/`qc_warning_count`. Orchestrator retry semantics
   unchanged (`lint_status:"errors"` → auto-retry ≤3 with findings as revision_notes); `vob/*`
   rule codes map to no hyperframes gotcha-recipe — the finding message IS the fix instruction.
3. **Snapshot defaults.** Omitting `timecodes` now lands one frame just inside each storyboard
   scene (`timecode_source:"storyboard_scenes"`); explicit timecodes still win. The D8 self-QC loop
   can call it with no args right after lint passes.
4. **Render verification.** Both render results carry `verification`
   (§8 shape). The phase prose must surface `drift_exceeds_threshold:true` ("the MP4 is N s
   shorter/longer than the plan — usually a master data-duration mismatch") and
   `has_audio:false` when `music_vo`/`audio_treatment` expected audio, BEFORE asking for a verdict.
5. **Preview failures** now reference `stderr_log_path` (renders/preview-<ts>.log) — point the user
   at it instead of re-running with Bash tail.
6. **Render quality**: `vob_render_full` defaults to `high` on ≥10GB hosts; prose should state the
   default rather than always passing `quality`.
7. **Packaging**: result unchanged in shape; manifest/README gained audio-loudness + thumbnail
   strategy fields (§14) the PACKAGE prose may quote.
8. **Stale claims to DELETE from SKILL.md** (WP5): "preview is produced by `npx hyperframes render
   --quality draft`" (SKILL.md PREVIEW intro), "MCP error message will include the relevant tail"
   (now true — keep but reword to cite the log path), the snapshot step's "runs AFTER the draft
   render" ordering (moves pre-render per D8).

## 14. PACKAGE — `package-output.js` + `package-readme.js`

### 14.1 Hook-aware thumbnail
New helper inside package-output.js:
```js
// Pick the thumbnail moment: midpoint of the storyboard hook scene in OUTPUT
// time (scene starts are cumulative target durations), clamped to the probed
// duration; fall back to the configured percent (default 10%).
function resolveThumbnailMoment({ projectId, durationSeconds, state }) {   // state: the session doc already read by the handler
  let sb = null;
  try { sb = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8")); } catch {}
  if (sb && Array.isArray(sb.scenes)) {
    let cursor = 0;
    for (const scene of sb.scenes) {
      const d = Number(scene && scene.target_duration_seconds);
      if (!Number.isFinite(d) || d <= 0) { cursor = NaN; break; }
      if (scene.purpose === "hook") {
        const at = Math.max(0, Math.min(cursor + d / 2, Math.max(0, durationSeconds - 0.01)));
        return { seconds: at, strategy: "hook_scene_midpoint", hook_scene_id: scene.scene_id || null };
      }
      cursor += d;
    }
  }
  const percent = thumbnailPercentForIntent(state);   // NEW — platform-profiles, below
  const at = Math.max(0, Math.min(durationSeconds * (percent / 100), Math.max(0, durationSeconds - 0.01)));
  return { seconds: at, strategy: "percent", hook_scene_id: null, percent };
}
```
Replaces lines 143-144. ffmpeg extraction argv unchanged.

**Percent source — adopts WP2's hand-off verbatim (spec-engine §2.1.4; this is the ONLY
sanctioned consumer change in WP4's files):** DELETE `RENDER_PROFILES_PATH` (package-output.js:27)
and `readThumbnailPercent` (lines 42-59) entirely — `.vob-config/render-profiles.json` now has
exactly one reader, `platform-profiles.js`, with WP2's documented merge schema (a second ad-hoc
parser with the legacy schema must not survive). In their place:
```js
const { thumbnailTimestampPercent, canonicalizePlatform } = require("../platform-profiles.js");

// Platform for the thumbnail percent: canonical intent answer first (v2 object
// {raw,canonical,profile} or legacy string), falling back to the init-time
// state.target.format hint, else "" -> vertical profile (percent 10).
function thumbnailPercentForIntent(state) {
  const answers = state && state.intent && state.intent.answers ? state.intent.answers : {};
  const tp = answers.target_platform;
  const platformRaw = (tp && typeof tp === "object" && !Array.isArray(tp))
    ? (tp.canonical || tp.raw || "")
    : (typeof tp === "string" ? tp : null)
      || (state && state.target && typeof state.target.format === "string" ? state.target.format : "");
  return thumbnailTimestampPercent(canonicalizePlatform(platformRaw || "").canonical);
}
```
`resolveThumbnailMoment`'s percent fallback calls this helper; the resolved percent rides into the
manifest as today. (The platform-aware percents — youtube/landscape/square 15, vertical family
10 — and any user override in `.vob-config/render-profiles.json` now take effect via WP2's module.)

### 14.2 Two-pass loudnorm (default ON; `VOB_NO_LOUDNORM=1` opt-out)
New exports in `ffmpeg-runner.js`:
```js
const LOUDNORM_TIMEOUT_MS = 10 * 60 * 1000;
const LOUDNORM_TARGET = Object.freeze({ i: -14, tp: -1, lra: 11 });

function buildLoudnormMeasureArgv({ input }) {
  return ["-hide_banner", "-nostats", "-i", input, "-map", "0:a:0",
          "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"];
}
// measured fields are the strings parsed from pass 1
function buildLoudnormApplyArgv({ input, output, measured }) {
  const af = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
             `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
             `:offset=${measured.target_offset}:linear=true:print_format=summary`;
  return ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0",
          "-c:v", "copy",
          "-af", af,
          "-c:a", "aac", "-b:a", "256k",
          "-ar", "48000",                 // loudnorm internally resamples to 192kHz; restore 48k
          "-movflags", "+faststart",
          output];
}
// Parse the JSON block loudnorm prints to stderr: take the substring from the
// LAST "{" preceding the last occurrence of "input_i" to the next balanced "}".
// Returns { input_i, input_tp, input_lra, input_thresh, target_offset } as
// STRINGS (loudnorm emits them quoted), or null on any miss.
function parseLoudnormStats(stderr) { /* find lastIndexOf('"input_i"'), walk back to '{',
  walk forward balancing braces, JSON.parse, verify all five keys present, return */ }
```
package-output.js flow change (between the copy at line 124 and the probe at line 135):
```
copy render -> final.mp4                                   (existing)
probe final.mp4 -> summaryPre                              (moved up; existing call)
loudnorm = runLoudnormPass(...)                            (NEW, below)
if loudnorm.applied: re-probe final.mp4 -> summary         (authoritative post-normalization)
else: summary = summaryPre
thumbnail extraction (uses summary.duration_seconds)       (existing)
```
`runLoudnormPass({ finalMp4, summaryPre })` decision ladder (each non-`applied` exit records
`skipped_reason`):
1. `VOB_NO_LOUDNORM` boolish (`1|on|true|yes`) → `{ applied:false, skipped_reason:"disabled_via_env" }`.
2. `summaryPre.audio_streams === 0` → `"no_audio"`.
3. Run measure pass (`runFfmpegBlocking(buildLoudnormMeasureArgv(...), { timeoutMs: LOUDNORM_TIMEOUT_MS })`).
   Non-zero exit/timeout/`parseLoudnormStats` null → `{ applied:false, skipped_reason:"measure_failed", error: stderrTail(...) }` — packaging CONTINUES with the un-normalized copy (loudness is polish, not a gate).
4. `measured.input_i === "-inf"` → `"silent_audio"`.
5. `|Number(input_i) − (−14)| ≤ 0.5` AND `Number(input_tp) ≤ −1` → `"already_within_tolerance"`.
6. Apply pass to `package/final.loudnorm.tmp.mp4`; non-zero exit/timeout or missing output →
   `"apply_failed"` (+ error tail, tmp removed, continue un-normalized). Success →
   `fs.renameSync(tmp, finalMp4)`; `{ applied:true }`.
Return shape:
`{ applied, skipped_reason: string|null, error: string|null, measured_input_i: number|null, measured_input_tp: number|null }`
(numbers via `Number()`, null when unparseable/"-inf").

### 14.3 Manifest + README additions
`manifest_version: "1.0"` → `"1.1"` (additive-only change). New/changed fields:
```js
video: { ...existing, expected_duration_seconds, duration_drift_seconds },  // from storyboard total; null when unavailable
thumbnail: { path, extracted_at_seconds, extracted_at_percent,              // percent now derived: round(seconds/duration*1000)/10, null if duration 0
             strategy: "hook_scene_midpoint"|"percent", hook_scene_id: string|null, file_size_bytes },
audio: { loudnorm_applied: boolean,
         loudnorm_target: { i: -14, tp: -1, lra: 11 },
         measured_input_i: number|null, measured_input_tp: number|null,
         skipped_reason: string|null },
render: { ...existing, quality: state.render.quality ?? null },
```
package-readme.js: after the Thumbnail section, add an Audio section:
```
## Audio

- **Loudness:** normalized to −14 LUFS / −1 dBTP (measured −<X> LUFS at input)
   — when manifest.audio.loudnorm_applied
- **Loudness:** not normalized (<skipped_reason>)
   — otherwise; omit the section entirely when manifest.audio is absent (legacy manifest)
```
Thumbnail section line gains the strategy:
`- **Frame at:** <t> (<percent>% of duration; hook scene "<id>" midpoint)` when strategy is
hook_scene_midpoint. README consumers: humans only; additive.

History `package_built` entry gains `loudnorm_applied` and `thumbnail_strategy`.

### 14.4 Description rewrite (token: ~520 → ≤400 chars)
DELETE current (line 289). REPLACE:
> "Assemble package/: copy the confirmed render to final.mp4, two-pass loudness-normalize the audio to −14 LUFS/−1 dBTP (audio-only re-encode, video stream copied; VOB_NO_LOUDNORM=1 skips), extract the thumbnail at the storyboard hook-scene midpoint (fallback: 10%), write manifest.json (v1.1) + README.md. Wipes package/ first. Requires render.confirmed:true."

## 15. Verification — how the implementer proves each change

Fixtures live under `/tmp/vob-wp4-fix/` (not committed). Generate test media with lavfi:
```bash
ffmpeg -y -f lavfi -i testsrc=size=1080x1920:rate=30:duration=40 -f lavfi -i "sine=frequency=440:duration=40" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/vob-wp4-fix/src.mp4
```

### 15.1 Syntax + boot
`node --check` on every touched file; `node mcp/server.js` boots (Ctrl-C after the banner);
registry build passes (no metadata fields were added to tool modules, so `defineTool` is
unaffected).

### 15.2 composition-qc unit checks (no session needed)
```bash
node -e '
const { runCompositionQc, extractTags } = require("./mcp/lib/composition-qc.js");
const sb = { scenes: [ { scene_id:"s001", sequence:1, purpose:"hook", target_duration_seconds:3, source_clips:[{}] },
                       { scene_id:"s002", sequence:2, purpose:"beat", target_duration_seconds:27, source_clips:[{}] } ] };
const links = [{ scene_id:"s001", clip_index:0, clip_abs:"/nonexistent/s001-0.mp4" },
               { scene_id:"s002", clip_index:0, clip_abs:"/nonexistent/s002-0.mp4" }];
const bad = `<div data-width="1080" data-height="1920" data-start="0" data-duration="20">
<div class="caption-line" data-start="0" data-duration="3"><style>.caption-line{font-size:40px}</style></div>
<video src="/Users/x/a.mp4"></video><video src="./source/s003-0.mp4" data-media-start="2"></video></div>`;
const r = runCompositionQc({ files:[{relPath:"index.html",content:bad}], storyboard:sb,
  sourceLinks:[], sceneClipLinks:links, checkTargetsOnDisk:false });
console.log(JSON.stringify(r.findings.map(f=>[f.severity,f.rule]), null, 1));
'
```
Expect errors: `vob/missing_root_attr` (data-composition-id absent → variant b),
`vob/master_duration_short` (20 < 30−0.5), `vob/unresolved_source_ref` (s003-0),
`vob/absolute_src_path`, `vob/scene_missing_clip` ×2; warnings:
`vob/timed_element_missing_clip_class`, `vob/caption_font_size_small`,
`vob/scene_clip_media_start_nonzero`. A second, clean fixture (all attrs present, 2 videos,
resolving refs, `checkTargetsOnDisk:false`) must return zero findings. A third run with
`storyboard:null` must return exactly one `vob/storyboard_unreadable` warning plus the
storyboard-independent findings. A fourth, OVERLAY fixture (valid root attrs, zero `<video>`
elements, same 2-scene storyboard with `source_clips`) must return `error_count: 0` and exactly
one `vob/overlay_scene_missing_clip` warning naming 2 scenes — proving the overlay-over-base
escape hatch saves and lints.

### 15.3 TOOL_HANDLERS smoke (QC + fonts + lint merge + snapshot)
Drive `init → ingest(/tmp/vob-wp4-fix/src.mp4) → inspect(skip ASR) → intent(all keys) →
save_brief/confirm → save_storyboard(2-scene fixture matching §15.2's sb with real
source_path/in/out) → confirm → transition COMPOSE` via `TOOL_HANDLERS` (as m5-walker does), then:
1. `vob_save_composition` with the BAD fixture → expect `ok:false`,
   `error.code:"INVALID_ARGUMENTS"`, `details.qc_findings.length ≤ 10`; verify prior `compose/`
   (if any) untouched.
2. Save the CLEAN fixture → result has `qc.warning_count`, `fonts_linked:true`;
   `ls -l compose/fonts` shows a symlink to `mcp/assets/fonts`; `compose/fonts.css` exists.
3. `vob_lint_composition` → report file has `report_version:2`, merged findings carry `source`;
   `findings_summary.length ≤ 10`. Delete one pre-cut clip from `transcoded/clips/`, re-lint →
   `vob/source_ref_target_missing` error appears and `lint_status:"errors"`.
4. `vob_snapshot_keyframes {}` (no timecodes) in COMPOSE → `timecode_source:"storyboard_scenes"`,
   2 PNGs (one per scene). Requires hyperframes installed; skip behind an env guard like the
   walker's render gating.

### 15.4 Clip pre-cut accuracy + cache invalidation + parallelism
- Accuracy (the input-side `-ss` check, incl. HEVC): cut the same window both ways and compare
  first-frame signatures:
```bash
ffmpeg -y -ss 12.345 -i src.mp4 -t 3.000 -c:v libx264 -preset medium -crf 18 -g 30 -keyint_min 30 -pix_fmt yuv420p /tmp/a.mp4
ffmpeg -y -i src.mp4 -ss 12.345 -to 15.345 -c:v libx264 -preset medium -crf 18 -g 30 -keyint_min 30 -pix_fmt yuv420p /tmp/b.mp4
ffmpeg -i /tmp/a.mp4 -vf "select=eq(n\,0)" -vframes 1 -f image2 /tmp/a.png; ffmpeg -i /tmp/b.mp4 -vf "select=eq(n\,0)" -vframes 1 -f image2 /tmp/b.png
# images must be visually identical; ffprobe duration of both = 3.00 ±1 frame
```
  Repeat with an HEVC source (`-c:v libx265` re-encode of src.mp4) — this is the empirical check
  the critique demanded before flipping seek sides.
- Invalidation: run transition→COMPOSE once on the OLD code (or hand-write a sidecar with the old
  argv hash), upgrade, re-enter COMPOSE → every clip reports `status:"cut"` (not `cached`); second
  re-entry → all `cached`.
- Parallelism: `VOB_ENCODE_CONCURRENCY=3` with a 6-clip storyboard; assert `summary.concurrency:3`,
  results ordered by scene/clip, and wall-clock < serial run. Then unset on the 8GB host → 1.

### 15.5 Runner fixes
- Ring buffer: `node -e` a spawnWithShutdown of
  `bash -c 'head -c 6000000 /dev/zero | tr "\0" "x" 1>&2; echo "Protocol error (tail)" 1>&2; exit 7'`
  with `maxOutputBytes: 4*1024*1024` → `stderr` ends with `Protocol error (tail)`, contains the
  elision marker, `stderr_truncated:true`.
- Classifier: `node -e` over the exported sets:
  `NON_RETRYABLE` matches `"net::ERR_FILE_NOT_FOUND"`; `"net::ERR_NETWORK_CHANGED"` still matches
  RETRYABLE only. Verify via `runHyperframesWithRetry` with a stub script (`VOB_HYPERFRAMES_BIN`
  pointing at a .js that prints the string and exits 1) → exactly 1 attempt for FILE_NOT_FOUND,
  3 for NETWORK_CHANGED.
- `stderrTail("a".repeat(5000), 2000)` → length 2001, starts with `…`.
- Timeouts: `VOB_RENDER_TIMEOUT_MS=1234 node -e 'console.log(require("./mcp/lib/hyperframes-runner.js").renderTimeoutMs("preview", 600))'`
  → 1234; unset, duration 600 → 12_000_000 (600×20s); duration 10 → 900_000 (floor); duration null
  → floor; full/preview ceilings honored at absurd durations.
- Quality: `VOB_RENDER_QUALITY=standard` → "standard"; `=default` → null; unset → "high" iff
  `os.totalmem() ≥ 10GiB`.

### 15.6 Render verification + preview log (env-gated; needs hyperframes)
Run the §15.3 session through `render_preview` → result `verification.probed:true`,
`duration_drift_seconds` ≈ 0 (<0.5) for a correct composition, `renders/preview-*.log` non-empty.
Author a composition whose master `data-duration` is 5s short, override-save QC? — not possible
(QC blocks at 0.5s); instead set master duration short by 0.4s (passes QC) and check
`drift_exceeds_threshold:false`; the >0.5 path is unit-tested directly:
`node -e 'console.log(require("./mcp/lib/render-verify.js").verifyRenderedMp4({mp4Path:"/tmp/a.mp4", expectedDurationSeconds:10}))'`
(3s file vs 10 expected → drift −7, flag true). Probe of a non-file → `probed:false`, no throw.

### 15.7 Fonts served (env-gated)
Composition fixture using `<link rel="stylesheet" href="./fonts.css">` + an Anton headline;
`vob_snapshot_keyframes` → open the PNG: the headline must render in Anton's condensed caps (vs a
control save with the link removed). This simultaneously proves the hyperframes file server follows
the `fonts/` dir symlink. Then re-save and confirm `mcp/assets/fonts/` still contains all 5 TTFs
(wipe didn't traverse the symlink) and `compose/fonts` was recreated.

**Snapshot contact-sheet geometry (grounds WP5's self-QC read plan — record in docs/v2/RESULTS.md):**
on the same run, `ffprobe` (or `sips -g pixelWidth -g pixelHeight`) the produced
`contact-sheet.jpg` for 2, 8, and 16 requested timecodes; record total dimensions and derived
per-cell pixel size, plus the per-cell size AFTER a ~1.15MP/1568px vision downscale. WP5's
COMPOSE self-QC assumes per-cell legibility is NOT sufficient for caption-level checks at 8+
cells — if measurement shows otherwise, WP5 may relax its mandatory full-res single reads; the
measurement, not this assumption, is the record.

### 15.8 Loudnorm + thumbnail
Full pipeline to PACKAGE (env-gated) OR direct handler test: place a confirmed-render state with a
quiet test mp4 (`-af volume=0.05` variant of src.mp4). Run `vob_package_output` →
`manifest.audio.loudnorm_applied:true`; verify:
```bash
ffmpeg -hide_banner -i package/final.mp4 -af loudnorm=I=-14:TP=-1:print_format=json -f null - 2>&1 | grep input_i
# input_i ≈ -14 ±1
ffprobe -v quiet -show_streams -select_streams a package/final.mp4 | grep sample_rate   # 48000
ffprobe -v quiet -show_streams -select_streams v package/final.mp4 | grep codec_name    # unchanged (stream copy)
```
`VOB_NO_LOUDNORM=1` re-run → `skipped_reason:"disabled_via_env"`, byte-identical video stream.
Hook thumbnail: storyboard hook scene at scenes[0] (3s) → `manifest.thumbnail.extracted_at_seconds ≈ 1.5`,
`strategy:"hook_scene_midpoint"`; delete storyboard.json, re-package → `strategy:"percent"`, 10%.
Audio-less render (`-an` fixture) → `skipped_reason:"no_audio"`, packaging still completes with all
4 files (packageToIterate gate passes).

### 15.9 Legacy-state regression
Copy a pre-v2 session dir (no `composition.qc`, no `verification`, old sidecars): `vob_read_state`,
`vob_lint_composition` (QC re-runs; merged report), `transitionPhase` to COMPOSE (clips re-cut once
via hash mismatch) — all succeed with no thrown errors.

## 16. Token accounting (for docs/v2/RESULTS.md, WP7)
Description bytes, before → after: save_composition 1065→~455, lint_composition 575→~335,
snapshot_keyframes 810→~415, render_preview 705→~355, render_full 1156→~495, package_output
520→~395. Net ≈ −2.4KB (~600 tokens) off every session's tools/list in both adapters. No
inputSchema grew.
