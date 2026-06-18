# v3.9 — PLAN / Storyboarder Editorial-Quality Pass (PROGRESS)

**Status:** ✅ COMPLETE — all 3 pillars built, walker-verified, boot-clean, dual-adapter, and adversarially reviewed (3 reviewers) with every actionable finding FIXED + re-verified. NOT committed (the tree carries parallel uncommitted work — land v3.9 in isolation; see triage). NOT live-tested.
**Started:** 2026-06-18
**Branch (planned):** `v3.9/storyboarder-quality`
**Central tracking file:** this doc. Updated every loop iteration.

---

## The problem (from the user)

> **PLAN — the storyboarder is a single-shot editor with no self-critique.**
> It generates the storyboard once; lints catch errors but nothing improves *editorial quality*
> (take choice, cut rhythm, hook, b-roll). **A mediocre editor and a great one both pass the lints.**

The lints are a *floor* (no broken plans), not a *ceiling* (great plans). Raise the ceiling.

## The three fixes (user-specified) → three pillars
- **(a) Ground harder in INSPECT signals** it already has (hook candidates, energy/speech-rate, clean-cut spans).
- **(b) Generate → self-critique → revise loop** before handoff.
- **(c) Editorial pattern recipes** (cold-open structure, retention beats).

---

## Exploration findings (code-grounded, 2026-06-18)

**Storyboarder & PLAN flow** — `adapters/claude-code/.claude/agents/storyboarder.md` (393 ln; craft ~257–375; save ~387–392);
`…/skills/vob/phases/PLAN.md` (177 ln; spawn ~72–120; lint handling ~122–145; present ~129–145; user-revise loop ~159).
Spawned **once**; orchestrator does **one** auto-retry on lint *errors* via `revision_notes`. **No self-critique, no critic.**
OpenCode mirrors at `.opencode/agents/storyboarder.md` + `.opencode/vob/phases/PLAN.md`, synced by `port-adapter-docs.js`.

**Signals already in the spawn but UNDERUTILIZED** — `digest_path` (ranked hook candidates + segment table + clean-cut stats),
`segments_path` (per-seg `energy_rms_db`, `speech_rate_wpm`), `clean_speech_path` (keep_spans/removed), `audio_summary`,
`transcript_aligned`. The craft section never acts on energy/speech-rate and gives no "compare hook candidates" guidance.

**INSPECT signal shapes** (agent 3):
- `inspect/digest.md` §Hook candidates — ≤5 ranked: `{rank, score, start_seconds, end_seconds, paragraph, text, signals[]}`, on the **winner transcribed file**.
- `inspect/segments.json` (schema 1.1) per-seg: `{file_index, start_seconds, end_seconds, is_silence, transcript_text, word_count, has_speech, speech_rate_wpm, energy_rms_db, energy_peak_db, loudness_lufs_approx, keyframe_path}`.
- `inspect/clean_speech.json` — `keep_spans[{start,end,text}]`, `removed[{start,end,reason,text}]`, `stats{…}` (source seconds).
- State: `state.inspect.{segments_path, clean_speech_path, digest_path, audio (compact), transcript_aligned, hook_candidate_count, segment_count, word_count, transcripts[]}`. **`read_state_summary` surfaces** `transcript_aligned, audio, word_count, segment_count, transcripts[], hook_candidate_count, segments_path`. Full hook-candidate array & per-seg metrics live **on disk only** (must be loaded).
- ⚠️ **VERIFY in impl:** whether full `hook_candidates[]` is persisted as JSON / `state.inspect.hook_candidates` or only rendered into `digest.md`. If only in markdown, persist a small `inspect/hook_candidates.json` (or inline ≤5 into state) so the lint reads structured data, not parsed markdown.

**Plan-lint engine** — `mcp/lib/storyboard-schema.js`: entry `validateStoryboardContent(parsed,state)` (~2984) → `lintStoryboardPlan` (~2718);
`baseContext` (~2992) = `{state, manifest, transcript, transcriptForFileIndex, cleanSpeech, lintRules}`; single-timeline adds `{targetSeconds, durationSpec}` (~3004); fan-out runs per short (~3040–3057). Hook warns at ~2772–2773.
Accessors: `storyboardTimelines/allStoryboardScenes/findTimeline` (~1068–1137), scene helpers `sceneArollOutputSeconds/sceneVideoCount/realizedScopeDurationSeconds` (~136–204), clip window `{manifest_file_index,in_seconds,out_seconds,speed}` (~82–99).
Ruleset gating: `video-types.js::activeLintRules(state)` (~509) → `{ruleset_name, disabled:Set, chapter_rules, clean_cut}`. Existing hook lints (`PLAN_HOOK_NOT_FIRST/_TOO_LONG/_NO_SPEECH`, `PLAN_RHYTHM_ARC_INVERTED`) are **retention-gated**. Findings = `{code,message,scene_index?,scene_id?,…,data?}`; warnings → result (≤10) + state (≤25) + `storyboard.md`.

