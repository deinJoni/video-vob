# v3.7 BRAINSTORM — Mode-Aware Clarifying-Question Framework for PLAN/INTENT

> Status: brainstorm for a direction decision. Precise enough to turn into a PRD, but the forks in §6 are genuine human calls. Questions that require engine work to honor are tagged **[needs engine change]**.

---

## 1. Concept & goal

**v3.7 makes intake a fixed, mode-aware clarifying-question framework** layered onto the existing INTENT phase. The promise, in one breath:

- **Fixed** — a known catalog of questions per video-type mode, so coverage is exhaustive instead of proposal-driven. Nothing creative-but-steerable falls through the cracks.
- **Mode-aware** — the active preset (social-short / long-form / cinematic / tutorial / podcast / general) decides each question's *smart default* and which questions even apply.
- **Resolved from prompt-or-asked** — every question is first auto-answered from the freeform rough idea + INSPECT signal; only genuine gaps are surfaced. A rich prompt → 1–2 confirm cards; an empty prompt → the full grouped beats, each pre-answered.
- **Always selectable** — every asked question ships with options + a pre-selected *(recommended)* default. The user's minimum action is one tap, never typing prose. (A free-text "something else" escape is always present.)
- **Restates intent crisply** — silently-defaulted decisions are recapped at the single PLAN sign-off, so the human sees the full creative spec before the storyboarder commits.

**Why now:** the engine already carries a large, fully-implemented creative knob surface (per-clip speed, caption animation, transitions, split-screen layout, subject compositing, fan-out, chapters) but most of it is **storyboarder-inferred only** — the user has no forward-looking say, and the v3.x lints surface these as *post-hoc warnings at the plan gate*. v3.7 moves the decisions **before** the storyboarder runs, with mode-smart defaults so the user almost never has to think.

**What it is NOT:** a new FSM phase, a new gate, a sixth required key, or an engine-side questionnaire schema. The 5 required keys stay frozen.

**Honest scope note:** a handful of attractive questions are not honorable without engine work — clean-cut filler appetite (runs pre-INTENT, hard-coded), multi-aspect fan-out (no per-short profile field), single-timeline ducking (assembly-path only), and a custom loudness target (on/off only). These are tagged **[needs engine change]** throughout and parked in §6/Slice 4 rather than promised in the MVP.

---

## 2. The framework

### Universal vs mode-specific questions

| Class | Definition | Examples |
|---|---|---|
| **Universal** | Asked (or defaulted) in **every** mode; only the default value shifts per mode | format, length, key moments, captions, caption look, pacing, b-roll appetite, music/VO, loudness |
| **Mode-specific** | Surfaced only in modes where it's a real decision | fan-out (social/podcast), chapters (long-form/tutorial/podcast), grade + letterbox/grain (cinematic), callouts (tutorial), speaker-layout (podcast), hook (retention) |

### The resolve-from-prompt-else-ask loop (runs at INTENT)

0. **PASS 0 — Resolve mode FIRST.** Resolve the active mode from `summary.video_type.{canonical,source}` and the prompt **before any per-mode default is computed**. `video_type` gates which questions apply and supplies every default, so it cannot share a batch with the questions it parameterizes. If the prompt names a type, lock it; if a re-route is plausible (esp. podcast, which `deriveVideoType` can never reach), confirm it alone, then recompute. All later passes are downstream of Pass 0.
1. **PASS 1 — Pre-fill from evidence.** Parse the rough idea + INSPECT signal (`hook_candidates`, clean-cut stats, pools, `inspect.audio`, `transcript_aligned`, P3 visual tags) + the `--like` source's verbatim `intent.answers`. **Silently record only OPTIONAL keys.** Required/conditional keys parsed from the prompt are pre-*selected* as the Pass-2 default and shown for one-tap confirm — never silently recorded (a mis-parse of "not for tiktok" must not commit `tiktok` to a required key).
2. **PASS 2 — Compute per-mode defaults.** For every still-unknown row, look up its `default_per_mode` against the Pass-0 mode — these become the recommended-first option, **not yet recorded**.
3. **PASS 3 — Triage ASK vs SILENT.** Each row carries an explicit `triage_tier` (per mode — see §4). SILENT rows (fps, render segmentation, etc.) are never asked, only recapped at PLAN. CONDITIONAL rows gate on applicability (`audio_treatment` only if `audio_present`; caption animation only if `transcript_aligned`; layout only if ≥2 angles). The engine stays authority on required+conditional via `missing_required_keys`.
4. **PASS 4 — Ask the remainder, record, override.** Surviving ASK-tier unknowns batch into grouped `AskUserQuestion` cards (≤4/call). Each answer records as it returns. Overriding is uniform: one more `vob_record_intent_answer` overwriting the key.

