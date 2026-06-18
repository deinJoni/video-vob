# Lint + QC fix recipes
Read ONLY when your revision_notes carry one or more rule codes. Apply the canonical fix for
exactly those codes — do not guess.

## `timed_element_missing_clip_class`

Triggers when a NON-media element carries any timing attribute (`data-start`, `data-duration`, or `data-track-index`) without a `clip` class token (exact token — `my-clip` does not count). Without `class="clip"`, a layout element is visible for the entire composition instead of only its scheduled window. **`<video>`/`<audio>` are EXEMPT** — the runtime schedules media by its own timing attrs; never "fix" a timed `<video>` by adding wrappers or classes (timing attrs are REQUIRED directly on media — see `media_missing_data_start`). The engine's static QC pre-empts this rule as warning `vob/timed_element_missing_clip_class` with file/line — same scope, same fix.

✗
```html
<div data-start="3" data-duration="4" data-track-index="1">
  <h1>Wait for it</h1>
</div>
```

✓
```html
<div class="clip" data-start="3" data-duration="4" data-track-index="1">
  <h1>Wait for it</h1>
</div>
```

## `media_missing_data_start`

Triggers when a `<video>`/`<audio>` with `src` has no `data-start` — hyperframes cannot own playback for untimed media, so preview and render diverge. Timing attributes go DIRECTLY on the media element; a timed wrapper `<div>` does not time the media inside it.

✗
```html
<div class="clip" data-start="2.0" data-duration="6.0" data-track-index="0">
  <video id="s002-aroll" src="./source/s002-0.mp4" data-has-audio="true"
         data-media-start="0" data-playback-start="0"></video>
</div>
```

✓
```html
<video id="s002-aroll" src="./source/s002-0.mp4" data-has-audio="true"
       data-start="2.0" data-duration="6.0" data-track-index="0"
       data-media-start="0" data-playback-start="0"></video>
```

## `media_missing_id`

Triggers when a `<video>` or `<audio>` element lacks an `id` attribute. Hyperframes uses the id to address media elements for seeking and discovery; without one, the linter can't reason about the element.

✗
```html
<video src="./source/s001-0.mp4" muted
       data-start="0" data-duration="4.0" data-track-index="0"
       data-media-start="0" data-playback-start="0"></video>
```

✓
```html
<video id="scene-1-video"
       src="./source/s001-0.mp4" muted
       data-start="0" data-duration="4.0" data-track-index="0"
       data-media-start="0" data-playback-start="0"></video>
```

Use stable, scene-anchored names: `scene-1-video`, `scene-2-audio`, `outro-bg`. Don't reuse ids across scenes.

## `video_missing_muted` (alias `media_audible_not_marked`)

Triggers when a `<video>` element with `data-start` is neither `muted` nor explicitly marked as audible. The lint message itself says: "Mark audible videos with `data-has-audio='true'`".

✗
```html
<video id="scene-1-video" src="./source/s001-0.mp4"
       data-start="0" data-duration="4.0" data-track-index="0"
       data-media-start="0" data-playback-start="0"></video>
```

✓ (silent visual — for b-roll without dialogue):
```html
<video id="scene-1-video" src="./source/s001-0.mp4" muted
       data-start="0" data-duration="4.0" data-track-index="0"
       data-media-start="0" data-playback-start="0"></video>
```

✓ (keep diegetic audio — for dialogue, native sound):
```html
<video id="scene-1-video" src="./source/s001-0.mp4" data-has-audio="true"
       data-start="0" data-duration="4.0" data-track-index="0"
       data-media-start="0" data-playback-start="0"></video>
```

Pick exactly one. Default to `muted` for non-dialogue clips; use `data-has-audio="true"` only when the brief calls for diegetic sound. Note: when intent.audio_treatment is `discard_audio`, scene clips are pre-cut with `-an` — no audio stream exists, so `data-has-audio="true"` is meaningless.

## `overlapping_clips_same_track` (related: `duplicate_media_discovery_risk`)

Triggers when two clips share identical `data-start` + `data-duration` on the same `data-track-index`. Hyperframes can't decide which to render and either picks one arbitrarily or flags as duplicate-discovery risk.

✗
```html
<video id="a" src="./source/s003-0.mp4" muted data-start="5" data-duration="3" data-track-index="0" data-media-start="0"></video>
<video id="b" src="./source/s003-0.mp4" muted data-start="5" data-duration="3" data-track-index="0" data-media-start="0"></video>
```

✓ (stagger timing):
```html
<video id="a" ... data-start="5" data-duration="3" data-track-index="0"></video>
<video id="b" ... data-start="8" data-duration="3" data-track-index="0"></video>
```

✓ (or move to a different track for an intentional overlay):
```html
<video id="a" ... data-start="5" data-duration="3" data-track-index="0"></video>
<video id="b" ... data-start="5" data-duration="3" data-track-index="1"></video>
```

## `font_family_without_font_face`

Triggers when CSS sets a non-generic `font-family` (custom fonts, system stacks like `-apple-system`) without a matching `@font-face` declaration in the document. Headless Chrome doesn't have the font cached; the render falls back and your typography breaks.

✗
```css
body { font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
```

