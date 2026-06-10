"use strict";

const fs = require("fs");
const { PHASE_VALUES, LEGACY_PHASE_ALIASES } = require("./constants.js");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { sessionDir, statePath, assertSafeProjectId, inspectSummaryPath, transcodedClipsDir } = require("./paths.js");
const { withSessionLock, writeFileAtomic, readJsonFile } = require("./storage.js");
const { getGate } = require("./phase-gates.js");
const { archiveForIteration, currentIterationVersion, isArchivalTransition } = require("./archival.js");
const { missingIntentKeys } = require("./intent-schema.js");
const { materializeSceneClips } = require("./clip-materialize.js");

// INTENT -> PLAN -> COMPOSE: the former BRIEF and STORYBOARD phases are merged
// into a single PLAN phase (one human gate that presents intent summary +
// A-roll order + chosen takes + B-roll placements together). Back-edges that
// used to target STORYBOARD now target PLAN.
const ALLOWED_TRANSITIONS = Object.freeze({
  INGEST:   ["INSPECT"],
  INSPECT:  ["INTENT"],
  INTENT:   ["PLAN"],
  PLAN:     ["COMPOSE", "INTENT"],
  COMPOSE:  ["PREVIEW", "PLAN"],
  PREVIEW:  ["RENDER", "COMPOSE", "PLAN"],
  RENDER:   ["PACKAGE", "COMPOSE", "PLAN"],
  PACKAGE:  ["ITERATE", "COMPOSE", "PLAN"],
  ITERATE:  ["COMPOSE", "PLAN"],
});

function nowIso() {
  return new Date().toISOString();
}

function buildInitialSessionState({ project_id, target, derived_from }) {
  const id = assertSafeProjectId(project_id);
  const ts = nowIso();
  const state = {
    project_id: id,
    target: target == null ? null : target,
    phase: "INGEST",
    created_at: ts,
    last_updated: ts,
    history: [],
  };
  // Optional style lineage: when a project is started "--like" a prior one
  // (vob_init_project { derived_from }), stamp the source project_id so the
  // orchestrator can inherit its design — the source's intent answers, brief
  // tone, and composition look. Advisory only: no gate reads it, and it rides
  // through every transition because all state writes spread ...state. Omitted
  // entirely when not deriving, to keep a baseline state.json lean.
  if (derived_from != null) {
    state.style = { derived_from, applied_at: ts };
  }
  return state;
}

function initProject(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const target = args && args.target != null ? args.target : null;
  if (target !== null && (typeof target !== "object" || Array.isArray(target))) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "target must be an object if provided");
  }

  // Optional "--like <project>" style inheritance. Validate the source project
  // BEFORE creating the new one, so we never leave a new project pointing at a
  // source that doesn't exist. We only check the source's state.json existence
  // (a read); we never take the source's session lock.
  const derivedFrom = args && args.derived_from != null ? String(args.derived_from).trim() : null;
  if (derivedFrom) {
    const sourceId = assertSafeProjectId(derivedFrom);
    if (!fs.existsSync(statePath(sourceId))) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `cannot derive from '${sourceId}': no such project (state.json not found). Use an existing project_id to inherit its style.`,
      );
    }
  }

  return withSessionLock(id, () => {
    const dir = sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = statePath(id);
    if (fs.existsSync(file)) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `state.json already exists for project ${id} (already initialized)`,
      );
    }
    const state = buildInitialSessionState({ project_id: id, target, derived_from: derivedFrom });
    writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    return {
      created: true,
      project_id: id,
      session_dir: dir,
      phase: state.phase,
      style: state.style ? { derived_from: state.style.derived_from } : null,
    };
  });
}

