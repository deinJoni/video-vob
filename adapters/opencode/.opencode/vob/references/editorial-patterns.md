# Editorial patterns — the "good editor" playbook

This is the craft reference that separates a **good editor from a mediocre one**. The plan-lint engine is a
*floor* (no broken plans); this doc is the *ceiling* (great plans). Two readers use it:

- **Storyboarder** — read this *while planning* (proactively), and again *to fix* any `editorial/*` finding handed
  back as a revision note. Ground every take, cut, and hook in the INSPECT signals named below.
- **Editorial critic** — read this *to score*. Each rubric dimension below is a scoring axis; emit `editorial/*`
  findings against it.

The golden rule: **every editorial decision must point at a signal or a pattern.** "I opened here because it's the
highest-ranked hook candidate and it's a high-energy span" beats "I opened with the first clip." If you deviate from
a signal, say why in the scene `summary`/`notes` — that's the difference between an intentional cut and a lazy one.

---

## 1. The editorial rubric (the scoring spine)

Eight dimensions (Hook · Arc · Cut rhythm · Take · B-roll · Visual variety · Captions · Ending). For each: the
question, what **great** looks like, what **mediocre** looks like, and the signal that grounds it. The critic scores
each `strong | ok | weak`; the storyboarder self-checks each before saving.

### H — Hook (first ~3 seconds, ≤3.5s)
- **Question:** does the opening earn the next 3 seconds?
- **Great:** opens on the single most arresting moment — a ranked hook candidate, a high-energy line, a bold claim,
  an open loop ("the third one cost me $40k"). Visual and audio both land in frame 1.
- **Mediocre:** opens on a greeting, a slow ramp, ambient B-roll, or a low-energy throat-clear. "Hey guys, so today…"
- **Ground in:** `digest.md` § Hook candidates (ranked `{rank, score, start_seconds, end_seconds, signals[], text}`),
  per-segment `energy_rms_db` / `speech_rate_wpm` in the segments file. → lints `PLAN_HOOK_NOT_GROUNDED`,
  `PLAN_OPENING_LOW_ENERGY`, `PLAN_HOOK_TOO_LONG`, `PLAN_HOOK_NO_SPEECH`.

### A — Arc / structure
- **Question:** is there a shape — setup → escalation → payoff — not just a list of clips?
- **Great:** a clear spine. Retention: hook → open loop → escalating beats → payoff that closes the loop. Chaptered:
  signposted sections that build. Every scene has a `purpose` that advances the arc.
- **Mediocre:** flat sequence of equal-weight clips; the strongest moment buried in the middle; no payoff; the ending
  just stops.
- **Ground in:** `key_moments` (must all be covered and well-placed), the brief's promise. → `PLAN_KEY_MOMENT_UNCOVERED`,
  `editorial/no_payoff`, `editorial/buried_lede`.

### C — Cut rhythm & pacing
- **Question:** does the pace breathe and build, or is it monotone?
- **Great:** front-loaded energy (retention), varied shot lengths, a breath after a dense info beat, acceleration into
  the climax. Cuts land on motion or sentence boundaries, not mid-word.
- **Mediocre:** every scene the same length and pace; no rhythm; cuts mid-phrase; dead air left in.
- **Ground in:** per-segment `speech_rate_wpm` & `energy_rms_db` (cut on energy, breathe on density), `clean_speech.json`
  `keep_spans` (snap cuts to boundaries). → `PLAN_PACING_MONOTONE`, `PLAN_RHYTHM_ARC_INVERTED`,
  `PLAN_CLIP_STRADDLES_REMOVED_SPAN`.

### T — Take selection
- **Question:** is this the *best* take of this line/moment?
- **Great:** picks the take with the cleanest delivery, highest energy, eyes-to-camera, no flub — using the
  classification's `best_take` group and the segment energy table. Avoids retakes flagged by clean-cut.
- **Mediocre:** picks the first take, or a low-energy/mumbled one, or one mid-`removed` span.
- **Ground in:** per-segment `strength.{score,tier,flags}` in `segments.json` (the composite take-quality score —
  delivery + visuals, the quantified "is this the best take?"), classification `best_take` / take groups, segment
  `energy_rms_db`, visual tags (`eyes_to_camera`, `action`), `clean_speech.json` `removed[]` (retakes/fillers). →
  `editorial/weak_take`.

