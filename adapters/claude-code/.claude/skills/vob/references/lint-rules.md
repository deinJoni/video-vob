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

---
If your code isn't here, `lint_report_path` is ground truth — fix what the report's
file/line/message says.