**Save tool** — `mcp/lib/tools/save-storyboard.js` (handler ~74–199; `validateStoryboardContent` ~81; warnings→state ~169 / →result ~195 / →md ~103). Errors reject pre-write; warnings persist. Regenerates `plan/broll_gaps.json` every save.

**Registration** — `mcp/lib/tool-registry.js::VALID_ROLE_BUNDLES` (~5–10: orchestrator, inspector, storyboarder, composer).
Boot checks (`registry-integrity.js`): `verifyAgentRegistrations` (~73–102, every `agents/*.md` `name:` ∈ bundles) + `verifyAdapterToolReferences` (~130–278) incl. **reverse check** (~255–275: every bundle except orchestrator must have an agent file across adapters). `port-adapter-docs.js` ports **9 phases + 3 refs (`lint-rules.md`,`brief-design.md`,`clarifying-questions.md`) + 3 agents** → must EXTEND its lists for `editorial-critic.md` + `editorial-patterns.md`. A read-only critic needs **no** new MCP tool / SKILL.md / settings.json change (spawned via `Task`, uses existing read tools).

---

## LOCKED DESIGN

### Pillar C — `editorial-patterns.md` (build first; the knowledge core both B-pieces depend on)
New `adapters/claude-code/.claude/skills/vob/references/editorial-patterns.md`, modeled on `lint-rules.md`. Sections: editorial rubric
(Hook · Arc/Structure · Cut Rhythm & Pacing · Take Selection · B-roll Motivation · Captions/Legibility · Ending); grounding-in-signals
(hook_candidates / energy_rms_db / speech_rate_wpm / keep_spans / transcript_aligned / audio); cold-open recipes; retention beats;
take-selection heuristics; cut rhythm & pacing arc; b-roll motivation; endings; per-ruleset emphasis; the `editorial/*` finding codes.
Read by the storyboarder (proactive) and the critic (scoring). Ported to OpenCode.

### Pillar A — make signals load-bearing
- **A1 (agent .md, no engine change):** rewrite storyboarder craft section to MANDATE reading `digest.md` hook candidates + `segments.json` energy/speech-rate + `clean_speech.json` keep_spans, and to JUSTIFY the opening take against the top hook candidate, snap a_roll cuts to keep-span boundaries, and select takes by energy/clarity. Paths are already in the spawn.
- **A2 (engine teeth):** thread per-segment audio metrics + hook candidates into lint `ctx` (loaders `loadSegments(state)`, `loadHookCandidates(state)`; persist hook candidates as JSON if needed). New **WARNING, fail-safe, retention-gated** codes via `warnHookGrounding(scenes,ctx,disabled,warnings)` after ~2773:
  - `PLAN_HOOK_NOT_GROUNDED` — opening hook scene's source window overlaps **no** top-N hook candidate (only when opening clip is from the winner file; else skip).
  - `PLAN_OPENING_LOW_ENERGY` — opening segment `energy_rms_db` ≪ its file's median while a louder span exists (a limp/quiet open). [Energy-only by design — `speech_rate_wpm` grounding lives in the storyboarder/critic guidance + recipe doc, not this mechanical lint, to keep false positives low.]
  - Document both in `editorial-patterns.md`.

### Pillar B — generate → self-critique → revise
- **B1 (always-on, cheap):** storyboarder `.md` adds explicit **DRAFT → SELF-CRITIQUE (rubric, reads `editorial-patterns.md`) → REVISE → save** before its single `vob_save_storyboard`.
- **B2 (the strong lever — independent critic):** new read-only `editorial-critic` subagent. Orchestrator (PLAN.md, after a lint-clean save, before user presentation) spawns it with DATA-only paths (brief, storyboard.json/md, digest.md, editorial-patterns ref, ruleset, intent values). Critic emits **`VERDICT: SHIP|REVISE`** + rubric scores + `findings[]`. Orchestrator: if `REVISE` and critic-revisions `< 1`, re-spawn storyboarder with the critique as `revision_notes` (≤1 critic-driven cycle), then present the improved plan + a one-line "what the critic improved" note. **Fail-safe** (critic error/timeout ⇒ proceed with current storyboard) and **advisory** (never gates the human sign-off; no FSM edge, no gate, no new required key).
  - Registration: `+editorial-critic` to `VALID_ROLE_BUNDLES`; create `agents/editorial-critic.md` in **both** adapters; extend `port-adapter-docs.js` lists; verify claude-code agent-tools frontmatter pattern (Read + `vob_read_state` + `vob_read_state_summary`, **no** write).