### B — B-roll motivation
- **Question:** does every cutaway *earn its place*?
- **Great:** B-roll illustrates the noun being spoken ("the **dashboard**" → the dashboard), covers a jump cut, or
  contrasts. Each hold ≥1.5s. Motivated, not decorative.
- **Mediocre:** random pretty shots unrelated to narration; B-roll that fights the words; sub-second flashes; the same
  clip twice back-to-back.
- **Ground in:** `broll_placements[].narration_span` vs transcript nouns, B-roll index visual tags. →
  `PLAN_BROLL_TOO_SHORT`, `PLAN_BROLL_REPEATED_BACK_TO_BACK`, `PLAN_BROLL_LONGER_THAN_SPAN`,
  `editorial/broll_unmotivated`.

### V — Visual variety (cutaway rhythm)
- **Question:** does something on screen **change** often enough, or does it sit on a static talking head?
- **Distinct from Cut rhythm:** Cut rhythm is *shot-length / pacing* rhythm (how often you cut); Visual variety is
  *on-screen change* (b-roll, punch-ins, text cards, layouts, kinetic captions). A string of plain cuts between two
  same-framing talking-head takes has rhythm but **zero** variety — it's still a static stretch.
- **Great:** no static stretch runs past the per-video-type budget. A talking-head with little/no b-roll still breaks
  every long hold with a **variety beat** — a `scene.motion` punch-in, a design-system text card / lower-third, a
  multi-cell `scene.layout`, a kinetic-caption emphasis, an energetic `transition_in`, or a matted-subject moment.
- **Mediocre:** a 30s+ unbroken locked-off head; "I had no b-roll so I just let it sit"; nothing on screen moves but
  the mouth.
- **Ground in:** the realized (speed/layout-baked) master timeline modeled as covered-vs-uncovered intervals; the
  per-video-type `variety_budget.max_static_stretch_seconds`; `scene.motion`, beat-class overlays, `scene.layout`,
  `caption_segments[].animation`. → `PLAN_STATIC_STRETCH`, `PLAN_MOTION_INVALID`, `editorial/static_stretch`,
  `editorial/no_visual_variety`.

### L — Captions / legibility
- **Question:** are captions readable, well-timed, and faithful to what's said?
- **Great:** ≤7-word chunks, emphasis on the load-bearing word, word-level animation **only** on an aligned transcript,
  positioned out of the safe band, faithful to the spoken words.
- **Mediocre:** paragraph-long captions, karaoke on an unaligned transcript (drifts), captions for the wrong sentence,
  text under the UI chrome.
- **Ground in:** `transcript_aligned`, per-clip transcript, platform safe band. → `PLAN_CAPTION_*` family.

### E — Ending
- **Question:** does it land, or does it dribble out?
- **Great:** delivers the payoff, then a deliberate button — a CTA, a loop-back to the hook, or a clean visual stop.
- **Mediocre:** trails off, ends mid-thought, or tacks on a limp "so yeah, thanks for watching" on low energy.
- **Ground in:** the hook's open loop (close it), `key_moments` (the promised payoff). → `editorial/limp_ending`.

---

## 2. Grounding cheat-sheet — signal → where → how to use

**You are handed these in the spawn. Open them. Decisions that ignore them are how mediocre editors pass the lints.**

