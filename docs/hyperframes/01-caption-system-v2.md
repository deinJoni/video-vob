# PRD 01 — Caption System v2: realize the kinetic-caption layer on the COMPOSE side

**One-line summary:** Take bob's already-shipped PLAN-side caption layer (`scene.caption_segments[]` with `animation`/`emphasis_words`/`style_ref`/`id`/`exact`, the `PLAN_CAPTION_*` warnings, and the `data-vob-caption-id` binding) and give the COMPOSE side a *vetted, vendored caption-component kit* to realize it from — plus a real, geometry-based caption-legibility check at COMPOSE time via `hyperframes inspect`, wired through the one runner chokepoint.

**Status:** Proposed
**Version target:** v3.3 (additive; no FSM edges, no new gates, no schema-breaking change)
**Siblings:** [`02-scene-transitions.md`](./02-scene-transitions.md), [`03-subject-compositing.md`](./03-subject-compositing.md) (written separately — do not implement here)

---

## 1. Problem / motivation

Animated captions are the single most-watched element of short-form social video — bob's default `social-short`/`retention` territory. bob already invested heavily in the **plan side** of captions (the v3.x "PLAN creative layers" work):

- `scene.caption_segments[]` are validated and lint-checked in `mcp/lib/storyboard-schema.js`: `animation ∈ {pop, word-by-word, karaoke}`, `emphasis_words[]`, `style_ref`, `position`, plus an opt-in binding `id` and `exact` flag.
- Plan lint emits advisory `PLAN_CAPTION_*` warnings (chunk-too-long, emphasis-not-in-text, timing-drift, exact-on-unaligned-transcript) and the word-level alignment guard.
- COMPOSE QC already enforces an **opt-in binding**: a caption segment with an authored `id` must be realized by an element stamped `data-vob-caption-id="<id>"`, or QC warns (`vob/caption_unbound`) / errors when `exact:true` (`vob/caption_missing_element`).

**But the COMPOSE side is unaided.** The composer subagent hand-authors caption HTML/CSS/JS from prose recipes in `adapters/claude-code/.claude/skills/vob/references/lint-rules.md`. That has three concrete failure modes:

1. **Inconsistent, lint-fragile output.** hyperframes ships ~15 *vetted, lint-clean* caption components; bob re-derives them by hand and trips hyperframes' own caption lint rules (`caption_exit_missing_hard_kill`, `caption_fittext_scale_mismatch`, `caption_text_overflow_risk`, …) that the official components are built to satisfy.
2. **No real legibility measurement.** `PLAN_CAPTION_CHUNK_TOO_LONG` is a coarse heuristic (`caption_chunk_max_words: 7`, `caption_chunk_max_chars: 42` in `PLAN_LINT_THRESHOLDS`). It runs engine-side on JSON with no browser, so it cannot know whether a chunk *actually* overflows the safe area at the chosen font/size/canvas — and it's blind to CJK width (a 42-char Latin limit is meaningless for 中文). The genuine check requires rendering.
3. **`animation` is declared but not mapped.** The plan says `karaoke`; nothing tells the composer *which* implementation realizes karaoke deterministically, or how to wire per-word timing.

Separately, bob has a **standing gap from the PREVIEW/RENDER auto-QC track** (`docs/preview-render/`, the `steps67-autoqc` work): the black-frame luma check shipped (`mcp/lib/tools/qc-stills.js`), but contrast / safe-area / text-overflow QC was *deferred* on the stated belief there was "no hyperframes geometry." There is: **`hyperframes inspect`** renders the composition at sampled timestamps and reports text/container overflow as agent-readable JSON. This PRD folds that capability in as the legibility check, killing two birds.

## 2. Goals

