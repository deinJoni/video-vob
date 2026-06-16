# PREVIEW — render a draft, surface the file, collect verdict
Spine rules 2, 7, 8, 10, 11 apply.

The preview is a draft-quality render produced via the render tool. You run it, surface the MP4
path, and wait for the user to open it in an external player — you cannot display video in chat.

## Read sites
| step | source | fields |
|---|---|---|
| 2–3 | `vob_render_preview` result | `render_path, render_duration_seconds, stderr_log_path, revision_count, composition_revision_rendered, verification{duration_seconds, width, height, has_audio, duration_drift_seconds, drift_exceeds_threshold}` |
| 3b | `vob_snapshot_keyframes` result | `still_paths, contact_sheet_path` |

1. Tell the user a render is starting. Expect minutes, not seconds: a 20–30s vertical typically
   takes 2–10 minutes on the reference 8GB host (software GPU, 1 worker); the call blocks up to
   the duration-scaled timeout. Point the user at `stderr_log_path` for `tail -f` progress.
   **Fan-out:** before rendering, verify the summary's `composition.short_id` equals the active
   short (COMPOSE.md defines the rule) — if it doesn't, you're about to render the WRONG short:
   back-edge to COMPOSE and compose the active short first. Tell the user which short this
   preview is ("previewing short k of N: <short_id>").
   **Segmented render:** same check against `composition.segment_id` vs the active segment
   (COMPOSE.md defines the rule). The preview renders ONE segment; its drift verification is
   scoped to the segment's target, not the document total. Say which segment this is
   ("previewing segment k of N: <segment_id>").

2. Call `vob_vob_render_preview { project_id }`. On failure it throws — show a
   one-paragraph summary of the stderr (the error message includes the relevant tail) and ask
   whether to revise the composition (back-edge to COMPOSE with their notes) or retry unchanged.
   Do not auto-retry — render failures usually indicate a real problem.
   If repeated attempts die in the BROWSER (`Target closed`, `Protocol error`, BeginFrame/ready
   timeouts) rather than in the composition, offer the overlay-over-base escape hatch —
   `.opencode/vob/phases/PACKAGE.md` §Escape hatch (`vob_import_deliverable`) — and ask the user first: it
   leaves the single-timeline FSM.

3. On success, print the absolute `render_path`: "preview rendered in
   <render_duration_seconds>s. Open it in any video player: `<render_path>`. I can't display
   video here — open it yourself and tell me what you think." Check the result's `verification`:
   if `drift_exceeds_threshold` is true (`duration_drift_seconds` > 0.5s vs the storyboard), the
   engine flagged silent truncation — treat it as a FAILED preview: surface the drift and go
   back to COMPOSE rather than asking the user to approve a truncated cut.

3b. **Surface full-resolution key-frame stills for the USER.** A draft render hides text
   legibility and fps-dependent motion. Call `vob_vob_snapshot_keyframes { project_id,
   timecodes }` with the cumulative start of each scene plus any explicit `key_moments`
   timecodes — dedupe and cap the list at 8 so hyperframes writes a single contact sheet (omit
   `timecodes` to default to one frame per storyboard scene). You already QC'd the contact sheet
   in COMPOSE's self-QC — this pass is for the user's eyes: surface `still_paths` +
   `contact_sheet_path` (may be `null` — fall back to `still_paths`), don't re-run the checklist. Blocks ~10–60s. On failure, surface it but
   don't block the verdict — the draft MP4 is the primary review artifact.

4. Wait for the user's verdict:
   - **Approve** → `vob_vob_confirm_preview { project_id }`, then
     `vob_vob_transition_phase { project_id, to_phase: "RENDER" }`.
   - **Revise the composition** → transition to COMPOSE and re-enter that phase with the user's
     notes as `revision_notes` on the next composer invocation.
   - **Revise the plan** → transition to PLAN. If the user wants INTENT, they get there via
     PLAN's own back-edge — never skip multiple edges in one call.
   - **Re-render without changes** → loop to step 2; the new render resets `preview.confirmed`
     and the user approves again.

5. The server resets `preview.confirmed` and `render.confirmed` when composition files change,
   and the PREVIEW→RENDER gate additionally blocks a preview rendered from a stale composition
   revision (`preview_stale_composition`). If it blocks, re-render the preview — never override.
   The server refuses `override_reason` on `preview_not_confirmed` (non-overridable); the gate
   also requires the file at `render_path` to exist on disk.
