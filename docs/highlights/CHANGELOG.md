# Highlight Extraction — CHANGELOG

## v0.3.11 — auto-author a multi-short fan-out from a long source

Discovery pre-pass that runs the INSPECT signal stack FORWARD to propose the short-worthy
moments of a long/already-edited source, auto-authoring a multi-short `shorts[]` plan that
flows through the EXISTING fan-out machinery. Additive, advisory, fail-safe — **no FSM edge,
no gate, no new/renamed required intent key**.

### New

- **`mcp/lib/highlight-discovery.js`** (pure, no requires, no I/O, never throws) — the
  scorer/clusterer. `discoverHighlights()` seeds every winner-file speech segment, grows a
  window to the intent duration snapping to keep-span + segment boundaries, scores it (hook
  pull + sustained take-quality delivery + self-containment + key-moment coverage, source-
  relative), dedupes overlaps, and returns the ranked top-N. Empty (with a `notes` reason)
  when nothing clears the minimum score. Exposed tunables + helpers for testing.
- **`mcp/lib/tools/propose-highlights.js`** — `vob_propose_highlights` (orchestrator,
  mutating). Loads `inspect.json` / `segments.json` / `clean_speech.json` + intent, runs
  discovery, writes `plan/highlights.json`, stamps a lean `state.highlights` slot under the
  session lock. Fail-safe: missing inputs / zero candidates → `count:0` + `notes`, never errors.
- **Optional intent key `highlight_count`** (`intent-schema.js`) — never required, never gates;
  canonicalized to `{raw, count}` (`record-intent-answer.js`), capped at 10. Absent ⇒ off.
- **`plan/highlights.json`** artifact (`highlightsPath()` in `paths.js`).
- **`read_state_summary.highlights`** `{count, requested_count, source_file_index,
  generated_at, highlights_path, notes, candidates_summary[]}` (`summarizeHighlights` in
  `session-state.js`).
- **Walker phase `highlights`** (`scripts/m5-walker.js`) — source-free: pure-discovery
  assertions (ranking / keep-span snapping / duration band / dedupe / key-moment / count cap /
  fail-safe empty / already-edited long-keep-span) + the full tool path end-to-end via a real
  temp session.

### Wiring

- PLAN step 4b (both adapters): when `highlight_count` is set, call `vob_propose_highlights`
  before the storyboarder spawn; `count >= 1` ⇒ fan-out of `count` shorts with `highlights_path`
  threaded in; `count == 0` ⇒ fall back to normal authoring. Editorial-critic pass unchanged.
- `storyboarder.md`: documents `highlights_path` → author one short per candidate window
  (the `{start_seconds, end_seconds}` bound each short's source material; hints are advisory).
- Registered in `index.js` `TOOL_MODULES`, `SKILL.md` `allowed-tools`, `settings.json`
  `permissions.allow`. OpenCode: no change (orchestrator MCP tools allowed by default).
- `parseKeyMoments` exported from `storyboard-schema.js` (additive).

### Verification

- `node scripts/m5-walker.js highlights` — 7/7 steps green (discovery + tool wiring).
- Boot integrity green on both adapters.
- `node scripts/m5-walker.js fanout` — green end-to-end (reached ITERATE, 2 deliverables, no
  override) on the real `01_hackabob_spa.mp4` source: the downstream fan-out path is unbroken.
- Version-of-record → 0.3.11 (`package.json`, `.vob/VERSION`, `mcp/server.js`).

### Out of scope (v1)

Multi-source highlights; model re-ranking of candidates; audio/beat-aware boundaries;
auto-generated titles/captions beyond a `suggested_title` hint.
