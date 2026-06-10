# Spec: WP1 engine-contracts (D1, D2-state, D2-envelope) + WP2 plan-quality (D3, D4)

Branch `v2/fable-rework`. Baseline = current HEAD (93d0dd1). All line refs cite current files.
Implementer rule: build exactly what is written here; where this spec and the design brief
(`docs/v2/DESIGN-BRIEF.md`) disagree, the brief wins — file an issue, don't improvise.

Files owned by this spec (no other files may be edited except the two shared-file edits marked SHARED):

- WP1: `mcp/lib/storage.js`, `mcp/lib/envelope.js`, `mcp/lib/dispatch.js`, `mcp/lib/phase-gates.js`,
  `mcp/lib/session-state.js`, `mcp/lib/tools/transition-phase.js`, `mcp/lib/tools/read-state.js`,
  `mcp/lib/tools/read-state-summary.js`, `mcp/lib/tools/init-project.js`, `mcp/lib/tools/ingest-file.js`
  (return shape only), `mcp/lib/tools/archive-for-iteration.js` (comment only),
  SHARED `mcp/lib/tools/save-composition.js` (reset edit ONLY — QC + font injection are WP4, applied after),
  SHARED `mcp/lib/tools/render-preview.js` + `mcp/lib/tools/render-full.js` (revision stamp ONLY —
  verification deltas/timeouts/logs are WP4).
- WP2: `mcp/lib/platform-profiles.js` (NEW), `mcp/lib/intent-schema.js`,
  `mcp/lib/tools/record-intent-answer.js`, `mcp/lib/storyboard-schema.js`,
  `mcp/lib/tools/save-storyboard.js`, `mcp/lib/storyboard-markdown.js`, `mcp/lib/brief-validator.js`,
  `.vob-config/render-profiles.example.json` (doc artifact of platform-profiles).
  `mcp/lib/constants.js`: NOT needed — all new thresholds live in the module that applies them.

Build order within this spec: WP1 first (wave 1), WP2 second (wave 2). WP1 must not require
`platform-profiles.js` (see §1.5.4 — the summary reads STORED canonical shapes only, so there is no
cross-wave import).

---

## PART 1 — WP1 engine-contracts

### 1.1 `mcp/lib/storage.js` — async-aware `withSessionLock`

Replace the current implementation (storage.js:272-279) with:

```js
// Async-aware: if the callback returns a promise, the lock is held until the
// promise settles and released exactly once. Sync callbacks behave as before.
function withSessionLock(domain, callback) {
  const release = acquireSessionLock(domain);
  let result;
  try {
    result = callback();
  } catch (error) {
    release();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return Promise.resolve(result).finally(release);
  }
  release();
  return result;
}
```

Notes:
- `Promise.prototype.finally` re-throws rejections and preserves the resolved value — exactly the
  required "released in finally after await" semantics. `release()` is idempotent-safe (token check
  at storage.js:248-255), but with this shape it is called exactly once per acquisition.
- Existing async caller `render-full.js:84` (`await withSessionLock(id, async () => {...})`) becomes
  correct-by-construction (today its lock is released before the promise resolves; the body happens
  to be fully synchronous so no observed bug — this closes the latent hole).
- No signature change; all 20+ sync call sites are unaffected.
- Do NOT touch the dead helpers (`appendJsonlLine`, `writeMarkdownMirror`, etc.) — out of scope
  (brief: dead-code cleanup is last-priority and only where touched anyway; we are not touching them).

### 1.2 `mcp/lib/envelope.js` + `mcp/lib/dispatch.js` — purge vestigial classification

Reference counts (verified by grep, 2026-06-10): `SCOPE_BLOCKED` — 2 refs, both inside envelope.js
(:6 definition, :66/:90 producers). `AUTH_MISSING` — 3 refs, all inside envelope.js (:7, :69, :75,
:93 producers). `classifyDataError` — 1 consumer (dispatch.js:30). `classifyException` — 1 consumer
(dispatch.js:36). `parseHandlerResult` — 1 consumer (dispatch.js:29); no handler returns a string.
Zero references anywhere else in `mcp/`, `scripts/`, `adapters/` (the only other hits are
DESIGN-BRIEF.md itself). Final per-code usage after this change:
`INTERNAL_ERROR` 47, `INVALID_ARGUMENTS` 40, `NOT_FOUND` 30, `STATE_CONFLICT` 13, `UNKNOWN_TOOL` 1.

**envelope.js edits:**

1. `ERROR_CODES` final value:
```js
const ERROR_CODES = Object.freeze({
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  STATE_CONFLICT: "STATE_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});
```
2. DELETE `classifyDataError` entirely (lines 61-81) and its export.
3. Replace `classifyException` (lines 83-102) with the exact final form:
```js
// Handlers signal intentional failures by throwing ToolError with a code from
// ERROR_CODES. Anything else is an unexpected internal error — no message
// sniffing (the BOB2-inherited regexes misclassified real errors).
function classifyException(error) {
  if (error && Object.values(ERROR_CODES).includes(error.code)) {
    return error.code;
  }
  return ERROR_CODES.INTERNAL_ERROR;
}
```
4. Replace `parseHandlerResult` (lines 49-59) with:
```js
function normalizeHandlerResult(rawResult) {
  return rawResult == null ? {} : rawResult;
}
```
   Export `normalizeHandlerResult`; remove the `parseHandlerResult` export.
5. `okEnvelope` / `errorEnvelope` / `metaForTool` / `ToolError`: UNCHANGED (meta removal is NOT in
   the locked decisions — do not touch).

**dispatch.js edits:** remove `classifyDataError` import and the `dataErrorCode` block
(dispatch.js:30-33); rename `parseHandlerResult` import/use to `normalizeHandlerResult`. Final
handler-success path:
```js
const data = normalizeHandlerResult(await tool.handler(safeArgs));
return okEnvelope(name, data);
```
The catch path is unchanged (`errorEnvelope(name, classifyException(error), …, error.details)`).

Back-compat: no handler produces `{scope_decision}` / `{error: string}` data shapes (grep
verified), and every intentional throw in `mcp/lib/**` is a `ToolError` — so the only behavior
change is that non-ToolError exceptions now always classify as `INTERNAL_ERROR` instead of
occasionally guessing `NOT_FOUND`/`STATE_CONFLICT` off message text. That is the intended fix.

### 1.3 `mcp/lib/phase-gates.js` — overridable flags, revision binding, corrupt-inspect blocker

#### 1.3.1 Blocker shape

`blocker(code, message, fields)` (phase-gates.js:22-24) is unchanged. The verdict shape becomes,
by convention: `{ allowed: boolean, blockers: [{ code, message, overridable?, ...fields }] }`.
A blocker WITHOUT an `overridable` field is overridable (legacy default — every existing blocker
object remains valid). Exactly three blockers gain `overridable: false`:

| Gate fn | Blocker code | Edit |
|---|---|---|
| `inspectToIntent` (:121-129) | `inspect_not_acknowledged` | add `overridable: false` to the fields object |
| `previewToRender` (:322-330) | `preview_not_confirmed` | add `overridable: false` |
| `renderToPackage` (:379-387) | `render_not_confirmed` | add `overridable: false` |

Example (the other two are identical in shape):
```js
blocker(
  "preview_not_confirmed",
  "preview has been rendered but not confirmed — call vob_confirm_preview after the user explicitly approves",
  { render_path: preview.render_path, overridable: false },
)
```
All other blockers stay overridable — in particular `ffmpeg_unavailable` (phase-gates.js:390-399),
preserving the sanctioned "installed ffmpeg since INGEST" override (SKILL.md:366).

#### 1.3.2 Revision binding (stale preview/render)

In `previewToRender`, AFTER the `preview.confirmed` check (i.e. only reachable when a confirmed
preview exists), append:

```js
const composition = state && typeof state.composition === "object" && !Array.isArray(state.composition)
  ? state.composition
  : null;
const compRev = composition && Number.isInteger(composition.revision_count)
  ? composition.revision_count
  : null;
const previewRev = Number.isInteger(preview.composition_revision_rendered)
  ? preview.composition_revision_rendered
  : null;
if (compRev !== null && previewRev !== null && previewRev !== compRev) {
  return block([
    blocker(
      "preview_stale_composition",
      `preview was rendered against composition revision ${previewRev} but the composition is now revision ${compRev} — re-run vob_render_preview and re-confirm`,
      { composition_revision: compRev, composition_revision_rendered: previewRev },
    ),
  ]);
}
```

In `renderToPackage`, after the `render.confirmed` check and BEFORE the ffmpeg check, the analogous
block with code `render_stale_composition`, message
`` `full render was produced against composition revision ${renderRev} but the composition is now revision ${compRev} — re-run vob_render_full and re-confirm` ``,
reading `render.composition_revision_rendered`.

Legacy-absent pass rule (exact): the blocker fires ONLY when BOTH numbers are integers and differ.
`composition_revision_rendered` absent/null (any pre-v2 session, or a render of a session whose
composition slot lacked `revision_count`) → gate passes. `state.composition` absent → gate passes
(upstream gates own that). These two blockers are overridable (default).

#### 1.3.3 `intentToPlan` — surface corrupt inspect.json

