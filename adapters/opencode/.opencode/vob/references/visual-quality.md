# Visual-quality rubric — the "does it look good in pixels" reference

The rubric the **visual-critic** scores rendered stills against, and the standard the
orchestrator's inline self-QC fallback holds the composer to. The composition already passed
lint + composition-QC (the floor: no errors, captions/overlays bound to elements, nothing off
the canvas). This doc is the ceiling: is the frame actually *legible, safe, uncluttered,
striking, and intentional* — or does it read as templated AI-slop?

Judge **stills** — you cannot see motion. Flag only what a frozen frame shows. Judge against the
**`video_type` / ruleset** and the **plan** (`storyboard.json`): an intended cinematic letterbox,
a designed flat title card, or a quiet b-roll beat is not a defect.

---

## 1. The six dimensions

Score each `strong | ok | weak`, citing a still + timecode. `weak` on any one ⇒ the verdict is
`REVISE`.

### Legibility — can a viewer read the text at a glance, on a phone?
- **What to look for:** caption/overlay contrast against whatever is behind it; font size relative
  to the frame (a caption that's tiny at thumbnail size is `weak`); ≤2 lines per caption chunk;
  text not smeared by motion blur in the underlying clip.
- **The classic slop defect:** white text on a bright or busy background with no scrim/plate
  behind it — readable on a calm shot, gone the instant the background brightens. A scrim, a solid
  pill, a text-shadow, or a darkened lower-third fixes it.
- **strong:** every caption pops off its background at thumbnail size, has a backing treatment
  where the shot is busy, never exceeds 2 lines. **ok:** readable but marginal contrast on one
  frame, or a slightly long line. **weak:** any caption you have to work to read, or 3+ lines, or
  text lost in the background.

### Safe-area — does text survive the platform's own UI?
- **What to look for:** all captions and key overlays INSIDE the safe band — nothing in the top
  `safe_top_px` or the bottom `safe_bottom_px` (where the platform overlays its caption
  autoscroll, profile/handle chrome, like/share rail, progress bar). Nothing clipped at the frame
  edges.
- **strong:** all text comfortably inside the band with margin. **ok:** text touches the band
  edge but isn't occluded. **weak:** a caption/overlay sits where TikTok's caption stack or
  YouTube's progress bar will cover it, or text is clipped at an edge. (This is almost always
  `glaring` — it's invisible in the wild, not just ugly.)

### Collisions — does anything overlap anything it shouldn't?
- **What to look for:** caption over a typed overlay; two overlays stacked on the same band; text
  over the speaker's face or over the subject of the shot; a lower-third over the burned-in
  caption.
- **strong:** clean separation, each element owns its real estate. **ok:** elements close but
  legible. **weak:** hard overlap that garbles either element, or text over the face.

### Hook frame — is the opening frame a thumbnail you'd stop scrolling for?
- **What to look for** (the first sampled still, the hook scene): subject clearly visible and in
  focus; not mid-blink / mid-motion-smear / mid-transition; the hook text (if any) legible at
  thumbnail size; the frame makes a promise. For a `retention` short this is the single
  highest-leverage frame in the whole cut.
- **strong:** crisp, well-framed, the text/subject reads instantly small. **ok:** fine but
  forgettable. **weak:** black/empty, motion-smeared, subject cut off, or hook text unreadable.

### Framing — aspect, crop, and composition accidents
- **What to look for:** the frame fills the target aspect (a 9:16 vertical with no unintended
  black bars; bars are a defect UNLESS the `video_type` intends them — cinematic letterbox is
  legitimate); the subject isn't cropped out by an `object-fit: cover` that zoomed past them;
  no wrong-dimension / squished / pillarboxed scene; consistent framing across scenes on the
  contact sheet.
- **strong:** every scene fills the frame correctly, subject well-placed. **ok:** one slightly
  loose crop. **weak:** unintended bars, a squished/stretched scene, or the subject cropped out.

### Polish — intentional design vs templated AI-slop
- **What to look for:** does the look feel *authored* (a coherent palette, a deliberate type
  hierarchy, consistent spacing, motion that serves the content) or *generated* (clashing colors,
  default-looking fonts at default sizes, center-everything, gratuitous gradients/emoji, a
  different feel every scene)? Does it serve the `tone`?
- **strong:** coherent, on-tone, looks made by a person with taste. **ok:** clean but generic.
  **weak:** visibly templated/slop — see §3.

---

## 2. Safe-band reference

The platform profile carries `safe_top_px` and `safe_bottom_px` (and the canonical dimensions).
Read them from the spawn data (`intent.platform_profile`). Captions and key overlays must sit in
the **safe band**: the region BETWEEN the top inset and the bottom inset.

- **TikTok / Reels / Shorts (9:16):** generous bottom inset — the caption autoscroll, the
  handle/caption text, and the action rail eat the bottom ~15–20% and the right edge. Captions
  belong in the lower-middle third, NOT pinned to the bottom edge. The top inset covers the
  "Following / For You" chrome.
- **YouTube landscape (16:9):** the progress bar + controls live across the bottom on hover;
  keep burned-in captions a safe margin above the very bottom.
- **Square (1:1):** lighter chrome, but keep the same edge margins.

A caption in the safe band on a clean preview can still be occluded in the app — that's the whole
point of the band. When in doubt, text belongs further from the edges.

---

## 3. The slop tells (Polish, made concrete)

A frame reads as templated / AI-generated when it shows:

- **Contrast-blind text** — white captions dropped on whatever's behind them, no scrim, no plate
  (also a Legibility `weak`).
- **Default everything** — the platform/library default font at a default size, centered, no
  hierarchy; nothing chosen.
- **Palette clash or palette drift** — colors that fight (neon on neon), or a different color
  scheme every scene with no through-line.
- **Gratuitous decoration** — random gradients, drop-shadows on everything, large inline emoji
  used as a crutch (and large color emoji can artifact under software GL — keep emoji small or
  inside a solid pill).
- **Center-everything** — every element dead-center because nothing was composed.
- **Inconsistent caption treatment** — captions styled differently scene to scene.

The opposite — what `strong` Polish looks like — is a single coherent system: one palette, a
type hierarchy (big bold hook, smaller body), consistent caption placement + treatment, motion
eases reused, spacing that breathes. The design-system kit (`compose/design-system/`) exists to
give exactly this; a frame that ignored it and rolled its own usually shows it.

---

## 4. Per-ruleset / per-video-type emphasis

- **`retention` (social-short):** the **Hook frame** and **Legibility** dimensions dominate — a
  weak hook frame or unreadable captions sink a short regardless of everything else. Captions are
  big, high-contrast, lower-middle.
- **`chaptered` (long-form):** consistency across a long piece matters — `Framing` and `Polish`
  carry weight (a coherent look across chapters); a single quiet frame is fine.
- **`montage`:** variety is intended — don't flag scene-to-scene framing/pace differences as
  inconsistency; do flag genuine legibility/collision defects.
- **`general` / `tutorial`:** clarity over flash — legible callouts, clean framing of whatever is
  being shown; a plain, readable frame is `strong`, not boring.
- **`cinematic`:** letterbox bars, dark/quiet frames, and minimal text are INTENTIONAL — never
  flag them as defects. Judge grade consistency and framing.
- **`podcast`:** stable framing, legible lower-thirds/names; little motion is expected.

---

## 5. The `visual/*` finding codes

Use these in `FINDINGS` (mirrors the `qc/*` and `editorial/*` code conventions):

- **`visual/low_contrast`** — caption/overlay text too low-contrast against its background (the
  white-on-bright slop defect). *Fix:* add a scrim/plate/shadow, darken the lower-third, or
  recolor the text. (The deterministic `qc/caption_low_contrast` check in `vob_qc_stills` flags
  the measurable cases; you catch the ones it can't — busy backgrounds, partial occlusion.)
- **`visual/caption_illegible`** — caption unreadable for a reason other than contrast: too small
  at thumbnail size, 3+ lines, smeared by underlying motion. *Fix:* size up, split the chunk,
  reposition off the motion.
- **`visual/safe_area_intrusion`** — caption/overlay in the top/bottom platform UI band or
  clipped at an edge. *Fix:* move it into the safe band.
- **`visual/text_collision`** — caption over an overlay, or two overlays overlapping. *Fix:*
  restack onto separate bands / tracks.
- **`visual/text_over_face`** — text placed over the speaker's face or the shot's subject. *Fix:*
  move the text to an empty region of the frame.
- **`visual/weak_hook_frame`** — the opening frame won't stop a scroll (black/empty, motion-smear,
  subject cropped, hook text unreadable small). *Fix:* re-pick the hook instant / reframe / size
  the hook text up.
- **`visual/subject_cropped`** — `object-fit: cover` or a layout cell zoomed past the subject.
  *Fix:* adjust `object-position` / `object-fit` / the cell crop.
- **`visual/letterbox_bars`** — unintended black bars / wrong aspect (NOT an intended cinematic
  letterbox). *Fix:* correct the scene dimensions / `object-fit`.
- **`visual/slop`** — the frame reads as templated/AI-generated (see §3). *Fix:* adopt the
  design-system look bundle for the `video_type`; one palette, a type hierarchy, consistent
  caption treatment.
- **`visual/other`** — anything real that doesn't fit a code; describe it clearly.

---

## 6. `glaring` vs `taste`

- **`glaring`** (orchestrator auto-fixes before the human sees it): the frame is broken or the
  text is unreadable / invisible in the wild — `safe_area_intrusion`, `text_over_face`, a black or
  unreadable `weak_hook_frame`, `low_contrast`/`caption_illegible` that you genuinely cannot read,
  `subject_cropped`, unintended `letterbox_bars`.
- **`taste`** (rides to the human as a note, never auto-fixed): a real but subjective improvement —
  palette feel, hook framing aesthetics, overlay density, caption position preference within the
  band, a generic-but-clean look.
- **When in doubt, choose `taste`.** The human is the final judge; a deferred note costs nothing,
  a needless re-render costs a render. Reserve `glaring` for "this looks broken / nobody can read
  this."
