# video-vob v3.0 — PRD: General Video

**Status:** Draft for review
**Target version:** `.vob/VERSION` 2.1.0 → **3.0.0**
**One-line vision:** From a short-form generator into a **general agentic video editor** — *any format, any length, planned as layers* — without abandoning the on-rails short-form experience that already works.

---

## 1. Background

v2.1 reliably produces short-form social video. The FSM spine
(`INGEST → INSPECT → INTENT → PLAN → COMPOSE → PREVIEW → RENDER → PACKAGE → ITERATE`),
the gate/lint/render-verify machinery, the subagent model, and the
multi-short fan-out are all sound and **format-agnostic in principle**.

"Short-form" is not baked into the FSM. It lives in **five concrete places**:

| # | Where | What's short-form-shaped | File |
|---|-------|--------------------------|------|
| 1 | Platform profiles | 7 profiles, all 9:16/16:9/1:1 at fixed **30 fps**; duration ideals top out at 180 s; no cinematic fps, no >3-min ideal | `mcp/lib/platform-profiles.js` |
| 2 | Render scale wall | `<video>`-element budget (6/8, host-tunable) + a **single continuous-composition** render. Cannot put 80 cuts in one headless-Chrome render. **The binding ceiling on length.** | `mcp/lib/tools/render-full.js`, `composition-qc.js`, `host-profile.js` |
| 3 | Clean-cut | Assumes talking-head A-roll (filler/dead-air removal); wrong for montage/tutorial/cinematic | `mcp/lib/clean-cut.js` |
| 4 | Plan-lint | `hook-first`, short-duration-drift are *social retention heuristics* | `mcp/lib/save-storyboard.js` plan-lint codes |
| 5 | Layer model | `scene.overlays` is **`string[]`**; `broll_placements[]` is **advisory** — overlays and b-roll are *described*, not *planned as typed, timed objects* | `mcp/lib/storyboard-schema.js` |

v3 is a **generalization, not a rewrite**: lift those five, on a spine that already fits.

---

## 2. Goals / Non-goals

### Goals
1. **Any length.** Lift the render ceiling so a 30-minute video is as on-rails as a 30-second one.
2. **Any format.** First-class long-form, cinematic (24 fps), tutorial/screencast, podcast→video, plus the existing social formats — driven by **presets**, with a generalized configurable model underneath.
3. **User-definable presets.** Ship built-in presets *and* let users author their own via a committed override file. (Locked decision.)
4. **Overlays as a planned layer.** Promote overlays to typed, timed, planned objects authored during PLAN; composer-coded (HTML/CSS/JS). (Locked decision.)
5. **Richer planned b-roll** + a **gap "shopping list"** when ingested coverage is insufficient. Ingested footage only. (Locked decision.)
6. **No regression.** v2.1 short-form behavior is preserved as the `social-short` preset; pre-v3 storyboards/sessions stay readable.

### Non-goals (explicitly deferred)
- External motion-graphics assets (Lottie/MOGRT/stock graphics). Overlays are composer-coded.
- Stock-library or AI-generated b-roll. B-roll is ingested-only + gap list.
- New external dependencies. The engine stays **zero-npm-dep, Node stdlib** (ffmpeg/ffprobe/hyperframes/ASR remain the only externals).
- New FSM phases. v3 reuses the existing 9-phase spine and the per-unit cycling pattern.
- Real-time / collaborative editing, a GUI timeline. Still agent-driven.

---

## 3. Principles

- **Generalize via data, not branches.** Presets and format profiles are resolved files (env > user `.vob-config/*.json` > built-in), mirroring `host-profile.js` / `platform-profiles.js`. No `if (videoType === ...)` sprawl in handlers.
- **Reuse the fan-out machinery.** Segmented long-form is fan-out with a *join* step. The per-short `{short_id}` cycling generalizes to per-segment `{segment_id}`.
- **The contract stays narrow.** The 5 required intent keys are untouched (no renames). New dimensions are additive and optional with sane defaults.
- **Disk is truth; gates enforce.** New layer/segment structure is validated at save and re-checked by gates against disk artifacts, same as today.
- **Short-form must stay a one-liner.** A user who wants a TikTok should never see long-form complexity.

