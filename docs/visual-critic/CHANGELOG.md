# v3.9.1 — COMPOSE / visual-critic: an independent vision critic for the rendered look

v3.9 added three independent-critic / taste levers (take-quality at INSPECT, the
`editorial-critic` at PLAN, the design-system kit at COMPOSE). The one thing none of
them added was an **independent check that the rendered frames actually look good** —
that the design floor *held* in pixels. The COMPOSE self-QC loop *did* read stills and
judge them, but that judgment was **self-assessment by the invested party** (the same
orchestrator that shepherded the composition, in its own budget-pressured context) —
exactly the pre-v3.9 state of PLAN before the editorial-critic. v3.9.1 applies the
independent-critic thesis to the pixels, and closes the deterministic caption-contrast
("QC-B ceded to the human") gap. Additive, advisory, fail-safe; no new FSM edge, no new
gate, no new/renamed required intent key, no new MCP tool. (3.9.0 → 3.9.1)

## Pillar A — the `visual-critic` subagent (the pixels twin of `editorial-critic`)

- **New read-only multimodal subagent** (`agents/visual-critic.md`, both adapters) —
  a near-exact clone of `editorial-critic`: `tools: [Read, mcp__vob__vob_read_state_summary]`,
  `model: opus`, holds NO mutating tool (it returns its verdict as its final message, so it
  needs no entry in any tool's `role_bundles`). Spawned in the **COMPOSE self-QC loop**,
  after a lint-clean save and over the full-res snapshot PNGs, **before** the human sees the
  cut and before a 15–30 min draft render. It scores six dimensions — Legibility, Safe-area,
  Collisions, Hook frame, Framing, Polish — `strong|ok|weak`, returns
  `VERDICT: SHIP|REVISE` + per-finding `visual/*` codes tagged `glaring|taste` + a `TOP FIX`,
  and judges against a fixed rubric (`references/visual-quality.md`), not its own taste.
- **Token isolation** — the frame-image tokens (~1.1–1.6k each) live in the critic's
  throwaway context, not the long-lived orchestrator transcript.
- **COMPOSE wiring** (`phases/COMPOSE.md` self-QC section) — the orchestrator's inline
  image-read + QC-A…F judgment is reframed as the FALLBACK: snapshot + `vob_qc_stills`
  (unchanged) → **spawn the visual-critic** → act on the verdict with **≤1** critic-driven
  composer fix (mirrors PLAN step 6c) → `SHIP`/`taste` ride to the gate as `⚠ visual:` notes.
  A critic error / unparseable / unavailable / `visual_critic_mode: off` → **fall back to the
  inline self-QC**, never block. Budgets stay separate: critic ≤1 fix; inline self-QC ≤2
  rounds; lint ≤3 retries (settles first). The human PREVIEW approval is untouched.
- **Knob `VOB_VISUAL_CRITIC`** = `auto` (default — spawn when the active scope carries
  captions / typed overlays / a `target.design` look, like `VOB_LAYOUT_QC`) | `always` | `off`.
  Resolved engine-side and surfaced as `read_state_summary.visual_critic_mode` so the
  orchestrator (which cannot read `process.env`) can honor it.
- **Registration** — `+visual-critic` in `VALID_ROLE_BUNDLES` (`tool-registry.js`); agent
  files in BOTH adapters (the boot reverse-check); `port-adapter-docs.js` extended
  (`+visual-critic` subagent, `+visual-quality.md` reference) and run. Boot integrity green.

## Pillar B — deterministic caption-contrast (the walker-testable companion)

- **New `mcp/lib/visual-legibility.js`** (pure + one injectable impure helper) — the engine
  half, closing the QC-B gap: a WCAG-ish `contrastRatio`, sRGB/luma relative-luminance,
  CSS-color parsing (`parseColorLuma`), caption-band geometry from the platform profile
  (`captionBandRect`), timecode→scene mapping (`sceneAtTime`/`sceneHasCaptions`), threshold
  resolution + classification (`classifyCaptionContrast`), and the orchestration entrypoint
  `evaluateStillCaptionContrast`. Because `hyperframes inspect` only reports geometry for
  *overflowing* elements, the check samples the **platform caption safe-band region** of the
  still (not exact per-caption boxes) and only on stills whose timecode lands in a
  caption-bearing scene — keeping it pure-ffprobe (no browser) and low-false-positive.
- **`signalstatsLuma` gains an optional `crop` region** (`ffprobe.js`) — `movie=…,crop=w:h:x:y,signalstats`,
  degrade-don't-die, whole-frame default unchanged (every existing caller is byte-identical).
- **Folded into `vob_qc_stills`** — `qc/caption_low_contrast` findings (`taste` by default;
  `glaring` only below the hard floor AND when the caption text color is *declared*, never on
  an assumed-white guess), riding the existing glaring → composer-auto-fix / taste → user-note
  routing. **Never an error** — the COMPOSE→PREVIEW gate (errors only) is unchanged. Report
  gains `caption_contrast_count` + `contrast_checked`. Degrades to a no-op (emits nothing) on
  any missing input (no platform dims, no storyboard, no aligned timecodes, an unprobeable
  region). Knobs: `VOB_QC_CONTRAST_GLARING` (2.0), `VOB_QC_CONTRAST_TASTE` (3.0).

## Pillar C (deferred)

- Motion-aware PREVIEW pass over sampled draft-render MP4 frames (incl. at transition/caption
  onsets). Not in v1 — the per-frame still dimensions cover the bulk; the agent file + rubric
  are written to generalize to it.

## Testing / tooling

- **Walker `visualqc` phase** (`node scripts/m5-walker.js visualqc`) — a source-free unit
  harness over `visual-legibility.js`: the contrast math (endpoints + monotonicity), color
  parsing, band geometry (vertical/landscape/anchors/degrade), timecode→scene mapping,
  thresholds + classification (glaring needs a KNOWN color), the spawn-gate knob, and the
  evaluate-with-injected-signalstats orchestration incl. every degrade path. Model-free
  regression test (the critic itself is verified by live runs + boot integrity, like
  editorial-critic).
- **Live-verified** — the real `signalstatsLuma` crop path discriminates a split white/black
  still (left yavg 253 vs right 0). Sibling source-free phases (`stillsqc`/`editorial`/
  `takequality`/`spans`) regress clean after the `ffprobe`/`qc-stills`/`session-state` edits.

## Files

`mcp/lib/visual-legibility.js` (new), `mcp/lib/ffprobe.js` (crop option),
`mcp/lib/tools/qc-stills.js` (contrast fold-in), `mcp/lib/session-state.js`
(`visual_critic_mode` surfaced), `mcp/lib/tool-registry.js` (`visual-critic` bundle), the new
`agents/visual-critic.md` + `references/visual-quality.md` (both adapters),
`phases/COMPOSE.md` (self-QC rewrite), `scripts/port-adapter-docs.js`,
`scripts/m5-walker.js` (`visualqc` phase), and the `3.9.1` version bump (`.vob/VERSION`,
`package.json`, `mcp/server.js`).