Replace lines 142-147:
```js
let inspectSummary = null;
if (state && state.inspect && typeof state.inspect.summary_path === "string" && state.inspect.summary_path) {
  if (fs.existsSync(state.inspect.summary_path)) {
    try {
      inspectSummary = readJsonFile(state.inspect.summary_path);
    } catch (error) {
      return block([
        blocker(
          "inspect_summary_unreadable",
          `inspect.json exists but could not be parsed (${error.message || String(error)}) — re-run vob_inspect_source; conditional intent keys (audio_treatment, captions_style) cannot be derived from a corrupt summary`,
          { summary_path: state.inspect.summary_path },
        ),
      ]);
    }
  }
}
```
Overridable (default) — the orchestrator may judge the source genuinely silent and override; that
choice is now explicit and audited instead of silent.

### 1.4 `mcp/lib/session-state.js` — transitionPhase, summary, projections, init

#### 1.4.1 `transitionPhase` — lock, enforcement, return

(a) **Lock.** Delete the hand-rolled `acquireSessionLock` + try/finally (lines 155-263 comment +
structure) and wrap the whole body:
```js
return withSessionLock(id, async () => {
  ... // body identical except as below
});
```
Drop the `acquireSessionLock` import if now unused in this file (it is — `withSessionLock` remains).

(b) **Non-overridable enforcement.** Replace the single guard at lines 178-184 with:
```js
const verdict = gate(state) || {};
const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : [];
if (verdict.allowed === false) {
  const nonOverridable = blockers.filter((b) => b && b.overridable === false);
  if (nonOverridable.length > 0) {
    const codes = nonOverridable.map((b) => b.code).join(", ");
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `gate blocked ${from} -> ${toPhase}: ${codes} cannot be bypassed with override_reason — ${nonOverridable.map((b) => b.message).join("; ")}`,
      { blockers, non_overridable: nonOverridable.map((b) => b.code), refused_override_reason: overrideReason },
    );
  }
  if (!overrideReason) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `gate blocked ${from} -> ${toPhase}: ${blockers.map((b) => b.message || b.code || String(b)).join("; ") || "no detail"}`,
      { blockers },
    );
  }
}
```
Semantics: a non-overridable blocker refuses the transition EVEN WITH a reason, and refuses it
even when other (overridable) blockers coexist. No state is written on refusal (throw precedes the
write), so nothing lands in history for a refused attempt; `refused_override_reason` rides in the
error details so the orchestrator can see its own reason was rejected. When an override IS accepted
(only overridable blockers), the existing history transition event (lines 241-248) is unchanged —
`gate_blockers` now records blockers verbatim including any `overridable:false` fields (there can
be none in the accepted case, by construction).

(c) **Return shape.** Replace lines 251-259 with:
```js
return {
  project_id: id,
  from,
  to: toPhase,
  override_reason: overrideReason,
  archived: archive ? archive.record : null,           // {version, archived_at, paths{...}} — unchanged record shape
  clips: transcodedClips ? clipsDigest(id, transcodedClips) : null,
  phase_summary: buildStateSummary(next, id),
};
```
NO `state` field. NO top-level `transcoded_clips`. The full materialization document still persists
into `next.transcoded_clips` (line 218-220, unchanged) — on-disk format identical.

`clipsDigest` (new module-local helper):
```js
function clipsDigest(projectId, transcodedClips) {
  const s = transcodedClips && transcodedClips.summary ? transcodedClips.summary : {};
  return {
    clip_count: (Number(s.cut) || 0) + (Number(s.cached) || 0),
    cached_count: Number(s.cached) || 0,
    scene_count: Number(s.total) || 0,
    skipped_scene_count: Number(s.skipped) || 0,
    audio_treatment: transcodedClips.audio_treatment || null,
    clips_dir: transcodedClipsDir(projectId),
  };
}
```
(`transcodedClipsDir` imported from `./paths.js` — counts source: clip-materialize.js summary
object `{summary:{total,cut,cached,skipped}, audio_treatment, …}`.)

Type contract of the return (every field):
`project_id: string` · `from: string(phase)` · `to: string(phase)` · `override_reason: string|null`
· `archived: null | {version:int, archived_at:isoString, paths:{renders,package,brief,storyboard,compose,snapshot: string|null}}`
· `clips: null | {clip_count:int, cached_count:int, scene_count:int, skipped_scene_count:int, audio_treatment:string|null, clips_dir:string}`
· `phase_summary: <summary shape, §1.4.2>`.

#### 1.4.2 `buildStateSummary(state, projectId)` — the enriched summary (NEW, replaces `readStateSummary` body)

New exported function; `readStateSummary(args)` becomes
`return buildStateSummary(readSessionStateStrict(args && args.project_id), assertSafeProjectId(args && args.project_id));`.

Exact return shape — every field, with the read-time default when the slot is absent (back-compat
with pre-v2 state.json is read-time only; nothing is written):

```
{
  project_id: string,
  phase: string,                              // post legacy-alias normalization
  target: object|null,                        // state.target verbatim (init arg)
  last_updated: string,
  iteration_version: int,                     // currentIterationVersion(state) — import from archival.js; default 1
  archived_version_count: int,                // (state.iteration.archive || []).length
  finalized_version: int|null,                // state.iteration.finalized_version ?? null
  style: { derived_from: string }|null,       // from state.style; null when absent
  external_import: boolean,                   // state.external_import === true
  deliverable_count: int,                     // (state.deliverables || []).length
  history_count: int,                         // (state.history || []).length
  dependency_failures: [ { name: "ffmpeg"|"hyperframes"|"asr", error: string|null } ],
                                              // one entry per state.dependencies.<name> with ok === false; [] otherwise
  manifest: null | { path: string, source_path: string, file_count: int, video_stream_count: int,
                     total_duration_seconds: number|null },
                                              // total_duration_seconds = state.manifest.total_duration_seconds ?? null
                                              // (stamped at ingest, §1.6; null on legacy sessions — WP5's PLAN file
                                              // falls back to Reading manifest.json when null)
  inspect: null | {
    summary_path: string, thumbs_dir: string, thumb_count: int, thumb_interval_seconds: number,
    sample_thumb_paths: string[], contact_sheet_paths: string[],
    audio_present: boolean, speech_detected: boolean,
    word_count: int, paragraph_count: int,
    transcript_path: string|null, transcript_summary_path: string|null, transcript_paragraphs_path: string|null,
    segments_path: string|null, segment_count: int,
    clean_speech_path: string|null,           // state.inspect.clean_speech_path ?? null (WP3 stamps it; null until then)
    digest_path: string|null,                 // state.inspect.digest_path ?? null (WP3 §8.1)
    strips_legend_path: string|null,          // state.inspect.strips_legend_path ?? null (WP3 §8.1)
    strip_count: int,                         // state.inspect.strip_count ?? 0
    transcripts: [{file_index:int, path:string|null, word_count:int, backend:string|null, from_cache:boolean}],
                                              // state.inspect.transcripts verbatim; [] on legacy (WP3 §8.1)
    hook_candidate_count: int,                // state.inspect.hook_candidate_count ?? 0
    classification: null | { aroll_count:int, broll_count:int, review_count:int,
                             take_group_count:int, best_take_count:int,
                             aroll_pool_path:string|null, broll_index_path:string|null, review_pool_path:string|null,
                             visual_coverage: object|null,      // WP3 §9.2 stamps it; null on legacy
                             hook_tagged_count: int|null },     // WP3 §9.2; null on legacy
    user_acknowledged: boolean,
    skipped_reason: string|null,
  },
  intent: null | {
    answers: object,                          // state.intent.answers with ONE projection: when
                                              // answers.target_platform is the v2 object shape,
                                              // emit {raw, canonical} (STRIP the profile snapshot);
                                              // all other values verbatim (string or {raw,seconds})
    missing_required_keys: string[],          // missingIntentKeys(answers, inspectSummaryFromDisk)
  },
  platform: null | { canonical:string, width:int, height:int, fps:int,
                     safe_top_px:int, safe_bottom_px:int,
                     ideal_duration_s:{min:int,max:int}|null, max_duration_s:int|null },
                                              // copied from the STORED answers.target_platform.profile
                                              // when object-shaped; null for legacy string answers.
                                              // NO import of platform-profiles.js here (wave isolation).
  target_duration_seconds: number|null,       // answers.target_duration.seconds when object-shaped; null otherwise
  brief: null | { path:string, saved_at:string, confirmed:boolean, confirmed_at:string|null },
  storyboard: null | { artifact_path:string, markdown_path:string, saved_at:string,
                       confirmed:boolean, confirmed_at:string|null, revision_count:int,
                       scene_count:int|null, total_duration_seconds:number|null,    // stamped by WP2 save; null on legacy
                       plan_lint: null | { error_count:int, warning_count:int } },  // counts only — no findings
  clips: null | { generated_at:string, audio_treatment:string|null, scene_count:int,
                  clip_count:int, cached_count:int, skipped_scene_count:int, clips_dir:string },
                                              // digest of state.transcoded_clips via clipsDigest-equivalent
  composition: null | { files:string[], saved_at:string, lint_status:string,
                        lint_report_path:string|null, lint_ran_at:string|null, revision_count:int },
  preview: null | { render_path:string, rendered_at:string, render_duration_seconds:number,
                    confirmed:boolean, confirmed_at:string|null, revision_count:int,
                    composition_revision_rendered:int|null },
  render: null | { mp4_path:string, rendered_at:string, render_duration_seconds:number,
                   file_size_bytes:int|null, stderr_log_path:string|null,
                   confirmed:boolean, confirmed_at:string|null, revision_count:int,
                   composition_revision_rendered:int|null },
  package: null | { directory_path:string, final_mp4_path:string, thumbnail_path:string,
                    manifest_path:string, readme_path:string, packaged_at:string, iteration_version:int },
}
```