### Testing (pending agent 5 specifics)
Walker negative path for A2: stub `state.inspect` segments + hook candidates on a clean storyboard, mutate the opening to a low-energy / non-candidate window, assert `PLAN_HOOK_NOT_GROUNDED` / `PLAN_OPENING_LOW_ENERGY`. Critic loop is agent-behavioral → validate registration boots clean + both agent files exist + porter runs.

---

## Guardrails I'm holding to
- **Engine enforces structure; skill owns wording/UX.** Editorial behavior lives in agent `.md` + reference docs.
- **No renamed/new required intent keys.** No new FSM edge / gate.
- **All new lints WARNING, fail-safe, ruleset-gated** (respect the `disabled` Set; hook grounding → retention only).
- **Critic advisory & fail-safe** — never strands PLAN, never gates sign-off.
- **Dual-adapter parity** — run `port-adapter-docs.js`; keep allow-lists in sync; don't trip the boot integrity checks.
- Memory: *output quality over eng hygiene* — lead with the editorial lever; tests proportionate.

---

## Open questions — RESOLVED
- [x] Signals already threaded into spawn? **Yes (underutilized).** Lint `ctx`? **cleanSpeech/transcript yes; hook candidates + per-seg energy NO → thread in.**
- [x] Insertion point for grounding lints? **`warnHookGrounding` after storyboard-schema.js:2773; finding-pusher pattern like `warnHookShape`.**
- [x] Scene source-window info sufficient? **Yes — `{manifest_file_index,in_seconds,out_seconds,speed}` (helpers ~82–99).**
- [x] Critic registration checklist? **Bundle + 2 adapter agent files + porter lists; no new tool/permission.**
- [ ] Walker stubbing of `state.inspect` signals for a model-free lint test — *pending agent 5.*
- [ ] Version-of-record file(s) to bump to 3.9.0 — *pending agent 5.*
- [ ] **VERIFY:** full `hook_candidates[]` persistence (JSON/state vs only digest.md) — resolve at impl start.

---

## Review findings & triage

**Concurrent-edit note:** `editorial-patterns.md` + `storyboarder.md` received intentional out-of-band
edits adding a per-segment **`strength.{score,tier,flags}`** take-quality signal (delivery+visuals) +
a digest "§ Strongest takes". NOT part of v3.9 — **preserve on any re-edit** (re-read before editing
those two files). My lints read `energy_rms_db`, not `strength`, so they're unaffected.

**Reviewer 1 — wiring/parity/boot (returned):** boot GREEN; fail-safe/advisory guarantee UPHELD
(critic touches zero engine state; every PLAN 6c branch terminates at step 7; ≤1 revision bounded);
spawn↔contract match CLEAN; porter idempotent. Two real **OpenCode-only** defects to fix:
- [ ] **[BLOCKER]** `adapters/opencode/.opencode/agents/vob.md` — `permission.task` allow-lists only
  inspector/storyboarder/composer (`"*": deny`) → OpenCode can't spawn `editorial-critic`; B2 inert
  on OpenCode (parity break; NOT a strand — 6c catches the denied spawn). FIX: add
  `editorial-critic: allow` + update description/§Delegating prose. (hand-maintained, not ported.)
- [ ] **[MAJOR]** `scripts/port-adapter-docs.js:57` — spawn-wrapper regex `subagent_type: "([a-z]+)"`
  excludes the hyphen → OpenCode PLAN.md step-6b Task block malformed. FIX: `"([a-z-]+)"` + re-run porter.

