# Auto-QC of stills — ship-ready slice (PREVIEW / step 6)

**Status:** spec, not yet built. **Track:** PREVIEW auto-QC. **Depth:** cheap wins only,
one concrete thing landed before expanding scope.

## One-line goal

Automate the **QC-C** check ("no black / empty / half-loaded frames at any sampled
timecode") that the COMPOSE self-QC loop currently asks a human to eyeball — by running
`ffmpeg`/`ffprobe` luma stats over the snapshot stills the composer **already** produces.
Zero new render, zero new npm deps.

---

## Why this is the slice (ground-truth findings)

The five-idea survey said auto-QC could cover caption legibility, safe-area, and contrast.
Reading the actual code changed that:

1. **hyperframes exposes no per-element geometry.** `snapshot` → PNGs only;
   `inspect --json` returns rects *only for already-broken elements* (text/container
   overflow, clipping); `--describe true` is Gemini vision, not geometry. With no caption
   bounding box, **caption-contrast** and **rendered safe-area** can't be measured without
   OCR/vision → **deferred to the deep (vision) track**, not cheap.
2. **Plan-lint already owns declared safe-area.** `PLAN_OVERLAY_SAFE_AREA`
   (`storyboard-schema.js` ~1348) checks declared `position.offset_px[1]` for **bottom**
   anchors vs `safe_bottom_px`. A composition-time re-check buys little (regex-only QC
   can't see CSS-cascaded position either). So safe-area is not a stills-QC win.
3. **Black/blank-frame detection is genuinely cheap and zero-new-render.** `ffmpeg`/`ffprobe`
   luma stats over the existing snapshot PNGs, via the established
   `silence-detector.js` / `audio-analysis.js` spawn-and-parse pattern. **This is the slice.**

### Verified mechanism (ffmpeg 8.1.1, host)

```
ffprobe -v error -f lavfi -i "movie=<still>.png,signalstats" \
  -show_entries frame_tags=lavfi.signalstats.YMIN,lavfi.signalstats.YAVG,lavfi.signalstats.YMAX \
  -of default=noprint_wrappers=1
```

| still      | YMIN | YAVG   | YMAX |
|------------|------|--------|------|
| full black | 0    | 0      | 0    |
| full white | 255  | 255    | 255  |
| gradient   | 32   | 150.62 | 224  |

`YMAX` is the discriminator: a frame where *nothing bright rendered* (dropped clip,
timed-out seek, blank scene) has a low `YMAX`. An **intentionally** dark cinematic frame
with any bright subject keeps a high `YMAX` → no false positive. Clean `key=value`
output — no fragile stderr regex.

---

## What ships (3 small files + wiring)

### 1. `mcp/lib/ffprobe.js` — add one helper

Centralize the ffprobe call where ffprobe already lives. Mirror `probeFile`'s spawn +
timeout discipline; **degrade, never throw** (return `{probed:false, error}` on failure).

```js
// signalstatsLuma(pngPath, {timeoutMs = 15000}) -> {probed, ymin, yavg, ymax} | {probed:false, error}
// argv: ["-v","error","-f","lavfi","-i",`movie=${escaped},signalstats`,
//        "-show_entries","frame_tags=lavfi.signalstats.YMIN,YAVG,YMAX",
//        "-of","default=noprint_wrappers=1"]
// parse: /lavfi\.signalstats\.YMAX=([\d.]+)/ etc. (key=value lines)
```
Note: escape the path for the lavfi `movie=` source (`:`, `\`, `'` are filtergraph-special;
use the `movie=filename=...` long form or backslash-escape). Cover this in the unit fixture.

### 2. `mcp/lib/still-qc.js` — pure classifier (unit-testable, no I/O)

```js
// classifyStillLuma({ymin, yavg, ymax}, thresholds) -> finding | null
//   black  : ymax <= BLACK_YMAX      -> {code:"qc/still_black",     severity:"glaring"}
//   blown  : ymin >= BLOWN_YMIN      -> {code:"qc/still_blown_out", severity:"glaring"}
//   flat   : (ymax-ymin) <= FLAT_RANGE && !black && !blown
//                                     -> {code:"qc/still_flat",      severity:"taste"}
// thresholds (env-overridable):
//   BLACK_YMAX  = VOB_QC_BLACK_YMAX  ?? 24   (covers TV-range black=16 + dithering)
//   BLOWN_YMIN  = VOB_QC_BLOWN_YMIN  ?? 232
//   FLAT_RANGE  = VOB_QC_FLAT_RANGE  ?? 24
```
`severity` uses the COMPOSE self-QC vocabulary (`glaring` | `taste`), **not** the
composition-qc `error`/`warning` enum — different tool, different consumer. `flat` is
`taste` because a solid title card is legitimately flat; `black`/`blown` are `glaring`
because nothing legible rendered.

### 3. `mcp/lib/tools/qc-stills.js` — the new tool

Frozen module, full metadata block:

```js
module.exports = Object.freeze({
  name: "vob_qc_stills",
  description: "Analyze the current composition's snapshot stills (compose/snapshots/*.png) "
    + "with ffprobe luma stats and flag black/empty/half-loaded frames (QC-C). Advisory, "
    + "non-gating; run after vob_snapshot_keyframes in COMPOSE self-QC. Pure ffprobe, ~1-3s.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      timecodes:  { type: "array", items: { type: "number", minimum: 0 } }, // echo of the
        // snapshot call's timecodes; if length === still count, stamp finding.timecode_seconds
    },
    required: ["project_id"],
  },
  handler: qcStills,
  role_bundles: ["orchestrator"],
  mutating: true,                 // writes a report + history audit entry
  global_preapproval: false,
  network_access: false,          // pure local ffprobe (unlike snapshot)
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["compose/snapshots/stills-qc.json", "state.json"],
  hook_required: false,
});
```

**Handler algorithm:**
1. `assertSafeProjectId`; `readSessionStateStrict`. Glob `snapshotsDir(id)/*.png` sorted
   (same convention as `snapshot-keyframes.js:143`). If none →
   `ToolError(NOT_FOUND, "run vob_snapshot_keyframes first")`.
2. For each still: `signalstatsLuma()` → `classifyStillLuma()`. Per-frame `try/catch`;
   a probe failure records `{frame_index, still_path, probed:false}` and continues.
3. Stamp `timecode_seconds` from input `timecodes[i]` **iff** `timecodes.length === stills.length`
   (best-effort; hyperframes names PNGs in timecode order, but we don't hard-depend on it —
   degrade to `frame_index` + filename, matching how `snapshot` returns `still_paths`/`timecodes`
   without asserting alignment).
4. Under `withSessionLock`: write `compose/snapshots/stills-qc.json`
   (`{ran_at, count, glaring_count, taste_count, findings[]}`) + a `stills_qc_run` history entry.
5. Return lean: `{report_path, count, glaring_count, taste_count, findings}` (≤10 inline + counts,
   matching the lint-result contract).

**Does NOT:** gate any transition, touch `lint_status`, or alter `preview`/`render` slots.
Advisory, exactly like `snapshot_keyframes`.

---

## Orchestrator wiring (COMPOSE self-QC loop)

Edit `adapters/claude-code/.claude/skills/vob/phases/COMPOSE.md` self-QC section
(currently ~lines 110–151, the QC-A..F checklist + glaring/taste routing):

- After step 2 (`vob_snapshot_keyframes`), call `vob_qc_stills { project_id, timecodes }`.
- **QC-C is now the tool's verdict**, not an eyeball pass: `qc/still_black` / `qc/still_blown_out`
  (severity `glaring`) feed the existing **auto-fix** path — `vob_log_composer_invocation`
  with `revision_notes = "self-QC round <n>: QC-C black/blank frame at t=<s>s"`, re-spawn the
  composer, re-lint, **re-snapshot only the failed timecodes**, **re-run `vob_qc_stills`**.
  Respect the existing **≤2 self-QC-round** budget (independent of the ≤3 lint-retry budget).
- `qc/still_flat` (severity `taste`) → carry into the "things you might want changed" note,
  never auto-retry.
- The human-eyeball checklist still owns **QC-A / QC-B / QC-D / QC-E / QC-F** — we can't
  automate those cheaply yet (no geometry). QC-C just moves off the human's plate.

Then `node scripts/port-adapter-docs.js` to regenerate the OpenCode mirror
(`.opencode/vob/phases/COMPOSE.md`).

---

## Registration checklist (boot drift guard cross-checks all of these)

1. `mcp/lib/tools/index.js` — add `qc-stills.js` to `TOOL_MODULES`.
2. `adapters/claude-code/.claude/skills/vob/SKILL.md` — add `mcp__vob__vob_qc_stills` to
   `allowed-tools` (alphabetical).
3. `adapters/claude-code/.claude/settings.json` — add `mcp__vob__vob_qc_stills` to
   `permissions.allow` (alphabetical).
4. OpenCode mirror: register `vob_vob_qc_stills` in `adapters/opencode/.opencode/opencode.json`
   tool/permission lists; the `vob` agent frontmatter; then `port-adapter-docs.js`.
5. Boot check: `node mcp/server.js` exits 0 (`verifyAdapterToolReferences` green).

---

## Walker regression — new `stillsqc` phase (no hyperframes render)

The `overlays` phase stops at COMPOSE and snapshot is env-gated, so qc-stills can't reuse a
real render cheaply. Add a standalone `stillsqc` phase (matching the `general`/`longform`
style) that uses **ffmpeg only** for determinism:

1. Synthesize stills into a temp snapshots dir via ffmpeg (the verified commands):
   `color=c=black`, `color=c=white`, `gradients=...` → `black.png`/`white.png`/`grad.png`.
2. Assert `signalstatsLuma(black.png).ymax === 0`, `signalstatsLuma(white.png).ymin === 255`,
   `grad` mid-range — locks the parser to real ffprobe output.
3. Assert `classifyStillLuma` returns `qc/still_black` (glaring) for black, `qc/still_blown_out`
   for white, `null` for the gradient.
4. Point a fixture project's `compose/snapshots/` at the synthetic stills and run the tool via
   `executeTool` (schema + envelope path, not the bare handler — the walker contract); assert
   `glaring_count === 2` and the finding codes/timecodes.
5. Fold `stillsqc` into `all`. Add `stillsqc` to the phase list in `CLAUDE.md` Commands.

No multi-minute render; ffmpeg is already a hard dependency.

---

## Definition of done

- [ ] `vob_qc_stills` registered; `node mcp/server.js` exits 0 (drift guard green).
- [ ] `ffprobe.js::signalstatsLuma` + `still-qc.js::classifyStillLuma` with the verified thresholds.
- [ ] COMPOSE.md (claude-code) wires QC-C to the tool; OpenCode mirror regenerated.
- [ ] `node scripts/m5-walker.js stillsqc` green; `node scripts/m5-walker.js all` still green.
- [ ] No new npm deps; no new render in the QC path.

---

## Explicitly out of this slice

- **Caption contrast & rendered safe-area** → deep (vision) track: need OCR/vision or a
  hyperframes geometry-dump that doesn't exist today.
- **Near-cheap next step (not zero-render):** wire `hyperframes inspect --json` into a layout
  audit — it already returns rects for clipped/overflowing text & containers, automating
  **QC-A (clip-at-edges)** and **QC-B (overflow)**. Costs a new hyperframes-runner entry point +
  parser and a browser pass (~10–60s), so it's the obvious follow-on once QC-C lands.
- **Adjacent 10-line freebie (plan-phase, not stills):** `PLAN_OVERLAY_SAFE_AREA` only checks
  **bottom** anchors vs `safe_bottom_px`; mirror it for **top** anchors vs `safe_top_px`
  (`platform-profiles.js` has the field; the check is currently asymmetric).

## Risks / mitigations

- **PNG order ↔ timecode mapping** — don't hard-depend; stamp `timecode_seconds` only when
  counts align, else report by `frame_index` + filename (matches existing snapshot convention).
- **Limited vs full luma range** — `BLACK_YMAX=24` margin covers TV-range black (16) + dithering.
- **Intentional flat title cards** — `flat` is `taste` (never auto-retries); a card with text
  has high `YMAX` so it never trips `black`.
- **ffprobe lavfi path escaping** — `movie=` is filtergraph-special; use the `filename=` long
  form / backslash-escape and cover it in the unit fixture.
