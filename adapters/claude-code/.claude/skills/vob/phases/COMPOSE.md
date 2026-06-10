# COMPOSE — delegate to the composer, lint + QC, self-QC, transition
Spine rules 5, 6, 8, 9, 11 apply.

The composition is hyperframes-compatible HTML/CSS/JS. You never write it yourself — you delegate
to the `composer` subagent; linting, snapshots, and transitions stay with you.

## Read sites
| step | source | fields |
|---|---|---|
| 2 | `vob_read_state_summary` | `storyboard.artifact_path`, `brief.path`, `manifest.path`, `composition.*`, `inspect.{transcript_path,clean_speech_path}`, `platform{...}`, `intent.answers`, `style.derived_from` |
| 5 | `vob_lint_composition` result | `lint_status, error_count, warning_count, qc_error_count, qc_warning_count, findings_summary[≤10], report_path` |
| 6 | `vob_snapshot_keyframes` result | `still_paths, contact_sheet_path, snapshots_dir` |

1. **Transition with a warning.** Tell the user the transition pre-cuts scene clips (first entry
   from PLAN typically 5–30s per scene; back-edge re-entry is cached, see spine rule 9), then
   call `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }`. On failure from a
   bad `out_seconds` in a `source_clips[i]`, the user stays in PLAN — surface the failing
   `scene_id`/`clip_index` and ask them to revise the storyboard.

2. If `composition` already exists in the summary (back-edge or re-entry), ask whether they want
   a fresh composition or to keep the existing files — only proceed to step 3 for a new pass.

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
   brief_path: <brief.path>                      (its Design language section is BINDING)
   manifest_path: <manifest.path>
   transcript_path: <inspect.transcript_path | none>
   clean_speech_path: <inspect.clean_speech_path | none>
   intent.target_platform: <canonical>
   intent.platform_profile: width=<w> height=<h> fps=<fps> safe_top_px=<t> safe_bottom_px=<b>
   intent.caption_defaults: anchor=<anchor> offset_px=<offset_px> min_font_px=<min_font_px> max_words_per_line=<max_words_per_line>
   intent.tone: <tone>
   intent.music_vo: <music_vo>
   intent.audio_treatment: <value | n/a>
   intent.captions_style: <value | n/a>
   fonts: ./fonts.css + ./fonts/ are present in compose/ (kit table in your instructions)
   style_source: <derived_from | none>
   style_source_compose: ~/video-vob-sessions/<derived_from>/compose/index.html | none
   style_source_brief: ~/video-vob-sessions/<derived_from>/brief.md | none
   prior_composition_files: <relative paths | none>
   revision_notes: <user words, lint/QC codes, or self-QC findings | none>
   lint_report_path: <composition.lint_report_path | none>
   Follow your agent instructions.")
   ```

4. **Save-time QC rejection branch.** If the composer reports `vob_save_composition` rejected
   with QC findings (`details.qc_findings`), that is the same auto-retry path as lint errors
   below — re-invoke with the findings' rule codes as `revision_notes` and count it against the
   lint-retry budget.

5. **Lint.** After the subagent returns, call `mcp__vob__vob_lint_composition { project_id }`
   (it merges hyperframes lint + the engine's static QC into one findings report). Branch on
   `lint_status`:
   - **`clean`** → go to step 6 (self-QC) before presenting anything.
   - **`warnings_only`** → show the warning summary (`findings_summary`, or `report_path` for
     the full list). Ask: "the linter flagged N warning(s); fix them, or accept and proceed?"
     - **Accept** → step 6 (self-QC), then present.
     - **Fix** → loop to step 3 with `revision_notes` = rule codes + file/line list +
       `report_path` — never paste full findings prose (the composer reads the report itself).
     - The user may also choose **revise** (their own notes) or **back to the plan**.
   - **`errors`** — do NOT surface to the user yet; auto-retry. Re-invoke the composer (step 3)
     with `revision_notes` = rule codes + file/line list + `report_path`. After **3** consecutive
     auto-retries without reaching `clean`/`warnings_only`, stop, surface the latest report, and
     ask: revise (user notes), back-edge to PLAN, or abort.

### Self-QC — snapshot review BEFORE the user sees anything
Run after lint returns `clean`, or after the user has accepted `warnings_only`. Budget: ≤2
self-QC rounds per COMPOSE pass (count rounds in-conversation; a round = one composer re-spawn
caused by this checklist). The lint ≤3 retry budget is separate and lint always settles first:
if a self-QC fix introduces lint errors, those consume lint retries; when lint is clean again,
resume self-QC at the SAME round count.

1. Compute snapshot timecodes from the storyboard (cumulative scene starts):
   - hook frame: hook-scene start + min(0.5, scene_duration/2) seconds — always include;
   - caption-dense: midpoint of the first caption window of every scene with captions (cap 3);
   - boundaries: every scene start + 0.2s (cap to fill);
   - dedupe within 0.5s; hard cap 8 (priority: hook > captions > boundaries).
2. `mcp__vob__vob_snapshot_keyframes { project_id, timecodes }` (works in COMPOSE — needs only
   a saved composition). Read `contact_sheet_path` for the black-frame/letterbox/layout sweep
   (QC-C, QC-F), then ALWAYS Read two stills at FULL resolution: the hook frame and the first
   caption-dense still (each ≈1.1–1.6k image tokens — cheap insurance against a wasted preview
   render; contact-sheet cells are too small after the vision downscale to judge caption
   legibility, safe-band margins, or collisions). Read up to 2 MORE stills to confirm suspected
   failures — singles budget 4 per round.
3. Judge QC-A/QC-B/QC-D/QC-E on the full-res stills; judge QC-C/QC-F on every contact-sheet
   cell. The checklist:
   - QC-A captions inside the safe band (not in the top safe_top_px / bottom safe_bottom_px of
     the frame; nothing clipped at frame edges)
   - QC-B caption legibility: readable contrast against what's behind it, ≤2 lines, not
     overlapping other text
   - QC-C no black/empty/half-loaded frames at any sampled timecode
   - QC-D no overlay collisions (overlay text over captions or over the speaker's face)
   - QC-E the hook frame is actually striking: subject visible, not motion-smeared, text hook
     legible at thumbnail size
   - QC-F aspect/framing accidents: unintended letterboxing, wrong dimensions, subject cropped
     out by object-fit
4. GLARING (auto-fix without asking): any QC-A/QC-C/QC-F failure; QC-B unreadable (not merely
   suboptimal); QC-D hard overlap. → `vob_log_composer_invocation` with `revision_notes` =
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
