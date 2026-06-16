# PRD 03 — Subject Compositing (`render_mode: "subject"`)

**One-line summary:** Add a `render_mode: "subject"` to b-roll/scene placements that uses hyperframes `remove-background` (local AI matte) to lift a talking-head / foreground subject off its original background and composite it over a **designed backdrop or another ingested clip** — enabling clean non-rectangular PiP, podcast→video, and a cinematic talking-head spine.

**Status:** Proposed
**Target release:** v3.3 (hyperframes-leverage creative layer). Sibling PRDs in this directory: [`01-caption-system-v2.md`](./01-caption-system-v2.md), [`02-scene-transitions.md`](./02-scene-transitions.md). This PRD is independent of both and can ship in any order.

---

## Problem / motivation

bob composites footage **rectangularly**. A b-roll placement is a full-frame cut, a rectangular PiP inset, or a graphics overlay (`broll_placements[].render_mode ∈ {full_frame, pip, overlay}`, see `mcp/lib/storyboard-schema.js` → `BROLL_RENDER_MODES`). There is no way to put a *subject* — a person, a product, a hand — onto a different background than the one they were filmed against. That blocks three things bob's presets explicitly want:

- **Podcast → video** (`podcast` preset, `video-types.js`): a static talking-head shot is visually dead for 30 minutes. Lifting the speaker onto a designed backdrop (brand gradient, chapter card, lower-third stage) is the single biggest production-value lever for the format, and the preset already reserves `pip` in its `overlay_vocabulary`.
- **Cinematic / social talking-head spine** (`cinematic`, `social-short`): a non-rectangular subject cut-in over the A-roll reads as "edited," not "filmed on a phone."
- **Clean PiP**: today a PiP is a rectangle with a hard edge. A matted subject is a floating cut-out — the look every CapCut/Desced edit uses.

hyperframes ships a **local** `remove-background` command (no cloud, `coreml` on Apple Silicon). It only ever *transforms footage the user already shot* — it never fabricates pixels of new content — so it sits cleanly inside bob's ingested-only rule. The capability exists in the engine bob already drives; bob just doesn't call it.

## Goals

1. A new `render_mode: "subject"` on `broll_placements[]` (additive to schema 1.2) that mattes a subject clip and composites it over a declared backdrop.
2. The matte is produced **once, on COMPOSE entry**, as a content-hash-cached side effect — exactly mirroring `clip-materialize.js`, so back-edge re-entry is a no-op.
3. Two realization paths, the same dual-strategy bob already uses for graphics overlays: **(a)** matte as an alpha `<video>` inside a hyperframes composition over an HTML/CSS backdrop (default; full motion/caption freedom), and **(b)** an ffmpeg composite via `overlay-compositor.js` (fallback for low-RAM hosts / `<video>` fragility).
4. Every `remove-background` invocation flows through the **one hyperframes runner chokepoint** (`hyperframes-runner.js`), inheriting the pinned-engine env policy and a **duration-aware timeout**.
5. Wire `podcast` and `cinematic` presets to prefer a subject spine where it fits.
6. Surface a preflight (`vob_doctor` + the INGEST dependency probe) so a missing/un-downloaded background model fails in seconds, not after COMPOSE burns minutes.

## Non-goals

