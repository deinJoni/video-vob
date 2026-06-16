# PRD 02 — Scene Transitions in COMPOSE

**One-line summary:** Promote bob's scene-join vocabulary from `cut` + a single ffmpeg dip-to-black `fade` to a typed, planned, ruleset-gated **intra-composition transition layer** (CSS by default, hyperframes WebGL shader transitions on roomy hosts), realized by the composer and verified to stay duration-exact.

**Status:** Proposed
**Version target:** v3.3 (additive on the v3.2 / 3.2.0 baseline)
**Siblings:** [`01-caption-system-v2.md`](./01-caption-system-v2.md) (caption kit + text measurement), [`03-subject-compositing.md`](./03-subject-compositing.md) (`remove-background`). This PRD is independent of both and can ship in any order.

---

## 1. Problem / motivation

Scene-to-scene motion is a large fraction of perceived production value, and bob expresses almost none of it. Today the entire transition vocabulary is:

- **`cut`** (the default) — a hard scene boundary.
- **`fade`** — realized two different ways depending on where the boundary lands:
  - *Intra-composition* (between two scenes in the same render chunk): the composer hand-rolls "a short opacity ramp on the scene clip" (`adapters/claude-code/.claude/agents/composer.md:191`).
  - *Cross-segment seam* (between two separately-rendered chunks): `vob_assemble_video` inserts a duration-preserving **0.25s dip-to-black** at the join (deliberately **not** xfade — overlap would shorten the total and poison drift verification; see CLAUDE.md, the segmented-render invariant).

The storyboarder is explicitly told to stay conservative: *"`transition_in` / `transition_out`: `cut` (default) or `fade` — nothing else renders reliably on the reference host; use `fade` at most twice per video"* (`adapters/claude-code/.claude/agents/storyboarder.md:130`). That caution was correct when the only tool was a hand-rolled opacity ramp.

Meanwhile hyperframes (v0.6.97) ships a **deep transition catalog** — CSS (push/slide, zoom, iris, clock-wipe, shutter, blur-crossfade, glitch, VHS, light-leak…) plus WebGL **shader transitions** (`@hyperframes/shader-transitions`: SDF iris, domain warp, glitch, chromatic split, cross-warp morph, swirl vortex, light leak, thermal distortion) — and they are **mixable within one composition**. We render every composition through hyperframes already; we are leaving this entirely on the table.

The constraint that has kept us conservative is real and must be preserved: **rich transitions only exist inside a single composition.** bob renders one composition per render-segment / short and concatenates with ffmpeg, where the only safe joins are stream-copy `cut` and the duration-preserving dip-to-black. This PRD unlocks the rich catalog **where it is safe** (intra-composition) and leaves cross-chunk seams exactly as they are.

## 2. Goals

1. A **typed transition vocabulary** (`video-types.js`, alongside `OVERLAY_TYPES`) that the storyboarder may plan per scene via the existing `scene.transition_in` field, **ruleset-gated** per preset (punchy for `retention`/`montage`, restrained for `chaptered`/`cinematic`).
2. **Plan-lint** warnings (never blockers) that keep transitions tasteful and host-appropriate: too-long, inconsistent, over-budget for the host.
3. **Render-plan boundary avoidance** — `deriveRenderPlan` must never place a render-chunk boundary in the middle of a planned non-cut transition, so the transition always renders inside one composition.
4. **Host-aware degradation** — shader transitions only on hosts that can run them; CSS transitions everywhere; absent/unknown ⇒ hard cut (fail-safe).
5. **Composer recipes** (CSS + shader) in the adapter docs that are deterministic and lint-clean.
6. **Duration-exactness preserved** — a transition is a visual treatment over *already-budgeted* scene frames; render/assembly drift verification (`render-verify.js`, `assemble.js`) is untouched.
7. **Zero new engine dependency** — CSS needs nothing; the shader lib (if used) is vendored into `mcp/assets/` and loaded *in the composition*, never `require()`d by the engine (the font-kit model).

## 3. Non-goals

