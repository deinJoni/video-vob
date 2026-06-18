# v3.9 — PLAN / Storyboarder Editorial-Quality Pass

**Status:** planning → implementing · **Branch:** `v3.9/storyboarder-quality` · **Base:** main @ 3.8.0
**Locked design ledger:** `docs/v3.9/PROGRESS.md` (the code-grounded findings + exact file/function anchors this PRD formalizes).

## Summary / Thesis

The storyboarder is a **single-shot editor**. It turns brief + manifest into `storyboard.json` in one pass; the orchestrator does **one** auto-retry, and only on lint *errors*. The plan-lint engine is a strong **floor** — it rejects broken plans (out-of-bounds overlays, duration-infeasible cuts, ungrounded key moments) — but it is not a **ceiling**: a mediocre editorial choice and a great one *both pass the same lints*. Nothing in the pipeline pushes the storyboard from "valid" toward "good."

v3.9 raises the ceiling on editorial quality at PLAN, with three additive pillars and **zero structural change** to the FSM:

- **(A) Make the INSPECT signals load-bearing.** INSPECT already computes ranked hook candidates, per-segment energy / speech-rate, and clean-cut keep-spans, and already threads their paths into the storyboarder spawn — but the craft guidance never *acts* on them. We mandate acting on them in the agent prose, and we add engine **teeth**: two new WARNING grounding lints (`PLAN_HOOK_NOT_GROUNDED`, `PLAN_OPENING_LOW_ENERGY`) that flag a plan whose opening ignores the strongest moments the footage actually contains.
- **(B) Generate → self-critique → revise.** The storyboarder gains an explicit internal **draft → self-critique → revise** step before its single save. On top of that, the orchestrator runs an independent, read-only **`editorial-critic`** subagent after a lint-clean save and before human sign-off; on a `REVISE` verdict it re-spawns the storyboarder once with the critique as revision notes. Fully advisory and fail-safe — it never gates the human and never strands PLAN.
- **(C) Editorial pattern recipes.** A new `editorial-patterns.md` reference (the cold-open structures, retention beats, take-selection heuristics, cut-rhythm/pacing arcs, b-roll motivation, endings, and the editorial rubric) — the shared knowledge core that both the storyboarder's self-critique and the critic score against.

This holds the house contract: **the engine enforces structure; the skill and agents own wording and editorial behavior.** Everything new is advisory / WARNING and fail-safe. No new FSM edge, no new gate, no new or renamed required intent key. (3.8.0 → 3.9.0)

## Goals & Non-Goals

