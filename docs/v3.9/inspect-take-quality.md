# v3.9 — INSPECT take-quality scoring (PROGRESS)

**Status:** ✅ DONE — feature-complete, adversarially reviewed, and all findings fixed + re-verified. Engine core, surfacing, agent docs, the OPTIONAL face backend, the `takequality` walker phase, doctor check, CHANGELOG, and CLAUDE.md invariant all landed. Verified: module smokes + `takequality` walker (7 steps) + REAL ffmpeg blurdetect + REAL OpenCV face detection (throwaway venv) + boot-clean both adapters + sibling `spans` regression. Rides the shared v3.9 branch's end-to-end test next. (Files are git-untracked — to be committed with the branch.)

## Adversarial review (iteration 3) — 3 parallel reviewers, all findings fixed
- **No HIGH/MED bugs.** Reviewers confirmed: degrade-don't-die holds on every failure path; `cleanByFile` winner-only gating correct; attach order sound; audio-only degrades to delivery-only; schema 1.2 back-compat (no consumer gates on segments.json version; detection cache stays on SEGMENT_SCHEMA_VERSION 1.0); take_quality flow + digest table integrity intact; no name-collision.
- **3 findings, all FIXED + re-verified:**
  - [perf] `detectFaceBackends()` re-ran the `import cv2` probe once per video file → memoized the probe per-process (`probeFaceModules`), `selected` still env-live. (`face-backend.js`)
  - [LOW] `paceScore` non-monotonic for `0<wpm<30` (dipped to ~0.09, below the wpm=0 floor) → floored sub-30 at the 0.2 halting anchor; verified monotone. (`take-quality.js`)
  - [LOW] temp-file leak in `analyzeOnce` when `runFfmpegBlocking` THROWS (catch returned before unlink) → unlink in the catch. (`visual-quality.js`)
