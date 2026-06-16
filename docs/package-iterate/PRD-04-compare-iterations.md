# PRD: `vob_compare_iterations` — read-only cross-version diff over archived snapshots

## 1. Summary

Ship a new read-only orchestrator tool, `vob_compare_iterations {project_id, from_version?, to_version?}`, that resolves two archived iterations from the authoritative `iteration.archive[]` ledger, reads each version's `archive/v<N>/snapshot.json` plus its copied `archive/v<N>/storyboard.json`, and emits a lean structured diff: render duration delta, file-size delta, composition/storyboard revision deltas, and a scene-count + scene-id set delta (added / removed / reordered). It defaults to comparing `(highest-archived − 1)` vs `(highest-archived)`. It is the cheapest real ITERATE unlock — today the orchestrator archives prior cuts (`mcp/lib/archival.js:99`) but has **no tool to read them back**, so "what changed between v1 and v2?" is unanswerable without the human shelling into `~/video-vob-sessions/`. Because it writes nothing and crosses no FSM edge, it is invariant-safe by construction and parallel-safe with the rest of the Wave A batch. It is also the UX prerequisite for the sibling promote PRD (a human can't choose which version to promote without first seeing the diff).

## 2. Problem & motivation

Back-edges out of `RENDER`/`PACKAGE`/`ITERATE` into `COMPOSE`/`PLAN` archive the prior cut: `archiveForIteration` (`mcp/lib/archival.js:99`) **moves** `renders/` + `package/` into `archive/v<N>/`, **copies** `brief.md` + `storyboard.json` + `compose/` (minus `compose/source/` symlinks, `archival.js:134-136`), writes `archive/v<N>/snapshot.json` (`archival.js:143-144`), and appends a ledger record to `state.iteration.archive[]` carrying `{version, archived_at, paths{renders,package,brief,storyboard,compose,snapshot}}` (`archival.js:146-157`). `iteration.current_version` is bumped and `preview`/`render`/`package` slots are deleted (`archival.js:160-168`).

The snapshot embeds exactly what a diff needs at the slot level — `version`, `from_phase`/`to_phase`, `target`, `preview`, `render`, `package`, `composition_revision_at_archive`, `storyboard_revision_at_archive`, `tail_history` (`archival.js:73-90`) — **but the snapshot does NOT embed scene content** (scene ids, scene count, scene text). That content lives only in the copied `archive/v<N>/storyboard.json` on disk.

There is no read path. `vob_read_state_summary` surfaces only `archived_version_count` (`session-state.js:517`), not the archive contents. `vob_read_state` echoes raw `state.iteration` (which contains the ledger) but nothing parses snapshots, opens the archived storyboards, or computes deltas. The only archive-aware tool, `vob_archive_for_iteration` (`mcp/lib/tools/archive-for-iteration.js:57`), **writes** archives — it never reads them. So the orchestrator literally cannot answer "what changed between cuts" without instructing the human to `cat` two JSON files and eyeball them — exactly the kind of state inspection the FSM is supposed to own.

## 3. Goals / Non-goals

**Goals**
- A read-only tool that resolves two archived versions and returns a lean diff: render duration delta, file-size delta, composition-revision delta, storyboard-revision delta, scene-count delta, and scene-id set delta (`added` / `removed` / `reordered`).
- Resolve versions **strictly from `iteration.archive[]`** (the authoritative ledger), tolerating non-dense version numbers (v1 then v3 is legal — a back-edge with nothing to archive bumps nothing; `archiveForIteration` returns `null` at `archival.js:106-108`).
- Default to `(highest-archived − 1)` vs `(highest-archived)` when args omitted.
- `NOT_FOUND` on a `from_version`/`to_version` absent from the ledger.
- Distinguish genuinely-unknown values (`null` expected duration / drift, e.g. fan-out snapshots that lack `total_target_duration_seconds`) from a real `0` delta.
- Ship independently of the revision-capture PRD: no hard dependency on `feedback[]`.

