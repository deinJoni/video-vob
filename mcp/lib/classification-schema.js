"use strict";

// Validation for the three INSPECT classification pools the `inspector`
// subagent produces from inspect/segments.json: the A-roll spine pool, the
// B-roll index, and the review bucket. Mirrors storyboard-schema.js in spirit —
// it checks SHAPE + required fields + that every segment reference points at a
// real detected segment (so the agent can't hallucinate segments), while
// staying permissive about extra descriptive fields the agent may add.

const SCHEMA_VERSION = "1.0";

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
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  indexSegments,
  validateArollPool,
  validateBrollIndex,
  validateReview,
  validateClassification,
};