- G1. **Vendor a caption-component kit** into the engine (`mcp/assets/captions/`), mirroring the font-kit precedent, with a manifest mapping the `animation` enum → a canonical component implementation. Inject it into `compose/` on every save like `fonts.css`.
- G2. **Wire `hyperframes inspect`** through the single runner chokepoint (`buildInspectArgv` + a runner in `mcp/lib/hyperframes-runner.js`) and run it as a **layout/legibility QC pass** inside the merged-lint path, folding overflow findings into the one findings list as `vob/*` **warnings**.
- G3. **Hand the composer what it needs to realize captions well:** the animation→component recipes, emphasis-word styling, and — for `word-by-word`/`karaoke` — the path to the **word-level transcript** (data-only in the spawn).
- G4. **Stay additive and advisory.** No new FSM edges or gates; captions remain advisory at COMPOSE-QC (binding stays opt-in; the new inspect findings are warnings, never errors).
- G5. **Make `PLAN_CAPTION_CHUNK_TOO_LONG` honest** by pairing the cheap pre-browser heuristic with the real geometric measurement at COMPOSE.

## 3. Non-goals

- NG1. **No hard caption binding by default.** We deliberately do *not* make every caption a `data-vob-overlay-id`-style error. The opt-in `id`/`exact` model already shipped and is correct — the composer must stay free to re-chunk and re-time captions.
- NG2. **No new ASR / alignment work.** Word-level timing + `transcript_aligned` come from the existing INSPECT P1 forced-alignment path. This PRD consumes them; it does not change them.
- NG3. **No `--variables`/`--batch` templating, no `tts`, no cloud render.** Those are separate ideas (see §13).
- NG4. **No font-kit changes.** The kit already includes the display faces caption components want (Anton, Bebas Neue, Hanken Grotesk, Noto SC). If a vendored component references a family not in the kit, that surfaces as the existing hyperframes `font_family_without_font_face` lint — handled by extending the font kit, out of scope here.
- NG5. **No change to the `captions` string field.** `scene.captions` stays the human-readable summary; `caption_segments[]` is the structured layer.

## 4. Current state (verified against the working tree — read these before building)

