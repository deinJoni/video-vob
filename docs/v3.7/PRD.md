# v3.7 PRD — Mode-Aware Clarifying-Question Framework for INTENT

> Status: BUILD-READY. Scope LOCKED to Slices 0–2 (the questionnaire framework over existing intent keys + 5 new user-steerable optional knobs). Slice 4 is explicitly DEFERRED. No FSM phase, no gate, no required-key change. Every implementation claim is grounded in the verified touch-points (file + line, against the working tree at HEAD); where verification contradicted the brainstorm, the verification wins and the corrected fact is stated inline.

---

## 1. Summary & scope

**What/why.** The engine already carries a large, fully-implemented creative-knob surface (per-clip speed, caption animation, scene transitions, split-screen layout, subject compositing, fan-out, chapters), but most of it is **storyboarder-inferred only** — the human has no forward-looking say, and the v3.x plan-lints surface these as *post-hoc warnings at the PLAN gate*. v3.7 turns intake into a **fixed, mode-aware clarifying-question framework** layered onto the existing INTENT phase: a known catalog of questions per video-type mode, each auto-resolved from the rough idea + INSPECT signal, each shipping a mode-smart *(recommended)* default, only genuine unknowns surfaced (smart triage into ~4–5 `AskUserQuestion` cards), and everything recapped at the single PLAN sign-off. The decisions move **before** the storyboarder runs.

**Locked scope (IN).**
- **Slice 0 — the framework over existing keys (zero engine risk).** A new `references/clarifying-questions.md` catalog; an INTENT.md rewrite (the resolve-from-prompt-else-ask 5-pass loop + `AskUserQuestion` grouping); a PLAN.md recap line. Uses ONLY the existing 5 required + 2 conditional + 5 optional keys. No engine change.
- **Slice 1 — 2 new optional keys (low risk):** `editorial_intent` (snap-to-clean-spans) + `caption_animation_intent`.
- **Slice 2 — 3 new optional keys (low risk):** `transition_intent`, `layout_intent`, `speed_intent`.

**Deferred (Slice 4 — explicitly OUT of v3.7).** Do not implement, do not advertise as steerable:
- **Filler-word aggressiveness** (`removeDiscourseFillers` is hard-`false`, computed in INSPECT *before* INTENT — needs an INSPECT options thread + a PLAN→INSPECT re-run).
- **Explicit fan-out N** (no home for a count; `target_duration` only carries `per_deliverable:true`).
- **Multi-aspect fan-out** (no per-short `target_platform`/aspect field; all shorts inherit one project geometry — **unbuildable today**).
- **Single-timeline music ducking** (assembly-path only via `vob_assemble_video` sidechain; single-composition ducking is composer-prose, not guaranteed).
- **Custom loudness target** (only on/off exists via `VOB_NO_LOUDNORM`; no custom-LUFS field).

**Frozen (do not touch).**
- The **5 required keys** (`target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`) — not renamed, no 6th added.
- **No new FSM phase, no new gate, no new transition edge.** Optional keys never appear in `missing_required_keys` (`missingIntentKeys` iterates only REQUIRED + applicable CONDITIONAL — `intent-schema.js:114–128`).
- Aspect ratio and fps stay pure consequences of `target_platform` (+ cinematic 24fps) — never independent questions; silently defaulted, recapped once at PLAN.

---

## 2. The new intent keys

Five new OPTIONAL keys (Slices 1–2). All are **free-text** (no server canonicalization — they fall through `canonicalizeAnswer`, `record-intent-answer.js:80`, as the trimmed string), all **never gate**, and the consumer strength varies sharply. **Be honest about advisory vs. binding** — this is the load-bearing correction over the brainstorm, which mislabeled the two weakest keys as "highest-leverage."