**Reviewer 3 — contracts/docs/invariants (returned):** SHIP-quality; invariants (a)-(e) all CLEAN
(required keys untouched; lints WARNING/fail-safe/retention-gated; no FSM edge/gate; engine-vs-skill
split intact; DATA-only critic spawn); field-name fidelity + `editorial/*` code consistency across the
3 files + version bump all verified; walker 6/6 + boot green (re-run by the reviewer).
- [ ] **[MAJOR · process, NOT a code defect]** working tree mixes v3.9 with a PARALLEL uncommitted
  feature — `take-quality.js`/`visual-quality.js` (the `strength` signal, wired into inspect.js) + a
  composer "design-system kit" (`injectDesignKit`, `mcp/assets/design-system/`, `build-design-system.js`,
  save-composition.js). v3.9 CHANGELOG lists only v3.9 files (correct), but `git commit -a` would ship
  both. ACTION: do NOT commit; surface to the user → land v3.9 in isolation. (§T's `strength` ref is the
  parallel feature's — my §T also stands on `best_take`+energy, which exist today, so it's fail-safe.)
- [ ] **[nit→fix]** editorial-critic spawn (PLAN.md 6b) omits the classification pools, yet §T/§B tell
  the critic to ground Take/B-roll on `best_take`/`eyes_to_camera`/`content_tags`. FIX: add
  `aroll_pool_path`/`broll_index_path` to the critic spawn + its "Your inputs".
- [ ] **[nit]** editorial-patterns.md §H "first 1–3 seconds" vs §3/lint "≤3.5s" — align §H.
- [ ] **[nit]** §5/§T frame `clean_audio_source_index` (a file-level spine pick) as a per-take signal — clarify.
- [skip] **[minor]** PRD R-B2.2 lists critic tools incl. `vob_read_state`; impl tightened to
  `read_state_summary` only (frontmatter↔body↔mirror consistent) — impl is source of truth, leave as-is.

**Reviewer 2 — engine correctness (returned):** NO blockers/majors. Lints crash-proof + fail-safe +
retention-gated + fan-out-correct (verified end-to-end through `validateStoryboardContent`). Minors:
even-count median bias (over-fire only), energy lint not using `speech_rate_wpm` (spec wording), a
rank-attribution message edge, and a note the walker bypassed the real disk loaders.

## Resolution — every actionable finding FIXED + re-verified (Iter 6)

- [x] **[BLOCKER]** vob.md — added `editorial-critic: allow` to `permission.task` + updated description/§Delegating prose.
- [x] **[MAJOR]** porter regex `"([a-z]+)"`→`"([a-z-]+)"`; OpenCode PLAN.md critic spawn now converts to the `task`-tool phrasing (0 raw `Task(` wrappers); porter idempotent (md5-stable).
- [x] **[MAJOR · process]** tree contamination — DOCUMENTED, NOT a code fix: I am **not committing**; v3.9 must land in isolation (the parallel `take-quality`/`design-system` work is separate). Flagged to the user.
- [x] **[minor]** even-count median → averages the two middle elements (`storyboard-schema.js`).
- [x] **[minor]** `speech_rate` spec divergence → PROGRESS A2 aligned to energy-only (CHANGELOG/CLAUDE.md were already energy-only; speech-rate grounding stays in agent guidance + recipe).
- [x] **[minor/nit]** `PLAN_HOOK_NOT_GROUNDED` message now cites `best.rank`; grounding `data` is `round1`-ed.
- [x] **[nit→fix]** editorial-critic spawn now passes `aroll_pool_path`/`broll_index_path` (+ an inputs bullet) so its Take/B-roll scoring is grounded.
- [x] **[nit]** §H "1–3s"→"≤3.5s"; §5 `clean_audio_source_index` clarified as a file-level spine pick.
- [x] **[process]** walker `editorial` gained a loader-path test (real `validateStoryboardContent` disk read) — now **7/7**.
- [skip] **[minor]** PRD R-B2.2 critic tool list (`vob_read_state`) — impl tightened to `read_state_summary` only; impl is source of truth.

**Re-verification:** porter re-run (17 files) · boot integrity GREEN · `editorial` walker 7/7 · `spans` walker green (no regression) · OpenCode critic spawn well-formed · porter idempotent.

