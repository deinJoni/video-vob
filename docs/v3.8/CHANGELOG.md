# v3.8 — FSM Stage-by-Stage Quality & Robustness Pass

A pass over **every FSM stage** to close signal-loss between stages, give the
v3.7 creative-intent knobs enforcement teeth, make the rendered *pixels and
audio* actually get QC'd, and harden the fan-out / segmented / resume paths.
No new FSM edges, no new required intent keys, output-quality first,
degrade-don't-die preserved. (3.7.0 → 3.8.0)

## INSPECT (+ INGEST preflight)
- **Multilingual ASR by default** — `VOB_ASR_MODEL` default `small.en` → `small`; all three Whisper drivers + `asr-backend` default. Unlocks the advertised CJK/bilingual transcript (was English-locked). `checkAsrAvailable` surfaces the resolved model + an `*.en` advisory.
- **VAD filter ON** in the faster-whisper driver (`VOB_ASR_VAD` knob) — suppresses hallucinated words over silence/music that defeated clean-cut's dead-air gate.
- **Adaptive scene-detect fallback** — a long video-bearing file that yields 0 cuts at 0.4 retries at 0.2; `scene_detection_basis` is stamped into the file summary + content-hash cache (key bumped) and the digest flags silence-only/single-shot granularity to the storyboarder.
- **Crosslingual hook scoring** — English-lexicon hook signals gate on the detected language; language-agnostic energy/position/digit/question-punct (incl. CJK ？！。) are boosted when lang≠en. English path byte-identical. Detected language threaded INSPECT→cache→hooks.
- openai-whisper driver now reports detected language (was dropped); clean-audio-track picker penalizes one-sided `|balance_db|`.

## INTENT → PLAN (plan-lint)
- **Intent-enforcement teeth** — `PLAN_PACING_INTENT_IGNORED` / `PLAN_LAYOUT_INTENT_UNMET` / `PLAN_TRANSITION_INTENT_UNMET` / `PLAN_CAPTION_ANIMATION_INTENT_UNMET` (all WARNINGS, permissive, fail-safe, document-global). First enforcement of the v3.7 creative keys.
- `PLAN_CAPTION_SEGMENTS_ON_SILENT` (captions-on-silent for the first-class caption_segments layer); broadened `PLAN_KEY_MOMENT_UNCOVERED` parser (single points, `mm:ss`, "X to Y seconds" — was exact-range-only).
- `PLAN_TARGET_PLATFORM_DRIFT` / `PLAN_TARGET_FPS_DRIFT`; safe-area generalized to the top band + `caption_segments[].position` (`PLAN_CAPTION_SAFE_AREA`); floor lints `PLAN_SCENE_TOO_SHORT` / `PLAN_SCENE_EMPTY`; `PLAN_HOOK_NO_SPEECH` (retention-gated).

## COMPOSE
- `vob/master_duration_long` (symmetric to the short check — frozen/black tail); `vob/design_font_partial` (type system collapsed to one face).
- Layout-overflow QC broadened to fire on caption-class **markup** (not only object-form plan captions) and **aimed** at caption/overlay output windows instead of generic samples; `vob/layout_degraded_fallback` names a layout that didn't composite + its extra `<video>` cost.
- _Note: rendered-text safe-band intrusion is not engine-detectable (hyperframes inspect = overflow only, stills = luma only); that lever lives at PLAN._

## PREVIEW + RENDER
- **Realized-cut drift** — drift verification expects the realized speed/layout-baked cut (`realizedScopeDurationSeconds`), not the declared target (which legitimately differs). Fixes false silent-truncation flags / un-masks real ones.
- **Content QC** — `verifyRenderedMp4({checkContent:true})` samples luma across the output (black-frame / all-black) + measures max volume (silent-audio); advisory, never gates. Catches the dropped-`<video>` / failed-audio-mux class duration can't see.
- Segment-confirm enforced at assembly (`validSegmentRenders` requires `confirmed`); music-duck status surfaced (flat-mix warning + manifest/README); screenshot-path fallback on a `<video>`-budget render timeout.

## PACKAGE
- **Per-video-type loudness** — each preset carries `loudness_target{i,tp,lra}` (cinematic −16/wide-LRA, podcast −16, social/long-form −14); threaded through loudnorm + ffmpeg argv; stamped into the manifest. `measured_input_lra` recorded.
- **Word-level VTT** — karaoke/word-by-word on an aligned transcript emits per-word `<HH:MM:SS.mmm>word` tags (`level:"word"`); SRT stays chunk-level. PACKAGE + fan-out import paths.

## ITERATE
- `compare_iterations` reads the archived package manifest → output-quality deltas (duration, loudness, dimensions, chapters, captions) — a "did it get better?" diff.
- Archival sweeps `segment_renders/`; `finalize_iteration` honors the fan-out completeness backstop (`missingShortDeliverables`).

## FSM CORE / cross-cutting
- **Cross-short/segment guard** — preview+render slots stamp `short_id`/`segment_id`; the PREVIEW→RENDER gate and `render_full` refuse (overridable:false) when the confirmed preview's scope ≠ the active composition's — stops shipping the wrong short unverified on resume mid-fan-out.
- **Process-level lock release** — exit/SIGINT/SIGTERM release the locks we own (token-precise) — a killed long render no longer strands the session for the 5-min stale timeout.
- `intentToPlan` reads the canonical inspect path; `confirm_preview` revision cross-check; `assertSafeProjectId` rejects leading-dot ids; `plan_stale_vs_intent` overridable gate when intent changed after the plan was saved.

## Verification
Each slice verified with targeted `node -e` tests, real ffmpeg-generated clips (black/normal/cinematic-loudnorm), the source-free `spans` walker, and a clean server boot. Two adversarial subagent reviews over the full diff. No test suite / CI in this repo by design.

## Deferred (low-value / efficiency / risk)
PACKAGE#8 (segmented drift total + redundant-loudnorm skip), INSPECT#4a (reuse measured LUFS), per-file ASR concurrency, dependency unknown-state gate, validator null/oneOf messages, transport byte-framing for CJK (load-bearing — high risk), `summary_delta` on mutating returns, brief-validator manifest audio.