✓ **link** the shipped kit in `<head>` — a `<link>`, NOT an `@import`. The lint resolves `@font-face` from a linked stylesheet but does not follow `@import` inside `<style>`, so non-auto-resolved families (Anton, Bebas Neue, Hanken Grotesk, Noto Serif SC / Noto Sans SC / Noto Sans JP) stay flagged when imported. Then use a kit family:
```html
<link rel="stylesheet" href="./fonts.css" />
```
```css
.hook-title { font-family: "Anton", sans-serif; }
```

Never base64, never CDN — fonts.css ships in compose/ on every save.

## `imperative_media_control`

Triggers when JavaScript calls `.play()`, `.pause()`, or sets `.currentTime` on a media element. Hyperframes owns playback; imperative control fights the framework and produces nondeterministic renders.

✗
```html
<script>
  const v = document.querySelector("video");
  v.play();
  v.currentTime = 10;
</script>
```

✓ — declare timing and trim via attributes; let hyperframes drive:
```html
<video id="scene-1-video" src="./source/s001-0.mp4" muted
       data-start="0" data-duration="3" data-track-index="0"
       data-media-start="0"
       data-playback-start="0"></video>
```

## Composition QC codes (engine static scan)

### `vob/missing_root_attr` (error)
A composition root is missing one of the Rule of Three (`data-composition-id`, `data-width`,
`data-height`), `index.html` has no `data-composition-id` element at all, or the MASTER root is
missing a positive numeric `data-duration`. Add the missing attribute(s): width/height are the
output pixels from the platform profile; the master `data-duration` is the total runtime in
seconds. (`data-start`/`data-fps` are hyperframes timing attrs — this rule does not check them.)

### `vob/unresolved_source_ref` / `vob/source_ref_target_missing` (errors)
A `./source/<name>` reference resolves to nothing on disk. The ref must be
`./source/<scene_id>-<clip_index>.mp4` for an existing storyboard clip — check the scene_id
spelling and the 0-based clip index against the storyboard. An unresolved-ref rejection lists
the legal names: the finding message previews them, and the rejection's
`details.valid_source_refs.scene_clips` (passed through in your `revision_notes`) carries the
full list — pick from it verbatim.

### `vob/absolute_src_path` (error)
A media `src` uses an absolute filesystem path. Make it relative (`./source/...`) — absolute
paths break the hyperframes file server.

### `vob/master_duration_short` (error)
The root `data-duration` is shorter than the storyboard scene-duration sum (in fan-out: the
ACTIVE short's scene sum). Set it ≥ the sum or the timeline tail is silently truncated.

### `vob/scene_missing_clip` (error) / `vob/overlay_scene_missing_clip` (warning)
Every storyboard scene (in fan-out: every scene of the ACTIVE short) needs ≥1 clip element
referencing `./source/<scene_id>-*.mp4`. Zero-video overlay compositions get the warning form
only — confirm the overlay-over-base path is intended.

### `vob/cross_short_clip_ref` (warning)
Fan-out: a `./source/` ref resolves to ANOTHER short's clip. A fan-out composition implements
exactly one short — use only the active short's `<scene_id>-<clip_index>.mp4` names (the
rejection/expected lists carry them).

### `vob/active_short_unresolved` (warning)
Fan-out storyboard but the composition's `short_id` matched no short (or was absent) — the scoped
storyboard checks were skipped. Re-save the composition with the correct `short_id`.

### `vob/video_count_exceeds_hard_cap` (error, >8) / `vob/video_count_over_budget` (warning, >6)
Merge or remove `<video>` elements to ≤6 — concatenate the A-roll spine into one clip rather
than fragmenting it.

### `vob/scene_clip_media_start_nonzero` (warning)
A scene clip carries a non-zero `data-media-start`. Set it to `0` — pre-cut clips are already
trimmed; offsets re-introduce the deep-seek failure mode.

### `vob/caption_font_size_small` (warning)
A caption selector sets font-size below 56px. Use ≥56px on vertical/short-form output.

### `vob/fps_mismatch` (warning)
The storyboard's `target.fps` differs from the master root's `data-fps` (absent = 30, the
hyperframes default). Set `data-fps="<target.fps>"` on the composition root — a 24fps cinematic
plan rendered at 30 is a silent format miss.

### `vob/cross_segment_clip_ref` (warning)
Segmented render: a `./source/` ref resolves to ANOTHER render segment's clip. A segment
composition implements exactly one segment — use only the scenes named in your
`segment_scene_ids` (cross-segment footage duplicates content at assembly).

### `vob/active_segment_unresolved` (warning)
The composition's `segment_id` no longer matches the render plan (the storyboard changed since
COMPOSE entry). The orchestrator re-enters COMPOSE to re-derive the plan; re-save with the
current segment_id.

### `vob/overlay_missing_element` (error)
A planned typed overlay has no implementing element. Render the overlay and stamp the element
with `data-vob-overlay-id="<overlay.id>"` — every object in `scene.overlays[]` is binding (same
severity as a missing scene clip).