Implementation notes:
- Every slot digest is defensive: non-object slot → `null`; missing inner field → the typed default
  above (`null`/`0`/`false`/`[]`). Never throw on a legacy document.
- `intent.missing_required_keys` requires the inspect summary from disk: lift
  `readInspectSummaryIfPresent(projectId)` (record-intent-answer.js:48-56) into session-state.js
  (export it; record-intent-answer.js re-imports from there to avoid duplication — WP2 applies that
  import swap in §2.3).
- `dependency_failures` reads `state.dependencies` (full blobs stay on disk); a missing
  `dependencies` slot → `[]`.
- Size budget: ~800–1,100 B compact for a typical mid-pipeline session BEFORE `intent.answers`
  (the WP3 inspect fields — digest/strips/transcripts/hook counts — add ~150–300 B);
  answers add their raw text (key_moments ≤1000 chars by SKILL convention). Worst case ~2.3 KB —
  still ~8× smaller than a full read. Accepted (see open issues).

**SKILL.md read-site coverage map** (every current `vob_read_state` / `vob_read_state_summary`
call; WP5 retargets per this table — listed here so WP5 can update in lockstep):

| SKILL.md site | What it reads today | v2 source |
|---|---|---|
| :94 resume | summary (4 fields) | `read_state_summary` — phase + every slot digest now resumes any phase |
| :149 INSPECT 5b | `state.inspect.classification` counts + pool paths | `summary.inspect.classification` |
| :164 INTENT `--like` | CROSS-PROJECT `intent.answers` of `derived_from` | RESIDUAL: stays `vob_read_state {project_id: derived_from}` — answers remain in the default read projection (§1.4.3); alternatively `read_state_summary` of the source project also carries `intent.answers`; WP5 should switch to the summary |
| :205 INTENT conditionals | `inspect.audio_present/speech_detected` | `summary.inspect.*` or `missing_required_keys` from record return |
| :232 PLAN 1 | `manifest.path`, `intent.answers`, `inspect.classification`, brief/storyboard confirmed | `summary.manifest.path`, `summary.intent.answers`, `summary.inspect.classification`, `summary.brief/.storyboard` |
| :271 storyboarder spawn | answers + pool paths + thumbs meta + transcript path | all present in summary (`inspect.*` — incl. `digest_path`, `strips_legend_path`, `clean_speech_path`, `transcripts[]`; `intent.answers`, `platform`, `target_duration_seconds`) |
| :278 PLAN 7 | `storyboard.markdown_path` | `summary.storyboard.markdown_path` (+ `plan_lint` counts to surface) |
| :296 COMPOSE 1 | manifest/brief/storyboard paths, composition existence | `summary.*` |
| :304 composer spawn | storyboard/brief/manifest/transcript paths, `composition.files`, `lint_report_path` | `summary.*` (`composition.files` included verbatim) |
| :307 COMPOSE 4 | `composition.files` populated | `summary.composition.files` |
| :310 lint-clean branch | `storyboard.total_target_duration_seconds` (does NOT exist in state today — latent SKILL bug) | `summary.storyboard.total_duration_seconds` (stamped by WP2; real fix) |
| :336 PREVIEW 3b | per-scene durations to compute scene start timecodes | RESIDUAL: per-scene data lives only in `storyboard.json` — orchestrator `Read`s the artifact at `summary.storyboard.artifact_path` (no MCP change) |
| :352 RENDER 1 | `preview.render_duration_seconds` | `summary.preview.render_duration_seconds` |

Residual full-state reads after v2: (1) debugging/audit (explicit `include`), (2) `--like`
cross-project inspection if WP5 chooses full answers context (summary suffices), (3) nothing else.

#### 1.4.3 `readState` — default projection + `include`

`readState(args)` signature: `readState({ project_id, include })`, `include` an optional array of
`"history" | "clips" | "dependencies"`. Behavior (read-time only; disk untouched):

```js
function readState(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const state = readSessionStateStrict(id);
  const include = new Set(Array.isArray(args && args.include) ? args.include : []);
  const out = { ...state };
  if (!include.has("history")) {
    delete out.history;
    out.history_count = Array.isArray(state.history) ? state.history.length : 0;
    out.last_history_event = Array.isArray(state.history) && state.history.length
      ? { kind: state.history[state.history.length - 1].kind, at: state.history[state.history.length - 1].at }
      : null;
  }
  if (!include.has("clips") && out.transcoded_clips && typeof out.transcoded_clips === "object") {
    out.transcoded_clips = clipsDigest(id, state.transcoded_clips);   // §1.4.1 helper; drops scenes[] detail
  }
  if (!include.has("dependencies") && out.dependencies && typeof out.dependencies === "object") {
    out.dependencies = dependencyFailuresDigest(state.dependencies);  // [{name, error}] — same as summary field
  }
  return out;
}
```
Everything else in the document (manifest, inspect, intent incl. full answers + profile snapshot,
brief, storyboard, composition, preview, render, package, iteration, deliverables, style) returns
verbatim.

#### 1.4.4 `initProject` — lean return

Replace the return at lines 89-93 with:
```js
return {
  created: true,
  project_id: id,
  session_dir: dir,
  phase: state.phase,                                   // "INGEST"
  style: state.style ? { derived_from: state.style.derived_from } : null,
};
```
SKILL.md reliance (verified): only the `STATE_CONFLICT` / `NOT_FOUND` error paths (:94) — no field
of the success return is read. Walker logs it opaquely. Safe.

### 1.5 Tool wrapper edits (schemas + descriptions)

All four files keep their metadata blocks intact (same `role_bundles` etc. — zero allow-list churn).
New EXACT `description` strings (token diet; the operational lore moves to WP5's phase files):

**`tools/transition-phase.js`** — description:
> "Apply one validated FSM transition. Refuses unknown edges; refuses gate-blocked transitions unless override_reason is given; blockers marked non-overridable (inspect acknowledgement, preview/render confirmation) refuse override entirely. Entering COMPOSE blocks while scene clips are pre-cut (cached on re-entry). Returns {from, to, archived, clips, phase_summary} — no full state echo."

inputSchema: UNCHANGED.

**`tools/read-state.js`** — description:
> "Full state.json document. By default history is replaced by {history_count, last_history_event}, transcoded_clips by a count digest, and dependencies by failure entries; pass include:[\"history\",\"clips\",\"dependencies\"] to restore any of them. Prefer vob_read_state_summary for routine phase decisions."

inputSchema:
```js
{
  type: "object",
  properties: {
    project_id: { type: "string" },
    include: {
      type: "array",
      items: { type: "string", enum: ["history", "clips", "dependencies"] },
      maxItems: 3,
      description: "Opt back in to heavy sections omitted by default.",
    },
  },
  required: ["project_id"],
}
```

**`tools/read-state-summary.js`** — description:
> "The orchestrator's working view: phase, iteration version, style lineage, dependency failures, and a per-slot digest (paths, confirmed/lint/render flags, revision counts, intent answers + missing keys, platform profile). Covers every routine phase decision without a full state read."

inputSchema: UNCHANGED.

**`tools/init-project.js`** — description (trim, drop duplicated --like lore):
> "Create the session directory and initial state.json (phase INGEST). Errors STATE_CONFLICT if the project exists (resume instead). Optional derived_from stamps style lineage from an existing project (NOT_FOUND if it doesn't exist). Returns {created, project_id, session_dir, phase, style}."

inputSchema: UNCHANGED.

### 1.6 `tools/ingest-file.js` — return shape + one additive state field

Handler logic untouched through the state write, EXCEPT one additive stamp: the `manifest` slot
written at ingest-file.js:243-249 gains
```js
total_duration_seconds: manifest.files.reduce((a, f) => a + (Number(f.duration_seconds) || 0), 0) || null,
```
(sum of per-file probed durations, rounded to 1 decimal; `null` when no file has a finite
duration). This is the data source for the summary's `manifest.total_duration_seconds` (§1.4.2)
and WP5's brief "Source: N file(s), <duration>s" line — `buildStateSummary` reads state only, so
the value must be stamped at ingest. Legacy sessions lack the field → summary emits `null` and
WP5's PLAN file falls back to Reading manifest.json. (Additive on-disk field — permitted by the
brief's back-compat constraint; this is a sanctioned widening of the brief's "return shape only"
note, agreed with WP5 — see spec-adapters-sync-docs.md C3.)

Then replace the return object (lines 272-284) with:

