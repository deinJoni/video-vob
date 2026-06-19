# Highlight Extraction — auto-author a multi-short fan-out from a long source (v0.3.11)

## Summary

Given a **long** (or already-edited) source, automatically **discover** the short-worthy
moments and **propose a multi-short `shorts[]` storyboard** that flows through the EXISTING
fan-out machinery unchanged. This is "auto-author the fan-out plan," not a second fan-out.

The app already computes every signal a good highlight wants — rhetorical **hook** scoring
(`hook-scoring.js` → `inspect.json` `hook_candidates[]`), per-segment **take-quality**
`strength` (`take-quality.js` → `segments.json`), clean-cut **keep-spans**
(`clean-cut.js` → `clean_speech.json`), and the user's named **key moments**
(`parseKeyMoments`) — but today consumes them only *defensively*, as PLAN warnings. This
feature runs those signals **forward** as a generative selection pass. The only net-new
logic is the discovery/scoring/clustering; everything from COMPOSE onward is reused.

## Non-negotiable philosophy

Advisory + fail-safe. **No new FSM edge, no new gate, no new/renamed required intent key.**
Discovery degrades to an empty candidate list, never throws. The human still approves the
plan at the existing PLAN gate. v1 is **single-source** (winner file only) — hook-candidate
and keep-span seconds are file-specific.

## The flow

```
INSPECT (signals exist)
  → INTENT (target platform/duration + how many highlights: highlight_count)
  → PLAN step 4b: vob_propose_highlights → writes plan/highlights.json (ranked windows)
  → orchestrator threads highlights_path into the storyboarder spawn
       ("author one schema-1.1 short per candidate window")
  → existing fan-out path: COMPOSE union materialize → per-short
       save_composition{short_id} → render → confirm_render → import_deliverable{short_id}
       → RENDER→COMPOSE back-edge → … → completeness gates → PACKAGE
```

`vob_propose_highlights` touches **no FSM edge and no gate**. It produces a standard
schema-1.1 `shorts[]` storyboard the storyboarder fleshes out and the human signs off via
the existing PLAN gate.

## Engine module — `mcp/lib/highlight-discovery.js` (pure)

A pure scorer + clusterer over the INSPECT artifacts. **No I/O, no requires, never throws**
— mirrors `hook-scoring.js` / `take-quality.js`. The walker `highlights` phase unit-tests it
from synthetic inputs.

`discoverHighlights({hookCandidates, segments, keepSpans, removedSpans, keyMoments,
sourceFileIndex, sourceDurationSeconds, target, count, options})` → `{candidates, notes, stats}`.

Algorithm:

1. **Atomic units** — the winner file's **non-silence speech segments** (each carries take
   `strength`, `energy_rms_db`, `transcript_text`), and the overlapping hook-scored sentences.
2. **Seed** — every speech segment is a potential cold-open seed.
3. **Window growing** — from each seed, grow forward (append consecutive segments) to ~the
   intent duration midpoint, then **snap both edges**:
   - `snapStart` snaps to the nearest **segment start at/before** the seed (preserving seed
     position, so a long continuous keep-span — an *already-edited* talk with little dead air
     — still yields multiple distinct windows), using keep-spans only to AVOID starting in a
     removed (dead-air) gap.
   - `snapEnd` picks a clean END from the **keep-span ends ∪ segment ends** inside
     `[start+min, start+max]`, closest to `start+mid` — preferring a keep-span end (a phrase
     end before a pause = a natural payoff). A pause right after the end raises self-containment.
