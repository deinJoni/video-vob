# v0.3.10 — Design Profiles (named, reusable style bundles; replaces `--like`)

A project's "look" — palette, typography, caption look, motion feel, grade, plus the
house editorial defaults a brand reuses (tone, platform, music/VO treatment, caption
animation, pacing) — was **smeared across four mechanisms** (`target.design`, the
`--vob-*` tokens / design-system kit, the per-video-type `design_default`, and `--like`)
with no reusable home. `--like` pointed a new project at a *prior project_id* and
**re-derived its look every time** via a cross-project read; it was never something you
could name and reuse. v0.3.10 unifies all of it under a **first-class named store**:
author a profile once, apply it to any future project **by name**. Additive, advisory,
fail-safe — no new FSM edge, no new gate, no new/renamed required intent key. (0.3.9 →
0.3.10) Full spec: `docs/design-profiles/PRD.md`.

## The engine module — `mcp/lib/design-profiles.js`

Mirrors `video-types.js` structurally; read-once-per-process; loose + fail-safe
everywhere (like `target.design` — a bad token is dropped, never rejects). Orthogonal to
the video-type preset: a preset says *what kind of video* (editorial rules); a profile
says *what my brand looks like + my house editorial defaults*. The same profile renders
as a social-short OR a cinematic long-form because the look is expressed as portable
`--vob-*` tokens.

- **`resolveActiveDesignProfile(state)`** → `{ name, source, profile }` — the ONE
  precedence chain (mirrors `resolveActiveVideoType`): `VOB_DESIGN_PROFILE` env >
  recorded `design_profile` intent answer > `state.design_profile.name` init stamp >
  none. Unknown name at any tier **falls through, never errors**.
- **Two resolution paths** — `look` → `target.design` + `--vob-*` tokens
  (`effectiveLook` merges the profile's `look` over the active video-type's
  `design_default`, so a partial profile still produces a complete token set; precedence
  per-project `target.design` > active profile > preset `design_default` > engine
  default). `editorial_defaults` → pre-fill INTENT answers (`intentPrefill` remaps the
  friendly names onto the canonical intent keys via `EDITORIAL_DEFAULT_KEYS`:
  `caption_animation`→`caption_animation_intent`, `pacing`→`pacing_intent`,
  `transition_lean`→`transition_intent`, `speed`→`speed_intent`, `layout`→`layout_intent`;
  the rest pass through), feeding the v3.7 clarifying-question resolver as a pre-answer
  source (precedence: explicit human answer > profile default > derivation / ask).
- **The intent-key carve-out (HARD RULE)** — a profile may default the stylistic keys but
  **NEVER `key_moments`** (content-specific) and **NEVER `target_duration`**
  (content/campaign-specific). Structural, not a runtime check: both are absent from
  `EDITORIAL_DEFAULT_KEYS`, so even a hand-authored profile that sets them has them
  stripped at normalization and they never reach `intentPrefill`. Inherits the exact rule
  `--like` enforced; the five required-intent-key contract is untouched.
- **Other exports** — `summarizeActiveDesignProfile` (lean per-project digest for
  `read_state_summary` + spawns), `canonicalizeDesignProfile` (for `record_intent_answer`;
  unknown → `name:null`), `describeDesignProfiles` (for `vob_doctor`), `getDesignProfile`,
  `normalizeProfile`, `profilesDir`, `invalidateCache`, `_reloadForTests`,
  `BUILT_IN_DESIGN_PROFILES`, `EDITORIAL_DEFAULT_KEYS`.

## The 5 built-in starter profiles

Seeded from the per-video-type `design_default`s already in `video-types.js`, spanning
distinct aesthetics: **`bold-social`** (punchy vertical social), **`clean-corporate`**
(clean explainer), **`cinematic-gold`** (warm cinematic film), **`warm-podcast`** (warm
conversational talk), **`mono-editorial`** (stark monochrome editorial). User profiles
layer on from `.vob-config/design-profiles/*.json` (one per file; absent/malformed/dot/
underscore files skipped silently; a same-named user profile merges over a built-in).

## The tool — `vob_save_design_profile`

`vob_save_design_profile { name, description?, version?, look?, editorial_defaults?,
overwrite? }` (`mcp/lib/tools/save-design-profile.js`, `role_bundles: ["orchestrator"]`,
`mutating:true`) writes a normalized profile JSON **atomically** into
`.vob-config/design-profiles/<name>.json` (the install-root config dir, NOT a session dir
— touches no FSM state, unaffected by the write-guards) and `invalidateCache()`s so it
resolves immediately. Fail-safe: bad tokens dropped, carve-out keys stripped; the only
hard error is an unusable name (`INVALID_ARGUMENTS`) or an existing profile under
`overwrite:false` (`STATE_CONFLICT`; default overwrites). Returns `{ saved, name, path,
existed, profile, intent_prefill }`. Used by the guided authoring flow; also callable
directly. Hand-authoring is just dropping a JSON (template:
`.vob-config/design-profile.example.json`).

