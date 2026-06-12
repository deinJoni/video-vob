# PACKAGE — assemble the shippable output, non-interactive
Spine rules 1, 8, 11 apply.

Packaging is deterministic — no user confirmation step. On success the user has a directory they
can ship as-is.

## Read sites
| step | source | fields |
|---|---|---|
| 1–2 | `vob_package_output` result | `directory_path, final_mp4_path, thumbnail_path, manifest_path, readme_path, packaged_at, iteration_version` |

> **Fan-out (the storyboard has `shorts[]`): skip steps 1–3.** The deliverables set IS the
> package — `vob_package_output` refuses on a fan-out project. Instead: read
> `deliverables/manifest.json` (regenerated on every import) and present the set — one line per
> short: title, duration, loudnorm applied/skipped, path under `deliverables/`. Then go to step 4
> (the PACKAGE → ITERATE gate passes on the recorded set; it blocks with
> `shorts_missing_deliverables` if any short lacks a record).

1. Call `vob_vob_package_output { project_id }`. On failure (ffmpeg missing, thumbnail
   extraction failed, render file missing) it throws — show the error and ask whether to retry,
   revise, or abort.

2. Report what was built: "packaged iteration v<iteration_version>:
   - `<final_mp4_path>` — the final video
   - `<thumbnail_path>` — frame extracted from the video
   - `<manifest_path>` — all metadata (target, duration, dimensions, source attribution, lineage)
   - `<readme_path>` — human-readable summary"
   Note that the audio was loudness-normalized to −14 LUFS (disable with `VOB_NO_LOUDNORM=1` and
   re-package if the user objects) and the thumbnail is pulled from the hook scene (fallback:
   10% mark). When the storyboard declared narrative `segments[]`, the manifest carries
   `chapters[]` and the README has a paste-ready **Chapters** block (`0:00 Title` lines for the
   YouTube description) — surface it. A segmented project packages its ASSEMBLED final exactly
   like a single render (the tool refuses if assembly is missing/stale — re-run
   `vob_assemble_video` first).

3. Optionally read the README and present a short excerpt (the Output and Lineage sections) so
   the user doesn't have to open the file.

4. Call `vob_vob_transition_phase { project_id, to_phase: "ITERATE" }`. PACKAGE → ITERATE
   is automatic on a successful package — the gate already verified all four package files are
   on disk.

5. PACKAGE does NOT mutate the render (beyond the audio-only loudness pass; the video stream is
   copied). `package/README.md` is generated from `package/manifest.json` engine-side — never
   author or edit it by hand (it's overwritten on the next package build).

## Escape hatch — recording externally-built finals (`vob_import_deliverable`)

(The PLANNED multi-short case is first-class now — see the **Fan-out** sections of the spine and
the COMPOSE/RENDER phase files; it uses this same tool with `short_id` per record. THIS section
is for work whose heavy lifting genuinely ran outside the FSM.)

Some jobs don't fit the single-timeline shape — most commonly a cut whose final was built outside
vob (e.g. an overlay composited over an ffmpeg-cut base because the hyperframes `<video>` render
path was too fragile on this host), shorts produced by a bespoke pipeline, or a render that ran
to completion out-of-band after OpenCode timed out the in-FSM render call. For those, do not let
`state.json` lie that the project is stuck at INGEST/INSPECT while finished clips exist on disk.
Record reality:

- **Scratch space:** bespoke ffmpeg/hyperframes work (cut/concat/speed-ramp bases, transparent
  overlay renders) is sanctioned ONLY under `~/video-vob-sessions/<project_id>/work/` — the
  session-guard plugin allows exactly that subtree (spine rule 8). Get the user's go-ahead before leaving
  the rails, and record every resulting final immediately below.
- **Register finished files:** `vob_vob_import_deliverable { project_id, deliverables:
  [{ path, title?, notes?, short_id? }, ...], normalize?: true }`. Each file is copied into the
  session's `deliverables/` dir, optionally loudness-normalized to −14 LUFS (`normalize:true` —
  the same pass `vob_package_output` runs; skip reasons are recorded per file), ffprobed, and
  recorded in `state.deliverables[]`; `deliverables/manifest.json` is regenerated as the set's
  manifest. Phase advances to PACKAGE (pass `set_phase:false` to record without changing phase).
  Give each file a distinct `title` so they don't stem-collide. After import you can transition
  PACKAGE → ITERATE and call `vob_finalize_iteration` to mark the project done — the ITERATE
  gate accepts external deliverables in lieu of a single-timeline package.
- **Overlay-over-base (first-class):** `vob_vob_import_deliverable { project_id,
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