### Relation to the existing intent contract (extends, never duplicates)

| Existing surface | How v3.7 uses it |
|---|---|
| 5 **required** keys (`target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`) | Surfaced as pickers (including a dedicated `key_moments` row — see U16); never silently recorded from freeform. Frozen — not renamed, no 6th added. |
| 2 **conditional** keys (`audio_treatment` enum, `captions_style`) | Surfaced only when INSPECT findings warrant (drive off `missing_required_keys`, not a static list). |
| 5 **optional** keys (`video_type`, `design_language`, `pacing_intent`, `hook_intent`, `broll_intent`) | The **spine** of the catalog — exhaustively surfaced-with-suggestions instead of folded one-liners. |
| **NEW** optional keys (small set) | Only for creative knobs with a real consumer but no existing home (caption animation, speed, transitions, layout). Free-text, never-gating. **[needs engine change]** — each touches `OPTIONAL_INTENT_KEYS` + the `record-intent-answer.js` enum + a consumer. |

Aspect ratio and fps are **never** independent questions — pure consequences of `target_platform` (+ cinematic 24fps), silently defaulted and recapped once at PLAN.

---

## 3. The mode × question matrix (centerpiece)

Cells = the **smart default** for that mode. `—` = not surfaced (silent / N/A). Tiering is in §4; this is the default landscape.

| Question | social-short | long-form | cinematic | tutorial | podcast | general |
|---|---|---|---|---|---|---|
| **Format / platform** | tiktok 9:16 | youtube 16:9 | cinematic 16:9 24fps | youtube 16:9 | youtube 16:9 | landscape 16:9 |
| **Length** | 20–45s range | 8–12 min | ~90s | (ask) | full episode | (ask) |
| **Video type** | keep social-short | keep long-form | keep cinematic | keep tutorial | **pin podcast** (underivable) | keep general |
| **Key moments** | INSPECT segments (ask) | from outline (ask) | hero beats (ask) | steps (ask) | topic beats (ask) | (ask) |
| **Audio treatment** | `transcribe_captions` | `transcribe_captions` | **`keep_ambient`** | `transcribe_captions` | `transcribe_captions` | (ask if audio) |
| **Caption animation** | karaoke **iff aligned**, else pop | pop (chunk) | gentle fade/pop | pop (chunk) | pop (chunk) | pop |
| **Caption look** | bold-pop | clean-pill | minimal lower-third | clean-pill | minimal lower-third | clean-pill |
| **Snap to clean-spans** | yes | yes | **no (preserve)** | yes | yes | (preset) |
| **Speed** | light ~1.25× | natural | natural | speed slow stretches | natural | — |
| **Pacing** | fast | build to climax | slow holds | medium | medium | medium |
| **Transitions** | punchy (whip/zoom) | cuts + dip at chapters | gentle dips/crossfades | cuts + slide/dip | clean cuts + dips | hard cuts |
| **Split-screen / layout** | none | none | single full-frame | **pip (cam over screen)** | **split (2 speakers)** | none |
| **B-roll appetite** | illustrative | illustrative | dynamic | illustrative | illustrative | illustrative |
| **Subject compositing** | off | off | off | off | off | off |
| **Hook / opening** | top hook candidate | cold open + setup | establishing/hero | brief "what you'll learn" | short teaser cold-open | best opening (auto) |
| **Music / VO** | voiceover | VO + ducked bed | music-led | voiceover | both (voices + light bed) | music bed |
| **Loudness** | -14 LUFS on | -14 LUFS on | -14 LUFS on | -14 LUFS on | -14 LUFS on | -14 LUFS on |
| **Fan-out (N shorts)** | one (ask) | one | — | — | one (ask) | — |
| **Chapters / segments** | — | auto 3–5 | continuous | auto-detect | auto (>8 min) | — |
| **Overlays / graphics** | — | chapter cards + lower-thirds | letterbox bars | callouts + section titles | name lower-thirds | none |
| **Grade / film-feel** | (preset) | none | **desaturated + letterbox** | none | none | none |
| **Design / look** | bold-pop preset | clean editorial | desaturated filmic | clean-pill green | calm purple | neutral |

Reading notes:
- "Captions" is expressed via the **`audio_treatment` enum**, not a boolean toggle — the matrix names the token. Cinematic = `keep_ambient` (preserve room tone, no burn-in), the most cinematic of the no-caption options; it is a real, made choice, not "OFF."
- Cinematic flips the most defaults (`keep_ambient`, snap-to-clean-spans OFF, music-led, 24fps, slow holds).
- Podcast is the one mode that **must explicitly pin** `video_type`: `deriveVideoType` can never reach `podcast` (a youtube+long source silently derives long-form, losing `scene_detect=false`).

