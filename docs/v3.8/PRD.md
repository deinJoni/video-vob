# v3.8 — FSM Stage-by-Stage Quality & Robustness Pass

**Status:** planning → implementing · **Branch:** `v3.8/fsm-improvements` · **Base:** main @ 3.7.0
**Detailed findings ledger:** `docs/v3.8/PROGRESS.md` (the 45 audited findings + status table).

## Theme

v3.7 generalized the editor to "any format, any length" and added creative-intent knobs. v3.8 is a **quality & robustness pass over every FSM stage**: close the signal-loss paths between stages, give the new creative layers enforcement teeth, make the rendered *pixels and audio* actually get QC'd, and harden the fan-out/segmented and resume paths. No new FSM edges. No new required intent keys. Output quality first; degrade-don't-die preserved; data-not-branches.

## Cross-cutting fixes (build once, consumed by multiple stages)

- **XC-1 — Realized-cut expected duration.** New shared helper deriving expected output seconds from `sceneArollOutputSeconds` (speed/layout-baked) for the active scope, replacing the declared `total_target_duration_seconds` in drift verification. Used by `render-preview` + `render-full`. _Fixes a real false-positive/false-negative in silent-truncation detection (RENDER#4 = PREVIEW#6)._
- **XC-2 — Rendered-output visual/audio QC.** New shared helper: ffprobe-extract N frames across an MP4 + `signalstatsLuma` → black/low-luma spans; quick `volumedetect`/loudnorm → silent-audio flag. Advisory `verification` fields, never fatal. Folded into `verifyRenderedMp4` (RENDER) and the preview path (PREVIEW). _Catches the dropped-`<video>` all-black / failed-audio-mux class that duration drift can't (RENDER#12 = PREVIEW#1)._
- **XC-3 — Safe-band data is shared.** Platform profiles already carry `safe_top_px`/`safe_bottom_px`. Enforce at PLAN (planned positions, INTENT/PLAN#6) and COMPOSE (rendered bounding boxes via `hyperframes inspect`, COMPOSE#2).

## Per-stage plan (FSM order; P1 = do, P2 = do, P3 = do-if-cheap/safe)

### Stage 1 — INSPECT (+ INGEST preflight) · `asr-backend.js`, `asr/`, `inspect.js`, `inspect-digest.js`, `audio-analysis.js`
- **P1** ASR default `small.en` → multilingual `small`; fix whisperx forcing `language="en"` on `.en`; INGEST/doctor preflight note when an `*.en` model is configured. _(unlocks the advertised CJK/bilingual transcript)_
- **P1** Default `vad_filter=True` in faster-whisper driver behind `VOB_ASR_VAD` (auto|on|off); kills hallucinated words over silence that defeat clean-cut's dead-air gate.
- **P1** Scene-detect zero-cut adaptive retry (0.4 → lower) on long video-bearing files; stamp `scene_detection_basis` into file summary/digest; fold basis into the content-hash cache key.
- **P2** openai-whisper driver: include detected `language` in envelope (bug).
- **P2** Hook scoring: weight language-agnostic energy/speech-rate signals when detected language ≠ en; gate English lexicon on language.
- **P3** Clean-audio-track picker: penalize `|balance_db|`, prefer transcribe-winner on ties.
- **Defer:** per-file ASR concurrency (perf, not output).

### Stage 2+3 — INTENT→PLAN · `storyboard-schema.js` (plan lint), `brief-validator.js`, `phase-gates.js`
- **P1** Intent-enforcement teeth (reads `ctx.state.intent.answers`, all WARNINGS, fail-safe): `PLAN_PACING_INTENT_IGNORED`, `PLAN_LAYOUT_INTENT_UNMET`, `PLAN_TRANSITION_INTENT_UNMET`, `PLAN_CAPTION_ANIMATION_INTENT_UNMET`.
- **P1** `PLAN_CAPTION_SEGMENTS_ON_SILENT` — captions-on-silent for the first-class `caption_segments[]` layer (legacy string already covered).
- **P1** Broaden `PLAN_KEY_MOMENT_UNCOVERED` parser: single points / `mm:ss` / "to…seconds" forms (reuse `parseSingleDuration`).
- **P2** `PLAN_TARGET_PLATFORM_DRIFT` + `PLAN_TARGET_FPS_DRIFT` (target vs intent canonical; promote fps check to PLAN).
- **P2** Generalize overlay safe-area to `safe_top_px` + extend to `caption_segments[].position` (XC-3).
- **P2** Floor lints `PLAN_SCENE_TOO_SHORT`, `PLAN_SCENE_EMPTY`.
- **P3** `PLAN_HOOK_NO_SPEECH` (retention-gated); `brief-validator` audio count from manifest; overridable `plan_stale_vs_intent` gate blocker.

### Stage 4 — COMPOSE · `composition-qc.js`, `layout-qc.js`, `lint-composition.js`, `caption-sidecar.js`, `save-composition.js`
- **P1** Safe-band / edge-clip QC on snapshot stills via `hyperframes inspect` against profile safe bands (XC-3); the #1 glaring auto-fix item (QC-A) becomes engine-flagged with timecodes.
- **P2** `vob/master_duration_long` warning (symmetric to the existing short check).
- **P2** Broaden `shouldRunLayoutQc` to fire on caption-class/text markup, not only object-form plan captions.
- **P2** `vob/layout_degraded_fallback` warning naming scene + extra `<video>` cost when a layout materialize degraded; surface materialize error/reason to QC.
- **P2** lint-path `runInspect` targets caption/overlay-window timecodes when in scope.
- **P3** `vob/design_font_partial` info; multi-clip caption-sidecar anchoring; `wipeComposeDir` atomicity (temp+swap or warn-not-throw); snapshot timecode→filename map.

### Stage 5 — PREVIEW · `render-preview.js`, `confirm-preview.js`
- **P1** Visual/audio QC on the rendered preview (XC-2).
- **P1** Realized-cut drift (XC-1).
- **P3** `confirm_preview` revision cross-check.

### Stage 6 — RENDER · `render-verify.js`, `render-full.js`, `render-segments.js`, `assemble.js`, `assemble-video.js`, `hyperframes-runner.js`
- **P1** Black-frame / silent-audio QC in `verifyRenderedMp4` (XC-2); realized-cut drift (XC-1).
- **P2** Enforce per-segment `confirmed` in `validSegmentRenders` before assembly.
- **P2** Music duck: surface `ducked` into manifest/README/result, make params tunable, warn on flat-mix fallback.
- **P2** Auto screenshot-path fallback (`PRODUCER_FORCE_SCREENSHOT=1`) on a `<video>`-budget render timeout before throwing.

### Stage 7 — PACKAGE · `video-types.js`, `loudnorm.js`, `ffmpeg-runner.js`, `caption-sidecar.js`, `package-output.js`
- **P1** Per-video-type loudness target (`loudness_target{i,tp,lra}` in presets; thread `resolveActiveVideoType`; stamp into manifest; default −14 keeps short-form byte-identical).
- **P2** Loudnorm "within tolerance" skip considers measured LRA; record `measured_input_lra`.
- **P2** Word-level VTT sidecar when aligned + word-animation planned (`level:"word"`).
- **P3** Segmented drift uses plan/assembly total; skip redundant package loudnorm when normalized at assembly.

### Stage 8 — ITERATE · `compare-iterations.js`, `archival.js`, `finalize-iteration.js`
- **P2** `compare_iterations` reads archived `package/manifest.json` → output duration / LUFS / dims / chapter / caption-cue deltas.
- **P3** Archival sweeps `segment_renders/` + clears stale matte/layout caches; `finalize_iteration` calls `missingShortDeliverables` backstop.

### Stage 9 — FSM CORE / cross-cutting · `session-state.js`, `phase-gates.js`, `storage.js`, `transport.js`, `tool-validation.js`, `paths.js`
- **P1** Stamp `short_id`/`segment_id` on preview+render slots; surface in summaries; guard `previewToRender`/`render_full` against confirming the wrong short (overridable:false).
- **P1** Process-level lock release on SIGINT/SIGTERM/exit (token-guarded) — stops killed long renders stranding the session for 5 min.
- **P2** `intentToPlan` reads inspect summary from the **canonical** path (disk-truth, like `inspectToIntent`).
- **P2** COMPOSE→PREVIEW lint-staleness fingerprint (block overridable `lint_stale`).
- **P2** Clip-materialize failure surfacing (failed scene_ids in clip digest + `materialization_warnings` in `transition_phase` return).
- **P3** dependency unknown-state (ok/failed/unknown); transport byte-accurate framing (CJK); validator null/oneOf messages; `assembly_status` enum; archive-on-compose-only back-edge; `assertSafeProjectId` leading-dot.

## Method / acceptance per stage

audit → design → implement → self-verify (`node scripts/m5-walker.js <phase>`, boot `npm run mcp` clean, targeted Node asserts on pure functions) → adversarial review (subagent) → mark done in PROGRESS.md. Bump VERSION + CHANGELOG + CLAUDE.md invariants as slices land. Commit per coherent slice. New plan-lint codes get fix recipes in the adapters' `lint-rules.md` where relevant; new tools (none expected) would need the dual allow-list sync.

## Explicitly out of scope

Tests/CI/code-linters (maintainer-deprioritized). New FSM edges. New required intent keys. Docker. Pinning/downgrading hyperframes. Stock/AI b-roll or synthesized backdrops (ingested-only contract holds).
