# video-vob v2 — Design Brief (locked scope)

This is the binding scope for the v2 rework on branch `v2/fable-rework`. Designers turn each work
package below into a precise per-file spec; implementers build from the specs. The full subsystem
analysis (9 readers + critique) lives at:
`/private/tmp/claude-501/-Users-jonas-Documents-mushanghai-video-vob/75397cf3-c317-4cd1-9c94-4dfca9e40975/tasks/wdx2lfi1x.output`
(JSON: `result.readers[]` keyed by `area`, plus `result.critique`). Read the areas relevant to your
package before speccing.

## Goals (in priority order)

1. **One-shot output quality.** The pipeline should produce a polished short-form video on the
   first pass: strong hook, tight pacing, real typography, captions that look professional,
   platform-correct framing — and catch its own visual mistakes *before* the human sees a draft.
2. **Token efficiency.** Cut the per-run context bill substantially (target: >50% reduction)
   without weakening any quality lever. The big four: full-res grounding images, full-state echoes,
   prompt duplication, fat tool descriptions.
3. **Architecture/contract hygiene** where it serves 1–2: defect fixes, single-sourcing, drift guards.

## Hard constraints (violate = rejected)

- FSM phases and edges stay EXACTLY as in `ALLOWED_TRANSITIONS` (session-state.js:16-26). No new
  phases, no new edges, no removed edges.
- State persistence layout stays: `~/video-vob-sessions/<project_id>/`, `state.json` authoritative,
  artifacts derived, atomic writes under the session lock. **On-disk state.json format stays
  back-compatible** (existing sessions must keep working; read-time defaults for new fields).
- Entry points stay: `/vob` positional + conversational parsing, `--like` inheritance,
  `vob_import_deliverable` escape hatch, resume behavior.
- Two-layer architecture: engine enforces structure, adapter owns wording/UX. The five intent keys
  keep their names. Confirm-then-transition semantics stay (saves reset confirms — and v2 makes
  that TRUE where it was only claimed).
- `mcp/` stays zero-npm-dependency, CommonJS, Node stdlib only.
- **ZERO new MCP tools** (no allow-list churn in either adapter). New capability rides inside
  existing tools' behavior/returns.
- No Docker anywhere. Latest hyperframes always (no pinning). 8GB M1 is the reference host:
  ≤6 concurrent `<video>` elements, software GPU, long blocking renders, `--workers 1`.
- Subagent containment stays: storyboarder/composer/inspector keep exactly their current tool
  lists and single-write contracts; orchestrator owns lint/render/confirm/transition.

## Established facts you must treat as true (verified by the critique pass)

- Every gate today is overridable server-side with any non-empty string (session-state.js:178) —
  including acknowledge-inspect. CLAUDE.md's "can never be overridden" is aspirational. v2 fixes this.
- `save_composition` does NOT reset `preview.confirmed`; SKILL.md:340 claims it does. Stale-preview
  hole is real. v2 fixes this with both a reset and revision binding.
- `clean_speech.json` (`keep_spans`) is computed at INSPECT and consumed by NOTHING. v2 wires it.
- All grounding images (thumbs at inspect.js:112, keyframes at segment-signals.js:99-101) are
  extracted at FULL source resolution; three agents Read them as singles (~60–90k image tokens/run).
- The composer never receives `captions_style`/`audio_treatment`/`music_vo` (storyboarder does).
- `manifest.json` is ~90% raw ffprobe `probe` blobs (16.7KB of 18.5KB real-session) that no
  consumer reads.
- `transitionPhase` returns the full state doc + `transcoded_clips` twice; `read_state` returns the
  full doc incl. unbounded history (45% of bytes on a real finished session).
- envelope.js error classification carries vestigial BOB2 patterns (scope_decision/auth_profile/
  wave; `SCOPE_BLOCKED`/`AUTH_MISSING` codes) — confirmed copied from another project.
- `.vob-config/render-profiles.example.json` is inert: package-output.js:27 reads
  `render-profiles.json` which install.sh never ships; only `thumbnail_timestamp_percent` has a
  reader anywhere.
- `intentToPlan` silently swallows corrupt inspect.json → conditional keys (audio_treatment,
  captions_style) silently stop being required.
- m5-walker predates scene-clip pre-cut conventions; it bypasses validation + envelope.
- OpenCode orchestrator tool surface is a DENY-list (new write tools would leak); tool names there
  are `vob_vob_*`.
