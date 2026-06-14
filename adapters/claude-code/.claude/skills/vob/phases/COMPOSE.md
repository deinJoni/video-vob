# COMPOSE — delegate to the composer, lint + QC, self-QC, transition
Spine rules 5, 6, 8, 9, 11 apply.

The composition is hyperframes-compatible HTML/CSS/JS. You never write it yourself — you delegate
to the `composer` subagent; linting, snapshots, and transitions stay with you.

## Read sites
| step | source | fields |
|---|---|---|
| 2 | `vob_read_state_summary` | `storyboard.artifact_path`, `brief.path`, `manifest.path`, `composition.*`, `inspect.{transcript_path,clean_speech_path,transcript_aligned}`, `platform{...}`, `intent.answers`, `style.derived_from` |
| 5 | composer-relayed save verdict; `vob_read_state_summary` `composition.{lint_status,lint_report_path}`; `vob_lint_composition` (fallback only) | `lint_status, error_count, warning_count, qc_error_count, qc_warning_count, findings_summary[≤10], report_path` |
| 6 | `vob_snapshot_keyframes` result | `still_paths, contact_sheet_path, snapshots_dir` |

1. **Transition with a warning.** Tell the user the transition pre-cuts scene clips (first entry
   from PLAN typically 5–30s per scene; back-edge re-entry is cached, see spine rule 9), then
   call `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }`. On failure from a
   bad `out_seconds` in a `source_clips[i]`, the user stays in PLAN — surface the failing
   `scene_id`/`clip_index` and ask them to revise the storyboard.

2. If `composition` already exists in the summary (back-edge or re-entry), ask whether they want
   a fresh composition or to keep the existing files — only proceed to step 3 for a new pass.

   **Fan-out (the storyboard has `shorts[]`):** first determine the **active short**:
   - the first short in storyboard order with no record in the summary's `deliverables[]`
     (match on `short_id`);
   - if EVERY short has a record (a revision pass from ITERATE), the short the user named —
     carried in conversation from ITERATE.md. On a RESUME mid-revision where you don't have the
     user's pick but `composition.short_id` is set, that IS the in-flight short — use it; only
     ask which short to revise when the composition slot is empty or predates the fan-out.
   When the summary's `composition.short_id` differs from the active short, the existing files
   implement ANOTHER short — a fresh composer pass is MANDATORY (never offer "keep"). The
   keep-or-fresh question above applies only when `composition.short_id` matches the active
   short. Tell the user the progress ("composing short k of N: <short_id> — <title>").

   **Segmented render (the summary has `render_plan.mode: "segmented"`):** the same active-unit
   rule with segments — the **active segment** is the first row in `render_plan.segments[]`
   (plan order) with `rendered: false` (a `stale: true` row counts as un-rendered — its partial
   predates the current storyboard). If EVERY segment is rendered, it's a revision pass: use the
   segment the user named, or `composition.segment_id` on a resume. When `composition.segment_id`
   differs from the active segment, a fresh composer pass is MANDATORY. The composer spawn gets
   `segment_id: <active>` and `vob_save_composition` REQUIRES it; QC scopes to that segment's
   scenes (refs into other segments' clips warn `vob/cross_segment_clip_ref`). Tell the user the
   progress ("composing segment k of N: <segment_id> — <title>"). Typed overlays planned on the
   segment's scenes are BINDING: the composer must implement each and stamp
   `data-vob-overlay-id` (QC errors `vob/overlay_missing_element` otherwise).

3. **Delegate.** Record the invocation first: `mcp__vob__vob_log_composer_invocation
   { project_id, revision_notes? }` — omit `revision_notes` on the very first invocation; pass
   the user's exact words on a user-driven revision; pass rule codes on a lint/QC auto-retry.
   Spawn prompt is DATA-ONLY (no behavioral clauses — the agent .md owns behavior; if you are
   tempted to add an instruction, it belongs in the agent file). Fields with no value are passed
   as the literal string `none`:
   ```
   Task(subagent_type: "composer",
        description: "Hyperframes composition",
        prompt: "DATA
   project_id: <project_id>
   session_dir: ~/video-vob-sessions/<project_id>/
   storyboard_path: <storyboard.artifact_path>
   short_id: <active short_id | none>            (fan-out only: compose ONLY this short)
   segment_id: <active segment_id | none>        (segmented render only: compose ONLY this render segment — pass it to vob_save_composition)
   segment_scene_ids: <the active segment's scene_ids, comma-joined | none>
   brief_path: <brief.path>                      (its Design language section is BINDING)
   manifest_path: <manifest.path>
   transcript_path: <inspect.transcript_path | none>
   clean_speech_path: <inspect.clean_speech_path | none>
   transcript_aligned: <inspect.transcript_aligned true|false>
   per_clip_transcripts: <comma-joined inspect/transcripts/file_<i>.json for the active scenes' clips | none>
   intent.target_platform: <canonical>
   intent.platform_profile: width=<w> height=<h> fps=<fps> safe_top_px=<t> safe_bottom_px=<b>
   intent.caption_defaults: anchor=<anchor> offset_px=<offset_px> min_font_px=<min_font_px> max_words_per_line=<max_words_per_line>
   intent.tone: <tone>
   intent.music_vo: <music_vo>
   intent.audio_treatment: <value | n/a>
   intent.captions_style: <value | n/a>
   transition_vocabulary: <summary.video_type.transition_vocabulary, comma-joined>   (realize scene.transition_in ONLY from this list — see Scene transitions)
   shader_transitions_allowed: <summary.video_type.shader_transitions_allowed true|false>   (false ⇒ substitute the nearest CSS transition for any shader type)
   fonts: ./fonts.css + ./fonts/ are present in compose/ (kit table in your instructions)
   style_source: <derived_from | none>
   style_source_compose: ~/video-vob-sessions/<derived_from>/compose/index.html | none
   style_source_brief: ~/video-vob-sessions/<derived_from>/brief.md | none
   prior_composition_files: <relative paths | none>
   revision_notes: <user words, lint/QC codes, or self-QC findings | none>
   lint_report_path: <composition.lint_report_path | none>
   Follow your agent instructions.")
   ```

   `transcript_aligned` is ALWAYS passed (it is the composer's not-aligned fallback trigger —
   when `false`, the composer downgrades any word-by-word/karaoke caption to chunk-level `pop`).
   `per_clip_transcripts` is conditional: populate it ONLY when the active scope (the whole
   document, or the active short/segment) has ANY `caption_segment` whose `animation` is
   `word-by-word` or `karaoke` — those word-level components want a real per-word transcript;
   otherwise pass `none`. The `file_<i>` index is the manifest file index of each active scene's
   clips (`source_clips[].manifest_file_index`); `inspect/transcripts/file_<i>.json` is the
   per-file transcript path emitted by INSPECT. De-dupe the indices across the active scenes' clips.

4. **Save-time QC rejection branch.** If the composer reports `vob_save_composition` rejected
   with QC findings (`details.qc_findings`), that is the same auto-retry path as lint errors
   below — re-invoke with the findings' rule codes as `revision_notes` (plus, when the rejection
   carries `details.valid_source_refs` for unresolved `./source/` refs, its `scene_clips` list
   verbatim — that is data, not findings prose) and count it against the lint-retry budget.

