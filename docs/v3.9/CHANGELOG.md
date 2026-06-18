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

## Testing / tooling

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
