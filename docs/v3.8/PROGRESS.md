# v3.8 — FSM Stage-by-Stage Improvement Pass · INTERNAL MEMORY

> This is the working memory for the v3.8 effort. It survives across `/loop` iterations.
> Read this first on every wake-up to know where we are.

## Mission

Run the full SDLC on video-vob to **improve each stage of the FSM**, going stage by stage.
Where deeper issues surface, fix them; where only small reworks are needed, do them.
Keep code clean; follow existing architecture.

**Branch:** `v3.8/fsm-improvements` (base: `main` @ 3.7.0)

## Standing constraints (from maintainer memory — DO NOT violate)

1. **Output quality over eng hygiene** — lead with creative/output levers; do NOT add tests/CI/lint-the-code work. (Plan-lint / composition-QC *content* rules ARE in scope — they improve output.)
2. **Always latest versions** — never pin/downgrade (esp. hyperframes).
3. **Never Docker** — banned everywhere.
4. **Follow existing architecture** — data-not-branches, degrade-don't-die, one-runner for hyperframes/ffmpeg, confirm-then-transition, gates check disk truth, FSM defined in two files that must agree (session-state ALLOWED_TRANSITIONS + phase-gates GATES), lean tool returns, atomic writes under session lock.

## SDLC method per stage

For each FSM stage: **audit (done in parallel up front) → design the fix → implement → self-verify (walker / boot / targeted) → adversarial review → mark done**.
Bump VERSION + CHANGELOG + CLAUDE.md invariants as changes land. Commit per coherent slice.

## Stage status