---

## 4. The four pillars

### Pillar 1 — Generalized format + preset system

**Format generalization (`platform-profiles.js`):**
- Make `fps` a real per-profile field with support for 24 / 25 / 30 / 50 / 60 (currently hardcoded 30 everywhere). Cinematic = 24; high-motion = 60.
- Add long-form/cinematic profiles: e.g. `youtube_long` (16:9, ideal 5–20 min, `max_duration_s: null`), `cinematic` (16:9 or 2.39:1, 24 fps), `tutorial` (16:9, screen-recording safe areas). Custom geometry is **already supported** today via `render-profiles.json` (any `{width,height}` becomes a canonical profile) — we extend, not invent.
- Decouple duration ideals from "short": lint reads the *active profile/preset* ideal, never a global short assumption.

**Preset system (new `mcp/lib/video-types.js` + `.vob-config/video-types.json`):**

A **preset** is a named bundle:
```jsonc
{
  "social-short": {
    "platform_default": "tiktok",        // seeds the platform profile
    "editorial": { "clean_cut": true, "scene_detect": true },
    "lint_ruleset": "retention",         // hook-first, duration drift on
    "overlay_vocabulary": ["kinetic_caption", "lower_third", "title_card"],
    "render": { "segmentation": "single" }
  },
  "long-form": {
    "platform_default": "youtube_long",
    "editorial": { "clean_cut": true, "scene_detect": true },
    "lint_ruleset": "chaptered",         // hook-first OFF; chapter coverage ON
    "overlay_vocabulary": ["chapter_marker", "lower_third", "callout", "data_viz", "progress_bar"],
    "render": { "segmentation": "auto" } // chunk to fit the <video> budget
  },
  "cinematic": { "...": "24fps, clean_cut OFF, beat/montage lint" },
  "tutorial":  { "...": "screencast safe areas, callout/zoom vocabulary" },
  "podcast":   { "...": "long-form audio-led, waveform/chapter overlays" }
}
```

- **Resolution precedence:** `VOB_VIDEO_TYPE` env > intent answer > preset's own `platform_default` > built-in default. User file shallow-merges over built-ins; an unknown preset name falls back to a generalized default (never an error) — same forgiveness as the platform alias table.
- **Selection:** add an optional intent dimension **`video_type`** (NOT one of the 5 required keys; additive). If unanswered, derive it from `target_platform` + `target_duration` (e.g. youtube + 12 min → `long-form`; tiktok + 30 s → `social-short`). The orchestrator proposes the derived preset and the human confirms — one extra INTENT beat, skippable.
- A preset **sets defaults** for the intent/format knobs; it never hard-limits them. The user can still override geometry, fps, or duration.

**`vob_doctor`** reports the resolved preset and its effective format/editorial/lint/overlay values + sources, exactly like it already reports `report.tuning`.

---

### Pillar 2 — Segmented render + concat (the length unlock)

**The bet (confirmed):** generalize v2.1 fan-out. A long-form video is *N timelines + a join*:

| | fan-out (`shorts[]`, v2.1) | long-form (`segments[]`, v3) |
|---|---|---|
| Units | N independent shorts | N consecutive segments of ONE video |
| Cycling | per-short COMPOSE→PREVIEW→RENDER | per-segment (same machinery) |
| Output | N deliverables, **no join** | N partials → **ffmpeg concat → 1 deliverable** |
| Audio | per-short | continuous **master bed** laid at join |

**Two levels of segmentation:**
- **Narrative (human-planned):** acts/chapters/sections — the planning unit, named, with titles (also drives chapter-marker overlays + YouTube chapters in PACKAGE).
- **Render-segments (engine-derived):** consecutive scenes are auto-chunked until the next scene would exceed the `<video>` budget (host-tuned, default 6). `segmentation: "single"` (short-form) = one segment; `"auto"` = chunk; `"manual"` = author declares segment boundaries.

