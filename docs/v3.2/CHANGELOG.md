# video-vob v3.3 — hyperframes-leverage creative layer (on top of v3.2)

**One line:** additive creative layers that lean on hyperframes capabilities the engine already
drove but didn't call — shipping as **v3.3** on top of v3.2. PRDs in `docs/hyperframes/`. Three
hyperframes pillars — **caption-system v2** (PRD 01), **scene transitions** (PRD 02), and
**subject compositing** (PRD 03) — land together, alongside the **PACKAGE / ITERATE** output-richness
set (`docs/package-iterate/`). All are additive, fail-safe, and warnings-only at QC.

## Caption system v2 — vendored kit + legibility QC (PRD 01)

Realizes the v3.2 caption PLAN on the COMPOSE side. A vendored **caption-component kit**
(`mcp/assets/captions/`, built by `scripts/build-captions.js` mirroring `build-fonts.js` — materialized
at build time from the hyperframes registry, committed so RUN is offline) gives the composer vetted
caption techniques to adapt; `source-symlink.js` injects it into `compose/` like the font kit.

- **Legibility QC via `hyperframes inspect`** (`layout-qc.js`): the pure-function half of the inspect
  fold-in — it decides WHEN to spend the browser render, parses the overflow / safe-area report, and
  folds issues into the merged-lint findings as **ADVISORY** (overflow → warning, off-canvas → info).
  NEVER an error: the COMPOSE→PREVIEW errors-only gate is unchanged. Closes the deferred
  `steps67-autoqc` safe-area/legibility gap. Runs through the one-runner (`resolveHyperframesCmd`).
- **Leverages the existing binding**: the `data-vob-caption-id` contract (`exact:true`→error) and the
  `PLAN_CAPTION_*` plan-lint layer already live in `composition-qc.js` + `storyboard-schema.js`; this
  pillar realizes them on the COMPOSE side rather than re-inventing them.

## Scene transitions — intra-composition vocabulary + glue packing (PRD 02)

Widens `scene.transition_in` from cut-only to hyperframes' CSS/shader transition vocabulary, realized
**inside** the composition (the browser hyperframes drives).

- **Glue packing** (`transition-glue.js`): a non-cut, non-seam `transition_in` means "render this scene
  in the SAME composition as the previous one" — the transition is intra-composition and can't be an
  ffmpeg seam. `deriveRenderPlan` packs **glue groups** (not bare scenes) to the host `<video>` budget;
  a glue group still over the hard cap is split at the cheapest internal boundary with the broken
  transition **downgraded** (dissolve family → `fade`/dip-to-black, else → `cut`), surfaced as
  `PLAN_TRANSITION_DOWNGRADED`.
- **Seams stay cut / dip-to-black**: cross-composition boundaries (the assembly join) keep the existing
  lossless-concat / 0.25s dip-to-black behavior — transitions never poison drift verification.

## Subject compositing — `render_mode: "subject"` (PRD 03)

A new `broll_placements[].render_mode: "subject"` (schema 1.2, additive) lifts a talking-head /
foreground subject off its filmed background with hyperframes' **local** `remove-background` model
and composites it over a designed or ingested **backdrop** — clean non-rectangular PiP,
podcast→video, a cinematic talking-head spine. It only ever *transforms footage the user already
shot*, so it stays inside the ingested-only contract.

- **Schema + plan lint** (`storyboard-schema.js`): `BROLL_RENDER_MODES += "subject"` +
  `BACKDROP_KINDS` (`design_token` | `clip_ref` | `scene_base` — NO synthesized/stock/AI
  backdrops). A subject placement references a real clip (`clip:{scene_id,clip_index}`, never a
  gap) plus a `backdrop` (+ optional `position{anchor,scale}`, `motion{in,out}`). Warnings only:
  `PLAN_SUBJECT_BACKDROP_NOT_INGESTED` (the ingested-only guard, human-visible at the gate — a bad
  kind / unresolved ref WARNS and the save STANDS) and `PLAN_SUBJECT_BUDGET_EXCEEDED` (per render
  unit vs the host subject-seconds budget).
