"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readInspectSummaryIfPresent, readSessionStateStrict } = require("../session-state.js");
const {
  ALL_INTENT_KEYS,
  isValidIntentKey,
  missingIntentKeys,
  validateIntentAnswerValue,
} = require("../intent-schema.js");
const { parseDurationSpec, resolvePlatform } = require("../platform-profiles.js");
const { canonicalizeVideoType, getVideoTypePreset } = require("../video-types.js");

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

// Canonicalize at record time (D3): the stored value is what downstream reads
// — the storyboarder/composer never re-parse free text. Unrecognized platform
// stores canonical:"vertical" (`raw` says what the user said; the profile says
// what will be built). Unparseable duration stores seconds:null, no error.
function canonicalizeAnswer(key, trimmed) {
  if (key === "target_platform") {
    const { raw, canonical, profile } = resolvePlatform(trimmed);
    return { raw, canonical, profile }; // profile snapshot stored for audit
  }
  if (key === "target_duration") {
    // Range and per-deliverable forms ("20–35s per short") canonicalize to
    // extra keys; plain durations keep the lean {raw,seconds} shape.
    const spec = parseDurationSpec(trimmed);
    return {
      raw: trimmed,
      seconds: spec.seconds,
      ...(spec.range ? { range: spec.range } : {}),
      ...(spec.per_deliverable ? { per_deliverable: true } : {}),
    };
  }
  if (key === "video_type") {
    // Preset selection. Unrecognized input stores canonical:null so the
    // resolver falls through to platform+duration derivation instead of
    // pinning a wrong preset; recognized input snapshots the preset for audit.
    const { raw, canonical } = canonicalizeVideoType(trimmed);
    return {
      raw,
      canonical,
      ...(canonical ? { preset: getVideoTypePreset(canonical) } : {}),
    };
  }
  return trimmed; // all other keys stay plain strings
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
    // Overwrite-by-key; re-recording a legacy string key upgrades it to the
    // canonical object shape (the migration path — no bulk rewrite).
    const nextAnswers = { ...prevAnswers, [key]: canonicalizeAnswer(key, value) };
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
      recorded: { key, value: nextAnswers[key] },
      missing_required_keys: missingIntentKeys(nextAnswers, inspectSummary),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_record_intent_answer",
  description: "Record one intent answer (overwrites the key). Five required keys: target_platform, target_duration, tone, key_moments, music_vo; conditional keys (audio_treatment, captions_style) per inspect findings; optional keys (never required, never gate): video_type (preset: social-short | long-form | cinematic | tutorial | podcast | a user-defined preset — unanswered, the engine derives it from platform+duration), design_language (confirmed look — fonts/palette/caption shape/motion — binds the brief Design language section), pacing_intent (fast|medium|slow + cut density — the storyboarder's scene-duration target), hook_intent (which opening moment to lead on), broll_intent (b-roll coverage appetite — minimal|illustrative|dynamic|A-roll-only — the storyboarder's cutaway-density target). audio_treatment enum: transcribe_captions | keep_audio | discard_audio | keep_ambient. target_platform/target_duration/video_type are canonicalized server-side ({raw,canonical,profile} / {raw,seconds,range?,per_deliverable?} / {raw,canonical,preset?} — ranges like '20-35s' carry {min_seconds,max_seconds} with seconds = midpoint; 'per short'-style qualifiers set per_deliverable:true); design_language/pacing_intent/hook_intent/broll_intent stay plain free-text. Returns {recorded, missing_required_keys}.",
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
