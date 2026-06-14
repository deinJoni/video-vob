# INTENT — propose from the source, confirm the gaps
Spine rules 3, 4, 11, 12 apply.

Intent is **infer-then-confirm**, not an interrogation. You have the INSPECT classification
(A-roll/B-roll/review pools, take groups, transcript, your visual notes) and possibly the **rough
idea from invocation**. Use all of it to PROPOSE the answers, pre-record the confident ones, and
ask only what you genuinely can't infer — batched.

**This is the ONE human-input round.** Everything a later phase would otherwise ask the human
(the look, the pacing, the opening) or silently guess, you capture or PROPOSE here so PLAN /
COMPOSE / RENDER never have to bounce back. Beyond the five required keys you also confirm a
handful of OPTIONAL keys (`video_type`, `design_language`, `pacing_intent`, `hook_intent`) — each
PROPOSED from evidence, never blank-asked, and each genuinely overridable. They never gate
(they never appear in `missing_required_keys`); their value is that they pre-decide what would
otherwise surface as a revision at PREVIEW.

## Read sites
| step | source | fields |
|---|---|---|
| inherited style | `vob_read_state_summary { project_id: <derived_from> }` | `intent.answers` (verbatim stored answers) |
| 1 | INSPECT context already in conversation | digest hook candidates, clean-cut stats, pools |
| structure beat | summary `inspect.classification.{file_roles[],content_tagged_count,on_screen_text_count}`; `Read` pools for per-segment tags | per-file role map (`{file_index, role: primary_aroll\|broll\|narration\|mixed, summary}`); `content_tags`/`on_screen_text`/`b_roll_role`/`camera_movement`/`setting` live in `aroll_pool`/`broll_index` (P3) |
| audio beat | summary `inspect.audio` (+ `transcript_aligned`) | per-file `{layout, lufs_integrated, balance, dead_channel, out_of_phase, gain_to_target_db, clip_risk}`, doc-level `{target_lufs, any_clip_risk, any_quiet, clean_audio_source_index}`; `audio_analysis_path`/`segments_path` for the deep read |
| look beat | summary `video_type.design_default` + `Read` `references/brief-design.md` | the format's design baseline + tone→design table (to propose `design_language`) |
| 4A | `Read` of `transcript_summary_path` / `transcript_paragraphs_path` | paragraph list |
| 6–7 | latest `vob_record_intent_answer` result | `missing_required_keys` |

**Inherited style (when `--like` was used).** If the summary shows `style.derived_from`, that
prior project is your strongest signal for the *stylistic* keys. Before proposing, call
`mcp__vob__vob_read_state_summary { project_id: <derived_from> }` — the summary carries the source
project's full `intent.answers` verbatim — and `Read` its brief at
`~/video-vob-sessions/<derived_from>/brief.md`. Pre-record `tone`, `target_platform`,
`target_duration`, `music_vo`, and — when this source's audio makes them applicable
(`audio_treatment` only when audio is present; `captions_style` only when `audio_treatment` is
`keep_audio` or `transcribe_captions`) — `audio_treatment` and `captions_style`, carried from the
source. Also propose `design_language` from the source brief's **Design language** section
verbatim (its whole point is to reuse the LOOK) — present it as the proposal in the look beat
below. Do NOT inherit `key_moments` or `hook_intent`: those are specific to THIS footage — derive
them fresh. If the source's `video_type` mismatches what this footage derives to (e.g. the
template was `cinematic`, this derives to `long-form`), say so in the video-type beat and let the
user pick. Tell the user what you carried over and that it's all overridable. If the source
project has been deleted (the read fails), say the styled-after project is no longer available and
fall back to inferring from this source — the lineage stays stamped in `state.style` regardless.

## The flow

1. **Propose.** From the rough idea (if any) + the classification + transcript + your visual
   read, draft a proposed value for each required key AND each optional key you can ground. The
   invocation idea is the strongest signal — if the user already stated platform/duration/tone/key
   moments/look there, pre-record those directly and don't re-ask. Use `digest_path`'s
   `hook_candidates` and clean-cut stats as proposal evidence. `target_platform` and exact
   `target_duration` are usually genuine unknowns unless the user already said.

