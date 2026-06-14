# PRD: Structured revision capture at the back-edge + ratable version labels

## 1. Summary

When a human back-edges out of `RENDER`/`PACKAGE`/`ITERATE` into `COMPOSE`/`PLAN`, the engine already archives the current cut (`renders/` + `package/` → `archive/v<N>/`, brief/storyboard/compose copied, iteration version bumped) — but it captures **no "why"** and stamps **no human-readable label or rating** on the version. This PRD makes the archival back-edge the structured attach point for both. It adds four optional, **advisory** args to `vob_transition_phase` — `revision_intent` (free text), `target_layer` (typed enum aligned 1:1 to PLAN/composer fields), `revision_label`, `prior_rating`, `preferred` — folds them into the `iteration_archived` history event, the `iteration.archive[]` record, and the version snapshot, and surfaces a lean `archived_versions[]` digest in `buildStateSummary` so the orchestrator can present a ratable, comparable version list at ITERATE without per-snapshot disk reads. Capture and labels ship together behind one shared `inputSchema` because they share the same call and the same archival sink. No new tool, no new edge, no gate change — feedback **never** gates a transition.

## 2. Problem & motivation

The archival back-edge is structurally rich but semantically blind today:

- `archiveForIteration` (`mcp/lib/archival.js:99`) moves outputs, copies intent, and builds a `record` (`archival.js:146-157`) whose only metadata is `version`, `archived_at`, and `paths`. The version that just got abandoned carries no reason and no quality signal.
- `buildSnapshot` (`archival.js:69-91`) freezes `target`/`preview`/`render`/`package` slots and a 20-event history tail, but no human annotation — so an archived `v1` is diffable by *artifact* but not searchable by *intent* ("the v2 where I tightened the hook").
- The `iteration_archived` history event (`mcp/lib/session-state.js:705-712`) records `archive_version` + `paths` only. The signature `archiveForIteration(state, { from, to })` (`archival.js:99`) has **no** slot for caller-supplied feedback.
- `buildStateSummary` exposes only `archived_version_count` (`session-state.js:517`) — a bare integer. ITERATE.md step 4 (`adapters/.../phases/ITERATE.md:39-40`) can only point the user at `archive/v1/` on disk; the orchestrator cannot present a labeled, rated, comparable list, so "compare prior cuts and promote the best one" (the thin-ITERATE goal of this batch) has no data to read.
- A self-containment gap blocks any lean digest: `archive.apply()` (`archival.js:159-169`) deletes the `render` slot, so `render.render_duration_seconds` and the final mp4 path are **gone** from `state` by the time the summary is built. A naive `archived_versions[]` would have to re-read each `snapshot.json` off disk to recover them.

Net: the back-edge is the one moment a human is actively judging a cut ("not good enough, revise the hook"), and the engine throws that judgment away. This PRD captures it where it already happens, with zero new ceremony.

## 3. Goals / Non-goals

**Goals**

- Add four optional args to `vob_transition_phase` — `revision_intent`, `target_layer`, `revision_label`, `prior_rating`, `preferred` — declared explicitly in `inputSchema.properties` (validator defaults `additionalProperties:false`).
- On a **genuine archival back-edge** (one where `archiveForIteration` returned non-null), fold capture into the `iteration_archived` history event, the `archive[]` record, and `buildSnapshot`.
- Validate labels/rating tool-side: `prior_rating ∈ 1..5 or null`; `revision_label` a trimmed string capped ~80 chars; `preferred` a bool — reject malformed with `INVALID_ARGUMENTS`.
- Close the digest self-containment gap: read `render.render_duration_seconds` + the archived final mp4 rel-path **before** `apply()` deletes the render slot, and stamp them into the record.
- Surface `archived_versions[]` (`{id, version, label, rating, preferred, archived_at, render_duration}`) in `buildStateSummary` with **no per-snapshot disk read**.
- Keep the whole feature **advisory**: nothing gates on it; `preferred` does not enforce a single winner.

**Non-goals (and why)**