---

## 4. Full question catalog

Notation: **Q** text · options (★ = a representative per-mode default) · **→ knob** · **auto** heuristic · **triage** (ASK / CONDITIONAL / SILENT, per the dominant case; per-mode shifts noted). Universal questions defined once; per-mode default overrides in the matrix.

### Universal questions

**U1 · Format / platform** — *"Which platform / aspect is this for?"* · **triage: CONDITIONAL** (ASK only if no platform token in prompt)
- Options: TikTok 9:16 / Reels 9:16 / Shorts 9:16 / YouTube 16:9 / Square 1:1 / Vertical fallback / Cinematic 16:9 24fps
- **→** `target_platform` (required; server canonicalizes `{raw,canonical,profile}`; co-derives video_type, fps, safe bands, caption sizing)
- **auto:** platform token (`tiktok`/`reels`/`shorts`/`youtube`/`9:16`/`16:9`) → pre-select for confirm (not silent-record). Ask only if none named.

**U2 · Length** — *"How long should the final cut be?"* · **triage: CONDITIONAL** (ASK if no duration phrase)
- Options: single (`15s`/`30s`/`60s`) · range (`20–45s`) · minutes-scale (`8–12 min`) · per-deliverable (`45s per short`)
- **→** `target_duration` (required; `parseDurationSpec` → seconds/range/per_deliverable)
- **auto:** duration phrase / range / `per short`/`each` → per_deliverable (fan-out signal); pre-select for confirm.

**U3 · Video type** — *"This looks like a `<mode>` — keep that, or route it differently?"* · **triage: SILENT for all derivable modes (recap at PLAN); ASK only podcast** (and only when platform+duration would mis-derive)
- Options: keep `<mode>` ★ / route to another type
- **→** `video_type` (optional). **Confirm-without-routing does NOT record** — recording is pinning under the precedence chain (`env > recorded > derivation > default`). To stay reactive to a later platform/duration change, simply don't call `vob_record_intent_answer` on a plain keep; record only on an explicit re-route (or the podcast pin).
- **auto:** explicit type word → record (pins). Vertical+short already derives social-short → don't ask. **Podcast is the lone always-record case** (underivable).

**U4 · Audio treatment / captions** — *"Burn in subtitles, or how do we treat the source audio?"* (CONDITIONAL: only if `audio_present`) · **triage: ASK (when audio present)**
- Options: burn captions (`transcribe_captions`) ★ / keep audio no captions (`keep_audio`) / drop source audio (`discard_audio`) / keep ambient only (`keep_ambient`)
- **→** `audio_treatment` (the ONE server enum — the single legitimately-closed question). There is **no boolean caption knob**; "captions off" = `keep_audio`/`keep_ambient`/`discard_audio`, a real choice.
- **auto:** `captions`/`subs`→transcribe; `no captions`→keep_audio; `music only`/`mute`→discard; ambient b-roll→keep_ambient. Skip on silent source.

**U5 · Caption animation** — *"How should captions animate?"* (only if `audio_treatment=transcribe_captions`) · **triage: CONDITIONAL** (the word-level options appear ONLY when `transcript_aligned===true`)
- Options: pop (chunk) ★ / **word-by-word, karaoke — shown only when aligned** / static
- **→** `caption_animation_intent` **[needs engine change]** (NEW optional) → `caption_segments[].animation`; word-level downgrades to pop on `transcript_aligned!==true` (`PLAN_CAPTION_KARAOKE_UNALIGNED`)
- **auto:** `karaoke`/`word highlight` → karaoke **only if aligned**; else pop. **The catalog row hard-gates word-level on `transcript_aligned===true` — never offer or auto-select it otherwise** (the load-bearing guard; do not implement the matrix cell "karaoke if aligned" as plain "default karaoke").

**U6 · Look (caption + grade + film-feel)** — *"What's the overall look — caption style, and (cinematic) grade / letterbox?"* (ONE look beat; sub-options expand by mode) · **triage: CONDITIONAL** (ASK if prompt mentions a look/brand; else SILENT to preset `design_default`)
- Options: follow preset ★ / bold-pop / clean-pill / minimal lower-third / `--like` a project · **cinematic sub-options:** grade (desaturated ★ / teal-orange / warm / natural) + film-feel (letterbox ★ / + grain / neither)
- **→** `captions_style` (conditional) + `design_language` (optional) → `target.design{caption_style,grade,palette,typography,motion}`; composer realizes captions from `mcp/assets/captions`; `--like` copies verbatim
- **auto:** explicit font/case/color/`brand` → verbatim; `teal & orange`→teal-orange, `golden hour`→warm; vibe → map to kit look; else preset default.
- *Collapses the former U6+M8+M9+M11 — one look question per mode, never three.*

