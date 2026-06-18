# PLAN — brief + storyboard, presented together, one sign-off
Spine rules 3, 4, 5, 11, 12 apply.

PLAN is the single planning gate. It produces two artifacts: the **brief** (creative direction —
hook, beats, tone, design language) which you draft, and the **storyboard** (the editorial plan)
which you delegate to the `storyboarder` subagent. You present BOTH together and get ONE approval
before COMPOSE. The gate requires both halves saved AND confirmed; internally that's
`vob_confirm_brief` + `vob_confirm_storyboard`, but to the user it's a single "approve the plan"
moment.

## Read sites
| step | source | fields |
|---|---|---|
| 1 | `vob_read_state_summary` | `manifest{path,file_count,total_duration_seconds}`, `intent.answers`, `platform{...}`, `video_type{canonical,source,lint_ruleset,segmentation,clean_cut,overlay_vocabulary,transition_vocabulary,design_default}`, `target_duration_seconds`, `inspect.classification` pool paths, `inspect.{clean_speech_path,digest_path,strips_legend_path,thumbs_dir,thumb_interval_seconds,thumb_count,transcript_path,transcript_aligned,audio,segments_path}`, `brief`, `storyboard{...,broll_gap_count,broll_gaps_path}`, `style.derived_from` |
| 2 | `Read` `references/brief-design.md` | brief skeleton + tone→design table |
| 7 | `vob_save_storyboard` result (via subagent) or summary | `storyboard.markdown_path`, `scene_count`, `plan_lint` |

**Draft the brief**

1. Call `mcp__vob__vob_read_state_summary { project_id }` for paths and flags. The intent ANSWER
   VALUES are already in your conversation from INTENT — on a resume where they are not, the
   summary's `intent.answers` carries the full stored answers; never call `vob_read_state` for
   this (its `include` enum is `history|clips|dependencies` only). The brief's Source line uses
   the summary's `manifest.total_duration_seconds`/`file_count`; `total_duration_seconds` is
   `null` on a pre-v2 session — only then Read `manifest.json` at `summary.manifest.path` and sum
   `files[].duration_seconds`. Read the manifest likewise when per-file detail is needed for the
   Technical line. If `brief`/`storyboard` already exist `confirmed:true` and the user is back
   via a back-edge, ask whether they want a fresh pass or to keep what's there — only redo what
   they want changed.

2. Read `.claude/skills/vob/references/brief-design.md` now (once; skip if already in context)
   and draft the brief from its skeleton + tone table. Your INSPECT visual notes plus the
   A-roll/B-roll split are ground truth for Hook and Beats — do not invent visual content; if
   your visual sense has faded, Read the contact sheet(s) again first. The **Design language**
   section is BINDING for the composer. **When `intent.answers.design_language` is present** (the
   user already confirmed the concrete look at INTENT), transcribe it into the Design language
   section verbatim — that IS the binding decision; do not re-derive from tone. Only when it is
   absent, fill the section from the tone table. Either way, adjust only where the user's
   `captions_style` / rough idea / `--like` source brief say otherwise, and keep the platform safe
   bands + 56px caption floor as hard constraints (surface any forced adjustment at the gate).

   **Fan-out:** when the job is N shorts, the brief's Target section MUST name the deliverable
   count and per-short duration (e.g. `- Deliverables: 3 shorts, 20–35s each`) — the brief is the
   DURABLE record of the fan-out ask (the summary's `target_duration_range` carries the duration
   shape, but N lives only here). On a resume into PLAN before a storyboard exists, derive the
   `fan_out` spawn lines from the brief.

   **Hook guidance:** If `intent.answers.hook_intent` is present, the user already chose the
   opening at INTENT — build the Hook section around it (cross-check it is in the A-roll pool).
   Otherwise pick the verbal hook from `digest_path`'s `hook_candidates[]` (Read the digest if it
   isn't in context). Prefer a mid-action, high-energy line that makes a claim or asks a question;
   NEVER a greeting or wind-up. If the inspector tagged `hook_candidate` segments in the pools,
   cross-check the candidate's segment is in the A-roll pool. For silent sources, the hook is the
   most kinetic contact-sheet cell.

