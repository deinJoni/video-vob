# Spec: WP5 claude-adapter (D8) + WP6 sync (D9) + WP7 docs (D9)

Status: implementation-ready. Baseline = branch `v2/fable-rework` at 93d0dd1.
Binding scope: `docs/v2/DESIGN-BRIEF.md` (locked decisions D8, D9; consumed contracts D1–D7).
Builds in wave 3 — AFTER WP1–WP4 land. Every contract consumed from WP1–4 is enumerated in §1;
where the sibling spec was not yet on disk at spec time, the brief line is cited and the item is
marked `[DEP:WPn]`. Implementers reconcile exact field/code names against the landed WP1–4 specs
before starting; everything else in this document is final.

Conventions used below:
- Token estimates = bytes / 4.
- `<S:nnn>` = current `adapters/claude-code/.claude/skills/vob/SKILL.md` line nnn.
- "spine" = the rewritten SKILL.md. "phase file" = `.claude/skills/vob/phases/<PHASE>.md`.
- Tool names: engine `vob_*`; claude-code `mcp__vob__vob_*`; opencode `vob_vob_*`.

---

## 1. Consumed contracts (cross-check against WP1–4)

WP5/6/7 write NO engine code except `registry-integrity.js`, `server.js` (2 lines),
`scripts/m5-walker.js`, `install.sh`. Everything else here is prose/config that *consumes* the
following engine contracts. If a landed WP1–4 spec names a field/code differently, the adapter
prose follows the engine — update the literal here, never fork.

