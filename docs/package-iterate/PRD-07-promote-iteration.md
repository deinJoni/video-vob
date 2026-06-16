# PRD: Promote an archived cut via the existing back-edge (not a render-slot writer)

## 1. Summary

ITERATE (and PACKAGE) already lets the user back-edge to COMPOSE to start a new iteration; `transitionPhase` archives the live `renders/`+`package/` into `archive/v<N>/` and re-cuts clips on COMPOSE entry. What it does *not* let them do is say "go back to **v2** and re-render from there." Today the only way to act on an archived cut is to manually hand-restore files — which no tool sanctions and which would strand the live working tree. This PRD adds one optional argument, `promote_from_version`, to the existing `vob_transition_phase` tool, handled **inside `transitionPhase` on the existing `{ITERATE,PACKAGE}->COMPOSE` back-edge**. When present it (a) archives the *current* live cut first (symmetric, non-destructive — nothing is ever lost), (b) restores `archive/v<K>/{brief.md,storyboard.json,compose/}` into the live tree with `copyIfExists` (excluding the never-archived `compose/source/`), and (c) lets the standard COMPOSE entry's `materializeSceneClips` rebuild `source/` from the restored storyboard so the re-render runs fully on rails. No new tool, no new FSM edge, no render-slot write, no phase skip. It is scoped to single-timeline (segmented later); fan-out is refused with a clear message because finished fan-out work lives in session-level `deliverables/`, not in `archive/v<N>/renders`.

## 2. Problem & motivation

Back-edges out of `RENDER`/`PACKAGE`/`ITERATE` into `COMPOSE`/`PLAN` auto-archive: `transitionPhase` calls `archiveForIteration` (`session-state.js:675-677`), which **moves** `renders/`+`package/` into `archive/v<N>/` and **copies** `brief.md`/`storyboard.json`/`compose/` (minus `compose/source/`) there (`archival.js:122-136`), bumps `iteration.current_version`, and deletes the `preview`/`render`/`package` slots (`archival.js:159-169`). Every archived version is fully diffable on disk and recorded in `iteration.archive[]` with relative paths (`archival.js:146-157`).

But the archive is **write-only from the user's perspective**. There is no path that reads a `v<K>` back into the live tree. A user who iterated v1→v2→v3, then decided v2 was the better cut, has three bad options:

1. Hand-restore `archive/v2/{brief.md,storyboard.json,compose/}` over the live tree — but `state.json`/`brief.md` are tool-write-only (the adapter write-guards block direct writes), and even if they weren't, `compose/source/` is excluded from archives (`archival.js:131-136`), so the restored composition would reference clips that no longer exist on disk.
2. Hand-copy `archive/v2/renders/final.mp4` into the live `render` slot — but `state.render.mp4_path` is tool-write-only, and even a hypothetical writer would immediately trip `render_stale_composition` (`phase-gates.js:477-485`): the archived render's `composition_revision_rendered` is *below* the now-advanced live `composition.revision_count`, so `RENDER->PACKAGE` would refuse.
3. Re-author v2 from scratch — defeating the entire point of the archive.

The orchestrator can already *see* the archive count (`iteration_version`, `archived_version_count` in `buildStateSummary`, `session-state.js:516-517`), and once `vob_compare_iterations` ships (PRD 4) it can read each archived snapshot to help the user *choose* a version. But there is no sanctioned *action* to take on that choice. This PRD is that action.

## 3. Goals / Non-goals

**Goals**

- Let a user promote a prior archived cut `v<K>` to become the live working point, then re-render it on rails, via a single optional arg on an existing tool.
- Be strictly non-destructive: the current live cut is archived (as a *new* version) before the promotion overwrites the live tree, exactly as a normal back-edge would archive it.
- Reuse the existing on-rails machinery end to end: archival via `archiveForIteration`, file ops via `moveIfExists`/`copyIfExists`, clip rebuild via the COMPOSE-entry `materializeSceneClips` side effect. The re-render path is the ordinary COMPOSE→PREVIEW→RENDER cycle with zero special-casing.
- Validate `promote_from_version` against `iteration.archive[]` and fail `NOT_FOUND` on a missing/non-archived version, before any fs mutation.
- Record an auditable `iteration_promoted` history event.

**Non-goals (and why)**