- **The matte is a COMPOSE-entry side effect** mirroring `clip-materialize.js`:
  `matte-materialize.js::materializeSubjectMattes` mattes each subject's already-pre-cut clip to an
  alpha `.webm` under `transcoded/mattes/`, content-hash cached (back-edge re-entry is a no-op),
  symlinked into `compose/source/<scene_id>-<clip_index>.webm`. It **DEGRADES, never throws** — a
  missing/uncached model, a disabled host (`VOB_REMOVE_BG_DISABLE`), an over-budget set, or a
  failed inference records the matte `skipped`/`unavailable`/`failed` and COMPOSE still proceeds
  (the composer falls back to a rectangular `pip`; subject mode is ADVISORY at QC).
- **One hyperframes runner**: every `remove-background` call flows through `resolveHyperframesCmd()`
  / `hyperframesChildEnv()` like render/snapshot/transcribe — pinned engine, no npx, duration-aware
  timeout, `retryTimedOut:false`. Knobs: `VOB_REMOVE_BG_DEVICE` (coreml-on-darwin / cpu),
  `VOB_REMOVE_BG_TIMEOUT_MS`, `VOB_REMOVE_BG_DISABLE`.
- **Two composer realizations** (recipes in `references/lint-rules.md`): (a) DEFAULT — the matte as
  an alpha `<video>` over an HTML/CSS backdrop, subject audio from the sibling `.mp4`; (b) low-RAM
  FALLBACK — `overlay-compositor.js::compositeOverlayOverBase` over a `buildBackdropArgv`/
  `generateBackdrop` design-token backdrop (or a clip base), the subject's audio muxed, backdrop
  laid muted.
- **Preflight**: INGEST `state.dependencies.remove_background` + `vob_doctor` report the matte
  backend (providers, model-cache state, device) — warn-only, NEVER flips `ok:false`. Host budget
  via `host-profile.js::subjectBudget` (`VOB_SUBJECT_SECONDS_MAX`; default 60s low-RAM / 600s; in
  `CAPACITY_TIERS`; surfaced in `vob_doctor` `report.tuning`).
- **State**: `read_state_summary.subject_mattes{count,matted,cached,skipped,over_budget,
  backend_available}` + a `subject_mattes_materialized` history event.
- **Verified end-to-end** against real footage via `node scripts/m5-walker.js subject`:
  schema/lint negatives + positives run model-free; the real matte (`VOB_WALKER_MATTE=1`) produced
  the alpha `.webm` + sidecar, re-entry reported `cached` (content-hash no-op), and the path-(b)
  ffmpeg composite was duration-exact (4.02s vs 4.00s) with the subject's audio retained.

## PACKAGE / ITERATE — Wave A output richness (`docs/package-iterate/`)

Five additive PRDs that enrich PACKAGE output and make ITERATE legible (merged from
`v3/package-iterate-wave-a`). No FSM edge/gate changes; the four package PRDs extend
`vob_package_output` + the fan-out `import-deliverable` mirror, and PRD-04 adds one read-only tool.
The package manifest stays **v1.2** (canonical key order chapters, captions, distribution, posters,
video, aspect_variants).

- **01 caption sidecars** — chunk-level `.srt`/`.vtt` from `scene.caption_segments[]`, re-timed
  SOURCE→OUTPUT exactly as the composer cuts (`cursor + (start − clip.in_seconds)`), clamped to the
  probed duration. Shared `mcp/lib/caption-sidecar.js`; mirrored per-short into `deliverables/`.
- **02 poster set** — the single thumbnail generalized to N output-time frames (`VOB_POSTER_COUNT`,
  else chapters-derived); `poster_0` IS the thumbnail (fatal), the rest strictly non-fatal (warnings).
- **03 distribution metadata** — `target.distribution{title,description,hashtags,cta}` validated like
  `target.design` (never lints); fenced copy-paste blocks + a chapter-stamp paste block in the README,
  mirrored into the fan-out manifest.
- **05 multi-aspect dumb-crop** — opt-in `aspect_variants`, pure-ffmpeg cover+center-crop labeled
  `quality:"naive_crop"` (`-c:a copy`); single-timeline only, unknown aspects rejected.
- **04 `vob_compare_iterations`** — read-only cross-version diff over `archive/v<N>` snapshots;
  null-not-zero deltas, mode-agnostic scene set.

Wave B (06 structured revision capture + version labels, 07 promote-an-archived-cut) is specced but
**held** — it touches `transitionPhase`/`archival.js` and lands in a later pass.

---

# video-vob v3.2.0 — consolidated release notes (vs `main` @ v2.1.0)

