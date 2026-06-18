# v3.9 — COMPOSE design-system kit — CHANGELOG

Branch: `v3.9/design-system-kit` (off main @ 3.8.0). NOT merged, NOT yet live-tested.
Docs namespaced here because a concurrent `/loop` session owns `docs/v3.9/{PRD,PROGRESS}.md` for a
different v3.9 feature (storyboarder editorial pass).

## What shipped

A first-party, vetted, **per-video-type DESIGN SYSTEM** the composer adapts — raising the COMPOSE
taste floor so the default look is striking, not "lint-clean AI slop". Mirrors the caption-kit
mechanism (build script → manifest → symlink-into-`compose/` → composer-reads-and-adapts); the content
is first-party (hyperframes' registry has no neutral title/lower-third/grade primitives, and its GSAP
blocks don't render here — `window.__timelines` is a no-op stub).

### New
- **`mcp/assets/design-system/`** — **28 PURE-CSS, token-parameterized REFERENCE components**, all
  lint-clean (build-verified) + render-verified: 5 titles, 5 lower-thirds, 7 grades, 3 motion presets,
  3 furniture (callout×2, end-card), 5 backdrops. Plus `tokens.css` (the `--vob-*` token contract) and
  generated `manifest.json` / `README.md` / `LICENSES.md`.
- **Per-video-type LOOK BUNDLES** (manifest `video_types` map): `social-short` / `long-form` /
  `cinematic` / `tutorial` / `podcast` / `general`, each with `principles[]` (taste guardrails handed
  to the composer) + the recommended component per role (title / lower_third / grade / motion /
  backdrop / callout / end_card) + transition guidance.
- **`scripts/build-design-system.js`** — source of truth. Lints EVERY component (`hyperframes lint`,
  fails the build on any error = the "vetted" guarantee, stronger than the caption kit which
  self-lints none), detects metadata (fonts / tokens / dims / pure-css), writes manifest/README/
  LICENSES. Modes: default (lint+build), `--manifest-only` (docs only, preserves prior lint verdict),
  `--skip-lint`, `--snapshot`.
- **`injectDesignKit()`** (`mcp/lib/source-symlink.js`) — symlinks `compose/design-system` on every
  save (clone of `injectCaptionKit`: degrade-don't-die, composer-supplied-dir wins, idempotent). Wired
  into `save-composition.js`; stamps `state.composition.design_system:{linked}` + returns
  `design_system_linked`.
- **Composer wiring**: `composer.md` §"Design system kit" (read manifest → set `--vob-*` tokens from
  `target.design` once → adapt the video_type look's components → apply the grade `filter:` on the
  scene `<video>` + overlays → reuse the motion preset eases → substitute fonts → STAGGER VIA
  `data-start`, NOT `animation-delay`). `COMPOSE.md` threads `video_type` + `design_system` into the
  (data-only) composer spawn. `lint-rules.md` §Design system kit (per-kind recipes + the 3 render gotchas).

### Render contract (verified on hyperframes 0.6.112)
Pure CSS `@keyframes` scrubbed by the css adapter (`animation-delay = -(T − data-start)`); `fill-mode:
both` + `play-state: paused`; stagger via separate `class="clip"` `data-start` elements (NOT
`animation-delay`); concrete AUTO-RESOLVED kit fonts in references (the composer substitutes per
`target.design.typography` + loads `./fonts.css` for house faces); colors `var(--vob-*, fallback)`;
inert `window.__timelines` stub; no GSAP / `<video>` / network.

### Scope
NO new tool / permission / role-bundle / FSM edge / schema version / QC code. Degrade-don't-die like
fonts/captions (absent kit → composer authors unaided).

## Verification
- All 28 components lint **0/0** (build-verified; the build fails on any error).
- **12 components render-verified** via `hyperframes snapshot` across social / general / cinematic /
  podcast looks and every kind → consistently pro, NOT slop. Contact sheets sent to the user.
- `injectDesignKit` functionally tested (present / idempotent / skip / composer-real-dir / dangling
  re-link); engine boots clean; `node --check` passes on the touched engine + build files.
- **Adversarial review** (subagent): NO blockers, NO majors. 5 minor findings fixed + re-verified:
  `--manifest-only` lint-verdict preservation; `fonts` metadata filtered to real kit families;
  `--skip-lint` documented; `tokens.css` font-token contradiction reworded; `design_system_linked`
  added to the save return.

## Deferred to merge / finalization (shared-file or merge-time — avoided churning the concurrent tree)
- `mcp/lib/video-types.js` `design_default` palette/typography ENRICHMENT — OPTIONAL (the manifest is
  keyed by canonical video-type, so no `video-types.js` change is needed for the kit to function).
- Version bump `package.json` + `mcp/server.js` → 3.9.0.
- OpenCode port — the concurrent session's `port-adapter-docs.js` run ALREADY synced my
  composer.md / COMPOSE.md / lint-rules.md edits into the OpenCode mirror (verified present); re-run +
  diff at merge to confirm completeness.
- Walker `design` phase (project convention) — DEPRIORITIZED per the output-over-hygiene preference,
  `scripts/m5-walker.js` being a shared file, and the walker needing a real `VOB_WALKER_SOURCE`. The
  feature is verified by build-lint + render + functional + review instead. Recommended follow-up.

## Concurrency note
Built in a working tree SHARED with a concurrent `/loop` session (a different v3.9 feature). Handled by
namespacing docs, keeping code on disjoint files, leaving `video-types.js` untouched, and not committing.
