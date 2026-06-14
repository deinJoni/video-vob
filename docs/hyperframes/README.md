# Leveraging hyperframes more — PRD set

*Derived from a hyperframes **v0.6.97** capability audit + this repo's architecture (2026-06-14).*

## Why this set exists

bob currently drives hyperframes as a glorified **HTML→MP4 renderer + linter + stills tool**: it calls only `render`, `lint`, `snapshot`, and (as an ASR fallback) `transcribe` — **4 of ~10 subcommands**, and roughly **30% of `render`'s flags**. All editorial/audio/encoding muscle (assembly, mixing, ducking, loudnorm, overlay compositing, clip pre-cutting) is routed through ffmpeg.

These three PRDs expand the **output-quality** surface using capabilities already present in the installed binary — three pillars of motion-graphics polish: **text, motion, subject.**

## The PRDs (in recommended build order)

| # | File | Theme | Status |
|---|------|-------|--------|
| 1 | [`01-caption-system-v2.md`](./01-caption-system-v2.md) | Realize the v3.2 caption plan on the COMPOSE side with hyperframes' vendored caption kit + `hyperframes inspect` legibility QC + deterministic text measurement | Proposed |
| 2 | [`02-scene-transitions.md`](./02-scene-transitions.md) | Widen `scene.transition_in` to hyperframes' CSS/shader transition vocabulary (intra-composition), glue-pack render segments, seams stay cut/dip-to-black | Proposed |
| 3 | [`03-subject-compositing.md`](./03-subject-compositing.md) | `render_mode: "subject"` via `remove-background` matte, content-hash-cached COMPOSE-entry step, ingested-only backdrops enforced in schema | Proposed |

## Recommended build order & why (1 → 2 → 3, low → high risk)

1. **#1 Captions first** — lowest risk, mostly additive, the biggest *visible* quality bump, and it builds the `buildInspectArgv` + fold-into-merged-lint QC infra that the other two reuse. Also closes the deferred `steps67-autoqc` safe-area/legibility gap.
2. **#2 Transitions second** — widens an *existing* field rather than adding one; its Phase-0 spike (how GSAP reaches a composition → the vendoring mechanism) de-risks any vendoring #3 needs.
3. **#3 Subject last** — heaviest (new preprocessing pipeline + tool surface + downloaded model weights), highest risk; benefits from #1's QC patterns and #2's vendoring patterns being in place first.

## Shared conventions every PRD respects

- **Engine zero-dep** — vendored assets (`mcp/assets/`), never an npm dependency; transition/caption libs load *inside the composition* (the browser hyperframes drives), like the font kit and GSAP.
- **One-runner chokepoint** — every new hyperframes call (`inspect`, `remove-background`) flows through `hyperframes-runner.js::resolveHyperframesCmd` + `hyperframesChildEnv`.
- **FSM two-file rule** where any edge/gate is touched (`session-state.js` + `phase-gates.js` must agree).
- **Additive, fail-safe, non-version-gated schema** — like the v3.2 caption/design/pacing fields.
- **Advisory (warnings-only) QC** for the creative layers — never a hard block.
- **`scripts/m5-walker.js` phase as the integration test** — there is no unit suite.
- **Native render on host** — no Docker, no off-host.

## Cross-cutting build notes

- **Building all three in parallel** — the 1→2→3 build order assumed shared infra would land in sequence; under parallel work, coordinate it explicitly:
  - **Commit these docs to the base branch (`v3/general-video`) *before* you branch / `git worktree add`** — uncommitted changes don't reliably follow a new worktree, and you want all three branches to inherit the PRDs + this note.
  - **Give #1 ownership of the shared infra:** (a) the `hyperframes inspect` → one-runner → fold-into-merged-lint QC path, and (b) the asset-vendoring + save-time-copy pattern (`build-*.js` mirroring `build-fonts.js`, `injectFontKit`-style copy, `source-symlink.js`). #2 (shader-transition vendoring) and #3 (matte materialize) should build against those interfaces / rebase on #1 early — don't invent parallel copies.
  - **Expect mechanical (additive, same-file-different-region) conflicts** in: `scripts/m5-walker.js` (each adds a phase + dispatch entry), `mcp/lib/hyperframes-runner.js` (argv builders + exports), `mcp/lib/storyboard-schema.js` `lintStoryboardPlan` (#2 transition vs #3 subject rules), `mcp/lib/video-types.js` (presets/vocab), `source-symlink.js` (save-time copy), and the composer agent `.md` + `lint-rules.md` (each appends its own recipe). Keep edits in clearly-delimited regions; no *design* overlap is expected.
- **GOTCHA:** plain `grep` treats `mcp/lib/storyboard-schema.js` as **binary** (a non-ASCII byte) and **silently returns nothing** — no error. Use `rg`, `grep -a`, or Node to search it. `SCENE_TRANSITIONS`, the `PLAN_CAPTION_*`/`PLAN_OVERLAY_*` rules, and the typed-overlay/caption bindings all live there.
- **Doc drift to fix:** #1's brief premise was partly stale — the `data-vob-caption-id` binding (incl. `exact:true`→error) and the `PLAN_CAPTION_*` layer **already exist** in `composition-qc.js` + `storyboard-schema.js`. The PRD leverages them; CLAUDE.md's prose on where they live is slightly off — **verify against `composition-qc.js` and correct CLAUDE.md inside #1's branch** (it's caption-related; don't land a standalone CLAUDE.md edit mid-parallel).

## Parked / not in this set

- **Audio-reactive montage preset** — natural sibling to #2 (motion driven by the footage's own audio bands); future.
- **`--variables` + `--batch` fan-out re-architecture** — an *efficiency/scale* play (cheaper to make many variants), not output quality; revisit for multi-language / volume.
- **Off-host render (`cloud` / `lambda` / `cloudrun`)** — attacks the 8 GB-Mac render wall but **gated on the "native on host" decision** (is that rule "no Docker" or "no off-host"?).
- **Local `tts` (Kokoro)** — gated on the AI-narration philosophy question (it's local, but generated narration is a different line than transforming your own footage).
- **Dropped as redundant/off-fit:** `snapshot --describe` (bob is multimodal — read the PNGs), hyperframes `doctor` (ours is richer), `capture`/`publish`, HTML-in-Canvas/3D/HDR (fragile on the 8 GB Mac), `--docker` (banned).