- **No parallel A/B variant model.** Promotion is a *sequential* overwrite of the live tree (the current cut is archived, the chosen one becomes live). A side-by-side variant store would fight the sequential-overwrite archival design that this whole subsystem is built on. (Fixed product decision for the ITERATE batch.)
- **No new tool and no new FSM edge.** Promotion is an *argument* on the existing `vob_transition_phase`, handled inside `transitionPhase` on the existing `{ITERATE,PACKAGE}->COMPOSE` edge. Adding a tool is a wide seam (4 registration sites + `port-adapter-docs.js` + the `verifyAdapterToolReferences` boot guard); adding an optional arg to an existing tool needs none of it. Adding an edge would mean editing both `ALLOWED_TRANSITIONS` and `GATES` — unnecessary, the edge already exists: `ITERATE->COMPOSE` (`session-state.js:31`) and `PACKAGE->COMPOSE` (`session-state.js:30`) are present with gates `iterateToCompose` (`phase-gates.js:628`) / `packageToCompose` (`phase-gates.js:619`).
- **No render-slot write and no phase jump.** Writing `state.render` directly or jumping to PACKAGE/RENDER would break "FSM never skips forward" and trip `render_stale_composition`. Promotion lands the user at COMPOSE and makes them re-render — correct and on rails.
- **No fan-out support in this PRD.** Fan-out finished work lives in session-level `deliverables/` (`paths.js:347-349`), not `archive/v<N>/renders` — a fan-out promote would target the wrong store. Refused with a clear message. (Single-timeline now; segmented can be layered in a follow-up since segmented finals *do* land in `renders/`.)
- **No promotion from `PACKAGE`.** Although `PACKAGE->COMPOSE` is also an archival back-edge, the orchestrator-facing "promote a prior cut" flow is an ITERATE-phase decision (the user is reviewing finished iterations). We *implement* the arg generically inside `transitionPhase` so it works on any `->COMPOSE` archival back-edge, but the walker + orchestrator drive it from ITERATE. (No extra cost to allow it from PACKAGE; we simply don't special-case the source phase.)

## 4. Design

### 4.1 Surface

One new optional property on `vob_transition_phase`'s `inputSchema.properties` (`tools/transition-phase.js:11-18`):

```
promote_from_version: {
  type: "integer",
  minimum: 1,
  description: "Restore archive/v<K>/{brief,storyboard,compose} into the live tree on a ->COMPOSE back-edge, after archiving the current cut. Single-timeline only; refused on fan-out. The standard COMPOSE entry rebuilds source/ and you re-render on rails."
}
```

Because tool-arg validation defaults `additionalProperties:false`, this property **must** be declared explicitly or the validator rejects it (the `save_classification` lesson). The `description` string on `transition-phase.js:8` is updated to mention the arg.

**Schema-collision note (vs PRD 6).** PRD 6 (revision-capture) also adds five args (`revision_intent`, `target_layer`, `revision_label`, `prior_rating`, `preferred`) to this same `inputSchema.properties` block (`:11-18`) and also edits the `:8` description. PRD 6 lands **before** this PRD (see §9). This PRD therefore appends `promote_from_version` to PRD 6's already-extended `properties` object — one merged properties literal, not two — and amends the description PRD 6 wrote rather than the original. There is no behavioral interaction between the arg sets; they are independent optional keys.

### 4.2 Where it hooks

All logic lands in `transitionPhase` (`session-state.js:589-757`), inside the existing `withSessionLock` async callback, so every fs op and the state write happen atomically under the per-session lock. PRD 6 has already threaded its feedback args through this same function (`archiveForIteration` call at `:676` and the history build at `:705-712`); this PRD **rebases onto PRD 6's final shape** of `transitionPhase` before re-sequencing.

The hook point is **right where archival already happens** — after the gate verdict passes (`session-state.js:641`) and at/around the existing archival block (`session-state.js:674-677`). The ordering is critical and is spelled out in 4.4.

### 4.3 New helper — `promoteArchivedVersion` in `archival.js`

Add a pure-ish helper alongside `archiveForIteration`, reusing `moveIfExists`/`copyIfExists`/`archiveVersionDir`/path builders already imported there (`archival.js:6-17`). Signature and behavior:

```
promoteArchivedVersion(state, { version }) -> { restored: { brief, storyboard, compose }, version }
```

- Validates `version` is an integer ≥1 and that an `iteration.archive[]` entry with that `version` exists (`currentArchive(state)`, `archival.js:43-48`). Missing → throw `ToolError(NOT_FOUND, ...)`. **`ToolError`/`ERROR_CODES` are NOT currently imported in `archival.js`** (confirmed — `archival.js:1-18` imports only path builders + `writeFileAtomic`); add `const { ToolError, ERROR_CODES } = require("./envelope.js");` to the import block.
- Resolves the source dir via `archiveVersionDir(projectId, version)` (`paths.js:355-360`) and confirms `fs.existsSync` on disk (gate convention: trust disk, not the state summary). A recorded-but-vanished archive → `NOT_FOUND`.
- Restores three artifacts into the **live** tree with `copyIfExists` (overwriting whatever is live — the current cut was already archived in 4.4 step (a), so this is safe):
  - `archive/v<K>/brief.md` → `briefPath(projectId)`
  - `archive/v<K>/storyboard.json` → `storyboardPath(projectId)`
  - `archive/v<K>/compose/` → `composeDir(projectId)` — **but `compose/source/` is excluded from the archive** (`archival.js:131-136`), so it is not present to restore. The restored `compose/` is the authored composition only (HTML/CSS/JS, `fonts.css`, etc.); `source/` is rebuilt by the COMPOSE-entry side effect. We must first remove the *live* `compose/` so a stale `source/` symlink tree from the just-archived cut doesn't survive under the restored composition — `copyIfExists`/`cpSync` of `compose/` does **not** delete pre-existing live children, so a stale `source/` would otherwise persist. The helper therefore `fs.rmSync(composeDir(projectId), {recursive,force})` before the `copyIfExists`, mirroring how `vob_save_composition` wipes `compose/` before recreating `source/` symlinks (`composeDir` at `paths.js:230`, `composeSourceDir` at `paths.js:234`).
- Returns which artifacts were restored (each `true`/`false` from `copyIfExists`) and the version, for the history event + tool return. Does **not** mutate `state` and does **not** touch `renders/`/`package/`/`state.render` — those are handled by the archival in step (a) and rebuilt by the on-rails re-render.

`storyboard.json` MUST be present in the archive for a promote to be meaningful (the COMPOSE entry reads it to materialize clips, `session-state.js:659-665`). If `copyIfExists` returns `false` for storyboard (archive lacks it), throw `NOT_FOUND` ("archive v<K> has no storyboard.json — cannot promote a version that never reached PLAN").

### 4.4 End-to-end flow inside `transitionPhase`

When `promote_from_version` is supplied, after the gate passes:

1. **Guard the edge.** It is only legal on a `->COMPOSE` back-edge where archival applies, i.e. `toPhase === "COMPOSE" && isArchivalTransition(from, toPhase)`. Otherwise throw `INVALID_ARGUMENTS` ("promote_from_version is only valid on a back-edge into COMPOSE from RENDER/PACKAGE/ITERATE"). Since this PRD drives it from ITERATE, `from === "ITERATE"` is the live case; PACKAGE/RENDER are permitted by the same predicate at no extra cost.

2. **Refuse fan-out (and, for now, segmented).** Read the live storyboard on disk and refuse with `STATE_CONFLICT` if `storyboardHasShorts(sb)` (fan-out — finished work is in `deliverables/`, not the archive's `renders/`). Also refuse `storyboardHasSegments(sb)` for now ("segmented promote not yet supported") so a half-built segmented restore can't strand the segment registry; this is the layered-in-follow-up boundary. Both helpers are already exported from `storyboard-schema.js`. This refusal precedes any fs mutation.

3. **Validate the version exists** via a *validation-only* pre-check (`assertPromotableVersion(state, version)`) before any mutation — integer/archive-entry/disk-existence + storyboard-present check, throwing `NOT_FOUND`/`INVALID_ARGUMENTS`. The actual restore (`promoteArchivedVersion`) runs after step (a). A `NOT_FOUND` thrown here leaves the live tree and history untouched — same "refused attempt leaves no trace" property the non-overridable gate block already guarantees (`session-state.js:621-624`).

4. **(a) Archive the current live cut.** Call the *existing* `archiveForIteration(state, { from, to: toPhase })` (`session-state.js:676`) exactly as the normal back-edge does. This moves the current `renders/`+`package/` into `archive/v<currentVersion>/`, copies the current brief/storyboard/compose there, and returns the `{record, apply}` pair. Promotion is now symmetric: the cut the user is leaving is preserved as its own version, identical to any other iteration. (If `archiveForIteration` returns `null` — nothing to archive — that is fine; promotion still proceeds. The live brief/storyboard/compose are about to be overwritten by the restore, and they were already archived on whatever back-edge created the current state, so no authored work is lost.)

5. **(b) Restore the chosen version** via `promoteArchivedVersion(state, { version })` — wipes live `compose/`, copies `archive/v<K>/{brief,storyboard,compose}` in. The live tree now *is* v<K>'s authored plan.

6. **(c) Proceed through standard COMPOSE entry.** The existing block at `session-state.js:650-666` runs unchanged: `materializeSceneClips` re-cuts every scene clip of the *restored* storyboard into `transcoded/clips/` and rebuilds `compose/source/`; `deriveRenderPlan` recomputes from the restored storyboard. Because the restored storyboard is single-timeline (fan-out/segmented refused in step 2), `renderPlan.mode !== "segmented"`, so the existing `else` branch (`session-state.js:696-703`) drops any stale `render_plan`/`segment_renders`/`assembly` — correct, the promoted plan is a fresh single-timeline render.

7. **State commit.** The normal commit (`session-state.js:679-744`) applies `archive.apply(next)` (bumping `iteration.current_version`, clearing `preview`/`render`/`package`, appending the archived version to `iteration.archive[]`), stamps `transcoded_clips`, and writes history. We add **one** event: `iteration_promoted` (see 4.5). The existing `iteration_archived` event (from step (a)'s archive, `session-state.js:705-712`) and `scene_clips_materialized` event (from the restore's re-cut) are emitted by the existing code paths, so the history reads, in order: archive-current → clips-materialized → **iteration_promoted** → transition. The user lands at COMPOSE on the promoted plan with empty render/preview/package slots — exactly the state a normal new iteration starts in.

**Ordering constraint — the riskiest edit (spelled out).** In the *current* code, the COMPOSE-entry `materializeSceneClips` block sits at `:650-666` and runs **unconditionally for any COMPOSE entry**, reading `storyboardPath(id)` from disk at `:661`; the archival block follows at `:674-677`. So materialize **precedes** archival today. The restore in step (b) overwrites `storyboard.json`, and `materializeSceneClips` at `:651` reads that storyboard from disk — therefore **both step (a) archive-current AND step (b) restore must be hoisted to run before `:651`** when promoting. Concretely, when `promote_from_version != null`:

- Hoist `archiveForIteration` (step a) and `promoteArchivedVersion` (step b) to execute **before** the `if (toPhase === "COMPOSE")` materialize/`deriveRenderPlan` block at `:650-666`, so `:651`'s `materializeSceneClips` and `:661`'s `readJsonFile(storyboardPath(id))` see the *restored* v<K> storyboard.
- Make the normal-path archival block at `:674-677` **conditional on not having promoted**, i.e. change `if (isArchivalTransition(from, toPhase))` to `if (!promoting && isArchivalTransition(from, toPhase)) archive = archiveForIteration(state, { from, to: toPhase });` — otherwise a promote would archive the current cut **twice** (once in the hoisted step (a), once at `:676`). When promoting, the `archive` binding is set by the hoisted step (a) and reused unchanged by the commit at `:684-685`/`:705-712`.

This is the single highest-risk edit; it must be reviewed as its own commit, and it must be rebased onto PRD 6's settled `transitionPhase` (PRD 6's history-build at `:705-712` and its `archiveForIteration` call at `:676` must stay callable).

The net effect: a promote is *a normal back-edge iteration whose authored content happens to be a restored prior version instead of a hand-edit.* Everything downstream (PREVIEW, RENDER, PACKAGE) is byte-for-byte the existing flow.

### 4.5 State / history shapes

No new persistent state slot. The promotion is fully captured by the existing `iteration` machinery plus one history event:

```jsonc
// appended to state.history, between the archive/clips events and the transition event
{
  "kind": "iteration_promoted",
  "at": "2026-06-14T12:00:00.000Z",
  "promoted_from_version": 2,          // the v<K> the user chose
  "archived_as_version": 3,            // the version the CURRENT cut was archived as (from step a), or null if nothing to archive
  "new_current_version": 4,            // iteration.current_version after the bump
  "restored": { "brief": true, "storyboard": true, "compose": true }
}
```

The tool return gains a `promoted` field (null on a normal transition):

```jsonc
// vob_transition_phase return, additive
{
  "project_id": "...", "from": "ITERATE", "to": "COMPOSE",
  "override_reason": null,
  "archived": { /* existing archive.record from step (a) */ },
  "clips": { /* existing clipsDigest */ },
  "promoted": { "from_version": 2, "restored": { "brief": true, "storyboard": true, "compose": true } },
  "phase_summary": { /* existing buildStateSummary */ }
}
```

This `promoted` field is additive to whatever return shape PRD 6 leaves; it does not touch PRD 6's added return keys.

No manifest change (promotion is a pre-RENDER action; the eventual `package_output` manifest is regenerated from the promoted-then-rendered cut on its own and carries no special lineage in this PRD).

## 5. Seam-level change list

| File | Anchor | Change |
|---|---|---|
| `mcp/lib/tools/transition-phase.js` | `:11-18` (inputSchema.properties) | **NEW optional arg** `promote_from_version` (integer, minimum 1) declared explicitly (additionalProperties:false), **appended to PRD 6's already-extended `properties` object**. Update tool `description` `:8` (amending PRD 6's edit) to mention it. No metadata-block change (still `mutating:true`, `session_artifacts_written:["state.json"]`). No registration changes — same tool name. |
| `mcp/lib/archival.js` | imports `:6-18` | **Import** `ToolError`, `ERROR_CODES` from `./envelope.js` (NOT currently imported — confirmed). `briefPath`, `storyboardPath`, `composeDir`, `composeSourceDir`, `archiveVersionDir` already imported (`:8-16`); add nothing new from `paths.js`. |
| `mcp/lib/archival.js` | new fns near `:172` | **NEW** `assertPromotableVersion(state, version)` — integer/archive-entry/disk-existence + storyboard-present validation, throws `NOT_FOUND`/`INVALID_ARGUMENTS`. **NEW** `promoteArchivedVersion(state, { version })` — `fs.rmSync(composeDir(projectId),…)` then `copyIfExists` brief/storyboard/compose from `archiveVersionDir(projectId, version)`; returns `{ restored, version }`. Export both in `module.exports` `:174-180`. |
| `mcp/lib/session-state.js` | archival require | Add `promoteArchivedVersion`, `assertPromotableVersion` to the `require("./archival.js")` destructure. Add `storyboardHasShorts`, `storyboardHasSegments` to the `require("./storyboard-schema.js")` import. |
| `mcp/lib/session-state.js` | `transitionPhase` `:590-592` | Parse `promote_from_version` from args (integer-or-null); set `const promoting = promote_from_version != null;`. |
| `mcp/lib/session-state.js` | after gate `:641`, before the materialize block `:650` | **NEW promote pre-checks (no fs mutation):** when `promoting`: (1) guard `toPhase==="COMPOSE" && isArchivalTransition(from,toPhase)` else `INVALID_ARGUMENTS`; (2) read live storyboard, refuse `STATE_CONFLICT` on `storyboardHasShorts`/`storyboardHasSegments`; (3) `assertPromotableVersion(state, promote_from_version)`. |
| `mcp/lib/session-state.js` | hoisted before `:650` materialize block | **NEW (re-sequence, riskiest):** when `promoting`, run step (a) `archive = archiveForIteration(state,{from,to:toPhase})` then step (b) `promoteArchivedVersion(state,{version:promote_from_version})` — **before** `:651`'s `materializeSceneClips` / `:661`'s `readJsonFile(storyboardPath(id))`, so they see the restored v<K> storyboard. |
| `mcp/lib/session-state.js` | `:674-677` | Make the normal-path archival **conditional**: `if (!promoting && isArchivalTransition(from, toPhase)) archive = archiveForIteration(...)` — skip when the promote branch already archived, to avoid double-archiving. `archive` is reused by the commit/history unchanged. |
| `mcp/lib/session-state.js` | history build `:705-743` | Add an `iteration_promoted` event (4.5 shape) when promoting, ordered before the `transition` event; rebased onto PRD 6's history-build shape. |
| `mcp/lib/session-state.js` | return `:747-755` | Add `promoted: promoting ? { from_version: promote_from_version, restored } : null`. |
| `scripts/m5-walker.js` | end of `package`/`all` block `:2497`, OR new `iterate` phase | **NEW walker assertions** (section 8): drive a promote and assert non-destructiveness + COMPOSE landing + slot reset. |