## Iteration log
- **Iter 1 (2026-06-18):** Planned 3 pillars; launched 5 parallel read-only exploration agents; created this file.
- **Iter 2 (2026-06-18):** Synthesized 4/5 reports; locked the code-grounded design (above); resolved open questions; began Pillar C (`editorial-patterns.md`). Awaiting agent 5 (walker/docs) for test-harness + version specifics.
- **Iter 3 (2026-06-18):** All 5 explorations in. Authored `editorial-patterns.md` (Pillar C). PRD drafted in parallel (`docs/v3.9/PRD.md`, ~14KB). Implemented Pillar A2: `transcribed_file_index` added to `summary.json` (inspect.js); `loadInspectSummary`/`loadSegments`/`segmentsForFile` + `summary`/`segments` in lint ctx + `warnHookGrounding` (storyboard-schema.js); 2 codes added to chaptered/montage/general disabled sets (video-types.js). **Smoke-verified** (`/tmp/vob_v39_smoke.js`): clean→0, bad opening→both codes, long-form→gated off. Modules load clean. Then Pillar A1/B1: storyboarder `.md` grounding mandate + self-critique loop + `editorial-patterns.md` reference.
- **Iter 4 (2026-06-18):** Built Pillar B2 — `editorial-critic` subagent (claude-code source `agents/editorial-critic.md` + opencode mirror), registered in `VALID_ROLE_BUNDLES` (tool-registry.js), wired into PLAN.md (step 6b spawn + 6c ≤1 auto-revise + 7d gate surfacing; advisory & fail-safe — never gates the human). Extended `port-adapter-docs.js` (+`editorial-critic`, +`editorial-patterns.md`) and ran it (17 files ported). **Boot integrity green** via `runIntegrityChecks` (both adapters' agent registrations + drift/reverse-bundle guards). Remaining: walker `editorial` phase (A2 negative path), version bump → 3.9.0 + CHANGELOG, adversarial review.
- **Iter 5 (2026-06-18):** Added the walker `editorial` phase (source-free hook-grounding harness, 6 negative paths). Bumped version → 3.9.0 (`.vob/VERSION` 3.7.0→3.9.0, `package.json`, `mcp/server.js`); wrote `docs/v3.9/CHANGELOG.md`; updated CLAUDE.md (walker list + a v3.9 invariant bullet). Launched 3 parallel adversarial reviewers (engine · wiring/parity/boot · contracts/docs/invariants).
- **Iter 6 (2026-06-18):** All 3 reviews in — NO blockers/majors in the v3.9 code itself. Fixed + re-verified every actionable finding: the OpenCode `vob.md` critic-spawn blocker, the porter hyphen-regex major, the even-count median, the rank-attribution message, the critic-pools gap, the doc nits, and the walker loader-path coverage gap (now 7/7). Re-verified: porter (17 files) · boot GREEN · editorial 7/7 · spans green · OpenCode critic spawn well-formed · porter idempotent. The [major] tree-contamination (parallel uncommitted `take-quality`/`design-system` work) is a commit-hygiene flag for the user — NOT a code defect, and I did NOT commit. **v3.9 done; awaiting a live `/vob` run.**

## Task checklist (living)
- [x] Synthesize exploration → lock design specifics
- [x] `docs/v3.9/PRD.md` drafted (~14KB, code-anchors verified)
- [x] **Pillar C:** authored `editorial-patterns.md` (rubric, signal cheat-sheet, hook recipes, `editorial/*` codes) — porter-list wiring happens in the B2 step
- [x] hook-candidate persistence resolved: full array already in `summary.json`; added `transcribed_file_index` to it
- [x] **Pillar A2:** signals threaded into lint ctx + `warnHookGrounding` → `PLAN_HOOK_NOT_GROUNDED` + `PLAN_OPENING_LOW_ENERGY`; retention-gated; **smoke-verified** (clean→0 / bad→both / long-form→off)
- [x] **Pillar A1 / B1:** storyboarder `.md` — grounding mandate (hook candidates + energy/speech-rate, cites new lints) + `editorial-patterns.md` reference + draft→self-critique→revise section  ← next: B2
- [x] **Pillar B2:** `editorial-critic` agent (both adapters, boot-verified) + PLAN.md step 6b/6c critique pass + 7d surfacing + `VALID_ROLE_BUNDLES` + porter extended & run
- [x] Walker `editorial` phase — 6 tests pass (clean / each code isolated / retention-gate / cross-file / missing-signal); `spans` still green (no regression)
- [x] Dual-adapter sync (`port-adapter-docs.js` run, 17 files) + boot integrity green (`runIntegrityChecks`)
- [x] Version → 3.9.0 (`.vob/VERSION` 3.7.0→3.9.0, `package.json`, `mcp/server.js`) + `docs/v3.9/CHANGELOG.md` + CLAUDE.md (walker list + v3.9 invariant bullet)
- [x] Adversarial review (3 reviewers) — no blockers/majors in v3.9 code; 1 OpenCode blocker + 1 porter major + all minors/nits FIXED + re-verified; tree-contamination flagged (NOT committed)