```js
const dependencyFailures = [
  ["ffmpeg", ffmpeg],
  ["hyperframes", hyperframes],
  ["asr", asr],
]
  .filter(([, info]) => info && info.ok === false)
  .map(([name, info]) => ({
    name,
    error: info.error || null,
    hint: DEPENDENCY_HINTS[name] || null,
  }));

return {
  manifest_path: manifestFile,
  source_path: sourcePath,
  file_count: manifest.file_count,
  video_stream_count: manifest.video_stream_count,
  new_or_changed_count: manifest.new_or_changed_count,
  reused_count: manifest.reused_count,
  files: manifest.files.map(({ probe: _probe, ...summary }) => summary),
  dependency_failures: dependencyFailures,          // [] when the toolchain is healthy
  rotation_warning: rotatedFiles.length > 0 ? rotatedFiles : null,
};
```
with module-level:
```js
const DEPENDENCY_HINTS = Object.freeze({
  ffmpeg: "install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg)",
  hyperframes: "npm install -g hyperframes",
  asr: "pip install faster-whisper (or set VOB_ASR_BACKEND)",
});
```
DELETED from the return: the `hyperframes`, `ffmpeg`, `asr` full preflight echoes. `state.dependencies`
on disk keeps the full blobs (renderToPackage gate + doctor unchanged). Description: replace the
current 1,020-char narrative with:
> "Probe a media file or directory with ffprobe into a hash-keyed, incremental manifest.json (re-runs merge; unchanged files are not re-probed). Preflights ffmpeg/hyperframes/ASR into state.dependencies and returns dependency_failures (empty when healthy) plus per-file summaries and rotation_warning. Errors if ffprobe is missing or no video stream exists."

WP5 hand-off: SKILL.md:112 ("Check the returned `asr` … if `asr.ok` is false") must become "warn if
`dependency_failures` contains `name:\"asr\"`" — listed in §3.

### 1.7 SHARED edit — `tools/save-composition.js` (reset ONLY)

This is the exact, minimal edit; WP4 layers QC + font injection AROUND it afterward and must not
move it. Inside the locked write (after `revisionCount` is computed, save-composition.js:73), extend
`next` (lines 75-103):

```js
const prevPreviewSlot = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
  ? state.preview
  : null;
const prevRenderSlot = state.render && typeof state.render === "object" && !Array.isArray(state.render)
  ? state.render
  : null;

const next = {
  ...state,
  composition: { /* unchanged */ },
  // D2: a composition save invalidates downstream human approvals. SKILL.md
  // claimed this reset existed; now it does.
  ...(prevPreviewSlot
    ? { preview: { ...prevPreviewSlot, confirmed: false, confirmed_at: null } }
    : {}),
  ...(prevRenderSlot
    ? { render: { ...prevRenderSlot, confirmed: false, confirmed_at: null } }
    : {}),
  last_updated: ts,
  history: [
    ...(Array.isArray(state.history) ? state.history : []),
    {
      kind: "composition_saved",
      /* existing fields unchanged */,
      reset_preview_confirmed: Boolean(prevPreviewSlot && prevPreviewSlot.confirmed === true),
      reset_render_confirmed: Boolean(prevRenderSlot && prevRenderSlot.confirmed === true),
    },
  ],
};
```
Rules: slots are NOT deleted (`render_path`/`mp4_path` etc. survive for display); only
`confirmed`/`confirmed_at` reset. Absent slots stay absent. Tool return: unchanged. Description:
append one sentence — "Saving also resets preview.confirmed and render.confirmed to false (stale
approvals never survive a composition change)."

### 1.8 SHARED edit — `tools/render-preview.js` + `tools/render-full.js` (revision stamp ONLY)

WP4 owns these files for verification deltas/timeouts/logs; THIS edit is WP1's and lands first.

**render-preview.js** — inside the locked commit (lines 82-114), before building `next`:
```js
const compositionNow = stateNow.composition && typeof stateNow.composition === "object" && !Array.isArray(stateNow.composition)
  ? stateNow.composition
  : null;
const compositionRevisionRendered = compositionNow && Number.isInteger(compositionNow.revision_count)
  ? compositionNow.revision_count
  : null;
```
and add to the `preview` slot object (line 94-101): `composition_revision_rendered: compositionRevisionRendered,`
and to the tool return (lines 116-122): `composition_revision_rendered: compositionRevisionRendered,`.

**render-full.js** — identical pattern in the success commit (lines 143-189): stamp
`composition_revision_rendered` into the `render` slot and the return.

Stamp source is the state read INSIDE the commit lock (not the pre-render read) so a composition
saved mid-render is correctly detected as a mismatch by the gate. Known race-acceptance: a save
that happens between the in-lock read and the gate check later is caught by the gate (it re-reads
state); a save during the render stamps the NEW revision — and that save also reset
`preview.confirmed` (§1.7), so the human must re-approve against the new files either way.

### 1.9 `tools/archive-for-iteration.js` — comment fix only

Replace the comment block (lines 13-18) with:
```js
// Standalone archival entrypoint. The primary archival code path is inside
// transitionPhase() — back-edges from RENDER/PACKAGE/ITERATE to COMPOSE or PLAN
// trigger archival atomically. This tool exposes the same helper for tests,
// recovery, or out-of-band cleanup. It is registered under the orchestrator
// role bundle (every tool must belong to a bundle and this is operator-driven
// recovery), but it is DELIBERATELY omitted from both adapters' allow-lists —
// the orchestrator never calls it in the normal flow.
```
`role_bundles: ["orchestrator"]` stays (VALID_ROLE_BUNDLES has no other sensible member;
registry-integrity checks agents→bundles, not bundles→allow-lists). Also fix the stale
"STORYBOARD" phase name in the old comment (now PLAN).

---

## PART 2 — WP2 plan-quality

### 2.1 `mcp/lib/platform-profiles.js` — NEW

Zero-dependency CommonJS module. Single source of truth for platform geometry/pacing defaults.

#### 2.1.1 Built-in table (exact values)

```js
const PLATFORM_PROFILES = Object.freeze({
  tiktok: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 200, safe_bottom_px: 280,
    ideal_duration_s: { min: 15, max: 45 }, max_duration_s: 90,
    caption_defaults: { anchor: "bottom", offset_px: 300, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  reels: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 220, safe_bottom_px: 270,
    ideal_duration_s: { min: 15, max: 45 }, max_duration_s: 90,
    caption_defaults: { anchor: "bottom", offset_px: 300, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  shorts: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 120, safe_bottom_px: 220,
    ideal_duration_s: { min: 20, max: 50 }, max_duration_s: 60,
    caption_defaults: { anchor: "bottom", offset_px: 260, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  vertical: {  // generic 9:16 fallback for unrecognized platforms
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 200, safe_bottom_px: 250,
    ideal_duration_s: { min: 15, max: 60 }, max_duration_s: null,
    caption_defaults: { anchor: "bottom", offset_px: 280, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  youtube: {
    width: 1920, height: 1080, aspect: "16:9", fps: 30,
    safe_top_px: 80, safe_bottom_px: 140,
    ideal_duration_s: { min: 30, max: 180 }, max_duration_s: null,
    caption_defaults: { anchor: "bottom", offset_px: 140, min_font_px: 36, max_words_per_line: 7 },
    thumbnail_timestamp_percent: 15,
  },
  landscape: {
    width: 1920, height: 1080, aspect: "16:9", fps: 30,
    safe_top_px: 80, safe_bottom_px: 120,
    ideal_duration_s: { min: 15, max: 120 }, max_duration_s: null,
    caption_defaults: { anchor: "bottom", offset_px: 140, min_font_px: 36, max_words_per_line: 7 },
    thumbnail_timestamp_percent: 15,
  },
  square: {
    width: 1080, height: 1080, aspect: "1:1", fps: 30,
    safe_top_px: 100, safe_bottom_px: 150,
    ideal_duration_s: { min: 15, max: 60 }, max_duration_s: 120,
    caption_defaults: { anchor: "bottom", offset_px: 160, min_font_px: 48, max_words_per_line: 5 },
    thumbnail_timestamp_percent: 15,
  },
});

const PLATFORM_ALIASES = Object.freeze({
  "tiktok": "tiktok", "tik tok": "tiktok", "tik-tok": "tiktok", "tt": "tiktok", "douyin": "tiktok",
  "reels": "reels", "reel": "reels", "instagram": "reels", "instagram reels": "reels",
  "ig": "reels", "ig reels": "reels", "insta": "reels",
  "shorts": "shorts", "short": "shorts", "youtube shorts": "shorts", "yt shorts": "shorts", "ytshorts": "shorts",
  "youtube": "youtube", "yt": "youtube", "long-form": "youtube", "longform": "youtube",
  "landscape": "landscape", "horizontal": "landscape", "16:9": "landscape", "widescreen": "landscape",
  "square": "square", "1:1": "square", "instagram feed": "square", "feed": "square",
  "vertical": "vertical", "portrait": "vertical", "9:16": "vertical",
  "story": "vertical", "stories": "vertical", "instagram story": "vertical",
  "snapchat": "vertical", "facebook reels": "vertical", "fb reels": "vertical",
});
```

#### 2.1.2 Lookup API (exports)

