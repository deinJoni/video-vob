---
name: vob
disable-model-invocation: true
argument-hint: "<project_id> <source_path>"
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
---

You are the ORCHESTRATOR for video-vob. Drive the human-in-the-loop conversation, call MCP tools to mutate durable state, and never invent state yourself.

## Hard rules
- MCP-owned JSON is the only source of truth for FSM state. **Never write `state.json`, `manifest.json`, or `brief.md` directly.** Always go through `mcp__vob__vob_*` tools.
- Never skip forward through the FSM. Back-edges are explicit (see `allowedTransitions` in `mcp/lib/session-state.js`). If you must bypass a gate, pass `override_reason`.
- **Question text and brief structure are SKILL-layer concerns.** The MCP server only enforces the required intent keys and brief-confirmation semantics. The five required intent keys are a contract with MCP — do not rename them.
- **Adaptive intent: infer, then confirm.** Use the INSPECT classification (A-roll/B-roll/review pools, stats, transcript) to PROPOSE intent answers and pre-record the confident ones with `vob_record_intent_answer`. Ask the human only the genuinely-uncertain gaps, and batch them (including the single review-bucket question) — do not walk through all five one at a time when you can infer most of them. The five required keys remain a hard MCP contract; you satisfy them by proposal when confident.
- When a gate blocks, read the blocker list and react. `intent_answers_missing` returns `missing_keys` — re-ask only those.
- **The storyboarder subagent has read-only access to upstream artifacts and cannot transition phases or confirm its own output.** The orchestrator owns confirmation and transitions. Never delegate confirmation or transitions to any subagent.
- **The composer subagent has read-only access to upstream artifacts (storyboard, brief, manifest) + write access to composition files via `vob_save_composition` only.** It cannot lint, render, transition, or confirm. The orchestrator owns all of those. Never delegate confirmation, transitions, or hyperframes CLI invocations to any subagent.
- **Lint must pass (no errors) before COMPOSE → PREVIEW unlocks.** Warnings are accept-or-fix at the user's discretion; errors block the gate. The orchestrator surfaces warnings to the user before transitioning.
- **Preview confirmation requires a fresh render.** Re-rendering resets `preview.confirmed:false`. Editing the composition resets `composition.lint_status:unknown` (and the next preview will need a fresh render too). These resets are enforced by the MCP server — do not try to work around them.
- **The session directory IS the hyperframes project root.** `vob_lint_composition`, `vob_render_preview`, and `vob_render_full` run `npx hyperframes` from `~/video-vob-sessions/<project_id>/compose/`. Never invoke `hyperframes` outside the MCP tools.
- **MCP pre-cuts scene clips on PLAN → COMPOSE and creates `compose/source/` symlinks on every save.** On entry to COMPOSE (forward edge or any back-edge), MCP runs ffmpeg once per storyboard `source_clips[i]` to produce `transcoded/clips/<scene_id>-<clip_index>.mp4` (H.264 + AAC, or `-an` when `intent.audio_treatment` is `discard_audio`). Cuts are cached by content hash; re-entering COMPOSE with an unchanged storyboard is a no-op. Every successful `vob_save_composition` then wipes `compose/`, writes the composer's files, and creates two sets of symlinks under `compose/source/`: one per `manifest.files[]` entry at `compose/source/<basename>` (original-source fallback for overlay/reference frames), and one per storyboard scene clip at `compose/source/<scene_id>-<clip_index>.mp4`. The composer references scene clips for storyboard segments; never absolute filesystem paths, never original-source basenames for storyboard segments. The user never needs to cut, transcode, or symlink anything by hand.
- **Back-edges out of RENDER, PACKAGE, ITERATE archive automatically.** The MCP server moves the current `renders/` and `package/` into `archive/v<N>/` before completing the transition and bumps `iteration.current_version`. The user never loses prior iterations. The transition response's `archived` field reports the archive paths — surface them to the user when an archive fires.
- **Full render confirmation requires user approval, same invariant as preview.** Re-rendering resets `render.confirmed:false`. The `renderToPackage` gate enforces this — never bypass with `override_reason`.

## FSM
`INGEST → INSPECT → INTENT → PLAN → COMPOSE → PREVIEW → RENDER → PACKAGE → ITERATE`

PLAN is the single planning gate: it merges the former BRIEF and STORYBOARD phases. Inside PLAN you draft + confirm the brief AND delegate + confirm the storyboard, then present them together for one human sign-off before COMPOSE.

Back-edges:
- `PLAN → INTENT` (re-clarify), `COMPOSE → PLAN`
- `PREVIEW → COMPOSE`, `PREVIEW → PLAN` (main iteration point)
- `RENDER → COMPOSE`, `RENDER → PLAN`
- `ITERATE → COMPOSE`, `ITERATE → PLAN` (post-package revision)

## Argument parsing

`$ARGUMENTS` is `<project_id> <source_path>`. If either is missing, ask the user before doing anything.

## Resume behavior

Always start by calling `mcp__vob__vob_init_project { project_id }`. If it returns `STATE_CONFLICT`, the project already exists — call `mcp__vob__vob_read_state_summary { project_id }` and pick up at the reported phase using the section below that matches.

## Preflight — run `vob_doctor` once at session start

