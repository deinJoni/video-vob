"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const {
  REQUIRED_INTENT_KEYS,
  isValidIntentKey,
  missingIntentKeys,
} = require("../intent-schema.js");

const MAX_ANSWER_LENGTH = 4096;

function nowIso() {
  return new Date().toISOString();
}

function validateAnswer(key, rawValue) {
  if (!isValidIntentKey(key)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `unknown intent key: ${key}. valid keys: ${REQUIRED_INTENT_KEYS.join(", ")}`,
    );
  }
  if (typeof rawValue !== "string") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "value must be a string");
  }
  const trimmed = rawValue.trim();
  if (trimmed === "") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "value must be a non-empty string");
  }
  if (trimmed.length > MAX_ANSWER_LENGTH) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `value exceeds ${MAX_ANSWER_LENGTH} character limit`,
    );
  }
  return trimmed;
}

function recordIntentAnswer(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const key = args && args.key;
  const value = validateAnswer(key, args && args.value);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const prevIntent = state.intent && typeof state.intent === "object" && !Array.isArray(state.intent)
      ? state.intent
      : null;
    const prevAnswers = prevIntent && typeof prevIntent.answers === "object" && !Array.isArray(prevIntent.answers)
      ? prevIntent.answers
      : {};

    const ts = nowIso();
    const nextAnswers = { ...prevAnswers, [key]: value };
    const next = {
      ...state,
      intent: {
        ...(prevIntent || {}),
        answers: nextAnswers,
        last_updated: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "intent_answer_recorded", key, at: ts },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      answers: nextAnswers,
      missing_required_keys: missingIntentKeys(nextAnswers),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_record_intent_answer",
  description: "Record a single intent answer (one of the five required INTENT keys: target_platform, target_duration, tone, key_moments, music_vo). Overwrites any previous value for the same key. Returns the current answers map and which required keys are still missing.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      key: { type: "string", enum: [...REQUIRED_INTENT_KEYS] },
      value: { type: "string", minLength: 1, maxLength: MAX_ANSWER_LENGTH },
    },
    required: ["project_id", "key", "value"],
  },
  handler: recordIntentAnswer,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["state.json"],
  hook_required: false,
});
