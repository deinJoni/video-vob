# video-vob v3.0.0 — "General Video" (vs v2.1.0)

**One line:** from a short-form generator to a general agentic video editor — any format, any
length, overlays and b-roll planned as real layers — with the v2.1 TikTok path preserved
byte-for-byte as the default.

Built per `docs/v3/PRD.md`; per-pillar verification evidence in `docs/v3/PROGRESS.md`.

---

## 1. Any format — video-type presets (P1)

- **New preset system** (`mcp/lib/video-types.js`): `social-short`, `long-form`, `cinematic`,
  `tutorial`, `podcast`, `general` — plus **user-defined presets** in
  `.vob-config/video-types.json` (shallow-merge over built-ins; a new name becomes a new preset
  based on `general`; an unknown name falls back to `general`, never an error). Template:
  `.vob-config/video-types.example.json`.
- A preset bundles: platform default · clean-cut on/off · plan-lint ruleset · overlay
  vocabulary · render segmentation policy. Presets set defaults, never hard limits.
- **Resolution precedence:** `VOB_VIDEO_TYPE` env → optional `video_type` intent answer →
  **derived from platform + duration** (youtube + 12 min ⇒ long-form; tiktok + 30 s ⇒
  social-short) → `social-short`. `read_state_summary.video_type` shows what's active and why
  (`source`).
- **`video_type` is a new OPTIONAL intent key class** — recordable, canonicalized from free
  text ("a cinematic montage" ⇒ `cinematic`), but never required and never gates. The 5
  required keys are untouched.
- **Lint rulesets:** hook-first / hook-length heuristics now fire **only under `retention`**
  (social). `chaptered` (long-form/tutorial/podcast) swaps them for `PLAN_CHAPTERS_MISSING` +
  `PLAN_SECTION_IMBALANCE`; `montage` (cinematic) drops them. Clean-speech straddle warnings
  apply only when the preset's `clean_cut` is on (cinematic cuts on motion, not keep-spans).
- **New platform profiles:** `youtube_long` (ideal 5–20 min), `cinematic` (**24 fps**),
  `tutorial` (screencast safe areas). fps is real per-profile data; `"long-form"`, `"podcast"`,
  `"film"`, `"screencast"` etc. now alias sensibly.
- **fps reaches the render:** storyboard `target.fps` → composer sets `data-fps` on the master
  root → QC warns `vob/fps_mismatch` if they disagree (absent attr = 30, the hyperframes
  default).
- `vob_doctor` reports the full preset table + per-project resolution (`report.video_types`;
  pass `project_id` for the per-project line).

## 2. Any length — segmented render + assembly (P2)

- **Schema 1.2 `segments[]`:** narrative acts/chapters over `scenes[]` (contiguous partition,
  validated; mutually exclusive with `shorts[]`). Titles become **YouTube chapter markers** in
  the package manifest plus a paste-ready `0:00 Title` block in the README.
- **Render segmentation** (`single` | `auto` | `manual`): long-form presets auto-chunk
  consecutive scenes to the host `<video>` budget — the 8 GB-Mac ceiling stops being a length
  limit; `manual` renders your declared acts; everything collapses to `single` when one
  composition fits (zero overhead for shorts). The derived plan is stamped into
  `state.render_plan` at COMPOSE entry.
- **Per-segment cycling**, mirroring fan-out: `vob_save_composition {segment_id}` (required on
  a segmented plan) scopes QC, render timeouts, drift verification, and snapshot defaults to
  that segment; `vob/cross_segment_clip_ref` / `vob/active_segment_unresolved` warn.
- **Archival-safe partials:** `vob_render_full` writes segment partials to
  `<session>/segment_renders/` — deliberately outside `renders/`, because the per-segment
  RENDER→COMPOSE back-edge auto-archives `renders/` — and records them in a **revision-bound
  registry** (`state.segment_renders`): re-saving the storyboard invalidates every stale
  partial. `vob_confirm_render` mirrors confirmation into the registry.
- **New tool `vob_assemble_video`:** joins partials in plan order — **lossless concat-demuxer
  stream copy** for hard cuts; `fade` boundaries re-encode as a duration-preserving 0.25 s
  dip-to-black (deliberately not xfade: overlap would shorten the total and poison drift
  verification — measured 0.034 s drift on the verification run); optional **music bed**
  (`music_path`, looped, pre-gained via `music_gain_db`, sidechain-ducked under program audio,
  fixed-gain fallback); optional `normalize` (−14 LUFS in place). The assembled final *becomes*
  `state.render`, so confirm → PACKAGE works unchanged.
