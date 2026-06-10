# Lint + QC fix recipes
Read ONLY when your revision_notes carry one or more rule codes. Apply the canonical fix for
exactly those codes — do not guess.

## `timed_element_missing_clip_class`

The #1 cause of lint failure. Triggers when an element has `data-start` + `data-duration` but no `class="clip"`. Without `class="clip"`, the element is treated as static and visible for the entire composition instead of only during its scheduled window. (The engine's static QC pre-empts this as warning `vob/timed_element_missing_clip_class` at save time — same fix.)

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

## `media_missing_id`

Triggers when a `<video>` or `<audio>` element lacks an `id` attribute. Hyperframes uses the id to address media elements for seeking and discovery; without one, the linter can't reason about the element.

✗
```html
<video src="./source/s001-0.mp4" muted
       data-media-start="0" data-playback-start="0"></video>
```

✓
```html
<video id="scene-1-video"
       src="./source/s001-0.mp4" muted
       data-media-start="0" data-playback-start="0"></video>
```

Use stable, scene-anchored names: `scene-1-video`, `scene-2-audio`, `outro-bg`. Don't reuse ids across scenes.

## `video_missing_muted` (alias `media_audible_not_marked`)

Triggers when a `<video>` element with `data-start` is neither `muted` nor explicitly marked as audible. The lint message itself says: "Mark audible videos with `data-has-audio='true'`".

✗
```html
<video src="./source/s001-0.mp4" data-media-start="0" data-playback-start="0"></video>
```

✓ (silent visual — for b-roll without dialogue):
```html
<video src="./source/s001-0.mp4" muted
       data-media-start="0" data-playback-start="0"></video>
```

✓ (keep diegetic audio — for dialogue, native sound):
```html
<video src="./source/s001-0.mp4" data-has-audio="true"
       data-media-start="0" data-playback-start="0"></video>
```

Pick exactly one. Default to `muted` for non-dialogue clips; use `data-has-audio="true"` only when the brief calls for diegetic sound. Note: when intent.audio_treatment is `discard_audio`, scene clips are pre-cut with `-an` — no audio stream exists, so `data-has-audio="true"` is meaningless.

## `overlapping_clips_same_track` (related: `duplicate_media_discovery_risk`)

Triggers when two clips share identical `data-start` + `data-duration` on the same `data-track-index`. Hyperframes can't decide which to render and either picks one arbitrarily or flags as duplicate-discovery risk.

✗
```html
<div class="clip" data-start="5" data-duration="3" data-track-index="0">
  <video id="a" src="./source/s003-0.mp4" muted data-media-start="0"></video>
</div>
<div class="clip" data-start="5" data-duration="3" data-track-index="0">
  <video id="b" src="./source/s003-0.mp4" muted data-media-start="0"></video>
</div>
```

✓ (stagger timing):
```html
<div class="clip" data-start="5" data-duration="3" data-track-index="0">...</div>
<div class="clip" data-start="8" data-duration="3" data-track-index="0">...</div>
```

✓ (or move to a different track for an intentional overlay):
```html
<div class="clip" data-start="5" data-duration="3" data-track-index="0">...</div>
<div class="clip" data-start="5" data-duration="3" data-track-index="1">...</div>
```

## `font_family_without_font_face`

Triggers when CSS sets a non-generic `font-family` (custom fonts, system stacks like `-apple-system`) without a matching `@font-face` declaration in the document. Headless Chrome doesn't have the font cached; the render falls back and your typography breaks.

✗
```css
body { font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
```

✓ load the shipped kit and use a kit family:
```css
@import url("./fonts.css");
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
<div class="clip" data-start="0" data-duration="3" data-track-index="0">
  <video id="scene-1-video"
         src="./source/s001-0.mp4" muted
         data-media-start="0"
         data-playback-start="0"></video>
</div>
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
The root `data-duration` is shorter than the storyboard scene-duration sum. Set it ≥ the scene
sum or the timeline tail is silently truncated.

### `vob/scene_missing_clip` (error) / `vob/overlay_scene_missing_clip` (warning)
Every storyboard scene needs ≥1 clip element referencing `./source/<scene_id>-*.mp4`. Zero-video
overlay compositions get the warning form only — confirm the overlay-over-base path is intended.

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