3. Call `mcp__vob__vob_save_brief { project_id, content }`. (Don't ask for approval yet — the
   brief and storyboard are presented together as one gate.)

**Delegate the storyboard**

4. Record the invocation: `mcp__vob__vob_log_storyboarder_invocation { project_id,
   revision_notes? }`. Omit `revision_notes` on the first invocation; pass the user's exact words
   on every subsequent pass.

5. Invoke the storyboarder. Spawn prompt is DATA-ONLY (no behavioral clauses — the agent .md owns
   behavior; if you are tempted to add an instruction, it belongs in the agent file). Fields with
   no value are passed as the literal string `none`; values come from the read-sites table.
   **Fan-out:** when the job is N shorts from this source (the user asked for multiple, and/or
   `target_duration_range.per_deliverable` is set in the summary), add the two `fan_out` lines —
   the storyboarder then emits the schema-1.1 `shorts[]` form:
   ```
   Task(subagent_type: "storyboarder",
        description: "Storyboard scene plan",
        prompt: "DATA
   project_id: <project_id>
   manifest_path: <manifest.path>
   brief_path: <brief.path>
   intent.target_platform: <canonical>            (raw: "<raw>")
   intent.platform_profile: width=<w> height=<h> fps=<fps> safe_top_px=<t> safe_bottom_px=<b> ideal_duration_s=<min>-<max> max_duration_s=<m>
   intent.target_duration_seconds: <seconds>
   video_type: <summary.video_type.canonical>     (lint_ruleset=<lint_ruleset> clean_cut=<clean_cut> segmentation=<segmentation>)
   variety_budget: <summary.video_type.variety_budget.max_static_stretch_seconds + "s" | none>   (longest static A-roll stretch before a visual beat is due — PLAN_STATIC_STRETCH)
   overlay_vocabulary: <summary.video_type.overlay_vocabulary, comma-joined>
   transition_vocabulary: <summary.video_type.transition_vocabulary, comma-joined>
   design_default: <summary.video_type.design_default, compact: palette/typography/caption_style/motion/grade — the storyboarder mirrors the brief's Design language into target.design, falling back to these>

   fan_out: <N> shorts                            (omit the two fan_out lines entirely for a single video)
   fan_out.per_short_duration: <min>-<max>s       (from target_duration_range; or the single per-short figure)
   intent.tone: <tone>
   intent.pacing_intent: <pacing_intent | none>
   intent.hook_intent: <hook_intent | none>
   intent.broll_intent: <broll_intent | none>
   intent.caption_animation_intent: <caption_animation_intent | none>
   intent.editorial_intent: <editorial_intent | none>
   intent.speed_intent: <speed_intent | none>
   intent.transition_intent: <transition_intent | none>
   intent.layout_intent: <layout_intent | none>
   intent.key_moments: <key_moments>
   intent.music_vo: <music_vo>
   intent.audio_treatment: <value | n/a>
   intent.captions_style: <value | n/a>
   file_roles: <summary.inspect.classification.file_roles, compact "fileN=role" list | none>
   aroll_pool_path: <path | none>
   broll_index_path: <path | none>
   review_pool_path: <path | none>
   segments_path: <path | none>
   clean_speech_path: <inspect.clean_speech_path | none>
   digest_path: <inspect.digest_path | none>
   transcript_path: <path | none>
   transcript_aligned: <inspect.transcript_aligned — true|false; false ⇒ word timing is approximate, so karaoke/word-by-word captions will drift>
   audio_summary: <inspect.audio compact, or none — clean_audio_source_index, any_quiet/any_clip_risk, per-file layout/balance/dead_channel; informs the multi-file spine AUDIO choice. Leveling itself lands at PACKAGE — surface a quiet/clip concern at the gate, don't act on it here>
   thumbs_dir: <inspect.thumbs_dir>
   thumb_interval_seconds: <n>
   thumb_count: <n>
   strips_legend_path: <inspect.strips_legend_path | none>
   style_source: <derived_from | none>
   style_source_brief: ~/video-vob-sessions/<derived_from>/brief.md | none
   prior_storyboard_path: <storyboard.artifact_path | none>
   revision_notes: <user's exact words, or validator errors | none>
   Follow your agent instructions.")
   ```