| Key | Slice | Accepted values | Downstream consumer (storyboard field) | Consumer strength | Engine teeth |
|---|---|---|---|---|---|
| `editorial_intent` | 1 | free-text (`snap` / `tighten` / `keep natural` / prose) | **No storyboard field.** Pure storyboarder behavior: snap `a_roll` cuts to `clean_speech` keep-spans, or not. | **WEAKEST — advisory-only.** No materialization, no QC binding. The key changes ONLY the storyboarder's snap *choice* in prose. | None directly. The `PLAN_CLIP_STRADDLES_REMOVED_SPAN` WARNING (`storyboard-schema.js:2065`, threshold `straddle_removed_min_s=0.8`, `:1338`) is driven by `clean_speech.json` + the preset `editorial.clean_cut` flag, and **never reads `editorial_intent`** — the straddle WARNING fires identically regardless of the key's value. Gated by preset `editorial.clean_cut` (cinematic = off). |
| `caption_animation_intent` | 1 | free-text (`pop` / `word-by-word` / `karaoke`); **`static`/`none` ⇒ omit `animation`** (chunk shown, no motion — there is NO `static` token, see below) | `caption_segments[].animation` (validated set is EXACTLY `pop` \| `word-by-word` \| `karaoke` — `storyboard-schema.js:47`) | **Advisory-only.** Captions are deliberately advisory at COMPOSE-QC (no `data-vob-overlay-id` hard binding). Composer MAY honor. | WARNING `PLAN_CAPTION_KARAOKE_UNALIGNED` (`storyboard-schema.js:1902`) only. **CORRECTION:** the engine does NOT downgrade word-level→pop; the *composer/storyboarder* downgrade, the engine only warns. |
| `speed_intent` | 2 | free-text (`light ~1.25×` / `aggressive` / `natural` / `slo-mo`) | `source_clips[].speed` | **STRONGEST — HARD materialization.** Speed is baked by `ffmpeg-runner.js::buildClipCutArgv` (`setpts`/`atempo`, `:144`/`:165`), invoked from `clip-materialize.js` at COMPOSE entry (cache-keyed on speed). On-screen duration genuinely becomes `(out−in)/speed`. | Drives `PLAN_DURATION_INFEASIBLE` (lint). The single most reliably-honored new key. |
| `transition_intent` | 2 | free-text (`punchy/whip/zoom` / `gentle dissolves` / `hard cuts` / `dip at seams`) | `scene.transition_in` (chosen from the active preset `transition_vocabulary`; loose/fail-safe) | **STRUCTURAL + advisory.** Real structural consumer = render-plan glue packing (`isGlueTransition` forces a glue group into one composition; `deriveRenderPlan` packs glue groups). Visual realization is composer CSS, advisory at QC. | `PLAN_TRANSITION_UNKNOWN_TYPE` / `TOO_LONG` / `INCONSISTENT` / `BUDGET` / `DOWNGRADED` (all warnings). |
| `layout_intent` | 2 | free-text (`none` / `split` / `pip` / `2×2 grid`) | `scene.layout` (`LAYOUT_TYPES` = `split_horizontal`/`split_vertical`/`grid_2x2`/`pip` — `storyboard-schema.js:77`) | **HARD materialization.** `layout-materialize.js::materializeSceneLayouts` pre-composites cells into ONE clip at COMPOSE entry; degrades-never-throws → CSS-cell fallback; advisory at QC. | `PLAN_LAYOUT_INVALID` / `UNKNOWN_TYPE` / `CELL_OUT_OF_RANGE` / `CELL_COUNT` (warnings). |

**CORRECTION to the brainstorm (irony to surface, not bury):** the two Slice-1 keys (`editorial_intent`, `caption_animation_intent`) are the **two weakest consumers** (advisory-only, no materialization, no QC binding). The genuinely hard-materialized keys are `speed_intent` and `layout_intent` (Slice 2). "Leverage" in the brainstorm meant breadth-of-use, not enforcement strength — the PRD must not imply the Slice-1 keys are reliably honored. Slice 1 ships first because it is the cheapest and unblocks the most common asks; the most-reliably-honored steering lands in Slice 2.

**`static`/`none` for `caption_animation_intent` has no schema token — it maps to OMITTING `animation`.** The validated set is exactly `pop | word-by-word | karaoke` (`CAPTION_ANIMATIONS`, `storyboard-schema.js:47`); there is no `static`/`none` animation value. When the user wants captions present but unanimated, the storyboarder authors the `caption_segments[]` WITHOUT an `animation` field (chunk shown, no motion). The catalog must offer "static / none" as a label that resolves to *omit the field*, never a literal value — wiring a `"static"` string would fail the `CAPTION_ANIMATION_SET` check (`:360`). "No captions at all" is a separate decision governed by `captions_style` applicability, not this key.

**All five remain advisory to the storyboarder** in the sense that "user-steerable" = "the storyboarder/composer *may* honor it." None gain hard enforcement unless an optional Slice-3-style plan-lint reads `ctx.state.intent.answers.<key>` (see §9). Do not claim hard enforcement.

---

## 3. Engine changes — the recipe, applied

**CORRECTION to the brainstorm's "3-spot edit."** It is NOT three engine spots. `record-intent-answer.js:131` is `enum: [...ALL_INTENT_KEYS]` — a **spread** of the schema constant, not a duplicated list. Adding a key to `OPTIONAL_INTENT_KEYS` auto-updates BOTH `isValidIntentKey` AND the `record-intent-answer` inputSchema enum. The real engine surface for a free-text optional key is:

1. **ONE engine line** — add the key to `OPTIONAL_INTENT_KEYS` (`mcp/lib/intent-schema.js:48–54`), plus a doc-comment bullet (`:26–47`).
2. **ONE optional doc string** — the hand-maintained `description` literal (`record-intent-answer.js:126`). Not load-bearing for validation; stale = a doc nit the boot guard does NOT catch.
3. **The consumer plumbing** — the *real* undercount: a hand-templated spawn line + an agent `.md` behavior bullet, **× two adapters** (claude-code + OpenCode mirror), + the walker `guided` object.

