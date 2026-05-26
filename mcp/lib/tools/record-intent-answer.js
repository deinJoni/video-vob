"use strict";

const fs = require("fs");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, inspectSummaryPath, statePath } = require("../paths.js");
const { readJsonFile, withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const {
  ALL_INTENT_KEYS,
  isValidIntentKey,
  missingIntentKeys,
  validateIntentAnswerValue,
} = require("../intent-schema.js");

const MAX_ANSWER_LENGTH = 4096;

function nowIso() {
  return new Date().toISOString();
}

function validateAnswer(key, rawValue) {
  if (!isValidIntentKey(key)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `unknown intent key: ${key}. valid keys: ${ALL_INTENT_KEYS.join(", ")}`,
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
  const enumCheck = validateIntentAnswerValue(key, trimmed);
  if (!enumCheck.ok) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, enumCheck.message);
  }
  return trimmed;
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

    const inspectSummary = readInspectSummaryIfPresent(id);
    return {
      answers: nextAnswers,
      missing_required_keys: missingIntentKeys(nextAnswers, inspectSummary),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_record_intent_answer",
  description: "Record a single intent answer. Five required keys are always asked (target_platform, target_duration, tone, key_moments, music_vo). Additional conditional keys may be required based on inspect findings (audio_treatment when audio is present; captions_style when speech is detected and audio_treatment is keep_audio or transcribe_captions). audio_treatment must be one of: transcribe_captions, keep_audio, discard_audio, keep_ambient. Overwrites any previous value for the same key. Returns the current answers map and which keys are still missing given the current inspect state.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      key: { type: "string", enum: [...ALL_INTENT_KEYS] },
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