- **New gates:** RENDER→PACKAGE blocks on `segments_missing_render` / `video_not_assembled`
  (both overridable, for deliberate partial ships only); `vob_package_output` refuses an
  unassembled segmented project before wiping anything.

## 3. Overlays as a planned, typed, enforced layer (P3)

- `scene.overlays[]` entries can now be **typed objects**: `{id, type, start/end_seconds
  (SCENE-relative), track, content, position{anchor, offset_px}, style, motion{in, out,
  dwell_min_s}}`. Plain strings remain valid everywhere as freeform notes.
- **Fixed composer-coded vocabulary:** `title_card`, `lower_third`, `callout`,
  `kinetic_caption`, `caption_block`, `logo_bug`, `progress_bar`, `chapter_marker`,
  `section_title`, `data_viz`, `cta`, `end_card`, `pip` — a PiP carries a `<video>` and counts
  against the video budget (plan lint and the auto-chunker both account for it).
- **Plan lint:** `PLAN_OVERLAY_OUT_OF_BOUNDS` (error — overlay past its scene); warnings for
  readability dwell (`PLAN_OVERLAY_DWELL_TOO_SHORT`, ≥1.2 s or `motion.dwell_min_s`),
  same-real-estate collisions (`PLAN_OVERLAY_CONFLICT`: bottom-band and full-frame groups),
  safe-area violations (`PLAN_OVERLAY_SAFE_AREA`), kinetic captions without speech
  (`PLAN_KINETIC_CAPTION_NO_SPEECH`), and the per-render-unit video budget
  (`PLAN_VIDEO_BUDGET_EXCEEDED` — whole doc / per segment / per short).
- **QC enforces the plan:** every planned overlay must exist as an element stamped
  `data-vob-overlay-id="<id>"` — missing is an **error** (`vob/overlay_missing_element`, same
  severity as a missing scene clip). `vob/overlay_track_zero`, `vob/overlay_element_untimed`,
  and `vob/unplanned_overlay_element` warn.
- Per-type HTML/CSS implementation recipes added to the adapters'
  `references/lint-rules.md` (§Overlay vocabulary).

## 4. Richer b-roll + the gap shopping list (P4)

- Placements gain **`render_mode`** (`full_frame` | `pip` | `overlay`) and **`motion`**
  (`ken_burns`, `none`, `speed_ramp`, …).
- **Gap form:** a placement may declare `{source: "gap", description,
  desired_duration_seconds, scene_ref, narration_span?, reason?}` instead of a clip — honest
  "the footage can't cover this" planning. Gaps collect into **`plan/broll_gaps.json`**
  (regenerated on every storyboard save; `broll_gap_count` stamped into state/result/summary)
  and warn `PLAN_BROLL_GAP_UNFILLED` — informational, never blocks sign-off.
- **New sanctioned back-edge `PLAN → INGEST`:** upload more footage, re-ingest the extended
  drop, re-walk INSPECT → INTENT (answers persist; content-hash caches make old files cheap) →
  PLAN; the gap auto-resolves on the next save. Ingested-footage-only stays the rule — no
  stock, no AI b-roll.

## 5. Everything else

- **PACKAGE manifest v1.2:** `chapters[]`, resolved `video_type` lineage, `assembly` record;
  README gains the Chapters block.
- **Walker:** four new standalone phases — `general` (presets/rulesets/fps), `longform`
  (segmented render + assembly with real renders), `overlays`, `gaps` — alongside the untouched
  `setup`/`preview`/`render`/`package`/`all`/`fanout`.
- **Adapter sync is now scripted:** `scripts/port-adapter-docs.js` regenerates the OpenCode
  phase files, references, and subagent bodies from the claude-code sources (the `vob.md`
  orchestrator spine stays hand-synced).
- **New env knobs:** `VOB_VIDEO_TYPE` (pin the preset per process), `VOB_VIDEO_TYPES_FILE`
  (preset file path override — share one preset file across installs).

## Backward compatibility

- Schema 1.0/1.1 storyboards and pre-v3 sessions load unchanged; string overlays stay legal;
  `shorts[]` is legal under schema 1.1 **or** 1.2 (still mutually exclusive with `segments[]`).
- No `video_type` answered ⇒ derived `social-short` ⇒ v2.1 lint and render behavior exactly.
- No new required intent keys, no new npm dependencies (engine stays zero-dep Node stdlib),
  no new FSM phases (the PLAN→INGEST back-edge is the only new edge).
- No `.vob-config/video-types.json` and no env ⇒ byte-for-byte v2.1 behavior for short-form.
