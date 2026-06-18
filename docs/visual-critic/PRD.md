# PRD — `visual-critic`: an independent vision critic for the rendered look

**Status:** ✅ SHIPPED in **3.9.1** (Pillar A + Pillar B together; Pillar C deferred) — branch `v3.9.1/visual-critic`. See `docs/visual-critic/CHANGELOG.md`. Walker `visualqc` 8/8 + real-ffprobe crop verified + boot integrity green both adapters. NOT yet live-tested with a real `/vob` run.
**One-liner:** The PREVIEW/COMPOSE (pixels) twin of v3.9's PLAN-phase `editorial-critic` — a read-only, token-isolated, multimodal subagent that judges the *rendered look* (legibility, safe-area, collisions, hook-frame strength, framing, polish) and returns `VERDICT: SHIP|REVISE` + findings, driving at most one composer fix before the human sees the cut.

---

## 1. Problem

v3.9's three pillars all raised *taste*: take-quality at INSPECT, the `editorial-critic` at PLAN, and the design-system kit at COMPOSE (the taste **floor**). The one thing none of them added is an **independent check that the rendered frames actually look good** — that the design floor *held* in pixels.

A common misconception (I made it myself first): "the system never sees its own output." **It does.** `COMPOSE.md` step *Self-QC* (lines 127–180) tells the orchestrator to `Read` full-res stills (hook frame + caption-dense frame + the contact sheet) and judge a QC-A…QC-F checklist, auto-fixing GLARING issues by re-spawning the composer. The deterministic half (QC-C black/blown/flat) is automated in `vob_qc_stills`. So the loop exists.

The real gaps are three:

1. **The visual judgment is self-assessment by the invested party.** The orchestrator that shepherded the composition also grades it — in its own context, under budget pressure ("singles budget 4 per round"), competing with everything else for attention. This is *exactly* the pre-v3.9 state of PLAN, where the storyboarder self-critiqued but no independent critic existed. v3.9's whole thesis was that an **independent, adversarially-prompted** second opinion catches what self-assessment misses. We never applied that thesis to the pixels.
2. **The frame-image tokens live in the orchestrator's main context.** Reading stills inline (~1.1–1.6k image tokens each) bloats the long-lived orchestrator transcript. A subagent isolates them.
3. **QC-B (caption legibility / contrast against background) is `ceded to the human`** — `composition-qc.js:5–9` literally says rendered "contrast, safe bands, collisions" belong to the self-QC loop, and that loop has no *deterministic* contrast check at all. It's the single most common slop defect (white caption on a bright shot) and nothing measures it.

**Why now:** the `editorial-critic` (v3.9) proved the independent-critic pattern end-to-end — agent file, spawn-after-clean-save, ≤1 auto-revision, fail-safe, `VALID_ROLE_BUNDLES` registration, dual-adapter port. This is that pattern, re-pointed at images. Low novelty, high leverage.

---

## 2. Goals / non-goals

**Goals**
- Add an **independent** visual quality opinion on the rendered look, before the human approves, that catches legibility/safe-area/collision/framing/polish defects the heuristic stack structurally can't.
- Keep frame-image tokens **out of** the orchestrator context (subagent isolation).
- Make caption **contrast** a deterministic, walker-testable check (close the QC-B "ceded to human" gap).
- Reuse every existing mechanism: snapshots, `vob_qc_stills`, the GLARING/TASTE routing, the composer re-spawn loop, the editorial-critic registration/port machinery.
- **Advisory, fail-safe, gates nothing.** A critic error/timeout falls back to the existing inline orchestrator self-QC and never blocks. The human remains the final judge.

**Non-goals**
- No new FSM edge, no new gate, no new/renamed required intent key. (Same constraint v3.9 honored.)
- No motion-artifact review in v1 (stills only — see Pillar C, deferred).
- No new heavy dependency. Pixel sampling is ffmpeg/ffprobe (already required); the critic is the model already in the loop.
- Not a replacement for the human PREVIEW approval — it's the second opinion *before* it.