**Non-goals (and why)**
- **No `feedback[]` join in v1.** The structured revision-capture artifact (`state.iteration.feedback[]` or equivalent) ships in a *separate* Wave-A PRD. This tool gates any feedback surfacing behind a presence check (`if Array.isArray(state.iteration.feedback)`) so it ships before that PRD lands and lights up automatically afterward — no schema coupling now.
- **No live-vs-archived as the *canonical* comparison.** The canonical compare is archived-vs-archived (both sides fully materialized on disk). The live working copy is comparable only as an explicit target and only when it actually has a render (see §4) — a back-edge *deletes* `render`/`package` slots (`archival.js:166-168`), so a freshly back-edged project has no live render and we must say so rather than emit null deltas that read as zero.
- **No A/B variant model.** ITERATE stays thin and sequential-overwrite; this tool reads the linear archive ledger, not a branch tree. (Product decision, fixed.)
- **No diff of brief.md / composition HTML bodies.** v1 diffs structured slots + scene-id sets only. Prose/markup diffing is out of scope (no value at the orchestrator's decision altitude; the human can open `archive/v<N>/` directly).
- **No new FSM edge, no gate, no state write.** Read-only by mandate.

## 4. Design

### Data flow

```
vob_compare_iterations {project_id, from_version?, to_version?}
  └─ readSessionStateStrict(project_id)           (session-state.js:105)
  └─ ledger = state.iteration.archive[]            (authoritative version list)
  └─ resolve {fromVersion, toVersion}              (default: highest−1 vs highest)
  └─ validate both against ledger                  → NOT_FOUND on a missing version
  └─ for each side: load(version)
       ├─ snapshot = read archive/v<N>/snapshot.json     (archiveSnapshotPath)
       └─ storyboard = read archive/v<N>/storyboard.json  (archived copy — scene content)
  └─ build lean diff  →  return (no state write)
```

The two sides are **both archived** by default. The `to` side becomes the **live working copy** only when the caller explicitly passes a sentinel target *and* `state.render.mp4_path` exists on disk (`fs.existsSync`). For v1 the input surface is the two integer version args; the live-side path is reached by a reserved `to_version: "live"` string (declared in the schema — see §5). When `to_version: "live"` is requested but `state.render` is absent or its `mp4_path` does not exist on disk, the tool returns a populated envelope whose `to` side carries `{ version: "live", available: false, reason: "live side has no render yet" }` rather than fabricating zero deltas.

### Version resolution (non-dense ledger)

```js
const archive = (state.iteration && Array.isArray(state.iteration.archive))
  ? state.iteration.archive : [];
// archive is append-only and version-ascending; do NOT assume dense.
const versions = archive.map(r => r.version).filter(Number.isInteger).sort((a,b)=>a-b);
```
- `< 2` archived versions and no `live` target ⇒ `NOT_FOUND` (`"fewer than two archived iterations to compare"`), listing the available `versions` in `error.details`.
- Defaults: `toVersion = versions[versions.length-1]`, `fromVersion = versions[versions.length-2]`.
- Explicit `from_version`/`to_version` integers are validated by **membership in `versions`**, not by range — `NOT_FOUND` with `details: { requested, available: versions }` on a miss (honours non-dense: v2 is a valid miss between v1 and v3).

### Per-side load helper

The snapshot is read via the existing path builder `archiveSnapshotPath(projectId, version)` (`paths.js:362`); the archived storyboard via `path.join(archiveVersionDir(projectId, version), "storyboard.json")` (`archiveVersionDir`, `paths.js:355`). Both reads use `readJsonFile` and tolerate absence/corruption (a legacy archive may predate the storyboard copy): a missing/unreadable snapshot for a *ledger-listed* version is a `NOT_FOUND` (the ledger lied — surfaceable); a missing archived storyboard degrades that side's scene fields to `null` (treated as unknown, never zero).

**Optional one-line helper in `archival.js`:** add an append-only export `readSnapshot(projectId, version)` that wraps `archiveSnapshotPath` + `readJsonFile` and returns `null` on absence. This is *optional* — the handler may read the path directly with zero `archival.js` edits. Recommended: read directly, to keep this PRD's footprint to one new file + registration (no edit to the hot archival module that phases 1–7 may touch).

### The diff algorithm

```
duration_delta:
  from = snapshot.render?.render_duration_seconds   (numeric or null)
  to   = snapshot.render?.render_duration_seconds
  delta = (from!=null && to!=null) ? round3(to-from) : null      // null = "unknown", not 0

file_size_delta:
  from/to = snapshot.render?.file_size_bytes         (int or null)
  delta = (both present) ? to-from : null

composition_revision_delta:
  from/to = snapshot.composition_revision_at_archive  (archival.js:83-85; int or null)
  delta = (both present) ? to-from : null

storyboard_revision_delta:
  from/to = snapshot.storyboard_revision_at_archive   (archival.js:86-88; int or null)
  delta = (both present) ? to-from : null

scene diff (from the archived storyboard.json copies, NOT the snapshot):
  fromScenes = orderedSceneIds(fromStoryboard)        // mode-agnostic accessor (see below)
  toScenes   = orderedSceneIds(toStoryboard)
  added      = toScenes \ fromScenes
  removed    = fromScenes \ toScenes
  common     = intersection, compared by ORDER → reordered = ids whose relative order changed
  scene_count_delta = toScenes.length - fromScenes.length  (null if either storyboard unreadable)
```

`orderedSceneIds` must be mode-agnostic across single-timeline, fan-out (`shorts[]`), and segmented (`segments[]`) storyboards. The repo already owns `allStoryboardScenes()` / `storyboardTimelines()` in `storyboard-schema.js` (per CLAUDE.md, the canonical accessors every consumer uses). The handler imports and reuses these against the **archived** storyboard document rather than re-deriving scene enumeration. `reordered` is computed over the common set by index-of comparison (stable: an id is "reordered" iff its rank among the common ids differs between sides).

`null` semantics are load-bearing: fan-out snapshots lack `total_target_duration_seconds` and a back-edge may archive before a full render exists, so `render` can be absent in a snapshot. The diff NEVER coerces a missing numerator to `0`; it emits `null` and the orchestrator renders it as "unknown / not rendered at this version".

### Return shape (literal)

```jsonc
{
  "project_id": "demo",
  "from": {
    "version": 1,
    "archived_at": "2026-06-14T10:00:00.000Z",
    "from_phase": "PACKAGE", "to_phase": "COMPOSE",
    "render_duration_seconds": 8.04,
    "file_size_bytes": 2113456,
    "composition_revision": 1,
    "storyboard_revision": 1,
    "scene_count": 4,
    "storyboard_readable": true
  },
  "to": {
    "version": 3,                       // non-dense: v2 never existed
    "archived_at": "2026-06-14T11:30:00.000Z",
    "from_phase": "PACKAGE", "to_phase": "PLAN",
    "render_duration_seconds": 9.12,
    "file_size_bytes": 2456789,
    "composition_revision": 2,
    "storyboard_revision": 3,
    "scene_count": 5,
    "storyboard_readable": true
  },
  "diff": {
    "duration_delta_seconds": 1.08,     // null when either side lacks a render
    "file_size_delta_bytes": 343333,    // null when either side lacks a render
    "composition_revision_delta": 1,
    "storyboard_revision_delta": 2,
    "scene_count_delta": 1,             // null when either storyboard unreadable
    "scenes": {
      "added": ["s5"],
      "removed": [],
      "reordered": ["s3", "s4"]
    }
  },
  "available_versions": [1, 3],
  "feedback": null                      // present-and-null until the revision-capture PRD lands
}
```

When `to_version: "live"` and the live render is absent:
```jsonc
{
  "project_id": "demo",
  "from": { "version": 3, ... },
  "to": { "version": "live", "available": false, "reason": "live side has no render yet" },
  "diff": null,
  "available_versions": [1, 3]
}
```

### `feedback` gating (forward-compat, no coupling)

```js
const fb = state.iteration && Array.isArray(state.iteration.feedback)
  ? state.iteration.feedback : null;
// v1: fb is always null. When the revision-capture PRD lands, this lights up
// without a schema edit here — pick the entries tagged for from/to versions.
out.feedback = fb ? selectFeedbackForVersions(fb, [fromVersion, toVersion]) : null;
```
`selectFeedbackForVersions` is a trivial filter that, in v1, is never reached. The key is the **presence check** so the tool ships before `feedback[]` exists.

## 5. Seam-level change list

| File | Anchor | Change |
|---|---|---|
| `mcp/lib/tools/compare-iterations.js` | **NEW** | New frozen tool module, templated on `read-state-summary.js`. Handler `compareIterations(args)`. Full metadata block below. |
| `mcp/lib/tools/index.js` | `:3-33` (`TOOL_MODULES`) | Add `require("./compare-iterations.js")` to the array (place after `read-state-summary.js` at `:7`, grouped with the read tools). |
| `adapters/claude-code/.claude/skills/vob/SKILL.md` | `:5-33` (`allowed-tools`) | Add `- mcp__vob__vob_compare_iterations` (near `vob_read_state_summary` at `:9`). |
| `adapters/claude-code/.claude/settings.json` | `:3-31` (`permissions.allow`) | Add `"mcp__vob__vob_compare_iterations"` (near `:7`). |
| `adapters/opencode/.opencode/agents/vob.md` | frontmatter `tools:` (`:4`) + ITERATE prose (`:260`) | The opencode primary agent's `tools:` map only lists the three subagent write tools as `false` (`:5-7`); MCP read tools are allow-by-default there, so **no frontmatter key is strictly required**. Add a one-line ITERATE-phase mention so the orchestrator knows the tool exists: reference `vob_vob_compare_iterations` near the ITERATE step (`:260`). |
| `scripts/port-adapter-docs.js` | — | **Run after** editing the claude-code SKILL/phase sources to regenerate the OpenCode mirror (per CLAUDE.md). |
| `archival.js` | `:174-180` (exports) | **Optional**: append-only export `readSnapshot(projectId, version)`. Recommended to SKIP — read the path directly in the handler to avoid touching this hot file. |
| `scripts/m5-walker.js` | new `compare` sub-runner in `main()` (`:2158`), wired like `fanout`/`general` (`:2164-2183`) | Add a dedicated runner that builds two archives, then asserts (see §8). |

**No new `paths.js` builders needed** — `archiveSnapshotPath` (`:362`) and `archiveVersionDir` (`:355`) already cover both reads (both confirmed correct). The archived-storyboard path is `path.join(archiveVersionDir(id, v), "storyboard.json")`, matching the literal name written at `archival.js:118`.

**No new state/schema/manifest keys.** The tool only reads existing `iteration.archive[]`, `archive/v<N>/snapshot.json`, and `archive/v<N>/storyboard.json`. No `manifest_version` bump (no manifest touched at all).

**`inputSchema` (note `additionalProperties` default):** the validator defaults `additionalProperties:false`, so every accepted arg MUST be declared (the `save_classification` lesson). The live-side sentinel is declared as a **string `enum`**, NOT a `const` sub-schema: `tool-validation.js` supports `oneOf` (`:83`) and `enum` (`:34`) but does **NOT** support `const` (zero hits — and a `const`-only sub-schema carries no type constraint, so it vacuously matches any value, including `to_version:"foo"`). Declare exactly:
```js
inputSchema: {
  type: "object",
  properties: {
    project_id:   { type: "string" },
    from_version: { type: "integer", minimum: 1 },
    to_version:   { oneOf: [
      { type: "integer", minimum: 1 },
      { type: "string", enum: ["live"] },   // NOT { const: "live" } — validator has no const support
    ] },
  },
  required: ["project_id"],
}
```
The handler still type-checks `to_version` defensively (positive integer or the literal `"live"`, else `INVALID_ARGUMENTS`) as a belt-and-braces guard behind the schema.

**Frozen metadata block** (templated on `read-state-summary.js:16-24`; every `REQUIRED_FIELDS` entry from `tool-registry.js:13-27` present; `mutating:false` + `session_artifacts_written:[]` are correct for a read-only tool):
```js
module.exports = Object.freeze({
  name: "vob_compare_iterations",
  description: "Read-only diff between two archived iterations (from iteration.archive[]): render duration + file-size deltas, composition/storyboard revision deltas, and the scene-id set delta (added/removed/reordered). Defaults to the two most recent archived versions. Versions are non-dense — validated against the ledger, NOT_FOUND on a miss. Treats missing render/scene data as unknown (null), never zero.",
  inputSchema: { /* as above */ },
  handler: compareIterations,
  role_bundles: ["orchestrator"],
  mutating: false,
  global_preapproval: true,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: [],
  hook_required: false,
});
```

## 6. Invariants preserved

- **`state.json`/`manifest.json`/`brief.md` written only by `vob_*` tools.** This tool's `mutating:false`, `session_artifacts_written:[]`. It never opens a write handle, never takes the session lock for writing (a plain `readSessionStateStrict` read, like `read-state-summary.js`). No invariant exposure.
- **FSM never skips forward; `ALLOWED_TRANSITIONS` + `GATES` edited only for an edge.** This tool adds NO edge and NO gate — it touches neither `session-state.js:22-32` nor `phase-gates.js`. Read-only tools touch no edge (per the constraint).
- **Back-edge archival is never disturbed.** The tool only *reads* `archive/v<N>/` and the `iteration.archive[]` ledger produced by `archiveForIteration` (`archival.js:99-172`). It never moves, deletes, or rewrites an archived directory, and never bumps `current_version`. A prior cut is never destroyed by this tool — it is the consumer the archival design always implied. (No `archival.js` edit — the reads-direct approach is sound.)
- **`package_output` refusals before the wipe.** Untouched — this tool does not call `package_output` and adds no work to it. (Cited because the constraint lists it; this PRD is orthogonal.)
- **`package/` wipe never reaches `deliverables/`.** Untouched — no package work here.
- **Two-tier override / `overridable` defaults.** No blocker added (read-only tool, no gate), so the two-tier override surface is unchanged.
- **Gates re-check disk (`fs.existsSync`).** Mirrored here for the *live-side* path: a `to_version:"live"` target is honoured only if `fs.existsSync(state.render.mp4_path)` is true — disk is the truth, the state summary alone is not trusted (a back-edge deletes the slot but a stale read elsewhere must not fake a render into existence). Snapshot/storyboard reads likewise `fs.existsSync`-guard before parsing.
- **`render.mp4_path` stored ABSOLUTE; `package.*` session-relative.** The handler reads `state.render.mp4_path` as an absolute path for the live `existsSync` check (no `sessionDir` join). Archived snapshot/storyboard paths are built via `paths.js` builders (absolute), never string-concatenated.
- **5 required intent keys unchanged.** Not referenced by this tool.

## 7. Data dependencies & availability

| Datum | Source | Status |
|---|---|---|
| Version ledger | `state.iteration.archive[]` `{version, archived_at, paths}` | **Present** — written at `archival.js:146-157`, applied at `:160-168`. |
| Render duration | `snapshot.render.render_duration_seconds` | **Present** — `render` slot copied wholesale into snapshot (`archival.js:85`); field set by `render-full`, surfaced at `session-state.js:479`. `null` when no render at that version (handled as unknown). |
| File size | `snapshot.render.file_size_bytes` | **Present** — same `render` slot (`session-state.js:480`). `null`-tolerant. |
| Composition revision | `snapshot.composition_revision_at_archive` | **Present** — `archival.js:83-85`. |
| Storyboard revision | `snapshot.storyboard_revision_at_archive` | **Present** — `archival.js:86-88`. |
| Scene ids / count | `archive/v<N>/storyboard.json` (copied, NOT in snapshot) | **Present** — copied at `archival.js:133` (`copyIfExists(storyboardPath, archivedStoryboardAbs)`). Read via `archiveVersionDir(id,v)/storyboard.json`. Mode-agnostic enumeration via `allStoryboardScenes()`/`storyboardTimelines()` in `storyboard-schema.js`. A legacy archive lacking the copy degrades scene fields to `null` (`storyboard_readable:false`). |
| Live render (optional target) | `state.render.mp4_path` (absolute) | **Conditionally present** — deleted by back-edges (`archival.js:166-168`); guarded by `fs.existsSync`. Absent ⇒ `to.available:false`. |
| Feedback | `state.iteration.feedback[]` | **BLOCKED / deferred** — ships in the sibling revision-capture PRD. Gated behind `Array.isArray` presence check; v1 always emits `feedback:null`. No coupling. |

Every canonical datum the diff needs is confirmed present in the current archival output. The only blocked datum (`feedback[]`) is explicitly deferred and presence-gated.

## 8. Verification

**Walker (`scripts/m5-walker.js`) — a dedicated `compare` sub-runner is REQUIRED, not an opportunistic hook.** The existing runners do **not** produce the two archives this test needs: `runLongform` performs exactly ONE archival back-edge (RENDER→COMPOSE at `m5-walker.js:1594`), and `runFanout`'s back-edge at `:813` is PREVIEW→COMPOSE — which is **not** in `ARCHIVE_FROM`, so it archives nothing. Neither yields the TWO archives the default compare requires. Therefore: add a new `compare` sub-runner in `main()` (`:2158`), wired exactly like `fanout`/`general` (`:2164-2183`), that builds two archives itself before asserting.

The runner must drive **two** archival back-edges explicitly (each from a phase in `ARCHIVE_FROM` — i.e. RENDER/PACKAGE/ITERATE — into COMPOSE/PLAN, the back-edges that auto-archive):

- **Archive v1:** walk the project to RENDER (real or stubbed render per the existing runner pattern), then back-edge RENDER→COMPOSE (archives v1, bumps `current_version`).
- **Mutate:** make a trivial storyboard change that adds one scene (and, to exercise `reordered`, move an existing scene), re-save the storyboard (bumps `storyboard_revision`).
- **Archive v2:** render again, then back-edge RENDER→COMPOSE a second time (archives v2).

Then assert (using the existing `call` / `expectError` / `assert` helpers, `:55-81`):

1. **Two-archive setup confirmed.** `vob_read_state_summary` → `assert(summary.archived_version_count >= 2)`.
2. **Default compare.** `const d = await call("vob_compare_iterations", {project_id})`. Assert `d.from.version` and `d.to.version` are the two most recent ledger versions; `assert(d.available_versions.length >= 2)`.
3. **Scene-set delta.** Given the added scene, `assert(d.diff.scenes.added.includes("<new_scene_id>"))` and `assert(d.diff.scenes.removed.length === 0)`. Given the moved scene, assert it appears in `d.diff.scenes.reordered`.
4. **Revision deltas.** `assert(d.diff.storyboard_revision_delta >= 1)` (the re-save bumped it).
5. **Null, not zero.** Using a side whose snapshot `render` is absent (a back-edge archives before a full render exists, or a fan-out snapshot lacking `total_target_duration_seconds`), assert `d.diff.duration_delta_seconds === null` (NOT `0`) and the corresponding `render_duration_seconds === null`.
6. **Non-dense + NOT_FOUND.** `await expectError("vob_compare_iterations", {project_id, from_version: <a-version-not-in-ledger>}, /NOT_FOUND/)`. Assert the error `details.available` lists the real versions.
7. **Too-few-archives.** On a project with `< 2` archives and no live target, `expectError(..., /NOT_FOUND/)`.
8. **Live target absent.** After a back-edge (which deletes `state.render`), `const d2 = await call("vob_compare_iterations", {project_id, to_version: "live"})`; `assert(d2.to.available === false && /no render yet/.test(d2.to.reason))` and `assert(d2.diff === null)`.

**Manual check:** on a real multi-iteration session under `~/video-vob-sessions/`, call the tool via `executeTool` and eyeball that `scenes.{added,removed,reordered}` matches a hand-diff of the two `archive/v<N>/storyboard.json` files; confirm `feedback:null`.

## 9. Parallel-safety & sequencing

**Read-only ⇒ cannot break any invariant; PARALLEL-SAFE with phases 1–7.** The handler reads `state.json` and `archive/v<N>/` and returns — no write, no lock-for-write, no edge, no gate. There is no ordering hazard against concurrent state mutations beyond the normal read-time tolerance already used by `read-state-summary.js`.

**Hot shared files (collision risk):**
- `mcp/lib/tools/index.js` (`TOOL_MODULES`, `:3-33`) — every new-tool PRD in this batch appends one line here. Collisions are trivial (append-only array, distinct lines) but **expect a merge touch**; land tool registrations in a predictable order to minimise rebases.
- `adapters/claude-code/.claude/skills/vob/SKILL.md` (`allowed-tools`) and `.claude/settings.json` (`permissions.allow`) — same append-only collision surface; the `verifyAdapterToolReferences` boot guard **exits 1** on drift, so all four registration points (index.js + SKILL + settings + opencode) MUST land in the **same commit** as the new module. Do not split registration across commits.
- `archival.js` — **avoid editing it.** The recommended design reads the snapshot path directly, leaving `archival.js` untouched so this PRD does not collide with any phase-1–7 work in the archival/iteration area. Only add the optional `readSnapshot` export if a sibling PRD already needs it.

**Dependencies on sibling PRDs in this batch:**
- **Revision-capture PRD (`feedback[]`):** *soft, forward-only.* This tool ships first and emits `feedback:null`; when the capture PRD lands `state.iteration.feedback[]`, the presence check lights up automatically — no edit to this tool required. **This PRD must NOT block on it.**
- **Promote PRD:** *this is its prerequisite.* The promote tool's UX assumes the human has already seen a diff. Land `compare` first (or in the same batch, before promote's UX copy references it).

**Recommended branch/commit boundaries:**
- One self-contained commit: `compare-iterations.js` + the four registration points + `port-adapter-docs.js` regen output + walker assertions (incl. the new `compare` sub-runner). This keeps the boot guard green at every commit boundary.
- Land in the Wave A batch, **before** the promote PRD, **independent of** the revision-capture PRD.
