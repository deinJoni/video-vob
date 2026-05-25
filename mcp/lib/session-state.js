"use strict";

const fs = require("fs");
const { PHASE_VALUES } = require("./constants.js");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { sessionDir, statePath, assertSafeProjectId } = require("./paths.js");
const { withSessionLock, writeFileAtomic, readJsonFile } = require("./storage.js");
const { getGate } = require("./phase-gates.js");

const ALLOWED_TRANSITIONS = Object.freeze({
  INGEST:     ["INTENT"],
  INTENT:     ["BRIEF"],
  BRIEF:      ["STORYBOARD", "INTENT"],
  STORYBOARD: ["COMPOSE", "BRIEF"],
  COMPOSE:    ["PREVIEW", "STORYBOARD"],
  PREVIEW:    ["RENDER", "COMPOSE", "STORYBOARD"],
  RENDER:     ["PACKAGE"],
  PACKAGE:    ["ITERATE"],
  ITERATE:    ["COMPOSE", "STORYBOARD"],
});

function nowIso() {
  return new Date().toISOString();
}

function buildInitialSessionState({ project_id, target }) {
  const id = assertSafeProjectId(project_id);
  const ts = nowIso();
  return {
    project_id: id,
    target: target == null ? null : target,
    phase: "INGEST",
    created_at: ts,
    last_updated: ts,
    history: [],
  };
}

function initProject(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const target = args && args.target != null ? args.target : null;
  if (target !== null && (typeof target !== "object" || Array.isArray(target))) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "target must be an object if provided");
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
    const state = buildInitialSessionState({ project_id: id, target });
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

function transitionPhase(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const toPhase = args && args.to_phase;
  const overrideReason = args && args.override_reason != null ? String(args.override_reason) : null;

  if (!PHASE_VALUES.includes(toPhase)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `unknown to_phase: ${toPhase}`);
  }

  return withSessionLock(id, () => {
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

    const ts = nowIso();
    const next = {
      ...state,
      phase: toPhase,
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "transition",
          from,
          to: toPhase,
          at: ts,
          override_reason: overrideReason,
          gate_blockers: verdict.blockers && verdict.blockers.length ? verdict.blockers : null,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
    return {
      project_id: id,
      from,
      to: toPhase,
      override_reason: overrideReason,
      state: next,
    };
  });
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