| Signal | Where (spawn handle / file) | How a good editor uses it |
|---|---|---|
| **Ranked hook candidates** | `digest_path` → `digest.md` § Hook candidates (≤5, `{rank,score,start_seconds,end_seconds,signals[],text}`, on the **winner transcribed file**) | Open scene 1 on the **rank-1 candidate's window** unless you have a better reason. Each candidate's `signals[]` (question/number/claim/energy_high…) tells you *why* it hooks — lead with that energy. |
| **Per-segment energy** `energy_rms_db` | `segments_path` → `segments.json` | Open on a high-energy segment. Cut *to* energy peaks. A hook drawn from a below-median-energy segment reads flat (`PLAN_OPENING_LOW_ENERGY`). |
| **Speech rate** `speech_rate_wpm` | `segments.json` | Fast delivery = high arousal → good for hooks & climaxes. A long slow segment = candidate for trimming or B-roll cover. Match scene `pacing` to the actual rate. |
| **Take strength** `strength.{score,tier,flags}` | `segments.json` (per segment) + the digest § Strongest takes | The composite take-quality read (0–1) over **delivery** (energy + pace + filler-freedom) AND **visuals** (`sharpness` focus + `luma_mean` exposure + optional `face`). **Prefer `tier:"strong"` segments for the hook and key beats; avoid `tier:"weak"`.** The `flags[]` say WHY a take is weak — `low_energy`, `halting`, `rushed`, `filler_heavy`, `soft_focus`, `underexposed`, `overexposed`, `no_face` — so pick a sibling take without that flaw. Energy & sharpness are scored *relative to the same file*, so "strong" = the best of THIS shoot. → backs `editorial/weak_take`, `PLAN_OPENING_LOW_ENERGY`. |
| **Clean-speech keep-spans** | `clean_speech_path` → `clean_speech.json` `keep_spans[{start,end,text}]` / `removed[]` | **Snap every a_roll `in/out` to keep-span boundaries.** Never let a clip straddle a `removed` span (dead air/filler/retake) — `PLAN_CLIP_STRADDLES_REMOVED_SPAN`. The `removed[]` reasons (`filler_word`/`retake`/`gap`) tell you what to skip. |
| **Transcript alignment** `transcript_aligned` | spawn flag | `true` → word-level caption animation (karaoke/word-by-word) is safe. `false` → chunk-level `pop` only; word timing drifts (`PLAN_CAPTION_KARAOKE_UNALIGNED`). |
| **Audio summary** | `audio_summary` (`clean_audio_source_index`, LUFS, balance, dead_channel, clip_risk) | Build the spine from the cleanest voice track. Flag clip-risk / dead-channel files away from the A-roll spine. |
| **Visual tags** | `aroll_pool` / `broll_index` per-segment (`eyes_to_camera`, `camera_movement`, `setting`, `content_tags[]`, `on_screen_text`, `action`) | Pick eyes-to-camera takes for direct address; match B-roll `content_tags` to the spoken noun; avoid duplicate `setting` back-to-back. |
| **Key moments** | `key_moments` intent | Every one must be covered by a clip window and placed at an arc-appropriate beat (payoffs late, not buried). |

---

## 3. Cold-open / hook recipes