5. **Lint verdict.** Every accepted save already ran the merged lint (hyperframes + engine QC)
   and stamped `composition.lint_status` — the composer self-corrects errors in-invocation
   (≤3 saves) and reports its final verdict. Take `lint_status` from the composer's report
   (confirm via `vob_read_state_summary` when in doubt — never from memory). Call
   `mcp__vob__vob_lint_composition { project_id }` yourself ONLY when `lint_status` is
   `unknown` (the save-time lint infra-failed — e.g. missing binary, timeout) or the
   composer's report is missing/garbled. Branch on `lint_status`:
   - **`clean`** → go to step 6 (self-QC) before presenting anything.
   - **`warnings_only`** → show the warning summary (`findings_summary`, or `report_path` for
     the full list). Ask: "the linter flagged N warning(s); fix them, or accept and proceed?"
     - **Accept** → step 6 (self-QC), then present.
     - **Fix** → loop to step 3 with `revision_notes` = rule codes + file/line list +
       `report_path` — never paste full findings prose (the composer reads the report itself).
     - The user may also choose **revise** (their own notes) or **back to the plan**.
   - **`errors`** — the composer already burned its in-invocation save budget on these; do NOT
     surface to the user yet; auto-retry. Re-invoke the composer (step 3) with `revision_notes`
     = rule codes + file/line list + `report_path`. After **3** consecutive auto-retries
     (re-spawns) without reaching `clean`/`warnings_only`, stop, surface the latest report, and
     ask: revise (user notes), back-edge to PLAN, or abort.

### Self-QC — snapshot review BEFORE the user sees anything
Run after lint returns `clean`, or after the user has accepted `warnings_only`. Budget: ≤2
self-QC rounds per COMPOSE pass (count rounds in-conversation; a round = one composer re-spawn
caused by this checklist). The lint ≤3 retry budget is separate and lint always settles first:
if a self-QC fix introduces lint errors, those consume lint retries; when lint is clean again,
resume self-QC at the SAME round count.