### Goals
1. The storyboarder's opening choice is **justified against the footage** — it compares the planned hook against INSPECT's ranked hook candidates and selects takes by energy/clarity rather than by source order.
2. A plan that opens on a weak moment (low energy, or a window no hook candidate covers) is **surfaced as a WARNING** at PLAN, in the same place the user already reviews warnings.
3. The storyboard the human signs off on has been through **at least one critique-and-revise loop** (the storyboarder's own, plus — when the critic fires — an independent one).
4. The editorial knowledge is **written down once** (`editorial-patterns.md`) and consumed by both the self-critique and the critic, so "good editing" is a shared rubric, not vibes.
5. **Both adapters stay in lockstep** (claude-code + OpenCode) and the boot integrity checks pass.

### Non-Goals (explicitly out of scope)
- **No new FSM edge, no new gate, no new/renamed required intent key.** The five required intent keys (`target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`) are untouched. All of v3.9 is orchestration *within* the existing PLAN phase.
- **No blocking behavior.** Every new lint is a WARNING; the critic is advisory. PLAN's sign-off gate (`confirm-brief` + `confirm-storyboard`) is unchanged, and warnings remain accept-or-fix at the user's discretion.
- **No new MCP tool, no new write tool, no SKILL.md / settings.json allow-list change.** The critic is read-only and reuses existing read tools.
- **No new engine dependency, no new INSPECT signal.** v3.9 consumes signals INSPECT already produces. (The one allowed exception: persisting the existing hook candidates as structured JSON if they currently live only in `digest.md` — see A2.)
- **No change to take *rendering*** — this is a PLAN-phase quality pass. COMPOSE/PREVIEW/RENDER/PACKAGE are untouched.
- Tests/CI/code-linters (maintainer-deprioritized); Docker; pinning/downgrading hyperframes; stock/AI b-roll (ingested-only contract holds).

## Pillar A — Make the INSPECT signals load-bearing

INSPECT (agent 3) produces three signal sources the storyboarder spawn already references by path (`digest_path`, `segments_path`, `clean_speech_path`, plus `audio_summary` and `transcript_aligned`), but the craft section never acts on energy/speech-rate and gives no "compare hook candidates" guidance.

**Signal shapes (on disk, must be loaded — `read_state_summary` surfaces only counts/paths):**
- `inspect/digest.md` §Hook candidates — ≤5 ranked entries `{rank, score, start_seconds, end_seconds, paragraph, text, signals[]}`, computed on the **winner transcribed file**.
- `inspect/segments.json` (schema 1.1) — per segment `{file_index, start_seconds, end_seconds, is_silence, transcript_text, word_count, has_speech, speech_rate_wpm, energy_rms_db, energy_peak_db, loudness_lufs_approx, keyframe_path}`.
- `inspect/clean_speech.json` — `keep_spans[{start,end,text}]`, `removed[{start,end,reason,text}]`, `stats{…}`.

### A1 — Storyboarder craft rewrite (agent `.md`, no engine change)
Rewrite the craft section of `adapters/claude-code/.claude/agents/storyboarder.md` (current craft ~ll. 257–375) to **mandate**, not merely mention, reading and acting on the signals:

1. **R-A1.1** Read `digest.md` hook candidates before choosing the opening, and **justify the opening take against the top-ranked candidate** — open on it, or write a one-line note in the storyboard explaining the deliberate departure.
2. **R-A1.2** Read `segments.json` and **select takes by energy/clarity** (`energy_rms_db`, `speech_rate_wpm`, `has_speech`) — prefer high-energy, well-paced segments for the hook and key beats; avoid limp/quiet openers.
3. **R-A1.3** Read `clean_speech.json` and **snap `a_roll` cuts to keep-span boundaries** (already half-honored — formalize it), avoiding windows inside `removed[]` spans.
4. **R-A1.4** Cross-reference the chosen opening against the rubric in `editorial-patterns.md` (Pillar C).

These paths are already in the spawn; A1 is pure prose + behavioral contract. Mirrored to `.opencode/agents/storyboarder.md` via the porter.

### A2 — Engine teeth: two grounding lints
Thread the per-segment audio metrics and hook candidates into the lint context and add a finding-pusher.

- **R-A2.1 — Loaders.** Add `loadSegments(state)` and `loadHookCandidates(state)` to `mcp/lib/storyboard-schema.js`, reading `inspect/segments.json` and the hook-candidate source. Extend `baseContext` (~l. 2992) so `ctx` carries `segments` and `hookCandidates` alongside the existing `{state, manifest, transcript, transcriptForFileIndex, cleanSpeech, lintRules}`. Both loaders **fail-safe**: a missing/unreadable/empty file yields `null`/`[]` and disables the dependent lint silently (never throws, never rejects the save).
- **R-A2.2 — Hook-candidate persistence (VERIFY at impl start).** Confirm whether the full `hook_candidates[]` array is persisted as structured data (`inspect/hook_candidates.json` or `state.inspect.hook_candidates`) or **only rendered into `digest.md`**. If markdown-only, persist a small `inspect/hook_candidates.json` (≤5 entries) at INSPECT so the lint reads structured data, not parsed prose. This is the *only* sanctioned INSPECT-side change in v3.9 and is additive.
- **R-A2.3 — `warnHookGrounding(scenes, ctx, disabled, warnings)`.** A new finding-pusher in `storyboard-schema.js`, called from `lintStoryboardPlan` (~l. 2718) right after the existing hook-shape warnings (~ll. 2772–2773), following the established `warnHookShape` pattern. Findings are `{code, message, scene_index?, scene_id?, data?}`, pushed into `warnings` (→ result ≤10, → state ≤25, → `storyboard.md`). Runs **per short** in fan-out (the lint already re-runs per timeline at ~ll. 3040–3057), document-global de-dup not required since each finding is scene-scoped.

The two codes (both **WARNING**, **fail-safe**, **retention-ruleset-gated**):

| Code | Fires when | Severity | Gating |
|---|---|---|---|
| `PLAN_HOOK_NOT_GROUNDED` | The opening hook scene's source window overlaps **none** of the top-N hook candidates — *only when the opening clip is from the winner transcribed file*; if it's from another file, **skip** (candidates aren't comparable). | WARNING | retention only |
| `PLAN_OPENING_LOW_ENERGY` | The opening segment's `energy_rms_db` is well below its file's median, **or** its `speech_rate_wpm` is very low (a limp open). | WARNING | retention only |

Gating goes through `video-types.js::activeLintRules(state)` (~l. 509) → respect the `disabled` Set; both codes fire only under the `retention` ruleset (consistent with the existing `PLAN_HOOK_NOT_FIRST/_TOO_LONG/_NO_SPEECH` and `PLAN_RHYTHM_ARC_INVERTED`). Both are documented in `editorial-patterns.md` with fix guidance.

> **Critical fail-safe (see Risks):** hook candidates are computed on a *single* winner file. The `PLAN_HOOK_NOT_GROUNDED` comparison is only meaningful when the opening clip's `manifest_file_index` equals the winner file's. When it doesn't, the lint **must skip** (emit nothing) rather than warn — a B-roll-led or multi-cam open is a legitimate editorial choice, not an ungrounded hook.

## Pillar B — Generate → self-critique → revise

### B1 — Storyboarder internal self-critique (always-on, cheap)
**R-B1.1** Add an explicit **DRAFT → SELF-CRITIQUE → REVISE → save** sequence to `storyboarder.md`, before its single `vob_save_storyboard` call (~ll. 387–392). The self-critique step reads `editorial-patterns.md` (Pillar C) and scores the draft against the rubric, then revises. This is always-on, in-context, and adds no spawn — the storyboarder still saves exactly once.

### B2 — Independent `editorial-critic` subagent (the strong lever)
A new **read-only** subagent the orchestrator runs **after a lint-clean save and before presenting the plan to the human**.

- **R-B2.1 — Contract.** `editorial-critic` is spawned with **DATA-only** paths (brief, `storyboard.json`/`storyboard.md`, `digest.md`, the `editorial-patterns.md` reference, the active ruleset, and the resolved intent values). It reads them, scores against the rubric, and emits a structured verdict:
  - `VERDICT: SHIP | REVISE`
  - per-dimension **rubric scores** (the dimensions in §Editorial Rubric below)
  - `findings[]` — concrete, scene-anchored notes (what's weak, why, what to change)
- **R-B2.2 — Read-only, no new tool.** The critic's only tools are read tools: `Read`, `vob_read_state`, `vob_read_state_summary` — **no write, no render, no confirm, no transition.** Because it adds no MCP tool, it needs **no SKILL.md `allowed-tools` change and no settings.json `permissions.allow` change** (those lists gate *write* tools; the read tools are already available). It is spawned via `Task` exactly like the other subagents.
- **R-B2.3 — Orchestrator wiring (`PLAN.md`).** After a lint-clean save and before user presentation (PLAN.md present-block ~ll. 129–145, ahead of the user-revise loop ~l. 159):
  1. Spawn `editorial-critic`.
  2. If `VERDICT: REVISE` **and** the critic-revision counter `< 1`: re-spawn the storyboarder once with the critique folded into `revision_notes` (the existing `revision_notes` channel — same mechanism as the lint-error auto-retry), then re-run the lint-clean save. **≤1 critic-driven revise cycle.**
  3. Present the improved plan to the human with a **one-line "what the critic improved"** note.
- **R-B2.4 — Fail-safe & advisory.** A critic error, timeout, malformed verdict, or unparseable output ⇒ **proceed with the current storyboard** and present it normally. The critic **never gates** the human sign-off, never blocks the save, introduces **no FSM edge and no gate**, and adds **no required intent key**. It is purely an orchestration-layer quality step inside PLAN.

### Editorial Rubric (dimensions)
The shared rubric used by B1 (self-critique) and B2 (critic), defined in `editorial-patterns.md`:

1. **Hook** — does the opening earn attention in the first ~2s; is it grounded in the strongest available moment?
2. **Arc / Structure** — clear setup → development → payload; coherent ordering; (chaptered presets: balanced sections).
3. **Cut Rhythm & Pacing** — varied, intentional pacing; an energy arc (not monotone); cuts motivated by content.
4. **Take Selection** — best available take per beat (energy/clarity), clean speech, no flubbed/low-energy lines where a better one exists.
5. **B-roll Motivation** — b-roll covers a real need (jump-cut, illustration, breathing room), not decoration; gaps acknowledged.
6. **Captions / Legibility** — caption load and emphasis serve comprehension; word-level animations only on aligned transcripts.
7. **Ending** — a deliberate close (CTA / button / payoff), not a hard stop on a dangling clip.

Per-ruleset emphasis is documented (e.g. Hook + Cut Rhythm weigh heaviest under `retention`; Arc/Structure under `chaptered`; B-roll Motivation + Take Selection under `montage`).

## Pillar C — `editorial-patterns.md` (build first)

**R-C.1** Create `adapters/claude-code/.claude/skills/vob/references/editorial-patterns.md`, modeled on the existing `lint-rules.md` reference (vetted recipe doc, read on demand). It is the knowledge core both B-pieces depend on, so it is built first.

**R-C.2** Sections:
- **The editorial rubric** — the seven dimensions above, with per-ruleset emphasis.
- **Grounding in signals** — how to read and act on `hook_candidates` / `energy_rms_db` / `speech_rate_wpm` / `keep_spans` / `transcript_aligned` / `audio` (maps Pillar A's signals to concrete decisions).
- **Cold-open recipes** — in-medias-res, question/curiosity-gap, bold-claim, pattern-interrupt, result-first.
- **Retention beats** — open loops, re-hooks, pacing escalation, payoff placement.
- **Take-selection heuristics** — energy/clarity comparison, flubbed-take detection, clean-speech snapping.
- **Cut rhythm & pacing arc** — front-load energy, vary shot length, avoid monotone, build to climax under chaptered/general.
- **B-roll motivation** — when b-roll is earned vs decorative; acknowledging gaps.
- **Endings** — CTA / button / payoff patterns by video type.
- **The `editorial/*` finding codes** — the critic's finding vocabulary, plus the new `PLAN_HOOK_NOT_GROUNDED` / `PLAN_OPENING_LOW_ENERGY` lint codes and their fixes.

**R-C.3** Read proactively by the storyboarder (A1, B1) and by the critic (B2 scoring). Ported to OpenCode (see Dual-Adapter Parity).

## FSM / Contract Impact

**None structural.** Stated explicitly because it is the load-bearing constraint:

- **No new FSM edge.** `ALLOWED_TRANSITIONS` in `session-state.js` is unchanged. v3.9 is orchestration *inside* PLAN, between the lint-clean save and the human presentation.
- **No new gate.** `GATES` in `phase-gates.js` is unchanged. The PLAN sign-off (`confirm-brief` + `confirm-storyboard`) is untouched; the critic never participates in any gate.
- **No new or renamed required intent key.** The five required keys are untouched; v3.9 adds none and renames none. The critic reads existing intent values; the lints read existing INSPECT signals.
- **No new MCP tool / write tool / allow-list change.** The critic is read-only via existing read tools; `SKILL.md allowed-tools` and `settings.json permissions.allow` are unchanged.
- **Engine vs skill split preserved.** The only engine change is the two fail-safe WARNING lints + their loaders in `storyboard-schema.js` (structure). All editorial *behavior* (self-critique, critic scoring, recipes) lives in agent `.md` files and the reference doc (wording/UX).

## Dual-Adapter Parity

v3.9 adds two reference/agent assets that the porter must mirror, and one bundle registration the boot guards check.

- **R-D.1 — Role-bundle registration.** Add `"editorial-critic"` to `VALID_ROLE_BUNDLES` in `mcp/lib/tool-registry.js` (~ll. 5–10). The boot integrity check `registry-integrity.js::verifyAgentRegistrations` (~ll. 73–102) requires every `agents/*.md` `name:` to be in the bundle list; its **reverse check** (~ll. 255–275) requires every bundle except `orchestrator` to have an agent file across adapters — so the bundle and the two agent files must land together.
- **R-D.2 — Agent files in both adapters.** Create `editorial-critic.md` in **both** `adapters/claude-code/.claude/agents/` and `adapters/opencode/.opencode/agents/`. Verify the claude-code agent-tools frontmatter pattern (tools: `Read` + `vob_read_state` + `vob_read_state_summary`, **no write tool**) and the OpenCode equivalent (lowercase `read`, `vob_vob_read_state*`, no `write`/`edit`/`patch`/`bash`).
- **R-D.3 — Extend the porter lists.** `scripts/port-adapter-docs.js` currently ports **9 phases + 3 references (`lint-rules.md`, `brief-design.md`, `clarifying-questions.md`) + 3 agents**. Extend its reference list to include `editorial-patterns.md` and its agent list to include `editorial-critic.md`. Run `node scripts/port-adapter-docs.js` after editing the claude-code sources; the OpenCode dialect mapping (tool-name prefixes, read-tool casing, `Task(...)` → `task` tool phrasing) applies automatically.
- **R-D.4 — Boot clean.** `node mcp/server.js` must boot without tripping `verifyAgentRegistrations`, the reverse bundle check, or `verifyAdapterToolReferences` (~ll. 130–278). Because the critic adds no tool, `verifyAdapterToolReferences` has nothing new to reconcile — but the agent-file ↔ bundle pairing must be exact.

## Testing

Consistent with house practice (`m5-walker.js` is the de-facto integration test; output-quality over test hygiene), proportionate coverage:

- **R-T.1 — Walker `editorial` phase (A2 negative path), model-free.** Add a `editorial` phase to `scripts/m5-walker.js`, modeled on the **source-free `spans` phase** (a lint harness that builds context in-process without a real video). It stubs `state.inspect` segments + hook candidates on a clean storyboard, then mutates the opening to (a) a low-energy / low-WPM segment and (b) a window no hook candidate covers, asserting `PLAN_OPENING_LOW_ENERGY` and `PLAN_HOOK_NOT_GROUNDED` respectively. It also asserts the **fail-safe skip**: an opening clip from a non-winner file emits **no** `PLAN_HOOK_NOT_GROUNDED`, and absent/empty signal files emit nothing (no throw).
- **R-T.2 — Critic loop = registration + structural checks.** The critic loop is agent-behavioral (model-driven), so validate the *substrate*, not the LLM output: `node mcp/server.js` boots clean (R-D.4); both `editorial-critic.md` files exist; `node scripts/port-adapter-docs.js` runs clean and the OpenCode mirrors are byte-current.
- **R-T.3 — Targeted Node asserts** on the pure functions (`loadSegments`, `loadHookCandidates`, `warnHookGrounding`) for the fail-safe (null/empty input ⇒ no finding, no throw) and the winner-file gating, as the `spans` harness already does for its lints.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Hook candidates are computed on a **single winner file**; comparing a multi-cam / B-roll-led open against them produces a false `PLAN_HOOK_NOT_GROUNDED`. | High | The lint **skips entirely** when the opening clip's `manifest_file_index` ≠ the winner file's (R-A2.3). Walker asserts the skip (R-T.1). The recipe doc frames a deliberate non-candidate open as legitimate. |
| Critic **gates or strands** the human if it errors, hangs, or loops. | High | Critic is advisory & fail-safe (R-B2.4): any error/timeout/malformed verdict ⇒ proceed with current storyboard. **≤1** critic-driven revise cycle (counter-bounded). No FSM edge, no gate. |
| New lints become **noise** (fire on legitimate choices) and erode trust in warnings. | Medium | Both WARNING-only and retention-gated (respect the `disabled` Set); permissive thresholds (`PLAN_OPENING_LOW_ENERGY` uses "well below median", not strict); each is accept-or-fix; never blocks sign-off. |
| Hook candidates persisted **only in `digest.md`** would force markdown parsing in the lint. | Medium | R-A2.2 verifies persistence at impl start; if markdown-only, persist a small structured `inspect/hook_candidates.json` (additive, the one sanctioned INSPECT change). |
| **Adapter drift** — OpenCode mirrors fall out of sync, or the boot guard trips on the new bundle/agent. | Medium | Bundle + both agent files land together (R-D.1/D.2); porter list extended and re-run (R-D.3); boot-clean is an acceptance gate (R-D.4). |
| **Latency / cost** — the critic adds a subagent spawn (+ up to one storyboarder re-spawn) to every PLAN. | Low | One spawn, ≤1 revise cycle, read-only (cheap context). The quality lever is the maintainer-stated priority; fail-safe means a slow critic degrades to "proceed," not "block." |
| Self-critique (B1) **inflates the storyboarder's context** without improving output. | Low | B1 is prose-only, reuses the in-context draft, adds no spawn; the independent critic (B2) is the real check. If B1 proves inert it can be trimmed without engine change. |

## Open Questions
- **VERIFY at impl start (R-A2.2):** is the full `hook_candidates[]` persisted as JSON / `state.inspect.hook_candidates`, or only rendered into `digest.md`? Resolve before wiring `loadHookCandidates`. Owner: implementer.
- **Walker stubbing fidelity (R-T.1):** confirm the minimal `state.inspect` shape the `spans`-style harness must fake (segments + hook candidates) so the two lints fire deterministically without a real video. Owner: implementer.

## Rollout / Version
- **Build order:** Pillar C (`editorial-patterns.md`) first — it's the knowledge core both B-pieces read. Then A2 (engine lints + loaders), then A1 / B1 (storyboarder `.md` rewrite), then B2 (`editorial-critic` + PLAN.md wiring + bundle registration), then the walker `editorial` phase, then the dual-adapter sync + boot-guard check.
- **Version-of-record → 3.9.0** in `.vob/VERSION`, `package.json`, and `mcp/server.js`; add `docs/v3.9/CHANGELOG.md`. Update the CLAUDE.md invariants as slices land (a new "PLAN editorial-quality pass" invariant: signals are load-bearing, two new fail-safe grounding lints, the advisory read-only critic loop).
- **Method per slice:** design → implement → self-verify (`node scripts/m5-walker.js editorial`; boot `npm run mcp` clean; targeted Node asserts) → adversarial review (parallel reviewer subagents) → mark done in PROGRESS.md. Commit per coherent slice.
- **Adapter rule:** every claude-code doc/agent edit is followed by `node scripts/port-adapter-docs.js`; the new `editorial-critic` agent and `editorial-patterns.md` reference must be in the porter's lists before the boot guard will pass.