- **Cross-segment xfade.** Seams stay `cut` (stream copy) or `fade` (0.25s dip-to-black). Never overlap-join two chunks. This is load-bearing for drift verification.
- **A hard composer binding** (the `data-vob-overlay-id` model). Transitions are **advisory** at COMPOSE-QC — the composer may realize a "whip pan" however it likes. (Mirrors the v3.2 caption stance: planned, surfaced, not hard-bound.)
- **Audio-reactive / beat-synced transitions.** Adjacent future work (see §12).
- **Animating the source footage itself** (speed ramps, etc.) — that is `source_clips[].speed`, already shipped.
- **New transition rendering machinery in the engine.** All motion runs in the browser hyperframes drives; the engine only plans, gates, chunks, and lints.

## 4. Current state (files & mechanisms)

| Concern | Where | Notes |
|---|---|---|
| Schema field | `mcp/lib/storyboard-schema.js` | `scene.transition_in` / `transition_out` already validated; today's accepted values are `"cut"` / `"fade"`. Plan-lint lives here too (imported by `save-storyboard.js`); ruleset gating threads in from `video-types.js::activeLintRules`. |
| Plan-lint host | `mcp/lib/tools/save-storyboard.js` | Runs plan lint on every save; errors reject, warnings ride into `plan_lint` + state + `storyboard.md`. Per-short in fan-out. |
| Markdown render | `mcp/lib/storyboard-markdown.js:94` | Already prints `in: <transition>` when `transition_in !== "cut"`. |
| Vocabulary + rulesets | `mcp/lib/video-types.js` | `OVERLAY_TYPES` (the model to copy), `LINT_RULESETS` (`retention`/`chaptered`/`montage`/`general` with `disabled_rules` + `chapter_rules`), `BUILT_IN_VIDEO_TYPES` presets (each with `overlay_vocabulary` + `design_default`), `mergePreset`, `activeLintRules(state)`. |
| Render chunking | `mcp/lib/render-segments.js::deriveRenderPlan` | `chunkScenesToBudget(scenes, budget)` greedily packs scenes by `sceneVideoCount` into chunks ≤ `hostProfile.videoBudget()`; respects narrative `segments[]` boundaries; `chunkRow` already carries a per-chunk `transition_out` (`"cut"` default) used as the **seam type** at assembly. |
| Seam join | `mcp/lib/assemble.js` (`vob_assemble_video`) | Lossless concat-demuxer stream copy for `cut` seams; duration-preserving 0.25s dip-to-black for `fade` seams; ffprobe-verifies the join total. |
| Host capacity | `mcp/lib/host-profile.js` | Single resolver; `CAPACITY_TIERS` (`low`/`medium`/`high`), `videoBudget()`, `LOW_RAM_BYTES = 10·GiB`, precedence `env > host.json field > capacity tier > RAM default`. `vob_doctor` reports each effective value + source under `report.tuning`. |
| Composer contract | `adapters/claude-code/.claude/agents/composer.md` (+ OpenCode mirror) | Uses GSAP timelines registered on `window.__timelines[id]` with `{paused:true}`; "Do NOT load external resources at render time (no scripts)"; implements `fade` as an opacity ramp. |
| Composer fix recipes | `adapters/claude-code/.claude/skills/vob/references/lint-rules.md` | Per-code HTML/CSS recipes (read on a save verdict / retry). |
| Composition QC | `mcp/lib/composition-qc.js` (`vob/*` codes) | Where an advisory `vob/transition_not_realized` would live. |
| Integration test | `scripts/m5-walker.js` | Phase-dispatched by `process.argv[2]`; `bootProject` helper (~L932) takes a project INGEST→PLAN; v3 phases `general`/`longform`/`overlays`/`gaps`; `longform` does REAL segmented renders + `assemble_video` with `render_plan` asserts. |

**Discovery that shapes the design:** the schema field already exists; this PRD *widens its accepted values and gives it a richer realization*, rather than introducing a new field. And `scene.transition_in` and `scene.transition_out` are reconciled into **two distinct roles** (§7.3).

## 5. hyperframes capabilities leveraged (v0.6.97)

