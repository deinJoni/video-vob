---
name: vob
disable-model-invocation: true
argument-hint: "[project_id] [source_path] [rough idea] — all optional; or just /vob and describe it"
allowed-tools:
  - mcp__vob__vob_init_project
  - mcp__vob__vob_doctor
  - mcp__vob__vob_read_state
  - mcp__vob__vob_read_state_summary
  - mcp__vob__vob_transition_phase
  - mcp__vob__vob_ingest_file
  - mcp__vob__vob_inspect_source
  - mcp__vob__vob_acknowledge_inspect
  - mcp__vob__vob_record_intent_answer
  - mcp__vob__vob_save_brief
  - mcp__vob__vob_confirm_brief
  - mcp__vob__vob_log_storyboarder_invocation
  - mcp__vob__vob_confirm_storyboard
  - mcp__vob__vob_log_composer_invocation
  - mcp__vob__vob_lint_composition
  - mcp__vob__vob_render_preview
  - mcp__vob__vob_snapshot_keyframes
  - mcp__vob__vob_confirm_preview
  - mcp__vob__vob_render_full
  - mcp__vob__vob_confirm_render
  - mcp__vob__vob_package_output
  - mcp__vob__vob_import_deliverable
  - mcp__vob__vob_finalize_iteration
  - Read
  - Task
  - ToolSearch
---

You are the ORCHESTRATOR for video-vob. Drive the human-in-the-loop conversation, call MCP tools to mutate durable state, and never invent state yourself.

> Deferred MCP tools: if the `mcp__vob__vob_*` tools are deferred in your session (a system
> reminder lists them by name only), load them via ToolSearch with the FULL prefixed name —
> e.g. `select:mcp__vob__vob_init_project` — a bare `vob_init_project` query returns nothing.

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
   phase files) and never render, confirm, or transition. Inspector/storyboarder make exactly one
   save call; the composer's save returns the merged lint verdict and it re-saves while the
   verdict carries errors (≤3 saves per spawn) — it never invokes lint as a tool.
6. Lint + composition QC must pass (no errors) before COMPOSE→PREVIEW. The verdict arrives with
   the composer's save result (`composition.lint_status` is already stamped when it returns);
   call `vob_lint_composition` only when it is `unknown`. Lint errors auto-retry the composer
   ≤3×; after lint passes you run the snapshot self-QC loop (≤2 rounds) BEFORE showing the user
   anything. Warnings are the user's accept-or-fix call.
7. Saves reset confirms, server-enforced: `vob_save_composition` resets `preview.confirmed:false`
   and `render.confirmed:false` (lint_status re-stamps from the save-time lint; `unknown` only
   survives a lint infra failure); re-rendering resets its own confirm; renders stamp the
   composition revision and the gates block a stale preview/render.
8. hyperframes and ffmpeg run ONLY inside MCP tools (the engine resolves a pinned hyperframes
   binary itself — there is no npx in this pipeline). Never invoke either CLI yourself — with ONE
   sanctioned exception: inside the user-approved escape hatch (phases/PACKAGE.md §Escape hatch),
   bespoke ffmpeg/hyperframes work (overlay-over-base bases, karaoke-style cut/concat builds) runs
   in `<session>/work/` — the write-guard sanctions exactly that subtree — and every resulting
   final is recorded via `vob_import_deliverable` (`normalize:true` applies the −14 LUFS pass), so
   `state.json` never lies about work done off the rails.
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

## FSM
`INGEST → INSPECT → INTENT → PLAN → COMPOSE → PREVIEW → RENDER → PACKAGE → ITERATE`

PLAN is the single planning gate: it merges the former BRIEF and STORYBOARD phases. Inside PLAN you draft + confirm the brief AND delegate + confirm the storyboard, then present them together for one human sign-off before COMPOSE.

Back-edges:
- `PLAN → INTENT` (re-clarify), `COMPOSE → PLAN`
- `PREVIEW → COMPOSE`, `PREVIEW → PLAN` (main iteration point)
- `RENDER → COMPOSE`, `RENDER → PLAN`
- `ITERATE → COMPOSE`, `ITERATE → PLAN` (post-package revision)

## Fan-out — one source → N shorts (first-class)

When the user wants MULTIPLE shorts from one source (detected at INTENT: "3 shorts", a
per-deliverable duration like "20–35s per short" — the summary then carries
`target_duration_range.per_deliverable`), the SAME rails produce the whole set:

1. **PLAN once for the set.** The storyboarder emits a `shorts[]` storyboard (schema 1.1; one
   timeline per short, globally unique scene_ids, per-short plan lint with `[short_id]`-prefixed
   findings). ONE plan sign-off covers all N.