4. **Window scoring** — a renormalizing weighted average over present components:
   `0.35·hookPull + 0.30·sustainedDelivery + 0.15·selfContainment + 0.20·keyMomentCoverage`,
   times a `durationFit` factor. Scores are **source-relative** (energy normalized vs the
   file's own distribution; hook normalized vs a reference) so "strong" = best-of-this-source.
   The key-moment term DROPS OUT (renormalizes) when the user named no moments.
5. **Dedupe + rank** — sort by window score; greedily accept windows that don't overlap an
   accepted one by more than 25% of the shorter; keep the higher score.
6. **Return top-N** — N = `count` (highlight_count or a sane default 3), capped at 10. Each:
   `{rank, score, source_file_index, start_seconds, end_seconds, duration_seconds, hook_type,
   key_moment_refs[], reason, suggested_title, components}`.

**Fail-safe:** nothing above `MIN_WINDOW_SCORE` (0.35) ⇒ `candidates:[]` + a `notes` reason.

## Tool — `vob_propose_highlights` (`mcp/lib/tools/propose-highlights.js`)

`role_bundles:["orchestrator"]`, `mutating:true`, `network_access:false`,
`session_artifacts_written:["plan/highlights.json","state.json"]`.

- **Inputs:** `project_id`, `count?` (override the intent key), `target_duration_seconds?` (override).
- **Behavior:** loads `inspect.json` (hook_candidates + `transcribed_file_index`) +
  `segments.json` + `clean_speech.json` + intent answers (best-effort), picks the winner file,
  runs `discoverHighlights`, writes `plan/highlights.json`
  `{schema_version, project_id, generated_at, source, target_duration, requested_count, count,
  candidates[], notes, stats}`, and stamps a lean `state.highlights`
  `{generated_at, source_file_index, requested_count, count, target_duration, highlights_path,
  notes, candidates_summary[]}` under the session lock.
- **Outputs:** `{highlights_path, count, requested_count, source_file_index, candidates_summary[], notes}`.
- **Fail-safe:** missing/unreadable inputs, no winner file, or zero candidates → returns
  `count:0` with a `notes` reason (still writes the artifact + state slot); **never errors,
  never gates.** The only hard errors are a bad/nonexistent `project_id` (the project must
  exist) and an I/O failure writing the artifact.

## Trigger + wiring

- **Optional intent key `highlight_count`** (`intent-schema.js`, OPTIONAL — never required,
  never gates). Canonicalized at record time (`record-intent-answer.js`) to `{raw, count}` (a
  positive integer parsed from free text like "the best 3 moments"; `count:null` when none is
  parseable; capped at 10). Absent ⇒ the feature is off.
- **PLAN wiring** (`PLAN.md` step 4b, both adapters): when `intent.answers.highlight_count` is
  set, call `vob_propose_highlights` BEFORE spawning the storyboarder; if `count >= 1`, treat
  it as a fan-out of `count` shorts and thread `highlights_path` into the storyboarder spawn.
  The editorial-critic pass runs after, unchanged. If `count == 0`, fall back to normal manual
  fan-out / single-timeline authoring (no error path).
- **`read_state_summary.highlights`** `{count, requested_count, source_file_index,
  generated_at, highlights_path, notes, candidates_summary[]}` (`summarizeHighlights`).
- **`storyboarder.md`** documents `highlights_path` → author one short per candidate window;
  the `{start_seconds, end_seconds}` bound each short's source material; `hook_type`/`reason`/
  `suggested_title` are hints.

## Registration (5 places — boot guard `verifyAdapterToolReferences` enforces)

1. `mcp/lib/tools/index.js` `TOOL_MODULES`; 2. `role_bundles:["orchestrator"]`;
3. `SKILL.md` `allowed-tools`; 4. `settings.json` `permissions.allow`; 5. OpenCode — **no
change** (the orchestrator allows MCP tools by default; only the 3 subagent write tools are
enumerated to be denied).

## Verification

- Source-free walker phase `highlights` (`node scripts/m5-walker.js highlights`): asserts
  ranking order, keep-span snapping, duration within the intent band, overlap dedupe,
  key-moment inclusion, count cap, fail-safe empty on weak signals, AND the full tool path
  end-to-end (real temp session → write inspect artifacts → record intent → propose → check
  `plan/highlights.json` + `state.highlights` + `read_state_summary`).
- Boot integrity green on both adapters (`registry-integrity.js`).
- `node scripts/m5-walker.js fanout` confirms the downstream fan-out path still passes.

## Out of scope for v1

- Multi-source / cross-file highlights (winner-file only).
- Model-based re-ranking of candidates (the storyboarder + editorial-critic provide model
  judgment downstream).
- Audio/beat-aware moment boundaries (a later audio-layer feature).
- Auto-generating final titles/captions beyond a `suggested_title` hint.