- **CSS transitions** — opacity / transform / `clip-path` / filter ramps on scene containers, driven by the GSAP timeline bob already uses. **No external library.** Works under software GL (SwiftShader) on the low-RAM Mac.
- **Shader transitions** — `@hyperframes/shader-transitions` (WebGL, pixel-per-pixel): SDF iris, domain warp, glitch, chromatic split, cross-warp morph, swirl vortex, light leak, thermal distortion. CSS and shader transitions mix in one composition.
- **`--page-side-compositing`** (render flag, default `true`) — runs shader transitions on a page-side WebGL canvas, ~6× faster for SDR; **auto-disables for HDR/alpha/video**. Relevant because our scenes *are* `<video>` — see §10 (open question on whether page-side compositing engages at all for video scenes).
- **The full 106-rule lint** we already run (`vob_lint_composition` / save-time lint) includes the determinism rules transitions must obey: `gsap_exit_missing_hard_kill`, `scene_layer_missing_visibility_kill`, `overlapping_gsap_tweens`, `gsap_css_transform_conflict`. **We rely on these instead of re-implementing determinism checks.**
- **Component registry** (`hyperframes add <name>`) ships transition/effect blocks; the composer *may* pull from it, but the engine must not depend on registry availability (offline + pinned posture).

**Crucial provisioning fact:** `@hyperframes/shader-transitions` is **not present in the installed npm package** (`ls node_modules/@hyperframes/` is empty; the SKILL.md points at monorepo `packages/shader-transitions/` source). So shader transitions are **not available by default** — bob must vendor them (§7.5) or run CSS-only. GSAP itself is used as a global today and is **not vendored in bob's repo** nor bundled in hyperframes `dist/` — exactly how it reaches the render page is the **Phase 0 spike** (§8, §10).

## 6. The duration-exactness rule (load-bearing)

A transition is a **visual treatment painted over frames the scenes already own** — never appended time. The outgoing scene animates out during the **tail** of its existing `target_duration_seconds`; the incoming scene animates in during its **head**. The composition's master `data-duration` (= Σ `target_duration_seconds`) is unchanged.

This is the intra-composition analog of the assembly's "NOT xfade" rule, and it keeps `render-verify.js` / `assemble.js` ffprobe drift checks valid with no change. **A transition must not lengthen or shorten the timeline.** Plan-lint enforces taste (`PLAN_TRANSITION_TOO_LONG`); the composer recipe enforces the mechanism (overlap within existing windows, hard-kill at the boundary).

## 7. Proposed design

### 7.1 Schema (`storyboard-schema.js`) — widen `transition_in`, additive & non-version-gated

Like the v3.2 caption/design/pacing fields, this is validated **unconditionally** (any schema version; no version gate, no `v13` flag). `transition_in` accepts either:

- a **string** in the active transition vocabulary (`"cut"`, `"crossfade"`, `"whip_pan"`, …) — `"cut"` and absence are identical (hard cut); or
- an **object** for control:

```jsonc
"transition_in": {
  "type": "whip_pan",        // must be in TRANSITION_TYPES; unknown ⇒ warn + treat as cut
  "duration_seconds": 0.4,   // carved from adjacent windows; default per-type
  "direction": "left",       // optional, type-specific (left/right/up/down)
  "intensity": "medium"      // optional, type-specific (subtle/medium/strong)
}
```

Validation is **loose and fail-safe** (mirrors `target.design`): wrong-typed ⇒ warn and fall back to `cut`; never reject the save on a transition field. Scene-0 (first scene of a timeline) ignores `transition_in` (nothing to transition *from*) — plan-lint emits an info-level note, not a warning.

### 7.2 Vocabulary + ruleset gating (`video-types.js`)

Add `TRANSITION_TYPES` (frozen, the full set) next to `OVERLAY_TYPES`, and a per-preset `transition_vocabulary` (the offered subset, exactly like `overlay_vocabulary`):

```js
const TRANSITION_TYPES = Object.freeze([
  "cut", "dip",            // dip-to-black (seam-expressible)
  "crossfade", "blur_dissolve", "focus_pull",   // dissolve family (CSS, gentle)
  "push", "slide", "zoom_punch", "whip_pan",     // kinetic (CSS)
  "iris", "clock_wipe", "shutter",               // reveal (CSS)
  "glitch", "light_leak", "chromatic", "cross_warp", "swirl", // shader family
]);
const SHADER_TRANSITIONS = Object.freeze(["glitch","light_leak","chromatic","cross_warp","swirl"]);
```