**Mechanics:**
- COMPOSE materializes the clip union (as today) and produces **one composition per segment** under `compose/segments/<segment_id>/`. The COMPOSE→PREVIEW→RENDER loop cycles per segment via `save_composition{segment_id}` (mirrors `{short_id}` — scoping QC, timeouts, drift verification, snapshots).
- `render_full` renders each segment to `renders/segments/<segment_id>-<ts>.mp4`. The existing revision-binding, duration-aware timeout, and ffprobe verification logic generalize to per-segment.
- **New tool `vob_assemble_video`** (orchestrator role, additive — no new phase): ffmpeg-concats the segment partials in order, applies boundary transitions (hard cut, or `xfade` per segment `transition_out`), lays the **master audio bed** (music + VO, ducked under speech via the existing `loudnorm.js` + sidechain), and writes `renders/final-<ts>.mp4`. ffprobe-verifies the joined duration vs the document total (silent-truncation detector, reused from `render-verify.js`).
- **Continuity:** render segments audio-light; the continuous music/VO bed is a *single* track laid at assembly, so there are no per-segment audio seams. Overlays that must span a boundary (a lower-third crossing a cut) are split at the segment boundary by the composer (lint-checked).
- **Gates:** RENDER→PACKAGE blocks until every segment is rendered AND assembled (overridable `segments_missing_render` / `video_not_assembled`, mirroring the fan-out `shorts_missing_deliverables` backstop).

**Why this is the right bet:** it respects the hardware wall instead of fighting it, reuses proven machinery, and makes length effectively unbounded. The single-composition path remains for `segmentation: "single"` — zero overhead for short-form.

---

### Pillar 3 — Overlays as a typed, planned layer

Promote `scene.overlays: string[]` → typed objects (schema **1.2**; a plain string stays valid as a legacy freeform note → back-compat).

**Overlay object:**
```jsonc
{
  "id": "lt-1",
  "type": "lower_third",          // see vocabulary below
  "start_seconds": 2.0,            // timeline-relative (within scene/segment)
  "end_seconds": 6.5,
  "track": 1,                      // z-order
  "content": { "title": "Jane Doe", "subtitle": "Founder" },
  "position": { "anchor": "bottom-left", "offset_px": [80, 160] }, // safe-area aware
  "style": { "font": "Hanken Grotesk", "accent": "#FF3B30" },      // kit fonts only
  "motion": { "in": "slide_up", "out": "fade", "dwell_min_s": 1.2 }
}
```

**Composer-coded vocabulary (no external assets):**
`title_card` · `lower_third` · `callout`/annotation · `kinetic_caption` (word-sync, from the transcript) · `caption_block` · `logo_bug` · `progress_bar` · `chapter_marker`/`section_title` · `data_viz` (number counter / bar) · `cta`/`end_card` · `pip` (picture-in-picture — **note: a PiP carries a `<video>` and counts against the budget**).

**This formalizes the existing escape hatch.** `overlay-compositor.js` (transparent graphics over an ffmpeg-cut base, today a fallback when `<video>` capture is fragile) becomes a *planned* render strategy: an "overlay-only segment" (zero base `<video>`, all graphics) composited over a pre-cut base. The QC already has a zero-video overlay exemption (`vob/overlay_scene_missing_clip`) — we lean into it.

**Contract & checks:**
- **Composer:** typed contract; per-type fix recipes in `references/lint-rules.md`. Each overlay type maps to a documented HTML/CSS/JS pattern using kit fonts via `<link>` (never `@import` — the lint gotcha).
- **New plan-lint codes:** overlay timing within bounds; no conflicting-type overlap; safe-area compliance; readability dwell (≥ `dwell_min_s`); kinetic-caption sync vs transcript; PiP within `<video>` budget.
- **New composition-QC codes:** a planned overlay has a corresponding element; z-order sane; PiP counted.

---

### Pillar 4 — Richer planned b-roll + gap shopping-list

Promote `broll_placements` from advisory to **planned** (it already references `{scene_id, clip_index}` + `narration_span` + `insert_at_seconds`):
```jsonc
{
  "clip": { "scene_id": "s3", "clip_index": 1 },   // OR "source": "gap"
  "render_mode": "full_frame",   // full_frame (cutaway) | pip (inset) | overlay
  "narration_span": { "start_seconds": 4.0, "end_seconds": 7.5 },
  "motion": "ken_burns",         // stills: pan/zoom; video: none|speed
  "reason": "illustrate the metric spike"
}
```

