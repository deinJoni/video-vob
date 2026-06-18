# v3.9 — Cold-open (semantic hook) + caption realization (PROGRESS)

**STATUS: ✅ implementation-complete + verified (NOT committed — shared tree w/ loop 2; NOT live-rendered).**
Verified: `hook` walker 7/7, `editorial` walker regression green, 31 design-system components lint-clean,
`vob/caption_emphasis_generic` differential test OK, boot integrity exit 0 (both adapters), OpenCode mirror
regenerated. The one thing left is a real `/vob` run with footage + render (the project's standing "live test").


**The lever (live-tester feedback #5):** the hook + captions are the two on-screen
elements that decide retention, and both were under-crafted.
- **Hook:** scene 0 was chosen by energy+lexicon heuristics and realized like any
  other scene (no punch).
- **Captions:** on screen ~always in short-form but realized generically (not
  on-brand, not animated, not emphasis-driven, not matched to the design system).

**Fix:** treat the cold-open as first-class (semantic hook scoring + a dedicated
punch-in / kinetic-claim recipe for scene 0) and elevate caption realization
(on-brand, animated, `emphasis_words`-driven, matched to the design system).

All additive, advisory, fail-safe, per the house patterns — **no FSM edge, no new
gate, no new/renamed required intent key.** (Sits inside the 3.9.0 line.)

## Design (locked)

### Lever 1 — Cold-open as first-class
- **(1a) Semantic hook scoring — NEW `mcp/lib/hook-scoring.js`** (pure, mirrors
  `take-quality.js`). A faithful SUPERSET of the legacy `rankHookCandidates`
  scorer: legacy mode (`VOB_HOOK_SCORING=off`) reproduces the exact old weights;
  enriched mode (default) adds rhetorical **hook archetypes** (`hook_type` ∈
  question / number_stat / bold_claim / curiosity_gap / contrarian / stakes /
  promise / direct_address / none), curiosity-gap / promise / contrarian / stakes
  phrase families, a **self-containment** adjustment (mid-thought open = weaker
  cold-open), a **specificity** bonus, and a **take-quality `strength` blend** (a
  well-delivered line is a better hook). Crosslingual fail-safe (structural
  signals language-agnostic; English phrase families gate to English; never worse
  than today). `inspect-digest.js::rankHookCandidates` delegates per-sentence
  scoring to it and now stamps `hook_type` on every candidate.
- **No new schema field for the cold-open** — `scenes[0].purpose==="hook"` already
  marks it (`PLAN_HOOK_NOT_FIRST`). The composer keys the recipe off that.
- **(1b) Punch-in / kinetic-claim recipe (COMPOSE)** — the hook scene gets a CSS
  punch-in (scale push on the scene `<video>`, duration-exact, data-start
  stagger) + its caption realized as the **kinetic claim** (biggest caption,
  design-token-styled, emphasis-driven). New design-system component
  `cold-open-claim`. Documented in composer.md + editorial-patterns.md §3 +
  lint-rules.md.

### Lever 2 — Caption realization elevated
- **Captions join the design-system kit.** The v3.9 design-system kit (the
  taste-floor) had titles/lower-thirds/grades but NO caption component — captions
  only lived in the separate GSAP caption kit, divorced from the `--vob-*` tokens.
  NEW pure-CSS, token-driven, emphasis-aware design-system components:
  - `caption-pop` (kind: caption) — everyday chunk pop, emphasis word in `--vob-accent`.
  - `caption-word-rise` (kind: caption) — pure-CSS word-by-word (staggered
    `data-start` spans; GSAP-free, the reliable not-aligned downgrade target).
  - `cold-open-claim` (kind: cold_open) — the marquee hook claim.
  Per-video-type `slots.caption` + `slots.cold_open` in the design-system manifest.
  (Karaoke stays the GSAP caption kit — it genuinely needs a per-word timeline,
  which renders.)
- **Composer guidance elevated** (composer.md): PREFER the design-system caption
  components (token-driven, reliably-rendering pure CSS) for the common case;
  emphasis_words are REQUIRED to get the look's accent treatment (was advisory);
  the hook scene's caption is the kinetic claim.
- **Advisory COMPOSE-QC nudge** `vob/caption_emphasis_generic` — a scope declares
  `emphasis_words` but the composition stamps zero `data-vob-emphasis` — INFO,
  never an error (captions stay advisory).

### PLAN side (light touch)
- The existing hook lints (`PLAN_HOOK_NOT_GROUNDED`, `PLAN_OPENING_LOW_ENERGY`)
  improve for FREE from the richer candidate ranking. The grounding-lint message
  now names the rank-1 candidate's `hook_type`.
- NEW advisory `PLAN_HOOK_CAPTION_NO_EMPHASIS` (retention-gated, fail-safe): the
  hook scene's caption carries no `emphasis_words` — a kinetic claim wants an
  emphasized word. WARNING, never blocks.

## Files (planned)
- NEW `mcp/lib/hook-scoring.js` — pure scorer. Knob `VOB_HOOK_SCORING`. ✅ written
- `mcp/lib/inspect-digest.js` — `rankHookCandidates` delegates to hook-scoring,
  threads per-candidate `strengthScore`, stamps `hook_type`; digest hook section
  shows `hook_type`.
- `mcp/lib/inspect.js` — pass winner-file segments (with `strength`) into
  `rankHookCandidates`.
- `mcp/lib/storyboard-schema.js` — grounding-lint message names `hook_type`;
  NEW `PLAN_HOOK_CAPTION_NO_EMPHASIS` (retention-gated, fail-safe).
- `mcp/lib/video-types.js` — `PLAN_HOOK_CAPTION_NO_EMPHASIS` → non-retention `disabled_rules`.
- `mcp/lib/composition-qc.js` — advisory `vob/caption_emphasis_generic`.
- NEW `mcp/assets/design-system/{caption-pop,caption-word-rise,cold-open-claim}/` (fork-authored, lint-clean).
- `scripts/build-design-system.js` + `mcp/assets/design-system/manifest.json` —
  register `caption` + `cold_open` kinds; per-video-type slots; rebuild.
- Agent docs (both adapters via `port-adapter-docs.js`): composer.md (caption +
  cold-open recipe), storyboarder.md (hook playbook → hook_type), editorial-patterns.md
  (§3 cold-open realization, §1/§10 caption emphasis), lint-rules.md (punch-in +
  caption recipes + new QC code).
- `scripts/m5-walker.js` — NEW `hook` phase (source-free, tests hook-scoring); extend `captions`.
- Docs: this file + `docs/v3.9/CHANGELOG.md` section + CLAUDE.md invariant.

## Build checklist
- [x] `mcp/lib/hook-scoring.js` (pure scorer) — smoke-verified (`/tmp/vob_hook_smoke.js`, ALL OK)
- [~] fork: 3 design-system components (lint-clean) — IN FLIGHT (agent `ab724bc7998278583`)
- [x] wire hook-scoring → inspect-digest.js + inspect.js (+ hook_type surfacing + winner `strength`)
- [x] grounding-lint hook_type message + `PLAN_HOOK_CAPTION_NO_EMPHASIS` (in-code retention gate, NO
      video-types.js edit — piggybacks on `disabled.has("PLAN_HOOK_NOT_GROUNDED")`) — `editorial` walker green
- [x] composer.md / storyboarder.md / editorial-patterns.md (§3) / lint-rules.md (caption + cold-open recipe) edits
- [x] boot integrity green (exit 0); all edited modules load
- [x] CHANGELOG section
- [x] 3 design-system components authored MYSELF (fork hung ~25min on lint loop → killed); all lint-clean
- [x] build-design-system.js (KINDS + COMPONENTS + slots) + manifest rebuilt → 31 components lint-clean, slots wired
- [x] `vob/caption_emphasis_generic` advisory (info) in composition-qc.js — raw-content scan, differential-tested
- [x] walker `hook` phase (m5-walker.js — inserted after runEditorial, no collision w/ loop-2's runVariety) — 7/7
- [x] `node scripts/port-adapter-docs.js` (OpenCode mirror — 17 files; my content present)
- [x] CLAUDE.md invariant bullet
- [x] final verification + report

## Concurrency notes (a 2nd loop shares this tree — "another FSM step")
- **DO NOT COMMIT** (tool guidance = commit only when asked; the user didn't, and shared files
  would bundle loop 2's half-done work). Leave clean, verified, uncommitted changes.
- **Loop 2 is touching:** `video-types.js`, `m5-walker.js`, `editorial-patterns.md` (it added a
  "Visual variety" rubric dimension → 8 dims). I AVOID `video-types.js`; coexist in
  `editorial-patterns.md` (different sections — Edit fails loud on true conflict, never clobbers).
- **My exclusively-owned files:** `hook-scoring.js`, `inspect-digest.js`, `inspect.js`,
  `storyboard-schema.js` (hook lints region), `composer.md`, `storyboarder.md`, `lint-rules.md`,
  `docs/v3.9/{hook-and-captions,CHANGELOG}.md`, + the new design-system component dirs.
- Don't claim a rubric "dimension count" in docs (loop 2 is changing it).

## Guardrails
Engine produces structure (hook_type, the richer ranking, the vetted components);
skill/agents own how to use it. Degrade-never-throw throughout. Captions stay
ADVISORY at QC (only the pre-existing `vob/caption_missing_element` exact-binding
is an error). New plan-lints are WARNING + retention-ruleset-gated + fail-safe.