Per preset (sketch — punchy vs restrained, following the `design_default`/`overlay_vocabulary` pattern):

| Preset | `lint_ruleset` | `transition_vocabulary` (illustrative) |
|---|---|---|
| `social-short` | retention | `cut, crossfade, whip_pan, zoom_punch, glitch, push` |
| `cinematic` | montage | `cut, dip, crossfade, focus_pull, light_leak, cross_warp` |
| `long-form` / `tutorial` / `podcast` | chaptered | `cut, dip, crossfade` |
| `general` | general | `cut, crossfade, dip` (conservative) |

`mergePreset` learns `transition_vocabulary` exactly as it handles `overlay_vocabulary` (array replaces wholesale, filtered to `TRANSITION_TYPES`), so `.vob-config/video-types.json` user presets can override it. `activeLintRules(state)` already exposes the ruleset; transition lints read `transition_vocabulary` off the resolved preset (add it to `summarizeActiveVideoType` + the `vob_doctor` per-project block).

### 7.3 Reconciling `transition_in` vs `transition_out`

Both fields exist today and the composer treats them symmetrically. This PRD gives them **distinct roles**:

- **`transition_in`** — the **rich, intra-composition** transition INTO this scene (full `transition_vocabulary`). This is the field the storyboarder plans against going forward.
- **`transition_out`** — **seam-only**, restricted to `{cut, dip/fade}`. It already feeds `chunkRow.transition_out` → the assembly seam. Keep it for: (a) the last scene of a render chunk (its exit at the join), (b) backward compatibility (existing `transition_out:"fade"` storyboards keep dipping). A non-seam-expressible value on `transition_out` is downgraded to `fade` with a warning.