| # | Contract | Producer | Source | Consumed by (this spec) |
|---|---|---|---|---|
| C1 | `vob_transition_phase` returns `{project_id, from, to, override_reason, archived:{version,paths}\|null, clips:{clip_count,cached_count,clips_dir,audio_treatment}\|null, phase_summary}` — no state echo | WP1 | brief D1 | spine §2.2 rules 7/10, all phase files |
| C2 | `vob_read_state` drops `history`/`transcoded_clips.clips[]`/`dependencies` by default; opt-in `include:["history","clips","dependencies"]` | WP1 | brief D1 | spine rule 11, phase files |
| C3 | `vob_read_state_summary` = per-slot digest, field names EXACTLY per WP1 §1.4.2 (reconciled — the names below ARE WP1's; do not improvise): `project_id, phase, target, last_updated, iteration_version, archived_version_count, finalized_version, style{derived_from}\|null, external_import, deliverable_count, history_count, dependency_failures[], manifest{path,source_path,file_count,video_stream_count,total_duration_seconds}\|null` (total_duration_seconds stamped at ingest per WP1 §1.6; **null on legacy sessions** — phases/PLAN.md falls back to Reading manifest.json), `inspect{summary_path, thumbs_dir, thumb_count, thumb_interval_seconds, sample_thumb_paths[], contact_sheet_paths[], audio_present, speech_detected, word_count, paragraph_count, transcript_path, transcript_summary_path, transcript_paragraphs_path, segments_path, segment_count, clean_speech_path, digest_path, strips_legend_path, strip_count, transcripts[], hook_candidate_count, classification{aroll_count,broll_count,review_count,take_group_count,best_take_count,aroll_pool_path,broll_index_path,review_pool_path,visual_coverage,hook_tagged_count}\|null, user_acknowledged, skipped_reason}\|null, intent{answers, missing_required_keys[]}\|null, platform{canonical,width,height,fps,safe_top_px,safe_bottom_px,ideal_duration_s,max_duration_s}\|null, target_duration_seconds, brief{path,saved_at,confirmed,confirmed_at}\|null, storyboard{artifact_path,markdown_path,saved_at,confirmed,confirmed_at,revision_count,scene_count,total_duration_seconds,plan_lint{error_count,warning_count}}\|null, clips{...}\|null, composition{files[],saved_at,lint_status,lint_report_path,lint_ran_at,revision_count}\|null, preview{render_path,rendered_at,render_duration_seconds,confirmed,confirmed_at,revision_count,composition_revision_rendered}\|null, render{mp4_path,rendered_at,render_duration_seconds,file_size_bytes,stderr_log_path,confirmed,confirmed_at,revision_count,composition_revision_rendered}\|null, package{directory_path,final_mp4_path,thumbnail_path,manifest_path,readme_path,packaged_at,iteration_version}\|null`. Legacy sessions: new fields default `null`/`0`/`[]` at read time. (Name corrections vs earlier drafts of this spec: `iteration_version` not `iteration.current_version`; `inspect.user_acknowledged` not `acknowledged`; `intent.answers`+`missing_required_keys` not `recorded_keys`/`missing_keys`; `storyboard.total_duration_seconds` not `total_target_duration_seconds`; `deliverable_count` not `deliverables_count`.) | WP1 | brief D1 ("Spec the exact field list against every SKILL.md read site"); WP1 §1.4.2 | every phase file read-site table (§2.3) |
| C4 | `vob_record_intent_answer` returns `{recorded, missing_required_keys}` only | WP1 | brief D1 | phases/INTENT.md |
| C5 | Non-overridable blockers: `inspect_not_acknowledged`, `preview_not_confirmed`, `render_not_confirmed` carry `overridable:false`; `transitionPhase` refuses `override_reason` for them | WP1 | brief D2 | spine rule 2; phases/INSPECT/PREVIEW/RENDER; CLAUDE.md §4.1 |
| C6 | `save_composition` resets `preview.confirmed`/`render.confirmed`; renders stamp `composition_revision_rendered`; `previewToRender`/`renderToPackage` block on mismatch (blocker name per WP1 spec; this spec calls it "stale-revision blocker") | WP1 | brief D2 | phases/PREVIEW/RENDER; CLAUDE.md |
| C7 | `vob_ingest_file` returns file summaries + dependency FAILURES only | WP1 | brief D1 | phases/INGEST.md |
| C8 | `vob_save_storyboard` accepts `content` as object OR string. A SUCCESSFUL save returns `plan_lint: {error_count: 0, warning_count, warnings[≤10]}`; a plan-lint REJECTION throws INVALID_ARGUMENTS with `details: {plan_errors[≤10], plan_warnings[≤10], error_count, warning_count}` (WP2 §2.5.2 — warnings ride on rejection too, so one revision pass fixes both) | WP1+WP2 | brief D1/D4 | phases/PLAN.md; storyboarder.md; walker |
| C9 | Plan-lint codes (errors: manifest index range, out_seconds overrun, captions-on-silent, broll dangle, narration_span outside scene, b_roll longer than narration_span; warnings: hook-not-first, hook>3.5s, duration sum drift>0.5s, target drift>20%, per-scene clip-sum drift>15%, broll hold<1.5s, back-to-back broll reuse, key_moments uncovered, a_roll straddles removed clean-cut span) — exact codes per WP2 spec | WP2 | brief D4/D5 | storyboarder.md §pre-compliance; phases/PLAN.md |
| C10 | `platform-profiles.js` canonical platforms (`tiktok,reels,shorts,youtube,landscape,square` + aliases) → `{width,height,aspect,fps,safe_top_px,safe_bottom_px,ideal_duration_s,max_duration_s,caption_defaults}`; intent stored as `target_platform:{raw,canonical,profile}`, `target_duration:{raw,seconds}` | WP2 | brief D3 | spawn templates §2.4; composer.md dims; phases/INTENT/PLAN |
| C11 | Optional storyboard fields when present: per-scene `caption_segments:[{text,start_seconds,end_seconds,emphasis?}]` (source-time), `transition_in/transition_out: "cut"\|"fade"`; schema stays "1.0" | WP2 | brief D4 | storyboarder.md schema block; composer.md; walker fixture |
| C12 | INSPECT v2 artifacts: `inspect/digest.md` (per-file one-liners, paragraph map, clean-cut stats, segment table, `hook_candidates[]`), contact strips + JSON legend, `state.inspect.clean_speech_path`, `inspect/transcripts/file_<i>.json`, downscaled thumbs (480) / keyframes (512), classification visual fields `shot_type, subject_position, framing_ok_for_vertical` + hook tags | WP3 | brief D5 | inspector.md; storyboarder.md; phases/INSPECT/PLAN; spawn templates |
| C13 | Composition QC: save-time rejection (INVALID_ARGUMENTS-style with findings) + QC findings folded into lint report (one findings list). Error checks: Rule-of-Three missing, unresolved `./source/<ref>`, absolute src path, master duration short, storyboard scene w/o clip element, >8 `<video>`. Warnings: >6 `<video>`, non-zero `data-media-start` on scene clip, caption <56px vertical, timed element missing `class="clip"`. **Overlay-mode exemption (WP4 §3.4):** a composition with ZERO `<video>` elements (the overlay-over-base escape hatch) is never rejected for uncovered storyboard scenes — `vob/scene_missing_clip` downgrades to one `vob/overlay_scene_missing_clip` warning at save AND lint. Exact code strings per WP4 spec | WP4 | brief D6 | references/lint-rules.md; composer.md; phases/COMPOSE.md + PACKAGE.md (escape hatch); walker |
| C14 | `render_preview`/`render_full` results gain `{duration_drift_s, width, height, size}`; >0.5s drift flagged; preview gets `stderr_log_path` | WP4 | brief D6 | phases/PREVIEW/RENDER.md |
| C15 | `vob_snapshot_keyframes` callable in COMPOSE (post-lint, pre-preview). Current code (snapshot-keyframes.js:27-47) already has no phase gate — WP4 verifies/keeps that | WP4 | brief D6 | phases/COMPOSE.md self-QC loop |
| C16 | Font kit: `mcp/assets/fonts/*.woff2` + `fonts.css`, copied/symlinked into `compose/fonts/` + `compose/fonts.css` on every save. Canonical families (reconcile with WP4): `Inter` (700, 900), `Anton` (400), `Bebas Neue` (400), `Playfair Display` (700), `Nunito` (800). Composer loads via `<link rel="stylesheet" href="./fonts.css">` | WP4 | brief D7 | composer.md font table; PLAN.md design table; NOTICE |
| C17 | PACKAGE: hook-aware thumbnail, loudnorm −14 LUFS default (opt-out `VOB_NO_LOUDNORM=1`), `--quality high` on ≥10GB hosts | WP4 | brief D6 | phases/PACKAGE.md; README |
| C18 | Lean lint/save results: ≤10 findings inline + counts + report path | WP1 | brief D1 | phases/COMPOSE/PLAN.md |

---

## 2. WP5 — claude-code adapter (`adapters/claude-code/**`)

### 2.1 Resulting file tree

```
adapters/claude-code/
  .mcp.json                                  (UNCHANGED)
  .claude/
    settings.json                            (EDITED — §2.9)
    rules/editing.md                         (REWRITTEN — §2.10)
    hooks/session-write-guard.sh             (REWRITTEN — §2.9)
    hooks/vob-statusline.js                  (UNCHANGED — out of v2 scope)
    skills/vob/SKILL.md                      (REWRITTEN — §2.2)
    skills/vob/phases/INGEST.md              (NEW)
    skills/vob/phases/INSPECT.md             (NEW)
    skills/vob/phases/INTENT.md              (NEW)
    skills/vob/phases/PLAN.md                (NEW)
    skills/vob/phases/COMPOSE.md             (NEW)
    skills/vob/phases/PREVIEW.md             (NEW)
    skills/vob/phases/RENDER.md              (NEW)
    skills/vob/phases/PACKAGE.md             (NEW)
    skills/vob/phases/ITERATE.md             (NEW)
    skills/vob/references/lint-rules.md      (NEW — §2.8)
    skills/vob/references/brief-design.md    (NEW — §2.3 PLAN; brief skeleton + tone→design table)
    agents/inspector.md                      (REWRITTEN — §2.5)
    agents/storyboarder.md                   (REWRITTEN — §2.6)
    agents/composer.md                       (REWRITTEN — §2.7)
    agents/.gitkeep                          (UNCHANGED)
```

No file is deleted. Zero changes to tool name lists (no new tools; brief hard constraint).
`install.sh`'s wholesale copy (`cp -R adapters/claude-code/. $TARGET/`) ships the new
`phases/` + `references/` dirs with no installer change.

### 2.2 SKILL.md v2 — the spine

Target: ≤19,000 bytes (~4.7k tokens). Current: 54,800 bytes (~13.7k tokens).

**Frontmatter — UNCHANGED.** Same `name`, `disable-model-invocation`, `argument-hint`, and the
exact same 23 `mcp__vob__vob_*` entries + `Read` + `Task` (<S:5-31>). The boot drift guard (§3.2)
verifies this list.

**Section order and content (drafted):**

#### (a) Role line (~2 lines)
Keep <S:33> verbatim:
> You are the ORCHESTRATOR for video-vob. Drive the human-in-the-loop conversation, call MCP
> tools to mutate durable state, and never invent state yourself.

#### (b) Hard rules (~12 one-liners, ≤1,700 bytes)
Each invariant stated EXACTLY ONCE in the spine; phase files do not restate them (they may cite a
rule number). Draft verbatim:

```markdown
## Hard rules
1. MCP-owned JSON is the only source of truth. Never write `state.json`, `manifest.json`, or
   anything under `~/video-vob-sessions/` directly — only `mcp__vob__vob_*` tools mutate state.
   (A PreToolUse hook blocks Write/Edit there; cross-project READS are allowed.)
2. Never skip forward through the FSM; back-edges are explicit. `override_reason` is recorded for
   audit and is REFUSED by the server for `inspect_not_acknowledged`, `preview_not_confirmed`,
   and `render_not_confirmed` — do not attempt it. The only sanctioned override is the
   ffmpeg-installed-since-INGEST case at RENDER→PACKAGE.
3. The engine enforces structure (intent keys, confirms, gates); YOU own wording and UX. The five
   intent keys (`target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`) are a
   hard contract — never rename them.
4. When a gate blocks, read `blockers[]` and react to exactly what it names (e.g.
   `intent_answers_missing.missing_keys`). Do not guess; do not retry blind.
5. Subagents (inspector/storyboarder/composer) get DATA-ONLY spawn prompts (the templates in the
   phase files), make exactly one save call each, and never lint, render, confirm, or transition.
6. Lint + composition QC must pass (no errors) before COMPOSE→PREVIEW. Lint errors auto-retry the
   composer ≤3×; after lint passes you run the snapshot self-QC loop (≤2 rounds) BEFORE showing
   the user anything. Warnings are the user's accept-or-fix call.
7. Saves reset confirms, server-enforced: `vob_save_composition` resets `lint_status:"unknown"`,
   `preview.confirmed:false`, `render.confirmed:false`; re-rendering resets its own confirm;
   renders stamp the composition revision and the gates block a stale preview/render.
8. hyperframes and ffmpeg run ONLY inside MCP tools (the engine resolves a pinned hyperframes
   binary itself — there is no npx in this pipeline). Never invoke either CLI yourself.
9. Entering COMPOSE blocks while the engine pre-cuts every storyboard clip to
   `transcoded/clips/<scene_id>-<clip_index>.mp4` (cached; back-edge re-entry is a no-op).
   Compositions reference scene clips as `./source/<scene_id>-<clip_index>.mp4` with
   `data-media-start="0"` — never absolute paths.
10. Back-edges out of RENDER/PACKAGE/ITERATE auto-archive `renders/` + `package/` into
    `archive/v<N>/` — when a transition response carries `archived`, surface those paths.
11. State reads: `vob_read_state_summary` is your default. Call `vob_read_state` only with an
    `include:` list and only where a phase file says so. Never re-read values already in your
    context; never read `history` unless debugging an audit question.
12. Visual grounding is mandatory: Read the INSPECT digest + contact sheet(s) before you write
    INTENT or PLAN prose. Never describe footage you have not seen.
```

#### (c) FSM map (~600 bytes)
Keep <S:50-59> verbatim (the diagram + PLAN-merge note + back-edge list). No change.

#### (d) Phase-file protocol (~550 bytes) — NEW. Exact text:

```markdown
## Phase files — read on entry
Immediately after every successful `vob_transition_phase` — and when resuming a project into a
phase — `Read` `.claude/skills/vob/phases/<PHASE>.md` (path relative to the project root, e.g.
`.claude/skills/vob/phases/PLAN.md`) BEFORE you call any other tool or speak to the user about
that phase. The phase file is the authoritative step-by-step procedure; the five-line summaries
below are orientation only. Read each phase file ONCE per session on first entry; re-read it only
if it is no longer in your context (e.g. after compaction) or if a blocker / `phase_summary`
references a step you don't recognize. A back-edge into a phase whose file you already read this
session does NOT require a re-read.
```

#### (e) Argument parsing — KEPT FULL
<S:61-90> verbatim (load-bearing per brief D8). ~5,700 bytes. One edit: none of its content
references stale facts; keep all 7 examples.

#### (f) Resume behavior — KEPT, one edit
<S:92-94> with the `read_state_summary` sentence extended:
> If it returns `STATE_CONFLICT`, the project already exists — call
> `mcp__vob__vob_read_state_summary { project_id }`, then Read the phase file for the reported
> phase and pick up at its first incomplete step (the summary's per-slot flags tell you which).

#### (g) Preflight doctor — CONDENSED to ~700 bytes
Keep the four reaction bullets of <S:100-104>, delete the motivational paragraph (<S:98> shrinks
to one sentence): "Call `mcp__vob__vob_doctor {}` once per session before INGEST; it preflights
ffmpeg/ffprobe/hyperframes/ASR and reports host capacity." Keep: ok:false→stop; asr warning→
`pip install faster-whisper` or `skip_transcription`; host-capacity→slow renders + ceilings;
relay advisories.

#### (h) Per-phase summaries (9 × ≤5 lines, ~3,600 bytes total). Drafted verbatim:

```markdown
## Phase summaries (detail: phases/<PHASE>.md)

**INGEST** — `vob_ingest_file {project_id, source_path}`; report from `files[]`; surface
dependency FAILURES the result carries (ASR dead, rotation warning); transition to INSPECT.

**INSPECT** — `vob_inspect_source` (knobs: `thumb_interval_seconds`, `skip_scene_detection` for
30min+ single-shots, `skip_transcription` only on user opt-out). Read `digest_path` + contact
sheet(s). Delegate classification to the inspector. Surface findings + pool split; wait for an
explicit human acknowledgement; `vob_acknowledge_inspect`; transition. Never override the ack.

**INTENT** — infer-then-confirm. Propose the five keys from the rough idea + digest +
classification; pre-record confident ones; batch the gaps + the review-bucket question.
Conditional keys (`audio_treatment` enum, `captions_style`) come from `missing_required_keys`.
`--like`: pre-record stylistic keys from the source project; never `key_moments`.

**PLAN** — draft the brief (template incl. the BINDING Design language section), `vob_save_brief`;
delegate the storyboard (data-only spawn); present brief + storyboard markdown together; ONE
sign-off → `vob_confirm_brief` + `vob_confirm_storyboard` → COMPOSE. Surface plan-lint warnings.

**COMPOSE** — warn that the transition pre-cuts clips, then transition. Delegate to the composer
(data-only spawn). Lint: errors → auto-retry ≤3. Lint clean → snapshot self-QC loop (≤2 rounds,
checklist in the phase file) → only then present to the user. Approve → PREVIEW.

**PREVIEW** — `vob_render_preview` (blocking, minutes on the reference host; result includes
duration-drift verification). Surface `render_path` + `stderr_log_path`. Verdict → confirm /
back-edge. Re-render resets the confirm.

**RENDER** — set ETA from preview duration ×4–8; `vob_render_full`; surface mp4 + size + log
path + any drift flag. Verdict → `vob_confirm_render` → PACKAGE. Archive fires on back-edges.

**PACKAGE** — non-interactive `vob_package_output`; report the four paths (+ loudnorm note);
auto-transition to ITERATE. Import-deliverable escape hatch lives in this phase file.

**ITERATE** — `vob_finalize_iteration`; offer done / revise-compose / revise-plan; back-edges
archive automatically — surface the paths.
```

#### (i) Escape-hatch pointer (~200 bytes)
Three lines: what `vob_import_deliverable` is for (fan-out, overlay-composited finals), and
"procedure: phases/PACKAGE.md §Escape hatch". Full prose moves there.

**DELETED from SKILL.md (the duplication/stale kill list):**
- <S:39> adaptive-intent paragraph (moves to INTENT summary + phases/INTENT.md).
- <S:41-48> long hard-rule paragraphs → replaced by the 12 one-liners (pre-cut mechanics ~250
  words at <S:46> → rule 9; resets <S:44>+<S:48> → rule 7; archive <S:47> → rule 10).
- <S:45> "`npx hyperframes` from compose/" — STALE, deleted (rule 8 states the no-npx reality).
- <S:108-418> all nine per-phase bodies → phase files. This includes deleting wholesale:
  <S:120> "`npx hyperframes transcribe`" (stale — ASR backend), <S:328> "`npx hyperframes render
  --quality draft`" (stale), <S:330> "30–90 seconds" preview ETA (contradicts the 8GB host;
  replaced in phases/PREVIEW.md), <S:350> "`npx hyperframes render`" (stale).
- The three inline spawn-prompt templates <S:147,271,304> → replaced by data-only templates in
  phase files (§2.4); all behavioral clauses in them are deleted (the agent .md files own them).
- The scene-clip rule restatements at <S:294> and <S:304> (rule 9 + composer.md are the two
  remaining homes).

**Budget check:** frontmatter 1,000 + role 200 + rules 1,700 + FSM 600 + protocol 550 + argparse
5,700 + resume 1,300 + doctor 700 + summaries 3,600 + escape 200 ≈ 15.6KB ≈ 3.9k tokens. Hard
ceiling 19KB.

### 2.3 Phase files — `skills/vob/phases/*.md` (9 files)

Common rules for all phase files:
- Combined byte budget for the nine files: ≤45,000 B hard ceiling, ≤40,000 B goal — a clean run
  Reads all nine cumulatively, so the per-run bill is spine + Σ(phase files), not the spine
  alone (see §4.6 accounting).
- No YAML frontmatter (they are plain Read targets, not skills).
- First line: `# <PHASE> — <one-line purpose>`. Second line: `Spine rules N, M apply.` (cite,
  don't restate).
- Each file carries a **Read sites** table: which tool/summary field each step consumes (C3).
- Steps are numbered and imperative, preserving ALL current behavior of the corresponding
  SKILL.md section except where this spec changes it (changes are listed per file below).
- Tool names written with the `mcp__vob__` prefix (claude-code dialect).

#### phases/INGEST.md (~1,800 B / ~450 t)
Content = <S:108-114> with these changes:
1. Step 2 reporting: pull from `files[]` (unchanged).
2. Step 3 REWRITTEN for C7: "The result no longer echoes the full toolchain preflight — it
   carries dependency FAILURES only. If `asr` failure is present, warn now (`pip install
   faster-whisper`); if `rotation_warning` is non-null, mention `VOB_DISABLE_AUTOROTATE=1`."
3. Step 5 transition; then per spine §(d), Read phases/INSPECT.md.

#### phases/INSPECT.md (~6,500 B / ~1.6k t)
Content = <S:118-156> restructured. Changes from current:
1. Step 1 expectation text: replace "via `npx hyperframes transcribe`" with "via the local ASR
   backend (faster-whisper / openai-whisper / hyperframes-whisper)".
2. Step 3 return fields: add `digest_path`, `clean_speech_path`, `strips_legend_path`,
   `strip_count` (C12 — NB: per-strip image paths are NOT a tool-return/summary field; they live
   in `strips/legend.json` `strips[].path`); keep the existing fields.
3. Step 4 (orchestrator grounding) REWRITTEN — the cost change, requirement unchanged:
   > **Ground yourself before speaking: Read `digest_path` (the INSPECT digest — per-file
   > one-liners, paragraph map, clean-cut stats, segment table, hook candidates), then Read each
   > entry of `contact_sheet_paths` (tiled thumb sheets, chunked at ≤40 cells — long sources
   > yield several per file; Read them all). Do NOT read individual `sample_thumb_paths` singles
   > unless a specific frame needs confirmation (limit 2). You must be able to write 1–2
   > sentences of concrete visual notes from what you saw.**
4. Step 5 surface-findings phrasing: keep current branches (<S:134-141>) + add one line:
   "Mention the top 1–2 `hook_candidates` from the digest — they anchor the INTENT proposal."
5. Step 5b inspector delegation: replace inline prompt with the data-only template (§2.4.1).
   Keep the one-retry-on-validator-error rule and the advisory-pools fallback (<S:149>).
   NEW step 5c (WP3 §9.3): after the inspector returns, check
   `vob_read_state_summary.inspect.classification.visual_coverage` — when
   `aroll_tagged < aroll_total` (or `hook_tagged_count === 0`), surface it as a one-line quality
   note alongside the pool split; do NOT re-loop the inspector for it.
6. Steps 6–8 (ack, transition, never-override) unchanged in substance; the never-override line
   becomes: "The server refuses `override_reason` on `inspect_not_acknowledged` (it is
   non-overridable) — there is no bypass; get the human acknowledgement."
- Read sites: `inspect.*` fields all from the inspect tool result; post-subagent classification
  counts from `vob_read_state_summary.inspect.classification` (NOT a full read — change from
  <S:149> which mandated `vob_read_state`).

#### phases/INTENT.md (~7,500 B / ~1.9k t)
Content = <S:160-222> with changes:
1. Inherited-style block (<S:164>): the cross-project read becomes
   `mcp__vob__vob_read_state_summary { project_id: <derived_from> }` — the summary carries the
   source project's full `intent.answers` verbatim (WP1 §1.4.2, read-site row :164) — plus a Read
   of the source `brief.md`. Do NOT use `vob_read_state` with `include:["intent"]`: the `include`
   enum is `history|clips|dependencies` only (anything else is rejected with INVALID_ARGUMENTS),
   and intent is in the default projection anyway. Rest unchanged (stylistic keys yes,
   `key_moments` never).
2. Propose/pre-record/batch steps (<S:166-171>): unchanged, plus one new sentence in step 1:
   "Use `digest_path`'s `hook_candidates` and clean-cut stats as proposal evidence (e.g. propose
   `key_moments` from the top-ranked hook candidate + best-take spans)."
3. Per-key guidance (<S:174-201>): kept, with `target_platform` note REPLACED (C10):
   > Record the user's words verbatim; the server canonicalizes to one of
   > `tiktok|reels|shorts|youtube|landscape|square` and attaches the platform profile
   > (dimensions, fps, safe bands, duration ideals). An unrecognized platform stays raw and
   > defaults to the vertical profile — no error, just tell the user what was assumed.
   `target_duration` note: "any duration string; the server parses it to seconds".
4. key_moments Branch A (<S:185-196>): KEPT AS-IS (client-side parse; engine-side resolution is
   explicitly not in v2 scope). One token-saving edit: step A.1 becomes "Read
   `transcript_summary_path` and show the user the paragraph LIST (numbers + first ~60 chars +
   timestamps) — not the full text; point them at the file for the full read."
5. Conditional follow-ups (<S:203-220>): kept; the state re-read sentence (<S:205>) becomes
   "inspect `missing_required_keys` from the latest `vob_record_intent_answer` result (C4) — do
   not re-read state for this."
6. Transition + `missing_keys` recovery (<S:222>): unchanged.

#### phases/PLAN.md (~6,500 B / ~1.6k t) + references/brief-design.md (~3,200 B, Read once while drafting the brief)
Content = <S:226-286> restructured, with the two new quality blocks. The brief skeleton (2) and
the tone→design table (3) live in `references/brief-design.md`, NOT in the phase file: PLAN.md
step 2 says "Read `.claude/skills/vob/references/brief-design.md` now (once; skip if already in
context) and draft the brief from its skeleton + tone table." This keeps PLAN.md lean and means
back-edges into PLAN never re-bill the template.

1. **Step 1 read sites:** `vob_read_state_summary` for paths/flags; the intent ANSWER VALUES are
   already in your conversation from INTENT — on a resume where they are not, the summary's
   `intent.answers` carries the full stored answers (C3); never call `vob_read_state` for this
   (its `include` enum is `history|clips|dependencies` only). The brief's Source line uses the
   summary's `manifest.total_duration_seconds`/`file_count`; `total_duration_seconds` is `null`
   on a pre-v2 session — only then Read `manifest.json` at `summary.manifest.path` and sum
   `files[].duration_seconds`. Read the manifest likewise when per-file detail is needed for the
   Technical line. [Replaces the <S:232> full-read mandate.]

2. **Brief template v2** (replaces <S:235-259>). Drafted verbatim — this exact skeleton goes in
   `references/brief-design.md` (with the tone table from (3) immediately after it):

```markdown
# Brief: <project_id>

## Target
- Platform: <canonical platform> (<profile.width>x<profile.height> @ <profile.fps>fps)
- Duration: <target_duration.seconds>s (platform ideal: <profile.ideal_duration_s>s)
- Source: <file_count> file(s), <total source duration>s
- Styled after: <derived_from>            ← include ONLY when state.style is set

## Hook
- Verbal hook: "<the chosen line>" — digest hook_candidate #<n>, at <t>s in file <i>
  (or, for silent sources: <the visual moment, grounded on the contact sheet>)
- Text hook: "<≤4 words>" — on screen within the first 700ms
- Why it stops the scroll: <one sentence>

## Beats
1. <beat — one idea, with the source span it comes from>
2. ...

## Tone
<answers.tone>, expanded: <2–4 concrete adjectives>

## Design language        ← BINDING for the composer; seed from the tone→design table below
- Typography: headline <kit family + weight>; captions <kit family + weight>
- Palette: bg <hex>, text <hex>, accent <hex>
- Captions: <bold-pop | clean-pill | minimal-lower-third>, <size>px, <position>,
  <ALL-CAPS | mixed case> — honor answers.captions_style verbatim where it conflicts
- Motion: <fast-snap | medium-soft | slow-cinematic>; punch-ins <yes|no>

## Constraints
- Music/VO: <answers.music_vo>
- Audio treatment: <answers.audio_treatment | n/a>
- Key moments to preserve: <answers.key_moments>
- Technical: <source resolution> → <profile.width>x<profile.height>; safe bands top
  <profile.safe_top_px>px / bottom <profile.safe_bottom_px>px
```

3. **Tone→design mapping table** (NEW, in `references/brief-design.md`, immediately after the
   template). Drafted verbatim — the orchestrator picks the row whose bucket matches `tone`
   (nearest match; blend two rows only when the user's tone genuinely spans them;
   `captions_style` answer always overrides the caption column):

```markdown
| tone bucket (match against answers.tone) | headline font (kit) | caption font (kit) | palette | caption look | motion |
|---|---|---|---|---|---|
| energetic / hype / punchy / chaotic | Anton (or Bebas Neue for taller frames) | Inter 900 | white on footage; one saturated accent (#FF3B30 or #FFD60A); high contrast | bold-pop: ALL-CAPS 3–4-word chunks, 64–72px, heavy shadow or solid pill, centered ~78% height | fast-snap: ≤0.15s entrances, beat-synced caption pops, punch-ins yes |
| cinematic / dramatic / epic | Playfair Display 700 | Inter 700 | desaturated grade via translucent overlay; off-white #F2EFE8 text; no neon | minimal-lower-third: mixed case, 56–60px, soft shadow, no pill | slow-cinematic: 0.5–0.8s ease-in-out, 1.02→1.0 scale holds, fade tails; punch-ins no |
| calm / explainer / documentary | Inter 700 | Inter 700 | muted neutrals; off-white #F5F5F0 text; single cool accent | clean-pill: rgba(0,0,0,0.55) pill, 12px radius, 56px, ≤2 lines, mixed case | medium-soft: 0.25–0.35s cubic-bezier(0.22,1,0.36,1); punch-ins no |
| comedic / playful / fun | Nunito 800 | Nunito 800 | bright + friendly; pastel accents; cream title cards | bold-pop with rounded pill; occasional single-word color emphasis | fast-medium: 0.2–0.3s springy ease-out; small rotations (±2°) on overlays only; punch-ins yes |
| raw / vlog / authentic | Inter 900 | Inter 700 | white on footage, one accent, zero decoration | bold word-chunk captions 60px, heavy shadow, no pill | medium-fast cuts; minimal overlays; punch-ins no |
```

   Exact rule sentence below the table:
   > Fill the Design language section from this table, then adjust ONLY where the user's
   > `captions_style` / rough idea / `--like` source brief say otherwise. The composer implements
   > the Design language section verbatim — it does not re-derive look from tone, so anything you
   > leave vague here will be vague on screen.

4. **Hook guidance** (NEW, 4 lines): "Pick the verbal hook from `digest_path`'s
   `hook_candidates[]` (Read the digest if it isn't in context). Prefer a mid-action,
   high-energy line that makes a claim or asks a question; NEVER a greeting or wind-up. If the
   inspector tagged `hook_candidate` segments in the pools, cross-check the candidate's segment
   is in the A-roll pool. For silent sources, the hook is the most kinetic contact-sheet cell."

5. Steps 3–9 (save_brief, log invocation, storyboarder spawn, retry-once, present, sign-off,
   branches): as current <S:261-286> with: (a) spawn template replaced by §2.4.2; (b) step 7's
   full-state re-read replaced by `vob_read_state_summary` (markdown path + scene count) + `Read`
   of `storyboard.markdown_path`; (c) NEW step 7b: "If the save result carried plan-lint
   `warnings[]` (C8/C9), present them with the plan as `⚠ plan-lint:` lines — they are exactly
   the drift/hook/B-roll problems the user should rule on at this gate."; (d) sign-off semantics
   unchanged (one approval → both confirms → transition).

#### phases/COMPOSE.md (~7,000 B / ~1.75k t)
Content = <S:290-322> + the NEW self-QC loop (condense the carried-over prose to fit the
budget — the self-QC block is load-bearing and stays whole). Structure:

1. **Pre-cut warning + transition** (<S:294> condensed to 3 lines; mechanics live in spine
   rule 9). On transition failure from a bad `out_seconds`, surface failing
   `scene_id`/`clip_index`, return to PLAN — unchanged.
2. **Read sites:** `vob_read_state_summary` → `storyboard.artifact_path`, `brief.path`,
   `manifest.path`, `composition.*`. The fresh-or-keep question on existing composition:
   unchanged (<S:296>).
3. **Delegate** — log_composer_invocation semantics unchanged (<S:298>); spawn template §2.4.3.
4. **Save-time QC rejection branch** (NEW, C13): "If the composer reports `vob_save_composition`
   rejected with QC findings, that is the same auto-retry path as lint errors below — re-invoke
   with the findings as `revision_notes` and count it against the lint-retry budget."
5. **Lint** (<S:307-322>): unchanged branching (clean / warnings_only / errors with ≤3
   auto-retries), except: findings arrive ≤10 inline (C18); pass to retries as
   "`revision_notes` = rule codes + file/line list + `report_path`" — never paste full findings
   prose (the composer reads the report itself).
6. **Self-QC loop** (NEW — the one-shot lever). Drafted verbatim:

```markdown
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
5. TASTE (never auto-fix; note for the user): font/palette feel, hook framing aesthetics,
   overlay density, pacing feel, caption position preferences within the safe band. Carry these
   as one short "things you might want changed" list when you present.
6. After 2 rounds — or a clean pass — present to the user: file list, total duration, the
   contact sheet path, any remaining taste notes, any UNRESOLVED glaring item flagged
   prominently. Then the normal approve / revise / back-to-plan branch.
```

7. **Approve→PREVIEW / revise / back-edge branches:** unchanged from <S:310-313, 320-322>.

#### phases/PREVIEW.md (~4,000 B / ~1k t)
Content = <S:326-344> with changes:
1. Delete "`npx hyperframes render --quality draft`" (<S:328>) → "a draft-quality render via the
   render tool".
2. ETA sentence (<S:330>) REPLACED: "Expect minutes, not seconds: a 20–30s vertical typically
   takes 2–10 minutes on the reference 8GB host (software GPU, 1 worker); the call blocks up to
   the duration-scaled timeout. Point the user at `stderr_log_path` for `tail -f` progress."
   (C14: preview now has a stderr log.)
3. Result fields: add C14 verification deltas — "the result carries `{duration_drift_s, width,
   height, size}`; if `duration_drift_s` > 0.5 the engine flagged silent truncation — treat it
   as a failed preview: surface it and go back to COMPOSE rather than asking the user to approve
   a truncated cut."
4. Snapshot step 3b (<S:336>): KEEP (it is the user-facing full-res still pass) but note the
   self-QC already happened in COMPOSE: "you have already QC'd the contact sheet; this pass is
   for the USER's eyes — surface paths, don't re-run the checklist."
5. Verdict branches unchanged; <S:340>'s false claim is now TRUE via C6 — phrase as: "the server
   resets `preview.confirmed` and `render.confirmed` when composition files change, and the
   PREVIEW→RENDER gate additionally blocks a preview rendered from a stale composition revision
   (stale-revision blocker). If it blocks, re-render the preview — never override."
6. Never-override line per C5 (server refuses).

#### phases/RENDER.md (~4,000 B / ~1k t)
Content = <S:348-366> with changes:
1. Delete "`npx hyperframes render`" (<S:350>).
2. ETA step 1: read `preview.render_duration_seconds` from `vob_read_state_summary` (not full
   read).
3. Result: add C14 drift deltas, same treat-as-failure rule as PREVIEW.
4. Stale-revision blocker note (C6) mirrored for `renderToPackage`.
5. ffmpeg-installed-since-INGEST override (<S:366>) — kept verbatim; this is the one sanctioned
   override (spine rule 2).

#### phases/PACKAGE.md (~5,000 B / ~1.25k t)
Content = <S:370-387> + the escape hatch moved from <S:411-418>:
1. Step 2 report: add C17 — "note the audio was loudness-normalized to −14 LUFS (disable with
   `VOB_NO_LOUDNORM=1` and re-package if the user objects) and the thumbnail is pulled from the
   hook scene."
2. Steps 3–5 unchanged.
3. **Escape hatch section** = <S:411-418> verbatim (register-finished-files + composite forms,
   PACKAGE-terminal note, audit entry), plus ONE new sentence after the overlay-over-base
   bullet (C13): "Building the overlay through the FSM works: a composition with zero `<video>`
   elements is accepted by `vob_save_composition` — composition QC downgrades the
   scene-coverage error to a `vob/overlay_scene_missing_clip` warning for zero-video
   compositions, so the overlay renders through the normal COMPOSE→PREVIEW path before you cut
   the base with ffmpeg and composite here."

#### phases/ITERATE.md (~2,500 B / ~600 t)
Content = <S:390-407> unchanged in substance; archive paths now come from the transition
response `archived.paths` (C1) — cite spine rule 10 instead of restating the mechanism.

### 2.4 Spawn prompt templates — DATA-ONLY (final)

All three templates live in their phase files. Hard rule (stated once in each template's
preamble): *no behavioral clauses in spawn prompts — the agent .md owns behavior; if you are
tempted to add an instruction, it belongs in the agent file.* Fields with no value are passed as
the literal string `none`. `<...>` values come from the read-site table of the phase file.

#### 2.4.1 Inspector (phases/INSPECT.md)
```
Task(subagent_type: "inspector",
     description: "Classify segments",
     prompt: "DATA
project_id: <project_id>
segments_path: <inspect.segments_path>
manifest_path: <manifest.path>
transcript_path: <inspect.transcript_path | none>
per_file_transcripts_dir: <inspect dir>/transcripts | none
digest_path: <inspect.digest_path | none>
strips_legend_path: <inspect.strips_legend_path | none>
strip_count: <inspect.strip_count>
revision_notes: <validator error list on a retry | none>
Follow your agent instructions.")
```

#### 2.4.2 Storyboarder (phases/PLAN.md)
```
Task(subagent_type: "storyboarder",
     description: "Storyboard scene plan",
     prompt: "DATA
project_id: <project_id>
manifest_path: <manifest.path>
brief_path: <brief.path>
intent.target_platform: <canonical>            (raw: "<raw>")
intent.platform_profile: width=<w> height=<h> fps=<fps> safe_top_px=<t> safe_bottom_px=<b> ideal_duration_s=<i> max_duration_s=<m>
intent.target_duration_seconds: <seconds>
intent.tone: <tone>
intent.key_moments: <key_moments>
intent.music_vo: <music_vo>
intent.audio_treatment: <value | n/a>
intent.captions_style: <value | n/a>
aroll_pool_path: <path | none>
broll_index_path: <path | none>
review_pool_path: <path | none>
segments_path: <path | none>
clean_speech_path: <inspect.clean_speech_path | none>
digest_path: <inspect.digest_path | none>
transcript_path: <path | none>
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
DELETED vs <S:271>: thumbnail layout math (lives at storyboarder.md grounding section), the
bracketing-frames MUST clause (agent file), the style behavioral clause ("apply the same
editorial rhythm…" — agent file §Inherited style), "Call … once / no other tools" (agent file
hard rules).

#### 2.4.3 Composer (phases/COMPOSE.md)
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
This closes the captions_style/audio_treatment/music_vo gap (brief "Established facts" #5):
the three values + the platform profile now reach the composer explicitly.
DELETED vs <S:304>: the scene-clip referencing paragraph, the STYLE REFERENCE behavioral
paragraph, the "call exactly once / don't lint or render" clauses — all live in composer.md.

### 2.5 agents/inspector.md v2 (target ≤9,000 B / ~2.2k t; current 6,897 B)

Section-by-section:
1. **Frontmatter** — unchanged (tools: Read, `mcp__vob__vob_read_state`,
   `mcp__vob__vob_save_classification`; model: opus). [Model change evaluated and rejected for
   v2 — out of brief scope.]
2. **Role + Why this exists** — keep current text (≤12 lines).
3. **Your inputs** — rewrite to enumerate the DATA spawn fields (2.4.1), including
   `per_file_transcripts_dir` (multi-file: read `file_<i>.json` for that file's words),
   `digest_path` ("the engine's heuristic read of the source — including ranked
   `hook_candidates[]` you will confirm or correct"), and `strips_legend_path` ("the ONE JSON
   legend at `inspect/strips/legend.json` — it lists every strip image path and maps each cell
   to its segment").
4. **Reading procedure (REWRITTEN — strip-based, C12):** draft verbatim:
   > Ground every judgment visually, in this order: (1) Read `strips_legend_path` FIRST — there
   > is ONE legend (`inspect/strips/legend.json`), not one per strip; its `strips[]` entries
   > give each strip image's `path` and map every cell (row-major: `cell`, `row`, `col`) to
   > `{segment_index, timestamp_seconds, start_seconds, end_seconds}`. Cells carry NO burned-in
   > labels — the legend is the only cell→segment mapping. (2) Read each strip image the legend
   > lists. A strip cell is enough to judge shot_type / subject_position / framing for most
   > segments; it is NOT enough for small on-frame text. (3) Read a segment's own
   > `keyframe_path` (a downscaled single) only when its strip cell is ambiguous, when you need
   > to read on-frame text, or for any segment a failed strip left uncovered (the legend's
   > `strip_count`/coverage tells you) — expect <20% of segments. Never classify a video segment
   > you have not seen in either form. Silent segments and audio-only files have nothing to look
   > at — classify those from transcript + priors.
5. **What to decide, per segment** — keep the three-pool routing + confidence + voiceover-spine
   rules verbatim, ADD the structured visual fields (C12; enum strings are the engine's
   `classification-schema.js` SHOT_TYPES/SUBJECT_POSITIONS — WP3 §9.1 — verbatim; any other
   value is rejected by `vob_save_classification` with INVALID_ARGUMENTS), drafted:
   > For every A-roll and B-roll entry, also record what the frame shows:
   > `shot_type`: one of `extreme_closeup | closeup | medium | wide | screen | graphic | other`
   > (`screen` = screen-recording/UI capture, `graphic` = title card/slide/chart; drone footage
   > is `wide`, cutaway detail shots are usually `closeup` or `other` — the enum has no other
   > values, anything else is rejected); `subject_position`: `left | center | right | none` (`none` for
   > empty/abstract frames with no primary subject); `framing_ok_for_vertical`: true when a 9:16
   > center crop keeps the subject and any on-frame text fully visible. These feed the
   > storyboarder's platform framing decisions — judge them from the strip cell, not the
   > metadata.
6. **Hook tagging (NEW):** drafted:
   > Tag hook candidates: set `hook_candidate: true` plus a one-line `hook_reason` on any A-roll
   > segment whose opening line is a strong claim/question/number delivered mid-action, and on
   > any B-roll clip with arresting motion or a striking frame. Start from `digest_path`'s
   > `hook_candidates[]` — confirm, demote, or add; your tags supersede the heuristic ranking.
   > Tag 2–5 candidates, never zero (pick the least-bad opening if nothing is strong, and say so
   > in `hook_reason`).
7. **Retake dedup** — unchanged.
8. **Output** — payload block updated with the new per-entry fields
   (`shot_type, subject_position, framing_ok_for_vertical, hook_candidate, hook_reason`)
   [DEP:WP3 exact schema]. Cross-check + exactly-once rules unchanged.

### 2.6 agents/storyboarder.md v2 (target ≤17,000 B / ~4.2k t; current 15,294 B)

1. **Frontmatter / role / contract** — unchanged.
2. **Your inputs** — rewrite to the DATA field list (2.4.2). New entries documented:
   - `clean_speech_path` → `inspect/clean_speech.json` `{keep_spans:[{start,end}], removed[],
     stats}`: "filler/dead-air-free spans of the A-roll in source time."
   - `digest_path` → digest incl. `hook_candidates[]`.
   - `strips_legend_path` → "the per-FILE keyframe strips: `legend.json` lists each strip
     image's path and maps cells (row-major) to `{segment_index, timestamps}` — cells are not
     labeled in the image."
   - `platform_profile` → "your `target` block and pacing table row come from these values —
     never parse the platform string yourself."
   - Pools paragraph: keep, add `hook_candidate`/`hook_reason` + visual fields to the pool field
     lists.
3. **Output schema** — keep the schema 1.0 block; ADD the optional fields (C11) with rules:
   > Optional per scene: `caption_segments: [{text, start_seconds, end_seconds, emphasis?}]` —
   > SOURCE-time caption chunks (3–5 words each) cut on clause boundaries from the transcript;
   > emit them whenever `captions` is set (the composer re-times them; you own the chunking).
   > Optional per scene: `transition_in` / `transition_out`: `"cut"` (default) or `"fade"` —
   > nothing else renders reliably on the reference host; use `fade` at most twice per video.
4. **Craft — Hook playbook (REPLACES the single hook bullet).** Drafted verbatim:
   > **The hook is the cut's most important decision.** Cold-open mid-action: the first frame is
   > already the thing happening, never a wind-up. Choose the verbal hook from the inspector's
   > `hook_candidate` tags / the digest's `hook_candidates[]`: the strongest single line that
   > makes a claim, asks a question, or names a number. NEVER open on a greeting, an intro, or
   > throat-clearing ("hey guys", "so today I want to…") — if the best take starts with one,
   > cut in after it (snap to the keep-span boundary). The hook scene is `purpose:"hook"`,
   > FIRST, and ≤3.5s (plan lint warns otherwise). Pair it with a text hook: put one ≤4-word
   > overlay in `overlays[]` for the hook scene (the composer shows it within the first 700ms).
   > The hook must promise the payoff: hook and payoff scenes should be answers to each other —
   > when the source supports it, consider ending on a frame that loops cleanly back to the
   > opening.
5. **Craft — keep-span snapping (NEW).** Drafted verbatim:
   > When `clean_speech_path` is present, the keep-spans ARE your A-roll raw material. Snap
   > every `a_roll` clip's `in_seconds`/`out_seconds` to keep-span boundaries (nearest boundary
   > within 0.5s; never start or end inside a removed span — plan lint warns when a clip
   > straddles one). Build scenes from whole keep-spans. To respect the video-element budget,
   > MERGE adjacent keep-spans into one clip when the removed gap between them is <0.8s (a beat
   > of dead air is cheaper than another video element) — plan lint is aligned with this rule:
   > it warns only when a clip contains MORE than 0.8s of removed time (or a single ≥0.8s
   > interior removed span), so sanctioned merges are lint-silent; prefer dropping the weakest
   > span over fragmenting a scene into many clips.
6. **Craft — platform pacing table (NEW).** Drafted verbatim:
   > | platform | hook | beats | cut density | captions | notes |
   > |---|---|---|---|---|---|
   > | tiktok | ≤2.5s, verbal+text | 2–4s each | a cut or visual change every 1–3s | effectively mandatory when speech exists | safe bands per profile; sound-on culture — lean on the verbal hook |
   > | reels | ≤2.5s | 2–4s | every 1.5–3s | strongly expected | bottom band is larger (UI) — keep captions at the profile's safe_bottom_px |
   > | shorts | ≤3s | 3–5s | every 2–4s | expected; a brief title-card is tolerated | slightly slower pacing reads fine |
   > | youtube / landscape | ≤4s | 4–8s | every 3–6s | lower-third style | longer beats; let shots breathe |
   > | square | ≤3s | 3–5s | every 2–4s | expected | crop-safety: prefer center-framed segments (`framing_ok_for_vertical` is a good proxy) |
7. **Craft — element budget (NEW).** Drafted verbatim:
   > **Video-element budget (host reality).** The render host is an 8GB Mac: every storyboard
   > `source_clips[]` entry becomes one `<video>` element. Keep the TOTAL across all scenes ≤6
   > (composition QC warns >6 and errors >8 — a plan that needs 10 clips will die in render,
   > not in planning). Spend them: 3–5 a_roll spans + 1–2 b_roll cutaways is the normal shape.
   > Fewer, longer, better-chosen clips beat many fragments.
8. **Source-clip grounding** — keep the mandatory-visual-grounding rule and evidence note;
   UPDATE the procedure for strips (NB: per-clip-window bracketing strips do NOT exist in v2 —
   WP3 §3.5 omitted them; never reference them): "Ground each candidate window on the per-FILE
   strips: via `strips_legend_path`, find the strip cells whose segments overlap the window and
   Read those strip images (the legend maps cells→segments/timestamps). To verify the exact
   in/out cut points, Read the bracketing thumbs/keyframe singles — compute `K_in`/`K_out` with
   the frame-index math below; that math IS the cut-point procedure, not a fallback. The frames
   are downscaled — that's fine; you are verifying content and cut points, not pixel detail."
   Keep the frame-index math (it is also the inverse mapping for evidence notes).
9. **B-roll matching / spine** — keep all five numbered rules; add a pre-compliance line:
   "Plan lint enforces: hold ≥1.5s, no back-to-back reuse of the same B-roll segment, cutaway
   inside its `narration_span`, `narration_span` inside its scene window."
10. **Overlays/captions, caption grounding, tone-honoring, key-moments-non-negotiable, total
    duration** — keep; total-duration paragraph adds: "plan lint warns when the scene-duration
    sum differs from `total_target_duration_seconds` by >0.5s or from the target by >20% —
    make the numbers add up before saving."
11. **Revision passes / hard rules** — unchanged.

DELETIONS from storyboarder.md: the `--like`/inherited-tone paragraph keeps only its 3-sentence
core; the input-description prose that duplicated the spawn prompt (now the spawn IS the field
list); no other section is removed (this file grows net ~1.7KB — quality additions outweigh
trims; that is intended by the brief).

### 2.7 agents/composer.md v2 (target ≤23,000 B / ~5.7k t; current 36,126 B)

Section plan (one canonical statement per rule):

1. **Frontmatter / role / contract** — unchanged except: delete "invoke `npx hyperframes
   render`" in the role paragraph → "the orchestrator will lint and render it via the engine".
2. **Your inputs** — rewritten to the DATA field list (2.4.3). Key new sentences:
   > `intent.captions_style`, `intent.audio_treatment`, `intent.music_vo` are the user's own
   > words/choices — they reach you directly now; honor them over any inference from tone.
   > `intent.platform_profile` gives your output dimensions and safe bands — use
   > `profile.width`/`profile.height` for the Rule of Three; do not parse the platform string.
   > The brief's **Design language** section is BINDING: implement its fonts, palette, caption
   > look, and motion intensity verbatim. You only derive look from tone when the brief
   > predates v2 and has no Design language section.
   > `clean_speech_path` is reference only (caption timing sanity) — the storyboard already
   > snapped cuts to it.
3. **Output / save call** — unchanged (file map, limits, extensions), plus C13:
   > `vob_save_composition` now runs a static QC pass and REJECTS the save (with findings) on
   > structural errors: missing Rule-of-Three attrs, unresolvable `./source/` refs, absolute
   > `src` paths, master `data-duration` shorter than the scene sum, a storyboard scene with no
   > clip element, >8 `<video>` elements. Fix and re-save; a rejection is not a crash.
   > Exception: a transparent OVERLAY composition (the overlay-over-base escape hatch) has zero
   > `<video>` elements by design — QC accepts it and downgrades the scene-coverage check to a
   > single warning (`vob/overlay_scene_missing_clip`); only build one when your revision_notes
   > explicitly ask for the overlay path.
4. **Hyperframes essentials** — keep, dedup'd: Rule of Three (one statement + the 8-line
   example), clip class (one statement, no ✗/✓ — that's in the reference file), media trim
   attrs, audio-vs-muted, track conventions. The spine+B-roll section keeps ONE pattern
   statement + pattern A example; pattern B (voiceover narration spine) is kept as a rule + its
   8-line snippet (it is the only documentation of the narration-file case). The "rules for
   both" paragraph stays.
5. **Element budget (NEW).** Drafted:
   > **≤6 `<video>` elements total** (QC warns above 6, errors above 8): the 8GB host's headless
   > Chrome dies on video-element-heavy compositions. One storyboard clip = one element; never
   > add `<video>` elements the storyboard didn't plan. Concatenated spine clips play as ONE
   > element each — never split a spine clip into fragments around a cutaway (lay B-roll OVER it
   > on a higher track).
6. **Animation** — keep both patterns (CSS-first; paused GSAP) at current length.
7. **Asset paths** — one canonical paragraph (current §Asset paths minus the duplicated
   restatements at lines 530/557 — keep the hard-rule line in §Hard rules as the only repeat).
8. **Determinism** — keep (3 lines).
9. **Lint/QC retry protocol (REPLACES the 137-line Gotchas section).** Drafted verbatim:
   > The linter + QC emit stable rule codes. If your `revision_notes` carry one or more codes
   > (e.g. `timed_element_missing_clip_class`, a `QC_*` code), `Read`
   > `.claude/skills/vob/references/lint-rules.md` FIRST and apply the canonical fix for exactly
   > those codes — do not guess. Do not read that file on a first pass or a purely user-driven
   > revision. If a code isn't listed there, the report at `lint_report_path` is ground truth.
   > Ship clean the first time: the four codes that account for nearly all failures are
   > `timed_element_missing_clip_class`, `media_missing_id`, `video_missing_muted`,
   > `font_family_without_font_face` — their rules are already stated above.
10. **Worked examples — exactly TWO** (brief D8): keep "hook scene" and "B-roll cutaway over an
    on-camera A-roll spine" verbatim; DELETE "beat scene with quick cut + captions" and "payoff
    scene with sync'd title" (composer.md:348-426 — no new mechanics). Keep the cumulative
    scene-start computation block (8 lines) that precedes the examples.
11. **Dimensions & safe zones** — REPLACE the platform table (composer.md:469-475) with:
    > Use `intent.platform_profile.width/height` from your spawn data. Fallback only if absent
    > (legacy spawn): vertical 1080×1920. Safe zones come from the profile: keep critical
    > content out of the top `safe_top_px` and bottom `safe_bottom_px`; captions sit just above
    > the bottom band. (`object-fit: cover` default / `contain` + matte on request — keep
    > current paragraph.)
12. **Craft.** Typography REWRITTEN around the kit (C16):
    > **Fonts — use the shipped kit, nothing else.** `compose/fonts.css` + `compose/fonts/` are
    > placed next to your files on every save. Load with `<link rel="stylesheet"
    > href="./fonts.css">` (or `@import url("./fonts.css");` at the top of your CSS) and use the
    > families by name — the `@font-face` rules in fonts.css make the font lint pass:
    >
    > | family | weights | use for |
    > |---|---|---|
    > | Inter | 700, 900 | captions everywhere; energetic/raw headlines |
    > | Anton | 400 | hype/punchy condensed headlines |
    > | Bebas Neue | 400 | tall display headlines |
    > | Playfair Display | 700 | cinematic/serious headlines |
    > | Nunito | 800 | comedic/playful headlines + captions |
    >
    > Never fetch fonts from a CDN, never inline base64 fonts, never use system-font stacks
    > (headless Chrome has no system fonts worth using; the lint fires on undeclared families).
    > The brief's Design language section names your families — follow it.
    Color-by-tone: keep, compressed to 4 bullets. Animation-by-pacing: keep. Caption styling:
    keep the spec numbers (56px/2-line/22-char/contrast/12%-rule) and ADD the three named looks:
    > Implement the brief's named caption look: **bold-pop** (ALL-CAPS 3–4-word chunks, 64–72px,
    > heavy shadow or solid pill, pops per chunk), **clean-pill** (mixed case, 56px,
    > rgba(0,0,0,0.55) pill, 12px radius), **minimal-lower-third** (mixed case, 56–60px, soft
    > shadow, no pill, anchored low). When the storyboard carries `caption_segments`, use them
    > as your chunking (re-time source→composition seconds); otherwise chunk 3–5 words yourself
    > from the transcript.
    Layout patterns: keep (4 bullets).
13. **Anti-patterns** — trim to 10 by deleting the four that duplicate rules stated above
    (clip-class, data-media-start, master-duration, absolute-paths — they're QC/lint codes now);
    ADD one (SwiftShader, from project memory + brief):
    > Do NOT render large color emoji (anything over ~80px) as bare text — the macOS software-GPU
    > renderer corrupts big emoji glyphs into solid boxes. Keep emoji small (≤64px) or inside a
    > solid-color pill, or use an inline SVG instead.
14. **Revision passes** — keep all 6 steps; step 3 now points at the retry protocol (§9).
15. **Hard rules** — keep, minus the duplicated scene-clip paragraph (one bullet remains:
    "`./source/<scene_id>-<clip_index>.mp4`, `data-media-start=\"0\"`, never absolute paths"),
    plus one new bullet: "≤6 `<video>` elements; never split spine clips."

**Deletion ledger (composer.md):** Gotchas ✗/✓ bodies (~9.4KB) → references/lint-rules.md;
worked examples 2 & 3 (~3.2KB) → deleted; platform table (~0.5KB) → profile rule; base64-font
guidance (~0.6KB) → deleted (kit replaces it); duplicate scene-clip/asset-path restatements
(~1.2KB) → deleted. Additions: ~2.5KB (inputs, budget, kit table, caption looks, QC). Net:
36.1KB → ~22–23KB.

### 2.8 references/lint-rules.md (NEW; ~9,000 B; loaded only on retries)

Layout: one `## <code>` section per code; each = trigger (1 line) + canonical fix (the ✗/✓ pair
moved VERBATIM from composer.md, including the alias note on `video_missing_muted`).

Sections, in order:
1. `timed_element_missing_clip_class` (from composer.md:174-190)
2. `media_missing_id` (192-209)
3. `video_missing_muted` / `media_audible_not_marked` (151-172)
4. `overlapping_clips_same_track` / `duplicate_media_discovery_risk` (211-235)
5. `font_family_without_font_face` — ✗ unchanged; ✓ REWRITTEN for the kit:
   ```css
   /* ✓ load the shipped kit and use a kit family */
   @import url("./fonts.css");
   .hook-title { font-family: "Anton", sans-serif; }
   ```
   plus the note: "never base64, never CDN — fonts.css ships in compose/ on every save."
6. `imperative_media_control` (261-282)
7. `## Composition QC codes (engine static scan)` — one subsection per QC code with a 2-line
   fix recipe. Code strings [DEP:WP4]; recipes drafted against the brief's check list:
   missing-Rule-of-Three → add the three attrs + timing to the root; unresolved-source-ref →
   the ref must be `./source/<scene_id>-<clip_index>.mp4` for an existing storyboard clip;
   absolute-src-path → make it relative; master-duration-short → set root `data-duration` ≥
   scene-sum; scene-without-clip → every storyboard scene needs ≥1 clip element (zero-video
   overlay compositions: warning `vob/overlay_scene_missing_clip` only — confirm the
   overlay-over-base path is intended); video-budget → merge/remove `<video>` elements to ≤6
   (hard error >8); nonzero
   data-media-start warning → set `0` (clips are pre-trimmed); caption-size warning → ≥56px on
   vertical.
8. Footer line: "If your code isn't here, `lint_report_path` is ground truth — fix what the
   report's file/line/message says."

### 2.9 settings.json + the REAL write-guard hook

**`settings.json` changes (exact):**
- `permissions.allow`: UNCHANGED (zero new tools; the boot drift guard verifies it).
- `hooks.PreToolUse`: REPLACE the current block (matcher `Bash|Read|Write` → no-op) with:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Write|Edit|NotebookEdit",
      "hooks": [
        {
          "type": "command",
          "command": "bash \"${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/session-write-guard.sh\"",
          "timeout": 5
        }
      ]
    }
  ]
}
```
`Read` is deliberately NOT matched: cross-project reads are required by `--like` (brief D8/D9 —
"Cross-project *reads* are deliberately not blocked"). `Bash` is not matched: the permissions
allow-list already restricts Bash to `ls/cat/jq/tail` patterns; any other Bash command prompts
the user. `statusLine` block: unchanged.

**`hooks/session-write-guard.sh` — full replacement content:**

```bash
#!/bin/bash
# video-vob session write-guard (PreToolUse: Write|Edit|NotebookEdit).
# Session state under ~/video-vob-sessions/ is owned EXCLUSIVELY by the vob MCP
# server. Blocks any direct Write/Edit targeting that tree (exit 2 = block, the
# stderr message is shown to the model). READS are not hooked — cross-project
# reads power --like style inheritance. The MCP server writes from its own
# process and is unaffected.
set -u
INPUT="$(cat)"
TARGET="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
ti = d.get("tool_input") or {}
print(ti.get("file_path") or ti.get("notebook_path") or "")
' 2>/dev/null)"
# Fallback if python3 is unavailable: crude extraction of "file_path":"..."
if [ -z "$TARGET" ]; then
  TARGET="$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -z "$TARGET" ] && exit 0