**U7 · Pacing / energy** — *"How fast and energetic should it feel?"* (the spine for energy; speed + transitions derive from it) · **triage: ASK**
- Options: fast / medium / slow holds (defaults per mode)
- **→** `pacing_intent` (optional); drives scene-duration target + `PLAN_PACING_MONOTONE` (universal) / `PLAN_RHYTHM_ARC_INVERTED` (retention only). tone ≠ pacing.
- **auto:** `fast`/`punchy`→fast; `let it breathe`→slow; else medium.
- *U8 (speed) and U9 (transitions) defaults are derived from this answer per preset and only surfaced if the prompt explicitly raises them.*

**U8 · Speed** — *"Speed up slow / over-long talking to fit?"* · **triage: CONDITIONAL** (ASK only if prompt mentions speed/fit; else default from U7 + preset)
- Options: light ~1.1–1.25× ★ / aggressive (whatever fits) / natural only / slow-mo a beat
- **→** `speed_intent` **[needs engine change]** (NEW optional; or prose in `pacing_intent`) → `source_clips[].speed` (baked at materialize; `PLAN_DURATION_INFEASIBLE` validates)
- **auto:** `1.25x`/`speed up`/`make it fit`→speed; `slo-mo`→slow; `natural`→none.

**U9 · Transitions** — *"What transition feel between shots?"* (multi-select) · **triage: CONDITIONAL** (ASK only if prompt mentions a transition; else default from U7 + preset)
- Options: punchy (whip/zoom) / gentle dissolves / hard cuts / dip-to-black at seams
- **→** `transition_intent` **[needs engine change]** (NEW optional; or prose in `design_language`) → `scene.transition_in` from preset `transition_vocabulary`; LOOSE/fail-safe; unknown→cut + `PLAN_TRANSITION_UNKNOWN_TYPE`. Shaders not offered (gated off).
- **auto:** `whip pan`/`zoom`→kinetic; `hard cuts only`→cut; `dissolve`/`smooth`→crossfade.

**U10 · Snap to clean-spans** — *"Tighten the speech — drop dead air and ums between kept lines?"* · **triage: CONDITIONAL** (ASK only if INSPECT wrote `clean_speech.json` with removed spans)
- Options: yes, snap cuts to clean-spans ★ / keep natural pauses
- **→** `editorial_intent` **[needs engine change]** (NEW optional) → storyboarder snaps `a_roll` cuts to `clean_speech` keep-spans or not. **This is the only intent-steerable half of clean-cut.** Filler-word removal (`removeDiscourseFillers`) is computed in INSPECT *before* INTENT and is hard-`false` with no options thread — see §6.1; do **not** advertise filler-aggressiveness control here.
- **auto:** `tighten`/`cut the ums`→snap; `keep it raw`/`natural`→preserve.
- Per-mode default: snap everywhere EXCEPT cinematic = preserve.

**U11 · Split-screen / layout** — *"Split-screen, multi-cam, or PiP moments?"* (CONDITIONAL: requires INSPECT ≥2 angles) · **triage: CONDITIONAL**
- Options: none ★ / split (2-up before-after) / pip (reaction) / 2×2 grid
- **→** `layout_intent` **[needs engine change]** (NEW optional) → `scene.layout` (pre-composited to ONE clip at COMPOSE, v3.4); advisory at QC; degrades to CSS cells.
- **auto:** `side by side`/`before-after`→split; `pip`/`reaction`→pip; `grid`/`four up`→grid_2x2. Default none for single-source.
- Per-mode default: none EXCEPT tutorial→pip · podcast→split if ≥2 angles.

**U12 · B-roll appetite** — *"How much should we cut away to b-roll?"* (CONDITIONAL: skip if `broll_count==0`) · **triage: CONDITIONAL**
- Options: illustrative ★ / dynamic / minimal / A-roll only
- **→** `broll_intent` (optional). Grounded in INSPECT `broll_count`/`file_roles`. Steers appetite, NOT render mode (storyboarder owns render mode).
- **auto:** `lots of b-roll`→dynamic; `stay on me`→minimal; `cut away`→illustrative.
- Per-mode default: illustrative; cinematic→dynamic.