| # | Stage | Status | Notes |
|---|-------|--------|-------|
| 0 | PLAN (this effort) | **done** | 5/5 audits in; PRD.md written + committed |
| 1 | INGEST | folded into INSPECT (preflight note) | ASR `.en` advisory in checkAsrAvailable |
| 2 | INSPECT | **done** ✓ | ASR multilingual default + VAD + scene-detect fallback + crosslingual hooks + openai lang + balance penalty; verified |
| 3 | INTENT→PLAN | **done** ✓ | P1 (teeth/caption-silent/key-moment) + P2 (target-drift/floors/safe-area) + P3 (hook-no-speech); brief-validator audio + stale-vs-intent gate deferred |
| 4 | PLAN (FSM gate) | pending | |
| 5 | COMPOSE | **done** ✓ | master_duration_long, design_font_partial, broadened+aimed inspect QC, layout_degraded_fallback; safe-band stays PLAN-side (no bbox from inspect) |
| 6 | PREVIEW | **done** ✓ | XC-1 realized-cut drift + XC-2 content QC (black-frame/silent-audio); confirm-revision cross-check (P3) deferred |
| 7 | RENDER | **done** ✓ | XC-1/XC-2 + segment-confirm-at-assembly + music-duck surfacing/warning + screenshot-path timeout fallback |
| 8 | PACKAGE | **done** ✓ | per-video-type loudness + LRA + word-level VTT; LOW efficiency nits (#8/#4a) deferred |
| 9 | ITERATE | pending | |
| X | FSM core / cross-cutting | pending | |

Status legend: pending → designed → implementing → verifying → reviewed → **done**

## Findings backlog

_(populated from the 5 audit agents; each becomes a scoped change with severity + effort)_
_Audit progress: **5/5 reported** (INGEST+INSPECT, RENDER+PACKAGE+ITERATE, COMPOSE+PREVIEW, FSM-core, INTENT+PLAN)._
_Note: ALLOWED_TRANSITIONS vs GATES verified in EXACT 19/19 agreement by the FSM-core agent. Non-overridable blockers + stale-lock TOCTOU guard confirmed correct._

### INGEST + INSPECT (agent 1)
- **[INSPECT][HIGH][small] ASR default `small.en` is English-only** — `asr-backend.js:40`; whisperx forces `language="en"` on `.en` models, defeating auto-detect. Contradicts advertised CJK/bilingual support (fonts ship, transcript is English-locked). → default to multilingual `small`; preflight note when `*.en` set.
- **[INSPECT][MED][small] No VAD filter → hallucinated words over silence/music** — `asr/faster_whisper_transcribe.py:55` (`vad_filter=False` hardcoded). Phantom "Thank you."/"subscribe" words defeat clean-cut's word-density dead-air gate (leaves dead air) + pollute hooks/low-conf. → default `vad_filter=True` behind `VOB_ASR_VAD` knob.
- **[INSPECT][HIGH][med] Scene detect fixed 0.4 threshold, no zero-cut fallback** — `inspect.js:97,617`. Soft-cut/single-shot/long interview → 0 cuts → silence-only multi-minute "segments", no clip granularity for storyboarder. → adaptive retry at lower threshold on 0 cuts + stamp `scene_detection_basis`; fold basis into cache key.
- **[INSPECT][MED][med] Measured loudness signal wasted** — `audio-analysis.js:417-461` + `segment-signals.js:79-109`. (a) PACKAGE `loudnorm.js` re-measures from scratch, ignoring INSPECT LUFS; (b) per-segment `loudness_lufs_approx` has ZERO consumers (built, never wired). → pass measured LUFS into loudnorm to skip a pass; surface per-segment levels to storyboarder or drop.
- **[INSPECT][MED][small] openai-whisper driver drops detected language** — `asr/openai_whisper_transcribe.py:82-88` never reads `result["language"]` → records `null` lang on fallback. → include language in envelope like the other 2 drivers.
- **[INSPECT][MED][med] Hook scoring is English-lexicon only** — `inspect-digest.js:10-16` all-English regexes → `hook_candidates[]` near-useless on non-English; inspector "starts from noise". → weight language-agnostic energy/speech-rate signals when lang≠en; gate English lexicon on language.
- **[INSPECT][LOW][small] Clean-audio-track picker ignores balance/dual-mono** — `audio-analysis.js:469-520`. One-channel lavalier can win despite half-dead mix. → penalize `|balance_db|`, prefer transcribe-winner on ties.
- **[INSPECT][LOW][med] Per-file ASR runs serially** — `inspect.js:1038-1088` sequential loop; everything else uses `mapWithConcurrency`. → host-gated small pool (Whisper is RAM-heavy).
- **[INSPECT][LOW][small] Detection cache basis not surfaced** — bundle with the scene-detect fallback fix (cache key must include effective threshold/basis).
- _Agent's top picks: ASR English-default + scene-detect fallback (both silently degrade all downstream understanding); then VAD + monolingual hooks._

### RENDER + PACKAGE + ITERATE (agent 4)
- **[RENDER][MED][small] Segment confirmation never enforced at assembly** — `render-segments.js:203-230` `validSegmentRenders` gates on existence+revision+scene_ids but NOT `confirmed`; `assemble_video` ships unconfirmed partials → bypasses the overridable:false confirm contract for the segmented path. → require `entry.confirmed===true`; name unconfirmed in assemble error.
- **[RENDER][MED][med] No auto screenshot-path fallback on `<video>`-budget render timeout** — `render-full.js:174-201`. 7-video comp (budget 6/cap 8) passes QC then stalls headless Chrome; 30-min job lost. → on timeout when video count > `videoBudget()`, retry once with `PRODUCER_FORCE_SCREENSHOT=1` (reuse existing escape hatch) before throwing.
- **[RENDER][MED][med] Music duck keys off whole concat program; fade seams not handled; flat-mix fallback invisible** — `assemble.js:86-99,186-215`. → surface `ducked` into manifest+README+result; make duck params tunable; (high-value first step) warn when `ducked:false`.
- **[RENDER][BUG/MED][med] Drift verification uses DECLARED target, not realized speed-baked cut** — `render-full.js:115-134` uses `total_target_duration_seconds`; should use `sceneArollOutputSeconds` sum (speed/layout-baked). False truncation flags / masks real ones. → compute expected from realized seconds; scale threshold `max(0.5s, 0.5%)`. **DUP with COMPOSE#6 (preview drift) — fix both via shared accessor.**
- **[PACKAGE][HIGH][med] Loudnorm hardcoded −14 LUFS for ALL video types** — `ffmpeg-runner.js:177`. Wrong for cinematic(~−16/−18 wider LRA)/podcast(−16); LRA=11+linear flattens dynamics. → add `loudness_target{i,tp,lra}` per preset in `video-types.js`, thread `resolveActiveVideoType` into loudnorm, stamp into manifest. Default −14 → byte-identical short-form. **Biggest PACKAGE lever.**
- **[PACKAGE][BUG/MED][small] Loudnorm "within tolerance" skip ignores LRA + skips TP limiting** — `loudnorm.js:49-52`. Over-compressed (LRA~2) audio skips → ships flat. → also require measured LRA in band before skipping; record `measured_input_lra`.
- **[PACKAGE][MED][med] Word-level karaoke timing discarded at PACKAGE** — `caption-sidecar.js:91-169` word-anchors chunk windows then throws away per-word times; manifest hardcodes `level:"chunk"`. → emit word-level VTT cues when aligned+word-animation planned; stamp `level:"word"`.
- **[PACKAGE][LOW][small] Segmented drift uses wrong total + redundant loudnorm pass** — `package-output.js:537-544,464`. → use plan/assembly total for segmented drift; skip package loudnorm when `assembly.loudnorm.applied` same target.
- **[ITERATE][MED][med] `compare_iterations` blind to output-quality deltas** — `compare-iterations.js:59-90` shows only render wall-clock/size/revisions, ignores archived `package/manifest.json` (output duration, LUFS, dims, chapters, caption count). → read archived manifest, add quality deltas.
- **[ITERATE][LOW][small] Archival leaves `segment_renders/` + stale matte/layout caches** — `archival.js:104-124` moves only renders+package. → also move `segment_renders/` into archive; clear stale registry on segmented re-derive.
- **[ITERATE][LOW][small] `finalize_iteration` bypasses fan-out completeness backstop** — `finalize-iteration.js:24-36` only checks *a* package/external exists, not all shorts; import jumps to PACKAGE skipping the gate. → call shared `missingShortDeliverables(state)`, refuse (overridable).
- **[RENDER/CROSS][MED][med] No black-frame / silent-audio QC on final render** — `verifyRenderedMp4` checks only drift/dims/has_audio; `signalstatsLuma` exists but only wired to COMPOSE stills. Dropped-`<video>` all-black stretch passes (duration correct). → sample frames w/ `signalstatsLuma` + quick volumedetect in `verifyRenderedMp4`; advisory `black_frames`/`silent_audio`. **DUP with PREVIEW#1.**

### COMPOSE + PREVIEW (agent 3)
- **[PREVIEW][HIGH][med] PREVIEW runs ZERO visual QC on the rendered draft** — `render-preview.js:121-178` only `verifyRenderedMp4`. All visual QC runs on COMPOSE-side snapshot, not the preview the human confirms. → ffprobe-extract N frames of `preview.render_path` + `signalstatsLuma`/`classifyStillLuma`, fold advisory findings w/ timecodes (no 2nd browser render). **DUP w/ RENDER black-frame.**
- **[COMPOSE][HIGH][med] `vob_qc_stills` is luma-only — no safe-band / edge-clip, yet QC-A is the #1 auto-fix item** — `still-qc.js:40-68`. Profiles carry `safe_top_px`/`safe_bottom_px`. → run `hyperframes inspect` on snapshot timecodes OR bounding-box safe-band check; fold findings w/ timecode. **Highest COMPOSE lever.**
- **[COMPOSE][MED][small] `hyperframes inspect` overflow gated OFF unless object-form caption/overlay planned** — `layout-qc.js:54-62`. Composer-authored captions (strings/free) get zero overflow QC. → also trigger on caption-class/text elements in markup (reuse `composition-qc.js:751-761` signal).
- **[COMPOSE][MED][med] Degraded layout falls back to N raw `<video>` cells silently blowing budget** — `layout-materialize.js:155-224`+`composition-qc.js:333-352`. → emit `vob/layout_degraded_fallback` warning naming scene + extra `<video>` cost; surface materialize error/reason to QC.
- **[COMPOSE][MED][small] Master-duration QC one-sided (too-short only)** — `composition-qc.js:401-420`. Too-long `data-duration` adds dead/black tail, no save-time signal. → add `vob/master_duration_long` warning.
- **[PREVIEW][MED][med] Preview drift uses declared target not realized cut** — `render-preview.js:72-86`. **DUP with RENDER#4** — fix via shared realized-seconds accessor.
- **[COMPOSE][LOW][small] Snapshot/qc-stills timecode attribution fragile (positional length match)** — `snapshot-keyframes.js:28-55`+`qc-stills.js:51-54`. count mismatch → all `timecode_seconds:null` → unactionable re-spawn. → return timecode→filename map from snapshot; qc reads it. Also sample entrance frame (start+0.1s).
- **[COMPOSE][MED][small] lint-path `runInspect` uses generic `--samples 6`, misses caption windows** — `lint-composition.js:435`. → pass explicit caption/overlay-window timecodes when in scope.
- **[PREVIEW][LOW][small] `confirm_preview` doesn't revision-cross-check** — `confirm-preview.js:16-48` trusts the save-reset side-effect. → compare `preview.composition_revision_rendered` vs `composition.revision_count`, refuse if stale (mirror lint path).
- **[COMPOSE][LOW][small] Font conformance passes if ANY one declared family used** — `composition-qc.js:826-865`. Type-system collapse to one face reads as adherent. → add info-level `vob/design_font_partial` when only 1 of ≥2 role-families used.
- **[COMPOSE][LOW][med] `wipeComposeDir` before validated writes → mid-save throw destroys prior comp** — `save-composition.js:159-272`. → temp-dir + atomic swap, OR collect symlink/inject throws into warnings (like EPERM already).
- **[COMPOSE][LOW][med] Caption sidecar word-anchors only clip[0] of multi-clip scenes** — `caption-sidecar.js:125-150`. Later-clip captions silently fall back to approx timing. → map each caption to its containing source clip (geometric, like `PLAN_CAPTION_TIMING_DRIFT`).

### FSM core / cross-cutting (agent 5)
- **[CORE][HIGH][med] Preview/render singleton slots carry no short_id/segment_id → can confirm/ship WRONG short** — `session-state.js:508-536`, `phase-gates.js:358-410`, `confirm-render.js:34-52`. On resume mid-fan-out, `preview.confirmed:true` may belong to short A while `composition.short_id`=B. → stamp short_id/segment_id on preview+render slots, surface in summaries, guard `previewToRender`/`render_full` when `preview.short_id !== composition.short_id` (overridable:false). **Top core item.**
- **[CORE][MED][small] No process-level lock release → killed long render strands session 5 min** — `storage.js:240-288`, `server.js` has no SIGTERM/SIGINT/exit handler. COMPOSE materialization holds lock across minutes of ffmpeg/remove-bg. → module-level Set of held tokens; release on SIGINT/SIGTERM/exit (same token guard). **Top core item.**
- **[CORE][MED][med] COMPOSE→PREVIEW gate trusts stale `lint_status:"clean"`** — `phase-gates.js:299-339` checks files-exist but trusts state lint verdict; manual `compose/` edit → stale clean never re-checked. → store lint fingerprint/revision, block `lint_stale` (overridable) when mismatch.
- **[CORE][MED][small] `intentToPlan` reads inspect summary from STATE path not canonical** — `phase-gates.js:166-197` (vs `inspectToIntent` which uses canonical). Stale slot → conditional intent keys (audio_treatment/captions_style) silently dropped, gate passes. → read `inspectSummaryPath(project_id)` w/ same corrupt-handling.
- **[CORE][MED][med] Lean-return contract applied unevenly** — `transition_phase` returns full `buildStateSummary`; confirm/render/save return only their slot → orchestrator over-reads or works stale. → add uniform `summary_delta` (touched slots) to every mutating return.
- **[CORE][MED][med] COMPOSE clip-materialize failures invisible in transition return** — `session-state.js:710-746`. `materializeSceneClips` failure lowers count silently (no failed/error field); composer gets torn symlink tree, only learns at save_composition. → add failed/error_count+scene_ids to clip digest + `materialization_warnings` in `transition_phase` return.
- **[CORE][LOW][med] `archiveForIteration` no-op when only compose/ changed** — `archival.js:106-108`. Back-edge before any render → no version bump, brief/storyboard/compose overwritten unarchived. → archive on any back-edge with confirmed comp/storyboard even w/o renders.
- **[CORE][LOW][small] Validator: present-but-null required key → misleading "is required"; oneOf concatenates branch errors** — `tool-validation.js:113-117,82-104`. Hurts subagent self-correction. → split null vs missing; surface furthest-match branch in oneOf.
- **[CORE][LOW][small] `dependencyFailuresDigest` hides never-run (unknown) preflights** — `session-state.js:231-237`; ffmpeg gate `phase-gates.js:535` only blocks on explicit `ok===false`, passes on undefined. → distinguish ok/failed/unknown; block (overridable) on unknown ffmpeg.
- **[CORE][LOW][med] Transport slices by CHARS not BYTES → multibyte (CJK) tool-call body mis-framed** — `transport.js:97,102-167`. `buffer.slice(bodyStart, +contentLength)` char-based vs byte Content-Length. → buffer on Buffers, slice by byte offset, decode after.
- **[CORE][LOW][small] `summarizeAssembly` doesn't say stale-vs-never for resume** — `session-state.js:493-506`. → add `assembly_status` enum none|current|stale(+reason) matching gate logic.
- **[CORE][LOW][small] `assertSafeProjectId` allows leading-dot/dotfile ids** — `paths.js:7-16`. Conversational basename `.intro.mp4`→hidden session dir. → reject/normalize leading-dot ids.

### INTENT + PLAN (agent 2)
- **[PLAN][HIGH][med] NO plan-lint reads `intent.answers` — v3.7 creative knobs have zero teeth** — `storyboard-schema.js:2414-2488` lint never reads the v3.7 keys. User asks "fast/split-screen/whip-pan/karaoke" → can get slow/single-cell/all-cut/no-anim & plan gate shows nothing. → add WARNINGS `PLAN_PACING_INTENT_IGNORED` / `PLAN_LAYOUT_INTENT_UNMET` / `PLAN_TRANSITION_INTENT_UNMET` / `PLAN_CAPTION_ANIMATION_INTENT_UNMET` reading `ctx.state.intent.answers`, fail-safe permissive. **Biggest INTENT→PLAN lever.**
- **[PLAN][HIGH][small] `caption_segments[]` has no captions-on-silent check** — `storyboard-schema.js:1849-1928`; only legacy `scene.captions` STRING is checked (`:1423-1446`). Captions burned over silence reach COMPOSE. → `PLAN_CAPTION_SEGMENTS_ON_SILENT` warning via `clipHasSpokenWords`, only when transcript exists.
- **[PLAN][HIGH][small] `PLAN_KEY_MOMENT_UNCOVERED` only matches exact `N–Ns` range form** — `storyboard-schema.js:1677-1685`. Single points (`42s`), `mm:ss`, `"27.9 to 42.1 seconds"` all silently no-op → missing requested moment ships silently. → broaden parser w/ `parseSingleDuration`; single point = containment ±tol; permissive.
- **[PLAN][MED][small] No PLAN cross-check of `target.{platform,duration,fps}` vs INTENT** — `storyboard-schema.js:1154-1181` shape-only; platform/duration drift caught NEVER at PLAN, fps only at COMPOSE. → `PLAN_TARGET_PLATFORM_DRIFT` + `PLAN_TARGET_FPS_DRIFT` (promote fps check to PLAN); fail-safe when no canonical.
- **[PLAN][MED][small] Overlay safe-area lint only bottom band; top overlays + `caption_segments.position` unflagged** — `storyboard-schema.js:1772-1787`; profiles carry `safe_top_px` (unused at PLAN). → generalize to top anchors + caption positions, reuse `platformProfileFromState`.
- **[PLAN][MED][small] No floor lints — micro/empty/zero-video scenes pass silently** — `storyboard-schema.js:477,483,1330`. b_roll has 1.5s floor but a_roll/scene don't. → `PLAN_SCENE_TOO_SHORT` (~0.7s via `sceneOutputSeconds`), `PLAN_SCENE_EMPTY` (no footage+no overlays).
- **[PLAN][LOW][med] Hook lint binary; no buried/no-speech opener check** — `storyboard-schema.js:1497-1520`. → `PLAN_HOOK_NO_SPEECH` under `retention` only (ruleset-gated), via `clipHasSpokenWords`.
- **[PLAN][LOW][small] `brief-validator` audio grounding brittle** — `brief-validator.js:37-44` regex lexicon + `inspect.audio_present`-only (silent off-switch on legacy session). → surface manifest per-file audio count as 2nd source.
- **[PLAN][LOW][med] `confirm_brief`/`confirm_storyboard` can confirm stale-vs-INTENT artifact** — no `intent.last_updated` vs `saved_at` compare. → overridable `plan_stale_vs_intent` gate blocker.

## Cross-cutting THEMES (dedup across agents)
1. **Drift = declared target, not realized speed-baked cut** (RENDER#4 + PREVIEW#6) → ONE shared `sceneArollOutputSeconds`-based expected-duration helper, used by render-preview + render-full. BUG.
2. **No black-frame / silent-audio QC on rendered output** (RENDER#12 + PREVIEW#1) → ONE shared frame-sample `signalstatsLuma` + volumedetect helper, folded into `verifyRenderedMp4` + preview. Advisory.
3. **Safe-band QC missing** (COMPOSE#2 stills + PLAN#6 plan positions) → profiles carry `safe_top/bottom_px`; enforce at PLAN (positions) AND COMPOSE (rendered bbox via hyperframes inspect).
4. **Multilingual/CJK undermined at transcript level** (INSPECT#1 English-only ASR, #5 lang dropped, #7 monolingual hooks, CORE#10 byte-framing) → advertised CJK support is real in fonts, broken in ASR. Coherent theme.
5. **Fan-out/segmented robustness** (CORE#1 short_id on slots, RENDER#1 segment confirm, CORE#2 lock release).
6. **Per-format audio quality** (PACKAGE#5 loudnorm per video-type) — biggest single PACKAGE lever.

## Decisions log

_(record non-obvious choices here as they're made)_

## Change log (what actually shipped in v3.8)

### Stage 1 — INSPECT (commit) ✓
- ASR default model `small.en` → **`small` (multilingual)** in `asr-backend.js` + all 3 Python driver defaults; unlocks advertised CJK/bilingual transcript. (INSPECT#1)
- `checkAsrAvailable` now returns `model`/`language`/`model_advisory` — flags an `*.en` model in INGEST preflight + doctor. (INSPECT#1)
- faster-whisper VAD filter default **ON** behind `VOB_ASR_VAD` (auto|on|off); kills hallucinated words over silence/music. (INSPECT#2)
- Scene-detect **zero-cut adaptive retry** (0.4→0.2) on files ≥45s; `scene_detection_basis` stamped into file summary + cache (cache key bumped via `retrySceneThreshold` in DETECT_PARAMS); digest surfaces "single-shot/soft → silence-only segmentation". (INSPECT#3,#6)
- openai-whisper driver now reports detected `language` in envelope (was dropped). (INSPECT#5)
- Hook scoring (`rankHookCandidates`) **crosslingual**: gates English-lexicon signals + boosts language-agnostic energy/position/digit/question-punct (incl. CJK ？！。) when detected lang≠en; detected language threaded INSPECT→cache→hooks. English path byte-identical. (INSPECT#7)
- Clean-audio-track picker penalizes one-sided `|balance_db|` beyond center band. (INSPECT#8)
- _Verified: py_compile, module load, boot clean, targeted EN/ZH hook test, advisory test, balance test._
- _Deferred to PACKAGE: reuse INSPECT-measured LUFS in loudnorm (INSPECT#4a). Deferred (low): per-segment level surfacing (INSPECT#4b), ASR concurrency (INSPECT#9)._

### Stage 2/3 — INTENT→PLAN (P1, commit) ✓
- **Intent-enforcement teeth** (`warnIntentUnmet`, reads `intent.answers`, all WARNINGS, permissive+fail-safe, document-global w/ fan-out suppression): `PLAN_PACING_INTENT_IGNORED` / `PLAN_LAYOUT_INTENT_UNMET` / `PLAN_TRANSITION_INTENT_UNMET` / `PLAN_CAPTION_ANIMATION_INTENT_UNMET`. First enforcement of the v3.7 creative keys. (INTENT#1)
- `PLAN_CAPTION_SEGMENTS_ON_SILENT` (`warnCaptionSegmentsOnSilent`) — captions-on-silent for the first-class caption_segments layer (legacy string already errored); skips legacy-covered scenes; fail-safe when no transcript. (INTENT#2)
- **Broadened key-moment parser** (`parseKeyMoments`): single points (`42s`, `1:05`), `mm:ss` ranges, "X to Y seconds" — was exact-`N–Ns`-only (silently skipped most phrasings). `parseSingleDuration` now exported from platform-profiles. (INTENT#3)
- _Verified: 5-case targeted test (all teeth + single-point + mm:ss + no-intent regression + "no transitions" negative guard), classic `N–Ns` range regression, server boot, `spans` walker (existing lint negative paths intact)._
### Stage 2/3 — INTENT→PLAN (P2+P3, commit) ✓
- `PLAN_TARGET_PLATFORM_DRIFT` + `PLAN_TARGET_FPS_DRIFT` (`warnTargetVsIntent`, document-global, fail-safe; only warns on a RECOGNIZED canonical mismatch / fps delta). (INTENT#4)
- Safe-area generalized to the **top** band + extended to `caption_segments[].position` — shared `safeBandIntrusion` helper; new `PLAN_CAPTION_SAFE_AREA`; profiles' `safe_top_px` now consulted at PLAN. (INTENT#6, XC-3 plan-side)
- Floor lints `PLAN_SCENE_EMPTY` (no footage+overlays+layout) / `PLAN_SCENE_TOO_SHORT` (<0.7s realized via `sceneOutputSeconds`). (INTENT#7)
- `PLAN_HOOK_NO_SPEECH` (retention-gated, in non-retention `disabled_rules`) — hook scene opening on silent footage. (INTENT#8)
- _Verified: targeted tests (drift+match-no-drift, floors, top safe-area overlay+caption, hook-no-speech retention-on/general-off), boot, spans walker._
- _Deferred (low): brief-validator manifest audio count (INTENT#5); stale-vs-intent gate `plan_stale_vs_intent` (INTENT#9 — touches phase-gates, will fold into CORE stage)._

### Stage 4 — COMPOSE (commit) ✓
- `vob/master_duration_long` — symmetric to `master_duration_short`; WARNING (1.0s tol) when `data-duration` exceeds scene total (frozen/black tail). (COMPOSE#5)
- `vob/design_font_partial` — INFO when a multi-role type system collapses to ONE face (templated "slop"); `design_font_mismatch` stays the 0-match warning. (COMPOSE#10)
- Layout-QC trigger broadened: `compositionHasTextMarkup` fires inspect on caption-class / `data-vob-*-id` MARKUP, not only object-form plan captions — overflow QC now runs on composer-authored captions. (COMPOSE#3)
- Inspect AIMED: `captionOverlayTimecodes` samples the caption/overlay output windows (per-scene cursor math, exact for scene-relative overlays) instead of 6 generic samples. (COMPOSE#8)
- `vob/layout_degraded_fallback` WARNING — a layout that didn't composite (skipped/failed) names the scene + extra `<video>` cost (scoped to active short/segment). (COMPOSE#4)
- _Verified: layout-qc helper unit tests, runCompositionQc master-long + design-partial (+ no-false-positive when matched/both-used), module load, boot, spans walker._
- _Note: rendered-text **safe-band** intrusion (COMPOSE#2) is NOT engine-detectable — `hyperframes inspect` gives overflow only (no bbox/safe-area), stills are luma-only (band always has video pixels). Safe-band lever lives at PLAN (planned positions, done Stage 2/3) + COMPOSE edge-overflow (broadened above)._
- _Deferred (low): caption-sidecar multi-clip anchoring (COMPOSE#12 → fold into PACKAGE sidecar work); wipeComposeDir atomicity (COMPOSE#11); snapshot timecode→filename map (COMPOSE#7)._

### Stage 5/6 — PREVIEW + RENDER shared verification (commit) ✓
- **XC-1 realized-cut drift**: `realizedScopeDurationSeconds(scenes)` (sum of `sceneOutputSeconds`, speed/layout-baked) replaces the DECLARED `total_target_duration_seconds` as the drift expectation in render-preview + render-full (per active scope: segment/short/doc; declared fallback when scenes don't resolve). Fixes false silent-truncation flags / masked real ones. (RENDER#4 = PREVIEW#6)
- **XC-2 content QC**: `verifyRenderedMp4({checkContent:true})` now samples peak luma across the output (`signalstatsLuma` w/ new `seekSeconds`) → `black_frame_count`/`all_black`, and measures `max_volume_db` (new `measureMaxVolumeDb`, audio-only volumedetect) → `silent_audio`. Advisory, never gates. Catches the dropped-`<video>` all-black / failed-audio-mux class that duration drift can't. Wired into preview + full render. (RENDER#12 = PREVIEW#1)
- _Verified on REAL generated videos: black+silent → all_black/silent flagged; normal → clean; realized 7 ≠ declared 14; module load; boot. Existing still-QC path untouched (seek only added on a video seek)._
- _Deferred: PREVIEW confirm-revision cross-check (PREVIEW#9, P3) → fold into CORE stage._

### Stage 7 — RENDER P2 (commit) ✓
- **Segment-confirm at assembly** (RENDER#1): `validSegmentRenders` now requires `entry.confirmed===true` → an unconfirmed partial counts as missing (new `unconfirmed[]`); `assemble_video` + the RENDER→PACKAGE gate name unconfirmed segments. Closes the segmented-path bypass of the overridable:false confirm contract.
- **Music duck surfaced** (RENDER#3): `ducked` was computed but invisible — `assemble_video` now emits a `warnings[]` on flat-mix fallback (+ silent-audio), and the PACKAGE manifest/README spell out the bed + `ducked` status (basename, gain).
- **Screenshot-path timeout fallback** (RENDER#2): on a render timeout when `<video>` count > `hostProfile.videoBudget()`, retry ONCE with `PRODUCER_FORCE_SCREENSHOT=1` (race-free `forceScreenshot` threaded `runHyperframesWithRetry`→`runHyperframesBlocking`→`hyperframesChildEnv`; no process.env mutation) before throwing. degrade-don't-die for the low-RAM many-video BeginFrame wall.
- _Verified: validSegmentRenders unit test (unconfirmed→missing, confirm→ready), forceScreenshot env (set/unset), module load, boot, spans walker. Music duck/timeout paths logic-reviewed (need a live render to exercise)._

### Stage 8 — PACKAGE loudnorm (commit) ✓
- **Per-video-type loudness target** (PACKAGE#5 — biggest packaging-audio lever): each preset in `video-types.js` carries `loudness_target{i,tp,lra}` (social/long-form/tutorial/general −14; cinematic −16/wide LRA 16; podcast −16). `resolveLoudnessTarget(state)` resolves it; `loudnorm.js` + the ffmpeg argv builders (`buildLoudnorm{Measure,Apply}Argv`) take a `target` (default −14 → short-form byte-identical). Threaded into PACKAGE + assembly; stamped into `manifest.audio.loudnorm_target`.
- **LRA recorded** (PACKAGE#6): `measured_input_lra` now surfaced in result + manifest. (Deliberately do NOT force-apply on a low-LRA input — our `linear=true` pass can't restore destroyed dynamics; recording it for the reviewer is the correct fix.)
- _Verified on REAL audio: cinematic target (−16/−1.5/16) applied to a −21.8 LUFS clip, target stamped, LRA recorded; resolveLoudnessTarget per type (social/cinematic/podcast); argv honors target; module load; boot._
### Stage 8 — PACKAGE word-level VTT (commit) ✓
- **Word-level VTT** (PACKAGE#7): when a karaoke/word-by-word animation is planned on a forced-aligned transcript, `caption-sidecar.js` emits per-word `<HH:MM:SS.mmm>word` VTT tags (`wordTaggedCue`) and returns `level:"word"` (SRT stays chunk-level — inline tags aren't portable there). Both PACKAGE (manifest `captions.level` was hardcoded "chunk") and the fan-out import path surface it. Falls back to chunk when unaligned / non-word animation. The engine already paid for alignment; now the sidecar spends it.
- _Verified: karaoke+aligned→word tags+level:word, pop→chunk, unaligned→chunk, SRT plain; module load; boot._
- _Deferred (LOW/efficiency, output-quality-first): segmented drift total + skip redundant package loudnorm (PACKAGE#8); reuse INSPECT LUFS to skip a measure pass (INSPECT#4a)._

## Loop bookkeeping

- ✅ All 5 audits collected; PRD + findings ledger written + committed (57a22e7).
- ✅ Stage 1 INSPECT committed (06d879b). ✅ Stage 2/3 PLAN P1 committed (bd47d88).
- ✅ Done & committed: planning (57a22e7), INSPECT (06d879b), PLAN (bd47d88, 7577c51), COMPOSE (b01e2d8), PREVIEW+RENDER shared (6c18084), RENDER P2 (15ea6b6), PACKAGE loudnorm (47e2df4).
- **NEXT ACTION ON WAKE:** finish **PACKAGE P2/P3**, then **ITERATE**, then **CORE** (the high-value robustness stage).
  - **PACKAGE#7 word-level VTT** (`caption-sidecar.js` + `package-output.js`): when `transcript_aligned` + a word-level animation is planned, emit word-level VTT cues + stamp `level:"word"` (currently chunk-only — engine pays for alignment but the sidecar discards per-word times). MED.
  - **PACKAGE#8** (LOW): segmented drift uses plan/assembly total; skip the package loudnorm measure when `state.assembly.loudnorm.applied` to same target. **INSPECT#4a** (LOW): reuse INSPECT-measured LUFS to skip a measure pass.
  - **ITERATE**: `compare-iterations.js` read archived `package/manifest.json` → output-duration/LUFS/dims/chapter/caption deltas (`loadArchivedSide`); `archival.js` also move `segment_renders/`; `finalize-iteration.js` call `missingShortDeliverables`.
  - **CORE (high-value)**: (1) stamp `short_id`/`segment_id` on preview+render slots + guard `previewToRender`/`render_full` vs wrong-short (CORE#1, HIGH); (2) process-level lock release on SIGINT/SIGTERM/exit (CORE#2, `storage.js`/`server.js`); (3) `intentToPlan` reads CANONICAL inspect path (CORE#4); plus deferred: stale-vs-intent gate (INTENT#9), PREVIEW#9 confirm-revision, brief-validator audio (INTENT#5), dependency unknown-state (CORE#9), validator null/oneOf msgs (CORE#8).
- Verification without a source: `node -e` targeted tests, `node scripts/m5-walker.js spans`, boot, real ffmpeg clips for probe/loudnorm. After CORE, do a final VERSION bump + CHANGELOG + CLAUDE.md invariant updates + an adversarial review pass.
