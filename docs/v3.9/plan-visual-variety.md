# v3.9 — PLAN visual-variety / cutaway-rhythm budget

The #1 reason an agent-edited talking-head reads as flat: **long static stretches
where nothing on screen changes.** The variety machinery already existed — typed
overlays, multi-cell layouts, subject mattes, kinetic captions, b-roll cutaways —
but nothing made the storyboarder *proactively plan* it, and one genuinely-missing
device (an intra-scene punch-in) had no way to be expressed. So a plan could sit on
the same framing for 30s and pass every lint. This adds the **storyboarder's
visual-variety budget**: a per-video-type ceiling on uninterrupted static A-roll, a
plan-lint that measures the realized cut against it, a new `scene.motion` punch-in
device, and the editorial guidance + critic dimension that make the storyboarder
spend the budget. Everything is additive, advisory (WARNING-level), fail-safe, and
ruleset-gated — **no FSM edge, no gate, no new/renamed required intent key.**

## Pillar A — the budget + the static-stretch lint (the teeth)

- **Per-video-type `variety_budget`** (`mcp/lib/video-types.js`) — each preset
  carries `variety_budget.max_static_stretch_seconds`: the longest acceptable run
  of uninterrupted static A-roll before a visual beat is due. social-short **10s**,
  general **14s**, long-form **18s**, tutorial **22s**, podcast **24s**; cinematic
  30s but the lint is gated OFF under the montage ruleset (a cinematic hold is
  intentional). `resolveVarietyBudget(preset)` is the resolver — env knobs
  `VOB_VARIETY_BUDGET=off` (disable entirely) and `VOB_VARIETY_MAX_STATIC_SECONDS=n`
  (force the threshold). Merged in `mergePreset` (user presets), surfaced in
  `summarizeActiveVideoType` → `read_state_summary.video_type.variety_budget` and
  in `vob_doctor` (`presetDigest`), and added to `activeLintRules()` so it rides
  into the lint ctx.
- **`PLAN_STATIC_STRETCH`** (`mcp/lib/storyboard-schema.js`, `warnVisualVariety`) —
  WARNING, fail-safe (no budget ⇒ skip), ruleset-gated OFF under montage. It models
  the timeline as **covered vs uncovered intervals in REALIZED (speed/layout-baked)
  master time** (`sceneOutputSeconds`) and warns per uncovered gap longer than the
  budget. The gap model is the point: a beat every ~Ns passes, but **one brief
  title card in a 30s take still fires** (the back half is uncovered) — which a
  per-scene binary "has any device?" check would miss. Runs **per timeline**, so
  each short/segment is judged on its own (fan-out findings carry `short_id` +
  `[short_id]` prefix via the existing tagging).
- **What counts as a "variety beat"** (breaks/covers a static run): a b-roll cutaway
  clip (or a concrete `broll_placements` covering the scene), a `scene.motion`
  punch-in/ken-burns, a multi-cell `scene.layout`, animated `caption_segments`, a
  matted-subject placement, a beat-class typed overlay (title_card / lower_third /
  callout / data_viz / chapter_marker / section_title / cta / end_card /
  kinetic_caption / pip — NOT static furniture: caption_block / logo_bug /
  progress_bar), or an energetic (non cut/dip/fade) `transition_in`. A plain cut
  between two same-framing takes is deliberately **not** variety.

## Pillar B — `scene.motion` (the no-b-roll punch-in device)

- New loose, fail-safe, additive scene field `scene.motion` — an intra-scene camera
  move on the A-roll spine, the variety device that needs **no footage to cut to**.
  A string (`"punch_in"` | `"push_in"` | `"ken_burns"`; `"none"`/`"static"` = opt
  out) OR an object `{ type, scale (1.0–2.0), ease?, start_seconds?, end_seconds? }`.
  Validated like `transition_in` / `target.design`: NOT checked in `validateScene`
  (so it never rejects a save), normalized by `sceneMotionOf`, warned by
  `warnSceneMotion` → `PLAN_MOTION_INVALID` on an off-vocabulary type / out-of-range
  scale. A valid move counts as a variety beat (continuous coverage).
