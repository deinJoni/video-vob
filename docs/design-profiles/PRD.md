# PRD — Design Profiles (named, reusable style bundles; replaces `--like`)

> Status: SHIPPED (v0.3.10). Engine + tool built and verified; this PRD is the
> grounded record of the built surface. The original mission brief is in
> `docs/design-profiles/BUILD-PROMPT.md`.

## Problem

A project's "look" — its palette, typography, caption look, motion feel, grade, and
the house editorial defaults a brand reuses (tone, platform, music/VO treatment,
caption animation, pacing) — was **smeared across four mechanisms** with no single,
reusable home:

1. `target.design{palette,typography,caption_style,motion,grade}` in
   `mcp/lib/storyboard-schema.js` — the per-project look contract, re-written by hand
   (or by the storyboarder) for every new project.
2. The `--vob-*` CSS tokens + the design-system kit (`mcp/assets/design-system/`,
   `build-design-system.js`, `injectDesignKit` in `source-symlink.js`) — the components
   the composer renders from, driven by tokens that nothing supplied durably.
3. The per-video-type `design_default` blocks in `mcp/lib/video-types.js` — a *format*
   default, not a *brand* default.
4. **`--like`** (the `state.style = {derived_from, applied_at}` lineage in
   `mcp/lib/session-state.js`, the `derived_from` arg on `vob_init_project`, the
   orchestrator's cross-project read, and the package lineage) — which pointed a new
   project at a *prior project_id* and **re-derived its look every time** via a
   cross-project read. The look was never captured as a thing you could name and reuse;
   it was always recomputed off another project's artifacts.

So a recurring series or a consistent brand had to re-describe its style each run (or
chain `--like` off the last project, re-deriving every time). The codebase already
anticipated the fix ("named style profiles" — see the project memory note).

## The model: a design profile is orthogonal to the video-type preset

Two independent axes, deliberately kept orthogonal:

- **Video-type preset** (`video-types.js`) = *what kind of video this is* → editorial
  **rules**, lint ruleset, render segmentation, overlay/transition vocabulary, platform
  default. (How the engine processes and validates.)
- **Design profile** (`design-profiles.js`, new) = *what MY brand looks like + my house
  editorial defaults* → look tokens + pre-filled INTENT answers. (Reusable across
  formats.)

The same brand should render as a social-short **or** a cinematic long-form, so a
profile expresses its look as **portable `--vob-*` tokens** (every design-system
component already reads them) and may *select* a `video_type` as one of its editorial
defaults — without coupling the two axes. A profile authored once is applied to any
future project **by name**.

## Schema (two blocks, two resolution paths)

A profile is a JSON file at `.vob-config/design-profiles/<name>.json` — ONE profile per
file. Both blocks are **optional and partial** (a profile may carry only `look`, only
some keys, etc.). Defined and normalized in `mcp/lib/design-profiles.js`:

```jsonc
{
  "name": "acme-brand",                 // kebab-case, unique (becomes the file name)
  "description": "...",                 // one line (optional)
  "version": 1,                         // optional, defaults to 1
  "look": {                             // → resolves INTO target.design + --vob-* tokens
    "palette":      { "bg": "#0A0A0A", "surface": "...", "text": "...",
                      "text_muted": "...", "accent": "#FF3B30", "accent_2": "..." },
    "typography":   { "headline": "Anton", "caption": "Hanken Grotesk", "body": "Inter" },
    "caption_style": "bold-pop",
    "motion":        "fast-snap",
    "grade":         "high-contrast",
    "slots":         { "grade": "grade-film-desat" }   // OPTIONAL design-system slot hints
  },
  "editorial_defaults": {               // → pre-fill INTENT answers (overridable by the human)
    "video_type":        "social-short",
    "target_platform":   "tiktok",
    "tone":              "energetic, punchy, direct",
    "music_vo":          "music bed under voiceover, burned captions",
    "caption_animation": "pop",
    "pacing":            "fast",
    "transition_lean":   "punchy cuts, occasional whip/zoom",
    "speed":             "light",
    "layout":            "split"
  }
}
```

### The two resolution paths

- **`look`** → resolves INTO `target.design` + the `--vob-*` tokens. The effective look
  (`effectiveLook(profile, state)`) takes the active video-type's `design_default` and
  merges the profile's `look` *over* it (palette/typography one level deep, scalars
  replace), so a **partial** profile still produces a complete token set. Precedence
  (most → least specific): **per-project `target.design` override > active design profile
  > video-type preset `design_default` > engine default.** The base video-type is the
  profile's own declared `editorial_defaults.video_type` when present (its intended
  format), else the resolved active type, else `general`.