```js
canonicalizePlatform(raw) -> { raw: string, canonical: string, recognized: boolean }
```
Algorithm: `norm = String(raw).toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,!?]+$/, "")`.
(1) exact `PLATFORM_ALIASES[norm]` hit → that canonical, `recognized:true`.
(2) else scan aliases LONGEST-FIRST for a word-boundary match inside `norm`
(`new RegExp("\\b" + escapeRegExp(alias) + "\\b")`) → first hit wins, `recognized:true`
(handles "for tiktok mainly").
(3) else `canonical: "vertical"`, `recognized:false`. Never throws; `raw` preserved verbatim
(original casing/whitespace, pre-norm).

```js
getPlatformProfile(canonical) -> profile object   // merged with user override; unknown name -> vertical profile
resolvePlatform(raw) -> { raw, canonical, recognized, profile }
parseDurationToSeconds(raw) -> number|null
thumbnailTimestampPercent(canonical) -> number    // profile value, falling back to override top-level
                                                  // thumbnail_timestamp_percent, then 10
```

`parseDurationToSeconds` exact rules, applied to `norm` (lowercased, trimmed, with a leading
`~`, `about `, `around `, `roughly ` stripped):
1. Range `A-B` / `A–B` / `A to B` where both sides parse via rules 2-5 → `Math.round((a+b)/2)`.
2. `M:SS` (`/^(\d+):([0-5]?\d)$/`) → `M*60+SS`.
3. Combined `Xm Ys` / `XmYs` / `X min Y s` (`/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/`) → `X*60+Y`.
4. Minutes only (`/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/`) → `X*60`.
5. Seconds only (`/^(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/`) → `X`.
6. Bare number (`/^\d+(?:\.\d+)?$/`) → seconds.
7. Anything else → `null`. Result is rounded to 1 decimal; values ≤ 0 → `null`.

#### 2.1.3 User override file

Path: `<repo>/.vob-config/render-profiles.json` resolved as
`path.join(path.resolve(__dirname, "..", ".."), ".vob-config", "render-profiles.json")`
(NB: platform-profiles.js sits at `mcp/lib/`, so two `..` reach the repo root — package-output.js
uses three from `mcp/lib/tools/`; verify with the test in §5). Read lazily once per process,
cached; export `_reloadForTests()` that clears the cache. Unreadable/malformed file → built-ins
(no error, no warning — same forgiveness as package-output.js:42-47 today).

Merge semantics (exact):
- Top-level `thumbnail_timestamp_percent` (number) → fallback for `thumbnailTimestampPercent`.
- Each other top-level key = a platform name (lowercased). If it matches a built-in canonical:
  shallow-merge its fields over the built-in (`caption_defaults` and `ideal_duration_s` merge one
  level deep; scalars replace). If it does NOT match a built-in: it defines a NEW canonical platform
  iff it has finite `width` and `height`; missing fields default from the `vertical` profile
  (portrait) when `height > width`, else from `landscape`. New canonical names also become their
  own alias.
- Aliases are NOT user-extendable in v2 (keep the surface small).

`.vob-config/render-profiles.example.json` — REWRITE to document the v2 override schema (it remains
an inert example; install.sh still does not ship a live `render-profiles.json` — that is correct,
the built-in table is the real default now):
```json
{
  "thumbnail_timestamp_percent": 10,
  "tiktok":   { "safe_bottom_px": 320, "ideal_duration_s": { "min": 20, "max": 40 } },
  "linkedin": { "width": 1080, "height": 1350, "fps": 30, "max_duration_s": 600 }
}
```

#### 2.1.4 Hand-off: `tools/package-output.js` (WP4-owned)

WP4 deletes `RENDER_PROFILES_PATH` + `readThumbnailPercent` (package-output.js:27, 42-59) and calls:
```js
const { thumbnailTimestampPercent, canonicalizePlatform } = require("../platform-profiles.js");
const platformRaw = /* state.intent.answers.target_platform: object -> .canonical ?? .raw, string -> itself,
                        falling back to state.target && state.target.format */;
const percent = thumbnailTimestampPercent(canonicalizePlatform(platformRaw || "").canonical);
```
This is the ONLY sanctioned consumer change in WP4's files; the `width/height/fps` fields gain
their real consumers via the composer spawn data (WP5) and D6 QC (WP4), both reading the canonical
profile from the intent answer / summary `platform` field.

### 2.2 `mcp/lib/intent-schema.js` — dual-shape answer handling

Add (and export) two helpers; rewire `missingIntentKeys`/`applicableConditionalKeys`:

```js
// v2 answers may be canonicalized objects:
//   target_platform: { raw, canonical, profile }   target_duration: { raw, seconds }
// Legacy sessions store plain strings. Every consumer goes through these.
function intentAnswerRaw(value) {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.raw === "string") return value.raw;
  return null;
}
function intentAnswerPresent(value) {
  const raw = intentAnswerRaw(value);
  return typeof raw === "string" && raw.trim() !== "";
}
```
- `missingIntentKeys` (lines 69-85): replace both `typeof value !== "string" || value.trim() === ""`
  checks with `!intentAnswerPresent(value)`.
- `applicableConditionalKeys` (line 59): `const treatment = (intentAnswerRaw(present.audio_treatment) || "").trim();`
  (audio_treatment remains a plain string in practice; this is belt-and-braces).
- `validateIntentAnswerValue`: unchanged (operates on the trimmed input string before storage).
- Exports: add `intentAnswerRaw`, `intentAnswerPresent`.

Enumerated consumers of `target_platform`/`target_duration`/answer values (grep-verified) and how
each handles both shapes after this spec:

| Consumer | Handling |
|---|---|
| `intent-schema.js` `missingIntentKeys`/`applicableConditionalKeys` | via helpers above (this section) |
| `phase-gates.js:141` intentToPlan | delegates to `missingIntentKeys` — covered |
| `phase-gates.js:229` planToIntent | only checks `answers` object exists — unaffected |
| `brief-validator.js:49-51` / `session-state.js:139-144` (`audio_treatment`) | stays a plain string; no change required (helpers tolerate both anyway) |
| `session-state.js` `buildStateSummary` (§1.4.2) | emits `{raw,canonical}` / `{raw,seconds}` digests; legacy strings verbatim |
| `storyboard-schema.js` plan lint (§2.4) | uses `intentAnswerRaw` + `.seconds` with `parseDurationToSeconds` fallback for legacy strings |
| SKILL.md / opencode vob.md display + spawn prompts (:164, :232, :239-240, :271) | WP5/WP6: render `value.canonical ?? value` for platform, `value.seconds ? value.seconds+"s" : value` for duration (hand-off §3) |
| `storyboarder.md:48-49` ("parsed from intent.target_duration") | WP5: spawn passes `platform=<canonical>` + `duration_seconds=<seconds>`; storyboarder no longer parses free text (hand-off §3) |
| `scripts/m5-walker.js:238-239` | records plain strings via the tool → server canonicalizes on write; walker's own local echo (:48-49) unaffected. WP6 may assert the canonical shape |

### 2.3 `tools/record-intent-answer.js` — canonicalize at record time + lean return

Imports: add `const { resolvePlatform, parseDurationToSeconds } = require("../platform-profiles.js");`
and swap the local `readInspectSummaryIfPresent` for the one now exported from `../session-state.js`
(§1.4.2 — delete the local copy, lines 48-56).

After `validateAnswer` (unchanged — input stays a string, ≤4096 chars, audio_treatment enum
enforced), compute the STORED value:

```js
function canonicalizeAnswer(key, trimmed) {
  if (key === "target_platform") {
    const { raw, canonical, profile } = resolvePlatform(trimmed);
    return { raw, canonical, profile };          // profile snapshot stored for audit; canonical is the key
  }
  if (key === "target_duration") {
    return { raw: trimmed, seconds: parseDurationToSeconds(trimmed) };   // seconds: number|null — null is legal
  }
  return trimmed;                                 // all other keys stay plain strings
}
```
Store `nextAnswers = { ...prevAnswers, [key]: canonicalizeAnswer(key, value) }` (overwrite-by-key
semantics unchanged; re-recording a legacy string key upgrades it to the object shape — that is
the migration path, no bulk rewrite). Unrecognized platform: stored with `canonical:"vertical"`
(`recognized` is NOT persisted — the profile says what will be built; `raw` says what the user said).
Unparseable duration: `seconds:null`, no error (downstream treats null as "target unknown").

History event: unchanged (`{kind:"intent_answer_recorded", key, at}`).

Return shape (D1 — replaces lines 90-93):
```js
return {
  recorded: { key, value: nextAnswers[key] },     // the stored shape (string or object)
  missing_required_keys: missingIntentKeys(nextAnswers, inspectSummary),
};
```
The full `answers` echo is GONE. Description — replace (lines 99) with:
> "Record one intent answer (overwrites the key). Five required keys: target_platform, target_duration, tone, key_moments, music_vo; conditional keys (audio_treatment, captions_style) per inspect findings. audio_treatment enum: transcribe_captions | keep_audio | discard_audio | keep_ambient. target_platform/target_duration are canonicalized server-side ({raw,canonical,profile} / {raw,seconds}). Returns {recorded, missing_required_keys}."