- **No parallel A/B variant model.** Per the fixed product decision, ITERATE stays thin: sequential overwrite + archive read-back. `preferred` is a *label*, not a branch — multiple versions may be flagged and nothing reconciles them. A variant model fights the sequential-overwrite archival design.
- **No `target_layer → phase` routing logic in the engine.** The enum is an engine-side shared constant (structure); the routing table that maps a chosen layer to `COMPOSE` vs `PLAN` and to storyboarder/composer revision notes stays in the orchestrator (wording/UX). This honors the narrow engine↔skill contract ("the server enforces structure, the skill owns wording").
- **No gate or transition behavior change.** Feedback must never block, redirect, or reorder a transition. Deferred permanently — gating on subjective feedback would corrupt the deterministic FSM.
- **No new tool / no `archive`-mutating write path.** Labels are written **only** through `transitionPhase` under `withSessionLock`. A "re-rate an old version" tool is deferred — it would need a second writer into `iteration.archive[]` and a fresh lock discipline; out of scope for the thin slice.
- **No back-fill of pre-existing archives.** Versions archived before this ships have no label/rating; the summary tolerates absent fields (renders `null`).
- **No manifest/README surfacing of labels.** `package_output` lineage stays as-is this round; labels live in state + snapshot only. (A future PRD may surface `preferred` in the package README.)

## 4. Design

### 4.1 Data flow

```
orchestrator (ITERATE.md step 3) — on a GENUINE human revision only —
  vob_transition_phase { project_id, to_phase: "COMPOSE"|"PLAN",
                         revision_intent?, target_layer?,
                         revision_label?, prior_rating?, preferred? }
        │
        ▼
transitionPhase (session-state.js:589)
  1. validate the 5 new args  → ToolError(INVALID_ARGUMENTS) on malformed
  2. existing edge + gate checks (UNCHANGED — feedback never consulted here)
  3. if isArchivalTransition(from,to):
        archive = archiveForIteration(state, { from, to, feedback })   ← feedback threaded (:676)
        (archiveForIteration: snapshot reads render slot BEFORE apply() deletes it,
         stamps duration+final rel-path+label/rating/preferred into the record)
  4. next = archive.apply(next)            ← apply runs at :685 (spreads ...next)
  5. stamp nothing extra onto next.* after apply (record already carries it)
  6. push iteration_archived history event WITH feedback fields (:705-712, only when archive!=null)
        │
        ▼
buildStateSummary (session-state.js:505) → archived_versions[]  (lean, no disk read)
```

### 4.2 The shared validation + normalization helper

A single normalizer parses all five args once, near the top of `transitionPhase` (after the `to_phase` enum check at `session-state.js:594-596`, before `withSessionLock`). It returns a frozen `feedback` object or throws `INVALID_ARGUMENTS`. The cap idiom mirrors the existing `MAX_NOTES_LENGTH` pattern in `log-composer-invocation.js:8,25`.

`TARGET_LAYERS` is a new exported `Object.freeze([...])` constant living in `mcp/lib/archival.js` (co-located with the archival logic it feeds — **its stated home; it does NOT land in `storyboard-schema.js`**), imported by `session-state.js`:

```
cuts | timing | captions | overlays | broll | look | pacing | hook | audio | order | tone
```

Each value maps 1:1 to a real PLAN/composer field the storyboarder/composer already consume (e.g. `cuts`→`a_roll` cut points, `captions`→`caption_segments`, `overlays`→`scene.overlays`, `broll`→`broll_placements`, `look`→`target.design`, `pacing`→scene `pacing`, `hook`→hook beat, `order`→scene/segment order, `tone`/`audio`→intent keys). The engine does **not** route on these — it only validates membership.

