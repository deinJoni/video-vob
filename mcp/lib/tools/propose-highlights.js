"use strict";

// vob_propose_highlights (v0.3.11) — the PLAN-time discovery pre-pass that runs
// the INSPECT signal stack FORWARD to auto-author a multi-short fan-out. It loads
// inspect.json (ranked hook_candidates + winner file index), segments.json
// (per-segment take-quality strength + energy), clean_speech.json (keep-spans to
// snap to), and the intent answers (target duration, named key moments, how many
// highlights), runs the pure scorer/clusterer in highlight-discovery.js, writes
// plan/highlights.json, and stamps a lean state.highlights slot. The orchestrator
// then threads highlights_path into the storyboarder spawn ("author one short per
// candidate window"); everything from COMPOSE onward is the existing fan-out path.
//
// ADVISORY + FAIL-SAFE by contract: touches NO FSM edge and NO gate. Missing or
// unreadable INSPECT artifacts, no winner file, or zero candidates → it still
// writes a highlights.json + state slot with count:0 and a `notes` reason, and
// returns normally. The only hard errors are a bad/nonexistent project_id (the
// project must exist) — never a "the signals were weak" error.

const fs = require("fs");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  planDir,
  statePath,
  highlightsPath,
  inspectSummaryPath,
  segmentsPath,
  inspectCleanSpeechPath,
} = require("../paths.js");
const { withSessionLock, writeFileAtomic, readJsonFile } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { intentAnswerRaw } = require("../intent-schema.js");
const { parseKeyMoments } = require("../storyboard-schema.js");
const { discoverHighlights } = require("../highlight-discovery.js");

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Best-effort JSON read — returns null on any missing/unreadable/corrupt file
// (the whole tool is fail-safe; a missing artifact is a notes reason, not a throw).
function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return readJsonFile(file);
  } catch {
    return null;
  }
}

// The winner file's segments — candidate seconds are file-specific, so v1 is
// single-source (summary.transcribed_file_index, with sensible fallbacks).
function pickWinner(summary, segmentsDoc) {
  const files = segmentsDoc && Array.isArray(segmentsDoc.files) ? segmentsDoc.files : [];
  if (files.length === 0) return { fileIndex: -1, segments: [] };
  let idx = summary && Number.isInteger(summary.transcribed_file_index) ? summary.transcribed_file_index : -1;
  let f = idx >= 0 ? files.find((x) => x && x.file_index === idx) : null;
  if (!f && files.length === 1) { f = files[0]; idx = f.file_index; }
  if (!f) return { fileIndex: -1, segments: [] };
  const fileIndex = Number.isInteger(f.file_index) ? f.file_index : idx;
  return { fileIndex, segments: Array.isArray(f.segments) ? f.segments : [] };
}

// {seconds?, min_seconds?, max_seconds?} from the override or the canonical intent
// target_duration ({raw, seconds, range:{min_seconds,max_seconds}}). Empty ⇒ the
// discovery defaults (a ~30s short) apply.
function buildTarget(args, answers) {
  if (Number.isFinite(args.target_duration_seconds) && args.target_duration_seconds > 0) {
    return { seconds: args.target_duration_seconds };
  }
  const td = answers && answers.target_duration;
  if (isPlainObject(td)) {
    const t = {};
    if (Number.isFinite(td.seconds)) t.seconds = td.seconds;
    if (isPlainObject(td.range)) {
      if (Number.isFinite(td.range.min_seconds)) t.min_seconds = td.range.min_seconds;
      if (Number.isFinite(td.range.max_seconds)) t.max_seconds = td.range.max_seconds;
    }
    return t;
  }
  return {};
}

// Desired N: explicit override > canonical highlight_count > legacy raw > null
// (discovery default). null lets discovery choose; we never force a count here.
function resolveCount(args, answers) {
  if (Number.isFinite(args.count) && Math.floor(args.count) > 0) return Math.floor(args.count);
  const hc = answers && answers.highlight_count;
  if (isPlainObject(hc) && Number.isInteger(hc.count) && hc.count > 0) return hc.count;
  if (Number.isInteger(hc) && hc > 0) return hc;
  if (typeof hc === "string") {
    const m = hc.match(/\d+/);
    if (m) return parseInt(m[0], 10);
  }
  return null;
}

function maxEnd(segments) {
  let m = null;
  for (const s of Array.isArray(segments) ? segments : []) {
    if (s && Number.isFinite(s.end_seconds) && (m == null || s.end_seconds > m)) m = s.end_seconds;
  }
  return m;
}

function leanCandidate(c) {
  return {
    rank: c.rank,
    score: c.score,
    start_seconds: c.start_seconds,
    end_seconds: c.end_seconds,
    duration_seconds: c.duration_seconds,
    hook_type: c.hook_type,
    suggested_title: c.suggested_title,
    key_moment_count: Array.isArray(c.key_moment_refs) ? c.key_moment_refs.length : 0,
  };
}

