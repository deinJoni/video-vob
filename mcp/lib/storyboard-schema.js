"use strict";

const SCHEMA_VERSION = "1.0";
const PURPOSES = Object.freeze(["hook", "beat", "payoff", "outro"]);
const PACINGS = Object.freeze(["fast", "medium", "slow"]);

const PURPOSE_SET = new Set(PURPOSES);
const PACING_SET = new Set(PACINGS);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateClip(clip, sceneIx, clipIx, errors) {
  const where = `scenes[${sceneIx}].source_clips[${clipIx}]`;
  if (!isPlainObject(clip)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (!Number.isInteger(clip.manifest_file_index) || clip.manifest_file_index < 0) {
    errors.push(`${where}.manifest_file_index must be a non-negative integer`);
  }
  if (!isNonEmptyString(clip.source_path)) {
    errors.push(`${where}.source_path must be a non-empty string`);
  }
  const inS = clip.in_seconds;
  const outS = clip.out_seconds;
  if (!isFiniteNumber(inS) || inS < 0) {
    errors.push(`${where}.in_seconds must be a non-negative finite number`);
  }
  if (!isFiniteNumber(outS) || outS < 0) {
    errors.push(`${where}.out_seconds must be a non-negative finite number`);
  }
  if (isFiniteNumber(inS) && isFiniteNumber(outS) && outS <= inS) {
    errors.push(`${where}.out_seconds must be greater than in_seconds`);
  }
  if (clip.note !== undefined && clip.note !== null && typeof clip.note !== "string") {
    errors.push(`${where}.note must be a string when present`);
  }
}

function validateScene(scene, ix, errors) {
  const where = `scenes[${ix}]`;
  if (!isPlainObject(scene)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (!isNonEmptyString(scene.scene_id)) {
    errors.push(`${where}.scene_id must be a non-empty string`);
  }
  if (!Number.isInteger(scene.sequence) || scene.sequence !== ix + 1) {
    errors.push(`${where}.sequence must equal ${ix + 1} (1-based, monotonically increasing)`);
  }
  if (!PURPOSE_SET.has(scene.purpose)) {
    errors.push(`${where}.purpose must be one of: ${PURPOSES.join(", ")}`);
  }
  if (!isFiniteNumber(scene.target_duration_seconds) || scene.target_duration_seconds <= 0) {
    errors.push(`${where}.target_duration_seconds must be a positive finite number`);
  }
  if (!isNonEmptyString(scene.summary)) {
    errors.push(`${where}.summary must be a non-empty string`);
  }
  if (!Array.isArray(scene.source_clips)) {
    errors.push(`${where}.source_clips must be an array (may be empty for overlay-only scenes)`);
  } else {
    scene.source_clips.forEach((clip, clipIx) => validateClip(clip, ix, clipIx, errors));
  }
  if (!Array.isArray(scene.overlays)) {
    errors.push(`${where}.overlays must be an array of strings (may be empty)`);
  } else {
    scene.overlays.forEach((entry, entryIx) => {
      if (typeof entry !== "string") {
        errors.push(`${where}.overlays[${entryIx}] must be a string`);
      }
    });
  }
  if (scene.captions !== null && scene.captions !== undefined && typeof scene.captions !== "string") {
    errors.push(`${where}.captions must be a string or null`);
  }
  if (!PACING_SET.has(scene.pacing)) {
    errors.push(`${where}.pacing must be one of: ${PACINGS.join(", ")}`);
  }
  if (scene.notes !== undefined && scene.notes !== null && typeof scene.notes !== "string") {
    errors.push(`${where}.notes must be a string when present`);
  }
}

function validateStoryboard(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["storyboard must be a JSON object"] };
  }
  if (input.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be "${SCHEMA_VERSION}"`);
  }
  if (!isNonEmptyString(input.project_id)) {
    errors.push("project_id must be a non-empty string");
  }
  if (!isNonEmptyString(input.generated_at)) {
    errors.push("generated_at must be a non-empty ISO 8601 string");
  }
  if (!isPlainObject(input.source)) {
    errors.push("source must be an object with manifest_path and brief_path");
  } else {
    if (!isNonEmptyString(input.source.manifest_path)) {
      errors.push("source.manifest_path must be a non-empty string");
    }
    if (!isNonEmptyString(input.source.brief_path)) {
      errors.push("source.brief_path must be a non-empty string");
    }
  }
  if (!isPlainObject(input.target)) {
    errors.push("target must be an object with platform, duration_seconds, tone");
  } else {
    if (!isNonEmptyString(input.target.platform)) {
      errors.push("target.platform must be a non-empty string");
    }
    if (!isFiniteNumber(input.target.duration_seconds) || input.target.duration_seconds <= 0) {
      errors.push("target.duration_seconds must be a positive finite number");
    }
    if (!isNonEmptyString(input.target.tone)) {
      errors.push("target.tone must be a non-empty string");
    }
  }
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    errors.push("scenes must be a non-empty array");
  } else {
    input.scenes.forEach((scene, ix) => validateScene(scene, ix, errors));
  }
  if (!isFiniteNumber(input.total_target_duration_seconds) || input.total_target_duration_seconds <= 0) {
    errors.push("total_target_duration_seconds must be a positive finite number");
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== "string") {
    errors.push("notes must be a string when present");
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  PURPOSES,
  PACINGS,
  validateStoryboard,
};
