"use strict";

const REQUIRED_INTENT_KEYS = Object.freeze([
  "target_platform",
  "target_duration",
  "tone",
  "key_moments",
  "music_vo",
]);

// Conditional keys are added to the required set when inspect findings warrant
// them. The orchestrator asks for them only when applicable; the gate enforces
// them only when applicable. See applicableConditionalKeys() for the rules.
const CONDITIONAL_INTENT_KEYS = Object.freeze([
  "audio_treatment",
  "captions_style",
]);

const AUDIO_TREATMENT_VALUES = Object.freeze([
  "transcribe_captions",
  "keep_audio",
  "discard_audio",
  "keep_ambient",
]);

const ALL_INTENT_KEYS = Object.freeze([
  ...REQUIRED_INTENT_KEYS,
  ...CONDITIONAL_INTENT_KEYS,
]);

const ALL_INTENT_KEY_SET = new Set(ALL_INTENT_KEYS);
const AUDIO_TREATMENT_SET = new Set(AUDIO_TREATMENT_VALUES);

function isValidIntentKey(key) {
  return typeof key === "string" && ALL_INTENT_KEY_SET.has(key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

// Given an inspect.json summary and the current answers map, return the list
// of CONDITIONAL keys that must be answered before INTENT can advance.
//
// Rules (initial):
//   - audio_present === true                       -> require audio_treatment
//   - speech_detected === true AND audio_treatment
//       in {keep_audio, transcribe_captions}       -> require captions_style
//
// If no inspect summary is supplied (e.g. legacy sessions), no conditional
// keys are required and behavior matches the pre-INSPECT schema.
function applicableConditionalKeys(inspectSummary, answers) {
  if (!isPlainObject(inspectSummary)) return [];
  const present = isPlainObject(answers) ? answers : {};
  const keys = [];
  if (inspectSummary.audio_present === true) {
    keys.push("audio_treatment");
  }
  const treatment = (intentAnswerRaw(present.audio_treatment) || "").trim();
  if (
    inspectSummary.speech_detected === true
    && (treatment === "keep_audio" || treatment === "transcribe_captions")
  ) {
    keys.push("captions_style");
  }
  return keys;
}

function missingIntentKeys(answers, inspectSummary = null) {
  const present = isPlainObject(answers) ? answers : {};
  const missing = [];
  for (const key of REQUIRED_INTENT_KEYS) {
    if (!intentAnswerPresent(present[key])) {
      missing.push(key);
    }
  }
  for (const key of applicableConditionalKeys(inspectSummary, present)) {
    if (!intentAnswerPresent(present[key])) {
      missing.push(key);
    }
  }
  return missing;
}

// Validate a single (key, trimmed-value) pair. Returns { ok: true } or
// { ok: false, message }. Free-form keys (everything except audio_treatment)
// pass through; audio_treatment is constrained to AUDIO_TREATMENT_VALUES so
// downstream validators (brief-validator, storyboard content gate) can rely
// on the canonical token.
function validateIntentAnswerValue(key, value) {
  if (key === "audio_treatment" && !AUDIO_TREATMENT_SET.has(value)) {
    return {
      ok: false,
      message: `audio_treatment must be one of: ${AUDIO_TREATMENT_VALUES.join(", ")}`,
    };
  }
  return { ok: true };
}

module.exports = {
  ALL_INTENT_KEYS,
  AUDIO_TREATMENT_VALUES,
  CONDITIONAL_INTENT_KEYS,
  REQUIRED_INTENT_KEYS,
  applicableConditionalKeys,
  intentAnswerPresent,
  intentAnswerRaw,
  isValidIntentKey,
  missingIntentKeys,
  validateIntentAnswerValue,
};