6. If the storyboarder errors (schema validation OR plan-lint rejection — the error's `details`
   carries `plan_errors[≤10]` + `plan_warnings[≤10]` + counts so one revision pass fixes both),
   re-invoke it once with the error list as `revision_notes`. If it fails again, surface the
   blocker and stop — never fabricate a storyboard yourself.

**Editorial critique pass (advisory, fail-safe)**

6b. With a lint-clean storyboard saved, run an INDEPENDENT editorial-quality check BEFORE you
   present — the lints are a floor; this raises the ceiling. Spawn the `editorial-critic` (DATA-only,
   it reads `references/editorial-patterns.md` and the signals itself):
   ```
   Task(subagent_type: "editorial-critic",
        description: "Editorial critique of the storyboard",
        prompt: "DATA
   project_id: <project_id>
   brief_path: <brief.path>
   storyboard_json_path: <storyboard.artifact_path>
   storyboard_markdown_path: <storyboard.markdown_path>
   video_type: <summary.video_type.canonical>   (lint_ruleset=<lint_ruleset>)
   variety_budget: <summary.video_type.variety_budget.max_static_stretch_seconds + "s" | none>   (grounds the Visual variety dimension — PLAN_STATIC_STRETCH)
   intent.target_duration_seconds: <seconds>     (range: <min>-<max> | none)
   intent.tone: <tone>
   intent.key_moments: <key_moments>
   intent.pacing_intent: <pacing_intent | none>
   intent.hook_intent: <hook_intent | none>
   intent.broll_intent: <broll_intent | none>
   digest_path: <inspect.digest_path | none>
   segments_path: <inspect.segments_path | none>
   clean_speech_path: <inspect.clean_speech_path | none>
   transcript_aligned: <true|false>
   audio_summary: <inspect.audio compact | none>
   aroll_pool_path: <inspect.classification aroll_pool path | none>   (take groups / best_take / visual tags — grounds the critic's Take + B-roll scoring)
   broll_index_path: <inspect.classification broll_index path | none>
   Follow your agent instructions.")
   ```
   The critic returns `VERDICT: SHIP|REVISE` + per-dimension SCORES + FINDINGS + (on REVISE) a TOP
   FIX. It NEVER writes, NEVER gates, and NEVER transitions — it is advisory input for you and the
   human.

6c. Act on the verdict — **at most ONE critic-driven revision**, so the gate is never delayed and
   the loop can't run away:
   - **SHIP** → proceed to step 7 (keep the one-line summary to show at the gate).
   - **Critic errored / unparseable / unavailable** (fail-safe) → proceed to step 7 with the plan as
     saved; note "editorial critic unavailable — presenting as-is." Never block on the critic.
   - **REVISE**, and you have NOT already auto-revised on the critic this round → record
     `vob_log_storyboarder_invocation { revision_notes: <the critic's TOP FIX + FINDINGS> }`, then
     re-invoke the storyboarder (step 5) with those as `revision_notes`. Re-run the lint handling
     (step 6). Then go to step 7 — do **not** loop the critic a second time; the human is the final
     judge. Carry any still-open critic notes into the presentation as `⚠ editorial:` lines.
   - On a purely user-driven revision later (step 8 → step 4), re-run this critic pass only when the
     storyboard changed substantially; skip it for a narrow tweak ("trim the hook") to avoid churn.