**New files:** none. **New persistent state keys:** none (history event only). **New manifest keys:** none. **paths.js additions:** none — `archiveVersionDir`, `briefPath`, `storyboardPath`, `composeDir` (`:230`), `composeSourceDir` (`:234`) all already exist.

## 6. Invariants preserved

- **FSM never skips forward; edits to both `ALLOWED_TRANSITIONS` and `GATES` only on an edge add/remove.** This adds *neither* an edge nor a gate. `{ITERATE,PACKAGE}->COMPOSE` already exist in `ALLOWED_TRANSITIONS` (`session-state.js:30-31`) with gates `iterateToCompose` (`phase-gates.js:628`) / `packageToCompose` (`phase-gates.js:619`). `promote_from_version` is handled *inside* `transitionPhase` after the existing gate passes — the gate, edge set, and transition validation are untouched.

- **No render-slot write; no phase jump; `render_stale_composition` never trips.** Promotion writes only brief/storyboard/compose and lands at COMPOSE with `render`/`preview`/`package` slots **deleted** by the existing `archive.apply` (`archival.js:165-168`). The user re-renders the promoted plan from COMPOSE, so the eventual `render.composition_revision_rendered` matches the fresh composition revision — `render_stale_composition` (`phase-gates.js:477-485`) is satisfied the normal way.

