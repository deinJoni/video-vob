"use strict";

// Validation for the three INSPECT classification pools the `inspector`
// subagent produces from inspect/segments.json: the A-roll spine pool, the
// B-roll index, and the review bucket. Mirrors storyboard-schema.js in spirit —
// it checks SHAPE + required fields + that every segment reference points at a
// real detected segment (so the agent can't hallucinate segments), while
// staying permissive about extra descriptive fields the agent may add.

// 1.1 (v3.1 P3): richer visual tagging — adds OPTIONAL camera_movement/setting/
// content_tags/on_screen_text/action (shared), content_description/eyes_to_camera
// (A-roll), b_roll_role (B-roll), and a top-level file_roles[] map. Every
// addition is validated only-when-present, so a 1.0 payload (no new fields) still
// passes — back-compat is the contract, not a migration.
const SCHEMA_VERSION = "1.1";

// Structured visual fields (OPTIONAL on every pool entry; presence is enforced
// socially via the inspector prompt — requiring them server-side would break
// every pre-v2 payload mid-migration). shot_type "screen" = screen-recording/UI,
// "graphic" = title card/slide/chart; subject_position "none" = empty/abstract
// frame; framing_ok_for_vertical = a 9:16 center crop keeps subject + on-frame
// text fully visible.
const SHOT_TYPES = Object.freeze(["extreme_closeup", "closeup", "medium", "wide", "screen", "graphic", "other"]);
const SUBJECT_POSITIONS = Object.freeze(["left", "center", "right", "none"]);

