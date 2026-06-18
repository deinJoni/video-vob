# video-vob design-system kit

First-party, **pure-CSS**, token-parameterized REFERENCE design components — vetted
visual systems (titles, lower-thirds, grades, motion, backdrops) per video-type, so
COMPOSE's default output is striking, not "lint-clean AI slop". Built by
`scripts/build-design-system.js` (the source of truth; these assets are committed),
lint-verified against hyperframes `0.6.112`.

The kit is symlinked into `compose/design-system/` on every save (beside `./fonts.css`
and `./captions/`). The composer READS `./design-system/manifest.json` + the per-component
reference HTML and ADAPTS the technique — it does **not** copy them verbatim.

## The composer's contract (every component)

1. **Pure CSS `@keyframes` — never GSAP.** hyperframes' css adapter scrubs a `paused`
   animation to each frame via `animation-delay = -(T − data-start)`. Keep
   `animation-fill-mode: both` + `animation-play-state: paused`.
2. **Stagger with `data-start`, NEVER `animation-delay`** (the runtime hijacks
   animation-delay). Each staggered piece is its own `class="clip"` element.
3. **Tokens, not hard-coded brand.** Set the `--vob-*` custom properties (see
   `tokens.css`) once on your composition root from `target.design`; components read them
   with a literal fallback (`var(--vob-accent, #ff3b30)`).
4. **Fonts:** references use hyperframes' auto-resolved families (`League Gothic, Archivo Black, Oswald, Montserrat, Poppins, Outfit`, …).
   Substitute the concrete family with `target.design.typography.{headline|body|caption}`;
   load `./fonts.css` for house faces (Anton / Hanken Grotesk / Noto SC) when the brief names them.
5. Every timed element: `class="clip"` + stable `id` + `data-start`/`data-duration`/`data-track-index`
   (≥1; a distinct track per time-overlapping element); `animation-duration == data-duration`.

## Looks by video-type

### social-short — _punchy, high-energy, retention-first_

  - Big heavy condensed display type (League Gothic / Archivo Black), UPPERCASE, tight leading (~0.9).
  - ONE dominant accent against near-black; high contrast; saturated.
  - Fast snappy motion — slam/scale-in 0.25–0.45s, nothing lingers; energy beats can whip/punch.
  - Titles ride the upper third (above a talking head); captions are bold-pop lower-third.
  - Generous size over generous spacing — fill the frame, it's watched small.

- **title**: `title-bold-slam` (alt: `title-kinetic-stack`)
- **lower_third**: `lower-third-bold-bar`
- **grade**: `grade-punch` (alt: `grade-teal-orange`)
- **motion**: `motion-fast-snap`
- **backdrop**: `backdrop-spotlight` (alt: `backdrop-gradient-sweep`)
- **end_card**: `end-card-cta`
- **caption**: `caption-pop` (alt: `caption-word-rise`)
- **cold_open**: `cold-open-claim`

  Transitions: Cut-heavy; reserve whip_pan / zoom_punch (≤0.35s) for energy beats.

### long-form — _clean editorial, readable, chaptered_

  - Calm grotesque headlines (Hanken Grotesk / Outfit) with generous whitespace; sentence or title case.
  - Restrained, soft motion (0.4–0.6s ease); let content breathe.
  - Chapter/section cards at boundaries; lower-thirds introduce speakers; cool blue accent.
  - 16:9 safe margins; never crowd the edges; one idea per card.

- **title**: `title-clean-kicker`
- **lower_third**: `lower-third-accent-edge` (alt: `lower-third-name-role`)
- **grade**: `grade-clean` (alt: `grade-warm`)
- **motion**: `motion-medium-soft`
- **backdrop**: `backdrop-gradient-sweep`
- **end_card**: `end-card-cta`
- **caption**: `caption-pop`

  Transitions: cut / dip between scenes; crossfade at section boundaries.

### cinematic — _filmic, restrained, elegant (24fps)_

  - Refined serif display (Playfair Display) + serif body (EB Garamond); lots of negative space.
  - Slow, smooth motion (0.7–1.0s, gentle ease); long holds; nothing snappy.
  - Letterbox feel; desaturated/teal-orange grade; muted gold accent; small minimal lower-thirds.
  - Center or rule-of-thirds compositions; type is small and confident, never shouting.

- **title**: `title-editorial-serif`
- **lower_third**: `lower-third-serif-minimal`
- **grade**: `grade-film-desat` (alt: `grade-teal-orange`)
- **motion**: `motion-slow-cinematic`
- **backdrop**: `backdrop-film-bars`

  Transitions: cut / dip; slow crossfade or focus_pull between acts; never whip/zoom.

### tutorial — _clear, functional, high-legibility_

  - Plain sans (Inter) headlines + body; mono (JetBrains Mono) for code/keys/numbers.
  - Step indicators and callouts that POINT at the thing; never decorative.
  - Soft, quick motion; green 'go/correct' accent; high text contrast on solid panels.
  - Keep the demo readable — overlays hug a safe edge, never cover the action.

