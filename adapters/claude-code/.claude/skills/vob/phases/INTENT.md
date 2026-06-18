# INTENT — propose from the source, confirm the gaps
Spine rules 3, 4, 11, 12 apply.

Intent is **infer-then-confirm**, not an interrogation. You have the INSPECT classification
(A-roll/B-roll/review pools, take groups, transcript, your visual notes) and possibly the **rough
idea from invocation**. Use all of it to PROPOSE the answers, pre-record the confident ones, and
ask only what you genuinely can't infer — batched.

**This is the ONE human-input round.** Everything a later phase would otherwise ask the human
(the look, the pacing, the opening) or silently guess, you capture or PROPOSE here so PLAN /
COMPOSE / RENDER never have to bounce back. INTENT is driven by a **fixed, mode-aware
clarifying-question catalog** — `references/clarifying-questions.md`. Read it once at entry: it
lists every question, the per-mode default, the triage tier, the intent key it maps to, and how to
auto-resolve it from the prompt. Beyond the five required keys you also confirm a set of OPTIONAL
keys — `video_type`, `design_language`, `pacing_intent`, `hook_intent`, `broll_intent`, and the
v3.7 creative knobs `caption_animation_intent`, `editorial_intent`, `speed_intent`,
`transition_intent`, `layout_intent` — each PROPOSED from evidence, never blank-asked, and each
genuinely overridable. They never gate (they never appear in `missing_required_keys`); their value
is that they pre-decide what would otherwise surface as a revision at PREVIEW.

