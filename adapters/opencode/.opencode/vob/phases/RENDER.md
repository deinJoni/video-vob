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

1. Read `preview.render_duration_seconds` from `vob_vob_read_state_summary` (not a full
   read). Set expectations: "the draft preview took Ns; a full render typically takes 4–8× that.
   The tool blocks until done; I'll give you a log path you can `tail -f` for live progress."

2. Call `vob_vob_render_full { project_id }`. On failure it throws with the log path in
   the error fields — surface that path so the user can inspect the failure. Do not auto-retry —
   full-render failures usually indicate a real problem worth surfacing.

3. On success, print the absolute `mp4_path` and size: "full render done in
   <render_duration_seconds>s — <file_size_bytes/1e6>MB at `<mp4_path>`. Watch for things draft
   hides: color banding, audio sync, text legibility at full resolution." Check `verification`:
   if `drift_exceeds_threshold` is true (`duration_drift_seconds` > 0.5s), the engine flagged
   silent truncation — treat it as a FAILED render: surface the drift and go back to COMPOSE
   rather than asking the user to approve a truncated cut.

4. Wait for the user's verdict:
   - **Approve** → `vob_vob_confirm_render { project_id }`, then
     `vob_vob_transition_phase { project_id, to_phase: "PACKAGE" }`. Packaging is
     non-interactive and happens immediately. **Fan-out: do NOT transition yet — go to step 4b.**
   - **Revise the composition** → transition to COMPOSE. The server auto-archives the current
     `renders/` (and any `package/`) into `archive/v<N>/` — surface the `archived.paths` from
     the transition response (spine rule 10). Re-enter COMPOSE with the user's notes.
   - **Revise the plan** → same shape with `to_phase: "PLAN"`. Surface archive paths, re-enter
     PLAN.
   - **Re-render without changes** → loop to step 2. This resets `render.confirmed:false`; the
     user re-approves before PACKAGE unlocks.

4b. **Fan-out record-then-loop** (the storyboard has `shorts[]`). After `vob_vob_confirm_render`:
   1. Record the finished short:
      `vob_vob_import_deliverable { project_id, deliverables: [{ path: <mp4_path>, title:
      "<short title>", short_id: "<active short_id>" }], normalize: true, set_phase: false }`.
      `normalize:true` applies the −14 LUFS pass the single-timeline package would have; the
      record (merged by `short_id`) is what marks this short DONE.
   2. **More shorts left** (any short without a deliverable record) → transition
      `RENDER → COMPOSE` (auto-archives `renders/` — the deliverable copy is already safe;
      surface `archived.paths`) and re-enter COMPOSE for the next active short.
   3. **All shorts recorded** → `vob_vob_transition_phase { project_id, to_phase: "PACKAGE" }`. The gate blocks
      with `shorts_missing_deliverables` (listing the missing `short_ids`) if a record is
      missing — record it or back-edge to produce it; override ONLY when the user explicitly
      wants to ship a partial set.

4c. **Segmented cycle-then-assemble** (the summary has `render_plan.mode: "segmented"`). The
   render you just ran produced a PARTIAL — the result carries `segment_id` and the mp4 lives
   under `segment_renders/` (registry-recorded, archival-safe). After `vob_confirm_render` (it
   also marks the segment's registry row confirmed):
   1. **More segments left** (any `render_plan.segments[]` row with `rendered: false` or
      `stale: true`) → transition `RENDER → COMPOSE` (auto-archives `renders/`; the partial is
      NOT under `renders/`, so it survives by construction) and re-enter COMPOSE for the next
      active segment.
   2. **All segments rendered** → `vob_vob_assemble_video { project_id }` (optional:
      `music_path` lays a looped, sidechain-ducked master music bed; `music_gain_db` default
      −12). It joins the partials in plan order — lossless concat for hard cuts, a
      duration-preserving 0.25s dip-to-black per `fade` boundary — ffprobe-verifies the joined
      duration vs the plan total (treat `drift_exceeds_threshold` as a FAILED assembly), and the
      assembled final BECOMES the render slot (confirmed:false). Surface `final_path` +
      `verification` + which path it took (`concat_path: "copy"` = lossless).
   3. The user reviews the ASSEMBLED final → `vob_vob_confirm_render` → transition to
      PACKAGE. The gate blocks with `segments_missing_render` (a partial is missing/stale — its
      message lists which; re-render those) or `video_not_assembled` (a segment was re-rendered
      after the last assembly — re-run `vob_assemble_video`); both are overridable only for a
      deliberate partial ship.
   4. **Revising one segment later:** back-edge `RENDER → COMPOSE`, recompose/render exactly
      that `segment_id`, then re-assemble (step 2) — a fresh partial invalidates the prior
      assembly automatically.

5. The RENDER→PACKAGE gate requires `render.confirmed === true`, the file at `mp4_path` on disk,
   AND a render from the current composition revision (`render_stale_composition` blocks a stale
   one — re-render, never override). The server refuses `override_reason` on
   `render_not_confirmed` (non-overridable).

6. The gate can block with `ffmpeg_unavailable` if ffmpeg wasn't on PATH at INGEST. Tell the
   user: "ffmpeg is required for packaging. Install it (`brew install ffmpeg` on macOS,
   `apt-get install ffmpeg` on Debian/Ubuntu) and then re-run `vob_ingest_file`, or use
   `override_reason: 'installed ffmpeg since INGEST'` on the transition if you've already fixed
   it." This is the ONE sanctioned override (spine rule 2).

> **OpenCode note on long renders.** OpenCode bounds how long a single MCP tool call may run, and
> that ceiling can be shorter than a full render (≤30 min) or a long INSPECT. If
> `vob_vob_render_full` / `vob_vob_render_preview` is killed by OpenCode (not by hyperframes)
> before completing, the render is still progressing in the log; tell the user, point them at the
> `stderr_log_path`, and either retry or — for a render you've run out-of-band to completion —
> record the finished file with `vob_vob_import_deliverable` (see the escape hatch in
> `.opencode/vob/phases/PACKAGE.md`). Raise OpenCode's MCP timeout if your version honors it
> (`mcp.vob.timeout` is set high in `opencode.json`, but some versions cap execution separately).
> The same hatch applies when repeated attempts die in the BROWSER (`Target closed`, `Protocol
> error`, BeginFrame/ready timeouts) rather than in the composition — offer the overlay-over-base
> path from that section and ask the user first: it leaves the single-timeline FSM.