1. Compute snapshot timecodes from the storyboard (cumulative scene starts; fan-out: the ACTIVE
   short's scenes only — the composition implements just that timeline):
   - hook frame: hook-scene start + min(0.5, scene_duration/2) seconds — always include;
   - caption-dense: midpoint of the first caption window of every scene with captions (cap 3);
   - boundaries: every scene start + 0.2s (cap to fill);
   - dedupe within 0.5s; hard cap 8 (priority: hook > captions > boundaries).
2. `mcp__vob__vob_snapshot_keyframes { project_id, timecodes }` (works in COMPOSE — needs only
   a saved composition). ALWAYS Read two stills at FULL resolution: the hook frame and the first
   caption-dense still (each ≈1.1–1.6k image tokens — cheap insurance against a wasted preview
   render; contact-sheet cells are too small after the vision downscale to judge caption
   legibility, safe-band margins, or collisions). Read `contact_sheet_path` for the
   letterbox/layout sweep (QC-F). Read up to 2 MORE stills to confirm suspected failures —
   singles budget 4 per round.
2b. `mcp__vob__vob_qc_stills { project_id, timecodes }` — pass the SAME `timecodes`. This is
   automated **QC-C**: it luma-scans every still and returns `glaring` findings `qc/still_black`
   / `qc/still_blown_out` (a frame that rendered with NO visible content — a dropped clip, a
   timed-out seek, a blank/blown scene) plus a `taste` `qc/still_flat`. Pure ffprobe, ~1–3s,
   advisory (gates nothing). Read its `findings` instead of eyeballing every contact-sheet cell
   for black frames: a `glaring` finding is a step-4 GLARING item — re-spawn the composer citing
   the finding's `code` + `timecode_seconds`. Carry `qc/still_flat` into the taste notes only if
   it lands mid-scene (a solid title card is legitimately flat).
3. Judge QC-A/QC-B/QC-D/QC-E on the full-res stills; judge QC-F on every contact-sheet cell
   (QC-C is automated in step 2b — read `vob_qc_stills` findings). The checklist:
   - QC-A captions inside the safe band (not in the top safe_top_px / bottom safe_bottom_px of
     the frame; nothing clipped at frame edges)
   - QC-B caption legibility: readable contrast against what's behind it, ≤2 lines, not
     overlapping other text
   - QC-C no black/empty/half-loaded frames at any sampled timecode — **automated by step 2b**
     (`vob_qc_stills`); trust its findings rather than re-judging every cell by eye
   - QC-D no overlay collisions (overlay text over captions or over the speaker's face)
   - QC-E the hook frame is actually striking: subject visible, not motion-smeared, text hook
     legible at thumbnail size
   - QC-F aspect/framing accidents: unintended letterboxing, wrong dimensions, subject cropped
     out by object-fit
4. GLARING (auto-fix without asking): any QC-A/QC-C/QC-F failure (QC-C = a `vob_qc_stills`
   `glaring` finding); QC-B unreadable (not merely suboptimal); QC-D hard overlap. →
   `vob_log_composer_invocation` with `revision_notes` =
   `"self-QC round <n>: <QC-code> at t=<s>s — <what is wrong, one line each>"`, re-spawn the
   composer, re-lint, then re-snapshot ONLY the timecodes that failed (plus the hook frame).
   Safe bands and the 56px caption floor are hard constraints even against an explicit user
   `captions_style` — if a glaring fix overrides a user choice, say so when you present.
5. TASTE (never auto-fix; note for the user): font/palette feel, hook framing aesthetics,
   overlay density, pacing feel, caption position preferences within the safe band. Carry these
   as one short "things you might want changed" list when you present.
6. After 2 rounds — or a clean pass — present to the user: file list, total duration, the
   contact sheet path, any remaining taste notes, any UNRESOLVED glaring item flagged
   prominently. Then the normal approve / revise / back-to-plan branch.

7. **Verdict branches:**
   - **Approve** → `mcp__vob__vob_transition_phase { project_id, to_phase: "PREVIEW" }`. (There
     is no separate confirm tool — clean lint + the user's explicit approval + the transition is
     the confirmation. The gate rejects `errors`/`unknown` lint.)
   - **Revise** ("tighten scene 3", "title too small") → loop to step 3 with the user's note as
     `revision_notes`.
   - **Back to the plan** → `mcp__vob__vob_transition_phase { project_id, to_phase: "PLAN" }`
     and re-enter PLAN.

8. If the composer errors out of band twice in a row (validation failure after one retry),
   surface the blocker and stop — never fabricate composition files yourself, and never invoke
   hyperframes directly (spine rule 8).