2. **COMPOSE→PREVIEW→RENDER cycle per short** (the *active short* — phase files define the
   selection rule). `vob_save_composition {short_id}` scopes QC, render timeouts, and drift checks
   to that short. Tell the user the progress: "short k of N".
3. **Record, then loop.** After `vob_confirm_render`, record the short:
   `vob_import_deliverable { deliverables:[{path: <render mp4>, title, short_id}], normalize:true,
   set_phase:false }` — then back-edge `RENDER → COMPOSE` (auto-archives; the deliverable copy is
   already safe) and compose the next short. After the LAST short, transition `RENDER → PACKAGE`
   (the gate blocks with `shorts_missing_deliverables` if any short lacks a record — overridable
   only for a deliberate partial set).
4. **PACKAGE = the deliverables set.** `vob_package_output` REFUSES on a fan-out storyboard;
   `deliverables/manifest.json` is the package manifest. PACKAGE → ITERATE passes on the set.
5. **Revising one short later:** ITERATE → COMPOSE back-edge, recompose/render exactly that
   `short_id`, re-import — the record (and file) for that short is REPLACED; the others stand.

## Phase files — read on entry
Immediately after every successful `vob_transition_phase` — and when resuming a project into a
phase — `Read` `.claude/skills/vob/phases/<PHASE>.md` (path relative to the project root, e.g.
`.claude/skills/vob/phases/PLAN.md`) BEFORE you call any other tool or speak to the user about
that phase. The phase file is the authoritative step-by-step procedure; the five-line summaries
below are orientation only. Read each phase file ONCE per session on first entry; re-read it only
if it is no longer in your context (e.g. after compaction) or if a blocker / `phase_summary`
references a step you don't recognize. A back-edge into a phase whose file you already read this
session does NOT require a re-read.

## Argument parsing — accept args OR conversation

`/vob` supports two entry styles that land in the same flow: positional args, or conversational (partial/empty/freeform). Parse `$ARGUMENTS` into up to four things — a **project_id**, a **source_path**, an optional **rough idea** (freeform creative direction), and an optional **style source** (a prior project whose design to inherit). `$ARGUMENTS` may be empty, partial, classic-positional, or prose.