- **`editorial_defaults`** → pre-fill INTENT answers. `intentPrefill(profile)` remaps the
  friendly names to the canonical intent keys via the single bridge
  `EDITORIAL_DEFAULT_KEYS`:

  | profile key | canonical intent key |
  |---|---|
  | `video_type` | `video_type` |
  | `target_platform` | `target_platform` |
  | `tone` | `tone` |
  | `music_vo` | `music_vo` |
  | `caption_animation` | `caption_animation_intent` |
  | `pacing` | `pacing_intent` |
  | `transition_lean` | `transition_intent` |
  | `speed` | `speed_intent` |
  | `layout` | `layout_intent` |

  These feed the v3.7 INTENT clarifying-question resolver as a new pre-answer source.
  Precedence: **explicit human answer > profile default > existing derivation / ask.**

### Active-profile precedence

`resolveActiveDesignProfile(state)` → `{ name, source, profile }` is the ONE precedence
chain (mirroring `resolveActiveVideoType`):

1. **`VOB_DESIGN_PROFILE`** env var → `source: "env"` (per-process override).
2. recorded `design_profile` **intent answer** → `source: "intent"` (the human's explicit
   INTENT choice).
3. `state.design_profile.name` → `source: "init"` (the init-time `{design_profile}` stamp
   — the `--like` successor; a profile NAMED at `vob_init_project` resolves before INTENT
   records anything, and an explicit INTENT answer still wins over it, matching "explicit
   human answer > profile default").
4. none → `source: "none"` (fall through to the video-type `design_default`, unchanged).

Unknown name at any tier **falls through to the next, never errors** (identical to an
unrecognized `video_type`).

### Intent-key carve-out (HARD RULE)

A profile may default the **stylistic** keys (`target_platform`, `tone`, `music_vo`, and
the optional keys `video_type`, `speed`, `layout`, `caption_animation`/`pacing`/
`transition_lean`) — but **NEVER `key_moments`** (content-specific) and **NEVER
`target_duration`** (content/campaign-specific). This inherits the exact rule `--like`
already enforced. The carve-out is structural, not a runtime check: `key_moments` and
`target_duration` are simply **absent from `EDITORIAL_DEFAULT_KEYS`**, so even a
hand-authored profile that tries to set them has those keys stripped at normalization
(`normalizeEditorialDefaults`) and they never reach `intentPrefill`. Nothing here gates;
the five required-intent-key contract is untouched.

## The engine module — `mcp/lib/design-profiles.js`

Mirrors `video-types.js` structurally. Read-once-per-process, `.vob-config/`-merge,
loose + fail-safe everywhere (like `target.design` — a bad token is dropped, never
rejects). Exports:

- `resolveActiveDesignProfile(state)` → `{ name, source, profile }` — the precedence chain.
- `summarizeActiveDesignProfile(state)` — lean per-project digest for `read_state_summary`
  + the storyboarder/composer spawns (name + resolved `effectiveLook` digest + which
  editorial defaults are set + the `intent_prefill`).
- `canonicalizeDesignProfile(raw)` → `{ raw, name }` — for `record_intent_answer`
  (an unrecognized name stores `name:null` so the resolver falls through, mirroring
  `canonicalizeVideoType`).
- `effectiveLook(profile, state)` — video-type `design_default` with the profile's `look`
  merged over it.
- `intentPrefill(profile)` — `editorial_defaults` remapped onto the canonical intent keys.
- `describeDesignProfiles()` — built-in + user names + per-profile digests, for
  `vob_doctor` (`report.design_profiles`).
- `getDesignProfile(name)`, `normalizeProfile(raw)`, `profilesDir()`, `invalidateCache()`,
  `_reloadForTests`, `BUILT_IN_DESIGN_PROFILES`, `EDITORIAL_DEFAULT_KEYS`.

**Built-in starter profiles (5)**, seeded from the per-video-type `design_default`s
already in `video-types.js`, spanning distinct aesthetics:

- **`bold-social`** — punchy vertical social (black canvas, Anton headlines, red/yellow
  accents, fast snap motion, bold kinetic captions).
- **`clean-corporate`** — clean explainer (near-black ground, Hanken Grotesk headlines,
  calm blue accent, soft motion, clean-pill captions).
- **`cinematic-gold`** — warm cinematic film (true black, Playfair Display titles, antique-
  gold accent, slow motion, desaturated grade).
- **`warm-podcast`** — warm conversational talk (soft dark ground, violet accent, medium
  motion, warm grade, split-friendly layout).
- **`mono-editorial`** — stark monochrome editorial (near-black ground, Archivo Black
  headlines, near-white accent + red highlight, dramatic mono grade).

**User profiles** load from `.vob-config/design-profiles/*.json` (one per file;
read-once-per-process; absent/malformed/unnamed/dot/underscore files skipped silently).
A user profile whose `name` matches a built-in **merges over it** (same forgiveness as
`mergePreset`). `VOB_DESIGN_PROFILES_DIR` overrides the directory.

## The tool — `vob_save_design_profile`

Self-describing frozen module `mcp/lib/tools/save-design-profile.js` with the full
metadata block (`role_bundles: ["orchestrator"]`, `mutating: true`,
`network_access: false`, `session_artifacts_written: []`, …):

`vob_save_design_profile { name, description?, version?, look?, editorial_defaults?, overwrite? }`

Writes a normalized profile JSON **atomically** (`writeFileAtomic`) into
`.vob-config/design-profiles/<name>.json` (the install-root config dir, NOT a session dir
— so it touches no FSM state and is unaffected by the session write-guards), then calls
`invalidateCache()` so the profile resolves immediately in the long-lived MCP server.
Validation is **fail-safe** (bad tokens dropped, carve-out keys stripped); the ONLY hard
error is an unusable name (`INVALID_ARGUMENTS` — a file can't be written without a kebab
slug) or an existing profile when `overwrite:false` (`STATE_CONFLICT`; default is
overwrite). Returns `{ saved, name, path, existed, profile, intent_prefill }`.

Used by the orchestrator's guided authoring flow; also callable directly. Hand-authoring
is just dropping a JSON in the config dir (template: `.vob-config/design-profile.example.json`).

**Registration** (kept in sync by hand; the boot guard `verifyAdapterToolReferences`
exits 1 otherwise): `mcp/lib/tools/index.js` `TOOL_MODULES`; its `role_bundles`; the
claude-code `SKILL.md` `allowed-tools` + `settings.json` `permissions.allow`; the OpenCode
frontmatter tool keys (`vob_vob_save_design_profile`).

## The `--like` migration

| `--like` (removed) | design profiles (new) |
|---|---|
| `vob_init_project { derived_from }` (a prior project_id) | `vob_init_project { design_profile }` (a profile NAME) |
| `state.style = {derived_from, applied_at}` | `state.design_profile = {name, applied_at}` (omitted when none; rides through transitions via `...state`) |
| orchestrator cross-project read of source `intent.answers` + `brief.md` + `compose/` | **removed** — the named profile is self-contained; no cross-project read |
| up-front `NOT_FOUND` when the source project is missing (before create) | unknown name → project still **created**, a `warning` returned (fail-safe; never leaves a bad state) |
| `read_state_summary` surfaced `state.style` | `read_state_summary.design_profile = summarizeActiveDesignProfile(state)` |
| `vob_package_output` manifest/README lineage named `derived_from` ("Styled after: X") | manifest/README lineage names the **profile** ("Design profile: X"; the Aspect-variants re-frame note points at "the same design profile") |
| preserved "never `key_moments`" rule | preserved + extended to "never `target_duration`" (the carve-out above) |

`state.design_profile` is **advisory** — no gate reads it. Cross-project *reads* stay
unblocked by the write-guards (unchanged).

## Orchestrator / skill wiring (both adapters)

- **INTENT** — `design_profile` is recorded as an OPTIONAL intent key (recordable, never
  required, never gates — exactly like `video_type`); `record_intent_answer` canonicalizes
  it via `canonicalizeDesignProfile`. Its `editorial_defaults` feed the v3.7 clarifying-
  question resolver as a pre-answer source. A guided **authoring flow** asks palette / font
  / vibe / tone / captions / music and calls `vob_save_design_profile`, offering "start from
  → [blank | a starter profile | an existing project's resolved look]" (the last is the
  graceful successor to `--like`'s one genuinely useful capability, now captured as a
  durable named profile).
- **PLAN** — the storyboarder spawn threads `summarizeActiveDesignProfile` so it mirrors
  the resolved `look` into `target.design`.
- **COMPOSE** — the composer spawn gets the resolved `--vob-*` tokens (the design-system
  kit already consumes them; no new rendering components).
- **`read_state_summary`** — surfaces the active profile, mirroring `video_type`.
- **`vob_doctor`** — `report.design_profiles` (built-in + user + env override; with
  `project_id`, the project's resolved active profile under `report.design_profiles.project`).

## Invariants honored

- **Advisory / fail-safe everywhere** — no new FSM edge, no new gate, no new/renamed
  required intent key. Unknown profile / bad token never errors.
- **`.vob-config/` pattern** — read-once-per-process, merge over built-ins, absent →
  defaults silently; `VOB_DESIGN_PROFILES_DIR` override mirrors `VOB_VIDEO_TYPES_FILE`;
  resolution surfaced in `vob_doctor`.
- **Dual-adapter parity** — claude-code is the source; `port-adapter-docs.js` regenerates
  the OpenCode mirror; boot integrity green on both.
- **No Docker, latest versions, output-quality-first** — leads with the brand-identity
  payoff, not eng hygiene.

## Out of scope for v1

- Binary assets (logo / watermark / intro-outro stinger / custom font files / LUTs) —
  tokens / JSON only. (Natural v2: profiles gain a directory + asset injection into
  `compose/`.)
- Profile inheritance chains / composition between profiles.
- A profile marketplace / remote fetch.