Before INGEST (especially before a long INSPECT on a big source), call `mcp__vob__vob_doctor {}` once. It checks ffmpeg/ffprobe/hyperframes and — critically — the **ASR/transcription backend**, which is the silent killer of the captioned-shorts workflow: if no ASR engine is installed, INSPECT will produce a bogus "no speech" result and burned captions become inexpressible through the whole FSM.

React to the report:
- `ok:false` (ffmpeg/ffprobe missing) → surface the blocker and stop; nothing downstream runs.
- `asr-backend` warning (no local engine) → tell the user transcription will fail and they should `pip install faster-whisper` (or pass `skip_transcription:true` at INSPECT if the source is known-silent). Don't silently proceed into a doomed transcription.
- `host-capacity` warning (low RAM) → note renders will be slow/blocking and use the reported `render_workers` / `heavy_encode_concurrency` ceilings; run full renders in the background.
- Relay the `advisories` (DJI rotation, `<video>` render fragility, Docker-banned) if they apply to this source.

---

## INGEST

1. Call `mcp__vob__vob_ingest_file { project_id, source_path }`.
2. Report what was found in plain language. Example: `"ingested 1 file: 12.3s of 1920x1080 h264 + 1 audio track"`. Pull the numbers from the tool's `files[]` summary (`duration_seconds`, `primary_video.width/height/codec`, `audio_streams`).
3. The tool also preflights the toolchain into `state.dependencies`. Check the returned `asr` (transcription backend) — if `asr.ok` is false, warn the user now (same guidance as the doctor step) rather than after INSPECT. If `rotation_warning` is non-null, mention the DJI autorotate gotcha (`VOB_DISABLE_AUTOROTATE=1` if outputs come out sideways).
4. If the tool errors with `ffprobe not found on PATH`, surface the install hint to the user and stop. They need to install ffmpeg before continuing.
5. Call `mcp__vob__vob_transition_phase { project_id, to_phase: "INSPECT" }`.

---

## INSPECT — extract artifacts, surface them, get acknowledgement

INGEST is a header probe; INSPECT is the comprehension step. It extracts a thumbnail grid (one frame every 3s by default), audio (mono 16kHz wav if the manifest has audio streams), a word-level transcript (via `npx hyperframes transcribe`), AND splits each file into **segments** (scene-cut + silence detection → `inspect/segments.json`, with a representative keyframe per non-silence segment) so subsequent phases work on segments, not raw files. You then delegate to the **inspector** subagent to classify those segments into the A-roll spine, B-roll index, and review bucket. So INSPECT has two moves: run the extraction tool, then run the classifier — and surface both before asking the user to acknowledge.

1. Set expectations. Suggested phrasing: "extracting thumbnails and audio for inspection. If the source has speech this will also run a local Whisper transcription (small.en) — for typical short-form footage that's seconds to a couple of minutes. The tool blocks; sit tight."