2. **Pre-record the confident ones** with `mcp__vob__vob_record_intent_answer { project_id, key,
   value }` and tell the user what you inferred so they can correct it ("I'm assuming
   voiceover-driven, ~45s, energetic — say the word if any of that's wrong").

3. **Ask only the gaps, batched into a few beats** (below). Record each answer as it comes back.
   Do NOT march through keys one at a time, and do NOT turn the optional keys into a long
   questionnaire — fold each into its beat as a PROPOSE-and-confirm one-liner the user can wave
   through.

## The beats (group the conversation; don't interrogate)

Keep INTENT to a few grouped messages. Each beat PROPOSES from evidence and asks the user to
confirm or override — only genuine unknowns (platform, exact duration) are open asks.

- **Beat 0 — Inherited style** (only with `--like`): tell the user what carried over (above).
- **Beat 1 — Format & platform**: `target_platform`, `target_duration`, and the `video_type`
  one-liner. (Render dims/fps/quality are a silent default — surface them once at the PLAN gate,
  never ask here.)
- **Beat 2 — Story & moments**: `tone`, `key_moments`, the `hook_intent` / `pacing_intent` /
  `broll_intent` one-liners, the multi-file role-map confirmation (from `file_roles[]`), and —
  when long-form/tutorial/podcast — the chapter-count confirm folded into the video-type line.
- **Beat 3 — Look & captions**: the `design_language` proposal (confirm or override) and, when
  applicable, `captions_style`.
- **Beat 4 — Audio**: `music_vo` and, when applicable, `audio_treatment`.

Per-key guidance (for the gaps you ask, or to sanity-check a proposal):

1. **`target_platform`** — "What platform is this for? (tiktok, reels, shorts, youtube, square,
   landscape, or something else)"
   *Record the user's words verbatim; the server canonicalizes to one of
   `tiktok|reels|shorts|youtube|landscape|square|vertical` and attaches the platform profile (dimensions,
   fps, safe bands, duration ideals). An unrecognized platform stays raw and defaults to the
   vertical profile — no error, just tell the user what was assumed.*

2. **`target_duration`** — "How long should the final cut be? (e.g. 15s, 30s, 60s, 3m)"
   *Any duration string; the server parses it to seconds. If the parsed seconds sit outside the
   platform profile's `ideal_duration_s`/`max_duration_s` (in the summary), say so in one line
   ("90 min is well beyond a TikTok") rather than letting it surface at PLAN.*

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
   For a visual/silent source, PROPOSE moments from INSPECT's P3 visual tags rather than asking
   blind: when `content_tagged_count > 0`, `Read` `aroll_pool`/`broll_index` and surface the
   strongest tagged shots ("I see a drone establishing shot at 0:42 and the handheld reveal at
   1:10 — must-haves?"). Then: "Any other specific moments that MUST be in the final cut?
   Timestamps or descriptions are both fine." *Free text; descriptions are OK.*

5. **`music_vo`** — "Music, voiceover, both, or neither?"
   *Normalize to one of those four words when possible; otherwise record what the user said.*

### The video-type beat (optional, skippable — v3)

After platform + duration are recorded, read the summary's `video_type` block (`canonical` +
`source`). When `source` is `"derived"`, PROPOSE it as one folded line in your batch — never a
standalone interrogation: "I'll treat this as **long-form** (chaptered lint, auto-segmented
render) based on youtube + 12 min — say 'cinematic', 'tutorial', 'podcast', or 'social short'
to steer differently." For long-form/tutorial/podcast, fold a chapter-count confirm into the same
line ("…roughly 3–4 chapters from the natural breaks, or tell me a count"). React:
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

### The look beat — `design_language` (optional; PROPOSE the concrete row)