### `vob/overlay_track_zero` / `vob/overlay_element_untimed` / `vob/unplanned_overlay_element` (warnings)
The bound overlay element sits on `data-track-index="0"` (the video spine — move it to the
planned track ≥1) / lacks `data-start` (it renders static; re-time scene-relative → master) /
carries a `data-vob-overlay-id` the plan never declared (typo'd id, or an overlay the storyboard
didn't ask for — remove it or fix the id).

### `vob/caption_missing_element` (error) / `vob/caption_unbound` (warning)
A planned `caption_segment` carrying an authored `id` has no implementing element. Stamp the
chunk div with `data-vob-caption-id="<id>"` plus `class="clip"` and its timing. If the caption is
`exact:true` (a binding text/timing contract) the miss is an **error**; an id-bearing but
non-exact caption is a **warning** — drop the `id` if the composer is free to re-chunk that
caption. Only id-bearing captions are checked; **id-less `caption_segments` are freeform** (no
binding, no finding).

### `vob/caption_element_untimed` / `vob/unplanned_caption_element` (warnings)
A bound caption element lacks `data-start` (it renders static — re-time scene-relative → master) /
an element carries a `data-vob-caption-id` the plan's active scope never declared (typo'd id, or a
caption the storyboard didn't ask to bind — remove it or fix the id).

### `vob/caption_emphasis_generic` (info)
The plan declares `emphasis_words` on one or more `caption_segment`s but the composition stamps NO
`data-vob-emphasis` anywhere — the load-bearing word isn't accented, so captions read generic.
ADVISORY (info; never gates). Fix: wrap each emphasis word in `<span class="emph" data-vob-emphasis>`
styled with the design accent (`color: var(--vob-accent)` + heavier weight / slight scale) — the
emphasis_words-driven realization (see §Caption components, §Cold-open). One global note, not per-caption.

### `vob/caption_overflow` (warning)
A caption (or typed-overlay) element's text overflows its container box — it spills past the box on
render (attributed to the caption/overlay id when resolvable). ADVISORY: it never gates
COMPOSE→PREVIEW (only errors do). The message carries hyperframes' `fixHint` (e.g. "shrink
font-size from 140px to ~40px, or allow wrapping with max-width/fitTextFontSize"). Fix per the hint:
shorten the chunk, drop the font-size (use the component's fit hook), widen the container with
`max-width`, or move it off the safe band. Emitted by the layout/legibility inspect pass folded
into the merged lint (gated to scopes with captions/typed overlays; knob `VOB_LAYOUT_QC`, default
`auto`).

### `vob/layout_overflow` (warning)
The same text/box overflow on a NON-caption, non-overlay element (a title card, kicker, or other
graphic); off-canvas placement reports at info severity. Same advisory status (never gates) and the
same fixes — shorten the text, drop the font-size, widen/`max-width` the container, or reposition
inside the frame. Carries hyperframes' `fixHint`.

### `vob/layout_qc_skipped` (info)
The layout/legibility inspect pass timed out, crashed, or returned something unparseable — legibility
was NOT verified this run. Purely informational: it never gates and needs no fix. Re-save to retry,
or set `VOB_LAYOUT_QC=off` to suppress the pass (or `always` to force it).

### `vob/design_font_mismatch` (warning)
The storyboard's `target.design.typography` declares a font kit (headline/caption/body) but the
composition's `font-family` declarations reference NONE of them — the composer went off-brief. Use
the declared kit families (loaded via `./fonts.css`); referencing at least one counts as
adherence. (Accent/grade/motion conformance is NOT checked — implement those from the brief's
Design language.)

---

## Overlay vocabulary — implementation patterns (schema 1.2)

Each planned overlay type maps to a known HTML/CSS shape. Shared skeleton — a `class="clip"` div
(except `pip`), timing re-based to master, the binding id stamped:

```html
<div id="lt-1-el" class="clip overlay-lower-third" data-vob-overlay-id="lt-1"
     data-start="10.5" data-duration="2.5" data-track-index="2">…</div>
```

- **`title_card`** — full-width centered block, upper third on vertical; headline font from
  `style.font` (Anton/Bebas for hype, Playfair for cinematic), 96–140px; entrance per
  `motion.in` at the pacing speed. Content: `title` (+ optional `subtitle` at ~40% size).
- **`lower_third`** — left- or anchor-aligned bar above `safe_bottom_px`: name 48–64px bold +
  subtitle 32–40px on a translucent pill or accent-edged bar (`border-left: 8px solid
  <accent>`); slide/fade in, hold `dwell_min_s`, exit before the scene cut.
- **`callout`** — small pill/arrow label NEAR the thing it names (use `position.anchor` +
  `offset_px`); 36–48px; never center-screen; keep up ≥1.2s.
- **`kinetic_caption`** — NOT one element: a series of word-chunk `class="clip"` divs (3–5 words,
  56px+ bold), each timed to its transcript words inside the scene's clip window; stamp the
  `data-vob-overlay-id` on a wrapper div spanning the overlay window that CONTAINS the chunk
  divs (the wrapper carries the timing of the whole window).
- **`caption_block`** — one static caption div in the caption position/style (clean-pill
  default); standard caption floors apply.
- **`logo_bug`** — small (≤120px) corner mark inside the safe area, low opacity (0.85),
  usually spans the whole scene window.
- **`progress_bar`** — 4–8px bar at a safe edge; animate `transform: scaleX(0→1)` linearly
  across the overlay window (CSS animation, `animation-duration` = overlay duration).
- **`chapter_marker` / `section_title`** — like a restrained title_card at a section boundary:
  index/kicker line + title; matches the brief's headline face; often paired with a `fade`
  segment boundary.
- **`data_viz`** — number counter or bar: big numeral (JetBrains Mono/IBM Plex Mono for
  technical tone) + label; animate the count with a GSAP timeline registered to
  `window.__timelines` ({paused:true}) or a CSS steps() trick; never fetch data — values come
  from `content`.
- **`cta` / `end_card`** — final-scene block: handle/text + accent button-shaped pill;
  `end_card` may own the whole frame (solid/blurred bg) for the last 1.5–3s.
- **`pip`** — a real `<video muted>` (inset 25–35% width, rounded corners, subtle shadow) on its
  planned track; src is a normal `./source/<scene_id>-<k>.mp4` clip; COUNTS against the video
  budget; `data-media-start="0"` like every scene clip.

### Subject compositing (`render_mode: "subject"`, schema 1.2 / v3.3)

A `subject` b-roll placement is a clip MATTED off its filmed background and composited over a
`backdrop` — a floating cut-out, not a rectangle. The engine pre-mattes it at COMPOSE entry
(hyperframes `remove-background`, content-hash cached) to an alpha `.webm` symlinked at
`./source/<scene_id>-<clip_index>.webm`; the subject's own `.mp4` clip stays at
`./source/<scene_id>-<clip_index>.mp4` (use it for **audio** — the matte `.webm` is visual-only).
Prefer a subject treatment on `podcast`/`cinematic` when a single speaker dominates the frame.
The `backdrop` is one of: `design_token` (a `target.design` palette key / `#hex` / CSS gradient),
`clip_ref` (another **ingested** clip), or `scene_base` (the scene's own clip) — **never** a
synthesized/stock/AI image (plan lint warns `PLAN_SUBJECT_BACKDROP_NOT_INGESTED`).

**If the matte is absent** (`vob_read_state_summary.subject_mattes.{skipped,unavailable,failed}` > 0
— model unavailable, host disabled, or over budget): fall back to a rectangular `pip` on the same
clip. Subject mode is advisory at COMPOSE QC (no `data-vob-overlay-id`-style hard binding), so a
fallback never fails QC.

**Path (a) — DEFAULT: alpha `<video>` over an HTML/CSS backdrop** (richest; full motion/captions on
the backdrop). The backdrop is pure CSS from `target.design`; the matte rides a higher track; the
subject audio is a separate `<audio class="clip">` from the `.mp4`:

```html
<div class="clip" id="bg" data-start="0" data-duration="6.5"
     style="background:linear-gradient(180deg,#111,#8B5CF6);"></div>
<video class="clip" id="subj" muted playsinline
       data-start="0" data-media-start="0" data-duration="6.5" data-track-index="1"
       style="position:absolute;inset:0;object-fit:contain;z-index:2;"
       src="./source/scene-03-0.webm"></video>
<audio class="clip" id="subj-a" data-start="0" data-media-start="0" data-duration="6.5"
       data-track-index="2" src="./source/scene-03-0.mp4"></audio>
```

This puts an (alpha VP9) `<video>` into the composition — the documented headless-Chrome
fragility. On a sub-10 GB host, prefer path (b).

**Path (b) — FALLBACK: ffmpeg composite (no browser `<video>`)**. Build it under `<session>/work/`
and record with `vob_import_deliverable`: generate the design-token backdrop (or use an ingested
`clip_ref`/`scene_base` clip as the base), composite the matte over it, mux the SUBJECT clip's
audio. `overlay-compositor.js::compositeOverlayOverBase` does exactly this (`overlay=format=auto`
preserves alpha; `audio:` = the subject `.mp4`); `buildBackdropArgv`/`generateBackdrop` makes the
solid/gradient backdrop. Steadier when the host is low-RAM, when alpha-`<video>` capture proves
fragile, or when the backdrop is itself a clip (clip-over-clip is cheaper in ffmpeg).

**Audio gotcha (both paths):** the matte `.webm` is silent — the subject's speech comes from the
`.mp4` clip; a `clip_ref`/`scene_base` backdrop clip is laid MUTED so the subject's audio wins.

### Multi-cell layout (`scene.layout` — split-screen / 2-up, v3.4)

The engine **pre-composites** a layout scene's cells into ONE clip at COMPOSE entry
(`./source/<scene_id>-layout.mp4`). When the scene is in your spawn's `layout_scenes_composited`
list, reference that single clip full-frame — one `<video>`, no per-cell elements:

```html
<video class="clip" src="./source/s003-layout.mp4" data-media-start="0" data-duration="6.0" data-track-index="0" muted="false"
       style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
```

**Fallback (scene in `layout_scenes_fell_back`):** the composite degraded, so render the cells
yourself as positioned `<video>` elements (a `split_vertical` 2-up = two clips, top/bottom). Keep
the speaker cell's audio; mute the rest. Costs N `<video>` elements — mind the budget.

```html
<!-- 2-up speaker stack fallback (cells 0 top, 1 bottom) -->
<video class="clip" src="./source/s003-0.mp4" data-media-start="0" data-duration="6.0" data-track-index="0"
       style="position:absolute;top:0;left:0;width:100%;height:50%;object-fit:cover"></video>
<video class="clip" src="./source/s003-1.mp4" data-media-start="0" data-duration="6.0" data-track-index="0" muted
       style="position:absolute;top:50%;left:0;width:100%;height:50%;object-fit:cover"></video>
```

### Caption binding (`caption_segments`)

A `caption_segment` carrying an `id` (or `exact:true`) is a **bound** caption — stamp the
implementing chunk div with `data-vob-caption-id="<id>"` plus `class="clip"` and its timing
(re-timed source→master):

```html
<div class="clip caption" data-vob-caption-id="cap-3"
     data-start="11.8" data-duration="1.0" data-track-index="3">and that's the secret</div>
```

- `exact:true` ⇒ the caption MUST be bound (QC errors `vob/caption_missing_element`); use exact
  text/timing verbatim.
- id-bearing, non-exact ⇒ bind it or QC warns `vob/caption_unbound` (it's advisory — drop the id
  if you legitimately re-chunk).
- **id-less `caption_segments` are freeform** — chunk and time them however reads best; no binding.
- One element per id; never stamp an id the plan didn't declare (`vob/unplanned_caption_element`).

### Caption components

**First choice for the everyday burned-in caption: the design-system kit's `caption` slot** (see
§Design system kit) — pure-CSS, token-driven (it reads `--vob-accent` for emphasis), renders
reliably, and matches the rest of the look. Reach for the GSAP `./captions/` kit below for an effect
the design-system caption can't do (notably true per-word `karaoke` fill).

The kit in `compose/captions/` realizes the `caption_segment.animation` enum. Read
`./captions/manifest.json` (placed next to `./fonts.css`), take the default component for the
segment's `animation` (or an alternate named by `style_ref` / `target.design`), and ADAPT the
chosen `./captions/<name>/<name>.html` reference — reproduce its technique, don't copy it. Three
adaptation rules apply to EVERY component: load fonts from `./fonts.css` (drop the reference's
`fonts.googleapis.com` `<link>` — it trips `google_fonts_import`; substitute the nearest kit family
when `font_in_kit` is `false`); keep any GSAP timeline at `window.__timelines["<composition-id>"]`
(`{paused:true}`); stamp `data-vob-caption-id="<id>"` on id-bearing segments (§Caption binding).

**`pop`** (default `caption-highlight`) — chunk-level. One timed `class="clip"` div per 3–5-word
chunk; the whole chunk pops in/out. No transcript needed.
```html
<div class="clip caption cap-pop" data-vob-caption-id="cap-2"
     data-start="10.2" data-duration="1.6" data-track-index="3">
  and that's the <span class="emph">whole</span> secret
</div>
```

**`word-by-word`** (default `caption-kinetic-slam`) — word-level; wants a real per-word transcript.
One `class="clip"` div per chunk; inside it, one `<span>` per word, each revealed/slammed on its own
word time. Drive word times from the matching `inspect/transcripts/file_<i>.json` entries
(`per_clip_transcripts`), re-timed source→master.

**`karaoke`** (default `caption-pill-karaoke`) — word-level fill-as-spoken; wants a per-word
transcript AND a GSAP timeline. Render the chunk on a pill, wrap each word in a `<span>`, and tween a
per-word highlight across them on the timeline:
```html
<div class="clip caption cap-karaoke" data-vob-caption-id="cap-7"
     data-start="14.0" data-duration="2.0" data-track-index="3">
  <span class="kw">wait</span> <span class="kw">for</span> <span class="kw">it</span>
</div>
```
```js
// per-word [{text,start,end}] inlined from per_clip_transcripts (source→master re-timed)
window.__timelines = window.__timelines || {};
window.__timelines["master"] = (window.__timelines["master"] || gsap.timeline({ paused: true }))
  .to(".cap-karaoke .kw:nth-child(1)", { duration: 0.01, className: "+=on" }, 14.0)
  .to(".cap-karaoke .kw:nth-child(2)", { duration: 0.01, className: "+=on" }, 14.6)
  .to(".cap-karaoke .kw:nth-child(3)", { duration: 0.01, className: "+=on" }, 15.2);
```

- **Emphasis words (REQUIRED when planned).** Render each `caption_segment.emphasis_words[]` word in a
  distinct `<span class="emph" data-vob-emphasis>…</span>` styled with the look's accent
  (`color: var(--vob-accent)` + heavier weight / slight scale). This is the highest-leverage caption
  detail — a caption with the load-bearing word popped in the brand accent reads as crafted, not
  generic. Emphasis stays ADVISORY at QC (no binding error), but a scope that plans `emphasis_words`
  and stamps zero `data-vob-emphasis` draws the `vob/caption_emphasis_generic` info note — realize it.
- **Karaoke wiring.** Inline the `[{text,start,end}]` per-word entries from `per_clip_transcripts`
  (re-timed source→master); register the highlight timeline at `window.__timelines["<comp-id>"]`
  (`{paused:true}`) — never play it. One word-span per word, in order.
- **NOT-ALIGNED fallback.** When the spawn's `transcript_aligned` is `false` (or
  `per_clip_transcripts` is `none`), word timing is approximate — DOWNGRADE `word-by-word`/`karaoke`
  to chunk-level `pop` (mirrors plan-lint `PLAN_CAPTION_KARAOKE_UNALIGNED`). Don't author a
  word-level component on an unaligned transcript.
- Captions stay ADVISORY at COMPOSE-QC (no hard binding beyond the id stamp); the only caption ERROR
  is the `exact:true` `vob/caption_missing_element` contract.

### Cold-open: punch-in + kinetic claim (scene 0, `purpose:"hook"`)

Scene 0 is the retention make-or-break; realize it with a PUNCH, never like a beat. Two parts:

**1. Punch-in on the scene video.** A CSS `transform: scale` settle (energy on the first frame),
scrubbed by the runtime — DURATION-EXACT (it paints over the scene's own frames; the master
`data-duration` is unchanged, exactly like a transition). `transform: scale` only — NEVER animate
`width`/`height` (anti-pattern). End at `scale(1.0)` so it's edge-safe under `object-fit: cover`.
Reuse the look's `motion` ease; a calmer video-type uses a slow push (`1.0→1.05`) instead of a punch.
```css
.punch-in { transform-origin: 50% 42%; animation: hook-punch 2.4s cubic-bezier(.2,.9,.2,1) both paused; }
@keyframes hook-punch { 0% { transform: scale(1.12); } 22% { transform: scale(1.0); } 100% { transform: scale(1.0); } }
```
(`animation-duration` == the scene's `data-duration`; `paused` + `both` so the runtime scrubs it.)

**2. Kinetic claim.** Adapt the design-system `cold_open` slot (`./design-system/manifest.json` →
`video_types[<vt>].slots.cold_open`): the hook LINE in large headline type, the load-bearing word in
`--vob-accent`. Stagger lines/words as SEPARATE `class="clip"` elements at increasing `data-start`
(NEVER `animation-delay`). Bind to the plan's `caption_segment` id if it carries one.
```html
<div id="s001-claim-1" class="clip cold-open-claim" data-start="0.10" data-duration="2.3" data-track-index="3">
  <span class="claim-line">Most dogs</span></div>
<div id="s001-claim-2" class="clip cold-open-claim" data-start="0.34" data-duration="2.06" data-track-index="3">
  <span class="claim-line"><span class="emph" data-vob-emphasis>never</span> do this</span></div>
```
The kinetic claim is just the strongest caption — the emphasis/accent/animation rules above all apply.

## Scene transition recipes (v3.3) — CSS `@keyframes`, NO GSAP

Realize `scene.transition_in` as a CSS `@keyframes` animation on the INCOMING scene element. hyperframes'
native **css adapter** scrubs a paused CSS animation deterministically to every rendered frame (per seek it
sets `animation-play-state: paused` and `animation-delay = -(T − element's data-start)s`, clamped at 0). So
**GSAP is not needed and is not loaded at render** — these recipes are verified 0 errors / 0 warnings on
hyperframes 0.6.97, and a crossfade renders to an MP4 of the exact expected duration. Contract:

- The animation goes on the timed scene element (the `<video>` clip — you may animate a `class="clip"`
  element directly; no wrapper needed). Use the marker attribute as the style hook:
  `[data-vob-transition="<type>"] { animation: <name> <dur>s <easing> both; animation-play-state: paused; }`.
- **`animation-fill-mode: both` is MANDATORY** — without it the element snaps to its un-animated state
  outside the active window and the scrub shows the wrong frame. Keep `animation-play-state: paused` too
  (the runtime sets both each seek; presetting them keeps a plain browser preview deterministic).
- **Duration-EXACT:** a transition only repaints frames the scenes already own. Never change the master
  root's `data-duration` (= Σ scene `target_duration_seconds`).
- No `requestAnimationFrame`, no `Math.random()`/`Date.now()` (the determinism rules — pure CSS needs none).
- The composition's `window.__timelines["<id>"]` stub must expose **`duration()` (returns the master
  seconds) and `pause()` (a method)** — the render driver calls them unconditionally; the inert stub bob
  already emits covers this. A stub missing `pause()` lints clean but dies at frame 0 ("zero duration").
- Stamp `data-vob-transition="<type>"` + `data-vob-transition-scene="<incoming scene_id>"` on the animated
  element (QC `vob/transition_not_realized` is advisory — these let it confirm the plan was realized).

Two patterns. **ENTRANCE** (push/slide/whip_pan/zoom_punch/iris/clock_wipe/shutter): the animation lives on
the incoming scene, anchored at its own `data-start` (= the cut). It animates over the first `dur` seconds of
the scene's natural window — `data-start`/`data-duration` unchanged, no extra concurrent `<video>`.
**OVERLAP** (crossfade/blur_dissolve/focus_pull): for a true dissolve both scenes must be on screen at once,
so pull the incoming's `data-start` back by `dur`, put it on a HIGHER `data-track-index`, and EXTEND its
`data-duration` by `dur` so it still ENDS at its natural time (master unchanged). Costs +1 concurrent
`<video>` for `dur` seconds — `deriveRenderPlan` already glues these scenes into one render chunk.

### crossfade — OVERLAP (boundary at 6s, dur 0.6s; outgoing scene ends at 6 on track 0)
```html
<style>
  @keyframes vob-crossfade-in { from { opacity: 0; } to { opacity: 1; } }
  [data-vob-transition="crossfade"] { animation: vob-crossfade-in 0.6s linear both; animation-play-state: paused; }
</style>
<!-- incoming: data-start = 6 − 0.6, data-duration = 3 + 0.6 (ends at 9, its natural end), higher track -->
<video id="s002-0-video" class="clip full-bleed" src="./source/s002-0.mp4" muted
       data-start="5.4" data-duration="3.6" data-track-index="1" data-media-start="0"
       data-vob-transition="crossfade" data-vob-transition-scene="s002"></video>
```
`blur_dissolve` = add `filter: blur(18px)`→`blur(0)` to the keyframes. `focus_pull` = blur only, no opacity.

### push / slide — ENTRANCE (`translateX/Y`; pick the axis from `direction`)
```html
<style>
  @keyframes vob-push-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
  [data-vob-transition="push"] { animation: vob-push-in 0.5s cubic-bezier(.22,1,.36,1) both; animation-play-state: paused; }
</style>
<video id="s002-0-video" class="clip full-bleed" src="./source/s002-0.mp4" muted
       data-start="6" data-duration="3" data-track-index="1" data-media-start="0"
       data-vob-transition="push" data-vob-transition-scene="s002"></video>
```

### whip_pan — ENTRANCE (`translateX` + `filter: blur()` smear that snaps into focus)
```html
<style>
  @keyframes vob-whip-in { 0% { transform: translateX(60%); filter: blur(24px); }
                           60% { transform: translateX(0); filter: blur(24px); }
                           100% { transform: translateX(0); filter: blur(0); } }
  [data-vob-transition="whip_pan"] { animation: vob-whip-in 0.35s cubic-bezier(.7,0,.3,1) both; animation-play-state: paused; }
</style>
```

### zoom_punch — ENTRANCE (`scale` + opacity reveal)
```html
<style>
  @keyframes vob-zoom-in { 0% { transform: scale(1.4); opacity: 0; } 40% { opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
  [data-vob-transition="zoom_punch"] { animation: vob-zoom-in 0.45s cubic-bezier(.2,.8,.2,1) both; animation-play-state: paused; transform-origin: 50% 50%; }
</style>
```

### iris / clock_wipe / shutter — ENTRANCE (`clip-path` reveal)
```html
<style>
  @keyframes vob-iris-in { from { clip-path: circle(0% at 50% 50%); } to { clip-path: circle(100% at 50% 50%); } }
  [data-vob-transition="iris"] { animation: vob-iris-in 0.55s ease-in-out both; animation-play-state: paused; }
</style>
```
(`circle(100%)` for full coverage; a smaller radius leaves a deliberate vignette. `clock_wipe` = animate a
conic `clip-path`/mask; `shutter` = `inset()` bars.)

### Shaders are GATED OFF in v3.3
`glitch`/`light_leak`/`chromatic`/`cross_warp`/`swirl` need `@hyperframes/shader-transitions` (Proprietary,
un-vendored) and never appear in your `transition_vocabulary`. If one is planned, or
`shader_transitions_allowed:false`, substitute the nearest CSS transition: `glitch`→`whip_pan`,
`light_leak`→`crossfade`, `chromatic`→`whip_pan`, `cross_warp`→`crossfade`, `swirl`→`zoom_punch`.

## Scene motion / punch-ins (v3.9) — CSS `scale`, NO GSAP

Realize `scene.motion` as a CSS `@keyframes` **transform** animation on the scene's `<video class="clip">`
element (or a wrapping clip element) — an intra-scene CAMERA MOVE on the A-roll spine (a punch-in / push-in /
slow Ken Burns drift over an otherwise-static talking head). It is THE no-b-roll visual-variety device.
hyperframes' native **css adapter** scrubs a paused CSS animation deterministically to every rendered frame
(per seek it sets `animation-play-state: paused` and `animation-delay = -(T − element's data-start)s`), so
**GSAP is not needed and is not loaded at render** — same proven, lint-clean approach as the scene-transition
recipes above. Contract (mirrors transitions):

- `transform: scale`/`translate` ONLY — **NEVER** animate `width`/`height` (the documented anti-pattern); end
  inside the frame so it stays edge-safe under `object-fit: cover`.
- **`animation-fill-mode: both` is MANDATORY** + keep `animation-play-state: paused` — without `both` the element
  snaps to its un-animated state outside the window and the scrub shows the wrong frame (the runtime sets both each
  seek; presetting them keeps a plain browser preview deterministic).
- **`animation-duration` == the element's `data-duration`** (or the motion window `end_seconds − start_seconds`).
- **Reuse the video_type's motion-preset ease** from `./design-system/manifest.json` (`video_types[<vt>].slots.motion`
  → fast-snap / medium-soft / slow-cinematic) so the move is TUNED to the format — a calmer video-type drifts slowly,
  a punchy one snaps.
