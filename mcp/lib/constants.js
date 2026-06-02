"use strict";

const PHASE_VALUES = Object.freeze([
  "INGEST",
  "INSPECT",
  "INTENT",
  "PLAN",
  "COMPOSE",
  "PREVIEW",
  "RENDER",
  "PACKAGE",
  "ITERATE",
]);

// Legacy phase names that collapsed into a single phase. Sessions created before
// the BRIEF+STORYBOARD -> PLAN merge carry these in state.json; they are
// normalized to their successor on read (see readSessionStateStrict). This is a
// read-time shim only — old state.json files are not rewritten until the next
// state-mutating tool runs.
const LEGACY_PHASE_ALIASES = Object.freeze({
  BRIEF: "PLAN",
  STORYBOARD: "PLAN",
});

const SESSION_LOCK_NAME = ".session.lock";
const SESSION_LOCK_STALE_MS = 5 * 60 * 1000;

module.exports = {
  PHASE_VALUES,
  LEGACY_PHASE_ALIASES,
  SESSION_LOCK_NAME,
  SESSION_LOCK_STALE_MS,
};
