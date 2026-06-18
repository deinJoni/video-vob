# COMPOSE — delegate to the composer, lint + QC, self-QC, transition
Spine rules 5, 6, 8, 9, 11 apply.

The composition is hyperframes-compatible HTML/CSS/JS. You never write it yourself — you delegate
to the `composer` subagent; linting, snapshots, and transitions stay with you.

## Read sites
| step | source | fields |
|---|---|---|
| 2 | `vob_read_state_summary` | `storyboard.artifact_path`, `brief.path`, `manifest.path`, `composition.*`, `inspect.{transcript_path,clean_speech_path,transcript_aligned}`, `platform{...}`, `video_type.{canonical,lint_ruleset}`, `visual_critic_mode`, `intent.answers`, `style.derived_from` |
| 5 | composer-relayed save verdict; `vob_read_state_summary` `composition.{lint_status,lint_report_path}`; `vob_lint_composition` (fallback only) | `lint_status, error_count, warning_count, qc_error_count, qc_warning_count, findings_summary[≤10], report_path` |
| 2/2b/3 | `vob_snapshot_keyframes` result → `vob_qc_stills` → `visual-critic` spawn | `still_paths, contact_sheet_path, snapshots_dir`; qc `findings[]`; critic `VERDICT/SCORES/FINDINGS/TOP FIX` |

1. **Transition with a warning.** Tell the user the transition pre-cuts scene clips (first entry
   from PLAN typically 5–30s per scene; back-edge re-entry is cached, see spine rule 9), then
   call `vob_vob_transition_phase { project_id, to_phase: "COMPOSE" }`. On failure from a
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