- Stale docs: SKILL.md:45/120/328 + README.md still say `npx hyperframes` / `hyperframes
  transcribe`; CLAUDE.md says Node ≥20 but package.json says ≥22; `.vob/VERSION`=1.0.0 vs
  `.vob/install.json` vob_version=0.1.0.

## Locked decisions

### D1 — Lean tool returns (token)
- `vob_transition_phase` returns `{project_id, from, to, override_reason, archived:{version,paths}|null,
  clips:{clip_count,cached_count,clips_dir,audio_treatment}|null, phase_summary}` — NO full state echo,
  no duplicated transcoded_clips. `phase_summary` = the enriched summary (below).
- `vob_read_state` drops `history`, `transcoded_clips.clips[]` detail, and raw `dependencies` blobs
  by default; opt-in via `include:["history","clips","dependencies"]`. On-disk format unchanged.
- `vob_read_state_summary` becomes the orchestrator's workhorse: per-slot digest (~600–900B):
  phase, iteration version, style.derived_from, and for each slot {key paths, confirmed/lint/render
  flags, counts}. Spec the exact field list against every SKILL.md read site.
- `vob_record_intent_answer` returns `{recorded, missing_required_keys}` only.
- `vob_ingest_file` returns file summaries + dependency FAILURES only (no full preflight echo).
- `vob_save_storyboard` accepts `content` as object OR string.
- Lint/save results: ≤10 findings inline + counts + report path.

### D2 — Defect fixes (correctness)
- `save_composition` resets `preview.confirmed:false` and `render.confirmed:false`. ADDITIONALLY:
  stamp `composition.revision_count` into preview/render slots at render time
  (`composition_revision_rendered`); `previewToRender`/`renderToPackage` block on mismatch
  (absent stamp = legacy pass).
- Per-blocker `overridable:false` for `inspect_not_acknowledged`, `preview_not_confirmed`,
  `render_not_confirmed`; `transitionPhase` refuses `override_reason` for those. All other
  blockers stay overridable (the sanctioned ffmpeg-installed-since-INGEST override survives).
- `intentToPlan` surfaces corrupt inspect.json as a blocker instead of silently dropping
  conditional keys.
- Purge vestigial error classification: `classifyException` → ToolError-code-or-INTERNAL_ERROR;
  delete SCOPE_BLOCKED/AUTH_MISSING and BOB2 regex patterns (verify zero references first).
- `withSessionLock` becomes async-aware (awaits promise-returning callbacks); transitionPhase uses it.
- Runners: exclude `net::ERR_FILE_NOT_FOUND`-class deterministic failures from retry; stderr
  capture keeps head AND tail (ring buffer) so late crashes classify correctly and error previews
  show the terminal error.
- Fix archive-for-iteration role_bundles/comment contradiction; fix source-symlink.js stale gate
  comment (the real check lands in D6 composition QC).
- Dead-code cleanup is opportunistic and LAST priority (storage helpers, TOOL_MANIFEST, transport
  dead catch) — only where touched anyway.