- **Back-edges auto-archive; a prior cut is never destroyed; no double-archive.** Step (a) runs the *existing* `archiveForIteration` before any overwrite, so the cut the user is leaving becomes its own `archive/v<N>/` exactly as a normal iteration; the normal-path `:674-677` call is made conditional (`if (!promoting)`) so the current cut is archived exactly **once**. The version being *promoted* is read-only-restored — its archive entry stays in place. Nothing in `renders/`/`package/`/`archive/` is deleted; the live `compose/` wipe in `promoteArchivedVersion` only clears the *just-archived* live composition (already copied to `archive/v<N>/compose/` in step a).

- **`compose/source/` is excluded from archives and rebuilt on COMPOSE entry.** The restore copies `archive/v<K>/compose/` which (by `archival.js:131-136`) never contained `source/`. The live `compose/` is wiped before restore (clearing any stale `source/` symlink tree, which `cpSync` would not delete) and `source/` is rebuilt by the unchanged COMPOSE-entry `materializeSceneClips` (`session-state.js:650-655`) from the restored storyboard — no dangling symlinks, no absolute paths.

- **State writes go through `writeFileAtomic` under `withSessionLock`.** All promote logic runs inside the existing `withSessionLock(id, async () => …)` (`session-state.js:604`) and commits via the single existing `writeFileAtomic` (`session-state.js:744`). `archiveForIteration`'s own snapshot write is already atomic (`archival.js:144`).