**Gap shopping-list (the new capability):**
- A placement may declare `"source": "gap"` with a `description`, `desired_duration_seconds`, and `scene_ref` instead of a concrete clip.
- At save, the engine collects all gaps into **`plan/broll_gaps.json`** (typed: `{description, desired_duration, scene_ref, reason}`) and surfaces them at the PLAN gate.
- Plan-lint emits an **overridable** `broll_gap_unfilled` warning per gap — informational, never blocks sign-off.
- The human resolves a gap by **uploading more footage**: a sanctioned **PLAN→INGEST back-edge** re-runs INGEST/INSPECT on the new files, which extends the B-roll index; PLAN re-derives and the gap auto-resolves when a matching clip exists. (Stretch: a `vob_resolve_broll_gap` helper that maps a newly-ingested clip to a gap id. MVP: the gap list is an artifact + lint warning; resolution is re-ingest.)

This gives PLAN a real conversation: *"here's the b-roll I have, here's where the cut wants coverage I don't have — upload these N shots or I'll hold on the spine."*

---

## 5. Cross-cutting changes

- **Editorial generalization (clean-cut becomes preset-gated).** Ordering is fine: INSPECT already only *computes* `inspect/clean_speech.json` (keep-spans are signal, not a decision); the storyboarder *applies* them at PLAN. v3: the preset's `editorial.clean_cut` decides whether PLAN snaps cuts to keep-spans. INSPECT keeps computing it (cheap, harmless) regardless. No FSM reorder.
- **Lint rulesets.** Plan-lint and composition-QC gain a notion of an *active ruleset* from the preset (`retention` / `chaptered` / `montage` / `tutorial`), implemented as per-rule enable/disable resolved like other config. `hook-first` and short-duration-drift move under `retention` only; new `chapter_coverage` / `section_balance` rules under `chaptered`.
- **Audio bed (new layer).** `music_vo` intent already exists; v3 adds an assembly-time master bed (music ducked under VO/narration). Meaningful for long-form where per-segment audio would seam. Scoped to assembly/PACKAGE.
- **PACKAGE.** Emit YouTube **chapter markers** from narrative segments; hook-aware thumbnail already exists; README/manifest gain format + preset + duration lineage.
- **Schema versioning.** Bump to **1.2**: overlays-as-objects, optional `segments[]`/narrative acts, richer `broll_placements`. 1.0/1.1 stay readable (string overlays accepted; no `segments` ⇒ single render as today). `storyboardTimelines()/allStoryboardScenes()/findTimeline()` extend to be segment-aware, staying the single mode-agnostic accessor set.
- **Adapters.** SKILL.md/`vob.md` spine + the PLAN/COMPOSE/PREVIEW/RENDER phase files gain segment + overlay-layer + b-roll-gap guidance; `storyboarder.md`/`composer.md`/`lint-rules.md` get the 1.2 contract and overlay-type recipes. Both adapters stay in lockstep; the boot drift guard still cross-checks tool lists (new `vob_assemble_video` added to both allow-lists).

---

## 6. Data-model & file-impact summary

| Area | Change | Files (indicative) |
|---|---|---|
| Format profiles | `fps` field real; long-form/cinematic/tutorial profiles | `platform-profiles.js` |
| Presets | New resolver + built-ins + override file + `video_type` intent dim | new `video-types.js`, `intent-schema.js`, `record-intent-answer.js`, `.vob-config/video-types.example.json` |
| Storyboard schema | overlays→objects; `segments[]`/acts; richer `broll_placements`; v1.2 | `storyboard-schema.js`, `storyboard-markdown.js` |
| Segmented render | per-segment compose/render; `{segment_id}` scoping | `save-composition.js`, `render-full.js`, `render-preview.js`, `clip-materialize.js`, `source-symlink.js` |
| Assembly | concat + transitions + master audio bed | new `concat.js`/`assemble.js`, new tool `tools/assemble-video.js`, `loudnorm.js` |
| Lint / QC | preset rulesets; overlay + b-roll-gap + segment codes | plan-lint in `save-storyboard.js`, `composition-qc.js`, `lint-report.js` |
| Gates | `segments_missing_render`, `video_not_assembled` | `phase-gates.js`, `session-state.js` (`ALLOWED_TRANSITIONS` for PLAN→INGEST b-roll back-edge) |
| Doctor | report resolved preset + format/editorial values | `doctor.js` |
| Walker | new `general` / `longform` / `overlays` phases | `scripts/m5-walker.js` |

