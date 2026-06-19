# Build Prompt — Design Profiles (named, reusable full-output style profiles; replaces `--like`)

> Paste everything below the line into a fresh loop. It is self-contained — it assumes no prior conversation.

---

## Mission

Build **design profiles**: named, stored, reusable bundles that capture *how a project's output should look and feel* — both the visual identity (palette, typography, captions, motion, grade) **and** a set of editorial defaults (tone, platform, music/VO treatment, caption animation, pacing, etc.). A user authors a profile once and applies it to any future project **by name**, so every output shares the same identity without re-deriving it.

This feature **replaces `--like`** (the `derived_from` lineage mechanism). `--like` pointed a new project at a *prior project_id* and re-derived its look every time; design profiles are a first-class, self-contained, named store instead.

This is the planned successor to `--like` (the codebase already anticipated "named style profiles"). Read `CLAUDE.md` end-to-end before starting — especially the invariants on `--like` / style inheritance, video-type presets, `target.design`, the `.vob-config/` per-machine config pattern, the design-system kit, and the dual-adapter contract.

## Read these first (the existing surface this slots into)

The "look" is currently smeared across four mechanisms. Your job is to unify them under a named store, **without** reimplementing the rendering:

1. **`mcp/lib/video-types.js`** — **THE structural template to mirror.** Study `mergePreset`, `resolveActiveVideoType` (the env > recorded-answer > derivation > default precedence chain), `summarizeActiveVideoType`, built-in presets + user presets from `.vob-config/video-types.json` (shallow-merged), and `VOB_VIDEO_TYPES_FILE`. Each preset carries a `design_default` (palette/typography deep-merged one level) — **these are your starter profiles' seed material.** Your new module should look and feel like this one.
2. **`mcp/lib/storyboard-schema.js`** — `target.design{palette,typography,caption_style,motion,grade}`: the per-project look contract, loosely shape-checked, **never lints**, fail-safe. A profile's `look` block resolves *into* this.
3. **The `--vob-*` CSS tokens + design-system kit** (`mcp/assets/design-system/`, `build-design-system.js`, `injectDesignKit` in `source-symlink.js`) — token-driven components the composer renders from. A profile's `look` is primarily a **token set**, so it drives the existing kit; **no new rendering components in v1.**
4. **`--like`** — `mcp/lib/session-state.js` (`buildInitialSessionState` / `initProject`, `state.style = {derived_from, applied_at}`), `mcp/lib/tools/init-project.js` (`derived_from` arg), and the orchestrator's cross-project read + `vob_package_output` lineage. **This is what you are replacing** — see the migration section.

Also read, for the integration points: `mcp/lib/host-profile.js` (the read-once `.vob-config/` resolver pattern, precedence `VOB_* env > host.json key > tier > default`), `mcp/lib/paths.js` (install-root / `.vob-config/` location), `mcp/lib/tool-registry.js` (`defineTool` metadata validation + `VALID_ROLE_BUNDLES`), `mcp/lib/registry-integrity.js` (`verifyAdapterToolReferences` boot guard), `mcp/lib/tools/read-state-summary.js` (how `video_type` is surfaced), and the v3.7 INTENT clarifying-question framework in the claude-code phase docs.

## The model: a design profile is orthogonal to the video-type preset

- **Video-type preset** = *what kind of video* → editorial **rules**, lint ruleset, render segmentation, overlay/transition vocabulary, platform default. (How the engine processes/validates.)
- **Design profile** = *what does MY brand look like + my house editorial defaults* → look tokens + pre-filled intent answers. (Reusable across formats.)

The same brand should render as a social-short **or** a cinematic long-form — so a profile expresses its look as **portable tokens** (every kit component reads `--vob-*`), and may *select* a `video_type` as one of its editorial defaults. Keep the two axes orthogonal.

## Profile schema (two blocks, two resolution paths)