- **`state.json`/`manifest.json`/`brief.md` written only by `vob_*` tools.** The restore writes `brief.md`/`storyboard.json`/`compose/` via `copyIfExists` *inside* the `vob_transition_phase` handler — a sanctioned `vob_*` tool, under the lock. (The adapter write-guards permit tool-mediated writes; they only block *direct* user writes.)

- **`deliverables/` is session-level and the package wipe never reaches it; fan-out output lives there, not in the archive.** Precisely *why* this PRD refuses fan-out: a fan-out project's finished cuts are in `deliverables/` (`paths.js:347-349`), never in `archive/v<N>/renders`. Promoting from the archive would target the wrong store, so `storyboardHasShorts` → `STATE_CONFLICT` refusal before any mutation.

- **Gates re-check disk.** `assertPromotableVersion` checks `fs.existsSync(archiveVersionDir(...))` and the storyboard's presence on disk — not just the `iteration.archive[]` summary — so a recorded-but-vanished archive refuses with `NOT_FOUND`.

- **Two-tier override unaffected.** No new blocker is introduced; the promote refusals are `ToolError` throws *before* the gate-verdict path, not gate blockers, so the overridable/non-overridable machinery (`session-state.js:625-640`) is untouched.

## 7. Data dependencies & availability

- **`iteration.archive[]`** — produced by `archiveForIteration` on every archival back-edge (`archival.js:146-169`); read via `currentArchive` (`archival.js:43-48`). Confirmed present. Each entry carries `version` + relative `paths.{renders,package,brief,storyboard,compose,snapshot}`. The promote helper resolves the version dir from `archiveVersionDir` rather than trusting the stored relative paths (disk-truth convention), but the archive *entry* is the existence gate.
- **`archive/v<K>/{brief.md,storyboard.json,compose/}`** — copied (not moved) into the archive at iteration time (`archival.js:132-136`), so they persist after the version is archived and are available to restore. `compose/source/` is deliberately absent. Confirmed.
- **Restored storyboard → `materializeSceneClips`** — COMPOSE entry reads `storyboardPath(id)` (`session-state.js:659-665`) which the restore has just overwritten with v<K>'s storyboard. Confirmed: the materialize is content-hash cached (`clip-materialize.js` sidecars), so re-cutting v<K>'s already-seen clips is cheap.
- **`vob_compare_iterations` (PRD 4)** — *hard dependency for usable UX.* The orchestrator needs to *see* archived cuts (snapshots/finals) to let the user choose a version to promote. `promote_from_version` is the *action*; compare is the *selection UX*. This PRD's engine change does not import compare, but the feature is not usable end-to-end without it — compare must ship first (see §9).
- **PRD 6 (revision-capture / feedback) — soft sequencing dependency** for the settled `transitionPhase` history-build. This PRD re-sequences the materialize/archive ordering and must rebase onto PRD 6's final history-event shape + its `archiveForIteration` call (see §9).
- **`storyboardHasShorts`/`storyboardHasSegments`** — exported from `storyboard-schema.js` (confirmed in module.exports). Used for the fan-out/segmented refusal.