// v3.1 P3 enums (all OPTIONAL). camera_movement/setting describe HOW and WHERE a
// shot was taken; b_roll_role is the editorial function of a coverage clip;
// file_roles[].role is the per-file map for multi-file drops (which file is the
// talking-head spine vs coverage vs voiceover).
const CAMERA_MOVEMENTS = Object.freeze(["static", "pan", "tilt", "handheld", "zoom", "drone", "other"]);
const SETTINGS = Object.freeze(["indoor", "outdoor", "studio", "screen", "graphic", "other"]);
const BROLL_ROLES = Object.freeze(["establishing", "detail", "illustrative", "action", "transition"]);
const FILE_ROLES = Object.freeze(["primary_aroll", "broll", "narration", "mixed"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isUnit(v) {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Build the set of valid "file_index:segment_index" keys + a duration lookup
// from the authoritative inspect/segments.json document.
function indexSegments(segmentsDoc) {
  const byKey = new Map();
  const files = segmentsDoc && Array.isArray(segmentsDoc.files) ? segmentsDoc.files : [];
  for (const f of files) {
    const fi = f && Number.isInteger(f.file_index) ? f.file_index : null;
    const segs = f && Array.isArray(f.segments) ? f.segments : [];
    for (const s of segs) {
      if (fi == null || !Number.isInteger(s.index)) continue;
      byKey.set(`${fi}:${s.index}`, s);
    }
  }
  return byKey;
}

// Validate one segment-referencing entry shared by all three pools: it must name
// a real detected segment via { file_index, segment_index } and carry valid
// timecodes + confidence. `where` is a path label for error messages.
function validateRef(entry, where, segIndex, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  if (!Number.isInteger(entry.file_index) || entry.file_index < 0) {
    errors.push(`${where}.file_index must be a non-negative integer`);
  }
  if (!Number.isInteger(entry.segment_index) || entry.segment_index < 0) {
    errors.push(`${where}.segment_index must be a non-negative integer`);
  }
  if (!isFiniteNumber(entry.start_seconds) || entry.start_seconds < 0) {
    errors.push(`${where}.start_seconds must be a non-negative finite number`);
  }
  if (!isFiniteNumber(entry.end_seconds) || entry.end_seconds <= entry.start_seconds) {
    errors.push(`${where}.end_seconds must be a finite number greater than start_seconds`);
  }
  if (entry.confidence !== undefined && !isUnit(entry.confidence)) {
    errors.push(`${where}.confidence must be a number in [0,1] when present`);
  }
  if (entry.shot_type !== undefined && !SHOT_TYPES.includes(entry.shot_type)) {
    errors.push(`${where}.shot_type must be one of ${SHOT_TYPES.join("|")} when present`);
  }
  if (entry.subject_position !== undefined && !SUBJECT_POSITIONS.includes(entry.subject_position)) {
    errors.push(`${where}.subject_position must be one of ${SUBJECT_POSITIONS.join("|")} when present`);
  }
  if (entry.framing_ok_for_vertical !== undefined && typeof entry.framing_ok_for_vertical !== "boolean") {
    errors.push(`${where}.framing_ok_for_vertical must be a boolean when present`);
  }
  // v3.1 P3 shared visual fields (all optional; on both A-roll and B-roll).
  if (entry.camera_movement !== undefined && !CAMERA_MOVEMENTS.includes(entry.camera_movement)) {
    errors.push(`${where}.camera_movement must be one of ${CAMERA_MOVEMENTS.join("|")} when present`);
  }
  if (entry.setting !== undefined && !SETTINGS.includes(entry.setting)) {
    errors.push(`${where}.setting must be one of ${SETTINGS.join("|")} when present`);
  }
  if (entry.content_tags !== undefined && !isStringArray(entry.content_tags)) {
    errors.push(`${where}.content_tags must be an array of strings when present`);
  }
  if (entry.on_screen_text !== undefined && typeof entry.on_screen_text !== "string") {
    errors.push(`${where}.on_screen_text must be a string when present`);
  }
  if (entry.action !== undefined && typeof entry.action !== "string") {
    errors.push(`${where}.action must be a string when present`);
  }
  // Cross-reference against the detected segments, if available.
  if (segIndex && Number.isInteger(entry.file_index) && Number.isInteger(entry.segment_index)) {
    const key = `${entry.file_index}:${entry.segment_index}`;
    if (!segIndex.has(key)) {
      errors.push(`${where} references segment ${key} which is not in inspect/segments.json`);
    }
  }
  return entry;
}

function validateArollPool(pool, segIndex, errors) {
  if (!isPlainObject(pool)) {
    errors.push("aroll_pool must be an object");
    return;
  }
  if (!Array.isArray(pool.segments)) {
    errors.push("aroll_pool.segments must be an array");
  } else {
    pool.segments.forEach((seg, i) => {
      const where = `aroll_pool.segments[${i}]`;
      validateRef(seg, where, segIndex, errors);
      if (seg && seg.transcript_span !== undefined && typeof seg.transcript_span !== "string") {
        errors.push(`${where}.transcript_span must be a string when present`);
      }
      if (seg && seg.tags !== undefined && !isStringArray(seg.tags)) {
        errors.push(`${where}.tags must be an array of strings when present`);
      }
      if (seg && seg.take_group !== undefined && seg.take_group !== null && !isNonEmptyString(seg.take_group)) {
        errors.push(`${where}.take_group must be a non-empty string or null`);
      }
      if (seg && seg.is_best_take !== undefined && typeof seg.is_best_take !== "boolean") {
        errors.push(`${where}.is_best_take must be a boolean when present`);
      }
      // hook_candidate: the inspector's tag that this segment could open the
      // video cold — refines the server-side digest heuristic list. Tagged on
      // BOTH pools (A-roll openers and arresting B-roll frames).
      if (seg && seg.hook_candidate !== undefined && typeof seg.hook_candidate !== "boolean") {
        errors.push(`${where}.hook_candidate must be a boolean when present`);
      }
      if (seg && seg.hook_reason !== undefined && typeof seg.hook_reason !== "string") {
        errors.push(`${where}.hook_reason must be a string when present`);
      }
      // v3.1 P3 A-roll fields (optional): what's shown beyond the words, and
      // whether the subject addresses the camera.
      if (seg && seg.content_description !== undefined && typeof seg.content_description !== "string") {
        errors.push(`${where}.content_description must be a string when present`);
      }
      if (seg && seg.eyes_to_camera !== undefined && typeof seg.eyes_to_camera !== "boolean") {
        errors.push(`${where}.eyes_to_camera must be a boolean when present`);
      }
    });
  }
  // take_groups is optional metadata; if present, validate light shape.
  if (pool.take_groups !== undefined) {
    if (!Array.isArray(pool.take_groups)) {
      errors.push("aroll_pool.take_groups must be an array when present");
    } else {
      pool.take_groups.forEach((g, i) => {
        if (!isPlainObject(g) || !isNonEmptyString(g.group_id)) {
          errors.push(`aroll_pool.take_groups[${i}].group_id must be a non-empty string`);
        }
      });
    }
  }
}

function validateBrollIndex(index, segIndex, errors) {
  if (!isPlainObject(index)) {
    errors.push("broll_index must be an object");
    return;
  }
  if (!Array.isArray(index.clips)) {
    errors.push("broll_index.clips must be an array");
    return;
  }
  index.clips.forEach((clip, i) => {
    const where = `broll_index.clips[${i}]`;
    validateRef(clip, where, segIndex, errors);
    if (clip && !isNonEmptyString(clip.description)) {
      errors.push(`${where}.description must be a non-empty string`);
    }
    if (clip && clip.tags !== undefined && !isStringArray(clip.tags)) {
      errors.push(`${where}.tags must be an array of strings when present`);
    }
    if (clip && clip.has_motion !== undefined && typeof clip.has_motion !== "boolean") {
      errors.push(`${where}.has_motion must be a boolean when present`);
    }
    if (clip && clip.has_usable_audio !== undefined && typeof clip.has_usable_audio !== "boolean") {
      errors.push(`${where}.has_usable_audio must be a boolean when present`);
    }
    // hook_candidate/hook_reason on B-roll: same optional semantics as A-roll —
    // the inspector also tags arresting B-roll clips as cold-open candidates.
    if (clip && clip.hook_candidate !== undefined && typeof clip.hook_candidate !== "boolean") {
      errors.push(`${where}.hook_candidate must be a boolean when present`);
    }
    if (clip && clip.hook_reason !== undefined && typeof clip.hook_reason !== "string") {
      errors.push(`${where}.hook_reason must be a string when present`);
    }
    // v3.1 P3 B-roll field (optional): the editorial function of the coverage.
    if (clip && clip.b_roll_role !== undefined && !BROLL_ROLES.includes(clip.b_roll_role)) {
      errors.push(`${where}.b_roll_role must be one of ${BROLL_ROLES.join("|")} when present`);
    }
  });
}

// v3.1 P3 — the explicit multi-file map (optional, top-level). One entry per
// file naming whether it's the talking-head spine, coverage, voiceover, or
// mixed. `validFileIndices` (a Set, when segments.json is available) rejects a
// role pointing at a file that wasn't ingested.
function validateFileRoles(fileRoles, validFileIndices, errors) {
  if (!Array.isArray(fileRoles)) {
    errors.push("file_roles must be an array when present");
    return;
  }
  fileRoles.forEach((fr, i) => {
    const where = `file_roles[${i}]`;
    if (!isPlainObject(fr)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!Number.isInteger(fr.file_index) || fr.file_index < 0) {
      errors.push(`${where}.file_index must be a non-negative integer`);
    } else if (validFileIndices && !validFileIndices.has(fr.file_index)) {
      errors.push(`${where}.file_index ${fr.file_index} is not a file in inspect/segments.json`);
    }
    if (!FILE_ROLES.includes(fr.role)) {
      errors.push(`${where}.role must be one of ${FILE_ROLES.join("|")}`);
    }
    if (fr.summary !== undefined && typeof fr.summary !== "string") {
      errors.push(`${where}.summary must be a string when present`);
    }
  });
}

function validateReview(review, segIndex, errors) {
  if (!isPlainObject(review)) {
    errors.push("review must be an object");
    return;
  }
  if (!Array.isArray(review.segments)) {
    errors.push("review.segments must be an array (empty for a clean drop)");
    return;
  }
  review.segments.forEach((seg, i) => {
    const where = `review.segments[${i}]`;
    validateRef(seg, where, segIndex, errors);
    if (seg && !isNonEmptyString(seg.reason)) {
      errors.push(`${where}.reason must be a non-empty string (why this segment is ambiguous)`);
    }
  });
}

// Validate the full classification payload. `segmentsDoc` is the parsed
// inspect/segments.json (or null to skip cross-referencing). Every pool is
// required to be present (any may be empty).
function validateClassification(input, segmentsDoc = null) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["classification payload must be a JSON object"] };
  }
  const segIndex = segmentsDoc ? indexSegments(segmentsDoc) : null;
  if (!isPlainObject(input.aroll_pool)) errors.push("aroll_pool is required");
  else validateArollPool(input.aroll_pool, segIndex, errors);
  if (!isPlainObject(input.broll_index)) errors.push("broll_index is required");
  else validateBrollIndex(input.broll_index, segIndex, errors);
  if (!isPlainObject(input.review)) errors.push("review is required");
  else validateReview(input.review, segIndex, errors);
  // file_roles is OPTIONAL (v3.1 P3). When segments.json is available, cross-check
  // each role's file_index against the real ingested files.
  if (input.file_roles !== undefined) {
    let validFileIndices = null;
    const files = segmentsDoc && Array.isArray(segmentsDoc.files) ? segmentsDoc.files : null;
    if (files) {
      validFileIndices = new Set(files.map((f) => (f && Number.isInteger(f.file_index) ? f.file_index : null)).filter((x) => x != null));
    }
    validateFileRoles(input.file_roles, validFileIndices, errors);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  SHOT_TYPES,
  SUBJECT_POSITIONS,
  CAMERA_MOVEMENTS,
  SETTINGS,
  BROLL_ROLES,
  FILE_ROLES,
  indexSegments,
  validateArollPool,
  validateBrollIndex,
  validateReview,
  validateFileRoles,
  validateClassification,
};
