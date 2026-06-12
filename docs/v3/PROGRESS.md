# v3.0 build progress — General Video

Tracking doc for the v3 build (see `PRD.md`). Updated as each pillar lands.
Branch: `v3/general-video`. Each pillar is committed separately and walker-verified.

| Pillar | Status | Walker phase | Commit |
|---|---|---|---|
| P1 — Format & presets | **done, walker-verified** | `general` | (this commit) |
| P2 — Segmented render + assembly | pending | `longform` | — |
| P3 — Overlay layer (schema 1.2) | pending | `overlays` | — |
| P4 — B-roll gaps + PLAN→INGEST | pending | `gaps` | — |
| Adapters (claude-code + opencode) | pending | boot drift guard | — |
| Version bump + docs + regression | pending | `setup`/`fanout` re-run | — |

Walker source for verification: `~/vob-share/hackabob_clips/01_hackabob_spa.mp4` (28.5s, speech).

---

## Design decisions (deltas / refinements vs the PRD)

Decisions made during implementation. PRD-locked decisions are not repeated here.

1. **Preset resolution is late-bound through one function.** `mcp/lib/video-types.js` exports
   `resolveActiveVideoType(state)` → `{ canonical, source, preset }` with precedence
   `VOB_VIDEO_TYPE` env > recorded `video_type` intent answer > derived from canonical
   platform + duration > `social-short`. The intent answer stores `{raw, canonical}` (+ preset
   snapshot for audit); an *unrecognized* free-text answer stores `canonical:null` so resolution
   falls through to derivation instead of pinning a wrong preset. Consumers (plan lint, summary,
   doctor, COMPOSE-entry segmentation) all call the one resolver — no `if (videoType)` sprawl.
2. **`video_type` is a third intent-key class: OPTIONAL.** Not required, not conditional —
   `missingIntentKeys` never reports it (PRD §7: no new required keys). It is recordable via
   `vob_record_intent_answer` like any key.
3. **Lint rulesets = per-rule disable sets + preset-gated extras, engine-side.** Defined in
   `video-types.js` (`retention`/`chaptered`/`montage`/`general`); `validateStoryboardContent`
   resolves the active ruleset from state. `PLAN_HOOK_NOT_FIRST`/`PLAN_HOOK_TOO_LONG` fire only
   under `retention`; `PLAN_CLIP_STRADDLES_REMOVED_SPAN` only when the preset's
   `editorial.clean_cut` is true; `chaptered` adds `PLAN_CHAPTERS_MISSING` (≥8 min, no
   `segments[]`) and `PLAN_SECTION_IMBALANCE`.
4. **fps reaches the render via the storyboard + QC, not a CLI flag.** Schema 1.2 adds optional
   `target.fps` (the storyboarder copies it from the platform profile). hyperframes reads fps
   from the composition root's `data-fps`; QC adds `vob/fps_mismatch` (warning) when
   `target.fps` ≠ master `data-fps` (absent attr = 30, the hyperframes default).
5. **Segment partials live OUTSIDE `renders/`** at `<session>/segment_renders/` — deviation from
   the PRD's `renders/segments/` path. Reason: the per-segment cycle runs RENDER→COMPOSE
   back-edges, and any back-edge out of RENDER auto-archives `renders/` (moves it to
   `archive/v<N>/`); partials under `renders/` would be swept away mid-cycle and dangle the
   registry. Mirrors the `deliverables/` precedent from fan-out. The *assembled* final still
   lands in `renders/final-<ts>.mp4` (archived correctly on iteration back-edges).
6. **No new args on the render tools.** `render_preview`/`render_full` render whatever
   `compose/` holds; the active segment is `composition.segment_id` (stamped by
   `save_composition`, mirroring `short_id`). `render_full` on an active segment writes the
   partial into `segment_renders/` and stamps BOTH the singleton `state.render` slot (so the
   existing preview/confirm machinery applies per segment unchanged) and the
   `state.segment_renders[segment_id]` registry entry. `vob_confirm_render` also marks the
   active segment's registry entry confirmed.
7. **Registry staleness = storyboard revision binding.** Each registry entry stamps
   `storyboard_revision` + the segment's `scene_ids`; `vob_assemble_video` treats an entry as
   missing when either no longer matches the current plan (re-saving the storyboard invalidates
   all partials — the plan changed).
8. **Assembly writes the singleton render slot.** `vob_assemble_video` stamps
   `state.assembly` AND sets `state.render` to the assembled final (confirmed:false,
   `composition_revision_rendered` = current composition revision), so RENDER→PACKAGE and
   `vob_package_output` work unchanged downstream. The RENDER→PACKAGE gate adds overridable
   `segments_missing_render` / `video_not_assembled` blockers; `vob_package_output` refuses on
   a segmented project until the assembled final IS the current render.
9. **Render-segmentation modes.** `single` (default — byte-for-byte v2.1 path, no segment
   machinery), `manual` (render segments = declared `segments[]`), `auto` (greedy chunking of
   consecutive scenes to the host `<video>` budget, respecting narrative boundaries when
   `segments[]` exist; collapses to `single` when one chunk suffices). Mode resolution:
   storyboard `render_segmentation` field > preset `render.segmentation` > `single`. The derived
   plan is stamped into `state.render_plan` at COMPOSE entry (like `transcoded_clips`).
10. **`segments[]` must contiguously partition `scenes[]`** in order, and are mutually exclusive
    with `shorts[]` (fan-out of segmented videos is out of scope, PRD §9.1). `shorts[]` is legal
    under schema 1.1 *or* 1.2 (a 1.2 fan-out doc may use typed overlays).
11. **Typed overlay elements are bound by `data-vob-overlay-id`.** The composer stamps the
    implementing element with the overlay's id; QC errors (`vob/overlay_missing_element`) when a
    planned typed overlay has no element — consistent with `vob/scene_missing_clip` severity.
12. **Audio bed MVP**: optional `music_path` on `vob_assemble_video`, sidechain-ducked under the
    program audio (`sidechaincompress` + `amix`), music looped/trimmed to program length, then
    the shared −14 LUFS two-pass on the final. No music → program audio passes through
    losslessly when all boundaries are hard cuts.

## Verification log

- **2026-06-12 — P1 verified.** `node scripts/m5-walker.js general` green end-to-end
  (derivation youtube+12min→long-form; free-text `video_type` canonicalization; env
  override; user preset file + doctor table/per-project resolution; chaptered save with
  hook warnings OFF + `PLAN_CHAPTERS_MISSING` ON; retention contrast on the same doc;
  `vob/fps_mismatch` fires without `data-fps` and clears with `data-fps="24"`, save-time
  merged lint `clean`). Regression: `setup` and `fanout` phases both green (derived
  `social-short` reproduces v2.1 retention lint byte-for-byte).