---

## 3. Design — three pillars

### Pillar A (core) — the `visual-critic` subagent

A read-only multimodal subagent, a near-exact clone of `editorial-critic`, spawned in the **COMPOSE self-QC loop** over the full-res snapshot PNGs.

**Why COMPOSE, not PREVIEW.** The snapshots (`<session>/compose/snapshots/*.png` + `contact-sheet.jpg`, full-res, from `vob_snapshot_keyframes`) are produced there for free, **before** burning a 15–30 min draft render, and the composer re-spawn + GLARING/TASTE routing already live there. PREVIEW explicitly hands stills to the user and doesn't re-judge. So COMPOSE is where an independent visual read has the most leverage at the least cost. (Naming: I'd call it `visual-critic`, not `preview-critic` — it parallels `editorial-critic` and it runs in COMPOSE, not the PREVIEW phase.)

**Agent file** (`adapters/claude-code/.claude/agents/visual-critic.md`) — clone of `editorial-critic.md`:
- Frontmatter: `name: visual-critic`, `tools: [Read, mcp__vob__vob_read_state_summary]`, `model: opus`, `color: <pick>`. (`Read` already presents PNG/JPG visually — the substrate works unchanged.)
- Charge: *independently* judge the rendered frames against a fixed visual rubric; default to finding real defects; every finding cites a still + a timecode + the concrete fix; writes nothing, drives no FSM ("your verdict is your final message").
- Reads the rubric from a new `references/visual-quality.md` (the visual analog of `editorial-patterns.md`) so it scores against the doc, not its own taste.

**Output format** (returned as the final message, parsed by the orchestrator — identical contract to editorial-critic):

```
VERDICT: SHIP            (or: VERDICT: REVISE)

SCORES:
- Legibility:   strong|ok|weak — <one line, cite still + timecode>
- Safe-area:    strong|ok|weak — <…>
- Collisions:   strong|ok|weak — <…>
- Hook frame:   strong|ok|weak — <…>
- Framing:      strong|ok|weak — <…>
- Polish:       strong|ok|weak — <intentional/designed vs templated/AI-slop>

FINDINGS:                (empty when SHIP)
- visual/<code> [glaring|taste] — <still @ t=<s>s> — <what's wrong + the specific composer fix>
- ...

TOP FIX: <only on REVISE — the single highest-leverage composition change, phrased as a
composer revision note, e.g. "Caption at t=0.5s is white on a blown-out sky (visual/low_contrast);
move it to the lower-third safe band and add the design-system scrim token.">
```

- **Verdict rule** (mirror editorial-critic): `REVISE` when any dimension is `weak`; `SHIP` otherwise.
- **Severity** adopts the **`glaring`/`taste`** split from `still-qc.js` (not error/warning), because it maps directly onto COMPOSE's existing routing: `glaring` → composer auto-fix, `taste` → user note.
- **Codes** (`visual/*`): `low_contrast`, `caption_illegible`, `safe_area_intrusion`, `text_collision`, `text_over_face`, `weak_hook_frame`, `subject_cropped`, `letterbox_bars`, `slop`, `other`.
- Fan-out / segments: judged per active short / chapter, naming the `short_id`/`segment_id` (the snapshots are already scope-defaulted).

**The DATA-only spawn prompt** (in `COMPOSE.md`, replacing the inline-read instruction) gives the critic everything it needs to know what *should* be where:
```
project_id, snapshots_dir, still_paths[], contact_sheet_path, timecodes[]
video_type / lint_ruleset
intent.target_platform (+ canonical profile → safe-band insets), intent.tone
storyboard_json_path (scene/caption/overlay plan + target.design tokens)
active short_id / segment_id | none
```

### Pillar B (companion) — deterministic caption-contrast check

The walker-testable engine half — closes the QC-B "ceded to human" gap and gives the feature a model-free regression target (exactly as the deterministic hook-grounding lints accompanied the editorial-critic).