Pick the structure that fits the material — don't default to "first clip." Hook scene `purpose:"hook"`, **≤3.5s**,
must contain spoken words (unless it's a deliberate visual cold-open with an overlay).

Each ranked candidate carries a `hook_type` (the digest names it) — let it pick the structure:

- **In-medias-res** — drop into the most intense moment, *then* context. Use when a candidate has `signals:["energy_high"]`
  / `strong_take` or a mid-story climax exists. ✓ open on the payoff-action, cut back to setup.
- **Question hook** (`hook_type:"question"`) — poses the loop the video answers. ✓ "Why does X…?"
- **Bold claim / number** (`hook_type:"bold_claim"` / `"number_stat"`) — a stat or absolute. ✓ "90% of people get this wrong."
- **Curiosity gap / contrarian** (`hook_type:"curiosity_gap"` / `"contrarian"`) — withhold the payoff or invert the
  assumption. ✓ "Here's what nobody tells you…" / "Everyone does this — and it's wrong."
- **Negative / stakes** (`hook_type:"stakes"`) — lead with the mistake/pain ("Don't do this"). High retention for how-to.
- **Pattern interrupt** — an unexpected visual/audio jolt in frame 1 (motion, hard sound, on-screen text). Use when no
  strong spoken hook exists; pair with a kinetic caption overlay.
- **Payoff tease** — flash the end result for <1s, then "here's how." Use for transformation/tutorial content.

**Realize the cold-open with a PUNCH — it is NOT a beat.** Whatever the archetype, plan scene 0 so the composer can
treat it as first-class: (1) the hook LINE goes in `caption_segments` with `emphasis_words` (the load-bearing word) —
not merely a vague overlay note — so it renders as the **kinetic claim** (design-system `cold_open` slot, emphasis word
in the accent); (2) the composer adds a **punch-in** on the scene video. A flat scene-0 with a generic caption is the
single biggest retention leak.

**Grounding rule:** the hook scene's source window **should overlap a top-ranked hook candidate**. If you open elsewhere,
justify it in the scene `summary` (e.g., "rank-1 candidate is mid-story; using rank-2 question hook for a cold open").
Opening off-candidate with no reason → `PLAN_HOOK_NOT_GROUNDED`; a hook caption with no emphasis word →
`PLAN_HOOK_CAPTION_NO_EMPHASIS`.

---

## 4. Retention beats (keep them watching)

- **The 3-second rule:** the hook must land before second 3. No ramp, no greeting, no logo.
- **Open a loop early, close it late:** plant a question/promise in the hook; pay it off at the end. An un-closed loop or
  a payoff with no setup both read as broken (`editorial/no_payoff`, `editorial/dangling_loop`).
- **Re-hook cadence:** for anything >20s, plant a fresh micro-hook every ~7–15s (a new question, a "but here's the thing",
  a visual change). For long-form, that's per chapter.
- **Escalation:** each beat should raise stakes/specificity, not restate. Order beats by increasing payoff.
- **Front-load energy:** the highest-energy material goes early in retention formats — never make the viewer wait for the
  good part (`PLAN_RHYTHM_ARC_INVERTED` fires when the opening is the slowest and a later scene is faster).
- **No dead air:** every kept span earns its place; trim to `keep_spans`.

---

## 5. Take selection heuristics

When the same line/moment exists in multiple takes (classification take groups / `best_take`):

**Start from the `strength` score.** Each segment in `segments.json` carries `strength.{score (0–1), tier, flags[]}` — a
composite over delivery (energy/pace/filler-freedom) and visuals (sharpness/exposure/face). Rank the candidate takes by
`strength.score`, prefer the `strong` tier, and let the `flags[]` tell you what's wrong with the rest (`low_energy`,
`soft_focus`, `filler_heavy`, `underexposed`…). Then refine with the qualitative checks below — a strong-tier take with
eyes-to-camera beats a marginally-higher score looking away. The score is the *starting rank*; your frame read breaks ties.

1. **Cleanest delivery** — not in a `removed[]` retake span; no stumble.
2. **Highest energy** — higher `energy_rms_db`, livelier `speech_rate_wpm` (within reason).
3. **Eyes-to-camera** for direct address (visual tag `eyes_to_camera:true`).
4. **Framing/motion** that matches the beat (a push-in for emphasis, a static for clarity).
5. **Audio quality** — prefer takes from the `clean_audio_source_index` **file** (a project-level "cleanest voice track" pick, not a per-take score); avoid clip-risk / dead-channel sources for the spine.

A weak-take choice when a clearly better take exists → `editorial/weak_take`.

---

## 6. Cut rhythm & pacing arc

- **Vary shot length.** A string of identical-duration scenes is monotone (`PLAN_PACING_MONOTONE` at ≥4 identical paces).
  Alternate `pacing` to create rhythm.
- **Cut on motion or sentence boundaries**, not mid-word. Use `keep_spans` text to find clause ends.
- **Breath after density.** After a fast, info-dense beat, give a slightly longer/quieter beat so it lands.
- **Pace arc by ruleset:**
  - *retention:* front-load; fastest early, build to the payoff. Inverted arc (slow open, fast later) is a defect.
  - *chaptered/long-form:* build to a climax is fine; signpost section changes; don't exhaust early.
  - *montage:* cut to the music's rhythm; variety is the point.
- **Speed ramps:** `clip.speed` (0.25–4.0) is on-rails — use a subtle speed-up to compress a slow span rather than cutting
  it if the content matters; baked into duration math.

---

## 7. B-roll motivation

Every `broll_placement` must answer "why *here*?":
- **Illustrate** — show the noun being spoken (`narration_span` aligns to the word; B-roll `content_tags` match).
- **Cover** — hide a jump cut / breath / removed span on the A-roll.
- **Contrast / emphasize** — a visual that adds meaning, not just decoration.