**One line:** the whole v3 line ships to `main` in one release — a **general agentic video
editor** (any format, any length, planned overlays + b-roll) on top of a **deep INSPECT**
(karaoke-grade alignment, full audio analysis, rich multi-file tagging) and **typed creative
PLAN layers** — with the v2.1 short-form path preserved byte-for-byte as the default.

`main` was last at **2.1.0**; everything below has lived on `v3/general-video` and merges as
**3.2.0**. Version-of-record (`.vob/VERSION`, `package.json`, `mcp/server.js`,
`.vob/install.json`) is **3.2.0**.

Earlier internal milestone labels (`v3.0.0`, `v3.1`, the "v4" Deep Inspect PRD) have been
unified under **v3.2** — none of them was ever released to `main`.

---

## 1. General Video — any format, any length (was v3.0 "General Video")

Full detail in [`docs/v3/CHANGELOG.md`](../v3/CHANGELOG.md); PRD in `docs/v3/PRD.md`.

- **Video-type presets** (`mcp/lib/video-types.js`): `social-short` · `long-form` · `cinematic`
  · `tutorial` · `podcast` · `general`, plus user presets in `.vob-config/video-types.json`. A
  preset bundles platform default · clean-cut on/off · plan-lint ruleset · overlay vocabulary ·
  render segmentation. Resolution precedence `VOB_VIDEO_TYPE` env → `video_type` intent answer →
  derived from platform+duration → `social-short`. `video_type` is a new **OPTIONAL** intent key
  (never required, never gates). New platform profiles `youtube_long` / `cinematic` (24 fps) /
  `tutorial`; storyboard `target.fps` → composer `data-fps`, cross-checked by QC `vob/fps_mismatch`.
- **Segmented render + assembly** (schema 1.2 `segments[]`, `vob_assemble_video`): narrative
  acts/chapters render as host-budget-sized chunks and join in plan order — lossless concat for
  cut boundaries, duration-preserving dip-to-black for fades, optional sidechain-ducked music
  bed. The 8 GB-Mac `<video>` ceiling stops being a length limit. Titles become YouTube chapters
  at PACKAGE. Mutually exclusive with `shorts[]`.
- **Typed overlay layer** (schema 1.2 `scene.overlays[]`): a fixed composer-coded vocabulary
  (`title_card`, `lower_third`, `callout`, `kinetic_caption`, `pip`, `cta`, `end_card`, …).
  Plan lint (`PLAN_OVERLAY_*`) and a QC binding (`data-vob-overlay-id`, `vob/overlay_*`) make the
  plan enforceable. Plain strings stay valid as freeform notes.
- **Planned b-roll + the gap shopping list** (schema 1.2): placements gain `render_mode`
  (`full_frame`/`pip`/`overlay`) + `motion`; a placement may declare `{source:"gap", …}` for
  coverage the footage can't supply, collected into `plan/broll_gaps.json` and warned
  (`PLAN_BROLL_GAP_UNFILLED`, informational). New sanctioned **PLAN→INGEST** back-edge resolves
  gaps by re-ingesting an extended drop. Ingested-footage-only stays the rule.
- **Multi-short fan-out stays first-class** (active-short model, schema 1.1).
- **Backward compatible:** no `video_type` answered ⇒ derived `social-short` ⇒ v2.1 lint/render
  behavior exactly; schema 1.0/1.1 storyboards and pre-v3 sessions load unchanged.

## 2. Deep INSPECT — understand the footage

PRD in [`docs/v3.2/PRD.md`](./PRD.md) (formerly the "v4" Deep Inspect PRD).

- **P1 — karaoke-accurate transcription.** New alignment-capable ASR backend (`whisperx`,
  wav2vec2 forced alignment, no HF token) prepended to the pluggable stack; canonical
  `[{text,start,end,p}]` words gain alignment-grade timing and a real per-word `p`. Document-level
  `transcript_aligned` marker threads through `inspect.json` → state → the storyboarder spawn and
  gates word-level caption animations (`PLAN_CAPTION_KARAOKE_UNALIGNED`). Degrades cleanly to
  faster-whisper native timing (`aligned:false`) — nothing breaks without `whisperx`.
- **P2 — audio analysis for normalization** (`mcp/lib/audio-analysis.js`,
  `inspect/audio_analysis.json`, `state.inspect.audio`): per-channel LUFS/RMS/peak via
  `channelsplit`, L/R balance, phase correlation, dual-mono / dead-channel detection, per-segment
  loudness, and a −14 LUFS normalization advisory (gain delta + true-peak clip risk) plus a
  `clean_audio_source` hint. ffprobe gains per-stream `audio_streams_detail[]`. Knob
  `VOB_DISABLE_AUDIO_ANALYSIS`; degrades on a build missing `aphasemeter`/`channelsplit`.
