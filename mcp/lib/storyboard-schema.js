"use strict";

const SCHEMA_VERSION = "1.0";
const PURPOSES = Object.freeze(["hook", "beat", "payoff", "outro"]);
const PACINGS = Object.freeze(["fast", "medium", "slow"]);
// Clip role: how the composer should treat a source clip.
//   a_roll  — spine footage; carries the narrative (audio kept per intent), visible base track.
//   b_roll  — coverage/cutaway; materialized MUTED and laid as video over the spine on a higher track.
//   overlay — graphic/text element with no source video of its own.
// Optional + backward-compatible: a clip with no `role` is treated as a_roll.
const CLIP_ROLES = Object.freeze(["a_roll", "b_roll", "overlay"]);

const PURPOSE_SET = new Set(PURPOSES);
const PACING_SET = new Set(PACINGS);
const CLIP_ROLE_SET = new Set(CLIP_ROLES);

function clipRoleOf(clip) {
  return clip && typeof clip.role === "string" && clip.role.trim() ? clip.role : "a_roll";
}

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
  if (clip.role !== undefined && clip.role !== null && !CLIP_ROLE_SET.has(clip.role)) {
    errors.push(`${where}.role must be one of: ${CLIP_ROLES.join(", ")} (omit for default a_roll)`);
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

// Optional top-level broll_placements[]: the storyboarder's explicit record of
// where each B-roll cutaway sits over the A-roll/narration spine. ADVISORY — the
// clips themselves live in scenes[].source_clips with role:"b_roll" (and are
// materialized + symlinked by the normal machinery); a placement only references
// one of those existing clips by {scene_id, clip_index}, so there is no separate
// materialization path and no way to dangle into a 404 at render. Backward-compat:
// absent/empty broll_placements is fine.
function buildSceneClipIndex(scenes) {
  const index = new Map();
  if (!Array.isArray(scenes)) return index;
  scenes.forEach((scene) => {
    if (!isPlainObject(scene) || !isNonEmptyString(scene.scene_id)) return;
    const clips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
    index.set(scene.scene_id, clips);
  });
  return index;
}

function validateBrollPlacements(input, errors) {
  if (input.broll_placements === undefined || input.broll_placements === null) return;
  if (!Array.isArray(input.broll_placements)) {
    errors.push("broll_placements must be an array when present");
    return;
  }
  const sceneClips = buildSceneClipIndex(input.scenes);
  input.broll_placements.forEach((p, ix) => {
    const where = `broll_placements[${ix}]`;
    if (!isPlainObject(p)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!isPlainObject(p.clip)) {
      errors.push(`${where}.clip must be an object { scene_id, clip_index }`);
    } else {
      if (!isNonEmptyString(p.clip.scene_id)) {
        errors.push(`${where}.clip.scene_id must be a non-empty string`);
      } else if (!sceneClips.has(p.clip.scene_id)) {
        errors.push(`${where}.clip.scene_id "${p.clip.scene_id}" does not match any scene`);
      } else if (!Number.isInteger(p.clip.clip_index) || p.clip.clip_index < 0) {
        errors.push(`${where}.clip.clip_index must be a non-negative integer`);
      } else if (p.clip.clip_index >= sceneClips.get(p.clip.scene_id).length) {
        errors.push(`${where}.clip.clip_index ${p.clip.clip_index} is out of range for scene "${p.clip.scene_id}" (has ${sceneClips.get(p.clip.scene_id).length} source_clips)`);
      }
    }
    if (p.narration_span !== undefined && p.narration_span !== null) {
      const ns = p.narration_span;
      if (!isPlainObject(ns) || !isFiniteNumber(ns.start_seconds) || !isFiniteNumber(ns.end_seconds) || ns.start_seconds < 0 || ns.end_seconds <= ns.start_seconds) {
        errors.push(`${where}.narration_span must be { start_seconds, end_seconds } with end > start >= 0 when present`);
      }
    }
    if (p.insert_at_seconds !== undefined && p.insert_at_seconds !== null && (!isFiniteNumber(p.insert_at_seconds) || p.insert_at_seconds < 0)) {
      errors.push(`${where}.insert_at_seconds must be a non-negative finite number when present`);
    }
    if (p.transition !== undefined && p.transition !== null && typeof p.transition !== "string") {
      errors.push(`${where}.transition must be a string when present`);
    }
    if (p.reason !== undefined && p.reason !== null && typeof p.reason !== "string") {
      errors.push(`${where}.reason must be a string when present`);
    }
  });
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
  validateBrollPlacements(input, errors);

  return { ok: errors.length === 0, errors };
}

// Content-level validation — runs AFTER validateStoryboard succeeds. Where
// validateStoryboard checks JSON shape, this checks that the storyboard's
// content claims are consistent with observable source facts (e.g. the
// transcript from INSPECT). Failures surface as actionable error codes.
function loadTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  const fs = require("fs");
  if (!fs.existsSync(transcriptPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry) => entry && isFiniteNumber(entry.start) && isFiniteNumber(entry.end));
  } catch {
    return null;
  }
}

function transcriptOverlapsClip(transcript, inSeconds, outSeconds) {
  for (const entry of transcript) {
    // any overlap between [entry.start, entry.end] and [in, out]
    if (entry.end > inSeconds && entry.start < outSeconds) return true;
  }
  return false;
}

function clipHasSpokenWords(scene, transcript) {
  if (!Array.isArray(scene.source_clips) || scene.source_clips.length === 0) {
    return false;
  }
  return scene.source_clips.some((clip) => {
    return clip
      && isFiniteNumber(clip.in_seconds)
      && isFiniteNumber(clip.out_seconds)
      && transcriptOverlapsClip(transcript, clip.in_seconds, clip.out_seconds);
  });
}

function sceneHasCaptions(scene) {
  return typeof scene.captions === "string" && scene.captions.trim() !== "";
}

function validateStoryboardContent(parsed, state) {
  const errors = [];
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["storyboard must be a JSON object"] };
  }

  // Captions vs transcript: if a transcript exists, every captioned scene
  // whose source_clips reference source windows must overlap at least one
  // transcript word. A captioned scene that pulls from a silent stretch of
  // the source is the "captions don't reflect what the source actually says"
  // failure mode.
  const transcriptPath = state && state.inspect && state.inspect.transcript_path;
  if (transcriptPath) {
    const transcript = loadTranscript(transcriptPath);
    if (Array.isArray(transcript) && transcript.length > 0 && Array.isArray(parsed.scenes)) {
      parsed.scenes.forEach((scene, ix) => {
        if (!sceneHasCaptions(scene)) return;
        if (!Array.isArray(scene.source_clips) || scene.source_clips.length === 0) return;
        if (!clipHasSpokenWords(scene, transcript)) {
          errors.push({
            code: "STORYBOARD_CAPTIONS_ON_SILENT_SEGMENT",
            message: `scenes[${ix}] has captions but none of its source_clips overlap any transcript word — captions would be unsupported by source speech`,
            scene_index: ix,
            scene_id: scene.scene_id || null,
            captions_preview: typeof scene.captions === "string" ? scene.captions.slice(0, 100) : null,
          });
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  PURPOSES,
  PACINGS,
  CLIP_ROLES,
  clipRoleOf,
  validateStoryboard,
  validateStoryboardContent,
};
