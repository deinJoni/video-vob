# INTENT — propose from the source, confirm the gaps
Spine rules 3, 4, 11, 12 apply.

Intent is **infer-then-confirm**, not an interrogation. You have the INSPECT classification
(A-roll/B-roll/review pools, take groups, transcript, your visual notes) and possibly the **rough
idea from invocation**. Use all of it to PROPOSE the five required answers, pre-record the
confident ones, and ask only what you genuinely can't infer — batched.

## Read sites
| step | source | fields |
|---|---|---|
| inherited style | `vob_read_state_summary { project_id: <derived_from> }` | `intent.answers` (verbatim stored answers) |
| 1 | INSPECT context already in conversation | digest hook candidates, clean-cut stats, pools |
| 4A | `Read` of `transcript_summary_path` / `transcript_paragraphs_path` | paragraph list |
| 6–7 | latest `vob_record_intent_answer` result | `missing_required_keys` |

**Inherited style (when `--like` was used).** If the summary shows `style.derived_from`, that
prior project is your strongest signal for the *stylistic* keys. Before proposing, call
`mcp__vob__vob_read_state_summary { project_id: <derived_from> }` — the summary carries the source
project's full `intent.answers` verbatim — and `Read` its brief at
`~/video-vob-sessions/<derived_from>/brief.md`. Do NOT use `vob_read_state` with
`include:["intent"]`: the `include` enum is `history|clips|dependencies` only (anything else is
rejected with INVALID_ARGUMENTS), and intent is in the default projection anyway. Pre-record
`tone`, `target_platform`, `target_duration`, `music_vo`, and — when this source's audio makes
them applicable (`audio_treatment` only when audio is present; `captions_style` only when
`audio_treatment` is `keep_audio` or `transcribe_captions`) — `audio_treatment` and
`captions_style`, carried from the source. Do NOT inherit `key_moments`: those are specific to
THIS footage — derive them fresh. Tell the user what you carried over and that it's all
overridable. If the source project has been deleted (the read fails), say the styled-after
project is no longer available and fall back to inferring from this source — the lineage stays
stamped in `state.style` regardless.

1. **Propose.** From the rough idea (if any) + the classification + transcript + your visual
   read, draft a proposed value for each of the five required keys. The invocation idea is the
   strongest signal — if the user already stated platform/duration/tone/key moments there,
   pre-record those directly and don't re-ask. Use `digest_path`'s `hook_candidates` and
   clean-cut stats as proposal evidence (e.g. propose `key_moments` from the top-ranked hook
   candidate + best-take spans). `target_platform` and exact `target_duration` are usually
   genuine unknowns unless the user already said.

2. **Pre-record the confident ones** with `mcp__vob__vob_record_intent_answer { project_id, key,
   value }` and tell the user what you inferred so they can correct it ("I'm assuming
   voiceover-driven, ~45s, energetic — say the word if any of that's wrong").

3. **Ask only the gaps, batched.** Put the keys you couldn't confidently infer into one message
   (plus the one folded review-bucket question, if `review_count > 0`). Record each answer as it
   comes back. Do NOT march through all five one at a time.

Per-key guidance (for the gaps you ask, or to sanity-check a proposal):

1. **`target_platform`** — "What platform is this for? (tiktok, reels, shorts, youtube, square,
   landscape, or something else)"
   *Record the user's words verbatim; the server canonicalizes to one of
   `tiktok|reels|shorts|youtube|landscape|square|vertical` and attaches the platform profile (dimensions,
   fps, safe bands, duration ideals). An unrecognized platform stays raw and defaults to the
   vertical profile — no error, just tell the user what was assumed.*

2. **`target_duration`** — "How long should the final cut be? (e.g. 15s, 30s, 60s, 3m)"
   *Any duration string; the server parses it to seconds.*

3. **`tone`** — "What tone or vibe? (e.g. energetic, calm, dramatic, comedic, cinematic, raw)"
   *Free text. Encourage one or two words but accept short phrases.*