**U13 · Music / VO** — *"Music, voiceover, both, or neither?"* · **triage: ASK** (required key)
- Options: voiceover / both (VO over bed) / music only / neither
- **→** `music_vo` (required; orchestrator normalizes — NOT a server enum)
- **auto:** `voiceover`/`narration`→voiceover; `music`/`trending sound`→music; `VO over music`→both; `silent`→neither; pre-select for confirm.

**U14 · Subject compositing** — *"Matte the speaker onto a clean backdrop for any shots?"* (CONDITIONAL: hide if `VOB_REMOVE_BG_DISABLE` or model unavailable) · **triage: CONDITIONAL** (default off; ASK only on a prompt cue)
- Options: no ★ / yes onto color/gradient (`design_token`) / yes onto another clip (`clip_ref`)
- **→** `broll_placements[].render_mode='subject'` + `backdrop{kind}`; hyperframes `remove-background`, budget-capped (`subjectBudget`), **degrades to pip**. Ingested-only — no synthesized/stock/AI backdrops.
- **auto:** `cut me out`/`green screen`/`gradient` → subject; else off.

**U15 · Loudness** — *"Normalize to the streaming standard?"* · **triage: SILENT** (default on; recap at PLAN)
- Options: -14 LUFS ★ / keep source levels
- **→** `loudnorm.js` (fixed -14 LUFS; on/off only via `VOB_NO_LOUDNORM` — **there is no custom-target field**; a "louder/quieter/specific LUFS" question is **[needs engine change]**, parked §6.5)
- **auto:** `normalize`→on; `leave levels`/`already mastered`→off.

**U16 · Key moments** — *"Which moments must make the cut?"* (multi-select over INSPECT segments / hook candidates) · **triage: ASK** (required; cannot be defaulted from preset)
- Options: live from INSPECT segments + `hook_candidates[]` (timestamps + on-screen text) · free-text add
- **→** `key_moments` (required; the empty-prompt path MUST collect this — it is the one required key with no preset default and is distinct from M3/hook). Multi-select is engine-legal here.
- **auto:** explicit "make sure to include X" / timestamps → pre-select; otherwise present INSPECT segments and ask. Not inherited via `--like` (content-specific).