**Started:** 2026-06-18 · **Branch:** `v3.9/design-system-kit` (shared multi-stage FSM-improvement tree)
**Sibling effort in same tree:** the storyboarder editorial-quality pass (`docs/v3.9/PRD.md`/`PROGRESS.md`) — this take-quality work is its UPSTREAM complement (it produces the richer signal that PRD's `loadSegments`/`PLAN_OPENING_LOW_ENERGY` consume).

## The problem (from the user)
> **INSPECT — no take-quality scoring (garbage-in for the edit).** INSPECT says what's spoken and what's A/B-roll, but not what's GOOD — strong delivery, good framing, sharp focus, no flubs. So the storyboarder picks spoken moments, not the best ones.
> **Fix:** surface per-segment strength signals (turn delivery energy/speech-rate into a "strength" score; add cheap visual heuristics: blur/sharpness, face-present, exposure). Upstream leverage — better input to every downstream decision.

## Design (locked)
Per non-silence segment, a composite **`strength`** block in `segments.json` (schema 1.1 → **1.2**):
`strength.{score (0–1), tier (strong|usable|weak), delivery, visual, components{energy,pace,cleanliness,sharpness,exposure,face}, flags[]}`.
- **Relative-within-file** for energy + sharpness (mic gain / lens / lighting are constant within a shoot → "strong" = the best take of THIS footage), **absolute bands** for pace (wpm) + exposure (luma).
- Composite = 0.6·delivery + 0.4·visual for a spoken take; visual-only for b-roll; renormalizes over present components. **Fail-safe**: every missing input → null component; score null only when nothing measurable.
- `flags[]` = the actionable "why weak": `low_energy`/`halting`/`rushed`/`filler_heavy`/`soft_focus`/`underexposed`/`overexposed`/`no_face`.

### Cheap visual heuristics — reuse the keyframes INSPECT already extracts
No video re-decode: analyze `inspect/segment_keyframes/file_<i>/seg_<n>.jpg` (512w, already on disk) with ONE ffmpeg pass per frame — `blurdetect,signalstats,metadata=mode=print:file=…` → sharpness (`1/(1+blur)`) + exposure (luma mean). **Degrades**: no `blurdetect` (pre-5.0) → exposure-only; any frame fails → null; whole pass deadline → remaining null. Cleanliness = fraction of a speech segment NOT covered by clean-cut `removed[]` spans (winner file only).

## Files
- **NEW `mcp/lib/take-quality.js`** — pure scoring (no I/O). `attachTakeStrength`, `attachCleanliness`, `computeSegmentStrength`, `fileTakeStats`, `summarizeTakeQuality`. Knob `VOB_TAKE_QUALITY=off`.
- **NEW `mcp/lib/visual-quality.js`** — ffmpeg exposure+sharpness. `attachVisualFeatures`, `analyzeKeyframeImage`. Knobs `VOB_VISUAL_QUALITY=off`, `VOB_VISUAL_QUALITY_FRAME_TIMEOUT_MS`, `VOB_VISUAL_QUALITY_TIMEOUT_MS`.
- **`mcp/lib/inspect.js`** — `SEGMENTS_DOC_VERSION`→`1.2`; `segmentSourceFiles` runs visual→cleanliness→strength after keyframes; `runInspect` captures clean-cut `removed`, passes `cleanByFile`, computes `take_quality` summary; digest call gets `takeQuality`.
- **`mcp/lib/segment-signals.js`** — unchanged (visual/strength attach happens in `segmentSourceFiles`, keeping segment-signals pure-ish).
- **`mcp/lib/inspect-digest.js`** — new `## Strongest takes` leaderboard section + a `take` column (tier+score+flags) in the segment table.
- **`mcp/lib/tools/inspect-source.js`** — `take_quality` into `state.inspect` + the tool return.
- **`mcp/lib/session-state.js`** — `summarizeTakeQuality` projection into `read_state_summary.inspect.take_quality` (lean: counts + median + top-5 strongest).
- **`adapters/claude-code/.claude/agents/storyboarder.md`** (line ~39 `segments_path`) + **`…/references/editorial-patterns.md`** (§1 T-dimension, §2 cheat-sheet, §5 take-selection) — document/mandate preferring `strong`-tier takes. Ported to OpenCode (`port-adapter-docs.js`, 17 files).

## Verification done
- `take-quality` smoke (`/tmp/vob_takequality_smoke.js`): strong=0.86 / weak=0.10 w/ correct flags; b-roll visual-only; pace-only fallback; silence→null; disabled knob; missing-file degrade. ✅
- `digest` smoke (`/tmp/vob_digest_smoke.js`): leaderboard + take column render; null-safe. ✅
- **REAL ffmpeg** (`analyzeKeyframeImage` on synthetic frames): `blurdetect`+`signalstats` present; sharp/bright→sharpness 0.17/luma 126 vs blur/dark→0.05/luma 21 — discriminates correctly. ✅
- Boot integrity green (both adapters); registry 30 tools. ✅

## Done (iteration 2)
- [x] **Optional face backend** — `mcp/lib/face-backend.js` + `mcp/lib/visual/face_detect.py` (OpenCV bundled Haar; mirrors `asr-backend.js` detect→run→degrade). Attaches `face` per segment in `segmentSourceFiles` (after visual, before strength); `face_backend` rides into the take_quality summary. Knob `VOB_FACE_BACKEND`. **Verified live**: real human face detected (present/area/centered) + the full Node→Python→parse→attach→score path via `VOB_PYTHON` pointed at a throwaway opencv venv; and the no-cv2 degrade (face:null) on this host.
- [x] **`takequality` walker phase** (`node scripts/m5-walker.js takequality`) — source-free, 7 steps (ordering/tiers/flags, fail-safe nulls, cleanliness, face term, disabled knob, visual-meta parse, summary+digest). Caught & fixed a contract wrinkle: a non-silence segment with nothing measurable now returns `strength:null` (not a hollow `{score:null}`), matching silence.
- [x] **`inspector.md`** — take-quality fields in the segments.json doc + `strength.score` as the best-take prior. Ported to OpenCode.
- [x] **`vob_doctor`** — optional, warn-only `face-detection` check (mirrors `remove-background`).
- [x] **CHANGELOG** (`docs/v3.9/CHANGELOG.md` — "INSPECT take-quality" section) + CLAUDE.md invariant (iter 1).

## Remaining
- [ ] Final adversarial self-review (parallel reviewers) of the take-quality + face slices.
- [ ] Version bump to 3.9.0 is the shared branch's concern (the sibling owns `.vob/VERSION`/`package.json`/`server.js`); nothing take-quality-specific to bump.

## Guardrails held
Engine produces structure (the score), skill/agents own how to use it. All advisory — no gate, no FSM edge, no new required intent key. Degrade-never-throw throughout. Lands in `segments.json` so the sibling editorial-quality lints consume it for free.