4. **`key_moments`** — branch on `transcript_summary_path`:

   **Branch A — `transcript_summary_path` is set** (the vlog/dialogue path):
   1. Read `transcript_summary_path` and show the user the paragraph LIST (numbers + first ~60
      chars + timestamps) — not the full text; point them at the file for the full read.
   2. Ask: "Which paragraphs MUST be in the final cut? Reference them by number (e.g. `3` or
      `3, 5-7`) — or describe in your own words if you'd rather."
   3. If the reply matches `/^[\s\d,\-]+$/` (only digits, commas, hyphens, whitespace), treat it
      as a line spec:
      - Parse into an explicit paragraph list (`"3, 5-7"` → `[3, 5, 6, 7]`; hyphens inclusive).
      - `Read` `transcript_paragraphs_path` — an array of `{ n, start, end, text }`.
      - For each selected paragraph capture `{ n, start, end, excerpt }` (`excerpt` = first ~80
        chars of `text`). Collapse contiguous runs into single timestamp ranges.
      - Build a compact resolved string, e.g. `paragraphs 3, 5-7 → 27.9–42.1s ("Now let me talk
        about…"); 65.4–102.7s ("And here's why…")`. Keep under 1000 chars.
      - Confirm: "I read that as paragraphs 3, 5-7 → <ranges>. Lock it in?" Wait for assent.
      - Record via `mcp__vob__vob_record_intent_answer { project_id, key: "key_moments",
        value: <resolved string> }`.
   4. If the reply doesn't match the regex, treat as natural language and record verbatim.

   **Branch B — no `transcript_summary_path`** (silent clip, skip, or failed transcription):
   "Any specific moments from the source that MUST be in the final cut? Timestamps or
   descriptions are both fine." *Free text; descriptions are OK.*

5. **`music_vo`** — "Music, voiceover, both, or neither?"
   *Normalize to one of those four words when possible; otherwise record what the user said.*

### The video-type beat (optional, skippable — v3)

After platform + duration are recorded, read the summary's `video_type` block (`canonical` +
`source`). When `source` is `"derived"`, PROPOSE it as one folded line in your batch — never a
standalone interrogation: "I'll treat this as **long-form** (chaptered lint, auto-segmented
render) based on youtube + 12 min — say 'cinematic', 'tutorial', 'podcast', or 'social short'
to steer differently." React:
- User confirms or stays silent on it → record nothing; the derivation stands (it is recomputed
  live, so a later platform/duration change re-derives).
- User names a type (or named one in the rough idea — e.g. "make a tutorial out of this") →
  `vob_record_intent_answer { key: "video_type", value: <their words> }`. The server
  canonicalizes (free text OK: "a cinematic montage" → `cinematic`; unrecognized stores
  `canonical:null` and falls back to derivation — tell the user what was assumed).
- `video_type` is OPTIONAL — it never appears in `missing_required_keys` and never blocks the
  INTENT→PLAN gate.
The preset matters downstream: `cinematic` turns clean-cut OFF and lints as a montage at 24fps;
`long-form`/`tutorial`/`podcast` lint chaptered (hook-first OFF) and auto-segment the render;
`social-short` is exactly the v2 rails. `vob_doctor { project_id }` shows the resolved preset +
the available table (incl. user presets from `.vob-config/video-types.json`).

### Content-conditional follow-ups

Inspect `missing_required_keys` from the latest `vob_record_intent_answer` result — do not
re-read state for this. The server derives conditional keys from inspect findings and reports
them as missing when applicable:

6. **`audio_treatment`** — only when audio is present. Phrase by speech:
   - **Speech detected**: "the source has speech (N words transcribed). How should we handle the
     audio?
     - `transcribe_captions` — burn captions from the transcript, mix audio in
     - `keep_audio` — keep dialogue audio as-is, no captions
     - `discard_audio` — drop the source audio entirely"
   - **Ambient/music only**: "the source has audio but no speech detected. Options:
     - `keep_ambient` — keep the source audio as background
     - `discard_audio` — drop it"
   Record one of the canonical tokens — the server enforces the enum (`INVALID_ARGUMENTS`
   otherwise).

7. **`captions_style`** — only when `audio_treatment` is `keep_audio` or `transcribe_captions`.
   "How should captions look? (e.g. 'bold sans, white with shadow, lower third', or whatever
   fits the tone)" — free-form string.

After all applicable keys are recorded, call `mcp__vob__vob_transition_phase { project_id,
to_phase: "PLAN" }`. If the gate blocks with `intent_answers_missing`, the blocker's
`missing_keys` tells you exactly which to re-ask — re-ask only those, record, retry. The set
already accounts for the conditional rules above.
