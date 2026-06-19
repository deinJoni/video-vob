# Design profiles — named, reusable brand looks (the `--like` successor)

A **design profile** is a named, self-contained style bundle stored at
`.vob-config/design-profiles/<name>.json`. Author it once, apply it to any future project **by
name**, and every output shares the same identity without re-deriving it. It **replaces `--like`**
(the old `state.style.derived_from` lineage that pointed a new project at a prior `project_id` and
did a cross-project read) — a profile is a first-class named store, so **there is no cross-project
read**. Read this when a profile is active, or when the user wants to create / pick one.

A profile is **orthogonal to the video-type preset**: the preset says *what kind of video this is*
(lint ruleset, render segmentation, overlay/transition vocabulary); the profile says *what MY brand
looks like + my house editorial defaults*. The same profile renders as a social-short or a cinematic
long-form because its look is portable `--vob-*` tokens (every design-system component reads them).

## The two blocks

A profile carries two optional, partial blocks:

| block | shape | resolves into |
|---|---|---|
| `look` | `palette{bg,surface,text,text_muted,accent,accent_2}`, `typography{headline,caption,body}` (kit families), `caption_style`, `motion`, `grade`, `slots?` | `target.design` + the `--vob-*` CSS tokens the composer renders from |
| `editorial_defaults` | `video_type`, `target_platform`, `tone`, `music_vo`, `caption_animation`, `pacing`, `transition_lean`, `speed`, `layout` | pre-fill INTENT answers (overridable) |

The palette keys map to tokens 1:1: `bg→--vob-bg`, `surface→--vob-surface`, `text→--vob-text`,
`text_muted→--vob-text-muted`, `accent→--vob-accent`, `accent_2→--vob-accent-2`. A partial profile
gap-fills any omitted token from the active video-type's `design_default` at resolve time, so a
profile that sets only a palette is fine.

**The carve-out (HARD RULE):** `editorial_defaults` may default the **stylistic** keys above but
**NEVER `key_moments`** (content-specific) and **NEVER `target_duration`** (content/campaign-
specific). This is the exact rule `--like` enforced; a hand-authored profile that tries to set them
has them stripped. Nothing in a profile gates — the five required-intent-key contract is untouched.

## How a profile is surfaced and resolved

The engine resolves the active profile and surfaces it in `read_state_summary.design_profile`
(mirroring how `video_type` is surfaced). When one is active:

```
design_profile: {
  name, source,                  // source ∈ "env" | "intent" | "init"
  description?,
  look: { palette, typography, caption_style, motion, grade, slots? },   // gap-filled, ready to use
  editorial_defaults,            // the friendly-named defaults as authored
  intent_prefill,                // editorial_defaults remapped onto canonical intent keys — record/pre-select these
  editorial_default_keys         // which keys the profile sets
}
```

When none is active it is `{ name: null, source: "none" }` — the orchestrator falls back to the
video-type `design_default` exactly as before.

**Active-profile precedence** (most → least specific; the engine applies it — you just read the
result):

| tier | source | set by |
|---|---|---|
| 1 | `VOB_DESIGN_PROFILE` env | per-process override (install / test) |
| 2 | recorded `design_profile` intent answer | the human's explicit INTENT choice |
| 3 | `state.design_profile.name` init stamp | `vob_init_project { design_profile: <name> }` (SKILL.md) — the `--like` successor |
| 4 | none | fall through to the video-type `design_default` |

`design_profile` is an **OPTIONAL intent key** (recordable via
`vob_record_intent_answer { key: "design_profile", value: <name> }`, canonicalized to `{raw,name}`;
an unrecognized name stores `name:null` and falls through). It never gates — exactly like
`video_type`.

**Where it lands downstream** (you don't re-derive any of this — read the summary):
- **INTENT** — `intent_prefill` pre-answers the stylistic optional/required keys (precedence:
  explicit human answer > profile default > derivation/ask); the `look` seeds the look beat. See
  `phases/INTENT.md` → *Active design profile*.
- **PLAN** — the storyboarder spawn threads `design_profile.look`, which it mirrors VERBATIM into
  `target.design`; the brief's Design language is seeded from it.
- **COMPOSE** — the composer spawn carries the resolved `--vob-*` tokens; the composer sets the
  custom properties from them (the kit already consumes them).

## Authoring a profile — the guided flow (skill-layer UX)

When the user wants a reusable look ("save this as my brand style", "make all my videos look like
X"), walk them through it, then call `vob_save_design_profile`. Offer a **starting point** first:

> "Start from → **blank**, a **starter profile** (bold-social / clean-corporate / cinematic-gold /
> warm-podcast / mono-editorial), or **an existing project's resolved look**?"

Then ask the look + defaults (an `AskUserQuestion` card or two — only what you can't infer):
- **palette** — bg / surface / text / accent (and accent_2) hexes, or a vibe to derive them from
- **fonts** — headline + caption + body from the kit (name only kit families; see `composer.md`)
- **vibe / motion** — fast-snap / medium-soft / slow-cinematic; grade (none / warm / cool /
  desaturated / high-contrast / monochrome)
- **captions** — bold-pop / clean-pill / minimal-lower-third + animation (pop / karaoke / static)
- **tone** and **music/VO** — the house editorial defaults
- optionally **video_type / platform / pacing / speed / layout / transitions** — any stylistic
  default the brand reuses (never `key_moments` / `target_duration`)

Then save:

```
mcp__vob__vob_save_design_profile {
  name: "<kebab-case>",
  description: "<one line>",
  look: { palette, typography, caption_style, motion, grade, slots? },
  editorial_defaults: { video_type?, target_platform?, tone?, music_vo?, caption_animation?,
                        pacing?, transition_lean?, speed?, layout? },
  overwrite?: <true to replace a same-named profile>
}
```

It writes a validated profile to `.vob-config/design-profiles/<name>.json` and returns the
canonicalized profile + path. Validation is loose / fail-safe (a bad token is dropped, never
rejects); the carve-out keys are stripped automatically.

**"Make it look like that real project"** — the graceful successor to `--like`'s one genuinely
useful capability. When the user picks *an existing project's resolved look*: read that source
project's `vob_read_state_summary { project_id: <source> }` → `design_profile.look` (cross-project
*reads* stay open), or, if the source predates profiles, read its `compose/` look + `brief.md`
Design language; capture it as a durable NAMED profile via `vob_save_design_profile`. The result is
reusable forever — not a one-shot lineage.

**Hand-authoring** is just dropping a JSON file in `.vob-config/design-profiles/` (read once per
process; an absent dir or a malformed file is skipped silently) — see the
`.vob-config/design-profile.example.json` template that ships with the install. A user file whose
`name` matches a built-in merges over it. `vob_doctor` reports the effective profile table.

## Built-in starter profiles

Five ship with the engine (extend with your own `.vob-config/design-profiles/*.json`):

| name | one-liner |
|---|---|
| `bold-social` | Punchy vertical social — black canvas, Anton headlines, red/yellow accents, fast-snap motion, bold kinetic captions. |
| `clean-corporate` | Clean corporate explainer — near-black ground, Hanken Grotesk headlines, calm blue accent, soft medium motion, clean-pill captions. |
| `cinematic-gold` | Warm cinematic film — true black, Playfair Display titles, EB Garamond body, antique-gold accent, slow motion, desaturated grade. |
| `warm-podcast` | Warm conversational podcast/talk — soft dark ground, violet accent, Hanken Grotesk headlines, medium motion, warm grade, split-friendly. |
| `mono-editorial` | Stark monochrome editorial — near-black ground, Archivo Black headlines, near-white accent with a red highlight, dramatic mono grade. |
