"use strict";

const fs = require("fs");
const { PHASE_VALUES, LEGACY_PHASE_ALIASES } = require("./constants.js");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { sessionDir, statePath, assertSafeProjectId } = require("./paths.js");
const { acquireSessionLock, withSessionLock, writeFileAtomic, readJsonFile } = require("./storage.js");
const { getGate } = require("./phase-gates.js");
const { archiveForIteration, isArchivalTransition } = require("./archival.js");
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
      session_dir: dir,
      state,
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

function readState(args) {
  return readSessionStateStrict(args && args.project_id);
}

function readStateSummary(args) {
  const state = readSessionStateStrict(args && args.project_id);
  return {
    project_id: state.project_id,
    phase: state.phase,
    target: state.target == null ? null : state.target,
    last_updated: state.last_updated,
  };
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
  // transition atomic. `withSessionLock` does not await async callbacks; we use
  // `acquireSessionLock` + try/finally directly so the lock is held until the
  // async work resolves.
  const release = acquireSessionLock(id);
  try {
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
    if (verdict.allowed === false && !overrideReason) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `gate blocked ${from} -> ${toPhase}: ${(verdict.blockers || []).map((b) => b.message || b.code || String(b)).join("; ") || "no detail"}`,
        { blockers: verdict.blockers || [] },
      );
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
        gate_blockers: verdict.blockers && verdict.blockers.length ? verdict.blockers : null,
      },
    ];
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
    return {
      project_id: id,
      from,
      to: toPhase,
      override_reason: overrideReason,
      archived: archive ? archive.record : null,
      transcoded_clips: transcodedClips,
      state: next,
    };
  } finally {
    release();
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  buildInitialSessionState,
  initProject,
  readSessionStateStrict,
  readState,
  readStateSummary,
  transitionPhase,
};
