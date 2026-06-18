# v3.9 — PLAN / Storyboarder Editorial-Quality Pass

The storyboarder was a **single-shot editor with no self-critique**: it generated a
plan once, the lints caught broken plans, but nothing pushed *editorial quality*
(hook, take choice, cut rhythm, b-roll motivation). A mediocre editor and a great
one both passed the lints. v3.9 makes the lints a *floor* and adds the *ceiling* —
the "good editor vs mediocre editor" lever — by making the INSPECT signals
load-bearing, adding a generate→self-critique→revise loop, and shipping an
editorial-pattern playbook. No new FSM edges, no new gates, no new/renamed required
intent keys; everything new is advisory, WARNING-level, ruleset-gated, and
fail-safe. (3.8.0 → 3.9.0)

## Pillar A — make the INSPECT signals load-bearing

- **Two new hook-grounding plan-lints** (`storyboard-schema.js`), both WARNING,
  fail-safe, and **retention-ruleset-gated** (off for chaptered/montage/general via
  `disabled_rules`, like the other hook lints):
  - **`PLAN_HOOK_NOT_GROUNDED`** — the opening hook scene's source window overlaps
    none of the top-ranked `hook_candidates[]` INSPECT produced. Only applies when
    the opening clip is from the winner/transcribed file (candidate source-seconds
    are file-specific), so it never false-positives across files.
  - **`PLAN_OPENING_LOW_ENERGY`** — the opening is drawn from a notably quiet span
    (`energy_rms_db` well below the file median) while louder delivery exists. A flat
    open rarely hooks.
- **Signals threaded into the lint ctx** — `loadInspectSummary` / `loadSegments` /
  `segmentsForFile` feed the full ranked hook candidates (from `inspect/summary.json`)
  and per-segment energy (`inspect/segments.json`) into `validateStoryboardContent`'s
  context, beside the existing `cleanSpeech` / `transcript`. `inspect.js` now stamps
  `transcribed_file_index` into `summary.json` so the candidate check knows which
  file the candidate timestamps belong to.
- **Storyboarder grounds harder** (`agents/storyboarder.md`) — the hook playbook and
  take-selection now mandate using the ranked candidates + `energy_rms_db` /
  `speech_rate_wpm` (cite the new lints), not merely *having* the digest.

## Pillar B — generate → self-critique → revise

- **Storyboarder self-critique loop** — a new *Self-critique before you save* section
  in `agents/storyboarder.md`: draft → critique against the seven-dimension rubric →
  revise → save. Cheap, always-on, in-context.
- **Independent `editorial-critic` subagent** (new, both adapters) — the orchestrator
  spawns it in PLAN *after* a lint-clean save and *before* the human sees the plan. A
  read-only critic (no write tool; returns its verdict as its final message) that
  reads the brief + storyboard + INSPECT signals + the editorial playbook and emits
  `VERDICT: SHIP|REVISE` + per-dimension scores + concrete `editorial/*` findings.
  PLAN auto-applies **at most one** critic-driven revision (re-spawns the storyboarder
  with the findings) then presents the improved plan; remaining notes ride to the
  gate as `⚠ editorial:` lines. **Fully advisory and fail-safe** — a critic
  error/timeout never blocks; the human is always the final judge (no FSM edge, no
  gate, no new tool/permission). Registered in `VALID_ROLE_BUNDLES`; boots clean.

## Pillar C — editorial pattern recipes

- **`references/editorial-patterns.md`** (new, both adapters) — the "good editor"
  playbook: the seven-dimension rubric (Hook · Arc · Cut rhythm · Take · B-roll ·
  Captions · Ending), a signal→decision grounding cheat-sheet, cold-open / hook
  structures, retention beats, take-selection heuristics, cut-rhythm/pacing arcs,
  b-roll motivation, endings, per-ruleset emphasis, and the `editorial/*` finding
  codes. Read by both the storyboarder (to plan + self-critique) and the critic (to
  score).

## INSPECT — per-segment take-quality scoring (the upstream complement)

Pillar A makes the storyboarder *act* on INSPECT's energy / hook signals; this adds a
richer composite signal those same consumers read. INSPECT used to say what is
*spoken* and what is A/B-roll, never what is *good* (strong delivery, sharp focus, no
flubs). Each non-silence segment in `segments.json` (schema 1.1→**1.2**) now carries a
**`strength`** block — `{score (0–1), tier (strong|usable|weak), delivery, visual,
components{energy,pace,cleanliness,sharpness,exposure,face}, flags[]}` — so the
storyboarder picks the BEST take of a moment, not just a spoken one.