- **Realization** (`references/lint-rules.md`, `agents/composer.md`) — a CSS scale
  `@keyframes` on the scene `<video class="clip">`, scrubbed deterministically by
  hyperframes' native css adapter (NO GSAP), `animation-fill-mode: both` +
  `animation-play-state: paused`, `animation-duration == data-duration`. **DURATION-
  EXACT** — it only repaints frames the scene already owns; the master/scene
  `data-duration` is unchanged, so render-drift verification is untouched (the same
  load-bearing rule as scene transitions). Reuses the video-type's design-system
  motion-preset ease; advisory `data-vob-motion` / `data-vob-motion-scene` QC marker
  (never an error, like transitions). Recipes for punch_in / push_in / ken_burns.

## Pillar C — make the storyboarder spend the budget (the ceiling)

- **`agents/storyboarder.md`** — `scene.motion` documented in the schema-1.2
  extensions; a new **"Visual variety & cutaway rhythm"** craft section (the budget,
  what counts vs a plain cut, the device toolkit, and the **no-b-roll → `scene.motion`
  punch-ins + design-system text-card beats + kinetic captions FIRST** emphasis);
  the rubric reference + self-critique upgraded to **eight** dimensions (a new
  *Visual variety* bullet).
- **`references/editorial-patterns.md`** — a new eighth rubric dimension *Visual
  variety* (after B-roll), a "Visual variety / cutaway rhythm" recipe, the
  `editorial/static_stretch` + `editorial/no_visual_variety` codes, and a per-ruleset
  emphasis note.
- **`agents/editorial-critic.md`** — scores the eighth *Visual variety* dimension
  (how-to-judge + the SCORES output block).
- **`PLAN.md`** — `variety_budget` threaded into the storyboarder AND editorial-critic
  spawns so both ground the static-stretch finding in the actual number.

## Testing / tooling

- **Walker `variety` phase** (`node scripts/m5-walker.js variety`) — a source-free
  unit harness (calls `lintStoryboardPlan` / `validateStoryboardContent` directly):
  long plain run fires; a beat every scene within budget doesn't; the gap-model win
  (one brief beat in a 30s take still fires); device resets (b-roll / motion / layout
  / kinetic caption / concrete placement); ruleset gate (montage off); fail-safes
  (no budget / no lintRules); multiple over-budget stretches; `PLAN_MOTION_INVALID`
  (off-vocab + out-of-range scale); E2E budget threading (social-short fires,
  cinematic gated); E2E fan-out tagging. Model-free permanent regression. 11/11 green.
- Sibling `editorial` + `spans` walker regressions re-run green (no behavior change).
- **Dual-adapter parity** — `port-adapter-docs.js` re-run (storyboarder / composer /
  editorial-critic bodies + editorial-patterns / lint-rules / PLAN ported to
  OpenCode); boot integrity green.

## Files

`mcp/lib/video-types.js` (variety_budget per preset + `resolveVarietyBudget` +
merge/summarize/doctor + montage gate + activeLintRules), `mcp/lib/storyboard-schema.js`
(`SCENE_MOTION_TYPES` + `sceneMotionOf` + `warnVisualVariety` + `warnSceneMotion`,
wired into `lintStoryboardPlan`), `scripts/m5-walker.js` (`variety` phase), the
storyboarder / composer / editorial-critic agents + `editorial-patterns.md` /
`lint-rules.md` / `PLAN.md` (both adapters), `scripts/port-adapter-docs.js` run.

## Guardrails held

Engine produces structure (the budget + the lint codes); the skill/agents own how to
use it. All advisory — no gate, no FSM edge, no new required intent key. Fail-safe
throughout (missing budget / malformed motion / clipless scenes never throw or
reject). Ruleset-gated so montage/cinematic holds are never flagged. The version bump
is the shared v3.9 branch's concern (this work touches no version file).
