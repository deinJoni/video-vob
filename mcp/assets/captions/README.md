# video-vob caption kit

Built by `scripts/build-captions.js` from the hyperframes registry
(`hyperframes add <name>`), generated with hyperframes `0.6.97`.
**The script is the source of truth; these assets are committed.** Re-run
`node scripts/build-captions.js` to refresh to the installed hyperframes.

Each `<name>/<name>.html` is a self-contained, lint-clean REFERENCE composition.
The composer READS them (the kit is symlinked into `compose/captions/` on every
save, like `./fonts.css`) and ADAPTS the technique — it does **not** copy them
verbatim.

## Required adaptations (the composer's contract)

1. **Fonts:** the references load their face from a `fonts.googleapis.com` `<link>`.
   That trips hyperframes' own `google_fonts_import` lint rule. Use the vendored
   kit instead: load `./fonts.css` and reference the family by name. If the
   component's font is **not** in the kit (see the table), substitute the nearest
   kit family (or extend the font kit — out of scope here).
2. **Animation engine:** the references drive their timeline with GSAP and register
   it at `window.__timelines["<composition-id>"]` — the hyperframes runtime
   contract. Keep that registration.
3. **Binding:** stamp `data-vob-caption-id="<id>"` on the implementing chunk for any
   `caption_segment` that carries an authored `id` (`exact:true` makes it required —
   COMPOSE QC errors otherwise).
4. **Word-level / karaoke:** components flagged `word_level`/`consumes_transcript`
   want a real per-word `[{text,start,end}]` transcript (from the spawn's
   `per_clip_transcripts` → `inspect/transcripts/file_<i>.json`). When
   `transcript_aligned` is false, DOWNGRADE word-by-word/karaoke to chunk-level
   `pop` (mirrors the `PLAN_CAPTION_KARAOKE_UNALIGNED` plan-lint warning).

## animation → component

| animation | default | alternates |
|---|---|---|
| `pop` | `caption-highlight` | `caption-editorial-emphasis`, `caption-gradient-fill`, `caption-neon-glow`, `caption-clip-wipe`, `caption-matrix-decode`, `caption-particle-burst`, `caption-parallax-layers`, `caption-texture` |
| `word-by-word` | `caption-kinetic-slam` | `caption-weight-shift`, `caption-neon-accent`, `caption-glitch-rgb`, `caption-emoji-pop` |
| `karaoke` | `caption-pill-karaoke` | — |

## components

`word-level` = the component animates per word (vs per chunk). It is distinct from
`consumes_transcript` (in `manifest.json`): a word-level component animates words
sequentially and works from chunk text + even spacing, but only `consumes_transcript`
components (e.g. `caption-pill-karaoke`) need a REAL per-word `{start,end}` transcript
to stay in sync — those are the ones to downgrade to `pop` when `transcript_aligned`
is false.

| component | suited for | word-level | font (in kit?) |
|---|---|---|---|
| `caption-pill-karaoke` | karaoke | yes | Poppins (yes) |
| `caption-kinetic-slam` | word-by-word | yes | Anton (yes) |
| `caption-weight-shift` | word-by-word | yes | Montserrat (yes) |
| `caption-neon-accent` | word-by-word | yes | Montserrat (yes) |
| `caption-glitch-rgb` | word-by-word | yes | Space Grotesk (NO — substitute a kit family) |
| `caption-emoji-pop` | word-by-word, pop | yes | Gabarito (NO — substitute a kit family) |
| `caption-highlight` | pop | no | Montserrat (yes) |
| `caption-editorial-emphasis` | pop | no | Inter (yes) |
| `caption-gradient-fill` | pop | no | Montserrat (yes) |
| `caption-neon-glow` | pop | no | Outfit (yes) |
| `caption-clip-wipe` | pop | no | Poppins (yes) |
| `caption-matrix-decode` | pop | no | Space Grotesk (NO — substitute a kit family) |
| `caption-particle-burst` | pop | no | Outfit (yes) |
| `caption-parallax-layers` | pop | no | Instrument Serif (NO — substitute a kit family) |
| `caption-texture` | pop | no | Anton (yes) |

`manifest.json` carries the machine-readable form (file lists, `external` deps,
`bytes`). See `LICENSES.md` for provenance.