**U17 · Ducking** — *"Duck the music under the talking?"* (CONDITIONAL: only if `music_vo ∈ {music,both}`) · **triage: CONDITIONAL — see caveat**
- Options: duck ★ / full level (music-forward)
- **→** On the **segmented-assembly** path, `vob_assemble_video` `music_path` sidechain duck (fixed-gain fallback). For a **single-timeline** social short rendered in one composition, ducking is a composer/hyperframes audio-mix concern, NOT `assemble_video` — likely composer-prose only today. **[needs engine change]** for guaranteed single-timeline ducking; until verified, treat U17 as advisory prose for non-segmented projects.
- **Conditional-gate caveat:** `music_vo` is free-text (not canonicalized), so gating U17 on `music_vo ∈ {music,both}` relies on skill-side string matching of an un-normalized key — brittle. Prefer making U17 **unconditional-but-defaulted** (default = the mode's value), OR canonicalize `music_vo` first **[needs engine change]**. Per-mode default: duck EXCEPT cinematic music-led = full level.

### Mode-specific questions

**M1 · Fan-out** (social-short, podcast) — *"One video, or several shorts from this footage?"* · **triage: ASK**
- Options: one ★ / a few (~2–3) / several (4+) / long + shorts (podcast)
- **→** storyboarder `shorts[]` (schema 1.1) + `target_duration.per_deliverable`; forks the whole RENDER/PACKAGE loop. **No discrete key for N today** (open decision §6.5).
- **auto:** `cut into 3 tiktoks`/`fan out`/N count → multiple; `per short` → multiple; default single.
- **Missing capability — multi-aspect fan-out [needs engine change]:** there is **no per-short `target_platform`/aspect field** on the storyboard schema; all fan-out shorts inherit the single project geometry. "One 16:9 master + three 9:16 cuts from the same footage" is **unbuildable today** (a per-short profile override touches COMPOSE clip materialization, dims, and safe-bands, all keyed off one project profile). The framework asks N, never aspect — flagged here and in §6/standing-risks so it doesn't surface as a live-tester gap.

**M2 · Chapters / segments** (long-form, tutorial, podcast) — *"Break into chapters/sections?"* · **triage: CONDITIONAL** (default ON for >~8–10 min)
- Options: auto-detect ★ / give a count / 3-act / no chapters
- **→** storyboarder `segments[]` (schema 1.2) → YouTube chapters at PACKAGE; `render_segmentation=auto`; chaptered ruleset (`PLAN_CHAPTERS_MISSING`/`PLAN_SECTION_IMBALANCE`). **Chapter *titles* are storyboarder-authored, not asked** — there is no chapter-name question; this question controls count/structure only.
- **auto:** numbered steps/`chapters`/outline → yes (extract count); `continuous` → no.

**M3 · Hook / opening** (social-short retention; advisory elsewhere) — *"Which moment opens the video?"* · **triage: ASK (retention) / SILENT (else)**
- Options: top hook candidate ★ / alternate #2 / payoff-first cold open / editor picks
- **→** `hook_intent` (optional); options populated **live from INSPECT `hook_candidates[]`**. retention enforces `PLAN_HOOK_NOT_FIRST`/`TOO_LONG`; **disabled under chaptered/montage**. Distinct from `key_moments` (U16). NOT inherited via `--like`.
- **auto:** `open on X`/`cold open`/timestamp → record; else propose top candidates and ask.

**M4 · Speaker view** (podcast) — *"How should multiple speakers/cameras be shown?"* (mode-specific framing of U11) · **triage: CONDITIONAL** (requires ≥2 angles)
- Options: side-by-side split ★ (if ≥2 angles) / full frame / pip / grid
- **→** `layout_intent`/`design_language` → `scene.layout`, `audio_cell` selects the live mic.
- **auto:** INSPECT camera count first; `two cameras`/`both of us`→split; single angle→full-frame, skip.

**M5 · Callouts / on-screen labels** (tutorial) — *"Which annotations?"* (multi-select) · **triage: ASK**
- Options: callouts ★ / section title cards ★ / progress bar / end card
- **→** `design_language` → `scene.overlays[]` typed objects from tutorial `overlay_vocabulary`; QC binds via `data-vob-overlay-id`
- **auto:** `highlight`/`arrow`→callout; `label each step`→section_title; `progress`→progress_bar; `subscribe`→end_card.

**M6 · Overlays / graphics** (long-form, podcast, general) — *"Any on-screen graphics?"* (multi-select) · **triage: CONDITIONAL**
- Options: chapter/section cards / lower-third name tags / logo bug / CTA + end card / none
- **→** `design_language` → `scene.overlays[]` from preset `overlay_vocabulary`
- **auto:** `guest name`→lower_third; `logo`→logo_bug; `chapter titles`→chapter_marker; `CTA`/`subscribe`→cta/end_card. Default lower-thirds for multi-speaker; chapter cards for chaptered.

**M7 · Frame feel** (cinematic) — *"24fps film cadence, or smoother?"* · **triage: SILENT** (default 24 for cinematic; recap at PLAN)
- Options: 24fps ★ / 30fps standard
- **→** platform profile `fps` via `target_platform=cinematic` → `target.fps` → composer `data-fps`; QC `vob/fps_mismatch`.
- **auto:** default 24 for cinematic; 30 only if explicit.

**M8 · Distribution copy** (podcast, optional anywhere) — *"Post copy ready (title, description, hashtags)?"* · **triage: CONDITIONAL** (PACKAGE-time, never gates)
- Options: draft it for me ★ / I'll provide / skip
- **→** `target.distribution{title,description,hashtags,cta}`; surfaced at PACKAGE.
- **auto:** explicit title/hashtags → verbatim; else draft.

> *Merged out:* grade (M8 prior), film-feel (M9 prior), and design/look (M11 prior) are now sub-options under the single **U6 look beat** — see §4 redundancy resolution. Caption-style (former U6) likewise folds into U6.

### Silent-default rows (never asked; recapped at PLAN)
fps (non-cinematic), render segmentation mode, render workers/quality, video budget, b-roll render mode (storyboarder-owned), thumbnail timestamp, loudness on (U15), video-type for derivable modes (U3), 24fps for cinematic (M7). These ride the preset.

---

## 5. Architecture recommendation

### Where the questions live — **HYBRID, weighted to skill-markdown**

| Layer | Owns | Files |
|---|---|---|
| **Skill (bulk)** | The catalog (questions, per-mode defaults, options, recommended tag, `triage_tier`, exact phrasing); the 5-pass loop (Pass 0–4); the PLAN recap | NEW `references/clarifying-questions.md`; rewritten `phases/INTENT.md`; one recap line in `phases/PLAN.md` |
| **Engine (minimal)** | Durable, resume-surviving, machine-read home for answers | Existing keys via `vob_record_intent_answer`; a SMALL set of new entries in `OPTIONAL_INTENT_KEYS` (`intent-schema.js`) **and** the `record-intent-answer.js` inputSchema enum |

**Rationale.** Honors the established contract: *engine enforces structure (required keys, confirm semantics, gate preconditions); skill owns wording and UX.* The whole question SET is UX → skill. But `brief.md` is free-form and never read back as state, so an answer encoded only there is invisible to the storyboarder spawn — it must flow through `vob_record_intent_answer`. Hence the hybrid: catalog as skill UX, answers durable + machine-read.

- **Why not engine-backed catalog:** drags wording/options/defaults into the engine, needs allow-list churn, freezes copy behind a release.
- **Why not skill-only:** the new creative knobs (speed, snap-to-clean-spans, transitions, layout, caption animation) have NO existing key; brief-only encoding won't survive resume or thread into the data-only storyboarder spawn.

**Adding an optional key is a THREE-spot edit + a silent failure mode.** `OPTIONAL_INTENT_KEYS` (intent-schema.js) + the `record-intent-answer.js` inputSchema enum + a consumer (storyboarder spawn / lint). The validator **rejects unknown keys**, so a half-landed key (enum not updated) fails *silently at record time* — the answer simply won't persist and it'll look like "the skill asked but nothing stuck." Land all three together.

### Answer classes
- **(a)** Maps to an existing key → zero engine change (most questions).
- **(b)** Genuinely new knob → add a NEW optional key (free-text, never-gating) — the **[needs engine change]** rows.
- **(c)** Pure confirmation (multi-file role map) → conversational, no recorded key.

### Suggestion UX — `AskUserQuestion`
- Native Claude Code tool, not currently referenced in any adapter file → additive. **Verify on first run** that it needs no `settings.json` permission entry (plausible as built-in, but unconfirmed against this repo's permission model — do not assume "no allow-list change").
- Each question: catalog options as choices; per-mode default placed **first + tagged "(recommended)"**; a free-text **"something else"** escape on every question (critical — most keys are free-text downstream); multi-select only where engine semantics allow (`key_moments`, b-roll/overlay appetite).
- **Single legitimately-closed question:** `audio_treatment` (the 4 enum tokens exactly).

### How answers flow downstream
- Every answer → `state.intent.answers` (overwrite-by-key, persisted, resume-surviving, in `summary.intent.answers`, used by `--like`).
- At PLAN: `design_language` transcribed verbatim into the binding Design language section; the storyboarder spawn (already data-only) gains lines for new/used keys — exactly like existing `intent.pacing_intent`/`hook_intent`/`broll_intent` lines. No new plumbing.
- `editorial_intent`→clean-span snap toggle · `speed_intent`→`source_clips[].speed` · `caption_animation_intent`→`caption_segments[].animation` · `transition_intent`→`scene.transition_in` · `layout_intent`→`scene.layout` · chapter count→`segments[]`.

### Anti-fatigue triage (how many to ASK)
1. **AskUserQuestion ≤4/call** → group ASK-tier rows into the existing beats (Format / Story+moments / Look & captions / Audio / Creative knobs) → ~4–5 cards, not one-per-question.
2. **`triage_tier` on every catalog row** (per mode) is the load-bearing artifact — only ASK-tier still-unknown rows become questions; SILENT and Pass-1-prefilled rows drop out. The collapses (U6 look beat; U7 spine absorbing U8/U9) and CONDITIONAL gates are what make the count land.
3. **Worked example — cinematic, empty prompt** (~19 applicable rows): ASK = U6(look), U7(pacing), U13(music/VO), U16(key moments) + (CONDITIONAL, likely fire) U1, U2 = **~6 rows → 2 cards**. SILENT/recap: U3, U15, M7, fps, segmentation. CONDITIONAL/skip: U4 (`keep_ambient` default, no captions → U5 N/A), U8/U9 (derived from U7), U10 (preserve), U11/U14 (off), U12 (default), U17 (full-level). This is how 19 applicable → ~2 cards; the claim is only credible *because* each row carries a tier.
4. **Conservative default:** anything safely preset-derivable defaults to **SILENT** (the fatigue-regression guardrail). Recommended-first means even a shown card is one tap.

### Incremental build order / MVP

| Slice | Content | Engine risk |
|---|---|---|
| **0 (MVP)** | Catalog covering ONLY existing keys (5 req incl. the explicit `key_moments` row + 2 cond + 5 opt). Rewrite INTENT.md (5-pass loop + AskUserQuestion). PLAN recap line. Port to OpenCode, commit both. Delivers always-resolve/always-suggest/just-select for everything already steerable. | **none** |
| **1** | Add 2 highest-leverage new keys: `editorial_intent` (snap-to-clean-spans) + `caption_animation_intent`. Thread into storyboarder spawn (3-spot edit each). | low |
| **2** | `transition_intent`, `layout_intent`, `speed_intent` (or route via richer prose in existing keys — see §6.1). Each independently shippable. | low |
| **3** | Walker scenario (`m5-walker.js intent`) exercising pre-fill/default/ask paths model-free + asserting new keys record and thread. Optional soft plan-lint warning when the storyboarder visibly ignored a strong creative intent. | low |
| **4 (deferred)** | Filler-aggressiveness (needs INSPECT options thread + PLAN→INSPECT re-run), explicit fan-out N (needs a home for N), multi-aspect fan-out (per-short profile field), single-timeline ducking, custom loudness target (new field). All genuine engine work. | medium — new fields/wires |

---

## 6. Open decisions for the human

1. **Clean-cut control [engine work, not a taste call].** `computeCleanSpans` is called in INSPECT with **no options object**, so `removeDiscourseFillers` is hard-`false` and never threaded; INSPECT also runs *before* INTENT, so any "filler appetite" answer arrives after `clean_speech.json` is already written. **(A)** Ship only the honest half — `editorial_intent` = storyboarder *snaps to keep-spans or not* (real, no engine change beyond the new key). **(B)** Add filler-aggressiveness too — requires threading an option into the INSPECT clean-cut call AND a PLAN→INSPECT re-run when the appetite changes post-INSPECT. — *Recommend (A) for v3.7; (B) is a future INSPECT slice. The "podcast filler default ON?" taste call is **moot until this wire exists.***

2. **How many new OPTIONAL keys?** **(A)** add 4–5 dedicated keys (`editorial_intent`, `speed_intent`, `caption_animation_intent`, `transition_intent`, `layout_intent`) — clean machine-read, each needs a consumer + spawn thread + arguably a verify-lint; **(B)** minimum (`editorial_intent` + `caption_animation_intent`), carrying transition/layout/speed appetite as richer prose inside existing `pacing_intent`/`design_language`/`broll_intent`. — *Recommend (B) for MVP, (A) as follow-on once the questionnaire proves which knobs users touch.*

3. **`video_type`: pin or stay reactive?** Under the precedence chain (`env > recorded > derivation > default`), **recording IS pinning** — there is no "confirm that stays reactive." The real fork: *record-on-confirm* (pins; a later platform/duration change won't re-derive) vs *don't-record-unless-re-routed* (stays derived/reactive — the engine already supports this; just skip `record_intent_answer` on a plain keep). — *Recommend don't-record-on-plain-keep for reactivity; always-record only on explicit re-route and for podcast (underivable).*

4. **Karaoke when `transcript_aligned===false`.** Word-level captions gate on a host fact, not a creative knob. **(A)** surface the word-level option only when already aligned (safe, no INSPECT churn). **(B)** offer always and back-edge to re-INSPECT with whisperx on "yes" (adds a re-ingest-class loop + `pip install whisperx`). — *Lean (A) for v3.7.*

5. **Fan-out (N + multi-aspect) and loudness target — in or out of MVP?** Fan-out N is only inferred from a `per short` qualifier today; an explicit "one or N?" needs **a home for N** (`target_duration` carries `per_deliverable:true`, not a count). **Multi-aspect fan-out** (different aspects per short) is **unbuildable** — no per-short profile field. Custom loudness target needs **a new engine field** (only on/off exists). — *All lean OUT of the MVP (Slice 4); flag multi-aspect explicitly so live-testers aren't surprised.*

### Standing risks to keep visible
- **Optional-key softness:** a new optional key never gates and reaches the storyboarder as advisory spawn data — "user-steerable" means "the storyboarder *may* honor it." Mitigate with spawn-prompt emphasis + a soft plan-lint; don't over-promise hard enforcement.
- **Multi-aspect fan-out gap:** all fan-out shorts share one project aspect/platform today — call it out, don't let it surface as a bug.
- **Silent mis-record of required keys:** Pass 1 silently records OPTIONAL keys only; required/conditional parsed from freeform are pre-*selected* for one-tap confirm, never committed — preserving the "engine is authority on required" contract.
- **Free-text conditional gates:** `music_vo` isn't canonicalized; gating U17 on it is skill-side regex over un-normalized state. Prefer unconditional-but-defaulted, or canonicalize `music_vo` first.
- **Three-spot enum edit, silent failure:** a new optional key touches `OPTIONAL_INTENT_KEYS` + the `record-intent-answer.js` enum + a consumer; a half-landed key is rejected at record time and never persists.
- **Adapter drift:** author claude-code side, regenerate OpenCode via `scripts/port-adapter-docs.js`; the boot drift guard covers only tool references, not phase-file content — manual discipline.
- **AskUserQuestion permission:** verify it needs no allow-list entry on first run.