3. **Delegate.** Record the invocation first: `vob_vob_log_composer_invocation
   { project_id, revision_notes? }` — omit `revision_notes` on the very first invocation; pass
   the user's exact words on a user-driven revision; pass rule codes on a lint/QC auto-retry.
   Spawn prompt is DATA-ONLY (no behavioral clauses — the agent .md owns behavior; if you are
   tempted to add an instruction, it belongs in the agent file). Fields with no value are passed
   as the literal string `none`:
   Invoke the `composer` subagent with the `task` tool, passing:
   ```
   DATA
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
   video_type: <summary.video_type.canonical>   (look up the matching look bundle: ./design-system/manifest.json → video_types[<this>], fallback general — see Design system kit)
   layout_scenes_composited: <summary.scene_layouts.composited_scenes, comma-joined | none>   (reference ./source/<scene_id>-layout.mp4 as ONE <video>)
   layout_scenes_fell_back: <summary.scene_layouts.fell_back_scenes, comma-joined | none>     (composite degraded — render the cells as positioned <video> elements)
   fonts: ./fonts.css + ./fonts/ are present in compose/ (kit table in your instructions)
   design_system: ./design-system/manifest.json + per-component references are present in compose/ (set --vob-* tokens from target.design once; adapt the video_type's look — see Design system kit)
   style_source: <derived_from | none>
   style_source_compose: ~/video-vob-sessions/<derived_from>/compose/index.html | none
   style_source_brief: ~/video-vob-sessions/<derived_from>/brief.md | none
   prior_composition_files: <relative paths | none>
   revision_notes: <user words, lint/QC codes, or self-QC findings | none>
   lint_report_path: <composition.lint_report_path | none>
   Follow your agent instructions.
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
   `vob_vob_lint_composition { project_id }` yourself ONLY when `lint_status` is
   `unknown` (the save-time lint infra-failed — e.g. missing binary, timeout) or the
   composer's report is missing/garbled. Branch on `lint_status`:
   - **`clean`** → run the Self-QC section below (start at its step 1) before presenting anything.
   - **`warnings_only`** → show the warning summary (`findings_summary`, or `report_path` for
     the full list). Ask: "the linter flagged N warning(s); fix them, or accept and proceed?"
     - **Accept** → run the Self-QC section below (its step 1), then present.
     - **Fix** → loop to step 3 with `revision_notes` = rule codes + file/line list +
       `report_path` — never paste full findings prose (the composer reads the report itself).
     - The user may also choose **revise** (their own notes) or **back to the plan**.
   - **`errors`** — the composer already burned its in-invocation save budget on these; do NOT
     surface to the user yet; auto-retry. Re-invoke the composer (step 3) with `revision_notes`
     = rule codes + file/line list + `report_path`. After **3** consecutive auto-retries
     (re-spawns) without reaching `clean`/`warnings_only`, stop, surface the latest report, and
     ask: revise (user notes), back-edge to PLAN, or abort.

### Self-QC — independent VISUAL critique BEFORE the user sees anything
Run after lint returns `clean`, or after the user has accepted `warnings_only`. The pixel check is
an INDEPENDENT `visual-critic` subagent (the COMPOSE twin of PLAN's `editorial-critic`): it judges
the rendered stills, you act on its verdict, and you judge the stills inline yourself only as a
fallback when it is unavailable. Budgets are separate and compose cleanly: the critic drives **≤1**
auto-fix; the inline-fallback self-QC keeps its **≤2** rounds; the lint **≤3** retry budget always
settles first (a self-QC fix that introduces lint errors consumes lint retries, then self-QC
resumes at the SAME round count). (Step numbers in this section are LOCAL to it; outer-phase steps
are written "COMPOSE step N".)

1. Compute snapshot timecodes from the storyboard (cumulative scene starts; fan-out / segmented:
   the ACTIVE short's / segment's scenes only — the composition implements just that timeline):
   - hook frame: hook-scene start + min(0.5, scene_duration/2) seconds — always include;
   - caption-dense: midpoint of the first caption window of every scene with captions (cap 3);
   - boundaries: every scene start + 0.2s (cap to fill);
   - dedupe within 0.5s; hard cap 8 (priority: hook > captions > boundaries).
2. `vob_vob_snapshot_keyframes { project_id, timecodes }` (works in COMPOSE — needs only a
   saved composition) → full-res PNGs (`still_paths`) + `contact_sheet_path` + `snapshots_dir`.
   You do NOT read the stills here — the visual-critic does (step 3), keeping the image tokens out
   of your context. (You still Read them yourself in the inline fallback, step 6.)
2b. `vob_vob_qc_stills { project_id, timecodes }` — pass the SAME `timecodes`. Automated
   **QC-C** (luma-scan: `glaring` `qc/still_black` / `qc/still_blown_out` for a frame that rendered
   with NO visible content; `taste` `qc/still_flat`) **and automated QC-B** (the deterministic
   caption-contrast check `qc/caption_low_contrast`, sampled under the caption safe band on
   caption-bearing frames — `glaring` below the hard floor, else `taste`). Pure ffprobe, ~1–3s,
   advisory (gates nothing). A `glaring` finding is a GLARING item (step 4 / step 6); carry `taste`
   findings (incl. `qc/still_flat` only if it lands mid-scene, and `qc/caption_low_contrast` at
   taste) into the user notes.
3. **Spawn the `visual-critic`** — the independent pixel critic — UNLESS the summary's
   `visual_critic_mode` is `off`, OR it is `auto` (default) AND the active scope plans NO captions,
   NO typed overlays, and NO `target.design` look (a bare cuts-only scope — then skip straight to
   the inline fallback, step 6). When `visual_critic_mode` is `always`, spawn regardless of scope.
   Its image tokens stay in its own throwaway context. Spawn prompt is DATA-ONLY (fields with no
   value are passed as the literal string `none`):
   Invoke the `visual-critic` subagent with the `task` tool, passing:
   ```
   DATA
   project_id: <project_id>
   snapshots_dir: <snapshot result .snapshots_dir>
   still_paths: <snapshot result .still_paths, comma-joined>
   contact_sheet_path: <snapshot result .contact_sheet_path | none>
   timecodes: <the SAME timecodes, comma-joined, same order as still_paths>
   video_type: <summary.video_type.canonical>
   lint_ruleset: <summary.video_type.lint_ruleset>
   intent.target_platform: <canonical>
   intent.platform_profile: width=<w> height=<h> safe_top_px=<t> safe_bottom_px=<b>
   intent.tone: <tone>
   storyboard_json_path: <storyboard.artifact_path>
   short_id: <active short_id | none>
   segment_id: <active segment_id | none>
   Follow your agent instructions.
   ```
4. **Act on the verdict — at most ONE critic-driven fix** (mirrors PLAN step 6c):
   - **`SHIP`** → keep a one-line summary for the gate; carry any `taste` findings forward as
     `⚠ visual:` notes; go to step 7 (present).
   - **`REVISE`** and not already auto-fixed this COMPOSE pass → `vob_vob_log_composer_invocation
     { project_id, revision_notes }` where `revision_notes` = the critic's `TOP FIX` + its
     `glaring` FINDINGS + any `glaring` `vob_qc_stills` codes (+ the `vob_qc_stills` `report_path`
     when it flagged anything; the critic itself writes no report — its verdict was its message).
     Re-spawn the composer (COMPOSE step 3), re-lint, then re-run snapshot + `vob_qc_stills`. Do
     **NOT** re-spawn the critic (the budget is one fix). Carry remaining `taste` notes forward;
     go to step 7.
   - **`taste`-only** (verdict `SHIP`, no `weak` dimension) → surface as `⚠ visual:` notes at the
     gate; never auto-fix.
   - **Critic errored / unparseable / unavailable / `visual_critic_mode: off`** → **fall back to
     the inline self-QC (step 6)** — never block. The critic is advisory; the human is the final
     judge.
5. Safe bands and the 56px caption floor are hard constraints even against an explicit user
   `captions_style` — if a glaring fix (from the critic OR the inline fallback) overrides a user
   choice, say so when you present.

6. **Inline self-QC fallback** — used ONLY when the critic was skipped/unavailable (step 4's last
   branch). Read two stills at FULL resolution (the hook frame + the first caption-dense still,
   ≈1.1–1.6k image tokens each); Read `contact_sheet_path` for the letterbox/layout sweep; Read up
   to 2 MORE to confirm a suspected failure (singles budget 4 per round). Judge:
   - QC-A captions inside the safe band (nothing in the top safe_top_px / bottom safe_bottom_px;
     nothing clipped at frame edges)
   - QC-B caption legibility: readable contrast against the background, ≤2 lines, not overlapping
     other text — **automated by step 2b** (`qc/caption_low_contrast`); add what it can't measure
     (busy backgrounds, partial occlusion)
   - QC-C no black/empty/half-loaded frames — **automated by step 2b** (`qc/still_black` etc.);
     trust its findings rather than re-judging every cell by eye
   - QC-D no overlay collisions (overlay text over captions or over the speaker's face)
   - QC-E the hook frame is striking: subject visible, not motion-smeared, hook text legible small
   - QC-F aspect/framing accidents: unintended letterboxing, wrong dimensions, subject cropped out
   GLARING (auto-fix without asking): any QC-A/QC-C/QC-F failure (QC-C = a `vob_qc_stills`
   `glaring` finding); QC-B unreadable; QC-D hard overlap → `vob_log_composer_invocation` with
   `revision_notes` = `"self-QC round <n>: <QC-code> at t=<s>s — <what is wrong>"`, re-spawn the
   composer, re-lint, then re-snapshot ONLY the failed timecodes (plus the hook frame). ≤2 rounds.
   TASTE (never auto-fix): font/palette feel, hook framing aesthetics, overlay density — carry as a
   short "things you might want changed" list.

7. **Present, then branch.** Present to the user: file list, total duration, the contact sheet
   path, any remaining `taste` / `⚠ visual:` notes, any UNRESOLVED glaring item flagged
   prominently. Then:
   - **Approve** → `vob_vob_transition_phase { project_id, to_phase: "PREVIEW" }`. (There is
     no separate confirm tool — clean lint + the user's explicit approval + the transition is the
     confirmation. The gate rejects `errors`/`unknown` lint.)
   - **Revise** ("tighten scene 3", "title too small") → loop to COMPOSE step 3 (Delegate) with the
     user's note as `revision_notes`.
   - **Back to the plan** → `vob_vob_transition_phase { project_id, to_phase: "PLAN" }` and
     re-enter PLAN.

8. If the composer errors out of band twice in a row (validation failure after one retry),
   surface the blocker and stop — never fabricate composition files yourself, and never invoke
   hyperframes directly (spine rule 8).