- **P3 — richer visual tagging** (classification schema 1.0 → 1.1, all fields OPTIONAL): shared
  `camera_movement` / `setting` / `content_tags[]` / `on_screen_text` / `action`; A-roll
  `content_description` / `eyes_to_camera`; B-roll `b_roll_role`; a top-level `file_roles[]`
  multi-file map. New coverage counts in `state.inspect.classification` (quality notes, never
  gates). Vision-LLM only — no OCR, no new deps.
- INSPECT timeouts already scale with source duration; pre-v3.2 payloads validate unchanged.

## 3. PLAN creative layers — typed, planned, lint-bound

(Lives in `storyboard-schema.js`; CLAUDE.md invariant "PLAN's creative layers … (v3.2)".)

- **First-class kinetic captions** — `scene.caption_segments[]` gain `emphasis_words[]`,
  `animation` (`pop`/`word-by-word`/`karaoke`), `style_ref`, `position`. Plan lint WARNS, never
  blocks (`PLAN_CAPTION_CHUNK_TOO_LONG` / `_EMPHASIS_NOT_IN_TEXT` / `_TIMING_DRIFT` /
  `_KARAOKE_UNALIGNED`). Captions stay **advisory at COMPOSE-QC** (no hard binding, unlike typed
  overlays).
- **The look contract** — `target.design{palette,typography,caption_style,motion,grade}`: a
  loosely-shape-checked token block the composer renders from and `--like` copies verbatim; never
  lints. Each preset carries a `design_default` the orchestrator seeds the brief from.
- **Pacing as an arc** — `PLAN_PACING_MONOTONE` (universal) + `PLAN_RHYTHM_ARC_INVERTED`
  (ruleset-gated to `retention`) over the per-scene `pacing` enum.
- **Clip speed + caption binding** — per-clip speed multipliers and the P1 alignment → caption
  timing contract wired through PLAN → COMPOSE.

## 4. PREVIEW / RENDER — automated stills QC

- **`vob_qc_stills`** (`mcp/lib/tools/qc-stills.js`): automates the **QC-C** black/empty/
  half-loaded-frame check by running `ffmpeg`/`ffprobe` luma stats over the snapshot stills the
  composer already produces. Zero new render, zero new deps, callable right after a save.
  Contrast / safe-area checks deferred (no hyperframes geometry). Spec:
  [`docs/preview-render/autoqc-stills-spec.md`](../preview-render/autoqc-stills-spec.md).

## 5. PACKAGE + ITERATE improvements — landing for 3.2

Seven implementation-ready PRDs in [`docs/package-iterate/`](../package-iterate/README.md).
**Wave A is the last work being implemented for the 3.2 merge:**

- **01 — Caption sidecars** (`.srt` + `.vtt`) at PACKAGE and `import_deliverable`.
- **02 — Poster set:** generalize the single thumbnail to N output-time frames.
- **03 — Distribution metadata:** title/description/hashtags/chapter-paste as a typed PLAN layer
  (`target.distribution`) surfaced at PACKAGE + import.
- **04 — `vob_compare_iterations`:** read-only cross-version diff over archived snapshots.
- **05 — Multi-aspect dumb-crop:** opt-in, labeled-lossy aspect-ratio escape hatch.

Wave B (engine-heart, serialized after Wave A): **06** structured revision capture + ratable
version labels at the back-edge, **07** promote an archived cut via the existing back-edge.

## 6. Engine / version

- **Version-of-record → 3.2.0** across `.vob/VERSION`, `package.json`, `mcp/server.js`,
  `.vob/install.json` (the latter three were stale at `2.0.0`).
- Engine stays **zero npm deps** (pure Node ≥22 stdlib, CommonJS). No new FSM phases beyond the
  v3 PLAN→INGEST back-edge. No Docker. Latest versions, nothing pinned.

## Backward compatibility

- Schema 1.0/1.1/1.2 storyboards and pre-v3 sessions load unchanged.
- No new **required** intent keys (the five required keys are untouched; `video_type` is optional).
- No `.vob-config` overrides + no env ⇒ byte-for-byte v2.1 short-form behavior.
- Every Deep INSPECT and creative-PLAN field is additive/optional with read-time defaults.