function proposeHighlights(args) {
  const id = assertSafeProjectId(args && args.project_id);
  if (args && args.count != null && !(Number.isFinite(args.count) && Math.floor(args.count) > 0)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "count must be a positive integer when provided");
  }
  if (args && args.target_duration_seconds != null
    && !(Number.isFinite(args.target_duration_seconds) && args.target_duration_seconds > 0)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "target_duration_seconds must be a positive number when provided");
  }
  // Confirms the project exists (NOT_FOUND otherwise) — a real error, not the
  // weak-signal fail-safe path.
  const state = readSessionStateStrict(id);
  const answers = isPlainObject(state.intent) && isPlainObject(state.intent.answers) ? state.intent.answers : {};

  // Load the INSPECT artifacts (all best-effort).
  const summary = readJsonSafe(inspectSummaryPath(id));
  const segmentsDoc = readJsonSafe(segmentsPath(id));
  const cleanDoc = readJsonSafe(inspectCleanSpeechPath(id));

  const { fileIndex, segments } = pickWinner(summary, segmentsDoc);
  const hookCandidates = summary && Array.isArray(summary.hook_candidates) ? summary.hook_candidates : [];
  const keepSpans = cleanDoc && Array.isArray(cleanDoc.keep_spans) ? cleanDoc.keep_spans : [];
  const removedSpans = cleanDoc && Array.isArray(cleanDoc.removed) ? cleanDoc.removed : [];
  const keyMoments = parseKeyMoments(intentAnswerRaw(answers.key_moments) || "");

  const target = buildTarget(args, answers);
  const requestedCount = resolveCount(args, answers);

  let result = { candidates: [], notes: "", stats: null };
  let reason = null;
  if (!summary && !segmentsDoc) {
    reason = "INSPECT has not produced inspect.json/segments.json yet — run INSPECT before extracting highlights";
  } else if (fileIndex < 0 || segments.length === 0) {
    reason = "no winner file segments found in segments.json — nothing to extract from";
  } else {
    try {
      result = discoverHighlights({
        hookCandidates,
        segments,
        keepSpans,
        removedSpans,
        keyMoments,
        sourceFileIndex: fileIndex,
        sourceDurationSeconds: maxEnd(segments),
        target,
        count: requestedCount,
      }) || { candidates: [], notes: "", stats: null };
    } catch (err) {
      // discovery is pure + fail-safe, but never let an unexpected throw escape.
      result = { candidates: [], notes: `discovery error: ${err && err.message ? err.message : "unknown"}`, stats: null };
    }
  }

  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const notes = reason ? [reason, result.notes].filter(Boolean).join("; ") : (result.notes || "");
  const generatedAt = nowIso();
  const path0 = highlightsPath(id);

  // Write plan/highlights.json (always — the artifact records the attempt even
  // when empty, so the orchestrator can read the reason).
  const doc = {
    schema_version: "1.0",
    project_id: id,
    generated_at: generatedAt,
    source: {
      file_index: fileIndex,
      hook_candidate_count: hookCandidates.length,
      segment_count: segments.length,
      keep_span_count: keepSpans.length,
    },
    target_duration: target,
    requested_count: requestedCount,
    count: candidates.length,
    candidates,
    notes,
    stats: result.stats || null,
  };
  try {
    fs.mkdirSync(planDir(id), { recursive: true });
    writeFileAtomic(path0, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `failed to write highlights.json: ${err && err.message ? err.message : err}`);
  }

  const candidatesSummary = candidates.map(leanCandidate);

  // Stamp the lean state.highlights slot under the session lock.
  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const next = {
      ...stateNow,
      highlights: {
        generated_at: generatedAt,
        source_file_index: fileIndex,
        requested_count: requestedCount,
        count: candidates.length,
        target_duration: target,
        highlights_path: path0,
        notes,
        candidates_summary: candidatesSummary,
      },
      last_updated: generatedAt,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        { kind: "highlights_proposed", at: generatedAt, count: candidates.length, requested: requestedCount, source_file_index: fileIndex },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
    return {
      highlights_path: path0,
      count: candidates.length,
      requested_count: requestedCount,
      source_file_index: fileIndex,
      candidates_summary: candidatesSummary,
      notes,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_propose_highlights",
  description:
    "(v0.3.11) Discovery pre-pass for highlight extraction — runs the INSPECT signals (ranked hook_candidates, per-segment take-quality strength, clean-cut keep-spans, named key_moments, energy) FORWARD as a generative selection pass to propose the short-worthy moments of a long/edited source. Loads inspect.json + segments.json + clean_speech.json + intent answers, scores/grows/dedupes candidate windows (winner file only — single-source in v1), writes plan/highlights.json {generated_at, source, target_duration, candidates[], notes}, and stamps a lean state.highlights {count, candidates_summary}. The orchestrator threads highlights_path into the storyboarder spawn to auto-author a schema-1.1 shorts[] storyboard (one short per candidate window), which flows through the EXISTING fan-out machinery. Inputs: project_id, count? (override the intent highlight_count), target_duration_seconds? (override the per-short target). ADVISORY + FAIL-SAFE: touches no FSM edge and no gate; missing/unreadable inputs or zero candidates return count:0 with a notes reason (never an error, never gates). Outputs {highlights_path, count, requested_count, source_file_index, candidates_summary[], notes}.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      count: { type: "integer", minimum: 1 },
      target_duration_seconds: { type: "number", minimum: 1 },
    },
    required: ["project_id"],
  },
  handler: proposeHighlights,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["plan/highlights.json", "state.json"],
  hook_required: false,
});
