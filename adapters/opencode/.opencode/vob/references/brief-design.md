# Brief skeleton + tone→design table
Read once while drafting the brief in PLAN. The Design language section is BINDING for the
composer — anything left vague here will be vague on screen.

## Brief skeleton

```markdown
# Brief: <project_id>

## Target
- Platform: <canonical platform> (<profile.width>x<profile.height> @ <profile.fps>fps)
- Duration: <target_duration.seconds>s (platform ideal: <profile.ideal_duration_s.min>–<profile.ideal_duration_s.max>s)
- Source: <file_count> file(s), <total source duration>s
- Styled after: <derived_from>            ← include ONLY when state.style is set

## Hook
- Verbal hook: "<the chosen line>" — digest hook_candidate #<n>, at <t>s in file <i>
  (or, for silent sources: <the visual moment, grounded on the contact sheet>)
- Text hook: "<≤4 words>" — on screen within the first 700ms
- Why it stops the scroll: <one sentence>

## Beats
1. <beat — one idea, with the source span it comes from>
2. ...

## Tone
<answers.tone>, expanded: <2–4 concrete adjectives>

## Design language        ← BINDING for the composer; seed from the tone→design table below
- Typography: headline <kit family + weight>; captions <kit family + weight>
- Palette: bg <hex>, text <hex>, accent <hex>
- Captions: <bold-pop | clean-pill | minimal-lower-third>, <size>px, <position>,
  <ALL-CAPS | mixed case> — honor answers.captions_style verbatim where it conflicts,
  EXCEPT the platform safe bands and the 56px caption floor (hard constraints captions_style
  cannot override): record the nearest compliant interpretation and surface the adjustment
  to the user at the plan gate
- Motion: <fast-snap | medium-soft | slow-cinematic>; punch-ins <yes|no>

## Constraints
- Music/VO: <answers.music_vo>
- Audio treatment: <answers.audio_treatment | n/a>
- Key moments to preserve: <answers.key_moments>
- Technical: <source resolution> → <profile.width>x<profile.height>; safe bands top
  <profile.safe_top_px>px / bottom <profile.safe_bottom_px>px
```

## Tone→design mapping table
Pick the row whose bucket matches `tone` (nearest match; blend two rows only when the user's tone
genuinely spans them; the `captions_style` answer always overrides the caption column):

| tone bucket (match against answers.tone) | headline font (kit) | caption font (kit) | palette | caption look | motion |
|---|---|---|---|---|---|
| energetic / hype / punchy / chaotic | Anton (or Bebas Neue for taller frames) | Inter 900 | white on footage; one saturated accent (#FF3B30 or #FFD60A); high contrast | bold-pop: ALL-CAPS 3–4-word chunks, 64–72px, heavy shadow or solid pill, centered ~78% height | fast-snap: ≤0.15s entrances, beat-synced caption pops, punch-ins yes |
| cinematic / dramatic / epic | Playfair Display 700 | Inter 700 | desaturated grade via translucent overlay; off-white #F2EFE8 text; no neon | minimal-lower-third: mixed case, 56–60px, soft shadow, no pill | slow-cinematic: 0.5–0.8s ease-in-out, 1.02→1.0 scale holds, fade tails; punch-ins no |
| calm / explainer / documentary | Inter 700 | Inter 700 | muted neutrals; off-white #F5F5F0 text; single cool accent | clean-pill: rgba(0,0,0,0.55) pill, 12px radius, 56px, ≤2 lines, mixed case | medium-soft: 0.25–0.35s cubic-bezier(0.22,1,0.36,1); punch-ins no |
| comedic / playful / fun | Nunito 800 | Nunito 800 | bright + friendly; pastel accents; cream title cards | bold-pop with rounded pill; occasional single-word color emphasis | fast-medium: 0.2–0.3s springy ease-out; small rotations (±2°) on overlays only; punch-ins yes |
| raw / vlog / authentic | Inter 900 | Inter 700 | white on footage, one accent, zero decoration | bold word-chunk captions 60px, heavy shadow, no pill | medium-fast cuts; minimal overlays; punch-ins no |

Fill the Design language section from this table, then adjust ONLY where the user's
`captions_style` / rough idea / `--like` source brief say otherwise. The composer implements the
Design language section verbatim — it does not re-derive look from tone, so anything you leave
vague here will be vague on screen.