inputSchema: UNCHANGED (string in).

### 2.4 `mcp/lib/storyboard-schema.js` — schema 1.0 optional fields + plan lint v2

#### 2.4.1 New OPTIONAL scene fields (validated in `validateScene` when present; absence = valid)

Schema_version stays `"1.0"` and the acceptance check (:177) is unchanged.

- `caption_segments`: array of `{ text, start_seconds, end_seconds, emphasis? }`, SOURCE-time.
  Validation per entry `scenes[i].caption_segments[j]`:
  - `text` non-empty string → else error `"...text must be a non-empty string"`;
  - `start_seconds` finite ≥ 0, `end_seconds` finite > start → else error
    `"...must satisfy 0 <= start_seconds < end_seconds"`;
  - `emphasis` optional boolean → else error `"...emphasis must be a boolean when present"`.
  No cross-check against `captions` (the string field stays the human-readable summary).
- `transition_in`, `transition_out`: optional, each must be `"cut"` or `"fade"` → else error
  `` `${where}.transition_in must be one of: cut, fade (omit for default cut)` ``. Export
  `const SCENE_TRANSITIONS = Object.freeze(["cut", "fade"]);` Deliberately tiny enum — only what
  renders reliably on the 8 GB reference host. NO top-level `style` block (design language lives in
  the brief; locked by D4).

#### 2.4.2 Plan lint — `lintStoryboardPlan(parsed, context)` (NEW export)

```js
// context = {
//   state,                     // full session state document
//   manifest,                  // parsed manifest.json document or null (loader in save-storyboard)
//   transcript,                // loadTranscript(state.inspect.transcript_path) or null
//   cleanSpeech,               // parsed clean_speech.json or null (see loader rule below)
//   targetSeconds,             // number|null (resolution rule below)
// }
// returns { errors: Finding[], warnings: Finding[] }
// Finding = { code, message, scene_id?, scene_index?, clip_index?, placement_index?, data? }
```

`validateStoryboardContent(parsed, state)` is REWRITTEN to: build the context (loaders below), run
the existing captions-on-silent check + all NEW checks, and return
`{ ok: errors.length === 0, errors, warnings }` (note: now also returns `warnings`).