- **title**: `title-clean-kicker`
- **lower_third**: `lower-third-pill`
- **grade**: `grade-clean`
- **motion**: `motion-medium-soft`
- **callout**: `callout-arrow-pill` (alt: `callout-number-step`)
- **backdrop**: `backdrop-grid`
- **caption**: `caption-pop`

  Transitions: cut / dip; slide for step-to-step; avoid flashy transitions.

### podcast — _minimal, speaker-forward, quotable_

  - Calm grotesque (Hanken Grotesk); big pull-quote cards; speaker name + role lower-thirds.
  - Soft medium motion; muted purple accent; lots of stillness (it's talking heads).
  - Frame the speaker; keep furniture minimal; one quote on screen at a time.

- **title**: `title-quote-card`
- **lower_third**: `lower-third-name-role`
- **grade**: `grade-clean` (alt: `grade-warm`)
- **motion**: `motion-medium-soft`
- **backdrop**: `backdrop-soft-studio`
- **caption**: `caption-pop`

  Transitions: cut / dip; gentle crossfade between segments.

### general — _balanced, versatile, clean_

  - Neutral sans (Inter / Outfit); moderate weight contrast; one clear accent.
  - Medium-soft motion (0.4–0.6s); comfortable margins; legible at any size.
  - Adapt density to platform: tighter & bolder if vertical, airier if 16:9.

- **title**: `title-clean-kicker` (alt: `title-bold-slam`)
- **lower_third**: `lower-third-accent-edge` (alt: `lower-third-pill`)
- **grade**: `grade-clean` (alt: `grade-warm`, `grade-cool`)
- **motion**: `motion-medium-soft`
- **backdrop**: `backdrop-gradient-sweep` (alt: `backdrop-spotlight`)
- **caption**: `caption-pop` (alt: `caption-word-rise`)
- **cold_open**: `cold-open-claim`

  Transitions: cut / crossfade / dip — match the destination platform's energy.

## Components

### title

| component | suited for | fonts | lint |
|---|---|---|---|
| `title-bold-slam` | social-short, general | League Gothic, Oswald | clean |
| `title-clean-kicker` | long-form, tutorial, general | Inter, Outfit, Montserrat | clean |
| `title-editorial-serif` | cinematic | Playfair Display, EB Garamond | clean |
| `title-quote-card` | podcast | Playfair Display, EB Garamond, Inter | clean |
| `title-kinetic-stack` | social-short | League Gothic, Oswald | clean |

### lower_third

| component | suited for | fonts | lint |
|---|---|---|---|
| `lower-third-bold-bar` | social-short | Archivo Black, Oswald | clean |
| `lower-third-accent-edge` | long-form, general | Outfit, Montserrat | clean |
| `lower-third-serif-minimal` | cinematic | Playfair Display, EB Garamond | clean |
| `lower-third-name-role` | podcast, long-form | Outfit, Montserrat | clean |
| `lower-third-pill` | tutorial, general | Inter | clean |

### grade

| component | suited for | fonts | lint |
|---|---|---|---|
| `grade-punch` | social-short | — | clean |
| `grade-teal-orange` | cinematic, general | — | clean |
| `grade-film-desat` | cinematic | — | clean |
| `grade-warm` | long-form, podcast, general | — | clean |
| `grade-cool` | general | — | clean |
| `grade-clean` | long-form, tutorial, podcast, general | — | clean |
| `grade-bw` | cinematic | — | clean |

### motion

| component | suited for | fonts | lint |
|---|---|---|---|
| `motion-fast-snap` | social-short | Archivo Black, Oswald | clean |
| `motion-medium-soft` | long-form, tutorial, podcast, general | Montserrat, Outfit | clean |
| `motion-slow-cinematic` | cinematic | Playfair Display, EB Garamond | clean |

### backdrop

| component | suited for | fonts | lint |
|---|---|---|---|
| `backdrop-spotlight` | social-short, general | Inter | clean |
| `backdrop-gradient-sweep` | general, long-form | Inter | clean |
| `backdrop-film-bars` | cinematic | Inter | clean |
| `backdrop-grid` | tutorial | Inter | clean |
| `backdrop-soft-studio` | podcast | Inter | clean |

### callout

| component | suited for | fonts | lint |
|---|---|---|---|
| `callout-arrow-pill` | tutorial | Inter | clean |
| `callout-number-step` | tutorial | Inter | clean |

### end_card

| component | suited for | fonts | lint |
|---|---|---|---|
| `end-card-cta` | social-short, long-form | Archivo Black, Oswald, Inter | clean |

### caption

| component | suited for | fonts | lint |
|---|---|---|---|
| `caption-pop` | social-short, general, long-form, tutorial, podcast | Montserrat | clean |
| `caption-word-rise` | social-short, general | Montserrat | clean |

### cold_open

| component | suited for | fonts | lint |
|---|---|---|---|
| `cold-open-claim` | social-short, general | Archivo Black | clean |

`manifest.json` carries the machine-readable form (per-component `kind`, `file`, `fonts`,
`tokens_used`, `pure_css`, `lint`, `bytes`; the per-video-type `video_types` map). See
`LICENSES.md` for provenance.