function readSessionStateStrict(projectId) {
  const id = assertSafeProjectId(projectId);
  const file = statePath(id);
  if (!fs.existsSync(file)) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `state.json not found for project ${id}`);
  }
  let parsed;
  try {
    parsed = readJsonFile(file);
  } catch (error) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `malformed state.json for ${id}: ${error.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `malformed state.json for ${id}: expected object`);
  }
  // Normalize legacy phase names (BRIEF/STORYBOARD -> PLAN) from sessions
  // created before the PLAN-gate merge. Read-time only; the next mutating tool
  // persists the normalized phase. Done before the validity check so an old
  // session never trips the "invalid phase" guard.
  if (Object.prototype.hasOwnProperty.call(LEGACY_PHASE_ALIASES, parsed.phase)) {
    parsed.phase = LEGACY_PHASE_ALIASES[parsed.phase];
  }
  if (!PHASE_VALUES.includes(parsed.phase)) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `state.json for ${id} has invalid phase: ${parsed.phase}`);
  }
  return parsed;
}

// ---- read-time projections (disk untouched; every digest tolerates a legacy
// document: non-object slot -> null, missing inner field -> typed default) ----

function asSlot(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function strOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function intOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function numOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function arrOr(value) {
  return Array.isArray(value) ? value : [];
}

function readInspectSummaryIfPresent(projectId) {
  const file = inspectSummaryPath(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    return readJsonFile(file);
  } catch {
    return null;
  }
}

// Count digest of the transcoded_clips materialization document. The full
// document (per-clip detail) persists in state.transcoded_clips on disk.
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

// One entry per dependency preflight with ok === false. The full preflight
// blobs stay on disk for the renderToPackage gate and vob_doctor.
function dependencyFailuresDigest(dependencies) {
  const deps = asSlot(dependencies);
  if (!deps) return [];
  return Object.entries(deps)
    .filter(([, info]) => info && typeof info === "object" && info.ok === false)
    .map(([name, info]) => ({ name, error: typeof info.error === "string" ? info.error : null }));
}

function summarizeManifest(slot) {
  const m = asSlot(slot);
  if (!m) return null;
  return {
    path: strOrNull(m.path),
    source_path: strOrNull(m.source_path),
    file_count: intOr(m.file_count, 0),
    video_stream_count: intOr(m.video_stream_count, 0),
    total_duration_seconds: numOr(m.total_duration_seconds, null),
  };
}

function summarizeClassification(slot) {
  const c = asSlot(slot);
  if (!c) return null;
  return {
    aroll_count: intOr(c.aroll_count, 0),
    broll_count: intOr(c.broll_count, 0),
    review_count: intOr(c.review_count, 0),
    take_group_count: intOr(c.take_group_count, 0),
    best_take_count: intOr(c.best_take_count, 0),
    aroll_pool_path: strOrNull(c.aroll_pool_path),
    broll_index_path: strOrNull(c.broll_index_path),
    review_pool_path: strOrNull(c.review_pool_path != null ? c.review_pool_path : c.review_path),
    visual_coverage: asSlot(c.visual_coverage),
    hook_tagged_count: intOr(c.hook_tagged_count, null),
  };
}

function summarizeInspect(slot) {
  const i = asSlot(slot);
  if (!i) return null;
  return {
    summary_path: strOrNull(i.summary_path),
    thumbs_dir: strOrNull(i.thumbs_dir),
    thumb_count: intOr(i.thumb_count, 0),
    thumb_interval_seconds: numOr(i.thumb_interval_seconds, 0),
    sample_thumb_paths: arrOr(i.sample_thumb_paths),
    contact_sheet_paths: arrOr(i.contact_sheet_paths),
    audio_present: i.audio_present === true,
    speech_detected: i.speech_detected === true,
    word_count: intOr(i.word_count, 0),
    paragraph_count: intOr(i.paragraph_count, 0),
    transcript_path: strOrNull(i.transcript_path),
    transcript_summary_path: strOrNull(i.transcript_summary_path),
    transcript_paragraphs_path: strOrNull(i.transcript_paragraphs_path),
    segments_path: strOrNull(i.segments_path),
    segment_count: intOr(i.segment_count, 0),
    clean_speech_path: strOrNull(i.clean_speech_path),
    digest_path: strOrNull(i.digest_path),
    strips_legend_path: strOrNull(i.strips_legend_path),
    strip_count: intOr(i.strip_count, 0),
    transcripts: arrOr(i.transcripts),
    hook_candidate_count: intOr(i.hook_candidate_count, 0),
    classification: summarizeClassification(i.classification),
    user_acknowledged: i.user_acknowledged === true,
    skipped_reason: strOrNull(i.skipped_reason),
  };
}

// Intent answers ride through verbatim with ONE projection: an object-shaped
// (v2 canonicalized) target_platform loses its stored profile snapshot —
// {raw, canonical} is what the orchestrator displays; the summary's `platform`
// field carries the geometry.
function summarizeIntentAnswers(answers) {
  const a = asSlot(answers);
  if (!a) return {};
  const out = { ...a };
  const platform = asSlot(a.target_platform);
  if (platform && typeof platform.raw === "string") {
    out.target_platform = { raw: platform.raw, canonical: strOrNull(platform.canonical) };
  }
  return out;
}

function summarizePlatform(answers) {
  const a = asSlot(answers);
  const platform = a ? asSlot(a.target_platform) : null;
  const profile = platform ? asSlot(platform.profile) : null;
  if (!profile) return null;
  return {
    canonical: strOrNull(platform.canonical),
    width: intOr(profile.width, 0),
    height: intOr(profile.height, 0),
    fps: intOr(profile.fps, 0),
    safe_top_px: intOr(profile.safe_top_px, 0),
    safe_bottom_px: intOr(profile.safe_bottom_px, 0),
    ideal_duration_s: asSlot(profile.ideal_duration_s),
    max_duration_s: numOr(profile.max_duration_s, null),
    caption_defaults: asSlot(profile.caption_defaults),
  };
}

function summarizeTargetDurationSeconds(answers) {
  const a = asSlot(answers);
  const duration = a ? asSlot(a.target_duration) : null;
  return duration && Number.isFinite(duration.seconds) ? duration.seconds : null;
}

function summarizeBrief(slot) {
  const b = asSlot(slot);
  if (!b) return null;
  return {
    path: strOrNull(b.path),
    saved_at: strOrNull(b.saved_at),
    confirmed: b.confirmed === true,
    confirmed_at: strOrNull(b.confirmed_at),
  };
}

function summarizeStoryboard(slot) {
  const s = asSlot(slot);
  if (!s) return null;
  const planLint = asSlot(s.plan_lint);
  return {
    artifact_path: strOrNull(s.artifact_path),
    markdown_path: strOrNull(s.markdown_path),
    saved_at: strOrNull(s.saved_at),
    confirmed: s.confirmed === true,
    confirmed_at: strOrNull(s.confirmed_at),
    revision_count: intOr(s.revision_count, 0),
    scene_count: intOr(s.scene_count, null),
    total_duration_seconds: numOr(s.total_duration_seconds, null),
    plan_lint: planLint
      ? { error_count: intOr(planLint.error_count, 0), warning_count: intOr(planLint.warning_count, 0) }
      : null,
  };
}

function summarizeComposition(slot) {
  const c = asSlot(slot);
  if (!c) return null;
  return {
    files: arrOr(c.files),
    saved_at: strOrNull(c.saved_at),
    lint_status: strOrNull(c.lint_status),
    lint_report_path: strOrNull(c.lint_report_path),
    lint_ran_at: strOrNull(c.lint_ran_at),
    revision_count: intOr(c.revision_count, 0),
  };
}

function summarizePreview(slot) {
  const p = asSlot(slot);
  if (!p) return null;
  return {
    render_path: strOrNull(p.render_path),
    rendered_at: strOrNull(p.rendered_at),
    render_duration_seconds: numOr(p.render_duration_seconds, 0),
    confirmed: p.confirmed === true,
    confirmed_at: strOrNull(p.confirmed_at),
    revision_count: intOr(p.revision_count, 0),
    composition_revision_rendered: intOr(p.composition_revision_rendered, null),
  };
}

function summarizeRender(slot) {
  const r = asSlot(slot);
  if (!r) return null;
  return {
    mp4_path: strOrNull(r.mp4_path),
    rendered_at: strOrNull(r.rendered_at),
    render_duration_seconds: numOr(r.render_duration_seconds, 0),
    file_size_bytes: intOr(r.file_size_bytes, null),
    stderr_log_path: strOrNull(r.stderr_log_path),
    confirmed: r.confirmed === true,
    confirmed_at: strOrNull(r.confirmed_at),
    revision_count: intOr(r.revision_count, 0),
    composition_revision_rendered: intOr(r.composition_revision_rendered, null),
  };
}

function summarizePackage(slot) {
  const p = asSlot(slot);
  if (!p) return null;
  return {
    directory_path: strOrNull(p.directory_path),
    final_mp4_path: strOrNull(p.final_mp4_path),
    thumbnail_path: strOrNull(p.thumbnail_path),
    manifest_path: strOrNull(p.manifest_path),
    readme_path: strOrNull(p.readme_path),
    packaged_at: strOrNull(p.packaged_at),
    iteration_version: intOr(p.iteration_version, 0),
  };
}

// The orchestrator's working view (D1): a per-slot digest (~1 KB) covering
// every routine phase decision without a full state read.
function buildStateSummary(state, projectId) {
  const iteration = asSlot(state.iteration);
  const intentSlot = asSlot(state.intent);
  const answers = intentSlot ? intentSlot.answers : null;
  const transcoded = asSlot(state.transcoded_clips);
  const style = asSlot(state.style);
  return {
    project_id: state.project_id,
    phase: state.phase,
    target: state.target == null ? null : state.target,
    last_updated: state.last_updated,
    iteration_version: currentIterationVersion(state),
    archived_version_count: iteration ? arrOr(iteration.archive).length : 0,
    finalized_version: iteration ? intOr(iteration.finalized_version, null) : null,
    style: style && style.derived_from != null ? { derived_from: style.derived_from } : null,
    external_import: state.external_import === true,
    deliverable_count: arrOr(state.deliverables).length,
    history_count: arrOr(state.history).length,
    dependency_failures: dependencyFailuresDigest(state.dependencies),
    manifest: summarizeManifest(state.manifest),
    inspect: summarizeInspect(state.inspect),
    intent: intentSlot
      ? {
          answers: summarizeIntentAnswers(answers),
          missing_required_keys: missingIntentKeys(asSlot(answers) || {}, readInspectSummaryIfPresent(projectId)),
        }
      : null,
    platform: summarizePlatform(answers),
    target_duration_seconds: summarizeTargetDurationSeconds(answers),
    brief: summarizeBrief(state.brief),
    storyboard: summarizeStoryboard(state.storyboard),
    clips: transcoded
      ? { generated_at: strOrNull(transcoded.generated_at), ...clipsDigest(projectId, transcoded) }
      : null,
    composition: summarizeComposition(state.composition),
    preview: summarizePreview(state.preview),
    render: summarizeRender(state.render),
    package: summarizePackage(state.package),
  };
}

// Default projection drops the heavy sections (history, per-clip detail, full
// dependency blobs); `include` opts back in. Read-time only — disk untouched.
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
    out.transcoded_clips = clipsDigest(id, state.transcoded_clips);
  }
  if (!include.has("dependencies") && out.dependencies && typeof out.dependencies === "object") {
    out.dependencies = dependencyFailuresDigest(state.dependencies);
  }
  return out;
}

function readStateSummary(args) {
  const id = assertSafeProjectId(args && args.project_id);
  return buildStateSummary(readSessionStateStrict(id), id);
}

function readAudioTreatment(state) {
  const intent = state && state.intent;
  const answers = intent && typeof intent === "object" && !Array.isArray(intent) ? intent.answers : null;
  const value = answers && typeof answers === "object" ? answers.audio_treatment : null;
  return typeof value === "string" && value.trim() ? value : "keep_audio";
}

async function transitionPhase(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const toPhase = args && args.to_phase;
  const overrideReason = args && args.override_reason != null ? String(args.override_reason) : null;

  if (!PHASE_VALUES.includes(toPhase)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `unknown to_phase: ${toPhase}`);
  }

  // Hold the lock across validation, scene-clip materialization (when entering
  // COMPOSE), and the state commit. The session lock is exclusive and uncontended
  // during phase transitions — the orchestrator drives one transition at a time —
  // so blocking on ffmpeg work inside the lock is the simplest way to keep the
  // transition atomic. withSessionLock is async-aware: the lock is held until
  // the returned promise settles.
  return withSessionLock(id, async () => {
    const state = readSessionStateStrict(id);
    const from = state.phase;
    const allowed = ALLOWED_TRANSITIONS[from] || [];
    if (!allowed.includes(toPhase)) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `invalid phase transition ${from} -> ${toPhase}. allowed from ${from}: ${allowed.join(", ") || "(none)"}`,
      );
    }
    const gate = getGate(from, toPhase);
    if (!gate) {
      throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `no gate registered for ${from} -> ${toPhase}`);
    }
    const verdict = gate(state) || {};
    const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : [];
    if (verdict.allowed === false) {
      // Non-overridable blockers (human sign-off gates) refuse the transition
      // even WITH a reason, and even when overridable blockers coexist. The
      // throw precedes the state write, so a refused attempt leaves no trace
      // in history.
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

    // Pre-cut every storyboard scene to its own H.264 clip when entering COMPOSE
    // (forward edge from PLAN, or any back-edge from a downstream phase).
    // Sidecar caching makes back-edge re-entry a no-op when the storyboard hasn't
    // changed. Cutting before the state write means the user is never advanced
    // into COMPOSE with a half-prepared compose/source/ tree.
    let transcodedClips = null;
    if (toPhase === "COMPOSE") {
      transcodedClips = await materializeSceneClips({
        projectId: id,
        audioTreatment: readAudioTreatment(state),
      });
    }

    const ts = nowIso();
    // Versioned archival on back-edges out of {RENDER, PACKAGE, ITERATE} into
    // {COMPOSE, PLAN}. The user never loses prior iterations: the
    // current renders/ and package/ are moved into archive/v<N>/ before the
    // transition state is committed. Archival is a no-op (returns null) if
    // there's nothing to move.
    let archive = null;
    if (isArchivalTransition(from, toPhase)) {
      archive = archiveForIteration(state, { from, to: toPhase });
    }

    let next = {
      ...state,
      phase: toPhase,
      last_updated: ts,
    };
    if (archive) {
      next = archive.apply(next);
    }
    if (transcodedClips) {
      next.transcoded_clips = transcodedClips;
    }
    const archiveEvents = archive
      ? [{
          kind: "iteration_archived",
          at: ts,
          archive_version: archive.record.version,
          paths: archive.record.paths,
        }]
      : [];
    const clipEvents = transcodedClips
      ? [{
          kind: "scene_clips_materialized",
          at: ts,
          audio_treatment: transcodedClips.audio_treatment,
          summary: transcodedClips.summary,
        }]
      : [];
    next.history = [
      ...(Array.isArray(state.history) ? state.history : []),
      ...archiveEvents,
      ...clipEvents,
      {
        kind: "transition",
        from,
        to: toPhase,
        at: ts,
        override_reason: overrideReason,
        gate_blockers: blockers.length ? blockers : null,
      },
    ];
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
    // Lean return (D1): no full state echo, no duplicated transcoded_clips —
    // the full materialization document persists in next.transcoded_clips.
    return {
      project_id: id,
      from,
      to: toPhase,
      override_reason: overrideReason,
      archived: archive ? archive.record : null,
      clips: transcodedClips ? clipsDigest(id, transcodedClips) : null,
      phase_summary: buildStateSummary(next, id),
    };
  });
}

module.exports = {
  ALLOWED_TRANSITIONS,
  buildInitialSessionState,
  buildStateSummary,
  initProject,
  readInspectSummaryIfPresent,
  readSessionStateStrict,
  readState,
  readStateSummary,
  transitionPhase,
};
