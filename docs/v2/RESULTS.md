# v2 RESULTS — token / byte accounting

Measured at Wave-3 verification (2026-06-10), repo worktree on `v2/fable-rework` with WP1–WP7
landed (uncommitted). "Before" = git HEAD (v1, 93d0dd1). Method: see bottom.

## tools/list bytes

| | bytes | ~tokens |
|---|---|---|
| before (HEAD) | 22,472 (spec's quoted 22,502 was a near-miss; this is measured) | ~5.6k |
| after (v2) | 18,640 | ~4.7k |
| delta | −3,832 B (−17.1%) | |

Billed on every conversation start (orchestrator + each subagent spawn sees its scoped subset).

## SKILL.md + phase files — CUMULATIVE per clean run

Per-file (claude-code adapter, `wc -c`):

| file | bytes |
|---|---|
| SKILL.md (spine) | 13,883 (v1: 54,800) — ceiling 19,000 ✓ |
| phases/INGEST.md | 1,350 |
| phases/INSPECT.md | 7,277 |
| phases/INTENT.md | 7,533 |
| phases/PLAN.md | 7,221 |
| phases/COMPOSE.md | 8,576 |
| phases/PREVIEW.md | 3,564 |
| phases/RENDER.md | 3,361 |
| phases/PACKAGE.md | 4,258 |
| phases/ITERATE.md | 1,833 |
| **nine phases combined** | **44,973** — hard ceiling 45,000 ✓, goal 40,000 ✗ (spec's own per-file estimates sum to ~44,800) |
| references/brief-design.md | 3,830 (read once, in PLAN) |
| references/lint-rules.md | 6,579 (retry-only; NOT on the clean path) |

Cumulative Read bill on a CLEAN run (spine once + each phase file once + brief-design once):

- **v2 clean run: 13,883 + 44,973 + 3,830 = 62,686 B ≈ 15.7k tokens**
- v1 clean run: 54,800 B ≈ 13.7k tokens (spine only, everything inline)

**Honest accounting: a full clean run is ~14% MORE static-prose bytes than v1.** The restructure
is roughly token-neutral-to-slightly-negative on the full happy path, exactly as the spec
predicted — booking "54.8KB → 13.9KB" as the win would overstate it. The real wins:

- **Short/aborted sessions**: a session that dies at PLAN sign-off reads
  13,883 + 1,350 + 7,277 + 7,533 + 7,221 + 3,830 = 41,094 B (~10.3k t) vs v1's 54,800 B — and a
  session that never leaves INGEST reads 15,233 B vs 54,800 B.
- **Resume / back-edge re-entry**: the spine re-bill is 13,883 B, not 54,800 B; the read-once
  rule (skip if already in context) means back-edges within one conversation re-read only the
  target phase file (≤8,576 B), not everything.
- **lint-rules.md (6,579 B) bills only when a lint/QC retry actually happens.**

OpenCode mirror totals for the record: spine (agents/vob.md) 14,964 B (v1: 56,188);
nine phases 45,514 B — 514 B over the 45,000 ceiling, the overage being the spec-mandated
OpenCode long-render-timeout block in RENDER.md (~720 B) + one PACKAGE escape-hatch clause;
references byte-identical to claude-code.

## agent prompts

| file | before (HEAD) | after | budget |
|---|---|---|---|
| claude-code inspector.md | 6,897 | 9,762 | target ≤9,000 ✗ (+762; declared — spec-protected verbatim blocks) |
| claude-code storyboarder.md | 15,294 | 18,613 | target ≤17,000 ✗ (+1,613; declared) |
| claude-code composer.md | 36,126 | 24,570 | §5.6 ceiling ≤24,000 ✗ (+570), §2.7 target ≤23,000 ✗; still −32% vs v1 |
| 3-agent total | 58,317 | 52,945 | −9.2% |
| opencode inspector.md | 7,071 | 9,934 | (twin + OpenCode frontmatter) |
| opencode storyboarder.md | 15,489 | 18,786 | |
| opencode composer.md | 36,333 | 24,733 | |

Inspector/storyboarder grew by design (v2 adds visual grounding, hook tagging, keep-span
snapping, strips protocol); composer shed the bulk of v1's inline lint lore to lint-rules.md.

## per-run dynamic estimate

Measured live on the `verify-wave3` walker session (full envelope JSON bytes):

| call | bytes/call | ~tokens |
|---|---|---|
| `vob_read_state_summary` | 4,842 | ~1.2k |
| `vob_read_state` (default digests) | 5,663 | ~1.4k |
| `vob_read_state` (include history+clips+deps) | 11,087 | ~2.8k |

A v1 `read_state` echoed the whole state document (~25–35k B late-pipeline, per the brief);
the v2 digest defaults + lean tool returns (transition_phase returns no state echo, lint/save
return ≤10 findings + a report path) carry the echo budget from ~25–35k B → ~5k B per
touchpoint. Image reads (the other >50% carrier, per D1+D8): INSPECT thumbs are downscaled to
480px wide (measured 480×854 on a 9:16 source) and segment keyframes to 512px (measured
512×910); per-file contact strips (3 cols portrait / 4 cols landscape, ≤9/≤12 cells, cell
width 512 — `segment-signals.js`) replace N single-frame reads with one tiled read. Spec
estimate stands: images ~60–90k t (v1 full-res habit) → ~12–20k t (v2 strips + downscale);
confirm on the first live footage run at integration.

## snapshot contact-sheet geometry

Measured on the walker session (1080×1920 composition, `vob_snapshot_keyframes`, 3 stills):

- COMPOSE contact sheet `compose/snapshots/contact-sheet.jpg`: **1816×1101** for 3 portrait
  stills → ~605×1067 per cell (3 cols, row-major), 123 KB on disk.
- Full-res stills: 1080×1920 PNG (306–359 KB for content-bearing frames).
- INSPECT per-file contact sheet (single-segment clip, no strips): 1600×1138; strips are only
  built at ≥2 cells (`STRIP_MIN_CELLS`), legend at `inspect/strips/legend.json`.

This grounds the COMPOSE self-QC read plan: read the sheet (one image, ~605px-wide cells —
enough for layout/safe-area checks) + the two mandatory full-res stills (hook frame, first
caption-dense frame); ≤4 full-res singles per round, ≤2 rounds.

## method

- tokens = bytes/4 (prose); image token costs are model-side estimates, not byte-derived.
- tools/list measured via
  `node -e "const {TOOLS}=require('./mcp/lib/tool-registry.js');console.log(JSON.stringify(TOOLS).length)"`
  (before: same one-liner in a temp `git worktree` at HEAD).
- File sizes via `wc -c`; image dimensions via `sips`; dynamic call sizes =
  `JSON.stringify(envelope).length` through `executeTool` on a real session.