**The framework in one breath:** resolve every catalog question FIRST from the prompt + INSPECT
signal; for the genuine gaps, ASK with **selectable suggestions** (a `AskUserQuestion` card per
beat, the mode's default placed first and tagged "(recommended)", so the user just taps); silently
default anything safely preset-derivable and **recap it at the PLAN sign-off**. A rich rough idea →
one or two confirm cards; an empty prompt → ~4–5 grouped cards. Never march one question at a time,
and never ask about something the engine can't honor (every row maps to a real knob).

## Read sites
| step | source | fields |
|---|---|---|
| catalog | once at entry: `Read` `references/clarifying-questions.md` | the question rows, per-mode default matrix, triage tiers, `maps_to` keys, auto-heuristics |
| mode | summary `video_type.{canonical, source}` | the active preset — supplies every per-mode default; resolve BEFORE defaulting anything |
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

## The flow — resolve from the prompt, else ask (5 passes)

Work the catalog in five passes. The goal is to ASK as little as possible: every question is first
resolved from evidence, and only genuine gaps surface — as grouped `AskUserQuestion` cards with the
mode's default pre-selected.

**Pass 0 — Resolve the mode FIRST.** Read the summary's `video_type.{canonical, source}`. It
parameterizes every per-mode default in the catalog, so settle it before defaulting anything else.
When `source` is `"derived"`, propose it (see the video-type beat) but DON'T record a plain "keep" —
the derivation stays live and reactive. Record `video_type` only on an explicit re-route, and
ALWAYS pin **podcast** (it never derives — a youtube + long source silently derives long-form).

**Pass 1 — Pre-fill from evidence.** From the rough idea + the classification + transcript + your
visual read (+ the `--like` source's `intent.answers`), draft a value for every catalog row you can
ground. The invocation idea is the strongest signal. Use `digest_path`'s `hook_candidates` and
clean-cut stats as evidence. **Silently RECORD only OPTIONAL keys** (`design_language`,
`pacing_intent`, the creative knobs, …) — they never gate, so a confident inference is safe to
commit and tell the user ("I'm assuming voiceover-driven, energetic, light speed-up — say the word
if any of that's wrong"). For REQUIRED/CONDITIONAL keys, pre-*select* the inferred value as the card
default but DON'T record it yet (a mis-parse of "not for tiktok" must never commit `tiktok` to a
required key — the engine stays the authority on required via `missing_required_keys`).

**Pass 2 — Default the rest.** For each still-unknown row, take the per-mode default from the
catalog matrix as the recommended option (not yet recorded).

**Pass 3 — Triage ASK vs SILENT.** Per each row's `triage` tier: SILENT rows (render fps,
segmentation, loudness-on, video_type for derivable modes) are never asked — they ride the preset
and you recap them at the PLAN gate. CONDITIONAL rows fire only when their `when` gate holds
(`audio_treatment` only if audio present; caption animation only when captions are in play and
word-level only when `transcript_aligned`; layout only with ≥2 angles; snapping only when INSPECT
removed clean-spans; etc.). ASK rows always surface.

**Pass 4 — Ask, record, override.** Group the surviving ASK / fired-CONDITIONAL rows into the beats
below and surface them with `AskUserQuestion` — ≤4 questions per card, the recommended option FIRST
and tagged "(recommended)", and a free-text "something else" option on every question EXCEPT
`audio_treatment` (the one closed enum). Record each answer as it returns with
`mcp__vob__vob_record_intent_answer { project_id, key, value }` (record the user's words; the server
canonicalizes only platform/duration/video_type). An override later is just one more record call on
the same key. For a rich prompt that already answered most rows, this collapses to one or two
confirm cards. (`AskUserQuestion` is the preferred surface; for a free-form back-and-forth or under
an adapter without it, the same rows present as conversational PROPOSE-and-confirm one-liners.)

## The beats (the AskUserQuestion grouping)

Group the cards by beat — don't interrogate one key at a time. Each beat PROPOSES from evidence; the
user taps the recommended default or picks an alternate.

- **Beat 0 — Inherited style** (only with `--like`): tell the user what carried over (above).
- **Beat 1 — Format & platform**: `target_platform`, `target_duration`, and the `video_type`
  one-liner. (Render dims/fps/quality are a silent default — recap them once at the PLAN gate.)
  *Multi-short fan-out caveat:* all shorts inherit this ONE project aspect/platform — per-short
  aspects (e.g. one 16:9 master + 9:16 cuts from the same footage) are NOT supported in v3.7; if the
  user asks, say so rather than promising it.
- **Beat 2 — Story & moments**: `tone`, `key_moments`, the `hook_intent` / `pacing_intent` /
  `broll_intent` one-liners, the multi-file role-map confirmation (from `file_roles[]`), and —
  when long-form/tutorial/podcast — the chapter-count confirm folded into the video-type line.
- **Beat 3 — Look & captions**: the `design_language` proposal (confirm or override), the caption
  animation choice when captions are in play (`caption_animation_intent`), and, when applicable,
  `captions_style`.
- **Beat 4 — Audio**: `music_vo` and, when applicable, `audio_treatment` (+ the ducking default
  when music is in the mix).
- **Beat 5 — Creative knobs** (mostly CONDITIONAL — surface only the ones the prompt raises or the
  footage warrants): `editorial_intent` (snap/tighten), `speed_intent`, `transition_intent`,
  `layout_intent`. Most projects accept the preset defaults silently; ask only when a prompt cue or
  an INSPECT fact (≥2 angles, removed clean-spans, an explicit "speed it up") makes it a real
  decision. See the creative-knobs beat below.

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

### The creative-knobs beat — `editorial_intent`, `speed_intent`, `transition_intent`, `layout_intent`

These four are the v3.7 editorial knobs (Beat 5). They are mostly CONDITIONAL: the preset already
carries a sensible default for each (catalog matrix), so SURFACE one only when a prompt cue or an
INSPECT fact makes it a real decision — otherwise let the default ride and recap it at PLAN. Each
records as a free-text OPTIONAL key the storyboarder reads; none gate.

- **`editorial_intent`** — only when INSPECT wrote removed clean-spans
  (`inspect.clean_speech_path` with `removed[]`). "Tighten the speech — drop dead air and the ums
  between kept lines, or keep the natural pauses?" Record `tighten`/`snap` or `keep natural`.
  Default snap on every preset EXCEPT cinematic (preserve). It steers WHERE the storyboarder cuts,
  not the lint — and under a cinematic `clean_cut=false` an explicit "tighten" is surfaced as a gate
  conflict, not a silent snap. (Filler-WORD removal aggressiveness is NOT user-steerable — it runs
  in INSPECT before INTENT.)
- **`speed_intent`** — when the prompt mentions speed/fit ("make it punchy", "speed me up", "fit it
  in 60s") OR the duration math is tight. "Speed up slow / over-long talking to fit? light ~1.25× /
  aggressive / natural / a slo-mo beat." Record their pick. Default light for social-short, "speed
  slow stretches" for tutorial, natural elsewhere. This HARD-materializes (baked clip speed), so a
  feasibility conflict ("1.25× + 60–90s" with only ~50s of clean source) gets caught at PLAN.
- **`transition_intent`** — only when the prompt names a transition feel ("smooth dissolves", "hard
  cuts only", "punchy whip pans"). "What transition feel between shots? punchy (whip/zoom) / gentle
  dissolves / hard cuts / dip at seams." Record their words. Default is the preset's vocabulary
  (punchy for social, gentle dips/focus_pull for cinematic, hard cuts for general). Shaders aren't
  offered.
- **`layout_intent`** — only when INSPECT shows ≥2 usable angles (`file_roles[]` with >1 camera) or
  the prompt mentions split-screen / a 2-up / reaction / PiP. "Want split-screen or PiP moments?
  none / split (2-up) / pip / 2×2 grid." Record their pick. Default none, EXCEPT tutorial→pip (cam
  over screen) and podcast→split (two speakers). A single-angle source can't fill cells — skip
  silently.

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
   **Caption animation (P1, live) — `caption_animation_intent`.** Branch on the summary's
   `inspect.transcript_aligned` (missing → treat as false). When `true`, the transcript is
   karaoke-grade — OFFER word-level captions ("the transcript is frame-accurately aligned, so I can
   highlight each word karaoke-style, pop whole chunks, or keep them static — which?") and record
   the choice as `caption_animation_intent` (`karaoke` / `word-by-word` / `pop` / `static`). When
   `false`, do NOT offer or auto-select word-level (it would highlight the wrong word) — offer
   `pop` (chunk) or `static` only, note the limit once ("caption timing is approximate —
   `pip install whisperx` for frame-accurate per-word timing"), and record `pop`/`static`.
   `static`/`none` means captions with no motion (the storyboarder omits the `animation` field).
   This carries the caption MOTION; `captions_style` carries the look (font/size/case). Either way
   captions still render.

After all applicable keys are recorded, call `mcp__vob__vob_transition_phase { project_id,
to_phase: "PLAN" }`. If the gate blocks with `intent_answers_missing`, the blocker's
`missing_keys` tells you exactly which to re-ask — re-ask only those, record, retry. The set
already accounts for the conditional rules above (and never includes the optional keys).
