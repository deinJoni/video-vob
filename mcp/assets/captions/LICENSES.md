# Caption kit provenance & attribution

The caption components under `mcp/assets/captions/` are sourced from the
**hyperframes** registry (`hyperframes add <name>`), generated with hyperframes
`0.6.97`. They are authored by the hyperframes
project and vendored here as **reference** material.

video-vob already depends on and pins the hyperframes CLI (it is the rendering
engine), and these components ship inside that package; vendoring them as
reference keeps the COMPOSE side offline and lint-clean by construction.

> ⚠️ **Open item (PRD 01 R2 — redistribution not yet confirmed).** The installed
> hyperframes package declares **no SPDX `license` field and ships no LICENSE
> file**, so the redistribution terms of these vendored components are
> UNCONFIRMED. They are retained here on the basis that video-vob already bundles
> and pins hyperframes (the same toolchain) and uses them only as composer
> reference. **Confirm redistributability with the hyperframes maintainers before
> publishing this template publicly**; if it cannot be confirmed, the kit can be
> dropped (the COMPOSE side degrades to authoring captions unaided — the engine
> handles an absent kit gracefully).

Re-running `scripts/build-captions.js` re-materializes them from whatever
hyperframes version is installed (pinned in `manifest.json` as
`generated_with_hyperframes`).

Components vendored: `caption-pill-karaoke`, `caption-kinetic-slam`, `caption-weight-shift`, `caption-neon-accent`, `caption-glitch-rgb`, `caption-emoji-pop`, `caption-highlight`, `caption-editorial-emphasis`, `caption-gradient-fill`, `caption-neon-glow`, `caption-clip-wipe`, `caption-matrix-decode`, `caption-particle-burst`, `caption-parallax-layers`, `caption-texture`.
