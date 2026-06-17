# Clarifying-question catalog (v3.7)

**Read once at INTENT entry, alongside `brief-design.md`.** This is the *data* for the INTENT
clarifying-question framework; the *procedure* (the 5-pass resolve-from-prompt-else-ask loop) lives
in `.opencode/vob/phases/INTENT.md`. The contract in one breath: a **fixed** set of questions, **mode-aware**
defaults, every question **resolved from the prompt or asked** with **selectable suggestions** (a
recommended default pre-picked), and everything silently-defaulted **recapped at the PLAN sign-off**.

Every row maps to a real engine knob — never ask about something the engine can't honor. Most rows
map to an existing intent key; the five v3.7 creative knobs (`caption_animation_intent`,
`editorial_intent`, `speed_intent`, `transition_intent`, `layout_intent`) are new OPTIONAL keys —
free-text, never-gating, advisory to the storyboarder (only `speed_intent`/`layout_intent`
HARD-materialize; the rest the storyboarder/composer *may* honor).

## How the orchestrator uses this (summary — full loop in INTENT.md)

1. **Resolve the mode FIRST** (`summary.video_type.{canonical,source}` + the prompt). It supplies
   every default below, so settle it before computing any default. Podcast must be pinned (it never
   derives); other types stay reactive (don't record a plain "keep").
2. **Pre-fill from evidence** (rough idea + INSPECT signal + `--like` source answers). Silently
   record OPTIONAL keys only; pre-*select* required/conditional answers for one-tap confirm.
3. **Default** each still-unknown row from the matrix below (recommended, not yet recorded).
4. **Triage** by `triage` tier: SILENT rows are never asked (recap at PLAN); CONDITIONAL rows fire
   only when their `when` gate holds; ASK rows are surfaced.
5. **Ask** the surviving ASK/fired-CONDITIONAL rows via `AskUserQuestion`, grouped into the beats
   (≤4 questions/card, recommended option first + "(recommended)", a free-text "something else"
   escape on every question except `U4` which is the one closed enum). Record each answer as it
   returns; an override is one more `vob_record_intent_answer`.

The worked target: a rich prompt → 1–2 confirm cards; an empty prompt → ~4–5 grouped cards, not
one-per-question. Anything safely preset-derivable stays SILENT.

## Mode × default matrix

Cells = the **recommended default** for that mode. `—` = not surfaced (silent / N/A). Engine-accurate
(platform profiles and vocabularies verified against `mcp/lib/video-types.js`).

| Question | social-short | long-form | cinematic | tutorial | podcast | general |
|---|---|---|---|---|---|---|
| U1 Format / platform | tiktok 9:16 | youtube_long 16:9 | cinematic 16:9 24fps | tutorial 16:9 | youtube_long 16:9 | landscape 16:9 |
| U2 Length | 20–45s | 8–12 min | ~90s | (ask) | full episode | (ask) |
| U3 Video type | keep social-short | keep long-form | keep cinematic | keep tutorial | **pin podcast** | keep general |
| U4 Audio treatment | transcribe_captions | transcribe_captions | **keep_ambient** | transcribe_captions | transcribe_captions | ask if audio |
| U5 Caption animation | karaoke *iff aligned*, else pop | pop | pop / static | pop | pop | pop |
| U6 Look (caption+grade) | bold-pop | clean-pill | minimal lower-third + desaturated + letterbox | clean-pill | minimal lower-third | clean-pill |
| U7 Pacing | fast | build to climax | slow holds | medium | medium | medium |
| U8 Speed | light ~1.25× | natural | natural | speed slow stretches | natural | natural |
| U9 Transitions | punchy (whip/zoom) | cuts + dip at chapters | gentle dips / crossfades / focus_pull | cuts + slide/dip | clean cuts + dips | hard cuts |
| U10 Snap clean-spans | yes | yes | **no (preserve)** | yes | yes | yes |
| U11 Layout | none | none | none | **pip** | **split (≥2 cams)** | none |
| U12 B-roll appetite | illustrative | illustrative | dynamic | illustrative | illustrative | illustrative |
| U13 Music / VO | voiceover | VO + bed | music-led | voiceover | both | music bed |
| U14 Subject compositing | off | off | off | off | off | off |
| U15 Loudness | −14 LUFS | −14 LUFS | −14 LUFS | −14 LUFS | −14 LUFS | −14 LUFS |
| U16 Key moments | (ask) | (ask) | (ask) | (ask) | (ask) | (ask) |
| U17 Ducking | (n/a unless music) | duck | full level | (n/a) | duck | duck |
| M1 Fan-out (N) | one | — | — | — | one | — |
| M2 Chapters | — | auto 3–5 | continuous | auto-detect | auto (>8 min) | — |
| M3 Hook / opening | top hook candidate | cold open | establishing | "what you'll learn" | teaser cold-open | best (auto) |
| M5 Callouts | — | — | — | callouts + section titles | — | — |
| M6 Overlays | — | chapter cards + lower-thirds | title/section cards | — | name lower-thirds | none |
| M7 Frame feel | (preset 30fps) | 30fps | **24fps** | 30fps | 30fps | 30fps |

Reading notes: "captions off" is not a boolean — it is an `audio_treatment` token (`keep_ambient` =
preserve room tone, no burn-in; the cinematic default). Cinematic flips the most defaults
(`keep_ambient`, snap OFF, music-led, 24fps, slow). Aspect & fps are pure consequences of the
platform — never asked, silently defaulted, recapped once.

## Universal questions

Notation per row: **id · name** (`triage`) — *question* — options (★ = matrix default) — **→** key —
**auto** prompt heuristic — **when** applicability gate.

### Beat: Format

**U1 · Format / platform** (`CONDITIONAL` — ASK only if no platform token in the prompt)
*"Which platform / aspect is this for?"* — TikTok 9:16 / Reels 9:16 / Shorts 9:16 / YouTube 16:9 /
Square 1:1 / Cinematic 16:9 24fps · **→** `target_platform` (server canonicalizes `{raw,canonical,
profile}`; co-derives fps + safe bands) · **auto** `tiktok`/`reels`/`shorts`/`youtube`/`9:16`/`16:9`
→ pre-select for confirm · **when** always applies; only the *ask* is conditional on the prompt.

**U2 · Length** (`CONDITIONAL` — ASK if no duration phrase)
*"How long should the final cut be?"* — 15s / 30s / 60s / a range (20–45s) / minutes (8–12 min) /
per-deliverable (45s per short) · **→** `target_duration` (`parseDurationSpec`) · **auto** a duration
phrase / range / `per short`/`each` → pre-select (`per short` also flags fan-out).

**U3 · Video type** (`SILENT` for derivable modes — recap at PLAN; `ASK` only for podcast)
*"This looks like a `<mode>` — keep that, or route it differently?"* — keep `<mode>` ★ / route
elsewhere · **→** `video_type` (optional) — **recording = pinning**; a plain "keep" records NOTHING
(stays reactive to a later platform/duration change). Record only on an explicit re-route, and
ALWAYS for **podcast** (`deriveVideoType` never reaches it) · **auto** an explicit type word →
record; vertical+short already derives social-short → don't ask.

### Beat: Story & moments

**U16 · Key moments** (`ASK`; multi-select) — required, no preset default.
*"Which moments must make the cut?"* — live from INSPECT segments + `hook_candidates[]` (timestamps +
on-screen text) + free-text add · **→** `key_moments` (required) · **auto** explicit "make sure to
include X" / timestamps → pre-select; else present segments and ask. NOT inherited via `--like`.

**U7 · Pacing / energy** (`ASK`) — the spine for energy; U8/U9 derive from it.
*"How fast and energetic should it feel?"* — fast / medium / slow holds · **→** `pacing_intent` ·
**auto** `fast`/`punchy`→fast; `let it breathe`→slow; else the matrix default. (tone ≠ pacing.)

**M3 · Hook / opening** (`ASK` under retention; `SILENT` elsewhere)
*"Which moment opens the video?"* — top hook candidate ★ / alternate / payoff-first cold-open /
editor picks · **→** `hook_intent` (options live from `hook_candidates[]`) · **auto** `open on X`/
`cold open`/timestamp → record. Distinct from U16; not inherited via `--like`.

### Beat: Look & captions

**U4 · Audio treatment / captions** (`ASK` when audio present) — the one closed enum (no free-text).
*"Burn in subtitles, or how should we treat the source audio?"* — burn captions (`transcribe_captions`)
★ / keep audio, no captions (`keep_audio`) / drop source audio (`discard_audio`) / keep ambient only
(`keep_ambient`) · **→** `audio_treatment` (server enum) · **auto** `captions`/`subs`→transcribe;
`no captions`→keep_audio; `music only`/`mute`→discard; ambient b-roll→keep_ambient · **when**
`audio_present`. "Captions off" = one of the non-transcribe tokens, a real choice.

**U5 · Caption animation** (`CONDITIONAL`) — word-level options shown ONLY when aligned.
*"How should captions animate?"* — pop (chunk) ★ / **word-by-word / karaoke (shown only when
`transcript_aligned===true`)** / static · **→** `caption_animation_intent` → `caption_segments[].
animation` (`static`/`none` ⇒ OMIT the field — there is no `static` token) · **auto** `karaoke`/
`word highlight` → karaoke *only if aligned*, else pop · **when** captions in play (`audio_present`
+ a caption-bearing treatment). Word-level is HARD-gated on alignment — never offer/auto-select it
otherwise (no re-INSPECT loop in v3.7).

**U6 · Look (caption style + grade + film-feel)** (`CONDITIONAL` — ASK if the prompt names a look/brand;
else SILENT to the preset `design_default`)
*"What's the overall look — caption style, and (cinematic) grade / letterbox?"* — follow preset ★ /
bold-pop / clean-pill / minimal lower-third / `--like` a project · *cinematic adds* grade
(desaturated ★ / teal-orange / warm / natural) + film-feel (letterbox ★ / + grain / neither) ·
**→** `captions_style` (conditional) + `design_language` (optional) → `target.design` · **auto**
explicit font/case/color/`brand` → verbatim; `teal & orange`→teal-orange; `golden hour`→warm; else
preset. One look beat per mode — never three.

### Beat: Audio

**U13 · Music / VO** (`ASK`) — required key.
*"Music, voiceover, both, or neither?"* — voiceover / both (VO over bed) / music only / neither ·
**→** `music_vo` (required; orchestrator normalizes) · **auto** `voiceover`/`narration`→voiceover;
`music`/`trending sound`→music; `VO over music`→both; `silent`→neither.

**U17 · Ducking** (`CONDITIONAL` — default-but-confirm; default duck) — only meaningful with music.
*"Duck the music under the talking?"* — duck ★ / full level (music-forward) · **→** advisory
(segmented-assembly: `vob_assemble_video` sidechain; single-timeline: composer mix) · **auto**
`music forward`→full; else duck · **when** `music_vo` mentions music/both. Prefer defaulting over a
hard gate (`music_vo` isn't canonicalized). Cinematic music-led defaults to full level.

### Beat: Creative knobs (mostly CONDITIONAL/derived — surfaced only when the prompt raises them)

**U8 · Speed** (`CONDITIONAL` — ASK only if the prompt mentions speed/fit; else default from U7+preset)
*"Speed up slow / over-long talking to fit?"* — light ~1.1–1.25× ★ / aggressive (whatever fits) /
natural only / slo-mo a beat · **→** `speed_intent` → `source_clips[].speed` (HARD; baked at COMPOSE;
`PLAN_DURATION_INFEASIBLE` validates) · **auto** `1.25x`/`speed up`/`make it fit`→speed; `slo-mo`→slow;
`natural`→none.

**U9 · Transitions** (`CONDITIONAL` — ASK only if the prompt mentions a transition; else default from
U7+preset; multi-select)
*"What transition feel between shots?"* — punchy (whip/zoom) / gentle dissolves / hard cuts / dip at
seams · **→** `transition_intent` → `scene.transition_in` from the preset `transition_vocabulary`
(unknown→cut + `PLAN_TRANSITION_UNKNOWN_TYPE`; shaders not offered) · **auto** `whip pan`/`zoom`→whip_pan/zoom_punch/push (when in vocab);
`hard cuts only`→cut; `dissolve`/`smooth`→crossfade/dip.

**U10 · Snap to clean-spans** (`CONDITIONAL` — ASK only if INSPECT wrote `clean_speech.json` with removed spans)
*"Tighten the speech — drop dead air and ums between kept lines?"* — yes, snap ★ / keep natural pauses ·
**→** `editorial_intent` (ADVISORY — changes the storyboarder's snap *choice*; does NOT alter the
`PLAN_CLIP_STRADDLES_REMOVED_SPAN` lint) · **auto** `tighten`/`cut the ums`→snap; `keep it raw`→preserve ·
default snap everywhere EXCEPT cinematic = preserve (under `clean_cut=false` an explicit "tighten"
surfaces as a gate conflict, not a silent snap). Filler-WORD aggressiveness is NOT steerable in v3.7.

**U11 · Split-screen / layout** (`CONDITIONAL` — requires INSPECT ≥2 angles)
*"Split-screen, multi-cam, or PiP moments?"* — none ★ / split (2-up) / pip (reaction) / 2×2 grid ·
**→** `layout_intent` → `scene.layout` (HARD; pre-composited to ONE clip at COMPOSE; degrades to CSS
cells) · **auto** `side by side`/`before-after`→split; `pip`/`reaction`→pip; `grid`/`four up`→grid ·
default none EXCEPT tutorial→pip, podcast→split. (`pip` here = `scene.layout` pip, not an overlay/b-roll pip.)

**U12 · B-roll appetite** (`CONDITIONAL` — skip if `broll_count==0`)
*"How much should we cut away to b-roll?"* — illustrative ★ / dynamic / minimal / A-roll only ·
**→** `broll_intent` (appetite, NOT render mode) · **auto** `lots of b-roll`→dynamic; `stay on me`→minimal;
`cut away`→illustrative · cinematic defaults dynamic.

**U14 · Subject compositing** (`CONDITIONAL` — default off; ASK only on a prompt cue; hide if `VOB_REMOVE_BG_DISABLE`/model unavailable)
*"Matte the speaker onto a clean backdrop for any shots?"* — no ★ / yes onto color/gradient
(`design_token`) / yes onto another clip (`clip_ref`) · **→** `broll_placements[].render_mode="subject"`
(degrades to pip; ingested-only — no synthesized/stock backdrops) · **auto** `cut me out`/`green screen`/
`gradient`→subject; else off.

## Mode-specific questions

**M1 · Fan-out** (social-short, podcast — `ASK`)
*"One video, or several shorts from this footage?"* — one ★ / a few (~2–3) / several (4+) / long +
shorts (podcast) · **→** storyboarder `shorts[]` (schema 1.1) + `target_duration.per_deliverable` ·
**auto** `cut into 3 tiktoks`/`fan out`/an N → multiple. *No discrete key for N today, and multi-aspect
fan-out is NOT supported — all shorts inherit the one project aspect; do not promise per-short aspects.*

**M2 · Chapters / segments** (long-form, tutorial, podcast — `CONDITIONAL`, default ON for >~8–10 min)
*"Break into chapters/sections?"* — auto-detect ★ / give a count / 3-act / no chapters · **→**
storyboarder `segments[]` (schema 1.2) → YouTube chapters at PACKAGE · **auto** numbered steps/
`chapters`/outline → yes (extract count); `continuous`→no. Chapter *titles* are storyboarder-authored,
not asked.

**M4 · Speaker view** (podcast — `CONDITIONAL`, ≥2 angles) — the podcast framing of U11.
*"How should multiple speakers/cameras be shown?"* — side-by-side split ★ / full frame / pip / grid ·
**→** `layout_intent`/`design_language` → `scene.layout` (`audio_cell` = the live mic) · **auto** INSPECT
camera count first; `two cameras`/`both of us`→split; single angle→full-frame, skip.

**M5 · Callouts / on-screen labels** (tutorial — `ASK`; multi-select)
*"Which annotations?"* — callouts ★ / section title cards ★ / progress bar / end card · **→**
`design_language` → `scene.overlays[]` from the tutorial `overlay_vocabulary` · **auto** `highlight`/
`arrow`→callout; `label each step`→section_title; `progress`→progress_bar; `subscribe`→end_card.

**M6 · Overlays / graphics** (long-form, podcast, general — `CONDITIONAL`; multi-select)
*"Any on-screen graphics?"* — chapter/section cards / lower-third name tags / logo bug / CTA + end card /
none · **→** `design_language` → `scene.overlays[]` from the preset `overlay_vocabulary` · **auto**
`guest name`→lower_third; `logo`→logo_bug; `chapter titles`→chapter_marker; `CTA`/`subscribe`→cta/end_card.
(No "letterbox" overlay token — letterbox/grade live in U6.)

**M7 · Frame feel** (cinematic — `SILENT`, default 24fps; recap at PLAN)
*"24fps film cadence, or smoother?"* — 24fps ★ / 30fps · **→** platform profile fps (via
`target_platform=cinematic`) → `target.fps` · **auto** default 24 for cinematic; 30 only if explicit.

**M8 · Distribution copy** (podcast, optional anywhere — `CONDITIONAL`, PACKAGE-time, never gates)
*"Post copy ready (title, description, hashtags)?"* — draft it for me ★ / I'll provide / skip · **→**
`target.distribution` (surfaced at PACKAGE) · **auto** explicit title/hashtags → verbatim; else draft.

## Silent-default rows (never asked; recapped at PLAN)

fps (non-cinematic), render segmentation mode, render workers/quality, the `<video>` budget, b-roll
render mode (storyboarder-owned), thumbnail timestamp, loudness-on (U15), video_type for derivable
modes (U3), 24fps for cinematic (M7). These ride the preset and surface once in the PLAN recap.

## AskUserQuestion grouping

Batch surviving ASK / fired-CONDITIONAL rows into the beats above → ~4–5 cards (Format, Story &
moments, Look & captions, Audio, Creative knobs), ≤4 questions per `AskUserQuestion` call. Place the
matrix default FIRST and tag it `(recommended)`. Add a free-text "something else" escape to every
question EXCEPT `U4 audio_treatment` (the one closed enum — the server rejects off-enum tokens).
Multi-select only where engine-legal: `U16` key_moments, `U9` transitions, `M5`/`M6` overlay appetite.