- **`mcp/lib/take-quality.js`** (pure scorer) — energy + speech-rate + clean-cut
  cleanliness (delivery) and sharpness + exposure + optional face (visual).
  Energy/sharpness are scored *relative to the file's own distribution* ("strong" =
  the best take of THIS shoot); pace/exposure use absolute bands; composite
  0.6·delivery + 0.4·visual, renormalized over present components. Fail-safe — missing
  inputs → null components; `strength:null` only when nothing is measurable (matching
  silence).
- **`mcp/lib/visual-quality.js`** — cheap visual heuristics off the **keyframes INSPECT
  already extracts** (no re-decode): one `blurdetect,signalstats,metadata=print` ffmpeg
  pass per frame → focus `sharpness` + `luma_mean` exposure. Degrades to exposure-only
  (no `blurdetect`) or null; never throws.
- **`mcp/lib/face-backend.js`** + `mcp/lib/visual/face_detect.py` — an OPTIONAL
  pluggable face-presence backend (OpenCV bundled Haar cascade; mirrors
  `asr-backend.js` detect→run→degrade). Adds the `face` term when `pip install
  opencv-python-headless` is present; degrades to `face:null` otherwise. Knob
  `VOB_FACE_BACKEND`. Surfaced as an optional, warn-only `vob_doctor` check.
- **Surfaced** — `state.inspect.take_quality`, a lean
  `read_state_summary.inspect.take_quality` (counts + median + strongest), a digest
  **`## Strongest takes`** leaderboard + a `take` column (tier+score+flags) in the
  segment table; documented in `storyboarder.md` / `inspector.md` /
  `editorial-patterns.md` (§1/§2/§5). Lands in `segments.json`, so Pillar A's
  `loadSegments` / `PLAN_OPENING_LOW_ENERGY` consume it for free.
- **Advisory** — no gate, no FSM edge, no new required key. Knobs: `VOB_TAKE_QUALITY`,
  `VOB_VISUAL_QUALITY`, `VOB_FACE_BACKEND`.

## Testing / tooling

- **Walker `takequality` phase** (`node scripts/m5-walker.js takequality`) — a
  source-free unit harness for the strength scorer (strong>weak ordering / tiers /
  flags, fail-safe nulls, cleanliness from removed spans, the optional face term, the
  visual-metadata parser, and the digest section). Model-free regression test. The
  visual + face extraction were additionally verified live (real ffmpeg `blurdetect`;
  real OpenCV face detection on a human-face image in a throwaway venv).
- **Walker `editorial` phase** (`node scripts/m5-walker.js editorial`) — a source-free
  unit harness (calls `lintStoryboardPlan` with synthetic `summary`/`segments` ctx)
  that isolates each new code, the retention gate, and the cross-file / missing-signal
  fail-safes. Permanent regression test, model-free.
- **Dual-adapter parity** — `port-adapter-docs.js` extended (`+editorial-critic`,
  `+editorial-patterns.md`) and run; OpenCode mirror regenerated; boot integrity green.

## Files

`mcp/lib/storyboard-schema.js` (loaders + `warnHookGrounding` + ctx), `mcp/lib/inspect.js`
(`transcribed_file_index`), `mcp/lib/video-types.js` (ruleset `disabled_rules`),
`mcp/lib/tool-registry.js` (`editorial-critic` bundle), the storyboarder + new
editorial-critic agent (both adapters), `PLAN.md` (critique pass), the
`editorial-patterns.md` reference (both adapters), `scripts/port-adapter-docs.js`,
`scripts/m5-walker.js` (`editorial` phase), and the `3.9.0` version bump
(`.vob/VERSION`, `package.json`, `mcp/server.js`).

## COMPOSE — design-system kit (the taste-floor lever)

The composer turned `target.design` tokens into CSS with only a font kit + fix recipes
+ QC — no opinionated visual system, so the default read as "AI slop". v3.9 adds a
first-party, vetted, **per-video-type design system** the composer ADAPTS (mirrors the
caption-kit mechanism). No new tool / QC code / FSM edge / schema.

- **28 PURE-CSS, token-driven REFERENCE components** under `mcp/assets/design-system/`
  — 5 titles, 5 lower-thirds, 7 grades, 3 motion presets, 3 furniture (callout×2,
  end-card), 5 backdrops — all lint-clean (build-verified) + render-verified. Plus
  `tokens.css` (the `--vob-*` contract) and a generated `manifest.json` whose
  `video_types` map carries per-preset LOOK bundles (taste `principles[]` + the
  recommended component per role).