## The `--like` migration

- `vob_init_project { derived_from }` (a project_id) → **`{ design_profile }`** (a profile
  NAME). Unknown name → the project is still **created** with a `warning` returned (NOT the
  old up-front `NOT_FOUND`; a profile is self-contained, so there's no bad state to leave).
- `state.style = {derived_from, applied_at}` → **`state.design_profile = {name, applied_at}`**
  (omitted when none; rides through transitions via `...state`; advisory — no gate reads it).
- The orchestrator's **cross-project read** (source `intent.answers` + `brief.md` +
  `compose/`) is **removed** — the named profile is self-contained.
- `read_state_summary.design_profile` = `summarizeActiveDesignProfile(state)`.
- `vob_package_output` manifest/README lineage names the **profile** ("Design profile: X")
  instead of `derived_from`; the Aspect-variants faithful-re-frame note now points at
  "create a separate project with the same design profile".

## Wiring (both adapters)

- **INTENT** — `design_profile` recorded as an OPTIONAL intent key (recordable, never
  required, never gates — like `video_type`; canonicalized via `canonicalizeDesignProfile`);
  a guided **authoring flow** (palette / font / vibe / tone / captions / music →
  `vob_save_design_profile`) offering "start from → [blank | a starter profile | an existing
  project's resolved look]" (the durable successor to `--like`'s one useful capability).
- **PLAN** — the storyboarder spawn threads `summarizeActiveDesignProfile` (mirror the look
  into `target.design`).
- **COMPOSE** — the composer spawn gets the resolved `--vob-*` tokens (the design-system kit
  already consumes them; no new rendering components in v1).
- **`vob_doctor`** — `report.design_profiles` (built-in + user + env override; with
  `project_id`, the project's resolved active profile).

## Knobs

- **`VOB_DESIGN_PROFILE`** — per-process active-profile override (top of the precedence chain).
- **`VOB_DESIGN_PROFILES_DIR`** — override the `.vob-config/design-profiles/` directory
  (tests/installs; mirrors `VOB_VIDEO_TYPES_FILE`).

## Testing / tooling

- **Walker `designprofile` phase** (`node scripts/m5-walker.js designprofile`) — a
  source-free model-free harness (like `editorial` / `spans` / `visualqc`): resolution
  precedence (none < init-stamp < recorded-intent-answer < env), the intent-key carve-out
  (`intent_prefill` never carries `key_moments` / `target_duration` even if a profile JSON
  sets them), the `vob_save_design_profile` save/load round-trip, fail-safe on an unknown
  name (`source:"none"`, never throws) and a bad token (dropped, save still succeeds), and
  the `--like` migration (`initProject({design_profile})` stamps `state.design_profile`,
  the summary surfaces it, an unknown name → created with a `warning`). Runs in an isolated
  `VOB_DESIGN_PROFILES_DIR` + HOME so it pollutes nothing.
- **Boot integrity green on both adapters** (`registry-integrity.js`,
  `verifyAdapterToolReferences`).
- **Dual-adapter parity** — claude-code source → `port-adapter-docs.js` regenerates the
  OpenCode mirror.

## Out of scope for v1

Binary assets (logo / watermark / stinger / custom fonts / LUTs — tokens/JSON only; the
natural v2 is a profile directory + asset injection into `compose/`); profile inheritance
chains; a profile marketplace / remote fetch.

## Files

`mcp/lib/design-profiles.js` (new module), `mcp/lib/tools/save-design-profile.js` (new
tool) + its registration in `mcp/lib/tools/index.js`, `mcp/lib/session-state.js`
(`design_profile` init stamp + `read_state_summary` surface, replacing `state.style`),
`mcp/lib/tools/init-project.js` (`design_profile` arg, replacing `derived_from`),
`mcp/lib/tools/doctor.js` (`report.design_profiles`),
`mcp/lib/tools/package-output.js` + `mcp/lib/package-readme.js` (profile lineage), the
record-intent canonicalization, both adapters' SKILL/agent/phase docs (+
`port-adapter-docs.js`), `.vob-config/design-profile.example.json`,
`scripts/m5-walker.js` (`designprofile` phase + the stale `--like` README assertion), and
the `0.3.10` version bump (`.vob/VERSION`, `package.json`, `mcp/server.js`).