- **No generated, stock, or AI-synthesized backdrops.** This is the load-bearing philosophy line. `remove-background` is sanctioned *only because* it transforms the user's own ingested footage. The replacement backdrop MUST be one of: a **design token** (solid / gradient / `target.design` palette), or **another ingested clip** (`clip_ref` / the scene's own base, `scene_base`). bob never reaches for a stock image, a generated gradient-photo, or an AI scene. This keeps "subject compositing" strictly inside the same ingested-only contract as the B-roll gap rule (`isGapPlacement` in `storyboard-schema.js`, resolved by re-ingesting real footage — never by synthesis).
- **No background *replacement with video the user didn't shoot.*** A `clip_ref` backdrop must resolve to a clip already in the manifest.
- **No green-screen keying as a separate path.** `remove-background` is segmentation-model matting; we do not add a chroma-key filter. (If a user shot on a literal green screen, the model still mattes it; we don't special-case it.)
- **No real-time / preview-studio integration.** Matting is a batch preprocessing step, like clip pre-cut.
- **No auto-grading of matte edge quality** (see Risks — we snapshot for review instead).
- **Not a replacement for `pip`.** Rectangular PiP stays; `subject` is the matted sibling.

## Current state (files / mechanisms this builds on)

| Mechanism | File | Role here |
|---|---|---|
| One hyperframes runner (resolve-once, pinned, retry) | `mcp/lib/hyperframes-runner.js` | Add `buildRemoveBackgroundArgv` + a runner; reuse `resolveHyperframesCmd`, `hyperframesChildEnv`, `runHyperframesWithRetry`. |
| Clip pre-cut on COMPOSE entry (content-hash sidecar cache) | `mcp/lib/clip-materialize.js` (`materializeSceneClips`) | Direct precedent for `matte-materialize.js`. Matte input = the **already pre-cut** clip. |
| COMPOSE-entry side effect | `mcp/lib/session-state.js:650-666` (`if (toPhase === "COMPOSE")`) | Insert `materializeSubjectMattes` right after `materializeSceneClips` (line 651-654), before `deriveRenderPlan`. |
| ffmpeg overlay-over-base composite | `mcp/lib/overlay-compositor.js` (`compositeOverlayOverBase`, `buildOverlayCompositeArgv`) | Path (b). `overlay=format=auto` already preserves alpha; `audio` param already accepts a **source path**. |
| Storyboard schema + plan lint | `mcp/lib/storyboard-schema.js` (`BROLL_RENDER_MODES`, `validateStoryboardContent`, `lintStoryboardPlan`, `isGapPlacement`, `collectBrollGaps`) | Add `"subject"` to the enum; validate a `backdrop` ref; optional plan-lint warning. |
| Storyboard save | `mcp/lib/tools/save-storyboard.js:113` | No change needed beyond the schema additions it already drives. |
| Video-type presets | `mcp/lib/video-types.js` (`podcast`, `cinematic`, `overlay_vocabulary`, `design_default`) | Wire subject spine + supply the default backdrop tokens. |
| Path helpers | `mcp/lib/paths.js` (`transcodedClipsDir`, `transcodedClipPath`, `transcodedClipSidecarPath`) | Add `mattesDir` / `mattePath` / `matteSidecarPath` under `transcoded/mattes/`. |
| Duration-aware timeout | `mcp/lib/inspect.js:144` (`durationAwareTimeout`) | Mirror the pattern for the matte timeout (sibling of `renderTimeoutMs` in the runner). |
| Host capacity profile | `mcp/lib/host-profile.js` | New knob: subject-seconds budget + device default. |
| INGEST preflight | `mcp/lib/tools/ingest-file.js:221-283` (`checkHyperframesAvailable`/`checkFfmpegAvailable`/`checkAsrAvailable` → `state.dependencies`) | Add a `remove-background` model probe. |
| Doctor | `mcp/lib/tools/doctor.js` (`{ ok, summary, host, tuning, video_types, checks[], advisories[], blockers[], warnings[] }`) | Report the matte backend + advisory. |
| Composer subagent + recipes | `adapters/claude-code/.claude/skills/vob/references/lint-rules.md`, composer `agents/*.md` | Realization recipes for both paths. |
| Walker integration test | `scripts/m5-walker.js` (phase dispatch at line ~2159) | New `subject` phase. |

## hyperframes capabilities leveraged (v0.6.97)

`hyperframes remove-background <INPUT> [OPTIONS]` — removes background from a video or image using a **local** AI model, outputting transparent media. Verified flags (capability map, v0.6.97):

- **Input:** video (`.mp4/.mov/.webm/.mkv`) or image (`.jpg/.png/.webp`).
- `-o, --output=<path>` — output path; **format inferred from extension**: `.webm` (VP9 alpha), `.mov` (alpha, ProRes-family), `.png` (image).
- `-b, --background-output=<path>` — optional **inverse-alpha plate** (subject transparent, surroundings opaque); `.webm`/`.mov` only. *(We do not need this for v3.3; noted for future "blur the background" treatments.)*
- `--device=<provider>` — `auto` | `cpu` | `coreml` | `cuda` (default `auto`). On Apple Silicon `coreml` uses the Neural Engine/GPU; `cpu` is the safe fallback.
- `--quality=<preset>` — `fast` | `balanced` | `best` (default `balanced`), for `.webm` output.
- `--info` — print detected execution providers and exit (used by the doctor/INGEST probe).
- `--json` — machine-readable result.

Key facts that shape the design:
- It is **media preprocessing**, not a render/snapshot — but it is still the `hyperframes` binary, so it MUST go through `resolveHyperframesCmd()` (the one-runner invariant: no `npx` re-resolution, pinned engine, no mid-pipeline auto-update).
- First run may **download model weights** (tens-to-hundreds of MB). This is why a preflight is mandatory.
- It is **slow on long footage** (per-frame inference). A fixed timeout would guarantee a timeout on a 20-minute podcast clip — hence the duration-aware timeout.
- Output transparent media is consumed two ways: as a `<video>` in a hyperframes composition (path a) or as the alpha overlay in an ffmpeg `overlay=format=auto` composite (path b).

## Proposed design

### Schema (engine: `mcp/lib/storyboard-schema.js`)

Extend the frozen enum and validate a backdrop reference. **Additive and non-version-gated** (same treatment as `target.design` / `target.fps` — any schema version; no new `v13` flag).

```js
// today: const BROLL_RENDER_MODES = Object.freeze(["full_frame", "pip", "overlay"]);
const BROLL_RENDER_MODES = Object.freeze(["full_frame", "pip", "overlay", "subject"]);

// Backdrop kinds a subject may be composited onto. design_token | clip_ref | scene_base only.
const BACKDROP_KINDS = Object.freeze(["design_token", "clip_ref", "scene_base"]);
```

A `subject` placement gains a `backdrop` object (validated only when `render_mode === "subject"`):

```jsonc
{
  "scene_ref": "scene-03",
  "render_mode": "subject",
  "source_clip": { "source_path": "/abs/clip.mp4", "in_seconds": 12.0, "out_seconds": 18.5 },
  "backdrop": {
    "kind": "design_token",          // design_token | clip_ref | scene_base
    "fill": "palette.bg",            // design_token: a target.design palette key OR a #hex / css-gradient string
    // "clip_ref": "scene-01-0",     // clip_ref: a materialized clip key (sceneId-clipIndex) already in the plan
    "blur_px": 0                     // optional, only meaningful for clip_ref/scene_base backdrops
  },
  "position": { "anchor": "center", "scale": 0.85 },   // subject placement on the backdrop
  "motion": { "in": "fade", "out": "fade" }            // reuses the existing motion vocabulary
}
```

Validation (additive, in `validateStoryboardContent`):
- `render_mode` must be in `BROLL_RENDER_MODES` (already enforced; `"subject"` now passes).
- When `render_mode === "subject"`: `backdrop` is required and `backdrop.kind ∈ BACKDROP_KINDS`. A `design_token` backdrop needs `fill`; a `clip_ref` backdrop needs a `clip_ref` that resolves to a known materialized clip key; `scene_base` needs no extra field (it means "the scene's own first clip, behind the matted subject").
- A subject placement is **never** a gap (`isGapPlacement` stays false for it) — it has a real `source_clip`.

Plan lint (`lintStoryboardPlan`, **warning only — never blocks sign-off**, consistent with the B-roll-gap and overlay warnings):
- `PLAN_SUBJECT_BACKDROP_NOT_INGESTED` — a `clip_ref`/`scene_base` backdrop that doesn't resolve to a manifest clip, **or any backdrop kind outside `BACKDROP_KINDS`**. This is the lint-level guard that keeps the no-synthesized-backdrop rule visible to the human at the plan gate.
- `PLAN_SUBJECT_BUDGET_EXCEEDED` — total subject-clip seconds in the document (or per render unit) exceed the host budget (see host-profile knob). Warns the human that matting will be slow on this host.

### Engine: runner (`mcp/lib/hyperframes-runner.js`)

Add a canonical argv builder (next to `buildRenderArgv` / `buildSnapshotArgv`), a duration-aware timeout (sibling of `renderTimeoutMs`), a device knob, and a thin runner that reuses the retry wrapper.

```js
// Device resolution: VOB_REMOVE_BG_DEVICE > darwin default "coreml" > "cpu".
function resolveRemoveBgDevice() {
  const knob = (process.env.VOB_REMOVE_BG_DEVICE || "").trim().toLowerCase();
  if (["auto", "cpu", "coreml", "cuda"].includes(knob)) return knob;
  return process.platform === "darwin" ? "coreml" : "auto";
}

function buildRemoveBackgroundArgv({ inPath, outPath, quality = "balanced", device = resolveRemoveBgDevice() }) {
  return ["remove-background", "--json", "--device", device, "--quality", quality, "-o", outPath, inPath];
}

// Matte timeout scales with clip duration (per-frame inference is the cost).
// Floored generously, ceilinged, fully overridable (VOB_REMOVE_BG_TIMEOUT_MS).
const REMOVE_BG_TIMEOUT_FLOOR_MS = 10 * 60 * 1000;
const REMOVE_BG_TIMEOUT_PER_SECOND_MS = 60 * 1000;   // 1 min wall per 1s of clip — generous
const REMOVE_BG_TIMEOUT_CEILING_MS = 3 * 60 * 60 * 1000;
function removeBackgroundTimeoutMs(clipSeconds) {
  const env = Number.parseInt((process.env.VOB_REMOVE_BG_TIMEOUT_MS || "").trim(), 10);
  if (Number.isInteger(env) && env > 0) return env;
  if (!Number.isFinite(clipSeconds) || clipSeconds <= 0) return REMOVE_BG_TIMEOUT_FLOOR_MS;
  return Math.min(REMOVE_BG_TIMEOUT_CEILING_MS,
    Math.max(REMOVE_BG_TIMEOUT_FLOOR_MS, Math.round(clipSeconds * REMOVE_BG_TIMEOUT_PER_SECOND_MS)));
}

async function runRemoveBackground(argv, { timeoutMs, stderrLogPath = null } = {}) {
  // remove-background is deterministic per input but the SPAWN can still hit the
  // ESM/launch flakes the render path sees, so reuse the bounded retry — but
  // retryTimedOut:false (a long matte that timed out shouldn't blindly re-run).
  return runHyperframesWithRetry(argv, { timeoutMs, stderrLogPath, maxAttempts: 2, retryTimedOut: false });
}

// Preflight: `remove-background --info` lists providers without doing work and
// surfaces a missing/un-downloaded model. Mirrors checkHyperframesAvailable().
function checkRemoveBackgroundAvailable({ timeoutMs = 30 * 1000 } = {}) { /* runHyperframesSync(["remove-background","--info","--json"]) → {ok, providers, error} */ }
```

Export all four alongside the existing builders.

### Engine: matte materialization (`mcp/lib/matte-materialize.js`, new)

A near-clone of `clip-materialize.js`. **Input = the already-pre-cut clip** (`transcodedClipPath(id, sceneId, clipIndex)`), so the matte is trimmed/sped exactly like the spine and we never re-trim. Output = an alpha `.webm` under `transcoded/mattes/`. Content-hash sidecar so a back-edge COMPOSE re-entry is a no-op.

```js
async function materializeSubjectMattes({ projectId, storyboard = null, hostBudget } = {}) {
  // 1. Collect every subject placement across all timelines (storyboardTimelines()
  //    + the fan-out-aware accessors), resolve each to its pre-cut clip path.
  // 2. Budget check: sum subject-clip seconds; if > hostBudget.subjectSecondsMax,
  //    still proceed but flag `over_budget:true` in the summary (the plan lint
  //    already WARNED at sign-off — this is the runtime echo).
  // 3. Per matte (bounded concurrency = recommendedHeavyEncodeConcurrency()):
  //    - sidecar key = { source_clip_path, source_clip_mtime_ms, argv_hash(device+quality+format), schema_version }
  //    - cache hit → record "cached"; miss → runRemoveBackground(buildRemoveBackgroundArgv(...),
  //      { timeoutMs: removeBackgroundTimeoutMs(clipSeconds) })
  //    - on success write the sidecar atomically (writeFileAtomic), record matte_path
  // 4. Return { mattes: [{ scene_id, clip_index, matte_path, status, ... }], summary, over_budget }
}
```

Sidecar cache key deliberately includes `device` + `quality` + output format (via the argv hash) so flipping `VOB_REMOVE_BG_DEVICE=cpu` or `--quality best` re-mattes — same discipline as the clip sidecar keying on the ffmpeg argv hash (`clip-materialize.js:170-178`).

Paths (`mcp/lib/paths.js`), mirroring the transcoded-clip helpers:

```js
function mattesDir(projectId)        { return path.join(transcodedDir(projectId), "mattes"); }
function mattePath(projectId, sceneId, clipIndex)        { return path.join(mattesDir(projectId), `${transcodedClipStem(sceneId, clipIndex)}.webm`); }
function matteSidecarPath(projectId, sceneId, clipIndex) { return path.join(mattesDir(projectId), `${transcodedClipStem(sceneId, clipIndex)}.json`); }
```

### Engine: COMPOSE-entry wiring (`mcp/lib/session-state.js`)

Insert directly after the existing `materializeSceneClips` call (currently line 651-654), before `deriveRenderPlan`. Same async/blocking discipline — the user is never advanced into COMPOSE with half-prepared mattes:

```js
if (toPhase === "COMPOSE") {
  transcodedClips = await materializeSceneClips({ projectId: id, audioTreatment: readAudioTreatment(state) });
  subjectMattes = await materializeSubjectMattes({ projectId: id, hostBudget: hostProfile.subjectBudget() });  // NEW
  // ...deriveRenderPlan unchanged...
}
```

Stamp `next.subject_mattes = subjectMattes` (lean: counts + per-matte status/path) and emit a `subject_mattes_materialized` history event, exactly like `scene_clips_materialized` (line 713-718). `read_state_summary` gains a lean `subject_mattes: { count, cached, over_budget }`.

### Two realization paths (composer-facing)

**(a) DEFAULT — alpha `<video>` in the composition over an HTML/CSS backdrop.**
The composer authors a normal hyperframes composition. The backdrop is HTML/CSS from `target.design` tokens (a `design_token` backdrop) — full GSAP motion, captions, overlays all available. The matte rides as a higher-track `<video class="clip">` pointing at the materialized `.webm`, with the subject's **audio supplied by a separate `<audio class="clip">`** sourced from the pre-cut subject clip (the matte `.webm` is visual-only). Sketch:

```html
<!-- backdrop: design tokens, pure CSS -->
<div class="clip" id="bg" data-start="0" data-duration="6.5"
     style="background:linear-gradient(180deg,#111,#8B5CF6);"></div>
<!-- subject: alpha matte over the backdrop -->
<video class="clip" id="subj" muted playsinline
       data-start="0" data-media-start="0" data-duration="6.5" data-track-index="1"
       style="position:absolute;inset:0;object-fit:contain;z-index:2;"
       src="./source/scene-03-0.matte.webm"></video>
<!-- subject audio (matte is visual-only) -->
<audio class="clip" id="subj-a" data-start="0" data-media-start="0" data-duration="6.5"
       data-track-index="2" src="./source/scene-03-0.mp4"></audio>
```

This leverages the hyperframes render and is the richest look — **but** it puts a `<video>` (and an alpha one at that) into the composition, which is exactly the headless-Chrome fragility the project already documents. So:

**(b) FALLBACK — ffmpeg composite via `overlay-compositor.js`.**
No browser `<video>` capture. The backdrop is either an ffmpeg-generated solid/gradient (from `design_token`) or another **ingested** clip (`clip_ref` / `scene_base`); the matte `.webm` is the alpha overlay; the subject's audio is muxed from the pre-cut clip. `compositeOverlayOverBase` already does precisely this — `overlay=format=auto` preserves alpha and the `audio` param accepts a source path:

```js
await compositeOverlayOverBase({
  basePath:    backdropPath,                 // ffmpeg lavfi color/gradient OR an ingested clip
  overlayPath: mattePath(id, sceneId, clipIdx),  // alpha .webm
  outPath:     subjectCompositePath,
  audio:       transcodedClipPath(id, sceneId, clipIdx),  // subject speech, NOT the (silent) backdrop
  scaleToBase: true,
});
```

**Recommendation:** path (a) when the host budget allows browser `<video>` capture **and** the look needs HTML motion on the backdrop; path (b) when the host is low-RAM, when alpha-`<video>` capture proves fragile, or when the backdrop is itself a clip (clip-over-clip is cheaper and steadier in ffmpeg). This is the *same* decision bob already makes for graphics overlays (`overlay-compositor.js` header comment). The composer chooses; the engine supports both. On a sub-10 GB host the default flips to (b).

### Presets (`mcp/lib/video-types.js`)

- `podcast` and `cinematic` `design_default` already carry palette/typography — these become the default `design_token` backdrop fills. No structural change to the preset shape.
- Document (in the composer recipe) that on `podcast`/`cinematic` the talking-head spine *should* prefer a subject treatment when a single speaker dominates the frame. `pip` is already in `podcast.overlay_vocabulary`; no enum change needed there.

### Preflight (`ingest-file.js` + `doctor.js`)

- INGEST (`ingest-file.js:221-283`): add `const removeBg = checkRemoveBackgroundAvailable();` next to the existing `checkHyperframesAvailable()` / `checkAsrAvailable()` calls, fold it into `state.dependencies.remove_background`, and include it in `dependency_failures` **as a warning, never fatal** (a project may not use subject mode). This way a missing/un-downloaded model surfaces at INGEST, before COMPOSE spends 20 minutes failing per clip.
- `doctor.js`: add `report.checks` entry for the matte backend (`remove-background --info` providers) and an advisory ("`remove-background` downloads model weights on first run; `coreml` on Apple Silicon, `cpu` fallback").

### Host budget (`host-profile.js`)

New resolver `subjectBudget()` returning `{ subjectSecondsMax, device }` with the standard precedence (`VOB_*` env > `host.json` key > capacity tier > RAM default). Default `subjectSecondsMax`: low-RAM (<10 GB) → 60s of subject footage total; else → 600s. Knob `VOB_SUBJECT_SECONDS_MAX`. `device` defers to `resolveRemoveBgDevice()` in the runner (kept there so it covers both the materializer and the doctor probe). Report both under `doctor` `report.tuning`.

## Implementation plan (phased commits)

1. **Schema + lint.** Extend `BROLL_RENDER_MODES`, add `BACKDROP_KINDS`, validate `backdrop` additively in `validateStoryboardContent`, add the two warning codes to `lintStoryboardPlan`. Update the `save-storyboard` description string. Unit-exercise via the walker's storyboard-save path. *(No behavior change for existing storyboards — the enum addition and conditional validation are purely additive.)*
2. **Runner.** `buildRemoveBackgroundArgv`, `resolveRemoveBgDevice`, `removeBackgroundTimeoutMs`, `runRemoveBackground`, `checkRemoveBackgroundAvailable` in `hyperframes-runner.js`; export them.
3. **Paths + materializer.** `mattesDir`/`mattePath`/`matteSidecarPath`; `matte-materialize.js` (clone `clip-materialize.js` structure: pass-1 validate+cache-check, pass-2 bounded-parallel mattes, atomic sidecars).
4. **COMPOSE wiring.** Call `materializeSubjectMattes` in `session-state.js`; stamp `subject_mattes` + history event; add the lean `read_state_summary` field.
5. **Composite fallback.** Confirm `compositeOverlayOverBase` covers the subject case (it does); add a tiny `buildBackdropArgv` helper (ffmpeg `lavfi` color/gradient) for `design_token` backdrops in path (b).
6. **Preflight.** INGEST probe + `doctor` check/advisory; `host-profile.subjectBudget()`.
7. **Presets + adapter recipes.** `video-types.js` doc + composer `agents/*.md` + `lint-rules.md` recipes for BOTH paths (the alpha-`<video>` composition sketch and the ffmpeg-fallback note, including the "audio comes from the subject clip, not the backdrop" gotcha). Run `node scripts/port-adapter-docs.js` to regenerate the OpenCode mirror.
8. **Walker phase + docs.** New `subject` walker phase; update `CLAUDE.md` invariants (a new bullet under the overlay/b-roll cluster) and `docs/v3.2/CHANGELOG.md`.

## Testing & verification

New walker phase `node scripts/m5-walker.js subject` (dispatch alongside `overlays`/`gaps` at `scripts/m5-walker.js:~2176`). It must, against the real walker source video:
1. Save a storyboard with one `subject` b-roll placement on a `design_token` backdrop (assert the save passes lint; assert a bad `kind` warns `PLAN_SUBJECT_BACKDROP_NOT_INGESTED`).
2. Transition to COMPOSE and assert: a matte `.webm` exists at `mattePath(...)`, its sidecar is written, and a **second** COMPOSE entry (back-edge RENDER→COMPOSE) reports the matte as `cached` (content-hash no-op — the load-bearing assertion, same as the clip-materialize cache test).
3. Run path (b) `compositeOverlayOverBase` and ffprobe-assert the composite is **duration-exact** vs the subject clip and **retains audio** (the subject's speech, not silence) — the same duration/audio discipline `overlay-compositor.js` already documents (`-shortest` deliberately absent).
4. Assert the budget echo: a synthetic over-budget set flags `over_budget:true` without aborting.

Real-video sanity (manual, documented in the phase comment): one `remove-background` run on the example DJI clip with `--device coreml`, snapshot a mid-frame, eyeball the matte edge. (Edge quality is not auto-asserted — see Risks.)

`vob_doctor` must report the matte backend and not flip `ok:false` when the model is absent (warning only).

## Risks & open questions

- **Alpha `<video>` fragility in headless Chrome.** Transparent VP9 in the hyperframes render path is unproven on bob's low-RAM reference host, and `<video>` capture is already the documented fragile path. *Mitigation:* path (b) is the low-RAM default; path (a) is opt-in where the host budget allows. **Open:** validate VP9-alpha `<video>` actually composites in the hyperframes capture before recommending (a) anywhere — if it doesn't, (a) becomes "designed backdrop + matte both as ffmpeg," i.e. (b) always, and (a) is dropped.
- **Model-weights download / pinning.** First `remove-background` downloads weights; a mid-pipeline failure must not strand COMPOSE. *Mitigation:* INGEST preflight + doctor; the matte timeout floor is generous; `runRemoveBackground` does **not** retry a timeout. **Open:** is the weights cache stable across hyperframes upgrades? bob pins the engine per-process (`HYPERFRAMES_NO_AUTO_INSTALL`), so within a session it's fixed; across sessions the model may re-download after a hyperframes bump.
- **`coreml` vs `cpu` on the 8 GB Mac.** `coreml` should be faster, but the Neural Engine path may contend with the same memory pressure that drives the render worker clamp. *Mitigation:* `VOB_REMOVE_BG_DEVICE` knob + host-profile default; the subject-seconds budget caps total work. **Open:** measure coreml vs cpu wall-time + RAM on the reference host; pick the default empirically.
- **Matte edge quality is not auto-gradeable.** A bad matte (haloing, missed hair) is a visual defect no luma/geometry check catches. *Mitigation:* snapshot a subject frame at PREVIEW for agent (multimodal) / human review — bob's orchestrator can read the PNG directly (no external vision dependency), the same reasoning used to reject `snapshot --describe`. **Open:** should a subject scene force a snapshot into the PREVIEW gate rather than leaving it optional?
- **Backdrop audio collision.** A `clip_ref`/`scene_base` backdrop clip may carry its own audio; the subject's speech must win. *Mitigation:* path (b) explicitly muxes the subject clip's audio (`audio:` = the pre-cut subject path); the backdrop clip is laid muted (same rule as b-roll-over-spine in `clip-materialize.js:160-165`). Documented in the recipe.

## Philosophy fit

- **Ingested-only respected.** `remove-background` only transforms the user's own footage; the Non-goals forbid any synthesized/stock backdrop, and the `BACKDROP_KINDS` enum + `PLAN_SUBJECT_BACKDROP_NOT_INGESTED` lint make that machine-checked, not just a convention. This is the same ingested-only contract as the B-roll gap rule.
- **One hyperframes runner.** Every `remove-background` call goes through `resolveHyperframesCmd()` / `hyperframesChildEnv()` — pinned engine, no `npx`, no mid-pipeline auto-update, bounded retry. No new resolution path.
- **Native / local render.** The matte model runs locally (`coreml`/`cpu`); no cloud, no Docker, no footage leaving the machine. Consistent with the "render natively on the host" rule.
- **COMPOSE-entry side effect + content-hash cache.** Matting is a blocking COMPOSE-entry step cached by a content-hash sidecar — byte-for-byte the `clip-materialize.js` discipline, so back-edges (re-COMPOSE for the next short/segment, ITERATE) re-enter for free.
- **Two paths, not a workaround.** The ffmpeg fallback is the *same* first-class "overlay-over-base" pattern the project already sanctions for fragile `<video>` graphics — this PRD reuses `overlay-compositor.js` rather than inventing a parallel compositor.

## Out of scope / future

- **Inverse-plate background treatments** (`-b` flag): blur/darken the subject's *original* background and composite the sharp subject back over it ("portrait mode"). Cheap follow-up once the matte pipeline exists.
- **Subject tracking / auto-reframe** (keep the matted subject centered as they move). Needs per-frame bbox; out of scope.
- **Multi-subject scenes** (two speakers matted onto one stage). The schema allows multiple subject placements per scene; the *layout* logic (side-by-side) is a composer concern deferred to a later PRD.
- **Green-screen-aware fast path.** If a user shot on a literal green screen, a chroma key would be cheaper than the segmentation model — not worth the branch now.