> ⚠️ **CLAUDE.md drift to know about.** Two claims in the relayed CLAUDE.md are stale: (a) it implies captions are advisory at COMPOSE-QC "with no `data-vob-overlay-id`-style binding" — in fact an opt-in `data-vob-caption-id` binding already exists (below); (b) plain `grep` over `mcp/lib/storyboard-schema.js` returns nothing because the file is classified as binary `data` (a non-ASCII byte trips grep's binary heuristic) — use `grep -a`, ripgrep, or Node to read it. Trust the code, not the prose.

### 4.1 Plan-side caption layer — `mcp/lib/storyboard-schema.js`

Exports (verified via `node -e "Object.keys(require('./mcp/lib/storyboard-schema.js'))"`): `CAPTION_ANIMATIONS`, `WORD_LEVEL_CAPTION_ANIMATIONS`, `captionSegmentsOf`, `validateStoryboard`, `validateStoryboardContent`, `lintStoryboardPlan`, `SCENE_TRANSITIONS`, `PLAN_LINT_THRESHOLDS`, … Relevant internals (line numbers approximate, current tree):

- `WORD_LEVEL_CAPTION_ANIMATIONS = new Set(["word-by-word", "karaoke"])` (~line 49) — the animations that need karaoke-grade per-word timing.
- `captionSegmentsOf(scene)` (~line 222) — returns object-form `caption_segments` (filters non-objects).
- `validateCaptionSegment(...)` (~line 232) — validates `text`, `start_seconds`/`end_seconds`, `emphasis_words[]`, `style_ref` ("a freeform handle into the design system's caption look, e.g. a `target.design.caption_style` name"), `position`, and the binding pair: an authored `id` (attribute-safe) "lands in `data-vob-caption-id`"; `exact:true` "is a binding contract — it must carry an attribute-safe `id`".
- Document-global caption-`id` uniqueness (~line 902): duplicate ids reject the save.
- `PLAN_LINT_THRESHOLDS` (~line 1011): `caption_chunk_max_words: 7`, `caption_chunk_max_chars: 42`, `caption_window_tolerance_s: 0.1`.
- Caption plan lints (~line 1482), **all warnings** (advisory): `PLAN_CAPTION_CHUNK_TOO_LONG`, `PLAN_CAPTION_EMPHASIS_NOT_IN_TEXT`, `PLAN_CAPTION_TIMING_DRIFT` (geometric — segment window vs the scene's clip windows, via `captionContainedInScene`, ~line 1498), and the alignment guard for word-level animations on a non-`transcript_aligned` plan (e.g. `PLAN_CAPTION_EXACT_UNALIGNED` / the karaoke-unaligned warning).
- `target.design` token block (~line 302) is **loosely shape-checked and NEVER lints** (`caption_style`/`motion`/`grade`); each preset carries a `design_default` in `mcp/lib/video-types.js` (~lines 81/96/109).

### 4.2 COMPOSE-side caption binding — `mcp/lib/composition-qc.js`

Already implemented ("Typed caption binding", ~lines 505–572), imported via `captionSegmentsOf` (line 14):

- Only caption segments with an **authored `id`** are checked (id-less are silent — no derived ids, so a re-chunked set never floods the report).
- `vob/caption_missing_element` (**error**) when `exact:true` and no element carries `data-vob-caption-id="<id>"`.
- `vob/caption_unbound` (**warning**) when an id is declared but unrealized and not `exact`.
- `vob/caption_element_untimed` (**warning**) when the bound element lacks `data-start`.
- `vob/unplanned_caption_element` (**warning**) when an element's `data-vob-caption-id` matches no planned caption.
- Findings are built by `makeFinding(severity, rule, message, file=null, line=null)` → `{severity, rule, message, file, line, column:null, source:"vob"}` (~line 88).

### 4.3 The runner chokepoint — `mcp/lib/hyperframes-runner.js`

ALL hyperframes calls go through `resolveHyperframesCmd()` (resolved once/process, run under our Node — no npx float). Argv builders today: `buildRenderArgv`, `buildLintArgv`, `buildSnapshotArgv`, `buildTranscribeArgv`. **There is NO `buildInspectArgv` — that is the gap.** Shared policy is applied by `hyperframesChildEnv()` (GPU mode via `resolveBrowserGpuMode()`, pinned engine, raised CDP/readiness timeouts) and `runHyperframesWithRetry()` (transient/infra retry; deterministic aborts not retried). `buildSnapshotArgv` (~line 234) is the closest model — `inspect`, like `snapshot`, is a *browser render* call (not pure-Node like `lint`).

### 4.4 The save → lint path — `save-composition.js` + `lint-composition.js`

- `vob_save_composition` (`mcp/lib/tools/save-composition.js`): validates files → runs static `runCompositionQc` (errors reject before the lock) → under the session lock wipes `compose/`, writes files, `recreateSourceSymlinks(id, composeRoot)`, **`injectFontKit(composeRoot, {skipCss})`** (lines ~181–185) → then, post-commit, `await lintCompositionTool.handler({project_id:id})` and returns the verdict (lines ~275–285). An infra failure there degrades to `lint_status:"unknown"` + `lint_error`; the save still stands.
- `vob_lint_composition` (`mcp/lib/tools/lint-composition.js`): runs `hyperframes lint --json` via `runHyperframesWithRetry`, re-runs static QC against disk truth (`runCompositionQc`, ~line 205), **merges** vob + hyperframes findings (dedupe in `dedupeHyperframesFindings`), writes `compose/lint-report.json` (`report_version: 2`), stamps `composition.lint_status`, returns `{lint_status, error_count, warning_count, findings_summary (≤10), report_path}`. **This is the single seam where the inspect pass belongs** (so both the save-time self-heal and the orchestrator fallback get it).

### 4.5 Font-kit vendoring precedent (the template for the caption kit)

- `scripts/build-fonts.js` (170 lines, zero-dep, Node ≥22 `fetch`): a `FAMILIES` manifest → fetches woff2 from @fontsource → writes `mcp/assets/fonts/*.woff2` + `mcp/assets/fonts.css` + `mcp/assets/fonts/LICENSES.md`. `--css-only` regenerates CSS without fetching. **The script is the source of truth; the assets are committed.**
- `injectFontKit(composeRoot, {skipCss})` in `mcp/lib/source-symlink.js` (~lines 205–236): symlinks `compose/fonts` → `mcp/assets/fonts` and copies `fonts.css` into `compose/`. Degrades gracefully (warn + `linked:false`) if assets are absent or the composer supplied its own.

### 4.6 Word-level transcript (for karaoke/word-by-word)

- INSPECT writes per-file word-level transcripts under `inspect/transcripts/file_<i>.json` and sets `state.inspect.transcript_aligned` (`mcp/lib/inspect.js` ~lines 1015/1319; surfaced in `session-state.js` ~line 238). `whisperx` gives karaoke-grade alignment (each word a real `start/end`); without it, timing is approximate and the plan-lint alignment guard fires.
- These transcripts are **not currently handed to the composer**. The composer spawn is data-only (project_id, paths, intent values, revision notes); it has no word timing today.

## 5. hyperframes capabilities leveraged (v0.6.97 — verified on the installed binary)

- **`hyperframes inspect [DIR]`** — renders the composition and reports text/container overflow. Flags: `--json` (agent-readable), `--samples=<n>` (midpoint samples across duration, default 9), `--at=<t1,t2,…>` (explicit seconds), `--at-transitions` (also sample at tween start/end boundaries — exactly where captions enter/exit), `--max-transition-samples=<n>`, `--tolerance=<px>` (overflow threshold, default 2), `--timeout=<ms>` (runtime init, default 5000), `--max-issues=<n>` (default 80), `--collapse-static=true|false` (default true), `--strict` (fail on warnings — **we will NOT use this**; we fold findings ourselves).
- **15 built-in caption components**, installable via `hyperframes add <name>` (`--dir`, `--no-clipboard`, `--json`): `caption-pill-karaoke`, `caption-highlight`, `caption-editorial-emphasis`, `caption-kinetic-slam`, `caption-weight-shift`, `caption-gradient-fill`, `caption-clip-wipe`, `caption-neon-glow`, `caption-neon-accent`, `caption-glitch-rgb`, `caption-matrix-decode`, `caption-emoji-pop`, `caption-parallax-layers`, `caption-particle-burst`, `caption-texture`. They are authored to pass hyperframes' own caption lint rules.
- **Deterministic text measurement** available in the render runtime: `window.__hyperframes.fitTextFontSize(text, {maxWidth, fontFamily, fontWeight})` and `window.__hyperframes.pretext.prepare(text, font)` (layout without DOM reflow). Components use these; we get them for free by referencing the components, and `inspect` reflects their effect.
- **Karaoke** is per-frame word highlighting driven by an inline `[{text,start,end}]` transcript with a hard `tl.set()` kill at exit — i.e. it consumes exactly the word-level transcript bob's P1 alignment produces.

## 6. Proposed design

Five seams: **runner**, **vendored kit**, **layout QC fold-in**, **composer enablement**, **schema (no change)**.

### 6.1 Engine — `buildInspectArgv` + an inspect runner (`mcp/lib/hyperframes-runner.js`)

Add an argv builder and a thin async runner that reuse the shared env/retry policy (model on `buildSnapshotArgv` and `runHyperframesWithRetry`). `inspect` is a *browser* call, so it inherits `hyperframesChildEnv()` (software GPU on darwin, raised timeouts) and a snapshot-like retry budget (transient launch flakes retried; a found-issues report — exit ≠ 0 with valid JSON — is **not** retried, mirroring the lint rule that a found-errors report is deterministic).

```js
// timecodes optional; default to evenly-spaced samples + transition boundaries.
function buildInspectArgv({ composeRoot, samples = 6, timecodes = null, tolerancePx = 2 }) {
  const argv = ["inspect", "--json", "--at-transitions", "--tolerance", String(tolerancePx)];
  if (Array.isArray(timecodes) && timecodes.length > 0) {
    argv.push("--at", timecodes.map(String).join(","));
  } else {
    argv.push("--samples", String(samples));
  }
  argv.push(composeRoot);
  return argv;
}

async function runInspect({ composeRoot, samples, timecodes, tolerancePx, timeoutMs }) {
  return runHyperframesWithRetry(
    buildInspectArgv({ composeRoot, samples, timecodes, tolerancePx }),
    {
      cwd: composeRoot,
      timeoutMs: timeoutMs || INSPECT_TIMEOUT_MS,   // new const; ~3–5 min, scaled like snapshot
      captureStdoutViaFile: true,                    // JSON report can exceed the 8 KiB sync-pipe trap
      maxAttempts: 3,
      retryTimedOut: false,
    },
  );
}
```

Export both; add `INSPECT_TIMEOUT_MS` (+ a `VOB_INSPECT_TIMEOUT_MS` override, following the existing timeout-knob convention). Add a `parseInspectReport(stdout)` helper (or extend `mcp/lib/lint-report.js`) that tolerates the same truncation/parse failure modes `parseLintReport` handles.

### 6.2 Engine — vendored caption kit (`mcp/assets/captions/` + `scripts/build-captions.js`)

Mirror the font kit exactly. **Build-time** (network allowed, like @fontsource fetches) materializes the components; **run-time** is offline (vendored, committed).

`scripts/build-captions.js` (zero-dep, Node ≥22):
1. `COMPONENTS` manifest — the list above, each with: `name`, the `animation` value(s) it realizes, `word_level: bool`, the data-attributes/markup contract it expects, and license/attribution.
2. For each component: scaffold a throwaway project in a temp dir (`hyperframes init --non-interactive --skip-transcribe --skip-skills`), run `hyperframes add <name> --dir <tmp> --no-clipboard --json`, and copy the materialized component file(s) into `mcp/assets/captions/<name>/` (CSS + JS module + a short `SPEC.md` describing required markup, data attributes, and which `target.design` tokens feed it). The hyperframes calls go through the same `resolveHyperframesCmd()` policy.
3. Write `mcp/assets/captions/manifest.json`:
   ```json
   {
     "generated_with_hyperframes": "0.6.97",
     "animations": {
       "pop":          { "default": "caption-highlight", "alternates": ["caption-editorial-emphasis", "caption-gradient-fill"] },
       "word-by-word": { "default": "caption-kinetic-slam", "alternates": ["caption-weight-shift"] },
       "karaoke":      { "default": "caption-pill-karaoke", "alternates": [] }
     },
     "components": {
       "caption-pill-karaoke": { "word_level": true, "needs_transcript": true, "files": ["style.css","karaoke.js"], "design_tokens": ["caption_style","palette.accent","typography.caption_family"] }
     }
   }
   ```
4. Write `mcp/assets/captions/LICENSES.md` (attribution per component — **open question §11, resolve before vendoring**).
5. `--manifest-only` flag to regenerate `manifest.json`/`LICENSES.md` without re-fetching (mirrors `--css-only`).

`injectCaptionKit(composeRoot, {skip})` in `mcp/lib/source-symlink.js` (next to `injectFontKit`): symlink `compose/captions` → `mcp/assets/captions` and copy `manifest.json` to `compose/captions/manifest.json`. Same graceful degradation (warn + `linked:false` if assets absent or the composer wrote its own `captions/`). Call it from `saveComposition` right after `injectFontKit` (line ~184), pushing its warnings into `symlinkResult.warnings`, and add `captions: { linked }` to the composition slot alongside `fonts`.

The composer references `./captions/<name>/style.css` + script, writes the per-caption *markup* (the text chunks, `data-vob-caption-id`, `data-start`/`data-duration`), and pulls the vetted *motion* from the kit. This preserves composer freedom (re-chunk/re-time) while the styling/animation is lint-clean by construction.

### 6.3 Engine — layout/legibility QC fold-in (`mcp/lib/tools/lint-composition.js`)

After the static `runCompositionQc` (~line 213) and before computing `lintStatus`, run the inspect pass and fold its overflow issues into `findings` as **warnings**:

```js
// Gated: only spend a browser render when there's something to measure
// (captions or typed overlays in the active scope), unless VOB_LAYOUT_QC=always.
// Non-fatal: an infra failure degrades to a single advisory note, never fails the lint.
let inspectFindings = [];
if (shouldRunLayoutQc(storyboard, composition) && layoutQcEnabled()) {
  try {
    const ins = await runInspect({ composeRoot });
    if (!ins.timed_out) {
      const report = parseInspectReport(ins.stdout);
      inspectFindings = mapInspectIssues(report, { compositionFiles: qcFiles, storyboard });
    } else {
      inspectFindings = [makeAdvisory("vob/layout_qc_skipped", "hyperframes inspect timed out — layout/legibility not verified")];
    }
  } catch (err) {
    inspectFindings = [makeAdvisory("vob/layout_qc_skipped", `layout QC did not run: ${err.message || err}`)];
  }
}
const findings = [...qc.findings, ...inspectFindings, ...hfFindings];
```

`mapInspectIssues` maps each hyperframes inspect issue → a `source:"vob"` warning:
- text/element overflow whose element carries `data-vob-overlay-id` or `data-vob-caption-id` → `vob/caption_overflow` (warning) with the caption/overlay id and the `file:line` when resolvable.
- any other text/container overflow → `vob/layout_overflow` (warning).
- never an error (NG4/G4) — a too-tight safe area is a judgment call, and `inspect` tolerance is a heuristic.

Bump `report_version` to `3` and add an `inspect: { ran, samples, issue_count, skipped_reason? }` block to `lint-report.json` (back-compatible: absent ⇒ not run). Counts: add `inspectFindings` warnings into `warningCount`. Because errors still gate COMPOSE→PREVIEW and these are warnings, **the gate semantics do not change**.

**Cost control (load-bearing — see §10):** `shouldRunLayoutQc` returns false when the active scope has no caption_segments and no typed overlays (nothing geometric to verify). `layoutQcEnabled()` reads `VOB_LAYOUT_QC` (`auto` default = the gating above; `always`; `off`). Bound the render with a small `--samples` (default 6) plus `--at-transitions`. This keeps the common no-caption render untaxed and the captioned render bounded.

### 6.4 Adapter — composer enablement

- **`adapters/claude-code/.claude/agents/composer.md`**: document the kit. "When a scene has `caption_segments[]`, read `./captions/manifest.json`, pick the component for the segment's `animation` (honoring `style_ref`/`target.design`), reference its CSS/JS, and author the markup: one timed `.clip` element per chunk with `data-start`/`data-duration`; stamp `data-vob-caption-id="<id>"` on segments that carry an authored `id`. For `word-by-word`/`karaoke`, inline the word-level transcript slice provided in the spawn and follow the component's per-word contract. If the spawn says the transcript is **not aligned**, downgrade word-level animations to chunk-level `pop` (the plan already warns; don't fight it)."
- **`adapters/claude-code/.claude/skills/vob/references/lint-rules.md`**: add per-component realization recipes (markup skeleton per `animation`), emphasis-word styling (map `emphasis_words[]` → the component's per-word emphasis hook — brand/number/CTA treatments), and the karaoke wiring, plus fix recipes for the new `vob/caption_overflow` / `vob/layout_overflow` codes (shorten the chunk / drop font-size via the component's fit hook / move off the safe band).
- **`adapters/claude-code/.claude/skills/vob/phases/COMPOSE.md`** + the orchestrator's composer-spawn construction: when the active scope has any `word-by-word`/`karaoke` segment, include in the (data-only) spawn the path(s) to the relevant `inspect/transcripts/file_<i>.json` for the active scenes' clips and the `state.inspect.transcript_aligned` flag. (Resolve file index via the scene's `source_clips` → manifest file mapping.)
- Run **`node scripts/port-adapter-docs.js`** to regenerate the OpenCode mirrors (`.opencode/vob/**`) from the claude-code sources, per the build command in CLAUDE.md.

No `allowed-tools`/`settings.json` permission changes: no new MCP tool is added (the inspect pass lives inside the existing `vob_lint_composition` / `vob_save_composition` handlers). If §11's open question lands on a *separate* `vob_inspect_layout` tool instead, then the tool-registration checklist in CLAUDE.md applies (module + `TOOL_MODULES` + `role_bundles` + both adapter allow-lists).

### 6.5 Schema — already in place (no change required)

Everything the plan layer needs already validates in `storyboard-schema.js`: `animation`, `emphasis_words`, `style_ref`, `position`, `id`, `exact`. **Do not add a version gate or a `v12`-style flag** — these are additive, non-version-gated like `target.fps` (per the v3.2 invariant). The only *optional* additive considered and **rejected** for now: a `caption_segments[].component` override (let the storyboarder pin a specific kit component). Rejected because `style_ref` already covers intent and component choice is a composer/COMPOSE concern; revisit only if real plans need to pin motion.

## 7. Implementation plan (phased — each phase a coherent commit)

- **Phase 1 — runner plumbing.** Add `buildInspectArgv`, `runInspect`, `INSPECT_TIMEOUT_MS` + `VOB_INSPECT_TIMEOUT_MS`, and `parseInspectReport` to `mcp/lib/hyperframes-runner.js` (+ `lint-report.js` if extending). Export them. No behavior change yet. *Verify:* unit-call `buildInspectArgv` shapes; run `runInspect` against an existing `compose/` from a walker run.
- **Phase 2 — vendored caption kit.** `scripts/build-captions.js` + commit `mcp/assets/captions/**` (+ `manifest.json`, `LICENSES.md`). `injectCaptionKit` in `source-symlink.js`; call it from `saveComposition`; add `captions:{linked}` to the composition slot + history. *Verify:* a save symlinks `compose/captions` and copies the manifest; absent-assets degrades to a warning.
- **Phase 3 — layout/legibility QC fold-in.** `shouldRunLayoutQc`, `layoutQcEnabled` (`VOB_LAYOUT_QC`), `mapInspectIssues`, the fold into `lint-composition.js`, `report_version: 3` + `inspect{}` block. *Verify:* a deliberately-overflowing caption produces a `vob/caption_overflow` warning; a clean one doesn't; `lint_status` stays `errors` only on real errors (warnings don't gate).
- **Phase 4 — composer enablement.** `composer.md`, `lint-rules.md`, `COMPOSE.md`, the spawn transcript-path threading; `node scripts/port-adapter-docs.js`. *Verify:* boot drift guard (`verifyAdapterToolReferences`) still passes; OpenCode mirrors regenerated.
- **Phase 5 — walker `captions` phase + docs.** New `scripts/m5-walker.js` phase (§8). Update CLAUDE.md's COMPOSE/QC invariants and the walker phase list. *Verify:* `node scripts/m5-walker.js captions` green.

Phases 1–3 are engine-only and independently shippable; 4–5 light them up end-to-end.

## 8. Testing & verification

**New walker phase `captions`** in `scripts/m5-walker.js` (model on the existing `overlays`/`gaps` phases, ~lines 1660–2020, which boot through the shared bootstrap at ~line 932 and assert plan-lint + save outcomes). It should:

1. Build a single-timeline storyboard whose scenes carry `caption_segments[]` exercising all three `animation` values, `emphasis_words[]`, an authored `id` + `exact:true` on one segment, and a `style_ref` into `target.design.caption_style`.
2. **Positive path:** save a plan-lint-clean storyboard; transition to COMPOSE; save a composition that references the kit and stamps `data-vob-caption-id` on the `exact` segment. Assert: `captions.linked === true`, `compose/captions/manifest.json` exists, `lint_status` is `clean`/`warnings_only` (no errors), and `lint-report.json` has `report_version: 3` with an `inspect{}` block.
3. **Negative path A (binding):** omit the element for the `exact` segment → assert a `vob/caption_missing_element` **error** (already-shipped binding; guards regression).
4. **Negative path B (overflow):** author a caption chunk with a huge word at a large font on a narrow canvas → assert a `vob/caption_overflow` **warning** appears (proves the `inspect` pass fires and maps) and that it does **not** push `lint_status` to `errors`.
5. **Alignment fallback:** with `state.inspect.transcript_aligned !== true`, assert the plan-lint word-level alignment warning still fires (regression guard) and document the composer fallback.

Gate the heavy steps behind the walker's existing env gating (real renders only when `VOB_WALKER_SOURCE`/the heavy flag is set), but make the inspect-overflow assertion runnable on a tiny synthetic composition so it's cheap in CI-less local runs. **Real-video check:** one manual `/vob` run on a talking-head clip with `whisperx`-aligned transcript, confirming a karaoke caption renders word-synced and `inspect` flags a genuine overflow when forced.

## 9. Risks & open questions

- **R1 — inspect cost per lint.** `inspect` is a browser render (N sample frames); on the 8 GB Mac wall this is non-trivial. *Mitigation:* gate on captions/overlays present, bound `--samples`, non-fatal degrade, `VOB_LAYOUT_QC=off` escape hatch. *Open:* fold into the lint path (this PRD) vs a **separate `vob_inspect_layout` tool** the orchestrator calls once at PREVIEW (mirrors `vob_qc_stills`). Leaning fold-in for the self-heal benefit, but the separate-tool option is cleaner for cost and is the fallback if save-time renders prove too slow.
- **R2 — caption-component licensing.** Must capture attribution (`LICENSES.md`) before vendoring; confirm the components are redistributable. Blocks Phase 2.
- **R3 — `hyperframes add` output stability.** The materialized component shape may change across hyperframes versions. *Mitigation:* the build script pins `generated_with_hyperframes` in the manifest; re-running the script is the refresh path (like `build-fonts.js`). bob pins its hyperframes binary, so runtime/kit stay in lockstep within a session.
- **R4 — component ↔ runtime API coupling.** Components call `window.__hyperframes.*`; those exist only in the hyperframes render runtime (fine — bob renders through hyperframes) and not at lint time (fine — lint is static). Verify a vendored karaoke component renders under bob's pinned binary.
- **R5 — CJK measurement.** The char-count heuristic is wrong for CJK; `inspect` measures real geometry, so it's the *better* check for bilingual/中文 briefs — but confirm `inspect` handles the CJK fonts in the kit. (Strengthens the case for inspect over the heuristic.)
- **R6 — transcript→scene mapping.** Threading the right `inspect/transcripts/file_<i>.json` to the composer requires mapping a scene's `source_clips` to manifest file indices. Confirm that mapping is already derivable (it is, via the manifest the symlink layer reads) and keep the spawn data-only.

## 10. Philosophy fit

- **Zero-dep:** the kit is *vendored assets* (committed CSS/JS), built by a Node-only script using global `fetch` + the already-required hyperframes CLI at build time. **No npm dependency added** — identical posture to `build-fonts.js`.
- **One runner:** `inspect` flows through `resolveHyperframesCmd()` / `hyperframesChildEnv()` / `runHyperframesWithRetry()` — no new spawn path, no npx, inherits the GPU/timeout/retry policy.
- **Advisory-caption invariant preserved:** binding stays opt-in; the new inspect findings are warnings; the only error remains the pre-existing `exact:true` contract. No new gate, no FSM edge.
- **Native render:** `inspect` runs locally under the same software-GPU/low-RAM policy; nothing leaves the host (no Gemini `--describe`, no cloud).
- **Output over hygiene:** this is squarely an output-quality lever — better-looking, lint-clean captions and a real legibility guard — not eng-hygiene busywork.

## 11. Out of scope / future

- **Parametrized caption rendering via `--variables`/`--batch`** (one template, many language/variant renders) — a separate, more invasive idea; note it composes with this kit.
- **`tts` (local Kokoro VO)** and **cloud/off-host render** — explicitly parked (philosophy decisions pending).
- **Scene transitions** ([`02-scene-transitions.md`](./02-scene-transitions.md)) and **subject compositing / `remove-background`** ([`03-subject-compositing.md`](./03-subject-compositing.md)) — sibling PRDs; the `inspect`/runner plumbing in Phase 1 is shared infrastructure they can reuse.
- **`snapshot --describe` (Gemini vision QC)** — deliberately not used; bob's orchestrator is multimodal and reads snapshot PNGs directly without an external dependency.