Normalization rules:
- `revision_intent`: optional string; trimmed; if non-string → `INVALID_ARGUMENTS`; empty-after-trim → treated as absent (`null`).
- `target_layer`: optional string; must be in `TARGET_LAYERS` → else `INVALID_ARGUMENTS` with the valid list in `details`; absent → `null`.
- `revision_label`: optional string; trimmed; cap **80 chars** (`MAX_LABEL_LENGTH`); over-cap → `INVALID_ARGUMENTS`; empty → `null`.
- `prior_rating`: optional; must be an **integer 1..5** or `null`; anything else (string, float, 0, 6) → `INVALID_ARGUMENTS`.
- `preferred`: optional **boolean**; non-bool → `INVALID_ARGUMENTS`; absent → `false`.

If **none** of the five are supplied, `feedback` is `null` and every downstream sink behaves byte-for-byte as today.

### 4.3 `archiveForIteration` — thread feedback + close the self-containment gap

New optional 3rd field on the options bag: `archiveForIteration(state, { from, to, feedback })` (`archival.js:99`). `feedback` is the normalized object (or `null`).

Two reads must happen **before** `apply()` deletes the render slot. The reasoning that makes this safe: `apply` runs inside `transitionPhase` (`session-state.js:685`), *after* `archiveForIteration` returns, and it mutates `next` — a fresh `{...state}` spread — never `state` itself. So at record-build time inside `archiveForIteration`, the original `state.render` slot is still live and untouched:

- `render_duration_seconds`: `state.render && Number.isFinite(state.render.render_duration_seconds) ? … : null` (slot shape confirmed at `session-state.js:479`).
- `final_render_rel`: `state.render.mp4_path` is stored **absolute** (`render-full.js:226`, gotcha noted in CLAUDE.md). The archived copy lives at `archive/v<N>/renders/…`. `buildSnapshot` freezes the full live `render` slot at `archival.js:81` (the `render:` field; `:84` is the unrelated `composition_revision_at_archive`), so the snapshot path is independently self-contained; the **record** stores the **session-relative** path to the moved render dir (`record.paths.renders`, already computed at `archival.js:150`) plus the original mp4 basename — sufficient to locate the archived final without a disk walk. Concretely: stamp `final_render: record.paths.renders ? path.join(record.paths.renders, path.basename(state.render.mp4_path)) : null`.

The record (`archival.js:146-157`) gains a conditional-spread `feedback` block + the two derived fields:

```jsonc
{
  "version": 2,
  "archived_at": "2026-06-14T18:22:07.512Z",
  "paths": { "renders": "archive/v2/renders", "package": "archive/v2/package",
             "brief": "archive/v2/brief.md", "storyboard": "archive/v2/storyboard.json",
             "compose": "archive/v2/compose", "snapshot": "archive/v2/snapshot.json" },
  "render_duration_seconds": 41.8,
  "final_render": "archive/v2/renders/final-1718387100.mp4",
  // present only when the caller supplied feedback:
  "label": "tightened hook",
  "rating": 3,
  "preferred": false,
  "revision_intent": "hook felt slow, first 2s buried the payoff",
  "target_layer": "hook"
}
```

`buildSnapshot` (`archival.js:69-91`) gains the same `feedback` block, spread conditionally so a no-feedback archival writes byte-identical snapshots to today:

```jsonc
{
  "version": 2, "archived_at": "...", "from_phase": "RENDER", "to_phase": "COMPOSE",
  // ...existing fields unchanged (render slot at :81)...
  "revision": {                      // present only when feedback != null
    "label": "tightened hook", "rating": 3, "preferred": false,
    "revision_intent": "hook felt slow...", "target_layer": "hook"
  }
}
```

`buildSnapshot`'s signature gains `feedback` in its options bag; it runs **inside** `archiveForIteration` (`archival.js:143`), before the record is built — a separate edit from the record stamp because they are two call sites.

### 4.4 `transitionPhase` — write order + the history event

In `transitionPhase` (`session-state.js:674-712`):
- Pass `feedback` into `archiveForIteration` at `:676`.
- `archive.apply(next)` already runs at `:685`. **No new `next.*` slot is written for this feature** — all feedback lives inside the `record` (already inside `iteration.archive[]` via `apply`). This sidesteps the write-order hazard entirely: `apply` does `{...next}` and could clobber a slot set earlier, so we set nothing earlier.
- The `iteration_archived` event (`:705-712`) gains the feedback fields, spread conditionally and **only when `archive` is non-null**:

```jsonc
{
  "kind": "iteration_archived", "at": "...", "archive_version": 2,
  "paths": { ... },
  "revision_intent": "hook felt slow...",   // only if feedback supplied
  "target_layer": "hook",
  "label": "tightened hook", "rating": 3, "preferred": false
}
```

The `transition` event (`:735-742`) is **unchanged** — feedback rides the archive event, not the transition event. This produces the two distinct no-op behaviors the feature relies on:

1. **Non-archival edge carrying feedback args (a misuse).** `isArchivalTransition(from, toPhase)` is `false` (the edge's `from` is not in `ARCHIVE_FROM = {RENDER, PACKAGE, ITERATE}`), so the `if` at `:675` is never entered, `archiveForIteration` is **never called**, `archive` stays `null`, and the `archiveEvents` array is empty (`:712`). The feedback is dropped **because `isArchivalTransition` is false** — not via any "nothing to archive returns null" path. The `transition` event never carries feedback, so a forward edge with stray args produces zero history pollution.
2. **Genuine archival edge with nothing on disk to move.** Here `isArchivalTransition` is `true`, `archiveForIteration` **is** called, and it returns `null` (no `renders/` and no `package/`); `archive` stays `null` and the feedback is again dropped — this is the "nothing to archive returns null" path described at `archival.js:97-98`.

The orchestrator populates these args **only** on a genuine human revision; both no-op paths above guarantee a stray or premature arg is silently and harmlessly discarded.

### 4.5 `buildStateSummary` — `archived_versions[]`

A new helper `summarizeArchivedVersions(state)` maps `iteration.archive[]` to a lean digest, added to the return object at `session-state.js:517` (immediately adjacent to the existing `archived_version_count`). **No per-snapshot disk read** — every field comes from the record:

```jsonc
"archived_versions": [
  { "id": "v1", "version": 1, "label": null, "rating": null, "preferred": false,
    "archived_at": "2026-06-14T17:05:01.220Z", "render_duration": 39.2 },
  { "id": "v2", "version": 2, "label": "tightened hook", "rating": 3, "preferred": false,
    "archived_at": "2026-06-14T18:22:07.512Z", "render_duration": 41.8 }
]
```

`id` is `"v" + version`. Absent fields (pre-feature archives) render `null`/`false`. `render_duration` reads `record.render_duration_seconds` (the self-containment fix; `0`/absent → `null`). The existing scalar `archived_version_count` stays for back-compat.

> **Batch contract note (ITERATE Wave-A):** `archived_versions[]` is the digest **PRD 4 (compare)** and **PRD 7 (promote)** consume. This PRD is its sole producer; **freeze this §4.5 shape first**. PRD 4 gates on `Array.isArray(s.archived_versions)` so it tolerates the field's absence (ships independent of feedback capture); PRD 7's UX requires the populated shape, so PRD 7 lands after this PRD.

## 5. Seam-level change list

| File | Anchor | Change |
|---|---|---|
| `mcp/lib/tools/transition-phase.js` | `inputSchema.properties`, `:11-18`; description `:8` | Add 5 optional props: `revision_intent` (string), `target_layer` (string, `enum:[...TARGET_LAYERS]`), `revision_label` (string), `prior_rating` (`type:["integer","null"]` — type arrays are supported by the validator, `tool-validation.js:6`), `preferred` (boolean). Each MUST be declared (validator `additionalProperties:false`). Update `description` at `:8` to note them as advisory, archival-back-edge-only. **No** `required` change. **No** metadata-block change (still `session_artifacts_written:["state.json"]`). **2-way collision with PRD 7** (`promote_from_version`): both edit this `properties` block AND the `:8` description — merge into ONE `properties` object; land this PRD first, PRD 7 rebases onto its final shape. |
| `mcp/lib/archival.js` | new export near `:20` | Add `const TARGET_LAYERS = Object.freeze(["cuts","timing","captions","overlays","broll","look","pacing","hook","audio","order","tone"]);` and add to `module.exports` (`:174-180`). **Lands here, not in `storyboard-schema.js`.** |
| `mcp/lib/archival.js` | `buildSnapshot` `:69-91` | Add `feedback` to the options bag; conditional-spread a `revision:{...}` block when `feedback != null`. Render slot stays at `:81`. |
| `mcp/lib/archival.js` | `archiveForIteration` `:99` + record `:146-157` | Add `feedback` to options bag. Before building `record`, derive `render_duration_seconds` (from `state.render`, `Number.isFinite`) and `final_render` (`record.paths.renders` join `basename(state.render.mp4_path)`). Stamp both + conditional-spread `feedback` fields into `record`. Pass `feedback` into the `buildSnapshot` call at `:143`. **Reads are safe — `apply` runs later in the caller and mutates `next`, not `state`.** |
| `mcp/lib/session-state.js` | import `:9` | Import `TARGET_LAYERS` from `./archival.js`. |
| `mcp/lib/session-state.js` | new helper + `transitionPhase` `:594-604` | Add `normalizeRevisionFeedback(args)` (validates the 5 args, throws `INVALID_ARGUMENTS` via the already-imported `ToolError`/`ERROR_CODES` at `:5`; cap idiom per `log-composer-invocation.js:8,25`). Call it after the `to_phase` enum check at `:594-596`. Add `MAX_LABEL_LENGTH = 80`. |
| `mcp/lib/session-state.js` | `transitionPhase` `:676` | Pass `feedback` into `archiveForIteration(state, { from, to: toPhase, feedback })`. |
| `mcp/lib/session-state.js` | `transitionPhase` `:705-712` | Conditional-spread feedback fields into the `iteration_archived` event (only when `archive` non-null). |
| `mcp/lib/session-state.js` | new helper + `buildStateSummary` `:517` | Add `summarizeArchivedVersions(state)`; add `archived_versions: summarizeArchivedVersions(state)` to the return object next to `archived_version_count` (`:517`). |
| `scripts/m5-walker.js` | `runLongform`, back-edge block `:1593-1600` | Pass feedback args on the `RENDER→COMPOSE` back-edge; assert record + history + summary (see §8). Plus a negative-fixture block for malformed args. |

**New files:** none. **New state keys:** `iteration.archive[].{render_duration_seconds, final_render, label, rating, preferred, revision_intent, target_layer}` (all additive, conditional); summary `archived_versions[]`; history `iteration_archived.{revision_intent,target_layer,label,rating,preferred}` (additive). **`paths.js` additions:** none (reuses `record.paths.renders`). **Manifest:** untouched — no `manifest_version` bump. **Tool-registry / allow-list / port-adapter:** none — adding optional args to an existing tool needs no `TOOL_MODULES`/SKILL.md/settings.json/opencode.json edit and is invisible to `verifyAdapterToolReferences` (it tracks tool **names**, not arg schemas).

## 6. Invariants preserved

- **package_output's two refusals stay before any wipe.** Untouched — this PRD adds nothing to `package_output`. The fan-out and unassembled-segmented `STATE_CONFLICT` refusals remain the first thing that runs.
- **`package/` wipe never reaches `deliverables/`.** Untouched — no package-path changes.
- **Back-edge auto-archive is atomic under the lock; a prior cut is never destroyed.** The new reads (`render_duration_seconds`, `final_render`) are pure reads off the still-live `state.render` slot **before** `apply()` (`session-state.js:685`) deletes it; the new record/snapshot fields are additive. All of it runs inside the existing `withSessionLock` block (`session-state.js:604`) before `writeFileAtomic` (`:744`). Moves/copies are unchanged.
- **`state.json` written only by `vob_*` tools.** Labels are written **only** through `transitionPhase`; no separate archive-mutating writer is introduced.
- **FSM never skips forward; edges unchanged.** No `ALLOWED_TRANSITIONS` edit, no `GATES` edit — this adds neither an edge nor a precondition. `phase-gates.js` is untouched. The gate verdict at `:618-641` never consults feedback.
- **Two-tier override unchanged.** Feedback args are advisory and orthogonal to `override_reason`; non-overridable blockers still refuse before any archival runs (`:625-633`).
- **Gates re-check disk.** Unaffected — no gate logic touched.
- **The 5 required intent keys are never renamed.** Untouched; `target_layer`'s `tone`/`audio` values are *labels for which layer to revise*, not intent keys.
- **Conditional-spread additivity.** Every new record/snapshot/history/summary field is conditional-spread (`...(x ? {x} : {})`); a no-feedback archival is byte-for-byte identical to today, and `manifest_version` is not bumped (no internal consumer must distinguish).

## 7. Data dependencies & availability

- **`render.render_duration_seconds`** — confirmed present, stamped by `render-full.js:228` and surfaced by `summarizeRender` (`session-state.js:479`). Read off the live slot before `apply()` deletes it. Absent on import-only/segmented-pre-assembly paths → `null` (tolerated).
- **`render.mp4_path` (absolute)** — confirmed present (`render-full.js:226`), and for segmented projects the assembled final *becomes* the render slot (`session-state.js:1624` walker asserts this). The archived rel-path is derived from `record.paths.renders` (computed at `archival.js:150`) + its basename — no absolute path leaks into the session-relative record.
- **`iteration.archive[]`** — confirmed the canonical archive list (`archival.js:43-48`, `:162-163`). `archived_versions[]` maps it directly.
- **`target_layer` enum values** — map 1:1 to fields the storyboarder (`storyboard-schema.js`) and composer already consume; confirmed real (cuts/captions/overlays/broll/look/pacing/order present in schema; hook/tone/audio map to intent + hook beat). The **routing** from layer→phase is the orchestrator's table (ITERATE.md), not engine data — no engine dependency.
- **No upstream blockers.** Every consumed field already exists; nothing is gated on a non-persisted remap.

## 8. Verification

**Walker phase: `longform`** (already exercises a single-timeline archival back-edge at `m5-walker.js:1593-1600` — the natural home; no new phase needed).

Add to the `RENDER→COMPOSE` back-edge `step` at `:1593`:
1. Call with feedback: `vob_transition_phase { project_id: LF, to_phase: "COMPOSE", revision_intent: "act-1 too long", target_layer: "timing", revision_label: "trim act 1", prior_rating: 3, preferred: true }`.
2. Assert `r.archived` is truthy (existing) **and** `r.archived.label === "trim act 1"`, `r.archived.rating === 3`, `r.archived.preferred === true`, `r.archived.target_layer === "timing"`, `r.archived.revision_intent` set.
3. Assert `r.archived.render_duration_seconds` is a finite number and `r.archived.final_render` starts with `archive/v` and ends `.mp4` (self-containment fix).
4. Read summary: assert `s.archived_versions` is an array, last entry `id === "v<N>"`, `label === "trim act 1"`, `rating === 3`, `preferred === true`, `render_duration` finite — **and** assert no `snapshot.json` read was needed (implicit: the data is in the summary).
5. Assert the `iteration_archived` history event carries the fields: read state with `include:["history"]`, find the last `iteration_archived`, assert its `target_layer`/`label`/`rating`.

Add a **negative-fixture** block (uses the existing `expectError` helper, `m5-walker.js:66`) on a fresh archival back-edge or a benign forward edge:
- `prior_rating: 6` → `INVALID_ARGUMENTS`; `prior_rating: 2.5` → `INVALID_ARGUMENTS`; `target_layer: "vibes"` → `INVALID_ARGUMENTS` with valid list in details; `revision_label` of 200 chars → `INVALID_ARGUMENTS`; `preferred: "yes"` → `INVALID_ARGUMENTS`.

Add a **no-op tolerance** assertion: a forward (non-archival) transition carrying `revision_intent` succeeds and the `transition` history event does **not** carry feedback fields — dropped because `isArchivalTransition` is `false`, so `archiveForIteration` is never called and the `archiveEvents` array is empty (no pollution, §4.4 path 1).

Add a **back-compat** assertion: a back-edge with **no** feedback args still archives and `r.archived` has no `label`/`rating`/`revision_intent` keys (conditional-spread proof), and `archived_versions[]` renders them as `null`/`false`.

**Manual check:** the no-op proof must run against a **genuine archival back-edge** (the `longform` `RENDER→COMPOSE` at `:1593`) and a forward edge — *not* the `fanout` `PREVIEW→COMPOSE` at `:813`, which is **not** an archival transition (`PREVIEW ∉ ARCHIVE_FROM = {RENDER, PACKAGE, ITERATE}`), so `archiveForIteration` is never even invoked there. Concretely: run `node scripts/m5-walker.js longform` (its machine-driven `RENDER→COMPOSE` and `RENDER→PACKAGE` archival back-edges must still archive with feedback absent — confirms the `archive!=null`-but-no-feedback path stays byte-identical) and `node scripts/m5-walker.js fanout` (its `PREVIEW→COMPOSE` back-edges confirm the orthogonal `isArchivalTransition === false` short-circuit). Inspect one `archive/v2/snapshot.json` to confirm the `revision` block appears only when feedback was supplied.

## 9. Parallel-safety & sequencing

**NOT parallel-safe.** This PRD touches the three hottest shared files in the engine:
- `mcp/lib/session-state.js` — `transitionPhase` (the FSM heart) + `buildStateSummary`.
- `mcp/lib/archival.js` — `archiveForIteration` + `buildSnapshot` (the iteration model).
- `mcp/lib/tools/transition-phase.js` — the tool surface.

**Collision risk** with the ITERATE Wave-A siblings:
- **PRD 7 (promote)** — 2-way HARD collision on `transition-phase.js` `inputSchema.properties` (`:11-18`) and its description (`:8`): both PRDs add args there. They must merge into ONE `properties` object. PRD 7 also re-sequences the materialize/archive blocks **inside** `transitionPhase` (`session-state.js:589-757`), overlapping this PRD's `archiveForIteration` thread (`:676`) and history-build (`:705-712`). **This PRD MUST land before PRD 7**; PRD 7 rebases its re-sequencing onto this PRD's settled history-build and the `archiveForIteration(... feedback)` call shape.
- **PRD 4 (compare)** — reads `archived_versions[]` (the §4.5 digest) but does not edit `transitionPhase` or the summary producer; it gates on `Array.isArray`, so it tolerates absence and ships independently. It only consumes this PRD's contract.

**Sequencing (ITERATE Wave-A chain):**
- The internal batch order is **PRD 4 (compare, read-only) → PRD 6 (this PRD: feedback + labels) → PRD 7 (promote)**. PRD 4 ships independent of `feedback[]`; this PRD produces the `archived_versions[]` digest both PRD 4 and PRD 7 consume; PRD 7 re-sequences `transitionPhase` and lands last.
- Land **after** any phase 1–7 work that restructures `iteration`/archival/`buildStateSummary` (rebasing onto a moved `archiveForIteration` signature or a renamed record shape is the main rework risk).
- **Freeze the §4.5 `archived_versions[]` shape first** — it is the cross-PRD contract.
- **Capture and labels ship together** in this single PRD behind one shared `inputSchema` — do not split them; they share the `transitionPhase` call, the `archiveForIteration` thread, and the same record/snapshot/history sinks, so splitting would touch the same hot lines twice.

**Recommended branch/commit boundaries:** one dedicated branch off the post-refactor base. Suggested commit order (each independently walker-greenable): (1) `archival.js` — `TARGET_LAYERS` export + `buildSnapshot`/`archiveForIteration` feedback thread + self-containment reads; (2) `session-state.js` — `normalizeRevisionFeedback` + `transitionPhase` wiring + `archived_versions[]` summary; (3) `transition-phase.js` inputSchema; (4) `m5-walker.js` assertions. Run `node scripts/m5-walker.js longform fanout` after each commit; the boot guard (`verifyAdapterToolReferences`) needs nothing since no tool name or allow-list changed.
