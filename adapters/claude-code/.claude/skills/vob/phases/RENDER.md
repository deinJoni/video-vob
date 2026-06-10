# RENDER — full-quality render, surface progress, collect verdict
Spine rules 2, 7, 8, 10, 11 apply.

The full render is the expensive operation — the shippable MP4. Expect a few minutes to half an
hour depending on length and visual density. The tool blocks for the entire run; point the user
at the stderr log they can `tail -f` from another terminal.

## Read sites
| step | source | fields |
|---|---|---|
| 1 | `vob_read_state_summary` | `preview.render_duration_seconds` |
| 2–3 | `vob_render_full` result | `mp4_path, rendered_at, render_duration_seconds, file_size_bytes, stderr_log_path, revision_count, quality, composition_revision_rendered, verification{duration_seconds, width, height, has_audio, duration_drift_seconds, drift_exceeds_threshold}` |

1. Read `preview.render_duration_seconds` from `mcp__vob__vob_read_state_summary` (not a full
   read). Set expectations: "the draft preview took Ns; a full render typically takes 4–8× that.
   The tool blocks until done; I'll give you a log path you can `tail -f` for live progress."

2. Call `mcp__vob__vob_render_full { project_id }`. On failure it throws with the log path in
   the error fields — surface that path so the user can inspect the failure. Do not auto-retry —
   full-render failures usually indicate a real problem worth surfacing.

3. On success, print the absolute `mp4_path` and size: "full render done in
   <render_duration_seconds>s — <file_size_bytes/1e6>MB at `<mp4_path>`. Watch for things draft
   hides: color banding, audio sync, text legibility at full resolution." Check `verification`:
   if `drift_exceeds_threshold` is true (`duration_drift_seconds` > 0.5s), the engine flagged
   silent truncation — treat it as a FAILED render: surface the drift and go back to COMPOSE
   rather than asking the user to approve a truncated cut.

4. Wait for the user's verdict:
   - **Approve** → `mcp__vob__vob_confirm_render { project_id }`, then
     `mcp__vob__vob_transition_phase { project_id, to_phase: "PACKAGE" }`. Packaging is
     non-interactive and happens immediately.
   - **Revise the composition** → transition to COMPOSE. The server auto-archives the current
     `renders/` (and any `package/`) into `archive/v<N>/` — surface the `archived.paths` from
     the transition response (spine rule 10). Re-enter COMPOSE with the user's notes.
   - **Revise the plan** → same shape with `to_phase: "PLAN"`. Surface archive paths, re-enter
     PLAN.
   - **Re-render without changes** → loop to step 2. This resets `render.confirmed:false`; the
     user re-approves before PACKAGE unlocks.

5. The RENDER→PACKAGE gate requires `render.confirmed === true`, the file at `mp4_path` on disk,
   AND a render from the current composition revision (`render_stale_composition` blocks a stale
   one — re-render, never override). The server refuses `override_reason` on
   `render_not_confirmed` (non-overridable).

6. The gate can block with `ffmpeg_unavailable` if ffmpeg wasn't on PATH at INGEST. Tell the
   user: "ffmpeg is required for packaging. Install it (`brew install ffmpeg` on macOS,
   `apt-get install ffmpeg` on Debian/Ubuntu) and then re-run `vob_ingest_file`, or use
   `override_reason: 'installed ffmpeg since INGEST'` on the transition if you've already fixed
   it." This is the ONE sanctioned override (spine rule 2).