Nothing is blocked. All upstream data is on disk by construction of the archival path.

## 8. Verification

**Walker (`scripts/m5-walker.js`).** Extend the `package`/`all` flow (after the existing `PACKAGE→ITERATE` + `finalize` at `:2491-2496`), or add a small dedicated `iterate` phase routed in `main()`. The walker already runs `all` through a full COMPOSE→…→PACKAGE→ITERATE single-timeline cut, so at ITERATE there is one archived version (`v1`) on disk plus the live cut. Add:

1. **Promote-back-edge happy path.** From ITERATE, call `vob_transition_phase { to_phase:"COMPOSE", promote_from_version: 1 }`. Assert: return `.to === "COMPOSE"`; `.archived` is non-null (the current live cut was archived as its own version — non-destructive); `.promoted.from_version === 1` and `.promoted.restored.storyboard === true`.
2. **Slots reset / landed at COMPOSE.** `vob_read_state_summary`: assert `phase === "COMPOSE"`, `preview === null`, `render === null`, `package === null`, and `iteration_version` bumped by 1 vs pre-promote, `archived_version_count` bumped by 1.
3. **`source/` rebuilt, not restored; archived only once.** Assert `fs.existsSync(composeSourceDir)` is true after the promote (COMPOSE-entry rebuilt it) and that `compose/index.html` (the authored file) exists — proving the restore landed and the materialize ran. Assert exactly one new `archive/v<N>/` directory appeared (not two) — proving the conditional `!promoting` archive avoided double-archiving.
4. **Re-render on rails.** Drive COMPOSE→PREVIEW→RENDER→PACKAGE on the promoted cut (reuse the existing save-composition/preview/render fixtures) and assert it reaches PACKAGE with **no** `override_reason` — proving `render_stale_composition` does not bite a promoted-then-re-rendered cut.
5. **Non-destructive archive of the prior live cut.** Assert the version the live cut was archived as exists on disk (`archive/v<N>/` with a `snapshot.json`) — nothing lost.
6. **Negative: missing version.** `expectError("vob_transition_phase", { to_phase:"COMPOSE", promote_from_version: 99 }, /NOT_FOUND/)` from ITERATE; assert the live tree is untouched (phase still ITERATE, no new history `iteration_promoted` event).
7. **Negative: fan-out refusal.** In the `fanout` phase, at its ITERATE state (`:920-923`), `expectError(..., { to_phase:"COMPOSE", promote_from_version: 1 }, /STATE_CONFLICT/)` and assert the message names fan-out/deliverables. Confirms the refusal precedes mutation.
8. **Negative: arg on a non-promote edge.** `expectError("vob_transition_phase", { to_phase:"PLAN", promote_from_version: 1 }, /INVALID_ARGUMENTS/)` — the arg is only valid on `->COMPOSE` archival back-edges.