case "$TARGET" in "~/"*) TARGET="$HOME/${TARGET#\~/}" ;; esac
case "$TARGET" in
  /*) ABS="$TARGET" ;;
  *)  ABS="$PWD/$TARGET" ;;
esac
SESSION_ROOT="$HOME/video-vob-sessions"
case "$ABS" in
  "$SESSION_ROOT"|"$SESSION_ROOT"/*)
    echo "video-vob: blocked direct write to $ABS — files under ~/video-vob-sessions/ are owned by the vob MCP tools (mcp__vob__vob_*). Use the appropriate vob tool instead." >&2
    exit 2
    ;;
esac
exit 0
```

Behavioral contract: blocks Write/Edit/NotebookEdit whose `file_path` (or `notebook_path`)
resolves under `~/video-vob-sessions/`; allows everything else; allows ALL reads; exit 2 +
stderr is the Claude Code blocking convention. No symlink resolution (matching the OpenCode
plugin's `path.resolve` behavior — both guards are belt-and-suspenders over prompt rules).

### 2.10 rules/editing.md — rewrite (≤1,400 B)

Replace the second paragraph (stale `STORYBOARD` phase + unqualified override sentence). Full
replacement text:

```markdown
# video-vob editing invariants

MCP-owned JSON is the only authoritative source for FSM state. `state.json` lives in
`~/video-vob-sessions/<project_id>/` and is read/written exclusively by `mcp__vob__vob_*` tools
(a PreToolUse hook blocks direct writes there). Markdown/JSON artifacts produced in later phases
(briefs, storyboards, compositions) exist for humans and debugging — never parse them as state.
If a markdown artifact disagrees with `state.json`, the JSON wins.

Never skip forward through the FSM. The allowed transition map in `mcp/lib/session-state.js` is
the contract; every legal advance crosses exactly one edge. Back-edges are explicit — use them
when a downstream phase reveals an upstream problem (e.g. `PREVIEW → PLAN` when the cut plan is
wrong) rather than patching forward. Gate-blocked transitions can carry an `override_reason`
(recorded in `state.json.history` for audit), but the server REFUSES overrides for
inspect-acknowledgement and preview/render confirmation — those gates always require the human.
```

---

## 3. WP6 — sync (`adapters/opencode/**`, `registry-integrity.js`, `server.js`,
`scripts/m5-walker.js`, `install.sh`)

### 3.1 OpenCode adapter mirror — file-by-file

The OpenCode adapter mirrors WP5 content with three mechanical transforms:
(T1) tool prefix `mcp__vob__vob_*` → `vob_vob_*`; (T2) `Task(subagent_type: "X", …)` →
"invoke the `X` subagent with the `task` tool, passing:" + the same DATA block; (T3) `Read` (the
tool name) → "the read tool". Plus the one OpenCode-only block that must SURVIVE the rewrite:
the long-render MCP-timeout note (currently vob.md:365) moves into the RENDER phase file.

| file | change |
|---|---|
| `.opencode/agents/vob.md` | REWRITTEN as the spine: same frontmatter (description, `mode: primary`, tools denies for the 3 save tools + write/edit/patch/webfetch/websearch, permission block incl. `task` allow-list — ALL UNCHANGED, vob.md:1-28); body = WP5 spine §2.2 under T1–T3, with the "Delegating to subagents" block (vob.md:34-41) kept (it is OpenCode-specific invocation prose), and the phase-file protocol pointing at `.opencode/vob/phases/<PHASE>.md` |
| `.opencode/vob/phases/*.md` (NEW dir, 9 files) | WP5 phase files under T1–T3. phases/RENDER.md ADDITIONALLY carries the OpenCode timeout note verbatim from vob.md:365 ("OpenCode may kill a long tool call even though `opencode.json` sets `mcp.vob.timeout`; if the render call dies but `stderr_log_path` shows progress, wait for the file at the expected output path and record it with `vob_vob_import_deliverable`") |
| `.opencode/vob/references/lint-rules.md` + `.opencode/vob/references/brief-design.md` (NEW) | identical content to §2.8 / §2.3-PLAN's brief-design file (no tool names inside; copy verbatim) |
| `.opencode/agents/inspector.md` | frontmatter UNCHANGED (vob_* false wildcard + read_state + save_classification pattern); body = §2.5 under T1/T3 |
| `.opencode/agents/storyboarder.md` | frontmatter UNCHANGED; body = §2.6 under T1/T3 |
| `.opencode/agents/composer.md` | frontmatter UNCHANGED; body = §2.7 under T1/T3; the retry-protocol path is `.opencode/vob/references/lint-rules.md` |
| `.opencode/commands/vob.md` | UNCHANGED |
| `.opencode/plugins/vob-session-guard.js` | UNCHANGED |
| `.opencode/rules/vob-editing.md` | one edit: in the first paragraph add "(direct writes are blocked by the session-guard plugin)" — already true; the never-override sentence in its last paragraph is now engine-enforced, reword "can **never** be overridden" → "are refused by the server (`overridable:false`)" |
| `opencode.json` | UNCHANGED (brief D9: untouched unless return shapes demand prose updates — they don't; timeout + external_directory + instructions all stay) |

Sync discipline (goes into adapters/README.md §WP7): every WP5 prose edit lands in the opencode
twin in the same commit; the normalized-diff check in §5 verification keeps them honest.

### 3.2 `mcp/lib/registry-integrity.js` — boot drift guard extension

New exported function + wiring. Existing exports unchanged.

```js
// NEW — pure, throws nothing; returns a problems list.
// repoRoot: absolute path of the repo/installed project root.
// toolNames: array of registered engine tool names (e.g. "vob_init_project").
function verifyAdapterToolReferences({ repoRoot, toolNames }) // -> { files_checked: number, problems: string[] }
```

Checks (each file SKIPPED silently when absent — installed projects copy only what their adapter
ships; a template repo has all of them):

1. **SKILL.md allowed-tools** (`<root>/adapters/claude-code/.claude/skills/vob/SKILL.md`, and
   ALSO `<root>/.claude/skills/vob/SKILL.md` to cover installed layouts): parse frontmatter
   lines matching `/^\s*-\s*(mcp__vob__(vob_[a-z_]+))\s*$/m`. For each captured `vob_*`:
   problem `unknown tool in SKILL.md allowed-tools: <name>` when not in `toolNames`.
   Additionally: for each of `vob_save_classification`, `vob_save_storyboard`,
   `vob_save_composition` present in the list → problem
   `subagent write tool must not be orchestrator-callable: <name> found in SKILL.md allowed-tools`.
2. **settings.json** (`adapters/claude-code/.claude/settings.json` + `<root>/.claude/settings.json`):
   `JSON.parse`; for each `permissions.allow[]` entry matching `/^mcp__vob__(vob_[a-z_]+)$/`:
   unknown-name problem as above. Additionally the three subagent save tools MUST be present →
   problem `subagent write tool missing from settings.json permissions.allow: <name>`.
   Unparseable JSON → problem `settings.json is not valid JSON: <err>`.
3. **OpenCode agent frontmatter** (`adapters/opencode/.opencode/agents/*.md` +
   `<root>/.opencode/agents/*.md`): for each file, read frontmatter (reuse `readFrontmatter`),
   collect keys matching `/^\s*(vob_vob_[a-z_]+)\s*:/m`; strip the leading `vob_` once →
   unknown-name problem `unknown tool in <file> frontmatter: <key>`. For `vob.md`
   (`mode: primary`) additionally require keys `vob_vob_save_classification`,
   `vob_vob_save_storyboard`, `vob_vob_save_composition` each present with value `false` →
   problem `orchestrator must deny subagent write tool: <name>` when missing or not `false`.
4. **opencode.json** (`adapters/opencode/opencode.json` + `<root>/opencode.json`): `JSON.parse`;
   require `mcp.vob.command` to be an array whose last element ends with `mcp/server.js` →
   problem `opencode.json mcp.vob.command does not point at mcp/server.js`. (No tool names live
   in this file; this is the registration sanity check.)
5. **Reverse role-bundle check**: for every entry of `validRoleBundles` except `"orchestrator"`,
   at least one agent file across ALL scanned agent dirs resolves (via `parseAgentName`) to that
   name → problem `role bundle <name> has no agent file in any adapter`. SKIP this check
   entirely when zero agent dirs exist (installed project with no adapter agents — same
   missing-dir tolerance as today, registry-integrity.js:59).

Wiring in `mcp/server.js` (2-line change inside `runIntegrityChecks`, server.js:28-33):

```js
const { verifyAgentRegistrations, verifyAdapterToolReferences } = require("./lib/registry-integrity.js");
// ... existing per-dir verifyAgentRegistrations loop unchanged ...
const { problems } = verifyAdapterToolReferences({
  repoRoot: path.resolve(__dirname, ".."),
  toolNames: TOOLS.map((t) => t.name),
});
if (problems.length > 0) {
  throw new Error(`adapter tool-list drift:\n  - ${problems.join("\n  - ")}`);
}
```
Exit semantics unchanged: the existing catch in server.js:35-41 prints and `process.exit(1)`.
ALSO in server.js: `SERVER_INFO.version` `"1.0.0"` → `"2.0.0"` (server.js:11; coordinated with
WP7 §4.4).

### 3.3 `scripts/m5-walker.js` v2

Goals (brief D9): current conventions, dispatch-validated calls, plan lint + composition QC
exercised (positive AND negative), conditional intent keys, optional env-gated renders. Stays
zero-dep, `VOB_WALKER_SOURCE`-driven, same phase args.

**Structural changes:**
1. Replace `TOOL_HANDLERS` import with `const { executeTool } = require("../mcp/lib/dispatch.js")`
   and add the unwrap helper — every call goes through schema validation + the envelope (the
   save_classification lesson):
   ```js
   async function call(name, args) {
     const env = await executeTool(name, args);
     if (!env.ok) {
       const err = new Error(`${name}: [${env.error.code}] ${env.error.message}`);
       err.details = env.error.details;
       throw err;
     }
     return env.data;
   }
   ```
   `step()` unchanged. A second helper `expectError(name, args, codeRe)` asserts a call FAILS
   with a matching code (for the negative fixtures) and throws if it unexpectedly succeeds.
2. **New flow (phase `setup`):**
   - `vob_doctor` first (print summary; warn-only).
   - init / ingest / transition INSPECT: as today (via `call`).
   - `vob_inspect_source`; print thumbs/audio/speech + `digest_path`/`clean_speech_path` when
     present.
   - **NEW canned classification** when `segment_count > 0`: read `segments_path` from disk,
     build pools mechanically (per file: non-silence segments with `has_speech` → `aroll_pool`
     entries `{file_index, segment_index, start_seconds, end_seconds, transcript_span:
     transcript_text||"", caption:"walker", tags:[], confidence:0.9, take_group:null,
     is_best_take:true}` (+ visual fields if WP3 made them required); non-silence without speech
     → `broll_index` `{…, description:"walker coverage", tags:[], has_motion:false,
     has_usable_audio:false, confidence:0.9}`; `review:{segments:[]}`) and
     `call("vob_save_classification", …)`.
   - acknowledge + transition INTENT.
   - intent: the 5 base keys (values as today, but key_moments phrased against the real source);
     then **conditional keys**: when the inspect result had `audio_present` →
     `audio_treatment: speech_detected ? "transcribe_captions" : "keep_ambient"`; when that
     value is `transcribe_captions` → `captions_style: "bold sans, white, pill"`. Use each
     `record_intent_answer` result's `missing_required_keys` (C4) to assert the set drains to
     `[]` before transitioning.
   - transition PLAN; save/confirm brief (brief fixture gains a `## Design language` section:
     `Typography: headline Anton; captions Inter 900 / Palette: bg #000, text #FFF, accent
     #FFD60A / Captions: bold-pop, 64px / Motion: fast-snap`).
   - **NEW negative storyboard fixture** (run before the good one):
     `expectError("vob_save_storyboard", { project_id, content: badStoryboard }, /INVALID_ARGUMENTS|VALIDATION/)`
     where `badStoryboard` = the good fixture with scene 1 `out_seconds` = file duration + 60
     (plan-lint ERROR) and the hook scene moved to position 2 with `target_duration_seconds: 6`
     (two WARNING triggers — assert the error response's `details.plan_errors` is non-empty,
     `details.plan_warnings` carries both warning findings, and `error_count`/`warning_count`
     match; WP2 §2.5.2 puts `plan_warnings` on the rejection alongside `plan_errors`).
   - **Good storyboard fixture** (passes plan lint), content rules:
     - passed as an OBJECT (not a string — exercises C8),
     - 3 scenes: `s001 purpose:"hook"` FIRST with `target_duration_seconds: 2` (≤3.5);
       `s002 "beat"`; `s003 "payoff"`,
     - per-scene clip in/out within file duration − 0.1s; per-scene clip-duration sum within 15%
       of the scene target; scene sum == `total_target_duration_seconds` exactly; total within
       20% of `target.duration_seconds`,
     - when the source has speech: `captions` set on s002 with the clip window chosen to overlap
       transcript words, plus `caption_segments` (C11) with 2 chunks inside the clip window;
       when silent: `captions: null` everywhere,
     - `transition_in:"cut"` on s001 (exercises the C11 enum),
     - in/out values derived from the actual source duration (probe result), not hardcoded 10/80
       (works on any clip ≥15s; bail with a clear message when shorter).
   - confirm storyboard; transition COMPOSE (clips materialize — print `clips` from the C1
     transition return).
   - **NEW negative composition fixture**:
     `expectError("vob_save_composition", { project_id, files: badComposition }, /INVALID_ARGUMENTS|QC/)`
     where `badComposition` = the good HTML with (a) one `<video src="/absolute/path.mp4">` and
     (b) the root missing `data-composition-id` — asserts the C13 save-time rejection.
   - **Good composition fixture** (QC- and lint-clean), generated from the storyboard object:
     - master root with the Rule of Three + `data-start="0"` +
       `data-duration=<total_target_duration_seconds>`,
     - per scene: `<div class="clip" data-start data-duration data-track-index="0">` wrapping
       `<video id="sNNN-0-video" class="full-bleed" src="./source/sNNN-0.mp4" muted
       data-media-start="0" data-playback-start="0">` — scene-clip refs, zero media-start,
       clip class on every timed element (kills the three legacy violations at
       m5-walker.js:146-153),
     - the caption scene renders its `caption_segments` as `<div class="clip caption"
       data-track-index="3">` chunks with ≥56px font,
     - fonts: `<link rel="stylesheet" href="./fonts.css">` + `font-family: "Inter"` on captions
       (exercises C16 — fonts.css must exist in compose/ after save; assert
       `fs.existsSync(<session>/compose/fonts.css)` after the save step),
     - ≤6 `<video>` elements (3 here),
     - keep the GSAP-stub `window.__timelines["master"]` registration (still required by the
       hyperframes runtime; duration read from the storyboard total),
     - DELETE the manual post-save symlink block (m5-walker.js:296-300) — the engine owns
       symlinks.
   - lint via `call`; fail the walker on `errors`.
   - **NEW env-gated snapshot QC step**: when `VOB_WALKER_SNAPSHOT=1`, call
     `vob_snapshot_keyframes { project_id, timecodes: [<hook mid>, <s002 mid>] }` while still in
     COMPOSE (asserts C15) and print `contact_sheet_path`.
   - transition PREVIEW.
3. **preview / render / package phases:** unchanged flow, via `call`; print the new C14
   verification deltas (`duration_drift_s`, dimensions) when present; preview prints
   `stderr_log_path`.
4. Header comment rewritten: "v2 walker — drives the FSM through executeTool (schema +
   envelope), modeling CURRENT conventions: scene clips ./source/sNNN-K.mp4,
   data-media-start=0, clip class, plan-lint-clean storyboard, QC-clean composition, font kit."

### 3.4 `install.sh`

1. DELETE the unreachable guard (install.sh:16): `[[ "$name" == "README.md" ]] && continue`.
2. Non-destructive config copy — insert BEFORE the adapter copy (install.sh:37):
   ```bash
   # Back up any pre-existing CLI config the wholesale copy would clobber.
   for f in opencode.json .mcp.json .claude/settings.json; do
     if [[ -e "$TARGET/$f" ]]; then
       cp -R "$TARGET/$f" "$TARGET/$f.pre-vob.bak"
       echo "warning: $f existed in target — backed up to $f.pre-vob.bak (then overwritten)"
     fi
   done
   ```
3. No other changes. Fonts ship via the existing `cp -R mcp` (mcp/assets/fonts lives under
   mcp/); phases/references ship via the existing adapter wholesale copy. The font-fetch
   fallback (brief D7 "document an install-time fetch in install.sh") is OWNED BY WP4 — only if
   WP4's spec invokes the fallback does install.sh gain a fetch step; coordinate at integration
   (see §6 hand-offs).

---

## 4. WP7 — docs (`CLAUDE.md`, `README.md`, `adapters/README.md`, `.vob/*`, `NOTICE`,
`package.json`, `docs/v2/RESULTS.md`)

### 4.1 CLAUDE.md — bullet-by-bullet edit list

Edits keyed to the current file's structure:

1. **Header paragraph** ("What this is"): fix "Rendering is done by hyperframes (invoked as
   `npx hyperframes`)" → "(via a once-per-process resolved binary — no npx)"; add after the
   adapters sentence: "The claude-code orchestrator is a slim SKILL.md spine + per-phase files
   under `skills/vob/phases/` read on phase entry (OpenCode mirrors them under
   `.opencode/vob/`)."
2. **Commands section**: walker bullet REWRITTEN — delete "its inline composition predates the
   scene-clip pre-cut change … treat it as a transport/FSM smoke test, not a model of current
   COMPOSE conventions"; replace with: "it calls `executeTool` (schema validation + envelope —
   not bare handlers) against a real video and models current conventions (scene clips,
   `data-media-start=\"0\"`, clip class, plan-lint-clean storyboard, QC-clean composition); it
   exercises the plan-lint and composition-QC negative paths too."
3. **"MCP server has zero npm dependencies"** bullet: "Node ≥20" → "Node ≥22" (matches
   package.json engines).
4. **Confirm-then-transition bullet**: fix the duplicated sentence (the reset sentence appears
   twice); REWRITE to: "…Re-saving a composition resets `lint_status:\"unknown\"`,
   `preview.confirmed:false`, AND `render.confirmed:false`; re-rendering resets its own confirm;
   renders stamp `composition_revision_rendered` and the preview→render / render→package gates
   block on a stale stamp. `inspect_not_acknowledged`, `preview_not_confirmed`, and
   `render_not_confirmed` are `overridable:false` — `transitionPhase` refuses `override_reason`
   for them (this was aspirational in v1; it is enforced in v2)."
5. **NEW bullet — lean returns**: "Tool returns are lean by contract: `transition_phase` returns
   `{from,to,archived,clips,phase_summary}` (no state echo); `read_state` omits
   history/clips/dependencies unless `include:[…]`; `read_state_summary` is the orchestrator's
   workhorse per-slot digest; `record_intent_answer` returns `{recorded,
   missing_required_keys}`. On-disk state.json is unchanged and back-compatible."
6. **NEW bullet — platform profiles**: "`mcp/lib/platform-profiles.js` owns canonical platforms
   (tiktok/reels/shorts/youtube/landscape/square + aliases) → dimensions/fps/safe-bands/duration
   ideals. `record_intent_answer` canonicalizes `target_platform` ({raw,canonical,profile}) and
   `target_duration` ({raw,seconds}) at record time; downstream consumers never parse free text.
   `.vob-config/render-profiles.json` overrides are absorbed into this module."
7. **NEW bullet — plan lint + composition QC**: "`save_storyboard` runs a content-quality pass
   (errors reject; warnings ride to the plan gate); `save_composition` runs a static QC scan
   (structural errors reject the save; findings share the lint report format); render results
   carry ffprobe verification deltas (`duration_drift_s` > 0.5 = silent truncation)."
8. **Clean-cut bullet**: update the last sentences: "INSPECT writes
   `inspect/clean_speech.json`; `state.inspect.clean_speech_path` is passed to the storyboarder,
   which snaps a_roll cuts to keep-span boundaries (plan lint warns on straddles)." (The v1 text
   already claimed the storyboarder uses keep_spans — v2 makes it true; keep the ~6-element
   guidance.)
9. **INSPECT bullets**: extend the timeouts bullet's section with: "Grounding images are
   downscaled at extraction (thumbs 480w, segment keyframes 512w); INSPECT also emits per-file
   contact strips + a JSON legend, per-file transcripts (`inspect/transcripts/file_<i>.json`),
   audio features (LUFS/energy/speech-rate) in segments.json, and `inspect/digest.md` with
   ranked `hook_candidates[]` — agents read strips + the digest instead of N full-res singles.
   `snapshot_keyframes` stills stay full-res (human-facing)."
10. **Tool layer paragraph**: append: "Handler errors classify via ToolError codes only —
    the vestigial BOB2 classification (SCOPE_BLOCKED/AUTH_MISSING, scope/wave regexes) is gone."
11. **Subagents section**: update the two-subagent framing to three (inspector already exists —
    list it) and add: "Spawn prompts are data-only; all behavioral contract lives in the agent
    .md files. Composer fix recipes for lint/QC codes live in
    `skills/vob/references/lint-rules.md`, read only on a retry carrying a code."
12. **Adapter/how-to-add-a-tool paragraph**: append: "A boot drift guard
    (`verifyAdapterToolReferences`) cross-checks SKILL.md allowed-tools, settings.json
    permissions.allow, and the OpenCode frontmatter tool keys against the registry and exits 1
    on an unknown name or a leaked subagent write tool."
13. **NEW bullet — font kit (D7)**: "`mcp/assets/fonts/` ships OFL woff2 fonts + `fonts.css`;
    every `save_composition` places them in `compose/` like `source/`. The composer loads
    `./fonts.css` and uses kit families by name — the font lint passes without base64/CDN.
    Attributions in NOTICE."
14. **Write-guard**: in the "State lives outside the repo" section, add: "(both adapters enforce
    this with a real guard: a PreToolUse hook on claude-code, a plugin on OpenCode; cross-project
    reads stay open for `--like`)".
15. Historical note: unchanged.

### 4.2 README.md — rewrite outline

Keep the overall shape; corrected facts. Section list with the load-bearing sentences:

1. **Intro** — unchanged pitch; "Version 2.0."; keep the planned-adapters sentence (Kimi/Codex/
   Cursor) — it is roadmap, not a stale fact.
2. **Pipeline list** — per-phase one-liners updated: INSPECT "…word-level transcript via a
   pluggable local ASR backend (faster-whisper → openai-whisper → hyperframes), segment split,
   clean-cut analysis, contact strips, and a digest with ranked hook candidates" (DELETE "via
   `npx hyperframes transcribe`", README.md:8); PLAN "…brief (with a binding Design language
   section) + storyboard validated by a save-time plan lint"; COMPOSE "…composer authors
   hyperframes HTML against a shipped font kit; engine QC + lint + an orchestrator snapshot
   self-QC catch visual mistakes before you see a draft"; PREVIEW "draft render with
   duration-drift verification" (DELETE "`npx hyperframes render --quality draft`",
   README.md:12); PACKAGE "…loudness-normalized to −14 LUFS, hook-aware thumbnail".
3. **Requirements** — Node ≥22; ffmpeg/ffprobe unchanged; hyperframes sentence REPLACED
   (README.md:24): "**hyperframes** — install globally (`npm i -g hyperframes`); the engine
   resolves the installed binary once per process and pins it for the whole run (no npx, no
   auto-update mid-pipeline). Optional but recommended: `pip install faster-whisper` for
   transcription."
4. **Install** — unchanged + one line: "existing `opencode.json`/`.mcp.json`/`.claude/settings.json`
   in the target are backed up to `*.pre-vob.bak` before being overwritten."
5. **Quickstart / Invoking / --like** — unchanged content (verified non-stale).
6. **Architecture** — add the spine/phase-file layout sentence and "engine static QC + plan
   lint" sentence; keep the OpenCode long-render note verbatim (still true).
7. NEW short section **"What the pipeline checks for you"** (5 bullets: plan lint, composition
   QC, snapshot self-QC, render drift verification, loudness normalization) — this is the v2
   sales pitch and doubles as user docs for the new failure messages.

### 4.3 adapters/README.md

1. Contract table (README:9-18): ADD three rows:
   - `Phase detail files | .claude/skills/vob/phases/*.md | .opencode/vob/phases/*.md`
   - `Lint/QC fix reference | .claude/skills/vob/references/lint-rules.md | .opencode/vob/references/lint-rules.md`
   - `Tool-list drift guard | SKILL.md allowed-tools + settings.json verified at MCP boot | agent frontmatter tool keys verified at MCP boot`
2. Row "only MCP tools mutate state": claude-code cell → "orchestrator has no Write/Edit of
   session paths; PreToolUse write-guard hook blocks Write/Edit under ~/video-vob-sessions/
   (real in v2)".
3. Below the table, add a **Sync rule** paragraph: "The orchestrator spine, nine phase files,
   three agent files, and the lint-rules reference are hand-synced twins across adapters
   (transforms: tool prefix, task-invocation phrasing, read-tool naming). Any edit to one side
   lands in the other in the same commit; the boot drift guard catches tool-name drift, and the
   normalized-diff check in docs/v2/spec-adapters-sync-docs.md §5 catches prose drift."
4. Add-an-adapter paragraph: append "…and mirror the phase/reference files in a layout that CLI
   can Read."

### 4.4 Versions — single source

- `.vob/VERSION` → `2.0.0`
- `.vob/install.json` → `"vob_version": "2.0.0"` (fixes the 0.1.0 mismatch; `schema_version: 1`
  unchanged)
- `package.json` `"version"` → `"2.0.0"`
- `mcp/server.js` `SERVER_INFO.version` → `"2.0.0"` (edited by WP6, §3.2)
- `package.json` `"description"`: fix the stale phase list "(ingest → intent → brief →
  storyboard → …)" → "(INGEST → INSPECT → INTENT → PLAN → COMPOSE → PREVIEW → RENDER → PACKAGE
  → ITERATE)".

`package-output.js` reads `.vob/VERSION` into deliverable lineage (package-output.js:26) — no
code change needed; v2.0.0 flows through.

### 4.5 NOTICE

Append the font attributions (exact block; family list reconciled with WP4's shipped kit, C16):

```
This distribution bundles the following typefaces under the SIL Open Font
License 1.1 (https://openfontlicense.org), in mcp/assets/fonts/:

- Inter — Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
- Anton — Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont)
- Bebas Neue — Copyright 2010 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue)
- Playfair Display — Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display)
- Nunito — Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)

Each typeface's own OFL license text is included alongside the font files.
```

### 4.6 docs/v2/RESULTS.md (skeleton — created by WP7, filled at integration)

Headings: `## tools/list bytes` (before: 22,502 B / after: <measured>), `## SKILL.md + phase
files — CUMULATIVE per clean run` (before: 54,800 B ≈ 13.7k t loaded once / after: spine
<measured> + Σ all nine phase files + references read on a clean run + expected re-reads —
**count the cumulative Read bill, not the spine alone**; with the §2.2(d) read-once rule a clean
run reads each file once. NB the restructure is roughly token-NEUTRAL on a clean run — booking
"54.8KB → ≤19KB" as the win would overstate it; D8's real wins are deferred-by-phase loading on
short/aborted sessions and no re-bill on back-edges), `## agent prompts` (before/after per
file), `## per-run dynamic estimate` (read-state calls × size; image reads — **this plus D1
return shapes is where the brief's >50% goal is carried**: images ~60–90k → ~12–20k, echoes
~25–35k → ~5k; record both), `## snapshot contact-sheet geometry` (cell dimensions measured per
WP4 §15.7 — grounds the COMPOSE self-QC read plan), `## method` ("tokens = bytes/4; tools/list
measured via
`node -e "const {TOOLS}=require('./mcp/lib/tool-registry.js');console.log(JSON.stringify(TOOLS).length)"`").

---

## 5. Verification

Run from the repo root after implementation. Items marked (T) need the template repo; (I) needs
an installed project.

1. **Syntax**: `bash -n install.sh && bash -n adapters/claude-code/.claude/hooks/session-write-guard.sh`;
   `node --check scripts/m5-walker.js mcp/lib/registry-integrity.js mcp/server.js`.
2. **Boot + drift guard green** (T): `node mcp/server.js < /dev/null` exits cleanly (prints
   nothing fatal). Then prove each guard trips (mutate → boot → expect exit 1 + message → revert):
   - add `  - mcp__vob__vob_nonexistent` to SKILL.md allowed-tools → "unknown tool in SKILL.md";
   - add `mcp__vob__vob_save_storyboard` to SKILL.md allowed-tools → "must not be
     orchestrator-callable";
   - remove `vob_save_composition` from settings.json allow → "missing from settings.json";
   - add `vob_vob_bogus: true` to opencode composer.md frontmatter → "unknown tool in";
   - flip `vob_vob_save_storyboard: false` to `true` in opencode vob.md → "must deny";
   - rename `adapters/opencode/.opencode/agents/composer.md` to `composerx.md` → existing
     bundle check fires ("not registered in VALID_ROLE_BUNDLES") — confirms the old path still
     works.
3. **Write-guard hook**: feed the script stdin fixtures and check exit codes:
   `printf '{"tool_name":"Write","tool_input":{"file_path":"%s/video-vob-sessions/x/state.json"}}' "$HOME" | bash adapters/claude-code/.claude/hooks/session-write-guard.sh; echo $?` → `2`;
   same with `"file_path":"/tmp/ok.txt"` → `0`; with `"file_path":"~/video-vob-sessions/x/y"` →
   `2`; empty stdin → `0`. In-session: ask Claude to Write a file under a session dir → blocked
   with the message; ask it to Read a prior project's brief.md → allowed.
4. **Walker** (T, real clip ≥15s, speech-bearing for the conditional-key path):
   `VOB_WALKER_SOURCE=/path/clip.mp4 node scripts/m5-walker.js setup` — green run must show:
   doctor summary; classification saved; conditional keys recorded; the negative storyboard
   rejected WITH plan-lint errors+warnings printed; good storyboard saved as an object; the
   negative composition rejected with QC findings; `compose/fonts.css` exists after save; lint
   clean; with `VOB_WALKER_SNAPSHOT=1` a contact sheet path in COMPOSE. Then
   `node scripts/m5-walker.js preview` (env-gated heavy) shows drift deltas + stderr log.
   Re-run `setup` against a SILENT clip: no conditional keys, `captions:null` everywhere, still
   green.
5. **Prose drift** (T): normalized diff between adapter twins is empty:
   `for p in INGEST INSPECT INTENT PLAN COMPOSE PREVIEW RENDER PACKAGE ITERATE; do
   diff <(sed -e 's/mcp__vob__vob_/vob_vob_/g' adapters/claude-code/.claude/skills/vob/phases/$p.md) \
        adapters/opencode/.opencode/vob/phases/$p.md; done` — allowed deltas: the T2/T3 phrasing
   lines and the RENDER timeout block (whitelist them in a small `scripts/` check or eyeball).
   Same for the three agent twins; lint-rules.md and brief-design.md must be byte-identical
   across adapters.
6. **Token accounting** (WP7): byte counts via `wc -c` on SKILL.md, phases/*, agents/*,
   references/*; SKILL.md ≤19,000 B; the nine phases/*.md COMBINED ≤45,000 B (goal ≤40,000 B);
   composer.md ≤24,000 B; record all numbers — including the CUMULATIVE clean-run read bill per
   §4.6 — in docs/v2/RESULTS.md.
6b. **Engine-enum drift**: the inspector twins must quote the engine enums verbatim —
   `node -e 'const {SHOT_TYPES,SUBJECT_POSITIONS}=require("./mcp/lib/classification-schema.js");
   const fs=require("fs");for (const f of ["adapters/claude-code/.claude/agents/inspector.md",
   "adapters/opencode/.opencode/agents/inspector.md"]) { const t=fs.readFileSync(f,"utf8");
   for (const v of [...SHOT_TYPES, ...SUBJECT_POSITIONS]) if (!t.includes(v)) { console.error(f+" missing enum value: "+v); process.exit(1); } }'`
   → exits 0; also grep both inspector twins for `aerial`/`insert` → no hits (they are NOT
   engine values).
7. **Stale-fact grep is clean**:
   `grep -rn "npx hyperframes" README.md adapters/` → no hits;
   `grep -n "invoked as .npx" CLAUDE.md` → no hits (the one-runner bullet's HISTORICAL npx
   mentions — "not npx --yes hyperframes, which…" — are allowed and stay);
   `grep -rn "STORYBOARD" adapters/claude-code/.claude/rules/ adapters/opencode/.opencode/rules/`
   → no hits; `grep -n "Node ≥20" CLAUDE.md` → no hits;
   `grep -rn "30–90 seconds\|30-90 seconds" adapters/` → no hits.
8. **Versions agree**: `cat .vob/VERSION` = `2.0.0`; `grep vob_version .vob/install.json` =
   `2.0.0`; `grep '"version"' package.json` = `2.0.0`; `grep version: mcp/server.js` shows 2.0.0.
9. **Install** (I): `./install.sh /tmp/vobtest && ls /tmp/vobtest/.claude/skills/vob/phases | wc -l`
   = 9; `ls /tmp/vobtest/.claude/skills/vob/references/lint-rules.md` exists; re-run install →
   `.pre-vob.bak` warning appears for settings.json. Repeat with `opencode`:
   `ls /tmp/vobtest2/.opencode/vob/phases | wc -l` = 9.
10. **Live smoke** (manual, after WP1–4 integration): one short claude-code run to PLAN —
    confirm the orchestrator Reads phases/<PHASE>.md on each entry (visible in the transcript),
    the brief carries a Design language section, the storyboarder reports keep-span snapping,
    and the COMPOSE self-QC loop reads the contact sheet before presenting.

---

## 6. Hand-offs (files owned elsewhere that this spec touches, or vice versa)

| File | Owner | This package's interaction |
|---|---|---|
| `mcp/server.js` | unassigned in brief map; WP6 takes the 2-line drift-guard wiring + SERVER_INFO bump | WP6 edits AFTER WP1 lands (no conflicting hunks — WP1 does not touch server.js per its file list) |
| `tools/*.js` return shapes & blocker names | WP1 | phase files quote field names from C1–C7; reconcile literals at integration |
| `storyboard-schema.js` optional fields, plan-lint codes | WP2 | storyboarder.md schema block + walker fixtures must match WP2's exact codes/fields |
| `inspect` artifacts & classification schema | WP3 | inspector.md §5/§6 field names + walker classification payload must match WP3's schema; `digest_path`/`clean_speech_path`/strip paths must be exposed via C3 summary (WP1↔WP3 join — flag at integration if the summary lacks them) |
| QC codes, fonts.css + family names, render deltas | WP4 | references/lint-rules.md §7 code strings; composer.md kit table; NOTICE font list; walker font assertion. If WP4 invokes the install-time font-fetch fallback, WP6 adds the fetch step to install.sh per WP4's spec |
| `tools/save-composition.js` | WP1 then WP4 | WP5/6 do not touch it; walker exercises its final behavior |
| `.vob-config/render-profiles.example.json` | WP2 (absorb or delete per D3) | README/CLAUDE.md §4 wording assumes absorption; if WP2 deletes the file, drop the README sentence and the install.sh copy keeps working (dir may be empty — `cp -R` of a missing dir would fail; if WP2 deletes the whole dir, WP6 must guard `[[ -d .vob-config ]]` in install.sh) |
| `CLAUDE.md` | WP7 | edits in §4.1 assume WP1–4 shipped as briefed; verify each claimed behavior against the landed code before writing it as fact |
```

# end of spec