The look is the single most-revised thing at PREVIEW, and today it is derived from `tone` alone
only AFTER PLAN. Pull it forward. Seed the proposal from the format's design baseline — the
summary's `video_type.design_default` (`{typography, palette, caption_style, motion, grade}`,
the preset's resolved look) — then refine it with the tone→design row: `Read`
`references/brief-design.md`, match the row to the user's `tone`, and PROPOSE the **concrete**
resolved values — not "I'll pick a look":

> "For an energetic short I'll go **Anton** headline / **Inter 900** captions, white-on-footage
> with a **#FF3B30** accent, bold-pop ALL-CAPS caption chunks, fast-snap motion. Good, or change
> any of it?"

- `--like` set → propose the SOURCE brief's Design language section instead of the table row.
- Name only kit families (the table + the wider kit list in `brief-design.md`); for a
  bilingual/CJK look name the matching Noto SC/JP face explicitly.
- Record the agreed look (table row, with the user's edits) as one compact line:
  `vob_record_intent_answer { key: "design_language", value: "headline Anton; captions Inter 900;
  bg #000 / text #FFF / accent #FF3B30; bold-pop ALL-CAPS captions ~64px centered ~78%;
  fast-snap motion" }`. Free-text — keep it concrete enough that PLAN can transcribe it into the
  brief's Design language section verbatim and the composer can implement it without re-deriving.
- OPTIONAL — if the user waves it off, skip the key; PLAN falls back to the tone table as before.
- The hard constraints (platform safe bands, the 56px caption floor) still win over any look —
  PLAN/QC enforce them; note the adjustment if the user's pick collides.

### The story beats — `hook_intent`, `pacing_intent`, `broll_intent` + the role map

- **File-roles confirmation (P3, multi-file).** When the summary's
  `inspect.classification.file_role_count > 1`, INSPECT mapped each file to a role
  (`primary_aroll`/`broll`/`narration`/`mixed`, each with a `summary`). Confirm the map as a
  one-liner so the whole edit is grounded: "I read file 0 as your main talking-head, files 1–2 as
  b-roll cutaways, file 3 as a voiceover bed — right?" This isn't a recorded key; it just feeds the
  storyboarder spawn (`file_roles`) and catches a mis-tagged file before PLAN. Single-file → skip.
- **`hook_intent`** — INSPECT ranked `hook_candidates[]`; with P3 you can describe each candidate
  by what's ON SCREEN, not just the line. Show the top 2–3 with timestamps and (when tagged)
  their `content_tags`/`on_screen_text` — "I'd open on the drone reveal at 0:42 (text on screen:
  'DAY ONE'); alternates: the cold-open at 0:03, the result at 1:10. Open on that, or another?"
  Record the user's choice (a line/visual + timestamp, or their description) as `hook_intent`.
  Skip the ask only if the rough idea already named an opening (record that). No `hook_candidates`
  → skip; the storyboarder picks from the spine.
- **`pacing_intent`** — `tone` is not pacing (a cinematic brief on shorts may still want snappy
  cuts). Fold one line: "pacing — **fast** cuts, **medium**, or **slow/long holds**? (I'd default
  to <fast for social-short / slow for cinematic> from the format)." Record `fast`/`medium`/`slow`
  (plus any "tighter on the back half"-style note) as `pacing_intent`. If the user doesn't care,
  skip — the storyboarder derives from tone + preset as before.