Rules: hold **≥1.5s** (sub-second flashes read as glitches — `PLAN_BROLL_TOO_SHORT`); don't reuse the same segment
back-to-back (`PLAN_BROLL_REPEATED_BACK_TO_BACK`); don't run B-roll longer than the span it covers
(`PLAN_BROLL_LONGER_THAN_SPAN`). Coverage the footage can't supply → declare a `source:"gap"` placement (a shopping list,
`PLAN_BROLL_GAP_UNFILLED`) rather than forcing an unmotivated cutaway. Decorative, unmotivated B-roll → `editorial/broll_unmotivated`.

---

## 7b. Visual variety / cutaway rhythm

The #1 reason an agent-edited talking head reads flat: long **static stretches** where nothing on screen changes. Fight
them proactively — you do **not** need literal b-roll footage to add visual variety.

- **The static-stretch budget.** Each video-type carries `variety_budget.max_static_stretch_seconds`; `PLAN_STATIC_STRETCH`
  (WARNING, OFF under `montage`) models the realized (speed/layout-baked) master time as covered-vs-uncovered intervals and
  warns per uncovered gap longer than the budget: **social-short 10s · general 14s · long-form 18s · tutorial 22s · podcast
  24s · cinematic 30s** (off under montage — holds are intentional). Knobs: `VOB_VARIETY_BUDGET=off`,
  `VOB_VARIETY_MAX_STATIC_SECONDS=n`.
- **Plain cuts don't count.** A cut between two **same-framing** talking-head takes is *not* variety — only on-screen
  CHANGE breaks a static stretch.
- **The variety-beat toolkit** (any one satisfies the budget): a **B-roll cutaway**; a **`scene.motion`** punch-in /
  ken-burns (string `"punch_in"|"push_in"|"ken_burns"`, or `{type,scale 1.0–2.0,ease?,start_seconds?,end_seconds?}`; a bad
  value → `PLAN_MOTION_INVALID`, never rejects); a **beat-class typed overlay** (`title_card`, `lower_third`, `callout`,
  `data_viz`, `chapter_marker`, `section_title`, `cta`, `end_card`, `kinetic_caption`, `pip` — NOT static
  `caption_block`/`logo_bug`/`progress_bar`); a multi-cell **`scene.layout`**; an animated **`caption_segments[].animation`**;
  a **matted-subject** b-roll moment; or an energetic (non `cut`/`dip`/`fade`) **`transition_in`**.
- **`scene.motion` is the no-b-roll workhorse.** An intra-scene camera move on the A-roll spine adds change without any
  cutaway footage — punch in on the emphasis beat, ken-burns a slow line.
- **No b-roll? Reach for the design system.** Break static stretches with **design-system beats** (title / text-card,
  lower-thirds, backdrops, grades from `compose/design-system/`) + **`scene.motion` punch-ins** + **kinetic-caption
  emphasis**. A talking-head with zero variety devices planned → `editorial/no_visual_variety`.

---

## 8. Endings

- **Deliver the payoff** the hook promised (close the loop).
- **Button it:** a CTA ("follow for part 2"), a loop-back to the opening image (great for short-form replays), or a clean
  visual stop on the key frame.
- **Don't** trail off on low energy, end mid-thought, or append a limp sign-off. A weak final beat → `editorial/limp_ending`.
- For multi-short fan-out: each short needs its own self-contained payoff.

---

## 9. Per-ruleset emphasis

The active `lint_ruleset` (from the video-type preset) shifts what "great" means:

- **retention** (social short-form): hook + open loops + front-loaded energy are everything. Hook lints ON. Inverted arc
  is a defect. Tight, no dead air. **Visual variety matters most here** — break every static stretch (§7b).
- **chaptered** (long-form/tutorial): signposting and section balance matter; building to a climax is correct (inverted-arc
  check OFF). Each chapter re-hooks. Visual variety still applies (longer budget). `PLAN_CHAPTERS_MISSING` /
  `PLAN_SECTION_IMBALANCE` apply.
