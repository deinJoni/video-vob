# Design-system kit — provenance & license

The components under `mcp/assets/design-system/` are **first-party, original work**
authored for video-vob — self-contained, pure-CSS reference compositions. They vendor
**no third-party component code** (unlike the caption kit, which is sourced from the
hyperframes registry), so there is no external redistribution question: they ship under
the same license as this repository.

Fonts are referenced **by family name only** (hyperframes' auto-resolved families); no
font binaries are embedded here. The vendored font kit (`mcp/assets/fonts/`) carries its
own OFL/Apache licenses (`mcp/assets/fonts/LICENSES.md`).

Lint-verified against hyperframes `0.6.112` (recorded in
`manifest.json` as `verified_with_hyperframes`). Re-run `node scripts/build-design-system.js`
to re-verify against the installed hyperframes.

Components: `title-bold-slam`, `title-clean-kicker`, `title-editorial-serif`, `title-quote-card`, `title-kinetic-stack`, `lower-third-bold-bar`, `lower-third-accent-edge`, `lower-third-serif-minimal`, `lower-third-name-role`, `lower-third-pill`, `grade-punch`, `grade-teal-orange`, `grade-film-desat`, `grade-warm`, `grade-cool`, `grade-clean`, `grade-bw`, `motion-fast-snap`, `motion-medium-soft`, `motion-slow-cinematic`, `callout-arrow-pill`, `callout-number-step`, `end-card-cta`, `backdrop-spotlight`, `backdrop-gradient-sweep`, `backdrop-film-bars`, `backdrop-grid`, `backdrop-soft-studio`, `caption-pop`, `caption-word-rise`, `cold-open-claim`.