```jsonc
{
  "name": "acme-brand",                 // kebab-case, unique
  "description": "...",                 // one line
  "version": 1,
  "look": {                             // → resolves INTO target.design + --vob-* tokens
    "palette":      { /* bg, fg, accent, accent_2, ... → --vob-* */ },
    "typography":   { /* kit families by name, weights, scale */ },
    "caption_style":{ /* default caption look */ },
    "motion":       { /* punch-in / transition lean / pacing feel */ },
    "grade":        { /* color grade tokens */ },
    "slots":        { /* OPTIONAL per-slot design-system component hints */ }
  },
  "editorial_defaults": {               // → pre-fill INTENT answers (overridable by the human)
    "video_type":        "...",         // may select the format
    "target_platform":   "...",
    "tone":              "...",
    "music_vo":          "...",
    "caption_animation": "...",
    "pacing":            "...",
    "transition_lean":   "...",
    "speed":             "...",
    "layout":            "..."
  }
}
```

Both blocks are **optional and partial** — a profile may carry only `look`, only some keys, etc.

### Resolution & precedence

- **`look`** → into `target.design` + the `--vob-*` tokens. Precedence (most→least specific): per-project `target.design` override > **active design profile** > video-type preset `design_default` > engine default.
- **`editorial_defaults`** → pre-fill INTENT answers. Precedence: explicit human answer > **profile default** > existing derivation / ask. These feed the **v3.7 INTENT clarifying-question resolver** as a new resolution source (a profile pre-answers questions before the orchestrator asks).
- **Active-profile precedence** (new `resolveActiveDesignProfile(state)`, mirror `resolveActiveVideoType`): `VOB_DESIGN_PROFILE` env > recorded `design_profile` intent answer > none.

### Intent-key carve-out (HARD RULE)

A profile may default the **stylistic** keys — `target_platform`, `tone`, `music_vo`, and the optional keys (`video_type`, `speed`, `layout`, `caption_animation`, `transition`, `editorial`/`pacing`) — but **NEVER `key_moments`** (content-specific) and **NEVER `target_duration`** (content/campaign-specific). This inherits the exact rule `--like` already enforces. Nothing here gates; the five required-intent-key contract is untouched.

## New engine module — `mcp/lib/design-profiles.js`

Mirror `video-types.js` structurally:

- **Built-in starter profiles** (3–5), seeded from the per-video-type `design_default`s already in `video-types.js` (your "we already have some"). Span distinct aesthetics (e.g. punchy social, clean corporate, cinematic, warm podcast).
- **User profiles** from `.vob-config/design-profiles/*.json` (read-once-per-process; absent/malformed → silently skip, never throw). Override `VOB_DESIGN_PROFILES_DIR` (mirror `VOB_VIDEO_TYPES_FILE`).
- `resolveActiveDesignProfile(state)` — the one precedence chain above. **Unknown name → fall back to default, never an error** (identical to unknown `video_type`).
- `summarizeActiveDesignProfile(state)` — lean summary for spawns + `read_state_summary` (name + resolved look digest + which editorial defaults are set).
- Loose, fail-safe validation throughout (like `target.design` — a bad token is ignored/defaulted, never rejects).

## New tool — `vob_save_design_profile`

Self-describing frozen module `mcp/lib/tools/save-design-profile.js` with the **full metadata block** (`role_bundles`, `mutating:true`, `network_access:false`, `session_artifacts_written`, etc. — `defineTool` validates every field). Writes a validated profile JSON atomically into `.vob-config/design-profiles/<name>.json`. Used by guided authoring; also callable directly. Fail-safe validation; returns the canonicalized profile + path.