Loaders (all best-effort, inside `validateStoryboardContent`):
- `manifest`: `state.manifest && state.manifest.path` → `readJsonFile`; any throw → `null`.
- `transcript`: existing `loadTranscript` (lines 229-240), unchanged.
- `cleanSpeech`: path = `state.inspect && state.inspect.clean_speech_path` (WP3 stamps it) — when
  that field is absent, fall back to `inspectCleanSpeechPath(state.project_id)` from `../paths.js`
  if the file exists on disk (it is written today at inspect.js:526-537 even though the state field
  isn't). Parse failure, absence, or a document without an array `keep_spans` → `null` → the
  straddle check is silently skipped (graceful absence; NEVER a blocker).
- `targetSeconds`: `state.intent.answers.target_duration` object-shaped with finite `seconds` →
  that; else `parseDurationToSeconds(intentAnswerRaw(answer))`; else
  `parsed.target.duration_seconds`; else `null`.

Constants (module-level, exported as `PLAN_LINT_THRESHOLDS` for tests):
```js
const PLAN_LINT_THRESHOLDS = Object.freeze({
  out_seconds_tolerance_s: 0.1,
  hook_max_s: 3.5,
  scene_sum_tolerance_s: 0.5,
  target_drift_ratio: 0.20,
  scene_clip_sum_ratio: 0.15,
  broll_min_hold_s: 1.5,
  broll_span_tolerance_s: 0.25,
  straddle_removed_min_s: 0.8,   // aligned with the storyboarder's "merge keep-spans when the gap
                                 // is <0.8s" craft rule — sanctioned merges must be lint-silent
});
```

**ERRORS (reject the save):**

| Code | Predicate (exact) | Message template |
|---|---|---|
| `PLAN_MANIFEST_INDEX_OUT_OF_RANGE` | `manifest` loaded AND `clip.manifest_file_index >= manifest.files.length` (per clip, all roles) | `scenes[{i}].source_clips[{j}].manifest_file_index {idx} is out of range — manifest has {n} file(s)` |
| `PLAN_CLIP_OUT_OF_BOUNDS` | `manifest` loaded AND `manifest.files[idx].duration_seconds` finite AND `clip.out_seconds > duration_seconds + 0.1` | `scenes[{i}].source_clips[{j}] out_seconds {out}s exceeds file duration {dur}s (file {idx}: {basename})` |
| `STORYBOARD_CAPTIONS_ON_SILENT_SEGMENT` | existing predicate (lines 277-295), UNCHANGED | existing message |
| `PLAN_NARRATION_SPAN_OUTSIDE_SCENE` | for each `broll_placements[k]` with a `narration_span`: let S = the scene containing the referenced clip; let A = S's a_roll clips (clipRoleOf === "a_roll"); if A is empty, A = all a_roll clips in the storyboard; error when NO clip in A satisfies `clip.in_seconds < span.end_seconds && clip.out_seconds > span.start_seconds` (any overlap) | `broll_placements[{k}] narration_span {start}–{end}s does not overlap any a_roll clip window {in scene "{scene_id}" / anywhere in the storyboard}` |
| `PLAN_BROLL_LONGER_THAN_SPAN` | for each placement with a `narration_span`: referenced clip duration `(out−in) > (span.end−span.start) + 0.25` | `broll_placements[{k}] clip runs {clipDur}s but covers a {spanDur}s narration span — trim the b_roll clip to the span` |

(Schema-shape errors from `validateStoryboard` — including the existing broll placement
reference-integrity "dangle" errors at lines 128-170 — continue to reject BEFORE content lint runs,
exactly as today: shape first, content second.)

**WARNINGS (ride into the result + state + storyboard.md):**

| Code | Predicate (exact) | Message template |
|---|---|---|
| `PLAN_HOOK_NOT_FIRST` | `parsed.scenes[0].purpose !== "hook"` | `scenes[0] has purpose "{purpose}" — short-form cuts should open on a hook scene` |
| `PLAN_HOOK_TOO_LONG` | `scenes[0].purpose === "hook" && scenes[0].target_duration_seconds > 3.5` | `hook scene is {d}s — hooks land in ≤3.5s; front-load the decisive moment` |
| `PLAN_SCENE_SUM_MISMATCH` | `Math.abs(sum(scenes[].target_duration_seconds) − total_target_duration_seconds) > 0.5` | `scene durations sum to {sum}s but total_target_duration_seconds is {total}s (Δ{d}s)` |
| `PLAN_TARGET_DRIFT` | `targetSeconds` finite AND `Math.abs(total_target_duration_seconds − targetSeconds) / targetSeconds > 0.20` | `storyboard total {total}s drifts {pct}% from the {target}s target` |
| `PLAN_SCENE_CLIP_SUM_MISMATCH` | per scene with ≥1 a_roll clip: `Math.abs(sumArollClipDur − scene.target_duration_seconds) / scene.target_duration_seconds > 0.15` | `scenes[{i}] a_roll clips sum to {sum}s vs scene target {target}s (Δ{pct}%)` |
| `PLAN_BROLL_TOO_SHORT` | any clip with `clipRoleOf(clip) === "b_roll"` and `(out−in) < 1.5` | `scenes[{i}].source_clips[{j}] b_roll holds only {d}s — under 1.5s reads as a glitch` |
| `PLAN_BROLL_REPEATED_BACK_TO_BACK` | sort placements by `narration_span.start_seconds ?? insert_at_seconds ?? array index`; warn when two CONSECUTIVE placements reference the same `{scene_id, clip_index}`, OR clips with the same `source_path` whose `[in,out]` windows overlap | `broll_placements[{k}] and [{k+1}] reuse the same b_roll segment back-to-back — vary the cutaway` |
| `PLAN_KEY_MOMENT_UNCOVERED` | parse ranges from `intentAnswerRaw(answers.key_moments)` with `/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*s/g` (the Branch-A resolved format `27.9–42.1s`); 0 parseable ranges → skip the check; else warn once per range with NO overlapping `source_clips` window (any scene, any role) | `key moment {start}–{end}s is not covered by any source clip — the user named this moment explicitly` |
| `PLAN_CLIP_STRADDLES_REMOVED_SPAN` | `cleanSpeech` loaded (must carry `keep_spans`): for each a_roll clip with `clip.manifest_file_index === cleanSpeech.file_index`, compute `removedWithin(cleanSpeech.keep_spans, clip.in_seconds, clip.out_seconds)` (import from `../clean-cut.js` — WP3 §5); warn when `removedWithin(...).seconds > 0.8` OR any single `cleanSpeech.removed[]` entry strictly inside the clip (`removed.start > in && removed.end < out`) has `(end − start) ≥ 0.8`. NB: clean-cut emits gap cuts down to 0.18s and per-filler removals — those are exactly what the storyboarder's <0.8s merge rule deliberately keeps, so they must NOT warn. Threshold = `straddle_removed_min_s` | `scenes[{i}].source_clips[{j}] contains {sec}s of removed dead-air/filler — snap the cuts to clean_speech keep-span boundaries (merged gaps under 0.8s are fine)` |

Each finding carries the structured fields named in its predicate
(`scene_index`/`scene_id`/`clip_index`/`placement_index`, plus a `data` object with the numbers
used in the message). Cap: NO cap inside the lint function (caller caps, §2.5).

### 2.5 `tools/save-storyboard.js` — object-or-string content, plan lint, slot stamps

#### 2.5.1 Input: `content` as object OR string (D1)

```js
function parseContent(rawContent) {
  let parsed;
  if (typeof rawContent === "string") {
    /* existing trim/length/JSON.parse path, unchanged (lines 22-42) */
  } else if (rawContent !== null && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    if (JSON.stringify(rawContent).length > MAX_STORYBOARD_LENGTH) {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `content exceeds ${MAX_STORYBOARD_LENGTH} character limit`);
    }
    parsed = rawContent;
  } else {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a JSON object or a string of JSON");
  }
  /* existing validateStoryboard call, unchanged */
}
```
inputSchema fragment (CRITICAL: the object branch MUST set `additionalProperties: true` — the
mini-validator defaults objects to `additionalProperties:false`, the exact bug class that broke
save_classification):
```js
content: {
  oneOf: [
    { type: "string", minLength: 1, maxLength: MAX_STORYBOARD_LENGTH },
    { type: "object", additionalProperties: true },
  ],
  description: "Storyboard document (schema 1.0) as a JSON object or a JSON string.",
},
```

#### 2.5.2 Plan-lint wiring (replaces the contentCheck block, lines 61-71)

```js
const contentCheck = validateStoryboardContent(storyboard, state);
if (!contentCheck.ok) {
  const shown = contentCheck.errors.slice(0, 10);
  const extra = contentCheck.errors.length - shown.length;
  throw new ToolError(
    ERROR_CODES.INVALID_ARGUMENTS,
    `storyboard plan lint failed: ${shown.map((e) => (typeof e === "string" ? e : `${e.code}: ${e.message}`)).join("; ")}${extra > 0 ? ` (+${extra} more)` : ""}`,
    {
      plan_errors: shown,
      plan_warnings: contentCheck.warnings.slice(0, 10),   // warnings ride on rejection too —
                                                           // the storyboarder fixes both in one revision pass
      error_count: contentCheck.errors.length,
      warning_count: contentCheck.warnings.length,
    },
  );
}
const planWarnings = contentCheck.warnings;
```

#### 2.5.3 State slot + markdown + return

`next.storyboard` (lines 92-99) gains:
```js
scene_count: storyboard.scenes.length,
total_duration_seconds: storyboard.total_target_duration_seconds,
plan_lint: {
  error_count: 0,
  warning_count: planWarnings.length,
  warnings: planWarnings.slice(0, 25),       // bounded in state
  linted_at: ts,
},
```
History event gains `warning_count: planWarnings.length`.
Markdown render call becomes `renderStoryboardMarkdown(storyboard, { planWarnings })` (§2.6).
Tool return (lines 108-115) becomes:
```js
return {
  artifact_path: jsonFile,
  markdown_path: mdFile,
  saved_at: ts,
  confirmed: false,
  revision_count: revisionCount,
  scene_count: storyboard.scenes.length,
  total_duration_seconds: storyboard.total_target_duration_seconds,
  plan_lint: {
    error_count: 0,
    warning_count: planWarnings.length,
    warnings: planWarnings.slice(0, 10),     // ≤10 inline per D1
  },
};
```
Description — replace (line 121) with:
> "Save the storyboard (schema 1.0; content may be a JSON object or string). Validates shape, then runs plan lint: errors (out-of-range clips, captions-on-silent, narration-span violations) reject the save; warnings (hook placement/length, duration drift, b_roll holds, key-moment coverage, clean-speech straddles) return in plan_lint, persist to state, and render into storyboard.md for the plan gate. Any save resets confirmed:false and bumps revision_count."

#### 2.5.4 Back-compat

Legacy storyboard.json documents (no caption_segments/transitions) validate exactly as before.
Legacy `state.storyboard` slots (no `scene_count`/`plan_lint`) are read fine everywhere (summary
defaults `null`, §1.4.2). Re-save upgrades the slot.

### 2.6 `mcp/lib/storyboard-markdown.js`

`renderStoryboardMarkdown(storyboard, options = {})` — second parameter `{ planWarnings = [] }`.
Back-compat: callable with one argument (walker, tests).

1. After the `## Target` block (line 110), when `planWarnings.length > 0` insert:
```
## Plan warnings ({n})

_Flagged by plan lint — review at the plan gate; fix or accept explicitly._

- **{code}** — {message}
...
```
(one bullet per warning, capped at 25 — same cap as the state slot).
2. In `renderScene` (after the captions block, line 81): when `scene.caption_segments` is a
non-empty array, render:
```
**Caption segments:**
  - {MM:SS.ss} → {MM:SS.ss} "{text}"{ **(emphasis)** when emphasis === true}
```
using the existing `formatTimecode`.
3. In the scene header line (line 55), when `transition_in`/`transition_out` present and not
`"cut"`, append ` _(in: {transition_in}, out: {transition_out})_` — omit defaults.

### 2.7 `mcp/lib/brief-validator.js` — de-overfit

Delete exactly two patterns from `DROP_AUDIO_PATTERNS` (lines 9-18): `/\bdrone\s+hum\b/i` and
`/\bwind\s+isn[’']t\s+useful\b/i` — both are source-specific phrases from one test session, not
audio-drop claims (a brief may legitimately MENTION drone hum while keeping audio). The six generic
patterns stay. No other change; `BAKE_CAPTIONS_PATTERNS` untouched.

---

## PART 3 — Cross-package hand-offs (every touch on a file another WP owns)

| # | This spec provides | Consumer/owner | Exact hand-off |
|---|---|---|---|
| 1 | `withSessionLock` async-aware (§1.1) | all WPs | drop-in; `render-full.js:84` needs no edit |
| 2 | `preview/render.composition_revision_rendered` stamp (§1.8) | WP4 (render tools) | WP4's verification-delta edits to the SAME files land AFTER WP1's stamp edit; WP4 must keep the stamp inside the locked commit |
| 3 | `save-composition.js` confirmed-reset (§1.7) | WP4 (QC + fonts in the same file) | WP4 inserts QC BEFORE `withSessionLock` (reject early) and font injection next to `recreateSourceSymlinks`; the reset block in `next` is untouched |
| 4 | `clipsDigest` + lean transition return (§1.4.1) | WP6 (m5-walker) | walker doesn't destructure `result.state` (verified) — logs only; WP6 should assert the new shape and plan-lint-clean fixtures |
| 5 | enriched summary + read_state `include` (§1.4.2-3) | WP5/WP6 (SKILL.md, vob.md) | retarget every read site per the table in §1.4.2; OpenCode names are `vob_vob_read_state[_summary]` |
| 6 | `ingest_file.dependency_failures` (§1.6) | WP5/WP6 | SKILL.md:112 + vob.md equivalent: check `dependency_failures` for `name:"asr"` instead of `asr.ok` |
| 7 | `record_intent_answer` return `{recorded, missing_required_keys}` (§2.3) | WP5/WP6 | skill must stop reading the `answers` echo (it re-asks from `missing_required_keys`, already its documented path at :222) |
| 8 | canonical intent shapes (§2.3) | WP5 (spawn prompts), WP4 (package manifest lineage), WP6 | platform → `value.canonical`, duration → `value.seconds`; storyboarder spawn passes `platform=<canonical> duration_seconds=<seconds>`; storyboarder.md drops "parsed from intent.target_duration" |
| 9 | `thumbnailTimestampPercent` / `canonicalizePlatform` (§2.1.4) | WP4 (package-output.js) | replace `readThumbnailPercent` + `RENDER_PROFILES_PATH` with the platform-profiles import |
| 10 | `state.inspect.clean_speech_path` consumption (§2.4.2) | WP3 (stamps the field) | plan lint already falls back to `inspectCleanSpeechPath()` on disk, so WP2 works with or without WP3 landed |
| 11 | `plan_lint` in save return/state/markdown (§2.5) | WP5 | PLAN step 7 surfaces `plan_lint.warnings` alongside the storyboard at the single sign-off |
| 12 | non-overridable blockers (§1.3-1.4) | WP5/WP7 | SKILL.md:37 ("If you must bypass a gate, pass override_reason") and `.claude/rules/editing.md` need the non-overridable caveat; CLAUDE.md's "can never be overridden" becomes TRUE (WP7 documents) |
| 13 | D1 "lint results ≤10 findings" for `lint_composition` | WP4 | NOT specced here — lint-composition.js currently returns 20 (lint-composition.js:148); WP4 caps to 10 when reworking the findings shape for D6 |
| 14 | D2 runner items (ERR_FILE_NOT_FOUND retry exclusion, stderr ring buffer) | WP4 | out of this spec's scope despite living under D2 — runner files are WP4-owned |

---

## PART 4 — Back-compat matrix (pre-v2 `state.json` MUST keep working)

| Legacy condition | v2 behavior |
|---|---|
| `intent.answers.*` all plain strings | gates/summary/lint use `intentAnswerRaw`; summary `platform`/`target_duration_seconds` = null; plan lint parses duration from the raw string |
| no `preview.composition_revision_rendered` / no `render.composition_revision_rendered` | revision-binding blockers never fire (null ⇒ pass) |
| no `storyboard.scene_count`/`total_duration_seconds`/`plan_lint` | summary emits nulls; next save stamps them |
| no `manifest.total_duration_seconds` (pre-v2 ingest) | summary emits `null`; a re-ingest stamps it; WP5 PLAN falls back to Reading manifest.json |
| no `inspect.digest_path`/`strips_legend_path`/`strip_count`/`transcripts`/`hook_candidate_count` and no `classification.visual_coverage`/`hook_tagged_count` (pre-WP3 inspect) | summary defaults `null`/`0`/`[]`/`null` per §1.4.2 |
| no `style`/`iteration`/`deliverables`/`dependencies` | summary defaults (`null`/1/`0`/`[]`) |
| `history` absent or huge | summary/read_state never throw; counts default 0 |
| BRIEF/STORYBOARD legacy phases | unchanged normalization (session-state.js:112-122) |
| storyboard.json without new optional fields | validates identically; plan lint may emit warnings (warnings never block a save) |
| a confirmed preview from a pre-v2 session entering PREVIEW→RENDER | passes (legacy-absent stamp), exactly as before |
| envelope consumers expecting `SCOPE_BLOCKED`/`AUTH_MISSING` | none exist (grep §1.2) |

On-disk `state.json` write format: unchanged except ADDITIVE fields
(`composition_revision_rendered`, `scene_count`, `total_duration_seconds`, `plan_lint`,
object-shaped intent answers on NEW recordings, `reset_*` history fields). No field is removed or
renamed on disk.

---

## PART 5 — Verification (commands + fixtures; run from repo root)

Fixtures dir: create `docs/v2/fixtures/` with
`storyboard.valid.json` (hook-first, durations consistent, in-range clips),
`storyboard.errors.json` (one out-of-range `manifest_file_index`, one `out_seconds` past EOF, one
narration_span overlapping nothing), `storyboard.warnings.json` (beat-first scenes[0], 5s hook,
total 30s vs 20s target, 1.0s b_roll, duplicated consecutive placement),
`state.legacy.json` (plain-string answers, no v2 stamps, phase PREVIEW with confirmed preview).

1. **Syntax** — `for f in mcp/lib/{storage,envelope,dispatch,phase-gates,session-state,intent-schema,storyboard-schema,storyboard-markdown,brief-validator,platform-profiles}.js mcp/lib/tools/{transition-phase,read-state,read-state-summary,init-project,ingest-file,save-composition,render-preview,render-full,archive-for-iteration,record-intent-answer,save-storyboard}.js; do node --check "$f"; done`
2. **Boot** — `node mcp/server.js < /dev/null` exits cleanly after registry build + integrity check
   (tools/list bytes: `node -e 'const {TOOLS}=require("./mcp/lib/tool-registry.js");console.log(JSON.stringify(TOOLS).length)'` — record before/after for `docs/v2/RESULTS.md`).
3. **Async lock** — `node -e` test: `withSessionLock("locktest", async () => { await new Promise(r=>setTimeout(r,200)); return 1; })` and, 50 ms in (separate timer), assert `acquireSessionLock("locktest")` throws `Session lock busy`; after the promise resolves, acquisition succeeds. Also: sync callback still returns synchronously; throwing callback releases the lock.
4. **Envelope** — `node -e`: `classifyException(new Error("auth_profile x not found"))` → `INTERNAL_ERROR`; `classifyException(new ToolError("NOT_FOUND","x"))` → `NOT_FOUND`; `require` exposes no `classifyDataError`; `executeTool("vob_read_state",{project_id:"nonexistent"})` → `{ok:false,error:{code:"NOT_FOUND"}}` (via dispatch, proving the pipeline end-to-end).
5. **Non-overridable gates** — temp session at INSPECT with `inspect.user_acknowledged:false` and inspect.json on disk: `TOOL_HANDLERS.vob_transition_phase({project_id, to_phase:"INTENT", override_reason:"because"})` → throws STATE_CONFLICT with message containing `inspect_not_acknowledged cannot be bypassed` and `details.non_overridable:["inspect_not_acknowledged"]`. Same for preview/render confirm blockers (drive state via the fixture). Then verify `ffmpeg_unavailable` IS still overridable (mutate `state.dependencies.ffmpeg.ok=false` in a fixture and override RENDER→PACKAGE with all confirms true).
6. **Revision binding** — fixture at PREVIEW with `preview.confirmed:true, composition_revision_rendered:1, composition.revision_count:2` → PREVIEW→RENDER blocked with `preview_stale_composition`; with `composition_revision_rendered` deleted (legacy) → passes. Mirror for RENDER→PACKAGE.
7. **save_composition reset** — TOOL_HANDLERS smoke through COMPOSE; set `preview.confirmed:true` by hand in the temp fixture; call `vob_save_composition` → re-read state: `preview.confirmed===false`, `confirmed_at===null`, history tail has `reset_preview_confirmed:true`.
8. **Lean returns** — full TOOL_HANDLERS walk (init → ingest real file → inspect `skip_transcription` if no ASR → 5 intent answers → save_brief/confirm → save_storyboard(valid fixture)/confirm → transition COMPOSE): assert transition results have NO `state` key, `phase_summary.phase` correct, COMPOSE result `clips.clip_count > 0` and no `transcoded_clips` key; `vob_read_state` default has `history_count` but no `history`; `include:["history"]` restores it; `vob_read_state_summary` contains every §1.4.2 field.
9. **Canonicalization** — `record_intent_answer {key:"target_platform", value:"Tik Tok"}` → state stores `{raw:"Tik Tok", canonical:"tiktok", profile:{width:1080,...}}`; `"my niche forum"` → canonical `"vertical"`; `{key:"target_duration", value:"~1m 30s"}` → `{raw:"~1m 30s", seconds:90}`; `"30-45s"` → 38 (midpoint rounded); `"whatever feels right"` → `seconds:null`. Return is `{recorded, missing_required_keys}` only. Legacy: hand-write a plain-string answers fixture → `missingIntentKeys` treats them as present; INTENT→PLAN passes.
10. **platform-profiles** — `node -e` matrix over all aliases → expected canonicals; override file test: write a temp `.vob-config/render-profiles.json` with `{"tiktok":{"safe_bottom_px":320},"linkedin":{"width":1080,"height":1350}}`, `_reloadForTests()`, assert merged `safe_bottom_px===320`, `getPlatformProfile("linkedin").fps===30` (vertical defaults), `thumbnailTimestampPercent("square")===15`; delete the file, reload, assert built-ins.
11. **Plan lint** — `save_storyboard` with `storyboard.errors.json` → throws INVALID_ARGUMENTS, `details.plan_errors` contains `PLAN_MANIFEST_INDEX_OUT_OF_RANGE` + `PLAN_CLIP_OUT_OF_BOUNDS` + `PLAN_NARRATION_SPAN_OUTSIDE_SCENE`, `details.plan_warnings` is an array (any warning findings the fixture also trips, ≤10), ≤10 inline, counts exact; with `storyboard.warnings.json` → save SUCCEEDS, return `plan_lint.warning_count===5` (codes: HOOK_NOT_FIRST or HOOK_TOO_LONG per fixture, SCENE_SUM/TARGET_DRIFT, BROLL_TOO_SHORT, BROLL_REPEATED…), state slot capped at 25, `storyboard.md` contains `## Plan warnings`; object-form `content` accepted (pass the parsed object). Clean-speech straddle: write a minimal `inspect/clean_speech.json` (`{file_index:0, keep_spans:[{start:0,end:5},{start:7,end:60}], removed:[{start:5,end:7,reason:"gap"}]}`) into the temp session + a clip 3–10s → warning fires (2.0s removed > 0.8); change to `keep_spans:[{start:0,end:5},{start:5.5,end:60}], removed:[{start:5,end:5.5,reason:"gap"}]` → NO warning (0.5s < 0.8 — the sanctioned merge case); delete the file → no warning, no error.
12. **Brief de-overfit** — `validateBriefGrounding("the drone hum is lovely", state-with-audio-keep)` → `ok:true`; `"drop the audio entirely"` with `keep_audio` → violation (unchanged).
13. **Legacy end-to-end** — load `state.legacy.json` into a temp session: `read_state_summary` returns without throwing (nulls where unstamped); PREVIEW→RENDER transition passes (stamp absent) when `render_path` exists on disk.

---

## PART 6 — Token accounting expectations (for docs/v2/RESULTS.md, WP7 records)

- transition return: ~16 KB late-session → ≤1.5 KB (summary-bound). ~8 transitions/run.
- read_state default: history (45% of bytes) + clips detail + dependency blobs gone; summary
  replaces ≥4 of 5 routine full reads (§1.4.2 table).
- Descriptions trimmed in this spec's six tool files: ~2,900 chars → ~1,600 chars combined.
- record_intent_answer: no more full-answers echo × 5-7 calls/run.