- New pure helper `mcp/lib/visual-legibility.js`:
  - `contrastRatio(textColorLuma, bgLuma)` — WCAG-style ratio (pure math, fully unit-testable).
  - Given the caption element bounding boxes from `hyperframes inspect` (already parsed by `layout-qc.js`) + the rendered still, sample the background luma under each caption box (one `ffprobe`/`signalstats` crop read — reuse `visual-quality.js`'s `signalstats` pass machinery) and compute contrast against the caption's declared text color.
- Folds into `vob_qc_stills` (or `lint-composition`'s inspect block) as advisory findings: `qc/caption_low_contrast` (`taste` by default; `glaring` below a hard floor, e.g. ratio < 2.0). **Never an error** — the COMPOSE→PREVIEW gate (errors only) is unchanged.
- Degrade-don't-die: no bbox geometry / no signalstats → skip, emit nothing.

> Pillar B is independently shippable and valuable even without Pillar A. If we want to de-risk, ship B first (pure, deterministic, walker-proven), then A on top.

### Pillar C (deferred) — motion-aware PREVIEW pass

Stills miss motion defects (a caption that animates in badly, a transition flash). Phase 2: after the draft render, sample N frames from the preview MP4 via ffmpeg (`-vf fps=…`/`select`) — including *at* transition/caption-onset times — and run the same critic over them. Deferred because it's more expensive (post-render) and the per-frame dimensions in Pillar A already cover the bulk of the value. Documented here so the agent file + rubric are designed to generalize to it.

---

## 4. Orchestrator wiring (`COMPOSE.md` self-QC, ~lines 127–180)

Surgical swap. The snapshot + `vob_qc_stills` (ffprobe backstop) stays. The orchestrator's **inline image-read + QC-A…F judgment** is replaced by a critic spawn:

1. `vob_snapshot_keyframes` → PNGs (unchanged).
2. `vob_qc_stills` → deterministic black/blown/flat + (Pillar B) caption-contrast (unchanged routing).
3. **Spawn `visual-critic`** (DATA-only prompt above), *before* presenting / transitioning.
4. **Act on the verdict — at most ONE critic-driven fix** (mirror PLAN steps 6c):
   - `SHIP` → proceed; keep a one-line summary for the gate.
   - Critic errored / unparseable / unavailable / `VOB_VISUAL_CRITIC=off` → **fall back to the existing inline orchestrator self-QC** (the current behavior becomes the fallback) — never block.
   - `REVISE` and not already auto-fixed this round → `vob_log_composer_invocation { revision_notes: <critic TOP FIX + the glaring FINDINGS> + lint_report_path }`, re-spawn the composer (COMPOSE step 3), re-run snapshot + `vob_qc_stills`. Do **not** re-spawn the critic. Carry remaining `taste` notes forward.
   - `taste`-only findings (no `weak` dimension) → surface as `⚠ visual:` notes to the user at the gate; don't auto-fix.
5. Funnel findings through the existing `revision_notes` channel + cite `report_path`; never paste full prose (the composer reads the report itself).

Budgets compose cleanly: the critic drives **≤1** auto-fix; the lint **≤3** re-spawn budget (errors) and the **≤2** self-QC-round budget are unchanged and separate. The human PREVIEW approval is untouched.

**Knob:** `VOB_VISUAL_CRITIC` = `auto` (default — run when the active scope carries captions/overlays/typed design, like `VOB_LAYOUT_QC`) | `always` | `off` (→ inline-orchestrator fallback). Mirrors the existing layout-QC knob.

---

## 5. Files to touch

| File | Change |
|---|---|
| `adapters/claude-code/.claude/agents/visual-critic.md` | **new** — clone of `editorial-critic.md` |
| `adapters/claude-code/.claude/skills/vob/references/visual-quality.md` | **new** — the visual rubric (the analog of `editorial-patterns.md`) |
| `adapters/claude-code/.claude/skills/vob/phases/COMPOSE.md` | self-QC section: spawn + ≤1 auto-fix + fallback |
| `mcp/lib/tool-registry.js` | `VALID_ROLE_BUNDLES += "visual-critic"` (+ the explanatory comment; no tool's `role_bundles` changes — read-only critic) |
| `mcp/lib/visual-legibility.js` | **new (Pillar B)** — pure `contrastRatio` + bbox-luma sampling |
| `mcp/lib/tools/qc-stills.js` (or `lint-composition.js`) | fold Pillar B contrast findings in |
| `adapters/opencode/.opencode/agents/visual-critic.md` | **new** — hand-written OpenCode frontmatter stub (`mode: subagent`, `vob_*: false` + `vob_vob_read_state_summary: true`, write/edit/bash/task/webfetch/websearch false, `permission:` deny block); body is overwritten by the port |
| `scripts/port-adapter-docs.js` | add `"visual-critic"` to the subagent loop array (~line 137) + `visual-quality.md` to the references port list; re-run `node scripts/port-adapter-docs.js` |
| `scripts/m5-walker.js` | **new phase `visualqc`** — source-free harness for Pillar B (`contrastRatio` math, the glaring/taste threshold, fail-safe on missing bbox/luma); register in the line-46 source-free array + `main()` dispatch |
| `mcp/server.js` / `package.json` / `.vob/VERSION` | version bump |
| `docs/visual-critic/CHANGELOG.md` + CLAUDE.md invariant | docs |

**No new MCP tool required** — the critic returns its verdict as its final message (like editorial-critic), and the auto-fix is logged through the existing `vob_log_composer_invocation`. (If we later want the critique persisted to disk for audit, that's a small additive tool, not a v1 requirement.)

---

## 6. Risks & mitigations

- **Over-revision / churn (false positives trigger needless re-renders).** → Only `glaring` auto-fixes; `taste` → user note; **≤1** auto-fix; conservative rubric ("REVISE only on a `weak` dimension"); the human is final judge. Knob to disable.
- **Cost/latency: an extra opus subagent per COMPOSE round.** → It *replaces* the orchestrator's inline image read (system-wide token-neutral-ish; shifts image tokens into the throwaway subagent context and out of the long-lived orchestrator). Bounded still count. `auto` gating to caption/overlay-bearing scopes.
- **Stills miss motion.** → Acknowledged; per-frame dimensions cover the bulk; Pillar C is the motion follow-up.
- **The model is non-deterministic → not unit-testable.** → Pillar B (contrast) is the deterministic, walker-tested surface; the critic itself is verified by live runs + boot integrity, exactly like editorial-critic.
- **Snapshot vs final-render fidelity.** → Snapshots are the *same composition*, full-res (the draft MP4 is lower-res) — arguably a *better* legibility substrate than the preview video.

---

## 7. Acceptance / verification

- Boot integrity green in both adapters (the `visual-critic` bundle ↔ agent-file cross-check).
- `node scripts/m5-walker.js visualqc` — contrast math monotone, glaring/taste thresholds, fail-safe nulls, bbox-missing degrade.
- Live: a composition with a deliberately low-contrast caption over a bright shot → critic returns `REVISE` + `visual/low_contrast` (glaring) → one composer fix → re-snapshot clean → SHIP. A clean composition → `SHIP`, zero auto-fixes. Critic forced to error (bad model/timeout) → falls back to inline self-QC, never blocks.
- Adversarial self-review pass (the project's convention) on the new engine helper + wiring.

---

## 8. Decisions (locked)

1. **Name:** `visual-critic` (parallels `editorial-critic`; runs in COMPOSE, not the PREVIEW phase). *(default — trivially renameable)*
2. **Scope of v1:** **Pillar A + Pillar B together** — the independent subagent and the deterministic contrast companion, one pass, mirroring how v3.9 shipped critic + lints together.
3. **PREVIEW pass:** deferred to Pillar C (not in v1). v1 judges COMPOSE snapshots only.
4. **Critique persistence:** ephemeral (verdict-as-final-message, like editorial-critic); a disk audit tool is a later additive option, not v1.