When a join is described by *both* (scene[i-1].transition_out and scene[i].transition_in) **inside one chunk**, `transition_in` wins (it's the richer descriptor); `transition_out` only governs **chunk-exit seams**. Documented in both agent .md files.

### 7.4 Render-plan boundary avoidance (`render-segments.js`)

A non-cut `transition_in` on scene *i* is a **glue constraint**: scenes *i-1* and *i* must land in the same render chunk (the transition renders between them in one composition). Replace the flat greedy pack with **glue-group packing**:

```js
// 1. Partition scenes into glue groups: maximal runs joined by non-cut transition_in.
//    group cost = Σ sceneVideoCount(scene) over members.
function glueGroups(scenes) {
  const groups = [];
  for (const scene of scenes) {
    const glued = groups.length > 0 && isNonCutTransition(scene.transition_in);
    if (glued) groups[groups.length - 1].push(scene);
    else groups.push([scene]);
  }
  return groups;
}
// 2. Greedy-pack GROUPS (not scenes) into chunks by videoBudget().
// 3. If one group's cost > videoHardCap(): it cannot render in a single composition.
//    Split at the cheapest internal boundary, DOWNGRADE that transition to a seam:
//      dissolve-family (crossfade/dip/blur) -> seam "fade" (dip-to-black);
//      everything else                      -> seam "cut";
//    emit PLAN_TRANSITION_DOWNGRADED (warn) naming the scene + reason.
```

`sceneVideoCount` already counts PiP overlays toward the budget, so a glue group with PiPs is costed correctly. The per-chunk `transition_out` stays the seam type; the assembly path is untouched (still only `cut`/`fade`). Single-mode and fan-out are unaffected (fan-out shorts are always `single`; intra-short transitions just render inside the one composition).

### 7.5 Host gating + the shader-transitions vendor (`host-profile.js` + `mcp/assets/`)

**CSS transitions: always allowed** (no library, software-GL-safe). **Shader transitions: gated.** Add to `host-profile.js`:

```js
// VOB_SHADER_TRANSITIONS env > host.json shader_transitions > capacity tier > RAM default
//   low tier / <10GB RAM  -> false (CSS only)
//   medium/high           -> true
function shaderTransitionsAllowed() { /* same precedence shape as renderWorkers() */ }
```

Report it in `vob_doctor report.tuning` with its source (like `video_budget`, `browser_gpu`). When a shader transition is planned but `shaderTransitionsAllowed()` is false, plan-lint warns `PLAN_TRANSITION_BUDGET` and the composer is instructed to substitute the nearest CSS transition (e.g. `glitch`→`whip_pan`, `cross_warp`→`crossfade`).

**Vendoring** (only needed for the shader path; mirrors the font kit precisely):

- A build script `scripts/build-shader-transitions.js` produces a single pinned, offline **IIFE/UMD** bundle at `mcp/assets/shader-transitions/shader-transitions.min.js` (+ `LICENSES.md`), the source-of-truth model used by `scripts/build-fonts.js`.
- `source-symlink.js` grows `injectTransitionLib(composeRoot)` — a near-clone of `injectFontKit`: symlink `compose/vendor/shader-transitions` → `mcp/assets/shader-transitions` and (optionally) copy a tiny loader. Called from the same place `injectFontKit` is, on every `save_composition`. Graceful when absent (warn + CSS-only).
- The composer references it with a **local** `<script src="./vendor/shader-transitions/shader-transitions.min.js">` — satisfying "no external resources at render time" exactly like `./fonts.css`. **The engine never `require()`s it; `package.json` dependencies stays empty.**

> The shader path can be deferred to a fast-follow: ship Phases 1–3 (CSS transitions, the bulk of the value) first; gate `SHADER_TRANSITIONS` out of every preset's `transition_vocabulary` until Phase 4 vendors the lib.

### 7.6 Plan-lint warnings (ruleset-gated, never block)

Emitted by the plan-lint in `storyboard-schema.js` / surfaced via `save-storyboard.js`, all **warnings**:

| Code | Fires when | Gating |
|---|---|---|
| `PLAN_TRANSITION_UNKNOWN_TYPE` | `transition_in.type` ∉ active `transition_vocabulary` | all rulesets; fail-safe → treated as `cut` |
| `PLAN_TRANSITION_TOO_LONG` | `duration_seconds` > 0.5 × the shorter adjacent scene's duration | all |
| `PLAN_TRANSITION_INCONSISTENT` | > 3 distinct transition types in one timeline | all **except** `montage` (variety is the point) — gate via `LINT_RULESETS[...].disabled_rules` |
| `PLAN_TRANSITION_BUDGET` | a `SHADER_TRANSITIONS` type planned while `shaderTransitionsAllowed()` is false | all |
| `PLAN_TRANSITION_DOWNGRADED` | a glue group exceeded the hard cap and a transition was forced to a seam (§7.4) | all |

These follow the existing `PLAN_*` finding shape (code + message + severity + `short_id` tag in fan-out) and ride into `plan_lint` / state / `storyboard.md` for the plan gate. None block sign-off — taste, not safety. (Safety/determinism is hyperframes' lint, §5.)

### 7.7 Composition QC (`composition-qc.js`) — advisory only

Add a single advisory `vob/transition_not_realized` **WARNING**: a non-cut `transition_in` was planned but the composition shows no corresponding treatment at that boundary. Detection is best-effort and soft — suggested convention is a `data-vob-transition="<type>"` attribute on the transition element so QC can confirm, but **absence is a warning, never an error** (unlike the `vob/overlay_missing_element` hard binding). This matches the v3.2 "captions stay advisory at COMPOSE-QC" stance: the composer may realize a transition in ways QC can't statically prove.

### 7.8 Adapter recipes (`composer.md` + `lint-rules.md`)

- **`composer.md`**: replace the "Do NOT add transitions" blanket (L348) with "realize `scene.transition_in` from the active `transition_vocabulary` (passed in the spawn); keep `transition_out` as a seam-level dip only." Add the duration rule (§6): animate over existing windows, never append time; hard-kill at the boundary.
- **`lint-rules.md`**: per-family recipes —
  - *CSS dissolve* (`crossfade`/`blur_dissolve`/`focus_pull`): GSAP opacity/filter tween on the incoming scene over the outgoing scene's tail; `tl.set(out, {opacity:0, visibility:"hidden"})` hard-kill (satisfies `gsap_exit_missing_hard_kill`).
  - *CSS kinetic* (`push`/`slide`/`whip_pan`/`zoom_punch`): single `x`/`scale` tween per element (never stack two transform tweens — `gsap_css_transform_conflict`); use `tl.fromTo`.
  - *CSS reveal* (`iris`/`clock_wipe`/`shutter`): animate `clip-path` on the incoming scene.
  - *Shader* (gated): the `./vendor/shader-transitions` script-include + the documented init/seek call, registered on the same paused timeline; note `--page-side-compositing` and the software-GL caveat.
- The **spawn prompt** to the composer gains the resolved `transition_vocabulary` + `shaderTransitionsAllowed` (data-only, per the "spawn prompts are data-only" invariant).

## 8. Implementation plan (phased commits)

- **Phase 0 — spike (no code):** Confirm (a) exactly how GSAP reaches a bob composition today (hyperframes-injected global? composer-emitted local script? — resolves the §10 open question), and (b) that `@hyperframes/shader-transitions` builds to a standalone offline IIFE and is license-clear to redistribute. Append findings to this PRD. **Decision gate:** ship CSS-only (Phases 1–3) regardless; greenlight Phase 4 only if (b) passes.
- **Phase 1 — schema + plan-lint (engine-only).** Widen `transition_in` (string|object, fail-safe) in `storyboard-schema.js`; add `TRANSITION_TYPES`/`SHADER_TRANSITIONS`/`transition_vocabulary` + `mergePreset` support in `video-types.js`; add the `PLAN_TRANSITION_*` lints (ruleset-gated); `storyboard-markdown.js` already renders `transition_in`. No render change. *Walker assert: lints fire and clear.*
- **Phase 2 — render-plan boundary avoidance.** Glue-group packing + seam-downgrade in `render-segments.js`; `shaderTransitionsAllowed()` + `report.tuning` in `host-profile.js`; stamp nothing new into `render_plan` beyond what `chunkRow` already carries. *Walker assert: glued scenes never split; forced seam downgrades correctly.*
- **Phase 3 — adapter recipes (CSS).** `composer.md` + `lint-rules.md` CSS recipes; spawn-prompt plumbing for `transition_vocabulary`. Run `scripts/port-adapter-docs.js` to regenerate the OpenCode mirror. **End of Phase 3 = shippable: CSS transitions on every host.**
- **Phase 4 — shader transitions (gated, optional fast-follow).** `scripts/build-shader-transitions.js` → `mcp/assets/shader-transitions/`; `injectTransitionLib` in `source-symlink.js`; composer shader recipe; un-gate `SHADER_TRANSITIONS` in roomy presets. Update NOTICE + `LICENSES.md`.
- **Phase 5 — QC advisory + the walker phase.** `vob/transition_not_realized` in `composition-qc.js`; new `scripts/m5-walker.js` `transitions` phase (§9). Update CLAUDE.md invariant + the `m5-walker.js` phase list comment.

Each phase is a self-contained commit; Phases 1–2 are pure engine + walker-verifiable without a render.

## 9. Testing & verification

**New walker phase: `node scripts/m5-walker.js transitions`** (boots via `bootProject`, like `longform`). Fixture: a single-timeline storyboard whose scenes split into **two render chunks** under a deliberately low `VOB_VIDEO_BUDGET`, such that:

- Scenes **A→B→C** are glued by non-cut `transition_in` (B = `crossfade` CSS, C = `whip_pan` CSS; on a roomy host swap C for a shader type to exercise Phase 4) and must land in **one chunk**.
- Scene **D** starts a second chunk; the A–B–C chunk's `transition_out` is a seam `fade`.

**Asserts:**
1. `deriveRenderPlan` keeps `{A,B,C}` in one chunk — **no boundary inside the glued run** — and D in the next (boundary avoidance).
2. The inter-chunk seam type is `fade`; intra-chunk transitions are *not* seams.
3. `PLAN_TRANSITION_TOO_LONG` fires for an over-long fixture transition and clears when shortened; `PLAN_TRANSITION_BUDGET` fires when a shader type is planned with `VOB_SHADER_TRANSITIONS=off`.
4. **REAL render** of both chunks + `vob_assemble_video`, then ffprobe: **assembled duration == Σ `target_duration_seconds`** within the existing 0.5s drift tolerance — i.e. transitions added no time and the dip-to-black seam stayed duration-preserving. (This is the single most important assert: it proves §6.)
5. The hyperframes lint (run at save) returns clean — in particular no `gsap_exit_missing_hard_kill` from the transition recipes.

Add `transitions` to the walker's documented phase list (CLAUDE.md command block + the header comment in `m5-walker.js`).

## 10. Risks & open questions

1. **How does GSAP reach a bob composition today? (Phase 0, load-bearing.)** The composer uses `gsap` as a global but bob neither vendors GSAP nor (per its own rules) loads CDN scripts; hyperframes' scaffold uses a CDN tag, and hyperframes `dist/` doesn't bundle GSAP. Either hyperframes injects GSAP into the render page (then shader-transitions, which depends on GSAP, likely "just works" once script-included) **or** the composer already emits a local GSAP script (then we mirror that for shader-transitions). The vendor mechanism (§7.5) must match whatever is true. **Resolve before Phase 4.**
2. **shader-transitions redistribution + bundle size + reproducibility.** It's a HeyGen package; confirm the license permits vendoring into bob, and that the build is pinned/offline (`build-fonts.js` precedent). If it can't be redistributed, ship CSS-only and document the shader add-on as an optional user install.
3. **Shader perf/determinism under software GL on the 8GB Mac.** WebGL shaders under SwiftShader may be slow or render differently; `--page-side-compositing` *auto-disables for video/alpha* — and our scenes are `<video>` — so the 6× SDR speedup may not even engage for us. This is the core reason shader transitions are **host-gated off** on low-RAM; verify on a roomy host before un-gating.
4. **Budget pressure vs. glue.** A long glued run can blow the `<video>` hard cap and force a seam downgrade (handled by §7.4, surfaced by `PLAN_TRANSITION_DOWNGRADED`) — acceptable, but worth watching that auto-segmentation doesn't fragment a montage that *wants* many transitions. Mitigation: `montage` ruleset is exempt from `PLAN_TRANSITION_INCONSISTENT` and tends to single-composition durations.
5. **Determinism of CSS transitions across hyperframes' seek model.** Transitions must attach to the seekable paused timeline (no bare `gsap.to`, no CSS `animation` that isn't seek-adapted) — the hyperframes lint covers this, but the recipes must be written to pass it on the first save.

## 11. Philosophy fit

- **Zero engine dependency.** CSS transitions need nothing new. The shader lib is vendored into `mcp/assets/` and loaded **in the composition** (the browser), never imported by the Node engine — byte-for-byte the font-kit posture. `package.json` `dependencies` stays empty (CLAUDE.md: "The MCP server has zero npm dependencies").
- **Duration-exact assembly preserved.** Transitions paint over existing scene windows; cross-chunk seams stay `cut`/dip-to-black; `render-verify`/`assemble` ffprobe drift checks are untouched (§6). No xfade, ever.
- **Native render on host; latest hyperframes.** No Docker, no cloud; uses the engine we already drive at the version already installed.
- **Output-quality lever, not hygiene.** This makes the videos materially better-looking on the most common path (scene-to-scene within a composition), which is the stated priority.
- **Data, not branches.** Vocabulary + gating live as preset/ruleset data in `video-types.js` (the v3 "presets generalize the format — data, not branches" invariant), extensible via `.vob-config/video-types.json`.

## 12. Out of scope / future

- **Cross-segment xfade** — permanently out (drift verification).
- **Audio-reactive / beat-synced transitions** — a natural sibling: bob already computes `energy_rms_db` per segment at INSPECT and hyperframes supports audio-reactive animation from pre-extracted bands. A future "montage / music-video" preset could place cuts and transition intensity on detected beats. Worth its own PRD.
- **Transition presets in `--like` inheritance** — once `transition_vocabulary` + a per-project chosen palette of transitions exist, `--like` could copy the transition language alongside the look (it already copies `target.design`). Small follow-up.
- **A richer QC binding** — if advisory `vob/transition_not_realized` proves too weak in practice, consider promoting `data-vob-transition` to a soft-required marker (still not error-severity).
