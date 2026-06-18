# COMPOSE design-system kit — PROGRESS (central tracker)

> **This is the loop's durable state.** On re-entry, read this top section first.
> Namespaced under `docs/v3.9/compose-design-system/` (NOT `docs/v3.9/PRD.md`) because a
> CONCURRENT session owns `docs/v3.9/{PRD,PROGRESS}.md` for a different v3.9 feature
> ("Storyboarder Editorial-Quality Pass", branch `v3.9/storyboarder-quality`). See
> "Concurrency" below.

## CURRENT STATUS
- **✅ FEATURE COMPLETE & VERIFIED — loop STOPPED (satisfied).** 28 vetted pure-CSS components + per-video-type look bundles + build script + injection + composer wiring, all verified (build-lint 0/0 ×28, 12 render-verified across social/general/cinematic/podcast, injection functional-tested, boot clean, adversarial review = no blockers/majors with 5 minor findings fixed). CHANGELOG written (this dir). See CHANGELOG.md for the full ledger.
- **Phase 3 (wire composer) — DONE (claude-code).** `composer.md` §"Design system kit" + `COMPOSE.md` spawn (`video_type` + `design_system`) + `lint-rules.md` §Design system kit. Docs-only → no boot impact.
- **Phase 5 (review + fixes) — DONE.** Adversarial subagent review: 0 blockers / 0 majors. Fixed: `--manifest-only` lint-verdict preservation (footgun), `fonts` metadata filtered to real kit families, `--skip-lint` documented, `tokens.css` font-token contradiction reworded, `design_system_linked` added to save return. All re-verified (build 28-clean, manifest-only preserves, boot clean).
- **Phase 4 (walker `design` phase) — DEPRIORITIZED (not done).** Per the output-over-hygiene preference + `m5-walker.js` is a shared file + the walker needs a real `VOB_WALKER_SOURCE`. The feature is verified via build-lint + render + functional + review instead. Recommended follow-up (project convention).
- **DEFERRED to merge/finalization (shared-file or merge-time):** `video-types.js` `design_default` enrichment (OPTIONAL — kit works without it), version bump `package.json`+`mcp/server.js` → 3.9.0, OpenCode port verify (already synced by the concurrent session's port run — re-run+diff at merge). NOT live-tested (needs a real `/vob` run).
- **Phase 1 (foundation) — DONE & VERIFIED.** Proven exemplar + build script + injection wired + engine boots clean.
- **Phase 2 (author components) — DONE & VERIFIED.** 28 components (5 titles incl. exemplar, 5 lower-thirds, 7 grades, 3 motion, 3 furniture, 5 backdrops) authored via 5 parallel agents, ALL lint-clean (0 errors) + pure-css, wired into `COMPONENTS[]` + `VIDEO_TYPES` (all slots resolve), manifest rebuilt (28 components × 6 video-types, + dims detection). Taste-verified by rendering 6 representatives (title-clean-kicker, title-kinetic-stack, lower-third-accent-edge, grade-teal-orange, backdrop-gradient-sweep, end-card-cta) → all read as intentional pro design, NOT slop. Contact sheets sent to user.
- **NEXT STEP:** Phase 3 — wire the composer:
  1. `adapters/claude-code/.claude/agents/composer.md` — add a "Design system kit" section in/near the Craft section (read `./design-system/manifest.json` → find active `video_type` look → set `--vob-*` tokens from target.design on the comp root → adapt the look's title/lower-third/backdrop components → apply the grade `filter:` to scene videos + overlays → use the motion preset eases). Mirror the caption-kit section's shape.
  2. `adapters/.../phases/COMPOSE.md` — thread `video_type: <summary.video_type.canonical>` + `design_kit: ./design-system/manifest.json present` into the data-only spawn (parallel to the `transition_vocabulary` line).
  3. `adapters/.../references/lint-rules.md` — add a "## Design system kit" section with per-kind usage recipes (title/lower-third/grade/motion/backdrop) + the critical gotchas (pure-CSS scrub, data-start stagger NOT animation-delay, concrete auto-resolved fonts, token-setting).
  4. `scripts/port-adapter-docs.js` → regen OpenCode mirror.
  - (DEFERRED: `video-types.js` design_default enrichment — shared with concurrent session; OPTIONAL.)
- THEN Phase 4 (walker `design` phase + no-regression on captions/layout/compose; snapshot more), Phase 5 (adversarial review + version 3.9.0 + CHANGELOG).
- **Branch:** `v3.9/design-system-kit` (shared HEAD; concurrent session in same tree — user chose CONTINUE-IN-SHARED-TREE: don't touch `video-types.js`, don't commit).

## Goal (from the user)
COMPOSE's composer defaults to generic, templated design ("AI slop") because there's no
opinionated, vetted visual system — only a font kit + fix recipes + QC guardrails. Build a
per-video-type design system the way the caption kit works — vetted components for titles,
lower-thirds, transitions, grades, motion presets — and hand the composer strong visual
references. Raise the floor of its taste. (Single biggest "does this look pro?" lever.)

## Key decisions (with rationale)
1. **Clone the caption-kit MECHANISM, author the CONTENT first-party.** hyperframes' registry
   has no neutral title/lower-third/grade/motion primitives (only platform-branded cards +
   proprietary gated-off shaders), and its GSAP blocks don't render here (`window.__timelines`
   is a no-op stub). First-party authoring → guaranteed render, no license question, full taste control.
2. **Pure CSS `@keyframes`, never GSAP.** hyperframes' css adapter scrubs a `paused` animation via
   `animation-delay = -(T − data-start)`. Matches the proven v3.3 transition path. VERIFIED by snapshot.
3. **Stagger via separate `data-start` elements, NEVER `animation-delay`** (runtime hijacks delay to scrub).
4. **Fonts: concrete AUTO-RESOLVED kit families, no font `<link>`** in references. The lint reads
   `@font-face` only inside the project dir and can't resolve a var()-font → errors. Auto-resolved set
   (probed on 0.6.112): League Gothic, Archivo Black, Oswald, Montserrat, Poppins, Outfit, Open Sans,
   Lato, Roboto, Nunito, Inter, Playfair Display, EB Garamond, JetBrains/IBM Plex/Source Code/Space Mono,
   Noto Sans JP. House faces (Anton, Hanken Grotesk, Noto SC) error standalone → the composer brings them
   via `./fonts.css` at COMPOSE (its existing contract). The composer SUBSTITUTES the family per
   `target.design.typography` regardless, so reference face = cosmetic.
5. **Colors/safe-areas via `--vob-*` tokens with literal fallback** (`var(--vob-accent, #ff3b30)`).
   Composer sets them once on its root from `target.design`; whole kit re-skins. Token contract = `tokens.css`.
6. **Manifest keyed by canonical video-type** → no required `video-types.js` change for the kit to work.
   `design_default` enrichment is OPTIONAL and DEFERRED (video-types.js is touched by the concurrent session).
7. **No new tool / permission / role-bundle / schema / FSM edge** — asset injection + prose contracts only
   (confirmed by the composer-surfaces investigation). Degrade-don't-die like fonts/captions.

## Verified facts (from build + render)
- `title-bold-slam` lints **0/0/0** and the snapshot shows correct scrub (in @0.3s → hold @2.0s w/ accent rule → exit @4.1s). Pattern PROVEN end-to-end.
- `injectDesignKit` symlinks `compose/design-system`, manifest + components + tokens.css readable through it, idempotent, skip-honored, degrade-on-missing. Engine boots clean (no integrity regression).
- hyperframes installed = **0.6.112**; `lint`/`snapshot` operate on a project DIR (need `index.html`).

## Phase checklist
- [x] **Phase 0** — investigate (5 parallel agents: caption-kit mechanism, presets/tokens, composer/lint/QC surfaces, hyperframes capability, docs/version/walker/assets).
- [x] **Phase 1** — foundation:
  - [x] `mcp/assets/design-system/tokens.css` (token contract)
  - [x] exemplar `title-bold-slam/title-bold-slam.html` (pure CSS, token-driven, lint 0/0/0, snapshot-verified)
  - [x] `scripts/build-design-system.js` (lints each component = "vetted" guarantee; detects metadata; writes manifest/README/LICENSES; `--manifest-only`/`--skip-lint`/`--snapshot`; per-video-type look bundles w/ unresolved-slot filtering)
  - [x] `injectDesignKit` in `source-symlink.js` (+ export) + wired into `save-composition.js` + `state.composition.design_system:{linked}`
  - [x] engine boot smoke OK; injection functional test OK
- [ ] **Phase 2** — author components (parallel) + complete look bundles:
  - titles: `title-clean-kicker`, `title-editorial-serif`, `title-quote-card`, `title-kinetic-stack`
  - lower-thirds: `lower-third-bold-bar`, `lower-third-accent-edge`, `lower-third-serif-minimal`, `lower-third-name-role`, `lower-third-pill`
  - grades: `grade-punch`, `grade-teal-orange`, `grade-film-desat`, `grade-warm`, `grade-cool`, `grade-clean`, `grade-bw`
  - motion: `motion-fast-snap`, `motion-medium-soft`, `motion-slow-cinematic`
  - backdrops: `backdrop-spotlight`, `backdrop-gradient-sweep`, `backdrop-film-bars`, `backdrop-grid`, `backdrop-soft-studio`
  - furniture: `callout-arrow-pill`, `callout-number-step`, `end-card-cta`
  - add each to `COMPONENTS[]` in the build script; re-run build → all lint-clean; slots resolve.
- [ ] **Phase 3** — wire composer:
  - `composer.md` — new "Design system kit" section (read manifest → set tokens → adapt look components → apply grade/motion). Mirror the caption-kit section.
  - `COMPOSE.md` — thread `video_type` + `design_default` into the data-only spawn.
  - `lint-rules.md` — per-kind recipes (title/lower-third/grade/motion/backdrop) in the `###`-per-type format.
  - (DEFERRED, shared file) `video-types.js` design_default enrichment — only after the concurrent session's video-types.js settles; OPTIONAL.
  - `scripts/port-adapter-docs.js` → mirror to OpenCode.
- [ ] **Phase 4** — walker `design` phase + run `captions`/`layout`/`compose` for no regression; `--snapshot` a representative set (real render verify).
- [ ] **Phase 5** — adversarial self-review (subagent), fix findings, version → 3.9.0, CHANGELOG, finalize.

## Concurrency (IMPORTANT — surfaced to user)
A concurrent session shares this working tree, working a DIFFERENT v3.9 feature (storyboarder
editorial pass). git shows its uncommitted edits to `storyboarder.md`, `inspect.js`,
`storyboard-schema.js`, `tool-registry.js`, `video-types.js` + `editorial-patterns.md`, and it owns
`docs/v3.9/{PRD,PROGRESS}.md`. Mitigations taken: my docs namespaced here; my code is on disjoint
files; `video-types.js` edit DEFERRED; will NOT commit (would sweep their changes). Awaiting user
decision on isolation (worktree vs shared-careful vs pause). Pre-v3.3 precedent: concurrent sessions
clobbered shared files — hence the caution.

## Component reference pattern (for Phase 2 authors)
Every component: full standalone HTML; `#stage` root with `data-composition-id`/`data-timeline-locked`/
`data-start=0`/`data-duration=N`/`data-fps`/`data-width`/`data-height`; a `.ds-demo-bg` (CSS, stands in
for the video spine — dropped in real comps); timed elements `class="clip"` + id + data-start/duration/
track-index (≥1, distinct per overlap); `animation-*: <name> <dur>s <ease> both; paused`; `@keyframes`
with in→hold→out; colors `var(--vob-*, fallback)`; fonts auto-resolved concrete; inert
`window.__timelines["<id>"]={duration:()=>N,pause:()=>{}}`. Verify: `node scripts/build-design-system.js`
(lints all; fails on any error). See `title-bold-slam` as the canonical exemplar.