---

## 7. Backward compatibility & migration

- Pre-v3 storyboards (schema 1.0/1.1) validate unchanged: string overlays accepted as legacy notes; no `segments` ⇒ today's single-composition render; no `video_type` ⇒ derived `social-short`.
- Pre-v3 sessions read fine (read-time defaults, as v2 did).
- No `video-types.json` and no env ⇒ byte-for-byte v2.1 behavior for short-form (the `social-short` preset reproduces current defaults).
- New required intent keys: **none**. `video_type` is optional/derived.

---

## 8. Suggested phasing (each independently shippable + walker-verified)

- **P1 — Format & presets.** Generalize `platform-profiles` (fps, long-form profiles), add the preset resolver + `video_type` intent + doctor reporting + preset rulesets. *Unlocks "any format" without touching render.* Walker: `general` phase (preset resolution, custom geometry, fps).
- **P2 — Segmented render + assembly.** `segments[]`, per-segment cycling, `vob_assemble_video` (concat + transitions + master audio bed), gates, verification. **The length unlock.** Walker: `longform` phase (multi-segment render → concat → drift-clean assembly).
- **P3 — Overlay layer.** Schema 1.2 typed overlays, composer vocabulary + recipes, plan-lint/QC codes. Walker: `overlays` phase (typed overlay save, timing/safe-area/dwell negatives, kinetic-caption sync).
- **P4 — B-roll richness + gap list.** Planned placements, `broll_gaps.json`, PLAN→INGEST back-edge. Walker: gap-emission + re-ingest-resolves assertions.

P1 and P3 are largely independent; P2 is the critical-path lift; P4 depends on P3's schema bump.

---

## 9. Open questions / risks

1. **Unify `shorts[]` and `segments[]`?** Both are "N timelines + join policy" (none vs concat). Keep distinct top-level concepts but share the render/cycling/verify machinery? (Recommended: distinct schema, shared internals. A fan-out *of* long-form videos is out of scope for v3 — note as future.)
2. **`xfade` cost & exactness.** Cross-dissolves at segment boundaries re-encode a window; hard cuts via the concat demuxer are lossless/instant. Default hard cut; `xfade` opt-in per boundary. Verify drift accounting handles the xfade overlap.
3. **Audio ducking quality** at assembly (sidechain compression in ffmpeg) — needs a quality pass; fallback to fixed-gain duck.
4. **Render time for long-form** on the 8 GB Mac. Segmented render is *more* total frames; per-segment timeouts already scale with duration, but a 20-min video is many minutes of wall-clock. Acceptable (it's long-form), but doctor should set expectations.
5. **PiP and the `<video>` budget** — PiP segments need explicit budget accounting so a PiP-heavy segment auto-splits.
6. **Preset authoring UX** — how much does the orchestrator help a user *write* a custom preset vs hand-edit JSON? (MVP: hand-edit the example file; stretch: a guided `vob`-side flow.)

---

## 10. Success criteria

- A 10–20 min `long-form` video renders end-to-end on the 8 GB Mac via segmented render + assembly, ffprobe drift < 0.5 s, reaching PACKAGE with chapters.
- A `cinematic` 24 fps montage renders with clean-cut **off** and montage lint, no hook-first false positives.
- A typed overlay plan (lower-third + kinetic captions + chapter markers) renders correctly and passes the new lint/QC.
- A b-roll gap is emitted at PLAN, the human ingests footage, and the gap auto-resolves.
- A user-defined preset in `.vob-config/video-types.json` is resolved and reported by `vob_doctor`.
- **No regression:** the existing short-form + fan-out walkers stay green; pre-v3 sessions/storyboards still load.

---

*Built on the v2 spec conventions in `docs/v2/`. This PRD can be split into `spec-*.md` files (format/presets, segmented-render, overlay-layer, broll) for implementation, mirroring how v2 was speced and verified.*