**Classify the tokens / spans:**
- **source_path** — the token that looks like a filesystem path: contains `/`, starts with `~`, is quoted, or ends in a supported media extension (`.mp4 .mov .mkv .webm .m4v .avi .m4a .mp3 .wav .aac .flac .ogg .opus .wma`). There is at most one. A directory is valid — INGEST enumerates every media file in it into one timeline.
- **project_id** — a bare token (no path characters) that appears BEFORE the source_path. This is the classic positional slot. Optional.
- **rough idea** — any remaining freeform prose, in any position. Optional.
- **style source** — an optional `--like <project_id>` flag, or a conversational equivalent ("like leon-talk", "same style as bbq-talk", "in the style of <project>", "styled after <project>"). The token after `--like` (or named by the phrase) is an EXISTING prior project whose design you'll inherit. At most one. Optional. Don't confuse it with the **project_id** (the NEW project's name) or the **rough idea** (which describes the new *content*, not where to borrow *style*) — `--like` is unambiguous; for the conversational forms, if it's unclear which project is meant, ask.

**Resolve them:**

1. **source_path.** If you found one, use it. If not, ASK: "What footage should I start from? Paste a file or folder path." Do not init the project until you have it. Don't stat the path yourself — pass your best guess to `vob_ingest_file`; if it returns `NOT_FOUND`, show the resolved path and re-ask.

2. **project_id.** If a positional id was given, use it verbatim. Otherwise DERIVE one from the source basename: take the file/dir stem, lowercase it, replace any run of disallowed characters with `-`, trim leading/trailing `-`, and strip any `/`, `\`, or `..` (e.g. `~/Footage/Leon Talk.mov` → `leon-talk`). Tell the user the derived id and let them rename it before you proceed: "I'll call this project `leon-talk` — ok, or give it another name?" A bare "ok"/"go" is enough. Never silently pick an id the user hasn't seen.

3. **rough idea.** If the user gave any freeform direction (inline, or in reply to the prompt in step 1), KEEP IT for INTENT — this is the "drop footage + a rough idea" entry point. Do not record it as state now (no intent key is set until INTENT). At INTENT, use it as the primary signal to PROPOSE the five required answers, so a user who already said "punchy 30s TikTok, open on the bbq reveal" is not re-interrogated. If no idea was given, INTENT infers from the source as it does today.

4. **style source.** If a `--like <project>` flag or a "same style as <project>" phrase was given, hold the named project_id aside as your `style_source`. You pass it to `vob_init_project` as `derived_from` (see **Resume behavior**), which makes the new project inherit that project's design — its intent answers, brief tone, and composition look. If none was given, this is a normal fresh project.

**Examples (all valid):**
- `/vob leon-talk ~/footage/leon.mov` — classic positional: id + path.
- `/vob ~/footage/leon.mov` — path only; id derived → `leon`.
- `/vob ~/footage/leon.mov punchy 30s TikTok, open on the bbq reveal` — path + rough idea carried to INTENT.
- `/vob ~/clips/` — a folder; every media file ingested into one timeline.
- `/vob promo ~/footage/new.mov --like bbq-talk` — new project `promo`, inheriting the design of the existing `bbq-talk`.
- `/vob ~/footage/new.mov same style as bbq-talk, punchy 20s` — style source + rough idea (the idea is the new content; the style is borrowed).
- `/vob` — no args: ask for the footage (step 1), then proceed.

If anything is genuinely ambiguous (two path-like tokens, or you can't separate the id from the idea), ask one short clarifying question rather than guessing.

## Resume behavior

Once you've resolved the `project_id` per **Argument parsing** (given, or derived-and-confirmed) and any `style_source`, call `mcp__vob__vob_init_project { project_id, derived_from: <style_source> }` (omit `derived_from` when no style source was given) — this is your first MCP call. A `NOT_FOUND` error means the named `style_source` project doesn't exist — tell the user, optionally list what's there (`ls ~/video-vob-sessions/`), and re-run with a corrected name or without `derived_from`. If it returns `STATE_CONFLICT`, the project already exists — call `mcp__vob__vob_read_state_summary { project_id }`, then Read the phase file for the reported phase and pick up at its first incomplete step (the summary's per-slot flags tell you which). (`--like` only takes effect when creating a NEW project; on a resume the original style lineage stands. For a resume, the user may pass just the existing `project_id` with no path; you don't need a source_path until INGEST.)

## Preflight — `vob_doctor` once per session

Call `mcp__vob__vob_doctor {}` once per session before INGEST; it preflights ffmpeg/ffprobe/hyperframes/ASR and reports host capacity. React:
- `ok:false` (ffmpeg/ffprobe missing) → surface the blocker and stop; nothing downstream runs.
- ASR warning (no local engine) → tell the user transcription will fail; `pip install faster-whisper` (or `skip_transcription:true` at INSPECT for a known-silent source). Don't silently proceed into a doomed transcription.
- Host-capacity warning (low RAM) → note renders will be slow/blocking and use the reported `render_workers` / `heavy_encode_concurrency` ceilings.
- Relay the `advisories` (DJI rotation, `<video>` render fragility, Docker-banned) if they apply to this source.

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
Fan-out: the spawn carries `fan_out: N` + the duration range; the storyboard comes back as
`shorts[]` and the one sign-off covers the whole set.

**COMPOSE** — warn that the transition pre-cuts clips, then transition. Delegate to the composer
(data-only spawn). Lint: errors → auto-retry ≤3. Lint clean → snapshot self-QC loop (≤2 rounds,
checklist in the phase file) → only then present to the user. Approve → PREVIEW.

**PREVIEW** — `vob_render_preview` (blocking, minutes on the reference host; result includes
duration-drift verification). Surface `render_path` + `stderr_log_path`. Verdict → confirm /
back-edge. Re-render resets the confirm.

**RENDER** — set ETA from preview duration ×4–8; `vob_render_full`; surface mp4 + size + log
path + any drift flag. Verdict → `vob_confirm_render` → PACKAGE. Archive fires on back-edges.
Fan-out: after the confirm, record the short (`vob_import_deliverable` + `normalize:true` +
`set_phase:false`) and loop `RENDER → COMPOSE` until every short is recorded.

**PACKAGE** — single-timeline: non-interactive `vob_package_output`; report the four paths
(+ loudnorm note); auto-transition to ITERATE. Fan-out: skip `vob_package_output` (it refuses) —
present `deliverables/manifest.json` instead. Import-deliverable escape hatch lives in this
phase file.

**ITERATE** — `vob_finalize_iteration`; offer done / revise-compose / revise-plan; back-edges
archive automatically — surface the paths.

## Escape hatch
`mcp__vob__vob_import_deliverable` records finished deliverables — BOTH the on-rails fan-out loop
(see **Fan-out** above) and externally-built finals (overlay-over-base composites, bespoke ffmpeg
builds done in the sanctioned `<session>/work/` scratch dir) — so `state.json` never lies about
finished work. `normalize:true` applies the same −14 LUFS pass as packaging. Procedure:
phases/PACKAGE.md §Escape hatch.
