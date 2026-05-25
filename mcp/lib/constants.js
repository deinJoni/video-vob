"use strict";

const PHASE_VALUES = Object.freeze([
  "INGEST",
  "INTENT",
  "BRIEF",
  "STORYBOARD",
  "COMPOSE",
  "PREVIEW",
  "RENDER",
  "PACKAGE",
  "ITERATE",
]);

const SESSION_LOCK_NAME = ".session.lock";
const SESSION_LOCK_STALE_MS = 5 * 60 * 1000;

module.exports = {
  PHASE_VALUES,
  SESSION_LOCK_NAME,
  SESSION_LOCK_STALE_MS,
};