- **DURATION-EXACT** (the load-bearing rule, same as transitions): a punch-in only re-paints frames the scene
  ALREADY owns — **never** change the scene's `data-duration` or the master root `data-duration`. Lengthening the
  timeline poisons drift verification.
- Set `transform-origin` to the focal point — the speaker, usually `50% 40%` (eye-line slightly above center).
- **ADVISORY QC marker** (like transitions, NOT a hard binding): stamp `data-vob-motion="<type>"` +
  `data-vob-motion-scene="<scene_id>"` on the animated element. There is NO QC error for motion — realize the
  intent your way; the marker is a courtesy.

Storyboard field shape: a string (`"punch_in"` | `"push_in"` | `"ken_burns"`; `"none"`/`"static"` = opt out) OR an
object `{ type, scale (1.0–2.0, default ~1.12), ease? (a motion-preset ease name), start_seconds?, end_seconds? }`
(the window is SCENE-relative; default = the whole scene). It is loose/fail-safe — a bad value never rejects the save
(plan-lint warns `PLAN_MOTION_INVALID`) and you fall back to a static frame.

### punch_in — a held push that snaps/eases early then HOLDS (emphasis on a key line)
```html
<style>
  /* animation-duration == the scene's data-duration; reuse the look's motion ease */
  @keyframes vob-punch-in { 0% { transform: scale(1.0); } 18% { transform: scale(1.12); } 100% { transform: scale(1.12); } }
  [data-vob-motion="punch_in"] { transform-origin: 50% 40%; animation: vob-punch-in 6s cubic-bezier(.2,.9,.2,1) both; animation-play-state: paused; }
</style>
<video id="s003-0-video" class="clip full-bleed" src="./source/s003-0.mp4" data-has-audio="true"
       data-start="8" data-duration="6" data-track-index="0" data-media-start="0"
       data-vob-motion="punch_in" data-vob-motion-scene="s003"></video>
```

