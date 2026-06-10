# INSPECT — extract artifacts, ground yourself, classify, get acknowledgement
Spine rules 2, 5, 11, 12 apply.

INGEST is a header probe; INSPECT is the comprehension step. It extracts a thumbnail grid, audio,
a word-level transcript (via the local ASR backend: faster-whisper / openai-whisper /
hyperframes-whisper), clean-speech keep-spans, AND splits each file into **segments** (scene-cut +
silence detection → `inspect/segments.json`, with per-segment energy/speech-rate and a keyframe
per non-silence segment, tiled into contact strips). You then delegate to the **inspector**
subagent to classify those segments into the A-roll spine, B-roll index, and review bucket. Two
moves: run the extraction tool, then run the classifier — surface both before asking the user to
acknowledge.

## Read sites
| step | source | fields |
|---|---|---|
| 2–5 | `vob_inspect_source` result | everything listed in step 3 |
| 5b | `vob_read_state_summary` → `inspect.classification` | `aroll_count, broll_count, review_count, take_group_count, best_take_count, visual_coverage, hook_tagged_count`, pool paths |

1. Set expectations: "extracting thumbnails and audio for inspection. If the source has speech
   this will also run a local Whisper transcription — for typical short-form footage that's
   seconds to a couple of minutes. The tool blocks; sit tight."

2. Call `vob_vob_inspect_source { project_id }`. Optional arguments:
   - `thumb_interval_seconds` — default 3. Lower for very short sources, higher for very long
     ones (for a 40-min source use 15–30 so you don't extract thousands of frames).
   - `skip_scene_detection: true` — **use for long single-shot sources (podcasts/interviews,
     30+ min)**. Scene-cut detection decodes the whole stream and is the slowest pass; on a
     continuous talking-head it adds almost nothing. Silence + transcript still drive
     segmentation. (Timeouts auto-scale with duration regardless.)
   - `skip_transcription: true` — only if the user explicitly asks to skip, or doctor/INGEST
     showed no ASR backend and the user declines to install one. Recorded as
     `skipped_reason: "user_opt_out"`.
   - The result's `asr_backend` says which engine transcribed. If `speech_detected` is false on
     a source you know has speech, check `asr_attempts` — a `no_asr_backend` reason means the
     engine is missing, not that the audio is silent.

3. On success the result carries `{ thumbs_dir, thumb_count, thumb_interval_seconds,
   sample_thumb_paths, contact_sheet_paths, audio_present, speech_detected, transcript_path,
   transcript_summary_path, transcript_paragraphs_path, paragraph_count, word_count,
   segments_path, segment_count, segment_keyframe_count, skipped_reason, digest_path,
   clean_speech_path, strips_legend_path, strip_count, transcripts, hook_candidate_count,
   hook_candidates_top }`. NB: per-strip image paths are NOT a return/summary field — they live
   in `strips/legend.json` `strips[].path` (the inspector reads that legend, not you).

4. **Ground yourself before speaking: read `digest_path` (the INSPECT digest — per-file
   one-liners, paragraph map, clean-cut stats, segment table, hook candidates), then read each
   entry of `contact_sheet_paths` (tiled thumb sheets, chunked at ≤40 cells — long sources yield
   several per file; read them all). Do NOT read individual `sample_thumb_paths` singles unless a
   specific frame needs confirmation (limit 2). You must be able to write 1–2 sentences of
   concrete visual notes from what you saw.**
   If `contact_sheet_paths` is empty or the result carries thumbnail `warnings` (degraded
   extraction), ground from the strip images instead — `strips/legend.json` lists `strips[].path`
   — plus segment keyframes; the visual-notes requirement still applies.

5. Surface the findings in plain language, including your concrete visual notes:
   - "extracted N thumbnails to `<thumbs_dir>` (every Ns) — contact sheet(s) at
     `<contact_sheet_paths>`. Here's what I saw: <visual notes>"
   - If `audio_present && speech_detected && transcript_summary_path`: "transcribed N words → P
     paragraphs at `<transcript_summary_path>` (raw JSON: `<transcript_path>`). Open the summary —
     it's the fastest way to find the takes you want for `key_moments` in the next step."
   - If `audio_present && speech_detected && !transcript_summary_path` (rare): "transcribed N
     words; transcript at `<transcript_path>`."
   - If `audio_present && !speech_detected`: "audio extracted but no speech detected (likely
     ambient/music only)."
   - If `!audio_present`: "no audio streams in the source."
   - If `skipped_reason` is set and the user didn't ask to skip: explain (e.g.
     `transcription_failed`) and offer to retry or skip.
   - If the result carries `warnings` (thumbnail/contact-sheet degradation — stand-in frames,
     partial sheets), say so in one line; classification is unaffected (it grounds on segment
     keyframes/strips, not thumbs).
   - Mention the top 1–2 `hook_candidates` from the digest — they anchor the INTENT proposal.

5b. **Classify the segments via the `inspector` subagent.** When `segment_count > 0`, delegate —
   you do not classify yourself. This holds even for a single-segment source where the pass looks
   trivial: it's quick, and the classification record (pools + visual fields + hook tags) is what
   the storyboarder grounds on — skipping it starves PLAN. Spawn prompt is DATA-ONLY (no
   behavioral clauses — the agent .md owns behavior; if you are tempted to add an instruction, it
   belongs in the agent file). Fields with no value are passed as the literal string `none`.
   Invoke the `inspector` subagent with the `task` tool, passing:
   ```
   DATA
   project_id: <project_id>
   segments_path: <inspect.segments_path>
   manifest_path: <manifest.path>
   transcript_path: <inspect.transcript_path | none>
   per_file_transcripts_dir: <inspect dir>/transcripts | none
   digest_path: <inspect.digest_path | none>
   strips_legend_path: <inspect.strips_legend_path | none>
   strip_count: <inspect.strip_count>
   revision_notes: <validator error list on a retry | none>
   Follow your agent instructions.
   ```
   After it returns, read `vob_vob_read_state_summary` → `inspect.classification` (NOT a
   full state read) and surface the split: "split into N spine segments (M retake groups, best
   takes auto-picked), K B-roll clips, J flagged for review; dropped P silent segments." If
   `review_count > 0`, note you'll fold those into a single batched question at INTENT — do not
   ask now. If the subagent errors (e.g. `INVALID_ARGUMENTS` from validation), re-invoke it once
   with the validator's error list as `revision_notes`; if it fails again, surface the blocker
   and proceed without classification (the pools are advisory — INTENT/PLAN still run on the raw
   segments). If `segment_count === 0`, skip classification.

5c. After the inspector returns, check `inspect.classification.visual_coverage` — when
   `aroll_tagged < aroll_total` (or `hook_tagged_count === 0`), surface it as a one-line quality
   note alongside the pool split; do NOT re-loop the inspector for it.

6. Wait for the user to confirm they've had the chance to look. A "ok", "looks fine", "go on" is
   enough; silence is not. Then call `vob_vob_acknowledge_inspect { project_id }`.

7. Call `vob_vob_transition_phase { project_id, to_phase: "INTENT" }`. If the gate blocks
   with `inspect_not_acknowledged`, the user hasn't acknowledged — back to step 6.
   `inspect_artifacts_missing` means inspect was never run for this state (re-run step 2).

8. The server refuses `override_reason` on `inspect_not_acknowledged` (it is non-overridable) —
   there is no bypass; get the human acknowledgement. Likewise never skip step 4: downstream PLAN
   quality depends on you having actually seen the source.