**Present the plan, get one sign-off**

7. Call `mcp__vob__vob_read_state_summary` (markdown path + scene count) and `Read`
   `storyboard.markdown_path` — show it, don't paraphrase. Present BOTH halves together: the
   brief, then the storyboard markdown. Call out the editorial decisions the user is most likely
   to override: which **best take** was auto-picked per retake group (alternates available), and
   any **B-roll placements**. **Recap the creative spec** so the human sees the full decision set
   before sign-off — both what they steered at INTENT and what the preset silently defaulted:
   captions + animation (pop / karaoke), any **speed-ups**, **scene transitions**, **split-screen
   layouts**, clean-cut **snapping**, and the silent technical defaults (render **fps**, −14 LUFS
   **loudness**, render **segmentation**). Any of these is fair game to change here rather than
   discovering it at PREVIEW. Fan-out: the markdown has one `## Short k of N` section per short —
   this ONE sign-off approves the whole set, so say so explicitly ("approving covers all N
   shorts"). Ask one question: "Approve the plan, revise the brief, revise the storyboard, or
   re-clarify intent?"

7b. If the save result carried plan-lint `warnings[]`, present them with the plan as
   `⚠ plan-lint:` lines — they are exactly the drift/hook/B-roll/overlay problems the user
   should rule on at this gate.

7c. **B-roll gap shopping list** (the save result carries `broll_gap_count > 0`): `Read`
   `broll_gaps_path` (`plan/broll_gaps.json`) and present it as a concrete ask — one line per
   gap: _"scene <scene_ref> wants ~<desired_duration_seconds>s of: <description>"_. Frame the
   choice: "upload these N shots and I'll re-derive the plan (the cut gets the coverage it
   wants), or approve as-is and the cut holds on the spine there." Gaps are warnings, never
   blockers — `PLAN_BROLL_GAP_UNFILLED` does not stop the sign-off.

7d. **Surface the editorial critique** (from step 6b): show a one-line `Editorial critic: <SHIP |
   revised once on its notes> — <the critic's summary>`. If the critic returned a `REVISE` you did
   not auto-apply (a 2nd-round finding), list those as `⚠ editorial:` lines alongside the plan-lint
   warnings — they're the hook/take/rhythm/b-roll/ending calls the human should rule on. Advisory:
   the human can approve as-is regardless of the critic.

8. Handle the response:
   - **Approve** → `mcp__vob__vob_confirm_brief { project_id }` AND `mcp__vob__vob_confirm_storyboard
     { project_id }`, then `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }`.
   - **Revise the brief** → re-draft, `vob_save_brief` again (resets `brief.confirmed:false`),
     re-present.
   - **Revise the storyboard** → loop to step 4 with the user's note as `revision_notes` (the
     server bumps `revision_count`, resets `storyboard.confirmed:false`, re-renders the
     markdown), re-present.
   - **Re-clarify intent** → `vob_transition_phase` to `INTENT`, record the updated answer,
     transition back to PLAN, re-draft both halves.
   - **Fill the b-roll gaps** (the user has/uploads more footage) →
     `mcp__vob__vob_transition_phase { project_id, to_phase: "INGEST" }` (the sanctioned gap-
     resolution back-edge), then `vob_ingest_file` with the EXTENDED drop (a folder containing
     old + new files works best — re-probing unchanged files is hash-cached), re-walk
     INGEST→INSPECT (re-run inspect + classification + ack; detection/ASR caches make the old
     footage cheap)→INTENT (answers persist — transition straight through)→PLAN, then loop to
     step 4: the storyboarder re-derives against the extended B-roll index and drops the filled
     gaps.

9. Do not call either confirm tool until the user has explicitly approved the plan. A vague
   "sounds good" is fine; silence or "let me think" is not. If the gate blocks with
   `brief_not_confirmed` or `storyboard_not_confirmed`, you skipped one — call the missing
   confirm and retry.