### push_in — a slow continuous scale across the whole window (gentle life on a static head)
```css
@keyframes vob-push-in { from { transform: scale(1.0); } to { transform: scale(1.08); } }
[data-vob-motion="push_in"] { transform-origin: 50% 40%; animation: vob-push-in 6s linear both; animation-play-state: paused; }
```
(Linear for a continuous drift; swap the ease for the slow-cinematic preset on a cinematic look.)

### ken_burns — scale WITH a small translate drift (stills / long holds)
```css
@keyframes vob-ken-burns { from { transform: scale(1.05) translate(0, 0); } to { transform: scale(1.12) translate(-2%, -1.5%); } }
[data-vob-motion="ken_burns"] { transform-origin: 50% 40%; animation: vob-ken-burns 6s ease-in-out both; animation-play-state: paused; }
```
(The `scale ≥ 1.05` throughout hides the `translate` drift's exposed edges under `object-fit: cover`.)

A custom `{ scale }` overrides the `~1.12` peak; a `{ start_seconds, end_seconds }` window sets the
`animation-duration` (= the window length) on a wrapping `class="clip"` element timed to that sub-window
instead of the whole scene.

## Design system kit — component usage (v3.9)

The kit in `compose/design-system/` is your per-video-type visual system (titles, lower-thirds,
grades, motion presets, backdrops, callouts, end-cards). Read `./design-system/manifest.json`, take
`video_types[<your video_type>]` (fallback `general`) for the look's `principles[]` + slot component
names, set the `--vob-*` tokens from `target.design` ONCE on your root, then ADAPT the recommended
`./design-system/<name>/<name>.html` references. Three rules make a copied reference actually render:

- **Stagger with `data-start`, never `animation-delay`** — the css adapter sets
  `animation-delay = -(T − data-start)` per frame to scrub, so any delay you set is overwritten. Two
  title lines 0.13s apart = two `class="clip"` elements at `data-start` 0 and 0.13, each its own animation.
- **`animation-fill-mode: both` + `animation-play-state: paused`** on every animated clip;
  `animation-duration == data-duration`.
- **Substitute the reference's font** with `target.design.typography.*` via `./fonts.css`; keep colors
  on `var(--vob-*, <fallback>)`.

Per kind:
- **title** (`title_card` / `section_title`) — full-frame; headline in the headline family, accent
  emphasis line / rule; in→hold→out. Stamp `data-vob-overlay-id` if the plan declared the overlay.
- **lower_third** — anchored above `--vob-safe-bottom`; name + role; slide/fade in, hold `dwell_min_s`,
  exit before the cut. Bind the id if planned.
- **grade** — copy the reference's documented `filter:` onto the scene `<video class="clip">`; add its
  overlay layers (vignette / tint / grain) as full-frame `class="clip"` divs on HIGHER tracks. Use the
  look's grade; `grade-clean` for a "none" brief.
- **motion** — NOT an element: copy the preset's in/out eases + durations onto the entrances/exits you
  author elsewhere (titles, overlays, captions) so motion is consistent and video-type-tuned.
- **backdrop** — a full-frame `class="clip"` background for a title card, a `design_token` subject
  backdrop, or a b-roll gap; subtle motion is fine; keep it BEHIND content (low track).
- **callout / end_card** — adapt for the `callout` / `cta` / `end_card` overlay types; bind the id if planned.

Components are lint-clean by construction (`scripts/build-design-system.js` verifies each). They add
NO new QC codes — the usual rules apply (timed = `class="clip"` + id + timing; ≤6 `<video>`;
reference `target.design.typography` families, not system fonts).

---
If your code isn't here, `lint_report_path` is ground truth — fix what the report's
file/line/message says.