**Manual check.** Run `node scripts/m5-walker.js all` then inspect `~/video-vob-sessions/<id>/`: confirm `archive/v1/` (original), `archive/v2/` (the live cut archived at promote time — exactly one new dir), live `compose/index.html` matches `archive/v1/compose/index.html`, and `compose/source/` contains freshly-rebuilt symlinks.

## 9. Parallel-safety & sequencing

**Not parallel-safe.** This PRD edits the engine heart: `transitionPhase` (`session-state.js`), `archival.js`, and the COMPOSE-entry side-effect ordering. Hot shared files that collide with sibling phase 1-7 refactors:

- **`mcp/lib/session-state.js` `transitionPhase`** — the single most contended function. Any sibling touching the COMPOSE-entry block, archival call, history build, or the return shape collides directly. This PRD *re-sequences* the archive/materialize ordering (materialize at `:650-666` currently **precedes** archival at `:674-677`; promote must archive-then-restore *before* `:651`'s materialize, and make the `:674` archival conditional `if (!promoting)` to avoid double-archive). That re-sequencing is the highest-risk edit and must not race another `transitionPhase` change. **PRD 6 edits the same function** (history-build at `:705-712`, `archiveForIteration` at `:676`); this PRD rebases onto PRD 6's final shape.
- **`mcp/lib/archival.js`** — adds the `ToolError`/`ERROR_CODES` import (required — not currently imported) + two exported helpers; low collision unless a sibling reworks `archiveForIteration`/`copyIfExists`.
- **`mcp/lib/tools/transition-phase.js`** — only the `inputSchema.properties` + `:8` description; **collides with PRD 6**, which adds five args to the same `properties` block and edits the same description. Merge into ONE `properties` object and ONE amended description (this PRD appends to PRD 6's).
- **`scripts/m5-walker.js`** — append-only additions to the package/iterate flow; low collision.

**Must land first (hard dependency):** **PRD 4 — `vob_compare_iterations`.** The orchestrator cannot drive a *useful* promote without first showing the user the archived cuts to choose from. The engine change here is independent of compare's code, but the feature is incomplete without it — so compare merges first.

**Sequence within the ITERATE batch (PRD 7 lands LAST):**
1. **PRD 4 — `vob_compare_iterations`** (read-only archive read-back — no engine-heart edits) — first; it READS `archived_versions[]`/`archived_version_count` but does not edit `transitionPhase`.
2. **PRD 6 — revision-capture / feedback** (structured revision notes + labels) — second. It touches the same `transitionPhase` history-build region (`:705-712`) and `inputSchema.properties` (`:11-18`), and is the producer of the `archived_versions[]` summary shape this PRD's UX consumes. Landing it before this PRD means this PRD rebases onto the final history-event shape and the merged `properties` object rather than the reverse.
3. **This PRD (PRD 7)** — **last** in the batch, after the two above, so the risky `transitionPhase` re-sequencing happens against a settled history-build, a merged `inputSchema.properties`, and a shipped compare tool.

**Recommended branch/commit boundaries:** one branch off the ITERATE-batch integration branch, rebased onto PRD 6. Commit 1: `archival.js` import + helpers + `transition-phase.js` schema arg (additive, no behavior change). Commit 2: the `transitionPhase` re-sequencing (hoist archive+restore before `:651`, make `:674` conditional) + promote branch + history/return (the behavioral change, reviewed as a unit). Commit 3: walker assertions. Run `node scripts/m5-walker.js all` and `node scripts/m5-walker.js fanout` green before merge — both exercise the new positive and negative paths.