- **`broll_intent`** — how much to cut away from the A-roll spine. Today the storyboarder decides
  cutaway density and gap-vs-weak-match silently; with P3 you can PROPOSE a realistic appetite from
  what INSPECT actually found. Read `inspect.classification` (`broll_count`, `file_roles[]`) — and,
  for specifics, the `broll_index` pool's `b_roll_role`/`content_tags` — then fold one line: "you
  have ~N b-roll clips (2 establishing, 3 detail) — want **minimal** cutaways (stay on the
  speaker), **illustrative** (cut away when it illustrates a point), or **dynamic** (cover most
  beats)? Or A-roll only?" Record `minimal`/`illustrative`/`dynamic`/`A-roll only` (plus any note)
  as `broll_intent`. When `broll_count` is 0, say there's no usable b-roll and either skip or
  capture "A-roll only". Also surface any `on_screen_text` the footage already burns in, so the
  look/captions beat avoids overlay collisions ("file 1 already has on-screen captions — I'll keep
  overlays off that region").

*(INSPECT richness is fully live — consume all three pillars now: **P1 karaoke alignment**
(`inspect.transcript_aligned`) → the captions step offers word-synced timing (key #7); **P2 audio
analysis** (`inspect.audio`) → the audio beat pre-flags dead-channel/quiet/phase/normalization as
confirmations (key #6); **P3 rich visual tags** (`inspect.classification.file_roles[]` +
`content_tags`/`on_screen_text`/`b_roll_role` in the pools) → the structure beats ground
`hook_intent`, `key_moments`, and `broll_intent` proposals and the multi-file role-map confirm.
Every consumption is guarded: a degraded INSPECT (no whisperx → `transcript_aligned:false`;
`VOB_DISABLE_AUDIO_ANALYSIS` → `audio:null`; no P3 tags → 0 counts) falls back to the
tone/preset/digest proposals.)*

### Content-conditional follow-ups

Inspect `missing_required_keys` from the latest `vob_record_intent_answer` result — do not
re-read state for this. The server derives conditional keys from inspect findings and reports
them as missing when applicable:

6. **`audio_treatment`** — only when audio is present. **First, pre-flag what INSPECT's audio
   analysis (P2, live) already found** — read the summary's `inspect.audio` block and surface any
   defect as a CONFIRMATION, not an open question, before asking the treatment. Guard: `audio`
   may be `null` (a host with `VOB_DISABLE_AUDIO_ANALYSIS=1`) — then skip straight to the question;
   treat any missing sub-field as absent. Per `inspect.audio.files[]`:
   - `dead_channel` → "file N has a dead channel (one side silent — a lav on one input); I'll use
     the live channel."
   - `out_of_phase` → "file N's stereo is out of phase (mono-collapse cancellation risk); I'll
     fix it."
   - a non-trivial `gain_to_target_db` / doc-level `any_quiet` → "file N sits at <lufs_integrated>
     LUFS — I'll normalize ~<gain_to_target_db>dB toward <target_lufs> LUFS" (add "and limit the
     true-peak" when `clip_risk`/`any_clip_risk`).
   - multi-file: name `clean_audio_source_index` as the proposed spine/voice track ("file N reads
     as the clean voice track").
   These ride into the audio beat as one-liners the user waves through; the captures still land at
   COMPOSE/PACKAGE (INSPECT only *advises*). Then ask the treatment, phrased by speech:
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
   Invite the specifics the composer would otherwise guess: "How should captions look? Font,
   size, case, and chunk length all welcome — e.g. 'Inter 900, ~64px, ALL-CAPS, 3-word punchy
   chunks, lower third'. Or just a vibe and I'll match it to the look." — free-form string. If
   you already proposed `design_language`, you can say "captions follow the look unless you want
   something different" and only record `captions_style` when the user diverges.
   **Caption timing (P1, live).** Branch on the summary's `inspect.transcript_aligned` (missing →
   treat as false): when `true`, the transcript is karaoke-grade — OFFER word-synced captions
   ("the transcript is frame-accurately aligned, so I can do per-word highlight/pop captions —
   want that, or plain chunk captions?") and fold the choice into the recorded `captions_style`
   (e.g. "…, word-synced highlight"). When `false`, note the limit once ("caption timing will be
   approximate — `pip install whisperx` for frame-accurate per-word timing") and offer chunk
   captions only; either way captions still render.

After all applicable keys are recorded, call `mcp__vob__vob_transition_phase { project_id,
to_phase: "PLAN" }`. If the gate blocks with `intent_answers_missing`, the blocker's
`missing_keys` tells you exactly which to re-ask — re-ask only those, record, retry. The set
already accounts for the conditional rules above (and never includes the optional keys).