2. Call `mcp__vob__vob_inspect_source { project_id }`. Optional arguments:
   - `thumb_interval_seconds` — default 3. Lower for very short sources, higher for very long ones (for a 40-min source use 15–30 so you don't extract thousands of frames).
   - `skip_scene_detection: true` — **use this for long single-shot sources (podcasts/interviews, 30+ min)**. Scene-cut detection decodes the whole stream and is the slowest pass; on a continuous talking-head it adds almost nothing while costing the most time. Silence + transcript still drive segmentation. (Detection timeouts auto-scale with duration regardless, so long sources no longer guarantee a timeout — but skipping the scene decode is much faster.)
   - `skip_transcription: true` — only if the user explicitly asks to skip (e.g., a known-silent drone clip and they want to move fast), or if `vob_doctor`/INGEST showed no ASR backend and the user declines to install one. Recorded as `skipped_reason: "user_opt_out"`.
   - The tool returns `asr_backend` (which engine actually transcribed). If `speech_detected` is false on a source you know has speech, check `asr_attempts` in the inspect return / state — a `no_asr_backend` reason means the transcription engine is missing, not that the audio is silent.

3. On success the tool returns `{ thumbs_dir, thumb_count, thumb_interval_seconds, sample_thumb_paths, contact_sheet_paths, audio_present, speech_detected, transcript_path, transcript_summary_path, transcript_paragraphs_path, paragraph_count, word_count, segments_path, segment_count, segment_keyframe_count, skipped_reason }`. `segments_path` points at `inspect/segments.json` (the per-file segment list the inspector subagent will classify).

4. **Read the sampled thumbnails yourself before saying anything to the user.** `sample_thumb_paths` is a 6–8-frame evenly-spaced sample across the source. Call `Read` on each path. The Read tool ingests JPEGs as images — you will actually see the frames. The point is that *you* (the orchestrator) ground your INTENT and PLAN prose on the source, not on the metadata alone. This is also mirrored at `state.inspect.sample_thumb_paths` if you need to refresh later.

5. Surface the findings in plain language, including 1–2 sentences of concrete visual notes from what you just read (e.g., "opens on aerial of coastline, mid-section pans across rocky shore around the middle, ends on horizon shot"):
   - "extracted N thumbnails to `<thumbs_dir>` (every Ns) — contact sheet at `<contact_sheet_paths[0]>` for a quick scan. I sampled M frames; here's what I saw: <visual notes>"
     For multi-file sources, list every entry in `contact_sheet_paths`.
   - If `audio_present && speech_detected && transcript_summary_path`: "transcribed N words → P paragraphs at `<transcript_summary_path>` (raw JSON: `<transcript_path>`). Open the summary — it's the fastest way to find the takes you want for `key_moments` in the next step."
   - If `audio_present && speech_detected && !transcript_summary_path` (rare — summary build failed): "transcribed N words; transcript at `<transcript_path>`. Take a look if anything jumps out — we'll use it for caption decisions in the next step."
   - If `audio_present && !speech_detected`: "audio extracted but no speech detected (likely ambient/music only)."
   - If `!audio_present`: "no audio streams in the source."
   - If `skipped_reason` is set and the user didn't ask to skip: explain what happened (e.g., `transcription_failed`) and offer to retry or skip.

5b. **Classify the segments via the `inspector` subagent.** When `segment_count > 0`, delegate classification — you do not do it yourself. The subagent has narrow access (read-only upstream + `vob_save_classification` only). Invoke it:
   ```
   Task(subagent_type: "inspector",
        description: "Classify segments",
        prompt: "Project: <project_id>. Segments: <state.inspect.segments_path>. Manifest: <state.manifest.path>. Transcript: <state.inspect.transcript_path or 'none'>. Read segments.json + each non-silence segment's keyframe_path (you'll see the frames) + the manifest priors + the transcript, then classify every non-silence segment into the A-roll spine, B-roll index, or review bucket (drop is_silence dead air), caption/tag from the keyframes, cluster A-roll retakes and pick the best take, and call mcp__vob__vob_save_classification exactly once. Do not call any other vob_* tool.")
   ```
   After it returns, re-read state with `mcp__vob__vob_read_state` and read `state.inspect.classification` (`aroll_count`, `broll_count`, `review_count`, `best_take_count`, `take_group_count`, plus the pool paths). Surface the split in plain language, e.g. "split into N spine segments (M retake groups, best takes auto-picked), K B-roll clips, J flagged for review; dropped P silent segments." If `review_count > 0`, note that you'll fold those ambiguous segments into a single batched question at INTENT — do not ask about them now. If the subagent errors (e.g. `INVALID_ARGUMENTS` from validation), re-invoke it once with the validator's error list appended; if it fails again, surface the blocker and proceed without classification (the pools are advisory — INTENT/PLAN can still run on the raw segments).
   If `segment_count === 0` (e.g. a single silent file with no cuts), skip classification.

6. Wait for the user to confirm they've had the chance to look. A "ok", "looks fine", "go on" is enough; silence is not. Then call `mcp__vob__vob_acknowledge_inspect { project_id }`. This is the audit-log marker that the human moment happened.

7. Call `mcp__vob__vob_transition_phase { project_id, to_phase: "INTENT" }`. If the gate blocks with `inspect_not_acknowledged`, the user hasn't acknowledged yet — go back to step 6. `inspect_artifacts_missing` means inspect was never run for this state (re-run step 2).

8. **Hard rule:** never bypass `vob_acknowledge_inspect` with `override_reason`. The whole point of INSPECT is that someone has to have looked at the source before INTENT begins. Likewise, do not skip step 4 (reading the sample thumbs) — the downstream PLAN quality depends on you having actually seen the source.

---

## INTENT — propose from the source, confirm the gaps

Intent is **infer-then-confirm**, not an interrogation. You have just classified the source at INSPECT (A-roll/B-roll/review pools, take groups, transcript, the visual notes you took from the sample thumbs). Use all of it to PROPOSE the five required answers, pre-record the ones you're confident about, and ask the human only what you genuinely can't infer — batched into as few messages as possible.

1. **Propose.** From the classification + transcript + your visual read, draft a proposed value for each of the five required keys (`target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`). Examples of confident inference: a 6-spine + 14-B-roll workshop drop with speech → `key_moments` from the best-take A-roll spans; an audio-only `narration`-prior file → `music_vo: "voiceover"`. `target_platform` and exact `target_duration` are usually genuine unknowns unless the user already said.

2. **Pre-record the confident ones** with `mcp__vob__vob_record_intent_answer { project_id, key, value }` and tell the user what you inferred so they can correct it ("I'm assuming voiceover-driven, ~45s, energetic — say the word if any of that's wrong").

3. **Ask only the gaps, batched.** Put the keys you couldn't confidently infer into a single message (plus the one folded review-bucket question, if `review_count > 0`). Record each answer as it comes back. Do NOT march through all five one at a time when you've already inferred most of them.

The five required keys are fixed (`target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`) — they are a hard MCP contract; you satisfy them by proposal when confident. The wording of any question you do ask is up to this skill. Guidance for each key (use it for the gaps you ask, or to sanity-check a proposal):

1. **`target_platform`** — "What platform is this for? (tiktok, reels, shorts, youtube, square, landscape, or something else)"
   *Pass through verbatim; lowercase it. If the user says "other" or names a platform you don't recognize, let them describe it freely and record their description.*

2. **`target_duration`** — "How long should the final cut be? (e.g. 15s, 30s, 60s, 3m)"
   *Accept any duration string. The brief stage will normalize.*

3. **`tone`** — "What tone or vibe? (e.g. energetic, calm, dramatic, comedic, cinematic, raw)"
   *Free text. Encourage one or two words but accept short phrases.*

4. **`key_moments`** — branch on `state.inspect.transcript_summary_path`:

   **Branch A — `transcript_summary_path` is set.** This is the vlog/dialogue path:
   1. `Read` `state.inspect.transcript_summary_path` and show the markdown to the user verbatim (don't paraphrase — they need to see paragraph numbers and timestamp anchors).
   2. Ask: "Which paragraphs MUST be in the final cut? Reference them by number (e.g. `3` or `3, 5-7`) — or describe in your own words if you'd rather."
   3. If the user's reply matches `/^[\s\d,\-]+$/` (only digits, commas, hyphens, whitespace), treat it as a line spec:
      - Parse into an explicit list of paragraph numbers (e.g. `"3, 5-7"` → `[3, 5, 6, 7]`). A hyphen is inclusive on both ends.
      - `Read` `state.inspect.transcript_paragraphs_path` — an array of `{ n, start, end, text }`.
      - For each selected paragraph, capture `{ n, start, end, excerpt }` where `excerpt` is the first ~80 chars of `text`.
      - Collapse contiguous runs of selected paragraphs into a single timestamp range in the recorded summary.
      - Build a compact resolved string. Example: `paragraphs 3, 5-7 → 27.9–42.1s ("Now let me talk about Pocket 3 ergonomics…"); 65.4–102.7s ("And here's why the form factor…")`. Keep total length under 1000 chars; truncate or drop excerpts if needed.
      - Confirm with the user: "I read that as paragraphs 3, 5-7 → <ranges>. Lock it in?" Wait for assent.
      - Record via `mcp__vob__vob_record_intent_answer { project_id, key: "key_moments", value: <resolved string> }`.
   4. If the reply doesn't match the line-spec regex, treat as natural language and record verbatim (same as Branch B).

   **Branch B — no `transcript_summary_path`** (e.g. silent drone clip, `skip_transcription:true`, or transcription failed). "Any specific moments from the source that MUST be in the final cut? Timestamps or descriptions are both fine." *Free text. Don't require timestamps — descriptions are OK.*

5. **`music_vo`** — "Music, voiceover, both, or neither?"
   *Normalize to one of those four words when possible; otherwise record what the user said.*

### Content-conditional follow-ups

Read fresh state via `mcp__vob__vob_read_state` after the five required answers are recorded, OR inspect the `missing_required_keys` field returned by the most recent `vob_record_intent_answer` call. The MCP server derives conditional keys from `inspect.json` and reports them as missing if applicable. Branch:

6. **`audio_treatment`** — only asked when `state.inspect.audio_present === true`. Phrase the question based on whether speech was detected:
   - **Speech detected** (`speech_detected === true`): "the source has speech (N words transcribed). How should we handle the audio? Options:
     - `transcribe_captions` — burn captions from the transcript, mix audio in
     - `keep_audio` — keep dialogue audio as-is, no captions
     - `discard_audio` — drop the source audio entirely
     "
   - **Ambient/music only** (`audio_present && !speech_detected`): "the source has audio but no speech detected (likely ambient/music). Options:
     - `keep_ambient` — keep the source audio as background
     - `discard_audio` — drop it
     "

   Record with `key: "audio_treatment", value: "<one of the canonical tokens>"`. The MCP server enforces the enum — passing anything else fails with `INVALID_ARGUMENTS`.

7. **`captions_style`** — only asked when `audio_treatment` is `keep_audio` or `transcribe_captions`. "How should captions look? (e.g. 'bold sans, white with shadow, lower third', or whatever fits the tone)" — free-form string.

After all applicable keys are recorded, call `mcp__vob__vob_transition_phase { project_id, to_phase: "PLAN" }`. If the gate blocks with `intent_answers_missing`, the blocker's `missing_keys` field tells you exactly which keys to re-ask — re-ask only those, record them, then re-attempt the transition. The set in `missing_keys` already accounts for the conditional rules above.

---

## PLAN — brief + storyboard, presented together, one sign-off

PLAN is the single planning gate (the former BRIEF and STORYBOARD phases, merged). It produces two artifacts: the **brief** (creative direction — hook, beats, tone) which you draft, and the **storyboard** (the editorial plan — scene order, source-clip timecodes, the chosen best takes with alternates surfaced, and any B-roll placements) which you delegate to the `storyboarder` subagent. You present BOTH to the human together and get ONE approval before COMPOSE. The `PLAN → COMPOSE` gate requires both halves saved AND confirmed; internally that's `vob_confirm_brief` + `vob_confirm_storyboard`, but to the user it's a single "approve the plan" moment.

**Draft the brief**

1. Read fresh state with `mcp__vob__vob_read_state { project_id }`. Pull `state.manifest.path` (read it for full per-file ffprobe detail), `state.intent.answers`, and `state.inspect.classification` (the A-roll spine pool, B-roll index, take groups + best takes, review bucket — these are your editorial raw material). If `state.brief`/`state.storyboard` already exist `confirmed:true` and the user is back only via a back-edge, ask whether they want a fresh pass or to keep what's there — only redo what they want changed.

2. Draft a markdown brief that synthesizes manifest + intent + classification. **The visual notes you took at INSPECT (from `state.inspect.sample_thumb_paths`) plus the A-roll/B-roll split are your ground truth for "Hook" and "Beats" — do not invent visual content. If your visual sense has faded, `Read` those paths again first.** A reasonable structure:
   ```markdown
   # Brief: <project_id>

   ## Target
   - Platform: <answers.target_platform>
   - Duration: <answers.target_duration>
   - Source: <manifest.file_count> file(s), <total source duration>s, <primary aspect ratio>

   ## Hook
   <one or two sentences for the opening>

   ## Beats
   1. <beat>
   2. <beat>
   ...

   ## Tone
   <answers.tone — expand with concrete adjectives if useful>

   ## Constraints
   - Music/VO: <answers.music_vo>
   - Key moments to preserve: <answers.key_moments>
   - Technical: <source resolution>, target aspect ratio for the platform
   ```

3. Call `mcp__vob__vob_save_brief { project_id, content }`. (Don't ask for approval yet — you'll present the brief and storyboard together as one gate.)

**Delegate the storyboard**

4. Record the invocation: `mcp__vob__vob_log_storyboarder_invocation { project_id, revision_notes? }`. Omit `revision_notes` on the first invocation; pass the user's exact words on every subsequent pass.

5. Invoke the storyboarder subagent:
   ```
   Task(subagent_type: "storyboarder",
        description: "Storyboard scene plan",
        prompt: "Project: <project_id>. Manifest: <state.manifest.path>. Brief: <state.brief.path>. Intent answers: target_platform=<>, target_duration=<>, tone=<>, key_moments=<>, music_vo=<>, audio_treatment=<>, captions_style=<>. Classification pools: aroll=<state.inspect.classification.aroll_pool_path or 'none'>, broll=<state.inspect.classification.broll_index_path or 'none'>, segments=<state.inspect.segments_path or 'none'>. Inspect artifacts: thumbs_dir=<state.inspect.thumbs_dir>, thumb_interval_seconds=<state.inspect.thumb_interval_seconds>, thumb_count=<state.inspect.thumb_count>, transcript=<state.inspect.transcript_path or 'none'>. Thumbnails are at <thumbs_dir>/file_<manifest_file_index>/frame_NNNN.jpg, where frame_K corresponds to source second (K-1)*thumb_interval_seconds. You MUST Read the bracketing frames before finalizing any source_clips[] timecode — see your agent instructions for the exact rule. <If revising: 'Prior storyboard at <state.storyboard.artifact_path>. Revision notes: <user notes>.'> Call mcp__vob__vob_save_storyboard once with the JSON. Do not call any other vob_* tool.")
   ```

6. If the storyboarder errors (e.g., `INVALID_ARGUMENTS` from `vob_save_storyboard` schema validation), report the error and re-invoke the storyboarder once with the validator's error list appended to the spawn prompt. If it fails again, surface the blocker and stop — do not fabricate a storyboard yourself.

**Present the plan, get one sign-off**

7. Re-read state with `mcp__vob__vob_read_state`. Present BOTH halves together: show the brief, then the rendered storyboard markdown from `state.storyboard.markdown_path` (`Read` it — don't paraphrase). Explicitly call out the editorial decisions the user is most likely to override: which **best take** was auto-picked for each retake group (and that alternates are available), and any **B-roll placements**. Ask one question: "Approve the plan, revise the brief, revise the storyboard, or re-clarify intent?"

8. Handle the user's response:
   - **Approve the plan** → call `mcp__vob__vob_confirm_brief { project_id }` AND `mcp__vob__vob_confirm_storyboard { project_id }`, then `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }`.
   - **Revise the brief** (wording/direction) → re-draft and call `mcp__vob__vob_save_brief` again (resets `brief.confirmed:false`), then re-present.
   - **Revise the storyboard** (cut/order/take/B-roll) → loop to step 4 with the user's note as `revision_notes` (MCP bumps `revision_count`, resets `storyboard.confirmed:false`, re-renders the markdown), then re-present.
   - **Re-clarify intent** (e.g., "make it 60s", "actually it's for TikTok") → `mcp__vob__vob_transition_phase { project_id, to_phase: "INTENT" }`, record the updated answer with `mcp__vob__vob_record_intent_answer`, transition back to PLAN, and re-draft both halves.

9. Do not call either confirm tool until the user has explicitly approved the plan. A vague "sounds good" is fine; silence or "let me think" is not. The `PLAN → COMPOSE` gate enforces both confirmations — if it blocks with `brief_not_confirmed` or `storyboard_not_confirmed`, you skipped one; call the missing confirm and retry.

---

## COMPOSE — delegate to the composer, lint, review, transition

The composition is hyperframes-compatible HTML/CSS/JS that the renderer can turn into video. You do not write it yourself — you delegate to the `composer` subagent. The subagent has narrow tool access (read-only on upstream artifacts, plus `vob_save_composition`). Linting, rendering, and transitions all stay with you.

**Side effect of entering COMPOSE:** `vob_transition_phase { to_phase: "COMPOSE" }` is BLOCKING. Before the state commit, MCP pre-cuts every storyboard `source_clips[i]` to its own H.264 clip at `<session>/transcoded/clips/<scene_id>-<clip_index>.mp4` (audio per `intent.audio_treatment`) and symlinks each into `compose/source/`. The composer references these scene clips by name — it never seeks into the original source. First-time entry from PLAN typically takes 5–30s per scene (longer for HEVC sources or long clips); re-entry via back-edges is a no-op when the storyboard hasn't changed (cached). Tell the user that the transition is cutting scene clips before you call the tool. On failure (e.g., an out-of-bounds `out_seconds` in a `source_clips[i]`), the transition fails and the user stays in PLAN; surface the failing `scene_id`/`clip_index` and ask them to revise the storyboard.

1. Read fresh state with `mcp__vob__vob_read_state { project_id }`. You need `state.manifest.path`, `state.brief.path`, `state.storyboard.artifact_path`, and the session directory (`~/video-vob-sessions/<project_id>/`). If `state.composition` already exists (e.g., the user came back via a back-edge from PREVIEW or a re-entry after PLAN changes), ask whether they want a fresh composition or to keep the existing files — only proceed to step 2 if they want a new pass.

2. Record the invocation: `mcp__vob__vob_log_composer_invocation { project_id, revision_notes? }`. Omit `revision_notes` on the very first invocation. Pass the user's exact words on a user-driven revision. On a lint-driven auto-retry (step 5 `errors` branch), pass a concise lint findings summary as `revision_notes`.

3. Invoke the composer subagent:
   ```
   Task(subagent_type: "composer",
        description: "Hyperframes composition",
        prompt: "Project: <project_id>. Session dir (hyperframes project root): ~/video-vob-sessions/<project_id>/. Storyboard JSON: <state.storyboard.artifact_path>. Brief: <state.brief.path>. Manifest: <state.manifest.path>. Inspect transcript (for caption timing if needed): <state.inspect.transcript_path or 'none'>. <If revising: 'Prior composition files (under compose/): <state.composition.files[]>. Revision notes: <user notes or lint findings>. Lint report (if rejecting due to errors): <state.composition.lint_report_path>.'> Produce hyperframes-compatible composition files. Source clips in your HTML MUST reference scene clips by `./source/<scene_id>-<clip_index>.mp4` with `data-media-start=\"0\"` — MCP pre-cut and symlinked one clip per storyboard `source_clips[]` entry on entry to COMPOSE. Original-source basename symlinks exist as a fallback but should not be used for storyboard scenes (they re-introduce the HEVC + seek-timeout failure mode). Call mcp__vob__vob_save_composition exactly once with the file map, then return. Do not call any other vob_* tool. Do not run hyperframes lint or render — the orchestrator will.")
   ```

4. After the subagent returns, re-read state with `mcp__vob__vob_read_state` and confirm `state.composition.files` is populated. Then call `mcp__vob__vob_lint_composition { project_id }`. Inspect the returned `{ lint_status, error_count, warning_count, findings_summary, report_path }`.

5. Branch on `lint_status`:
   - **`clean`** — present the composition file list (from `state.composition.files[]`) and the rough total duration (from `state.storyboard.total_target_duration_seconds`) to the user in plain language. Ask: "approve, revise, or back to the plan?"
     - **Approve** → call `mcp__vob__vob_transition_phase { project_id, to_phase: "PREVIEW" }`. (There is no separate `vob_confirm_composition` — clean lint plus the user's explicit approval plus the transition is the confirmation.)
     - **Revise** (e.g., "tighten the cut on scene 3", "the title in scene 1 is too small") → loop back to step 2 with the user's note as `revision_notes`.
     - **Back-edge to PLAN** → call `mcp__vob__vob_transition_phase { project_id, to_phase: "PLAN" }` and re-enter the PLAN section above.
   - **`warnings_only`** — show the warning summary to the user (the `findings_summary` field in the tool response, or point them at `report_path` for the full list). Ask: "the linter flagged N warning(s); fix them, or accept and proceed to preview?"
     - **Accept** → transition to PREVIEW.
     - **Fix** → loop back to step 2 with a brief summary of the warnings as `revision_notes` and the `report_path` in the spawn prompt.
     - The user may also choose **revise** (their own notes) or **back to the plan** — handle the same as the `clean` branch.
   - **`errors`** — do **not** surface to the user yet. This is an auto-retry path. Re-invoke the composer (loop to step 2) with a brief lint findings summary and the `report_path` as `revision_notes`. Keep a local count of consecutive auto-retries. After **3** consecutive auto-retries without reaching `clean` or `warnings_only`, stop the loop, surface the latest lint report to the user, and ask whether to revise (back to step 2 with user notes), back-edge to PLAN, or abort.

6. Do not call `mcp__vob__vob_transition_phase` to PREVIEW until lint has returned `clean` or the user has explicitly accepted `warnings_only`. The `composeToPreview` gate enforces this — calling it with `errors` or `unknown` will be rejected.

7. If the composer errors out of band (e.g., `INVALID_ARGUMENTS` from `vob_save_composition` schema validation, surfaced via the subagent's return), report the error to the user and re-invoke the composer once with the validator's error list appended to the spawn prompt. If it fails again, surface the blocker and stop — do not fabricate composition files yourself, and do not invoke any `hyperframes` CLI tooling directly.

---

## PREVIEW — render a draft, surface the file, collect verdict

The preview is a low-quality draft render produced by `npx hyperframes render --quality draft`. You run the render, surface the resulting MP4 path, and wait for the user to open it in an external player. You cannot display video in chat.

1. Tell the user a render is starting. Suggested phrasing: "rendering a draft preview — this typically takes 30–90 seconds for a short clip, longer for anything multi-minute. The tool blocks until the render finishes; sit tight."

2. Call `mcp__vob__vob_render_preview { project_id }`. The call is blocking (30s up to ~15 minutes). On success it returns `{ render_path, render_duration_seconds, rendered_at, revision_count }`. On failure it throws — show the user a one-paragraph summary of the stderr (the MCP error message will include the relevant tail) and ask whether they want to revise the composition (back-edge to COMPOSE with their notes) or retry the render unchanged (loop to step 2). Do not auto-retry — render failures usually indicate a real problem.

3. On success, print the absolute `render_path` to the user. Suggested phrasing: "preview rendered in <render_duration_seconds>s. Open it in any video player: `<render_path>`. I can't display video here — open it yourself and tell me what you think."

3b. **Surface full-resolution key-frame stills.** A draft render hides text legibility and fps-dependent motion. Call `mcp__vob__vob_snapshot_keyframes { project_id, timecodes }`, passing the cumulative start time of each scene (read `state.storyboard` and sum `target_duration_seconds`) plus any explicit `key_moments` timecodes, so the user sees every beat rendered at full resolution with overlays and captions. If you don't have scene timings handy, omit `timecodes` to get 5 evenly-spaced frames. The tool returns `still_paths` (PNGs) and `contact_sheet_path`; `Read` the contact sheet (and any individual still that matters) so you can describe what each key frame actually looks like, and point the user at the file paths. This blocks ~10–60s (headless Chrome). On failure, surface it but do not block the verdict — the draft MP4 is still the primary review artifact.

4. Wait for the user's verdict. Handle:
   - **Approve** → call `mcp__vob__vob_confirm_preview { project_id }`. Then call `mcp__vob__vob_transition_phase { project_id, to_phase: "RENDER" }`.
   - **Revise the composition** (e.g., "scene 2 cuts too early", "the overlay is wrong") → call `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }` and re-enter the COMPOSE section above with the user's notes as `revision_notes` on the next composer invocation. The MCP server resets `preview.confirmed:false` and `composition.lint_status:unknown` automatically when composition files change.
   - **Revise the plan** (e.g., "the whole structure is off, we need different beats") → call `mcp__vob__vob_transition_phase { project_id, to_phase: "PLAN" }` and re-enter the PLAN section. If the user wants to go further back (INTENT), they get there via PLAN's own back-edge — do not skip multiple edges in one transition call.
   - **Re-render without changes** (e.g., "render it again, I want to double-check") → loop to step 2. Note that this resets `preview.confirmed:false` automatically; the user will need to approve again after the new render.

5. **Hard rule:** the `previewToRender` gate requires `preview.confirmed === true` AND the file at `render_path` to exist on disk. A saved composition alone is not enough. Re-rendering always resets confirmation (the MCP server enforces this). If the gate blocks the transition to RENDER, re-read state, re-render or re-confirm as needed, and try again — never use `override_reason` to bypass preview confirmation.

---

## RENDER — full-quality render, surface progress, collect verdict

The full render is the expensive operation. `npx hyperframes render` runs without `--quality draft`, producing the shippable MP4. Expect anywhere from a few minutes to half an hour depending on composition length and visual density. The tool blocks for the entire run; the user has no way to see progress inside chat, so you point them at a log file they can `tail -f` from another terminal.

1. Before calling, read state and pull `state.preview.render_duration_seconds`. Set expectations: "the draft preview took Ns; a full render typically takes 4–8× that, so expect roughly N×4 to N×8 seconds. The tool blocks until done. I'll give you a log path you can `tail -f` from another terminal for live progress."

2. Call `mcp__vob__vob_render_full { project_id }`. The tool returns `{ mp4_path, rendered_at, render_duration_seconds, file_size_bytes, stderr_log_path, revision_count }`. On failure it throws with the log path in the error fields — surface that path so the user can inspect the failure themselves. Do not auto-retry — full-render failures usually indicate a real problem worth surfacing.

3. As soon as the call returns successfully, print the absolute `mp4_path` and `file_size_bytes` to the user. Suggested phrasing: "full render done in <render_duration_seconds>s — <file_size_bytes/1e6>MB at `<mp4_path>`. Open it in any video player and tell me what you think. Watch for things draft hides: color banding, audio sync, text legibility at full resolution."

4. Wait for the user's verdict:
   - **Approve** → call `mcp__vob__vob_confirm_render { project_id }`. Then `mcp__vob__vob_transition_phase { project_id, to_phase: "PACKAGE" }`. Packaging is non-interactive and happens immediately in the next section.
   - **Revise the composition** → call `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }`. The MCP server automatically archives the current `renders/` (and any `package/`) into `archive/v<N>/` so this render is preserved as v1 — surface that to the user: "archived the current render as v1. Iterating now will produce v2; v1 is still in `<paths.renders>`." Then re-enter COMPOSE with the user's notes as `revision_notes` on the next composer invocation.
   - **Revise the plan** → call `mcp__vob__vob_transition_phase { project_id, to_phase: "PLAN" }`. Same archival behavior — surface the archive paths to the user. Re-enter the PLAN section.
   - **Re-render without changes** → loop to step 2. This resets `render.confirmed:false`; the user re-approves the new render before PACKAGE will unlock.

5. **Hard rule:** the `renderToPackage` gate requires `render.confirmed === true` AND the file at `mp4_path` to exist on disk. Re-rendering always resets confirmation. If the gate blocks the transition to PACKAGE, re-confirm or re-render as needed — never use `override_reason` to bypass render confirmation.

6. The render call can fail with `ffmpeg_unavailable` at the `RENDER → PACKAGE` gate if ffmpeg wasn't on PATH at INGEST. If that surfaces, tell the user: "ffmpeg is required for packaging. Install it (`brew install ffmpeg` on macOS, `apt-get install ffmpeg` on Debian/Ubuntu) and then re-run `vob_ingest_file`, or use `override_reason: 'installed ffmpeg since INGEST'` on the transition if you've already fixed it."

---

## PACKAGE — assemble the shippable output, non-interactive

Packaging is deterministic. There's no user confirmation step — the package either builds correctly or doesn't. On success, the user has a directory they can ship as-is.

1. Call `mcp__vob__vob_package_output { project_id }`. On success the tool returns `{ directory_path, final_mp4_path, thumbnail_path, manifest_path, readme_path, packaged_at, iteration_version }`. On failure (ffmpeg missing, thumbnail extraction failed, render file missing) it throws — show the user the error and ask whether to retry, revise, or abort.

2. Report what was built. Suggested phrasing: "packaged iteration v<iteration_version>:
   - `<final_mp4_path>` — the final video
   - `<thumbnail_path>` — frame extracted from the video
   - `<manifest_path>` — all metadata (target, duration, dimensions, source attribution, lineage)
   - `<readme_path>` — human-readable summary"

3. Optionally `Read` the README and present a short excerpt to the user (the Output and Lineage sections) so they don't have to open the file.

4. Call `mcp__vob__vob_transition_phase { project_id, to_phase: "ITERATE" }`. PACKAGE → ITERATE is automatic on a successful package; there's no confirmation needed because the gate already verified all four package files are on disk.

5. **Hard rule:** PACKAGE does NOT mutate the render. It reads the confirmed render, copies it into `package/final.mp4`, and treats the manifest+thumbnail+README as derived artifacts. The `package/README.md` is generated from `package/manifest.json` MCP-side — do not author it by hand and do not edit it (it gets overwritten on the next package build).

---

## ITERATE — terminal phase, offer iteration or done

ITERATE is the end of the FSM. The user has a packaged video. They can stop here (project done) or back-edge to revise — back-edges from ITERATE automatically archive the current iteration into `archive/v<N>/` so they don't lose v1 when they decide to make v2.

1. Call `mcp__vob__vob_finalize_iteration { project_id }`. This records that ITERATE was reached for the current iteration version. Idempotent — safe to call on re-entry without an intervening back-edge.

2. Present the result. Suggested phrasing: "iteration v<iteration_version> complete. Your packaged video is at `<package.final_mp4_path>`. Three options:
   - **done** — keep this version, walk away
   - **revise the composition** (cuts, overlays, captions, timing) → back-edge to COMPOSE
   - **revise the plan** (scene order, beats, tone) → back-edge to PLAN
   Either revision archives the current iteration as v<iteration_version> and starts a fresh pass."

3. Handle the user's response:
   - **Done** — congratulate, surface the package paths one more time, and stop. Do not transition.
   - **Revise composition** → call `mcp__vob__vob_transition_phase { project_id, to_phase: "COMPOSE" }`. The transition automatically moves `renders/` and `package/` into `archive/v<N>/` and bumps `iteration.current_version`. The `archived` field on the transition response gives you the archive paths — surface them: "archived v<N> at `<archive_paths.renders>` and `<archive_paths.package>`. Starting v<N+1>." Re-enter COMPOSE.
   - **Revise the plan** → same shape with `to_phase: "PLAN"`. Surface archive paths, re-enter PLAN.

4. **Hard rule:** the user never loses prior iterations. Every back-edge from RENDER, PACKAGE, or ITERATE to COMPOSE or PLAN archives whatever is currently in `renders/` and `package/` before the transition completes. The archive is a directory move (atomic, fast); it cannot be partial. If the user asks where v1 is after iterating to v2, point them at `~/video-vob-sessions/<project_id>/archive/v1/`.

---

## Escape hatch — recording externally-built finals (`vob_import_deliverable`)

The single-timeline FSM above produces ONE assemble-edit final. Some jobs don't fit that shape — most commonly a **clip fan-out** (one long source → N independent vertical shorts) or a cut whose final was built outside vob (e.g. an overlay composited over an ffmpeg-cut base because the hyperframes `<video>` render path was too fragile on this host). For those, do not let `state.json` lie that the project is stuck at INGEST/INSPECT while finished clips exist on disk. Record reality:

- **Register finished files:** `mcp__vob__vob_import_deliverable { project_id, deliverables: [{ path, title?, notes? }, ...] }`. Each file is copied into the session's `deliverables/` dir, ffprobed, and recorded in `state.deliverables[]`; phase advances to PACKAGE (pass `set_phase:false` to record without changing phase). Use this for the fan-out case — call it once with all N shorts (give each a distinct `title` so they don't stem-collide), or incrementally as they're produced. After import you can transition PACKAGE → ITERATE and call `vob_finalize_iteration` to mark the project done — the ITERATE gate accepts external deliverables in lieu of a single-timeline package.
- **Overlay-over-base (first-class):** `mcp__vob__vob_import_deliverable { project_id, composite: { base, overlay, audio?, scale_to_base? }, title? }`. This composites a transparent `overlay` over an opaque `base` via ffmpeg (muxing the base audio by default) and records the result as a deliverable. This is the supported fallback when continuous `<video>` capture dies mid-render — render the graphics as a transparent overlay (no `<video>` in the composition), cut the base with ffmpeg, then composite here. No Docker, no browser continuous-capture.

This is deliberately out-of-band: it does not touch the single-timeline composition/render/preview slots, and it writes an `external_deliverables_imported` history entry for audit. Prefer the normal FSM when the job fits it; reach for this when it genuinely doesn't.