### D3 — Platform profiles + intent canonicalization (quality)
- New `mcp/lib/platform-profiles.js`: canonical platforms (tiktok, reels, shorts, youtube,
  landscape, square + alias map) → {width, height, aspect, fps, safe_top_px, safe_bottom_px,
  ideal_duration_s, max_duration_s, caption_defaults}. Engine-owned defaults; optional user
  override file `.vob-config/render-profiles.json` absorbed into this module (keep the existing
  read path working; ship a real default file or built-in table — designer decides; the example
  file's dead width/height/fps fields get real consumers or the file gets deleted).
- `record_intent_answer` canonicalizes at record time: `target_platform` → store
  `{raw, canonical, profile}` ; `target_duration` → `{raw, seconds}`. Unrecognized platform →
  keep raw, default profile vertical, no error. Downstream (storyboard target block, composer
  dims, package) reads the canonical values; storyboarder no longer parses free text.

### D4 — Plan lint: storyboard save-time quality validation (quality)
`vob_save_storyboard` gains a content-validation v2 pass returning `{errors[], warnings[]}` in the
save result (errors reject the save, same as today's caption check; warnings ride into the result +
state + storyboard.md so the human sees them at the plan gate):
- ERRORS: `manifest_file_index` out of range; `out_seconds` > file duration+0.1s; captions-on-silent
  (existing); broll placement dangle (existing); `narration_span` outside its scene's window;
  b_roll clip longer than its narration_span.
- WARNINGS: scenes[0].purpose !== "hook"; hook scene > 3.5s; |sum(scene durations) −
  total_target_duration_seconds| > 0.5s; total vs target.duration_seconds drift > 20%; per-scene
  a_roll clip-duration sum vs scene target mismatch > 15%; b_roll hold < 1.5s; same b_roll segment
  reused back-to-back; key_moments timestamp ranges (when parseable) not covered by any clip.
- Schema stays "1.0"-accepting. New OPTIONAL fields validated when present: per-scene
  `caption_segments: [{text, start_seconds, end_seconds, emphasis?}]` (source-time), per-scene
  `transition_in/transition_out: "cut"|"fade"` (small enum — only what renders reliably on the 8GB
  host), top-level `style` block is NOT added (design language lives in the brief).

### D5 — INSPECT v2: cheaper images, richer signal (quality + token)
- Downscale at extraction: thumbs `-vf scale=480:-2`, segment keyframes `scale=512:-2` (agent-facing).
  `snapshot_keyframes` stills stay full-res (human-facing).
- Server-built contact strips (ffmpeg tile filter; zero-dep): per-file keyframe strip(s) for the
  inspector (≤~12 cells per strip) + a JSON legend mapping cell→{segment, timestamp}; per-clip-window
  bracketing strips are OPTIONAL (designer judges feasibility) — the fallback is the storyboarder
  reading downscaled singles, which is already 5× cheaper.
- Wire `clean_speech.json`: `state.inspect.clean_speech_path`, passed to storyboarder (spawn + agent
  doc): snap a_roll in/out to keep-span boundaries; plan-lint WARNING when an a_roll clip straddles
  a removed span (designer: implement in D4 using clean_speech when present).
- Per-file transcripts on multi-file drops (`inspect/transcripts/file_<i>.json`), per-file overlap
  attached in segments.
- Audio-feature pass chained into the existing silencedetect decode (ebur128/astats): per-file LUFS,
  per-segment energy + speech_rate → recorded in segments.json.
- Hook candidates: heuristic ranking (questions/numbers/bold claims/sentence position × energy)
  → `inspect/digest.md` `hook_candidates[]`; inspector refines/tags.
- INSPECT digest: `inspect/digest.md` — per-file one-liners, paragraph map, clean-cut stats, segment
  table (id, span, type, energy, speech_rate), hook candidates. Tool return points at it; the
  orchestrator reads THE DIGEST + contact sheet instead of N singles (visual grounding stays
  mandatory — cost drops, requirement doesn't).
- Keep ASR word confidence in transcript entries; cache transcription by content hash; classification
  schema gains structured visual fields (shot_type, subject_position, framing_ok_for_vertical).

### D6 — Composition QC + render verification (quality)
- Engine-side static QC (zero-dep regex/attribute scan), run at `save_composition` (cheap checks →
  immediate INVALID_ARGUMENTS-style rejection with findings) and folded into `lint_composition`'s
  report shape (one findings list, same gate semantics):
  - ERRORS: missing Rule-of-Three attrs; `./source/<ref>` that resolves to nothing; absolute
    filesystem `src` paths; master `data-duration` < sum of scene durations −0.5s; storyboard scene
    with no corresponding clip element; >8 total `<video>` elements.
  - WARNINGS: >6 `<video>` elements (host budget); non-zero `data-media-start` on a scene clip;
    caption font-size < 56px on vertical (when statically detectable); timed element missing
    `class="clip"` (pre-empting the hyperframes lint round-trip).
- `render_preview`/`render_full` results gain ffprobe verification deltas: `{duration_drift_s,
  width, height, size}`; >0.5s drift flagged in the result (silent-truncation detector).
- `snapshot_keyframes` must be usable in COMPOSE phase (post-lint, pre-preview) — verify/loosen its
  preconditions; it's the basis of the orchestrator self-QC loop (D9).
- Duration-aware render timeouts (`VOB_RENDER_TIMEOUT_MS`/`VOB_FULL_RENDER_TIMEOUT_MS` overrides,
  scaled by storyboard total duration, floored at today's caps); preview stderr tee to a log file
  (parity with render_full).
- Clip pre-cut: input-side `-ss` (fast seek; frame-accurate under transcode), crf 17–18, preset
  medium, aac 192k; bounded-parallel materialization via concurrency.js ceilings.
- PACKAGE: hook-aware thumbnail (midpoint of the hook scene, falling back to 10%); two-pass
  loudnorm to −14 LUFS / −1 dBTP on the final mp4 (default ON, `VOB_NO_LOUDNORM=1` opt-out, audio
  re-encode only, video stream copied); `--quality high` final render default on hosts ≥10GB
  (same gating shape as renderWorkerArgs).

### D7 — Typography: ship a font kit (quality)
- Vendor 4–6 OFL-licensed woff2 fonts (e.g. Inter 700/900, Anton, Bebas Neue or similar, one serif
  e.g. Playfair, one rounded e.g. Nunito) under `mcp/assets/fonts/` + a `fonts.css` with @font-face
  (relative `./fonts/...` urls). `save_composition` (or source-symlink machinery) symlinks/copies
  `fonts/` + `fonts.css` into `compose/` on every save, exactly like `source/`. Composer references
  them with plain CSS — the font lint passes because @font-face is present. Update NOTICE with OFL
  attributions. Designer: verify hyperframes' file server serves them (same mechanism as ./source/).
  IMPORTANT: implementers cannot download fonts at build time? They CAN (network available) — fetch
  from Google Fonts' GitHub (OFL). If fetching proves unreliable, fall back to documenting an
  install-time fetch in install.sh; do not block the rest of v2 on this.

### D8 — Prompt/skill v2 for claude-code (quality + token)
- SKILL.md → ~4–5k-token spine: hard rules (deduped, corrected — no stale npx/transcribe claims),
  FSM map, argument parsing (keep full — load-bearing), resume, doctor, per-phase 5-line summaries +
  "Read `skills/vob/phases/<PHASE>.md` on entering <PHASE>". Per-phase detail moves to
  `adapters/claude-code/.claude/skills/vob/phases/*.md` (9 files). Surface gate/save advisories.
- Brief template v2 (in PLAN phase file): adds a **Design language** section — typography (named
  font from the kit), palette, caption look (position/size/style), motion intensity — seeded from
  tone+platform via a curated mapping table in the phase file; the composer implements the brief's
  design language verbatim instead of re-deriving look from tone.
- **Orchestrator self-QC loop (the one-shot lever):** in COMPOSE, after lint passes: call
  `vob_snapshot_keyframes` (hook frame + caption-dense moments + scene boundaries), Read the
  contact sheet, check against a checklist (captions inside safe band, legible/contrast, no
  black/empty frames, overlay collisions, hook frame is actually striking), auto-revise the
  composer (≤2 self-QC rounds) for glaring failures BEFORE presenting to the user or rendering.
- Subagent spawn prompts become DATA-ONLY (project_id, paths, intent values, revision notes,
  style-reference paths). All behavioral contract lives in agent .md files.
- `storyboarder.md` v2: consume keep_spans (snap cuts), hook playbook (cold-open mid-action verbal
  hook; never greetings/wind-up), platform pacing tables, video-element/scene-count budget from
  host reality, grounding procedure on downscaled keyframes/strips, key_moments coverage, dedupe.
- `composer.md` v2: dedupe to ~5–6k tokens (one canonical statement per rule; 2 worked examples
  incl. the spine+B-roll case); lint gotcha fix recipes move to
  `skills/vob/references/lint-rules.md` read ONLY on a retry carrying that code; ADD: ≤6 video
  element budget + spine-concatenation guidance, SwiftShader large-emoji gotcha, font kit usage
  (./fonts/ + fonts.css), design-language-from-brief is binding, captions_style/audio_treatment/
  music_vo arrive in spawn data, platform dims from canonical intent.
- `inspector.md` v2: structured visual fields, hook tagging, strip-based reading procedure.
- Implement a REAL session write-guard hook (PreToolUse on Write|Edit blocking paths under
  `~/video-vob-sessions/`), replacing the no-op.
- Sync `settings.json` permissions.allow with any description changes (no tool-name changes
  expected — zero new tools).

### D9 — Cross-cutting sync + walker + docs
- OpenCode adapter: mirror ALL prompt/contract changes (vob.md, 3 subagents, opencode.json
  untouched unless return shapes demand prose updates). Tool names there are `vob_vob_*`.
- Extend `registry-integrity.js` boot check: verify every `role_bundles` entry maps to an agent
  file AND that the claude-code allowed-tools/settings allow-list + opencode permission blocks
  contain no unknown tool names (drift guard, exit 1 on hard mismatch).
- `m5-walker.js` v2: current conventions (scene clips `./source/sNNN-K.mp4`, `data-media-start=0`,
  clip class, plan-lint-clean storyboard, QC-clean composition); exercises plan lint + composition
  QC + (optionally, env-gated) preview render. It stays the executable spec / smoke test.
- Docs: CLAUDE.md updated to v2 reality (non-overridable blockers now true, clean_speech wired,
  lean returns, Node ≥22, platform profiles, QC); README de-staled; adapters/README contract table;
  `.vob/VERSION` 2.0.0 + install.json aligned; NOTICE for fonts.

## Explicitly OUT of scope for v2
Per-scene `render -c` + concat architecture; background render + poll tools; engine-generated
word-synced caption track artifact (composer keeps chunking from transcript); bundled music
library; template-generated adapter prompts (hand-sync + boot drift-guard instead); moving history
to history.jsonl (default-exclude on reads instead); any change to render execution model.

## Work packages and file ownership (implementers must not cross boundaries)

- **WP1 engine-contracts** (D1, D2-state, D2-envelope): session-state.js, tools/transition-phase.js,
  tools/read-state.js, tools/read-state-summary.js, tools/ingest-file.js (return shape only),
  envelope.js, dispatch.js, storage.js (async lock), phase-gates.js (overridable flags, revision
  binding, intent corrupt surface), tools/save-composition.js (preview/render reset ONLY — QC is WP4),
  tools/render-preview.js + render-full.js (revision stamp only), archive-for-iteration.js.
- **WP2 plan-quality** (D3, D4): platform-profiles.js (new), intent-schema.js,
  tools/record-intent-answer.js, storyboard-schema.js, tools/save-storyboard.js,
  storyboard-markdown.js, brief-validator.js (de-overfit), constants.js if needed.
- **WP3 inspect-media** (D5): inspect.js, tools/inspect-source.js, segment-signals.js,
  segment-model.js, silence-detector.js (audio features), clean-cut.js (exports only), asr-backend.js
  (confidence, cache), mcp/lib/asr/*, classification-schema.js, tools/save-classification.js,
  paths.js (new artifact paths — WP3 owns paths.js additions; other WPs request via spec).
- **WP4 compose-render-package** (D6, D7-engine): composition-files.js, tools/lint-composition.js,
  lint-report.js, tools/snapshot-keyframes.js, clip-materialize.js, source-symlink.js,
  tools/render-preview.js + render-full.js (verification deltas, timeouts, logs — coordinate with
  WP1's stamp via spec), hyperframes-runner.js, ffmpeg-runner.js, spawn-with-shutdown.js,
  tools/package-output.js, package-readme.js, overlay-compositor.js, mcp/assets/fonts/* (new),
  tools/save-composition.js (QC pre-check + font injection — applied AFTER WP1's reset edit).
- **WP5 claude-adapter** (D8): adapters/claude-code/** (SKILL.md, phases/*, references/*, agents/*,
  settings.json, hooks).
- **WP6 sync** (D9): adapters/opencode/**, registry-integrity.js, scripts/m5-walker.js, install.sh.
- **WP7 docs** (D9): CLAUDE.md, README.md, adapters/README.md, .vob/*, NOTICE, package.json metadata.

Build order: wave 1 = WP1 + WP3 (disjoint); wave 2 = WP2 + WP4 (disjoint; see the two shared-file
hand-offs above); wave 3 = WP5 + WP6 + WP7 (disjoint). Each wave ends with `node --check` on every
touched file + a TOOL_HANDLERS smoke (init→ingest→… in a temp session) before the next wave starts.

## Verification requirements (gate for "done")
1. `node --check` clean on all mcp/ + scripts/ files.
2. `node mcp/server.js` boots; registry build + integrity checks pass.
3. TOOL_HANDLERS smoke: init → ingest (real file) → inspect (skip ASR if absent) → intent (all keys,
   canonical) → save_brief/confirm → save_storyboard (valid + deliberately-invalid fixtures: plan
   lint errors AND warnings observed) → transition COMPOSE (clips materialize) → save_composition
   (QC reject fixture + clean fixture) → lint → snapshot (COMPOSE-phase) → [env-gated render].
4. Gate semantics: non-overridable blockers refuse override; revision binding blocks stale preview;
   legacy state.json (pre-v2 fixture) still reads + transitions.
5. Both adapters' tool name lists contain no unknown names (boot drift guard proves it).
6. Token accounting: tools/list bytes before/after; SKILL.md spine token estimate; documented in
   docs/v2/RESULTS.md.
