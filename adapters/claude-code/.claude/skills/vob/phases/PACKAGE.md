# PACKAGE — assemble the shippable output, non-interactive
Spine rules 1, 8, 11 apply.

Packaging is deterministic — no user confirmation step. On success the user has a directory they
can ship as-is.

## Read sites
| step | source | fields |
|---|---|---|
| 1–2 | `vob_package_output` result | `directory_path, final_mp4_path, thumbnail_path, manifest_path, readme_path, packaged_at, iteration_version` |

1. Call `mcp__vob__vob_package_output { project_id }`. On failure (ffmpeg missing, thumbnail
   extraction failed, render file missing) it throws — show the error and ask whether to retry,
   revise, or abort.

2. Report what was built: "packaged iteration v<iteration_version>:
   - `<final_mp4_path>` — the final video
   - `<thumbnail_path>` — frame extracted from the video
   - `<manifest_path>` — all metadata (target, duration, dimensions, source attribution, lineage)
   - `<readme_path>` — human-readable summary"
   Note that the audio was loudness-normalized to −14 LUFS (disable with `VOB_NO_LOUDNORM=1` and
   re-package if the user objects) and the thumbnail is pulled from the hook scene (fallback:
   10% mark).

3. Optionally `Read` the README and present a short excerpt (the Output and Lineage sections) so
   the user doesn't have to open the file.

4. Call `mcp__vob__vob_transition_phase { project_id, to_phase: "ITERATE" }`. PACKAGE → ITERATE
   is automatic on a successful package — the gate already verified all four package files are
   on disk.

5. PACKAGE does NOT mutate the render (beyond the audio-only loudness pass; the video stream is
   copied). `package/README.md` is generated from `package/manifest.json` engine-side — never
   author or edit it by hand (it's overwritten on the next package build).

## Escape hatch — recording externally-built finals (`vob_import_deliverable`)

The single-timeline FSM produces ONE assemble-edit final. Some jobs don't fit that shape — most
commonly a **clip fan-out** (one long source → N independent vertical shorts) or a cut whose
final was built outside vob (e.g. an overlay composited over an ffmpeg-cut base because the
hyperframes `<video>` render path was too fragile on this host). For those, do not let
`state.json` lie that the project is stuck at INGEST/INSPECT while finished clips exist on disk.
Record reality:

- **Register finished files:** `mcp__vob__vob_import_deliverable { project_id, deliverables:
  [{ path, title?, notes? }, ...] }`. Each file is copied into the session's `deliverables/`
  dir, ffprobed, and recorded in `state.deliverables[]`; phase advances to PACKAGE (pass
  `set_phase:false` to record without changing phase). Use this for the fan-out case — call it
  once with all N shorts (give each a distinct `title` so they don't stem-collide), or
  incrementally as they're produced. After import you can transition PACKAGE → ITERATE and call
  `vob_finalize_iteration` to mark the project done — the ITERATE gate accepts external
  deliverables in lieu of a single-timeline package.
- **Overlay-over-base (first-class):** `mcp__vob__vob_import_deliverable { project_id,
  composite: { base, overlay, audio?, scale_to_base?, title?, notes? } }`. This composites a transparent
  `overlay` over an opaque `base` via ffmpeg (muxing the base audio by default) and records the
  result as a deliverable. This is the supported fallback when continuous `<video>` capture dies
  mid-render — render the graphics as a transparent overlay (no `<video>` in the composition),
  cut the base with ffmpeg, then composite here. No Docker, no browser continuous-capture.
  Building the overlay through the FSM works: a composition with zero `<video>` elements is
  accepted by `vob_save_composition` — composition QC downgrades the scene-coverage error to a
  `vob/overlay_scene_missing_clip` warning for zero-video compositions, so the overlay renders
  through the normal COMPOSE→PREVIEW path before you cut the base with ffmpeg and composite
  here.

This is deliberately out-of-band: it does not touch the single-timeline
composition/render/preview slots, and it writes an `external_deliverables_imported` history
entry for audit. Prefer the normal FSM when the job fits it; reach for this when it genuinely
doesn't.