### The two silent-failure asymmetries (state both)
- **Engine half fails LOUD:** if the skill is taught to record a key NOT in `OPTIONAL_INTENT_KEYS`, the inputSchema enum (validated by `tool-validation.js::validateEnum`, `:34–36`, run in `dispatch.js` *before* the handler) rejects it `INVALID_ARGUMENTS` — "the skill asked but nothing stuck." Land the `OPTIONAL_INTENT_KEYS` entry FIRST.
- **Doc half fails SILENT:** if the key is in `OPTIONAL_INTENT_KEYS` but the consumer plumbing is skipped, the record SUCCEEDS, the answer rides into `state.intent.answers` and `read_state_summary` verbatim — but **no agent ever reads it**. The key is inert with no error anywhere. This is the failure to guard against per key.

### Per-key engine edits

For each of the 5 keys, in order:

| File / symbol | Edit | Note |
|---|---|---|
| `mcp/lib/intent-schema.js` — `OPTIONAL_INTENT_KEYS` (48–54) | Add the key string. Add a doc-comment bullet (26–47) naming the **real** consumer — and HONESTLY noting advisory-only keys: for `editorial_intent` say "storyboarder snap-DECISION in prose only; does NOT alter the `PLAN_CLIP_STRADDLES_REMOVED_SPAN` WARNING, which keys off `clean_speech.json` + `editorial.clean_cut`, never this key"; for `caption_animation_intent` say "composer discretion over `caption_segments[].animation` (`pop`/`word-by-word`/`karaoke`, or OMITTED for static) + `PLAN_CAPTION_KARAOKE_UNALIGNED` WARNING." | The ONLY strictly-required engine line. Auto-propagates to `isValidIntentKey`, `ALL_INTENT_KEYS`, the record-intent-answer enum, and `missingIntentKeys`-immunity. |
| `mcp/lib/tools/record-intent-answer.js` — `description` (126) | Append the new keys to the human-readable description. **No enum edit** (it's `[...ALL_INTENT_KEYS]`, `:131`). **No `canonicalizeAnswer` branch** — all five stay free-text (fall through `:80`). | Optional but recommended (tool self-description hygiene). Boot guard checks NAMES, not descriptions, so stale = uncaught drift. |
| `mcp/lib/session-state.js` — `summarizeIntentAnswers` (314–326) | **NO edit.** `const out = { ...a }` already passes free-text keys through verbatim into `summary.intent.answers`. | This is why the orchestrator can read the key from `read_state_summary` with zero engine change. |
| `mcp/lib/tool-validation.js` | **NO edit.** Mechanism, not a touch point. | The enum check physically fires here. |

**No value-level enum constraint.** None of the five are added to `validateIntentAnswerValue` (`intent-schema.js:135–143`, the `audio_treatment` pattern). They stay free-text per the OPTIONAL-key invariant. If a future slice wanted `speed_intent ∈ {slower,normal,faster}` enforced server-side, that would be a deliberate departure (open item §9) — out of scope for v3.7.

### Spawn-prompt threading (engine-adjacent, but it's adapter docs)

For EVERY new key, add one DATA-ONLY line to the storyboarder spawn block in `phases/PLAN.md` (after the existing `intent.broll_intent` line ~92), each rendering `<value | none>` from `summary.intent.answers.<key>`:

```
intent.editorial_intent: <editorial_intent | none>
intent.caption_animation_intent: <caption_animation_intent | none>
intent.speed_intent: <speed_intent | none>
intent.transition_intent: <transition_intent | none>
intent.layout_intent: <layout_intent | none>
```

**Consumer routing (open question resolved here).** All five are PLANNED in the storyboard first (captions/transitions/layouts/speed/snapping are all storyboard fields or storyboarder decisions), so **all five thread to the STORYBOARDER spawn** (`phases/PLAN.md`), NOT the composer spawn. The composer realizes `caption_animation_intent`/`transition_intent`/`layout_intent` *downstream* by reading the storyboard the storyboarder already authored — no new COMPOSE-phase spawn line is required. (The composer already reads `caption_segments[].animation`, `scene.transition_in`, `scene.layout` from `storyboard.json`.) This keeps the v3.7 spawn edits confined to PLAN.md + storyboarder.md.

**Spawn stays DATA-ONLY** (PLAN.md hard rule, lines 65–66: "if you are tempted to add an instruction, it belongs in the agent file"). Behavioral contract goes in `storyboarder.md`.

### Storyboarder behavior (`adapters/claude-code/.claude/agents/storyboarder.md`)

Add one "Your inputs" bullet per new key (after the existing `pacing_intent`/`hook_intent`/`broll_intent` bullets ~lines 22–24), each stating that when `intent.<key>` is not `none` it is the USER's explicit choice and **overrides** the tone/preset-derived default, pointing at the existing field-doc section the agent already has:

- `editorial_intent` → overrides the `clean_cut`-derived snapping decision (existing keep-span snapping doc ~290–296). **Precedence rule (resolve the open question):** if the preset has `editorial.clean_cut=false` (cinematic) and the user explicitly asks to tighten/snap, the storyboarder **surfaces it as a conflict in the brief** rather than silently snapping or silently ignoring — the human resolves at PLAN sign-off. Do not auto-override `clean_cut=false`. **Honesty note for the bullet:** changing this key changes only the storyboarder's *choice* of where to cut; it does NOT change the `PLAN_CLIP_STRADDLES_REMOVED_SPAN` warning's behavior (that warning fires whenever a kept clip straddles a removed span by ≥0.8s, regardless of intent).
- `caption_animation_intent` → sets `caption_segments[].animation`, choosing from `pop`/`word-by-word`/`karaoke` (existing doc ~130), or OMITTING `animation` entirely when the user asks for static/no-motion captions (there is no `static` token — never write `animation:"static"`). Keep the `transcript_aligned` hard-gate: word-level (`karaoke`/`word-by-word`) only when `transcript_aligned===true`; otherwise downgrade to chunk `pop`. The storyboarder/composer perform this downgrade; the engine only warns (`PLAN_CAPTION_KARAOKE_UNALIGNED`).
- `speed_intent` → biases `source_clips[].speed` (existing doc ~225–236; the bake is `ffmpeg-runner.js::buildClipCutArgv`, orchestrated by `clip-materialize.js` at COMPOSE entry).
- `transition_intent` → biases `scene.transition_in` from the threaded `transition_vocabulary` (existing doc ~131).
- `layout_intent` → enables `scene.layout` (existing doc ~238–248), gated on INSPECT having ≥2 angles. **Disambiguate `pip`:** `layout_intent:pip` → `scene.layout{type:"pip"}` (the multi-cell layout composite materialized by `layout-materialize.js`), NOT an `overlay` `type:"pip"` and NOT a `broll_placements[].render_mode:"pip"` — three distinct `pip` concepts exist (`OVERLAY_TYPES`, `LAYOUT_TYPES`, `BROLL_RENDER_MODES`), only the layout one is what this key steers.

---

## 4. Skill changes

### 4a. NEW `adapters/claude-code/.claude/skills/vob/references/clarifying-questions.md`

The canonical catalog (third reference file alongside `brief-design.md` and `lint-rules.md`). **Data shape — one row per catalog question:**

| Field | Meaning |
|---|---|
| `id` | `U1`…`U17`, `M1`…`M8` (stable id from the catalog) |
| `header` | the beat it groups into (Format / Story+moments / Look & captions / Audio / Creative knobs) |
| `question` | exact phrasing (e.g. *"Which platform / aspect is this for?"*) |
| `options[]` | the choice strings, with the per-mode default marked ★ |
| `default_per_mode` | a 6-column lookup (social-short / long-form / cinematic / tutorial / podcast / general) → the recommended option |
| `triage_tier` | `ASK` / `CONDITIONAL` / `SILENT` (per dominant case; per-mode shifts noted inline) |
| `maps_to` | the intent key (or storyboard field) the answer records to |
| `auto` | the heuristic that resolves it from the prompt/INSPECT (e.g. `tiktok`/`9:16` → preselect platform) |
| `conditional_on` | the applicability gate (`audio_present`, `transcript_aligned===true`, `≥2 angles`, `broll_count>0`, `clean_speech.json` had removed spans, `music_vo ∈ {music,both}`, `captions in play`) |

**Content rules baked into the catalog:**
- Multi-select **only where engine-legal**: `U16 key_moments`, `M5`/`M6` callouts/overlays appetite, `U9 transitions` (multi). All other rows are single-select.
- The single legitimately-CLOSED question is `U4 audio_treatment` (exactly the 4 enum tokens). Every other asked row carries a **free-text "something else" escape**.
- **`U5 caption_animation` word-level (`karaoke`/`word-by-word`) options are SHOWN only when `transcript_aligned===true`** (the load-bearing guard — never offer or auto-select otherwise; no re-INSPECT loop in v3.7). The "static / none" option (omit `animation`) is always available.
- **`U5 caption_animation` is CONDITIONAL on captions existing at all:** mark its `conditional_on` as `captions in play (audio_present + a caption-bearing treatment, i.e. captions_style is applicable)`. Do NOT ask it on silent footage or a cut with no transcribe/keep-audio treatment — the answer would be inert (`caption_segments[]` won't exist).
- **`U3 video_type` is REACTIVE:** confirm-without-routing does **NOT** record (recording = pinning under `env > recorded > derivation > default`). Record `video_type` ONLY on an explicit re-route, and ALWAYS for **podcast** (which `deriveVideoType` can never reach — verified: it only returns cinematic/tutorial/long-form/social-short).
- "PROPOSE-as-default-then-confirm": the derived/inferred option is placed **first + tagged `(recommended)`**.
- Read-trigger line at top: *"Read once at INTENT entry alongside brief-design.md."*

**Use the corrected per-mode default matrix (§4d)** — the brainstorm matrix has 3 wrong platform cells and 2 imprecise label cells, fixed below.

### 4b. Rewrite `adapters/claude-code/.claude/skills/vob/phases/INTENT.md` — the 5-pass loop

Rewrite the prose flow (today: freeform "beats 0–4", NO `AskUserQuestion` anywhere) into the resolve-from-prompt-else-ask loop, pointing at the new reference:

- **PASS 0 — Resolve mode FIRST.** Resolve the active mode from `summary.video_type.{canonical,source}` + the prompt *before* any per-mode default is computed. If the prompt names a type, lock it; if a re-route is plausible (esp. podcast), confirm it ALONE, then recompute. `video_type` parameterizes every later default, so it cannot share a batch with the questions it parameterizes. **Record `video_type` only on explicit re-route or podcast pin** (reactive otherwise).
- **PASS 1 — Pre-fill from evidence.** Parse rough idea + INSPECT signal (`hook_candidates`, clean-cut stats, pools, `inspect.audio`, `transcript_aligned`, P3 tags) + `--like` source's verbatim `intent.answers`. **Silently record OPTIONAL keys only.** Required/conditional keys parsed from the prompt are pre-*selected* for one-tap confirm, **never silently recorded** (a mis-parse of "not for tiktok" must not commit `tiktok` to a required key — the engine stays authority via `missing_required_keys`).
- **PASS 2 — Compute per-mode defaults** for still-unknown rows (recommended-first, not yet recorded).
- **PASS 3 — Triage ASK vs SILENT** per each row's `triage_tier`. SILENT rows (fps, render segmentation, loudness-on, video_type for derivable modes) never asked, only recapped. CONDITIONAL rows gate on applicability.
- **PASS 4 — Ask the remainder, record, override.** Surviving ASK-tier unknowns batch into grouped `AskUserQuestion` cards (≤4 questions/call). Each answer records via `vob_record_intent_answer` as it returns (chosen option string → value verbatim; server canonicalizes only platform/duration/video_type). Overriding = one more `vob_record_intent_answer` overwriting the key.

Keep the existing literal freeform phrasings as the free-text fallback path. Add the read-site line: *"Read references/clarifying-questions.md at INTENT entry."* Preserve INTENT as "the ONE human-input round."

**Anti-fatigue:** group ASK-tier rows into the existing ~4–5 beats → ~4–5 cards, not one-per-question. The worked example (cinematic empty prompt, ~19 applicable rows → ~6 ASK rows → 2 cards) is credible only because each row carries a `triage_tier`; conservative default = anything safely preset-derivable is SILENT.

### 4c. `adapters/claude-code/.claude/skills/vob/phases/PLAN.md` — recap line

- **Storyboarder spawn (step 5):** add the 5 `intent.<key>: <value | none>` DATA lines (see §3). Add `intent.answers` coverage to the read-sites table if not already covered.
- **PLAN recap (step 7, ~lines 122–131):** extend the "Call out the editorial decisions the user is most likely to override" bullet (line 128) to surface the silently-defaulted creative knobs (speed, transitions, layout, snapping, caption animation, fps, loudness, segmentation) so the human sees the full creative spec before the storyboarder commits. The sign-off question (line 131, *"Approve the plan, revise the brief, revise the storyboard, or re-clarify intent?"*) stays unchanged.

### 4d. Corrected per-mode default matrix (use THIS, not the brainstorm's)

Verification found the brainstorm matrix's **Format/platform row wrong for 3 of 6 modes** (it used display name "youtube 16:9" where the preset `platform_default` is a *distinct canonical profile* with different safe-bands/duration-ideals), plus 2 imprecise label cells. Corrected:

| Cell | Brainstorm said | CORRECT (engine-accurate) |
|---|---|---|
| long-form · Format/platform | `youtube 16:9` | **`youtube_long 16:9`** (video-types.js:121; ideal 300–1200s, safe 60/100, max 8 words/line — NOT plain `youtube`) |
| tutorial · Format/platform | `youtube 16:9` | **`tutorial 16:9`** (video-types.js:151; own profile, safe 48/96, ideal 120–1200s, min_font 32px, max 9 words) |
| podcast · Format/platform | `youtube 16:9` | **`youtube_long 16:9`** (video-types.js:167; same distinction as long-form) |
| cinematic · Transitions | `gentle dips/crossfades` | **`gentle dips / crossfades / focus_pull`** (vocab is `[cut,dip,crossfade,focus_pull]` — focus_pull is the distinctive cinematic transition, omitted in the brainstorm) |
| cinematic · Overlays | `letterbox bars` | **`title_card / section_title / caption_block / end_card`** (overlay_vocabulary has NO "letterbox" token — verified `OVERLAY_TYPES` = title_card/lower_third/callout/kinetic_caption/caption_block/logo_bug/progress_bar/chapter_marker/section_title/data_viz/cta/end_card/pip; letterbox is a grade/film-feel concern, not an overlay) |
| social-short · Overlays | `—` (not surfaced) | overlay_vocabulary DOES exist (`kinetic_caption/caption_block/title_card/lower_third/logo_bug/cta/end_card`); the row is not-surfaced by triage, not absent from the preset |

**Confirmed correct (no change):** `deriveVideoType` can NEVER return `podcast` (only cinematic/tutorial/long-form/social-short) → podcast MUST be explicitly pinned. Cinematic carries **fps=24** (all other built-ins fps=30). All `clean_cut`, `caption_style`, `lint_ruleset`, and `segmentation` cells match the presets. `general` platform_default = `landscape`. Cinematic `clean_cut=FALSE` (snap-to-clean-spans = preserve). Per-short/per-segment lint scoping already works for any intent key flowing through `lintStoryboardPlan`.

---

## 5. AskUserQuestion integration

- **It is a Claude Code BUILT-IN tool**, not an `mcp__vob__` tool. Referenced NOWHERE in the repo today (grep-clean) — adding it is purely additive.
- **Boot drift guard is BLIND to it.** `verifyAdapterToolReferences` (`registry-integrity.js:146`) only matches `mcp__vob__vob_*` / `vob_vob_*` patterns in SKILL.md allowed-tools, settings.json permissions.allow, and OpenCode frontmatter. A non-vob entry like `AskUserQuestion` is skipped entirely — neither required nor forbidden, never trips the guard.
- **Required edit (to be callable):** add `  - AskUserQuestion` to **`adapters/claude-code/.claude/skills/vob/SKILL.md`** allowed-tools (lines 5–34, alongside Read/Task/ToolSearch). The allowed-tools frontmatter scopes which tools the orchestrator skill may invoke. Without this entry the skill cannot call it.
- **Optional edit (auto-approval):** `adapters/claude-code/.claude/settings.json` `permissions.allow` (lines 3–41). **CORRECTION to a naive assumption:** the "keep both lists in sync" invariant in CLAUDE.md applies to the **`vob_*` tool set only**. Built-ins are handled asymmetrically today (verified: ToolSearch is in SKILL.md allowed-tools but NOT in settings.json; Read/Task are in both) with no boot error. AskUserQuestion is interactive by design (always prompts), so omitting it from `permissions.allow` is defensible (it would simply prompt for tool-use permission the first time). **Recommend adding it for UX smoothness; verify on first run whether this repo's permission model requires it.** Either choice passes boot.
- **Grouping:** ASK-tier rows batch into the existing beats → ~4–5 cards (Format / Story+moments / Look & captions / Audio / Creative knobs), ≤4 questions per `AskUserQuestion` call. Recommended option first + tagged `(recommended)`; free-text "something else" escape on every question.
- **Multi-select only where engine-legal:** `key_moments` (U16), b-roll/overlay appetite (M5/M6), transitions (U9). All others single-select. The single legitimately-closed (no free-text) question is `audio_treatment`.

---

## 6. OpenCode port

The claude-code adapter docs are the **SOURCE**; OpenCode mirrors are regenerated.

**Propagation steps:**
1. Edit the claude-code sources (INTENT.md, PLAN.md, storyboarder.md, the new clarifying-questions.md, SKILL.md, settings.json).
2. **Edit `scripts/port-adapter-docs.js`:** the references loop iterates a **HARDCODED 2-element array** `['lint-rules.md','brief-design.md']` (line 119) — it will NOT auto-pick-up the new file. **Add `'clarifying-questions.md'` to that array** so the port emits `.opencode/vob/references/clarifying-questions.md`. (The brainstorm assumed this flows automatically — it does not.)
3. Run `node scripts/port-adapter-docs.js`. INTENT.md + PLAN.md port automatically (they're in the `PHASES` array); storyboarder.md ports automatically (subagent loop); the new reference ports once added to the array.
4. Commit both sides in the same commit.

**What the port script does NOT touch (hand-sync):**
- `adapters/opencode/.opencode/agents/vob.md` (the orchestrator spine — hand-synced per adapters/README.md). Its frontmatter only enumerates the 3 subagent write tools as `false`; a new optional intent key and AskUserQuestion do NOT appear there and do NOT trip the guard. If the INTENT summary prose in vob.md should mirror SKILL.md's, update it by hand.
- `settings.json` / `SKILL.md` frontmatter — NOT regenerated.
- **OpenCode has no `AskUserQuestion` tool.** The ported `.opencode/vob/phases/INTENT.md` must degrade gracefully — the question framework presents as conversational prose under OpenCode. Add an OpenCode-only block (the `OC_RENDER_NOTE` pattern) to the port script's INTENT handling, or word the catalog so the AskUserQuestion references read sensibly as "present these as grouped multiple-choice prompts" under OpenCode. **Open item — verify on first OpenCode run.**

**What the boot drift guard covers:** tool-NAME references only. It does NOT read phase-file or reference-file content; clarifying-questions.md drift between adapters is uncaught by any automated check (manual discipline — standing risk).

**Engine-side propagation:** none required for OpenCode beyond the shared `mcp/`. A new optional intent key works identically on both adapters once `OPTIONAL_INTENT_KEYS` is updated and both adapters' spawn lines + agent bullets exist.

---

## 7. Testing / acceptance

### m5-walker.js `intent` scenario

The existing `runGeneral` (`scripts/m5-walker.js`, project-id `GEN` is a phase-LOCAL `const` at line ~1144 — no collision with any new function) already exercises optional-key record/thread/never-gate at lines 1175–1194. **The walker calls `executeTool` directly (schema validation + envelope, NOT the LLM).**

**Source of truth for the new-key assertions (resolve the ambiguity): EXTEND the existing `runGeneral` `guided` object (lines 1176–1181) with all five new keys** — it is the already-green path that exercises the substrate, and adding the keys there gets the record/thread/never-gate coverage for free. A standalone `runIntent()` + `if (phase === 'intent')` case (insert after the `runSpans` dispatch, ~line 3148) is OPTIONAL and, if added, must assert the SAME substrate facts (do not duplicate divergent assertions). Do not write two harnesses that disagree.

**What the walker CAN assert model-free (the engine substrate):**
- Each new optional key is accepted by `vob_record_intent_answer` (the enum accepts it — proves the `OPTIONAL_INTENT_KEYS` landing).
- `recorded.value === <plain string>` (proves it stays free-text — a stray canonicalization branch would FAIL this assertion, the useful guard).
- The new key is **NOT** in `missing_required_keys` (the never-gates contract — mirrors line 1186).
- The key echoes verbatim through `read_state_summary.intent.answers[key]` (the thread-through — mirrors line 1191).
- A still-incomplete required-key set leaves the correct `missing_required_keys` (the pre-fill/ask boundary).

**What the walker CANNOT assert (skill/LLM-side, out of walker reach):** AskUserQuestion card rendering/UX, the 5-pass resolve-from-prompt-else-ask DECISION logic, mode-aware default SELECTION, the `(recommended)` tag, the one-tap-confirm-vs-silent-record distinction. The walker is a regression guard for the **engine half**, not the UX half — do not write a walker assertion that depends on storyboarder/composer behavior.

### Per-slice acceptance criteria (testable)

- **Slice 0:**
  - `node scripts/server.js` (or the repo's boot entry) exits 0 and the drift guard passes (no engine change → all existing walker phases stay green: `node scripts/m5-walker.js general` etc.).
  - `references/clarifying-questions.md` exists with the §4a data shape and the §4d corrected matrix (every Format/platform cell matches the verified profile name; cinematic transitions include `focus_pull`; no `letterbox` overlay token).
  - INTENT.md contains the PASS 0–4 structure, the read-site line, and references `AskUserQuestion`; `AskUserQuestion` is present in SKILL.md allowed-tools.
  - `scripts/port-adapter-docs.js` line-119 array includes `'clarifying-questions.md'`; after running the port, `.opencode/vob/references/clarifying-questions.md` exists and `.opencode/vob/phases/INTENT.md` is regenerated.
- **Slice 1:**
  - `editorial_intent` + `caption_animation_intent` are in `OPTIONAL_INTENT_KEYS`.
  - `node scripts/m5-walker.js general` (with the extended `guided` object) passes: both keys record with `recorded.value` equal to the plain input string, neither appears in `missing_required_keys`, both echo through `read_state_summary.intent.answers`.
  - storyboarder.md has both input bullets; `caption_animation_intent` bullet states the `transcript_aligned` word-level gate AND the `static`→omit-`animation` mapping (never `animation:"static"`); `editorial_intent` bullet states the `clean_cut=false` conflict-surfacing rule and that it does not alter `PLAN_CLIP_STRADDLES_REMOVED_SPAN`.
  - Port run regenerates both adapters; commit touches both.
- **Slice 2:**
  - `transition_intent` + `layout_intent` + `speed_intent` in `OPTIONAL_INTENT_KEYS`; walker `general` phase covers all three (record/free-text/never-gate/thread).
  - storyboarder.md has all three bullets; `layout_intent` bullet disambiguates the three `pip` concepts.
  - **Manual / out-of-walker check (label it as such — the walker cannot reach COMPOSE):** on a fixture with a `layout_intent`-derived `scene.layout`, COMPOSE entry runs `layout-materialize.js::materializeSceneLayouts` and produces one composited clip (covered by the existing `layout` walker phase, not the intent substrate); on a fixture with `source_clips[].speed`, the materialized clip's real duration ≈ `(out−in)/speed` (covered by the existing `clip`/`general` materialize path through `ffmpeg-runner.js::buildClipCutArgv`).

---

## 8. Sequenced task breakdown

Each slice is independently shippable. Land each engine key + its consumer + its OpenCode mirror together (the silent-failure rule).

### Slice 0 — Framework over existing keys (NO engine change)
- `adapters/claude-code/.claude/skills/vob/references/clarifying-questions.md` (NEW — catalog with the §4a data shape + §4d corrected matrix).
- `adapters/claude-code/.claude/skills/vob/phases/INTENT.md` (rewrite — 5-pass loop, AskUserQuestion grouping, read-site).
- `adapters/claude-code/.claude/skills/vob/phases/PLAN.md` (recap line in step 7).
- `adapters/claude-code/.claude/skills/vob/SKILL.md` (add `AskUserQuestion` to allowed-tools).
- `adapters/claude-code/.claude/settings.json` (optional: add `AskUserQuestion` to permissions.allow).
- `scripts/port-adapter-docs.js` (add `'clarifying-questions.md'` to the line-119 references array; optional INTENT OpenCode-only block).
- Run `node scripts/port-adapter-docs.js`; commit both adapters.

### Slice 1 — `editorial_intent` + `caption_animation_intent`
- `mcp/lib/intent-schema.js` (add both to `OPTIONAL_INTENT_KEYS` + doc comments, honest advisory wording — `editorial_intent` does NOT alter `PLAN_CLIP_STRADDLES_REMOVED_SPAN`).
- `mcp/lib/tools/record-intent-answer.js` (description string).
- `adapters/claude-code/.claude/skills/vob/phases/PLAN.md` (2 spawn lines).
- `adapters/claude-code/.claude/agents/storyboarder.md` (2 input bullets; `caption_animation_intent` keeps the `transcript_aligned` gate + `static`→omit-`animation`; `editorial_intent` conflict-surfacing on `clean_cut=false`).
- `scripts/m5-walker.js` (add both to the `guided` object in `runGeneral`; optionally add a labelled `runIntent()` mirroring the same substrate assertions).
- Run port; commit both adapters.

### Slice 2 — `transition_intent` + `layout_intent` + `speed_intent`
- `mcp/lib/intent-schema.js` (add all three to `OPTIONAL_INTENT_KEYS` + doc comments).
- `mcp/lib/tools/record-intent-answer.js` (description string).
- `adapters/claude-code/.claude/skills/vob/phases/PLAN.md` (3 spawn lines).
- `adapters/claude-code/.claude/agents/storyboarder.md` (3 input bullets pointing at the existing speed/transition/layout field docs; `layout_intent` disambiguates the three `pip` concepts).
- `scripts/m5-walker.js` (extend the `guided` object + any `runIntent` to all three).
- Run port; commit both adapters.

---

## 9. Risks & open items

**Standing risks (carried from the brainstorm, verification-confirmed):**
- **Optional-key softness:** every new key is advisory — "user-steerable" = "the storyboarder/composer *may* honor it." Mitigate with spawn emphasis + agent-bullet override semantics; do not over-promise. The two Slice-1 keys are the *weakest* (advisory-only, no materialization); `editorial_intent` in particular has NO engine path at all (it changes only the storyboarder's prose snap-choice — the `PLAN_CLIP_STRADDLES_REMOVED_SPAN` warning never reads it). Say so plainly.
- **Multi-aspect fan-out gap:** all fan-out shorts share one project aspect/platform (no per-short profile field) — DEFERRED (Slice 4), flag to live-testers so it's not reported as a bug. The framework asks N (also deferred), never aspect.
- **Silent mis-record of required keys:** Pass 1 records OPTIONAL keys only; required/conditional parsed from freeform are pre-selected for one-tap confirm, never committed — preserves "engine is authority on required."
- **Free-text conditional gates:** `music_vo` isn't canonicalized; any gate on `music_vo ∈ {music,both}` (e.g. the deferred U17 ducking) is skill-side regex over un-normalized state — brittle. Prefer unconditional-but-defaulted. (Moot for v3.7 since U17/ducking is Slice 4.)
- **Doc-half silent failure:** a key in `OPTIONAL_INTENT_KEYS` without consumer plumbing records inertly with no error. Land the spawn line + agent bullet + OpenCode mirror with every key.
- **Adapter drift:** edit claude-code, run `port-adapter-docs.js`; the boot guard covers only tool NAMES, not phase/reference content — manual discipline. The new reference needs the line-119 array edit or it silently won't port.
- **AskUserQuestion permission:** verify on first run whether this repo's permission model needs the `settings.json` entry (built-in, plausibly permission-free, but unconfirmed against this repo).
- **`caption_animation_intent` `static` value-without-a-home:** there is no `static` animation token (`CAPTION_ANIMATIONS` = `pop`/`word-by-word`/`karaoke`). The catalog/storyboarder must map "static/none" to OMITTING `animation`, never to a literal string — wiring `animation:"static"` fails validation (`storyboard-schema.js:360`).

**Open items for the build (resolve during implementation):**
- **OpenCode AskUserQuestion degradation:** does `.opencode/vob/phases/INTENT.md` need a dedicated OpenCode-only block explaining the conversational-prose fallback? Verify on first OpenCode run.
- **`editorial_intent` on `clean_cut=false` (cinematic):** PRD resolves this as *surface-a-conflict* (do not auto-override `clean_cut=false`, do not silently ignore). Confirm the storyboarder prose lands this cleanly.
- **`caption_animation_intent` conditionality:** the question is moot when no caption track exists (no `audio_present` + caption-bearing treatment). Catalog marks it CONDITIONAL on `captions in play`; confirm the triage logic skips it correctly on silent footage.
- **Soft "ignored-a-strong-intent" plan-lint (NOT in v3.7 scope):** the ONLY way any key gains enforcement teeth is a lint reading `ctx.state.intent.answers.<key>` in `storyboard-schema.js`. Without it all five stay advisory. Explicitly deferred; named so reviewers know the keys are advisory by design.
- **Value-level enum constraints (NOT in v3.7 scope):** the five stay free-text. If a future slice wants `speed_intent`/`caption_animation_intent` value-enforced, that extends `validateIntentAnswerValue` (the `audio_treatment` pattern) — a deliberate departure from the all-optional-keys-free-text invariant.