- **montage** (music-driven): rhythm and variety win; cut to the beat; transition-inconsistency check is OFF.
  `PLAN_STATIC_STRETCH` is **OFF** (the cutting itself is the variety).
- **tutorial:** step clarity, on-screen legibility, "show the result first" tease; don't sacrifice clarity for pace.
  Visual variety applies (generous budget).
- **podcast / general:** speaker focus, minimal gratuitous cutting, clean audio; let moments breathe. Visual variety
  applies — general talking-heads benefit most; podcast gets a generous budget. (`PLAN_STATIC_STRETCH` is gated OFF only
  under `montage`; cinematic carries a long 30s budget so intentional holds rarely trip it.)

---

## 10. Finding codes (what the critic emits / what the storyboarder fixes)

The critic returns `editorial/*` findings (agent-judgment) alongside the mechanical `PLAN_*` plan-lint warnings. When a
finding is handed back as a revision note, apply the fix for exactly that code:

| Code | Meaning | Fix |
|---|---|---|
| `editorial/weak_hook` | Opening doesn't earn the next 3s | Re-open on a top hook candidate / high-energy claim (§3); tighten to ≤3.5s. |
| `editorial/hook_not_grounded` | Hook ignores the ranked candidates | Move the opening window onto the rank-1 candidate, or justify the deviation. |
| `editorial/buried_lede` | Strongest moment is mid-video | Reorder: lead with it (in-medias-res) or tease it in the hook. |
| `editorial/no_payoff` / `editorial/dangling_loop` | Loop opened but never closed (or payoff with no setup) | Add the closing beat; plant the setup in the hook. |
| `editorial/monotone_pacing` | No rhythm | Vary scene lengths / `pacing`; add a breath beat (§6). |
| `editorial/arc_inverted` | Energy back-loaded (retention) | Front-load the high-energy material. |
| `editorial/weak_take` | A better take exists | Swap to the best-take/high-energy/eyes-to-camera take (§5). |
| `editorial/broll_unmotivated` | Decorative cutaway | Tie it to the spoken noun, a cut to cover, or cut it (§7). |
| `editorial/static_stretch` | A stretch over budget with no on-screen change | Add a `scene.motion` punch-in / b-roll cutaway / text card / layout / kinetic emphasis (§7b). |
| `editorial/no_visual_variety` | A whole talking-head with essentially no variety devices planned | Plan design-system beats + punch-ins across the timeline; break every long hold (§7b). |
| `editorial/straddles_dead_air` | Clip includes a removed span | Snap `in/out` to `keep_spans`. |
| `editorial/limp_ending` | Ending dribbles out | Deliver the payoff + a deliberate button (§8). |

Plan-lint grounding codes this doc backs (all WARNINGS, retention-gated): `PLAN_HOOK_NOT_GROUNDED` (opening window
overlaps no top-N hook candidate), `PLAN_OPENING_LOW_ENERGY` (opening segment energy/speech-rate below the file's norm).
Visual-variety codes (WARNINGS, OFF under `montage`): `PLAN_STATIC_STRETCH` (an uncovered realized-time gap longer than
the video-type budget), `PLAN_MOTION_INVALID` (a malformed `scene.motion` — falls back to static, never rejects).

---

## 11. The self-critique loop (storyboarder procedure)

Before your single `vob_save_storyboard` call, run this in your head — **draft → critique → revise → save**:

1. **Draft** the full timeline grounded in the signals (§2).
2. **Self-critique** against the 8-dimension rubric (§1). For each dimension, ask "strong, ok, or weak — and what signal
   backs it?" Be your own harshest critic: would a great editor open here? Is the best take chosen? Does every cutaway earn
   its place? Does any static stretch run past the budget? Does it end on a button?
3. **Revise** every `weak`. Re-open on a better candidate, swap takes, vary pacing, motivate or cut B-roll, break static
   stretches with motion/text-cards, fix the ending.
4. **Save** only the revised plan. Note your key grounding decisions in scene `summary`/`notes` so the critic and the human
   see the *why*.

A storyboard that survives this loop is a good editor's cut, not a mediocre one's first draft.