**Registration (all required, kept in sync by hand — the boot drift guard `verifyAdapterToolReferences` exits 1 otherwise):**
1. `mcp/lib/tools/index.js` → `TOOL_MODULES`.
2. Set its `role_bundles` (orchestrator-owned; subagents don't write profiles).
3. `adapters/claude-code/.claude/skills/vob/SKILL.md` → `allowed-tools`.
4. `adapters/claude-code/.claude/settings.json` → `permissions.allow`.
5. OpenCode frontmatter tool keys (referenced there as `vob_vob_save_design_profile`).

## Replace `--like` (concrete migration)

- `vob_init_project { derived_from }` → `{ design_profile }` (a profile **name**, not a project_id). Validate the name resolves up front; unknown → fall back to default (do **not** hard-error, matching the fail-safe philosophy — but `derived_from`'s old up-front NOT_FOUND-before-create behavior should be preserved in spirit: never leave a project in a bad state).
- `state.style = {derived_from, applied_at}` → `state.design_profile = {name, applied_at}` (omitted entirely when none — keep the lean baseline; rides through transitions via `...state`).
- The orchestrator's **cross-project read** (source `intent.answers` + `brief.md` + `compose/`) → **removed.** The named profile is self-contained; no cross-project read needed.
- `vob_package_output` manifest + README lineage → surface the **profile name** instead of `derived_from`.
- Preserve the "never `key_moments`" rule (now in the carve-out above).
- Grep for every reader of `state.style` / `derived_from` and migrate or remove it. Cross-project *reads* stay unblocked by the write-guards (unchanged).

## Orchestrator / skill wiring (both adapters)

- **INTENT**: record `design_profile` as a new **optional intent key** (recordable, never required, never gates — exactly like `video_type`). Its `editorial_defaults` feed the v3.7 clarifying-question resolver as a pre-answer source.
- **PLAN**: the storyboarder spawn threads `summarizeActiveDesignProfile` so it mirrors the resolved `look` into `target.design`.
- **COMPOSE**: the composer spawn gets the resolved `--vob-*` tokens (the kit already consumes them).
- **`read_state_summary`**: surface the active profile (mirror how `video_type` is surfaced).
- **Guided authoring flow** (skill-layer UX; engine stays source of truth): an orchestrator flow that asks palette / font / vibe / tone / captions / music and calls `vob_save_design_profile`. Offer **"start from → [blank | a starter profile | an existing project's resolved look]"** — the last option is the graceful successor to `--like`'s one genuinely useful capability ("make it look like that real project"), now captured as a durable named profile. **Hand-written** authoring just drops a JSON in `.vob-config/design-profiles/`; ship a `design-profile.example.json` template (mirror `host.example.json`).

## Invariants to honor

- **Fail-safe / advisory everywhere** — no new FSM edge, no new gate, no new/renamed required intent key. Unknown profile / bad token never errors.
- **`.vob-config/` pattern** — read-once-per-process, merge over built-ins, absent → defaults silently. Surface effective resolution in `vob_doctor` (like `video_types`).
- **Dual-adapter parity** — make claude-code the source, then run `node scripts/port-adapter-docs.js` to regenerate the OpenCode phase/reference/agent docs. Keep boot integrity green on both.
- **No Docker. Latest versions** (never pin/downgrade). **Prioritize output quality** over eng hygiene — lead with the creative/identity payoff.
- **Commit isolation** — if other loops are editing this tree concurrently, commit ONLY files containing this feature's content via explicit paths (never `git add -A`); leave unrelated standalone files alone.

## Verification

- Add a **source-free walker phase** `designprofile` to `scripts/m5-walker.js` (model-free harness, like `editorial` / `spans` / `visualqc`): exercises resolution precedence, the intent-key carve-out, save/load round-trip, fail-safe on unknown name / bad token, and the `--like` migration path. Run it green.
- **Boot integrity green on both adapters** (`registry-integrity.js`, `verifyAdapterToolReferences`).
- Run the existing relevant walker phases to confirm no regression (`setup`, `general`).
- Commission an adversarial code review and fix findings.

## Versioning & docs

- Bump the version-of-record per the alpha scheme (`grep` the current `0.3.9` — `package.json` + the other version-of-record files; see the versioning convention in `CLAUDE.md` / project memory) to **`0.3.10`**.
- Write `docs/design-profiles/PRD.md` + `docs/design-profiles/CHANGELOG.md`. Add a "design profiles" invariant bullet to `CLAUDE.md`.

## Out of scope for v1 (do NOT build)

- Binary assets (logo / watermark / intro-outro stinger / custom font files / LUTs) — tokens/JSON only. (Natural v2: profiles gain a directory + asset injection into `compose/`.)
- Profile inheritance chains / composition between profiles.
- A profile marketplace / remote fetch.