- **`scripts/build-design-system.js`** — source of truth; LINTS every component
  (`hyperframes lint`, fails the build on any error = the "vetted" guarantee);
  `--manifest-only` / `--skip-lint` / `--snapshot`.
- **`injectDesignKit()`** (`source-symlink.js`) symlinks `compose/design-system` on
  every save (clone of `injectCaptionKit`, degrade-don't-die); wired into
  `save-composition.js` (`state.composition.design_system:{linked}`).
- **Composer wired** — `composer.md` §"Design system kit" (set `--vob-*` tokens from
  `target.design` → adapt the video_type look's components → grade `filter:` on the
  scene `<video>` → reuse motion eases → font-substitute → STAGGER VIA `data-start`,
  not `animation-delay`); `COMPOSE.md` spawn (`video_type` + `design_system`);
  `lint-rules.md` §Design system kit. Both adapters in sync.
- Verified: 28 lint-clean, 12 render-verified across social / general / cinematic /
  podcast, adversarial review (0 blockers / 0 majors, 5 minor fixed). Full ledger:
  `docs/v3.9/compose-design-system/`.

## Cold-open (semantic hook) + caption realization (the two on-screen retention levers)

Live-tester feedback: the **hook and the captions** decide retention, and both were
under-crafted — scene 0 was chosen by an energy+lexicon heuristic and realized like
any other beat (no punch); captions were on screen ~always in short-form but realized
generically (not on-brand, not emphasis-driven, not matched to the design system).
This makes both first-class. Additive, advisory, fail-safe — no FSM edge, no new gate,
no new/renamed required key. Full ledger: `docs/v3.9/hook-and-captions.md`.

### INSPECT — semantic hook scoring
- **NEW `mcp/lib/hook-scoring.js`** (pure scorer, no I/O) — a faithful SUPERSET of the
  legacy `rankHookCandidates` lexicon scorer. `VOB_HOOK_SCORING=off` reproduces the old
  weights byte-for-byte (incl. non-English gating); enriched (default) adds: rhetorical
  **hook archetypes** (`hook_type` ∈ question / number_stat / curiosity_gap / contrarian
  / stakes / promise / bold_claim / direct_address / none), curiosity-gap / promise /
  contrarian / stakes phrase families, a **self-containment** adjustment (a mid-thought
  open is a weaker cold-open), a **specificity** bonus, and a **take-quality `strength`
  blend** (a well-delivered candidate out-ranks a flat one). Crosslingual & fail-safe.
- `inspect-digest.js::rankHookCandidates` delegates per-sentence scoring to it, threads
  the winner file's segments (`strength`), and stamps `hook_type` on every candidate;
  the digest's § Hook candidates names the archetype. The full candidates already ride
  into `summary.json`, so the existing v3.9 hook-grounding lints consume the richer
  ranking for free; `PLAN_HOOK_NOT_GROUNDED` now names the rank-1 candidate's `hook_type`.

### PLAN — the cold-open is the kinetic claim
- **NEW advisory lint `PLAN_HOOK_CAPTION_NO_EMPHASIS`** (`storyboard-schema.js`,
  `warnHookCaptionEmphasis`) — the hook scene plans captions but none carry
  `emphasis_words`; the kinetic claim wants a load-bearing word. WARNING, fail-safe, and
  retention-gated WITHOUT a `video-types.js` edit (piggybacks on the hook-grounding gate).
- `storyboarder.md` + `editorial-patterns.md §3` — plan scene 0 as a kinetic claim: pick
  the candidate by `hook_type`, put the hook LINE in `caption_segments` with `emphasis_words`.

### COMPOSE — punch-in + on-brand, emphasis-driven captions
- **NEW design-system caption components** (pure-CSS, token-driven, emphasis-aware,
  render-reliable): `caption-pop`, `caption-word-rise`, `cold-open-claim`, plus per-video-type
  `slots.caption` + `slots.cold_open`. Captions become part of the design system (they
  were divorced from `--vob-*` in the GSAP-only caption kit).
- `composer.md` — captions reframed as a PRIMARY surface: prefer the design-system caption
  slot (on-brand + reliably-rendering), emphasis_words REQUIRED via `<span class="emph"
  data-vob-emphasis>` in `--vob-accent`, and a worked **hook scene** example with the
  punch-in (duration-exact CSS scale on the video) + kinetic claim. Recipe in `lint-rules.md`.
- Knob: `VOB_HOOK_SCORING`.
