# v3.9 — COMPOSE design-system kit

> Namespaced under `docs/v3.9/compose-design-system/` to avoid colliding with a concurrent
> session that owns `docs/v3.9/{PRD,PROGRESS}.md` for a different v3.9 feature. Live tracker:
> `PROGRESS.md` (this dir). Branch: `v3.9/design-system-kit`. Base: main @ 3.8.0 → 3.9.0.

## The problem (the user's "why #1")

The composer turns `target.design` tokens into CSS with only a font kit + per-code fix
recipes + QC guardrails. There is **no opinionated, vetted visual system**, so the default
output reads as "AI slop" unless the LLM happens to have taste that run. Single biggest
"does this look pro?" lever, reusable across every video.

The engine already half-admits the gap: composition QC emits `vob/design_font_partial`
("declares ≥2 type roles but uses only one face — reads as templated AI slop") and
`vob/design_font_mismatch`. We have a *detector* for slop and no *cure*.

## The fix

Build a **per-video-type design system the way the caption kit already works** — vetted
components for titles, lower-thirds, grades, motion, and backdrops — and hand the composer
strong visual references. Raise the floor of its taste so the default is striking, not just
lint-clean.

## Approach — clone the caption-kit mechanism, author the content first-party

Clone the proven caption-kit MECHANISM (`mcp/assets/captions/` + `scripts/build-captions.js`
+ `injectCaptionKit` + composer-reads-`manifest.json`); author the CONTENT first-party.

**Decision: first-party, pure-CSS, token-parameterized components.** Investigation (5 parallel
agents) found hyperframes' registry has no neutral title/lower-third/grade/motion primitives —
only platform-branded social cards and proprietary gated-off shader transitions — and its GSAP
blocks DON'T animate at render (`window.__timelines` is a no-op stub; v3.3 transitions are
pure-CSS for this reason). First-party authoring guarantees render, sidesteps the hyperframes
redistribution-license question, and gives full taste control while reading `target.design`.

### Render contract (verified on hyperframes 0.6.112)
1. Pure CSS `@keyframes`, never GSAP — the css adapter scrubs a `paused` animation via
   `animation-delay = -(T − data-start)`; keep `animation-fill-mode: both` + `animation-play-state: paused`.
2. Stagger with `data-start`, NEVER `animation-delay` (runtime hijacks it); each staggered piece is
   its own `class="clip"` element; `animation-duration == data-duration`.
3. Inert `window.__timelines["<id>"] = {duration:()=>N, pause:()=>{}}` per composition.
4. Fonts: auto-resolved concrete kit families, no font `<link>` (lint scope + var() limits). Composer
   substitutes per `target.design.typography` and loads `./fonts.css` for house faces — unchanged contract.
5. Colors/safe-areas via `--vob-*` tokens with literal fallback; composer sets them once from `target.design`.
6. Standard composition-QC: timed = `class="clip"` + id + data-start/duration/track-index (≥1, distinct
   per overlap); no `<video>` in design components; determinism; no big emoji >80px.

## Architecture (surfaces)
- `mcp/assets/design-system/` — `<name>/<name>.html` reference components (flat), `tokens.css`, generated `manifest.json`/`README.md`/`LICENSES.md`.
- `scripts/build-design-system.js` — source of truth; **lints every component** (the "vetted" guarantee — fails the build on any error), detects metadata, writes manifest (per-video-type look bundles + per-component meta)/README/LICENSES. `--manifest-only`/`--skip-lint`/`--snapshot`.
- `mcp/lib/source-symlink.js` — `injectDesignKit()` clone of `injectCaptionKit`. **DONE.**
- `mcp/lib/tools/save-composition.js` — call it; stamp `state.composition.design_system:{linked}`. **DONE.**
- `composer.md` — new "Design system kit" section (read manifest → set tokens → adapt look components → apply grade/motion).
- `COMPOSE.md` — thread `video_type` + `design_default` into the data-only spawn.
- `lint-rules.md` — per-kind recipes (title/lower-third/grade/motion/backdrop).
- `video-types.js` — OPTIONAL `design_default` enrichment, DEFERRED (shared with concurrent session).
- `scripts/m5-walker.js` — `design` phase. `mcp/server.js`+`package.json` → 3.9.0 at merge. OpenCode mirror via `port-adapter-docs.js`.

Manifest keyed by canonical video-type → composer maps `summary.video_type.canonical` → look bundle;
unknown → `general`. No new tool/permission/role-bundle/schema/FSM edge. Degrade-don't-die.

## Component inventory (~22, all pure-CSS, token-driven, lint-clean)
- **titles**: `title-bold-slam` ✅, `title-clean-kicker`, `title-editorial-serif`, `title-quote-card`, `title-kinetic-stack`.
- **lower-thirds**: `lower-third-bold-bar`, `lower-third-accent-edge`, `lower-third-serif-minimal`, `lower-third-name-role`, `lower-third-pill`.
- **grades** (full-frame CSS filter/overlay): `grade-punch`, `grade-teal-orange`, `grade-film-desat`, `grade-warm`, `grade-cool`, `grade-clean`, `grade-bw`.
- **motion** (demo + documented eases): `motion-fast-snap`, `motion-medium-soft`, `motion-slow-cinematic`.
- **backdrops** (design-token backgrounds): `backdrop-spotlight`, `backdrop-gradient-sweep`, `backdrop-film-bars`, `backdrop-grid`, `backdrop-soft-studio`.
- **furniture**: `callout-arrow-pill`, `callout-number-step`, `end-card-cta`.

Grades realize `target.design.grade`; motion realizes `target.design.motion`; titles/lower-thirds/
callouts/end-cards realize the corresponding `OVERLAY_TYPES`. The kit is the per-look VISUAL
REALIZATION of what the plan already declares.

## Out of scope
Scene transitions (v3.3 owns them; kit only curates per-look guidance), LUT/3D grading (none in
hyperframes; grades are CSS filters), shaders (proprietary/gated), new required intent keys/FSM edges/
tools/schema versions.

## Verification
Build-time lint per component; `--snapshot` a representative set; walker `design` phase; re-run
`captions`/`layout`/`compose` walkers for no regression; adversarial subagent review before finalize.
