"use strict";

const fs = require("fs");
const path = require("path");
const { removedWithin } = require("./clean-cut.js");
const { intentAnswerRaw } = require("./intent-schema.js");
const { inspectCleanSpeechPath } = require("./paths.js");
const { parseDurationSpec, parseDurationToSeconds } = require("./platform-profiles.js");
const { readJsonFile } = require("./storage.js");
const { activeLintRules, OVERLAY_TYPES } = require("./video-types.js");
const hostProfile = require("./host-profile.js");

const SCHEMA_VERSION = "1.0";
// 1.1 adds the optional top-level shorts[] (multi-short fan-out); a document
// with shorts[] must declare 1.1 or later. 1.2 (v3) adds typed overlay objects,
// the optional top-level segments[] (narrative acts/chapters that double as the
// manual render-segmentation unit), render_segmentation, target.fps, and the
// richer broll_placements (render_mode / motion / gap form) — all additive;
// scenes-form 1.0 documents stay valid forever.
const SCHEMA_VERSIONS = Object.freeze(["1.0", "1.1", "1.2"]);
const SHORTS_SCHEMA_VERSIONS = Object.freeze(["1.1", "1.2"]);
// Render segmentation policy: how COMPOSE/RENDER chunk the timeline. "single"
// = one continuous composition (v2.1 path); "auto" = the engine chunks
// consecutive scenes to the host <video> budget; "manual" = the declared
// segments[] are the render units.
const RENDER_SEGMENTATIONS = Object.freeze(["single", "auto", "manual"]);
const PURPOSES = Object.freeze(["hook", "beat", "payoff", "outro"]);
const PACINGS = Object.freeze(["fast", "medium", "slow"]);
// Clip role: how the composer should treat a source clip.
//   a_roll  — spine footage; carries the narrative (audio kept per intent), visible base track.
//   b_roll  — coverage/cutaway; materialized MUTED and laid as video over the spine on a higher track.
//   overlay — graphic/text element with no source video of its own.
// Optional + backward-compatible: a clip with no `role` is treated as a_roll.
const CLIP_ROLES = Object.freeze(["a_roll", "b_roll", "overlay"]);
// Deliberately tiny enum — only what renders reliably on the 8 GB reference host.
const SCENE_TRANSITIONS = Object.freeze(["cut", "fade"]);

const PURPOSE_SET = new Set(PURPOSES);
const PACING_SET = new Set(PACINGS);
const CLIP_ROLE_SET = new Set(CLIP_ROLES);
const SCENE_TRANSITION_SET = new Set(SCENE_TRANSITIONS);

function clipRoleOf(clip) {
  return clip && typeof clip.role === "string" && clip.role.trim() ? clip.role : "a_roll";
}

// <video> elements a scene costs the composition: one per source clip plus one
// per planned PiP overlay (a pip carries a <video> by definition). The single
// budget-accounting function — render-segments chunking and plan lint both use
// it, so a PiP-heavy segment auto-splits and over-budget plans warn early.
function sceneVideoCount(scene) {
  if (!scene || typeof scene !== "object") return 0;
  const clips = Array.isArray(scene.source_clips) ? scene.source_clips.length : 0;
  const pips = Array.isArray(scene.overlays)
    ? scene.overlays.filter((o) => o !== null && typeof o === "object" && !Array.isArray(o) && o.type === "pip").length
    : 0;
  return clips + pips;
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

function validateClip(clip, sceneIx, clipIx, errors, wherePrefix = "") {
  const where = `${wherePrefix}scenes[${sceneIx}].source_clips[${clipIx}]`;
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

// --- Typed overlays (schema 1.2) ----------------------------------------------
// scene.overlays[] entries are either legacy freeform STRINGS (advisory notes,
// valid in every schema version) or typed OBJECTS — planned, timed, composer-
// bound graphics. The composer stamps the implementing element with
// data-vob-overlay-id="<id>", which composition QC enforces.
const OVERLAY_TYPE_SET = new Set(OVERLAY_TYPES);
const OVERLAY_ANCHORS = Object.freeze([
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
]);
const OVERLAY_ANCHOR_SET = new Set(OVERLAY_ANCHORS);
// Attribute-friendly id (lands in data-vob-overlay-id and finding messages).
const OVERLAY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function validateOverlayObject(overlay, sceneIx, entryIx, errors, wherePrefix, typedOverlaysAllowed) {
  const where = `${wherePrefix}scenes[${sceneIx}].overlays[${entryIx}]`;
  if (!typedOverlaysAllowed) {
    errors.push(`${where} is a typed overlay object — schema_version must be "1.2" (strings remain valid as freeform notes)`);
    return;
  }
  if (!OVERLAY_ID_RE.test(String(overlay.id || ""))) {
    errors.push(`${where}.id must be a short attribute-safe string (letters/digits/._:-, e.g. "lt-1")`);
  }
  if (!OVERLAY_TYPE_SET.has(overlay.type)) {
    errors.push(`${where}.type must be one of: ${OVERLAY_TYPES.join(", ")}`);
  }
  if (!isFiniteNumber(overlay.start_seconds) || overlay.start_seconds < 0
    || !isFiniteNumber(overlay.end_seconds) || overlay.end_seconds <= overlay.start_seconds) {
    errors.push(`${where} must satisfy 0 <= start_seconds < end_seconds (SCENE-relative seconds)`);
  }
  if (overlay.track !== undefined && overlay.track !== null
    && (!Number.isInteger(overlay.track) || overlay.track < 1)) {
    errors.push(`${where}.track must be an integer >= 1 when present (track 0 is the video spine)`);
  }
  if (overlay.content !== undefined && overlay.content !== null && !isPlainObject(overlay.content)) {
    errors.push(`${where}.content must be an object when present`);
  }
  if (overlay.position !== undefined && overlay.position !== null) {
    const p = overlay.position;
    if (!isPlainObject(p)) {
      errors.push(`${where}.position must be an object when present`);
    } else {
      if (p.anchor !== undefined && p.anchor !== null && !OVERLAY_ANCHOR_SET.has(p.anchor)) {
        errors.push(`${where}.position.anchor must be one of: ${OVERLAY_ANCHORS.join(", ")}`);
      }
      if (p.offset_px !== undefined && p.offset_px !== null
        && (!Array.isArray(p.offset_px) || p.offset_px.length !== 2 || !p.offset_px.every((n) => isFiniteNumber(n)))) {
        errors.push(`${where}.position.offset_px must be a [x, y] pair of finite numbers when present`);
      }
    }
  }
  if (overlay.style !== undefined && overlay.style !== null && !isPlainObject(overlay.style)) {
    errors.push(`${where}.style must be an object when present`);
  }
  if (overlay.motion !== undefined && overlay.motion !== null) {
    const m = overlay.motion;
    if (!isPlainObject(m)) {
      errors.push(`${where}.motion must be an object when present`);
    } else {
      for (const field of ["in", "out"]) {
        if (m[field] !== undefined && m[field] !== null && !isNonEmptyString(m[field])) {
          errors.push(`${where}.motion.${field} must be a non-empty string when present`);
        }
      }
      if (m.dwell_min_s !== undefined && m.dwell_min_s !== null
        && (!isFiniteNumber(m.dwell_min_s) || m.dwell_min_s <= 0)) {
        errors.push(`${where}.motion.dwell_min_s must be a positive finite number when present`);
      }
    }
  }
}

// Typed overlay objects from a scene (strings filtered out).
function typedOverlaysOf(scene) {
  if (!isPlainObject(scene) || !Array.isArray(scene.overlays)) return [];
  return scene.overlays.filter((o) => isPlainObject(o));
}

// Optional per-scene caption_segments (SOURCE-time): the storyboarder's timed
// caption plan. No cross-check against `captions` — that string stays the
// human-readable summary.
function validateCaptionSegment(seg, sceneIx, segIx, errors, wherePrefix = "") {
  const where = `${wherePrefix}scenes[${sceneIx}].caption_segments[${segIx}]`;
  if (!isPlainObject(seg)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (!isNonEmptyString(seg.text)) {
    errors.push(`${where}.text must be a non-empty string`);
  }
  if (
    !isFiniteNumber(seg.start_seconds) || seg.start_seconds < 0
    || !isFiniteNumber(seg.end_seconds) || seg.end_seconds <= seg.start_seconds
  ) {
    errors.push(`${where} must satisfy 0 <= start_seconds < end_seconds`);
  }
  if (seg.emphasis !== undefined && seg.emphasis !== null && typeof seg.emphasis !== "boolean") {
    errors.push(`${where}.emphasis must be a boolean when present`);
  }
}

function validateScene(scene, ix, errors, wherePrefix = "", opts = {}) {
  const typedOverlaysAllowed = opts.typedOverlaysAllowed === true;
  const where = `${wherePrefix}scenes[${ix}]`;
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
    scene.source_clips.forEach((clip, clipIx) => validateClip(clip, ix, clipIx, errors, wherePrefix));
  }
  if (!Array.isArray(scene.overlays)) {
    errors.push(`${where}.overlays must be an array (may be empty) — freeform note strings, or typed overlay objects under schema 1.2`);
  } else {
    scene.overlays.forEach((entry, entryIx) => {
      if (typeof entry === "string") return; // legacy freeform note — always valid
      if (isPlainObject(entry)) {
        validateOverlayObject(entry, ix, entryIx, errors, wherePrefix, typedOverlaysAllowed);
        return;
      }
      errors.push(`${where}.overlays[${entryIx}] must be a string note or a typed overlay object`);
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
  if (scene.caption_segments !== undefined && scene.caption_segments !== null) {
    if (!Array.isArray(scene.caption_segments)) {
      errors.push(`${where}.caption_segments must be an array when present`);
    } else {
      scene.caption_segments.forEach((seg, segIx) => validateCaptionSegment(seg, ix, segIx, errors, wherePrefix));
    }
  }
  for (const field of ["transition_in", "transition_out"]) {
    const value = scene[field];
    if (value !== undefined && value !== null && !SCENE_TRANSITION_SET.has(value)) {
      errors.push(`${where}.${field} must be one of: ${SCENE_TRANSITIONS.join(", ")} (omit for default cut)`);
    }
  }
}

// Optional top-level broll_placements[]: the storyboarder's explicit record of
// where each B-roll cutaway sits over the A-roll/narration spine. PLANNED but
// non-materializing — the clips themselves live in scenes[].source_clips with
// role:"b_roll" (and are materialized + symlinked by the normal machinery); a
// placement only references one of those existing clips by
// {scene_id, clip_index}, so there is no separate materialization path and no
// way to dangle into a 404 at render. Backward-compat: absent/empty
// broll_placements is fine.
//
// v3 (schema 1.2) adds:
//   render_mode  full_frame (cutaway) | pip (inset) | overlay — how COMPOSE lays it
//   motion       freeform treatment note ("ken_burns", "none", "speed_ramp", ...)
//   GAP form     { source: "gap", description, desired_duration_seconds,
//                  scene_ref, narration_span?, reason? } INSTEAD of clip — the
//                  cut wants coverage the ingested footage can't supply. Gaps
//                  collect into plan/broll_gaps.json (the shopping list) and
//                  warn at the plan gate; the human resolves one by ingesting
//                  more footage (the PLAN→INGEST back-edge).
const BROLL_RENDER_MODES = Object.freeze(["full_frame", "pip", "overlay"]);
const BROLL_RENDER_MODE_SET = new Set(BROLL_RENDER_MODES);

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

function isGapPlacement(p) {
  return isPlainObject(p) && p.source === "gap";
}

function validateBrollPlacementsList(placements, scenes, wherePrefix, errors, opts = {}) {
  if (placements === undefined || placements === null) return;
  if (!Array.isArray(placements)) {
    errors.push(`${wherePrefix}broll_placements must be an array when present`);
    return;
  }
  const v12 = opts.typedOverlaysAllowed === true; // schema 1.2 gates the new fields
  const sceneClips = buildSceneClipIndex(scenes);
  placements.forEach((p, ix) => {
    const where = `${wherePrefix}broll_placements[${ix}]`;
    if (!isPlainObject(p)) {
      errors.push(`${where} must be an object`);
      return;
    }
    // v3 additive fields, legal on both forms.
    if (p.render_mode !== undefined && p.render_mode !== null) {
      if (!v12) {
        errors.push(`${where}.render_mode requires schema_version "1.2"`);
      } else if (!BROLL_RENDER_MODE_SET.has(p.render_mode)) {
        errors.push(`${where}.render_mode must be one of: ${BROLL_RENDER_MODES.join(", ")}`);
      }
    }
    if (p.motion !== undefined && p.motion !== null) {
      if (!v12) {
        errors.push(`${where}.motion requires schema_version "1.2"`);
      } else if (!isNonEmptyString(p.motion)) {
        errors.push(`${where}.motion must be a non-empty string when present`);
      }
    }
    if (p.source !== undefined && p.source !== null && p.source !== "gap") {
      errors.push(`${where}.source must be the literal "gap" when present (concrete placements use clip instead)`);
    }
    if (isGapPlacement(p)) {
      // Gap form: a coverage WISH, no clip. Mutually exclusive with clip.
      if (!v12) {
        errors.push(`${where} declares source:"gap" — schema_version must be "1.2"`);
        return;
      }
      if (p.clip !== undefined && p.clip !== null) {
        errors.push(`${where} cannot carry BOTH clip and source:"gap" — a placement is concrete or a gap, never both`);
      }
      if (!isNonEmptyString(p.description)) {
        errors.push(`${where}.description must be a non-empty string (what footage to shoot/upload)`);
      }
      if (!isFiniteNumber(p.desired_duration_seconds) || p.desired_duration_seconds <= 0) {
        errors.push(`${where}.desired_duration_seconds must be a positive finite number`);
      }
      if (!isNonEmptyString(p.scene_ref)) {
        errors.push(`${where}.scene_ref must name the scene wanting this coverage`);
      } else if (!sceneClips.has(p.scene_ref)) {
        errors.push(`${where}.scene_ref "${p.scene_ref}" does not match any scene`);
      }
      if (p.narration_span !== undefined && p.narration_span !== null) {
        const ns = p.narration_span;
        if (!isPlainObject(ns) || !isFiniteNumber(ns.start_seconds) || !isFiniteNumber(ns.end_seconds) || ns.start_seconds < 0 || ns.end_seconds <= ns.start_seconds) {
          errors.push(`${where}.narration_span must be { start_seconds, end_seconds } with end > start >= 0 when present`);
        }
      }
      if (p.reason !== undefined && p.reason !== null && typeof p.reason !== "string") {
        errors.push(`${where}.reason must be a string when present`);
      }
      return; // gap placements skip the clip-reference checks below
    }
    if (!isPlainObject(p.clip)) {
      errors.push(`${where}.clip must be an object { scene_id, clip_index } (or declare source:"gap" with a description under schema 1.2)`);
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

function validateBrollPlacements(input, errors, opts = {}) {
  validateBrollPlacementsList(input.broll_placements, input.scenes, "", errors, opts);
}

// Every gap placement across both document forms, normalized for
// plan/broll_gaps.json and the plan gate. Each gap gets a stable derived id.
function collectBrollGaps(parsed) {
  const gaps = [];
  for (const timeline of storyboardTimelines(parsed)) {
    timeline.broll_placements.forEach((p, ix) => {
      if (!isGapPlacement(p)) return;
      gaps.push({
        id: timeline.short_id !== null ? `${timeline.short_id}:gap-${ix + 1}` : `gap-${ix + 1}`,
        ...(timeline.short_id !== null ? { short_id: timeline.short_id } : {}),
        placement_index: ix,
        description: isNonEmptyString(p.description) ? p.description : null,
        desired_duration_seconds: isFiniteNumber(p.desired_duration_seconds) ? p.desired_duration_seconds : null,
        scene_ref: isNonEmptyString(p.scene_ref) ? p.scene_ref : null,
        narration_span: isPlainObject(p.narration_span) ? p.narration_span : null,
        render_mode: isNonEmptyString(p.render_mode) ? p.render_mode : null,
        reason: isNonEmptyString(p.reason) ? p.reason : null,
      });
    });
  }
  return gaps;
}

// --- Multi-short fan-out (schema 1.1) ---------------------------------------
// shorts[]: N independent timelines in one document — one PLAN gate signs off
// the whole set; COMPOSE/PREVIEW/RENDER then cycle per short (active-short
// model). Each short carries its own scenes/total/broll_placements; the
// top-level fields must be ABSENT so there is exactly one source of truth.
function isSafeIdString(value) {
  return isNonEmptyString(value)
    && !/[\/\\]/.test(value)
    && !/(?:^|\.)\.\.(?:\.|$)/.test(value);
}

function validateShort(short, ix, seenShortIds, errors, opts = {}) {
  const where = `shorts[${ix}]`;
  if (!isPlainObject(short)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (!isSafeIdString(short.short_id)) {
    errors.push(`${where}.short_id must be a non-empty path-safe string`);
  } else if (seenShortIds.has(short.short_id)) {
    errors.push(`${where}.short_id "${short.short_id}" duplicates an earlier short — short_ids must be unique`);
  } else {
    seenShortIds.add(short.short_id);
  }
  if (!isNonEmptyString(short.title)) {
    errors.push(`${where}.title must be a non-empty string`);
  }
  if (!Number.isInteger(short.sequence) || short.sequence !== ix + 1) {
    errors.push(`${where}.sequence must equal ${ix + 1} (1-based, monotonically increasing)`);
  }
  if (!isFiniteNumber(short.total_target_duration_seconds) || short.total_target_duration_seconds <= 0) {
    errors.push(`${where}.total_target_duration_seconds must be a positive finite number`);
  }
  if (short.notes !== undefined && short.notes !== null && typeof short.notes !== "string") {
    errors.push(`${where}.notes must be a string when present`);
  }
  if (!Array.isArray(short.scenes) || short.scenes.length === 0) {
    errors.push(`${where}.scenes must be a non-empty array`);
  } else {
    short.scenes.forEach((scene, sceneIx) => validateScene(scene, sceneIx, errors, `${where}.`, opts));
  }
  validateBrollPlacementsList(short.broll_placements, short.scenes, `${where}.`, errors, opts);
}

// --- Narrative segments (schema 1.2) -----------------------------------------
// segments[]: acts/chapters/sections over the single-timeline scenes[]. They
// are the PLANNING unit (chapter markers at PACKAGE) and, under
// render_segmentation:"manual", the render unit. Constraints: scenes-form only
// (mutually exclusive with shorts[] — a fan-out OF segmented videos is out of
// scope for v3), and the segments must CONTIGUOUSLY partition scenes[] in
// timeline order — every scene in exactly one segment, no reordering — so
// concat-at-assembly is exactly the planned timeline.
function validateSegments(input, errors) {
  if (input.segments === undefined || input.segments === null) return;
  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    errors.push("segments must be a non-empty array when present");
    return;
  }
  if (input.schema_version === "1.0" || input.schema_version === "1.1") {
    errors.push('schema_version must be "1.2" when segments[] is present');
  }
  if (input.shorts !== undefined && input.shorts !== null) {
    errors.push("segments[] cannot be combined with shorts[] — segment a single timeline, or fan out shorts, not both");
    return;
  }
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  const sceneOrder = scenes
    .map((scene) => (isPlainObject(scene) && isNonEmptyString(scene.scene_id) ? scene.scene_id : null));
  const seenSegmentIds = new Set();
  const coveredSceneIds = [];
  input.segments.forEach((segment, ix) => {
    const where = `segments[${ix}]`;
    if (!isPlainObject(segment)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!isSafeIdString(segment.segment_id)) {
      errors.push(`${where}.segment_id must be a non-empty path-safe string`);
    } else if (seenSegmentIds.has(segment.segment_id)) {
      errors.push(`${where}.segment_id "${segment.segment_id}" duplicates an earlier segment`);
    } else {
      seenSegmentIds.add(segment.segment_id);
    }
    if (!isNonEmptyString(segment.title)) {
      errors.push(`${where}.title must be a non-empty string (it becomes the chapter title)`);
    }
    if (!Number.isInteger(segment.sequence) || segment.sequence !== ix + 1) {
      errors.push(`${where}.sequence must equal ${ix + 1} (1-based, monotonically increasing)`);
    }
    if (!Array.isArray(segment.scene_ids) || segment.scene_ids.length === 0) {
      errors.push(`${where}.scene_ids must be a non-empty array of scene_id strings`);
    } else {
      segment.scene_ids.forEach((sceneId, sIx) => {
        if (!isNonEmptyString(sceneId)) {
          errors.push(`${where}.scene_ids[${sIx}] must be a non-empty string`);
        } else {
          coveredSceneIds.push(sceneId);
        }
      });
    }
    if (segment.transition_out !== undefined && segment.transition_out !== null
      && !SCENE_TRANSITION_SET.has(segment.transition_out)) {
      errors.push(`${where}.transition_out must be one of: ${SCENE_TRANSITIONS.join(", ")} (omit for default cut)`);
    }
    if (segment.notes !== undefined && segment.notes !== null && typeof segment.notes !== "string") {
      errors.push(`${where}.notes must be a string when present`);
    }
  });
  // Contiguous full partition: the concatenation of scene_ids in segment order
  // must equal scenes[] order exactly.
  if (sceneOrder.every((id) => id !== null) && coveredSceneIds.length > 0) {
    const expected = sceneOrder.join(" ");
    const got = coveredSceneIds.join(" ");
    if (expected !== got) {
      const missing = sceneOrder.filter((id) => !coveredSceneIds.includes(id));
      const unknown = coveredSceneIds.filter((id) => !sceneOrder.includes(id));
      const dupes = coveredSceneIds.filter((id, i) => coveredSceneIds.indexOf(id) !== i);
      const detail = [
        missing.length ? `uncovered scenes: ${missing.join(", ")}` : null,
        unknown.length ? `unknown scene_ids: ${unknown.join(", ")}` : null,
        dupes.length ? `scenes in more than one segment: ${[...new Set(dupes)].join(", ")}` : null,
        !missing.length && !unknown.length && !dupes.length ? "scene order differs from scenes[]" : null,
      ].filter(Boolean).join("; ");
      errors.push(`segments[] must contiguously partition scenes[] in timeline order — ${detail}`);
    }
  }
}

function validateRenderSegmentation(input, errors) {
  const value = input.render_segmentation;
  if (value === undefined || value === null) return;
  if (!RENDER_SEGMENTATIONS.includes(value)) {
    errors.push(`render_segmentation must be one of: ${RENDER_SEGMENTATIONS.join(", ")}`);
    return;
  }
  if (input.schema_version === "1.0" || input.schema_version === "1.1") {
    errors.push('schema_version must be "1.2" when render_segmentation is present');
  }
  if (value === "manual" && (!Array.isArray(input.segments) || input.segments.length === 0)) {
    errors.push('render_segmentation "manual" requires segments[] — declare the render units');
  }
  if (input.shorts !== undefined && input.shorts !== null && value !== "single") {
    errors.push("render_segmentation does not apply to a shorts[] fan-out — each short is already its own render");
  }
}

function storyboardHasSegments(parsed) {
  return isPlainObject(parsed) && Array.isArray(parsed.segments) && parsed.segments.length > 0;
}

// Normalized narrative-segment view (scenes resolved, durations summed).
// [] when no segments are declared or the document is malformed.
function storyboardSegments(parsed) {
  if (!storyboardHasSegments(parsed)) return [];
  const sceneById = new Map();
  (Array.isArray(parsed.scenes) ? parsed.scenes : []).forEach((scene) => {
    if (isPlainObject(scene) && isNonEmptyString(scene.scene_id)) sceneById.set(scene.scene_id, scene);
  });
  return parsed.segments
    .filter(isPlainObject)
    .map((segment, ix) => {
      const sceneIds = Array.isArray(segment.scene_ids) ? segment.scene_ids.filter(isNonEmptyString) : [];
      const scenes = sceneIds.map((id) => sceneById.get(id)).filter(isPlainObject);
      const duration = scenes.reduce(
        (acc, s) => acc + (isFiniteNumber(s.target_duration_seconds) ? s.target_duration_seconds : 0),
        0,
      );
      return {
        segment_id: isNonEmptyString(segment.segment_id) ? segment.segment_id : null,
        title: isNonEmptyString(segment.title) ? segment.title : null,
        sequence: Number.isInteger(segment.sequence) ? segment.sequence : ix + 1,
        scene_ids: sceneIds,
        scenes,
        target_duration_seconds: duration > 0 ? duration : null,
        transition_out: isNonEmptyString(segment.transition_out) ? segment.transition_out : "cut",
        notes: typeof segment.notes === "string" ? segment.notes : null,
      };
    });
}

// Normalized timeline view — THE accessor for code that must work in both
// modes. Single-timeline documents project to one entry with short_id:null.
function storyboardTimelines(parsed) {
  if (!isPlainObject(parsed)) return [];
  if (Array.isArray(parsed.shorts) && parsed.shorts.length > 0) {
    return parsed.shorts.map((short, ix) => {
      const s = isPlainObject(short) ? short : {};
      return {
        short_id: isNonEmptyString(s.short_id) ? s.short_id : null,
        title: isNonEmptyString(s.title) ? s.title : null,
        sequence: Number.isInteger(s.sequence) ? s.sequence : ix + 1,
        scenes: Array.isArray(s.scenes) ? s.scenes : [],
        total_target_duration_seconds: isFiniteNumber(s.total_target_duration_seconds)
          ? s.total_target_duration_seconds
          : null,
        broll_placements: Array.isArray(s.broll_placements) ? s.broll_placements : [],
        notes: typeof s.notes === "string" ? s.notes : null,
      };
    });
  }
  return [{
    short_id: null,
    title: null,
    sequence: 1,
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
    total_target_duration_seconds: isFiniteNumber(parsed.total_target_duration_seconds)
      ? parsed.total_target_duration_seconds
      : null,
    broll_placements: Array.isArray(parsed.broll_placements) ? parsed.broll_placements : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : null,
  }];
}

function storyboardHasShorts(parsed) {
  return isPlainObject(parsed) && Array.isArray(parsed.shorts) && parsed.shorts.length > 0;
}

function allStoryboardScenes(parsed) {
  const scenes = [];
  for (const timeline of storyboardTimelines(parsed)) scenes.push(...timeline.scenes);
  return scenes;
}

// shortId null/undefined resolves the single timeline (and nothing in a
// fan-out document); a string resolves the matching short.
function findTimeline(parsed, shortId) {
  const timelines = storyboardTimelines(parsed);
  if (shortId === null || shortId === undefined) {
    return timelines.length === 1 && timelines[0].short_id === null ? timelines[0] : null;
  }
  return timelines.find((t) => t.short_id === shortId) || null;
}

// Duration basis for render TIMEOUTS: the active timeline's total; for a
// fan-out document with no resolvable short, the LONGEST short (a safe
// ceiling). Drift verification must NOT use the fallback — the render tools
// resolve the timeline separately and pass null when it didn't resolve.
function expectedTimelineDurationSeconds(parsed, shortId) {
  const timeline = findTimeline(parsed, shortId);
  if (timeline && isFiniteNumber(timeline.total_target_duration_seconds) && timeline.total_target_duration_seconds > 0) {
    return timeline.total_target_duration_seconds;
  }
  if (storyboardHasShorts(parsed)) {
    const max = storyboardTimelines(parsed).reduce(
      (acc, t) => Math.max(acc, isFiniteNumber(t.total_target_duration_seconds) ? t.total_target_duration_seconds : 0),
      0,
    );
    return max > 0 ? max : null;
  }
  const total = isPlainObject(parsed) ? Number(parsed.total_target_duration_seconds) : NaN;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function validateStoryboard(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["storyboard must be a JSON object"] };
  }
  if (!SCHEMA_VERSIONS.includes(input.schema_version)) {
    errors.push(`schema_version must be one of: ${SCHEMA_VERSIONS.map((v) => `"${v}"`).join(", ")}`);
  }
  const hasShorts = input.shorts !== undefined && input.shorts !== null;
  if (hasShorts && !SHORTS_SCHEMA_VERSIONS.includes(input.schema_version)) {
    errors.push(`schema_version must be one of: ${SHORTS_SCHEMA_VERSIONS.map((v) => `"${v}"`).join(", ")} when shorts[] is present`);
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
    // v3: fps is a real per-profile field; the storyboarder copies it from the
    // platform profile so the composer (data-fps) and QC read it from disk.
    if (input.target.fps !== undefined && input.target.fps !== null
      && (!isFiniteNumber(input.target.fps) || input.target.fps <= 0)) {
      errors.push("target.fps must be a positive finite number when present (e.g. 24, 25, 30, 50, 60)");
    }
  }
  const sceneOpts = { typedOverlaysAllowed: input.schema_version === "1.2" };
  if (hasShorts) {
    // Fan-out form: shorts[] carries the timelines; the top-level timeline
    // fields must be absent (one source of truth).
    if (!Array.isArray(input.shorts) || input.shorts.length === 0) {
      errors.push("shorts must be a non-empty array when present");
    } else {
      const seenShortIds = new Set();
      input.shorts.forEach((short, ix) => validateShort(short, ix, seenShortIds, errors, sceneOpts));
    }
    for (const field of ["scenes", "total_target_duration_seconds", "broll_placements"]) {
      if (input[field] !== undefined) {
        errors.push(`${field} must be omitted when shorts[] is present — each short carries its own`);
      }
    }
  } else {
    if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
      errors.push("scenes must be a non-empty array");
    } else {
      input.scenes.forEach((scene, ix) => validateScene(scene, ix, errors, "", sceneOpts));
    }
    if (!isFiniteNumber(input.total_target_duration_seconds) || input.total_target_duration_seconds <= 0) {
      errors.push("total_target_duration_seconds must be a positive finite number");
    }
    validateBrollPlacements(input, errors, sceneOpts);
  }
  validateSegments(input, errors);
  validateRenderSegmentation(input, errors);
  // Typed overlay ids are DOCUMENT-global (they become data-vob-overlay-id
  // element bindings; QC matches by id across the whole composition).
  {
    const seenOverlayIds = new Map();
    for (const timeline of storyboardTimelines(input)) {
      timeline.scenes.forEach((scene, ix) => {
        for (const overlay of typedOverlaysOf(scene)) {
          if (!isNonEmptyString(overlay.id)) continue;
          const at = timeline.short_id !== null
            ? `shorts["${timeline.short_id}"].scenes[${ix}]`
            : `scenes[${ix}]`;
          const prior = seenOverlayIds.get(overlay.id);
          if (prior) {
            errors.push(`overlay id "${overlay.id}" at ${at} duplicates ${prior} — overlay ids must be unique across the document`);
          } else {
            seenOverlayIds.set(overlay.id, at);
          }
        }
      });
    }
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== "string") {
    errors.push("notes must be a string when present");
  }

  return { ok: errors.length === 0, errors };
}

// Content-level validation — runs AFTER validateStoryboard succeeds. Where
// validateStoryboard checks JSON shape, this checks that the storyboard's
// content claims are consistent with observable source facts (manifest,
// transcript, clean_speech, intent target). Errors reject the save; warnings
// ride to the plan gate. Shape first, content second.
function loadTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
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

// Per-file transcript resolver. On multi-file drops each clip's words live in
// the transcript of ITS file (state.inspect.transcripts entries carry
// {file_index, path} -> inspect/transcripts/file_<i>.json) — validating every
// clip against the single winner-file transcript false-rejects/passes captioned
// scenes cut from other files. Falls back to the winner transcript when no
// per-file transcript exists (legacy sessions). Loaded transcripts are cached
// per file index for the duration of one validation call.
function buildTranscriptResolver(state, winnerTranscript) {
  const inspect = state && isPlainObject(state.inspect) ? state.inspect : null;
  const entries = inspect && Array.isArray(inspect.transcripts) ? inspect.transcripts : [];
  const pathByIndex = new Map();
  for (const entry of entries) {
    if (isPlainObject(entry) && Number.isInteger(entry.file_index) && typeof entry.path === "string" && entry.path) {
      pathByIndex.set(entry.file_index, entry.path);
    }
  }
  const cache = new Map(); // file_index -> transcript array | null
  return (fileIndex) => {
    if (!Number.isInteger(fileIndex) || !pathByIndex.has(fileIndex)) return winnerTranscript;
    if (!cache.has(fileIndex)) cache.set(fileIndex, loadTranscript(pathByIndex.get(fileIndex)));
    const transcript = cache.get(fileIndex);
    return transcript !== null ? transcript : winnerTranscript; // unreadable -> winner fallback
  };
}

function clipHasSpokenWords(scene, transcriptForFileIndex) {
  if (!Array.isArray(scene.source_clips) || scene.source_clips.length === 0) {
    return false;
  }
  return scene.source_clips.some((clip) => {
    if (!clip || !isFiniteNumber(clip.in_seconds) || !isFiniteNumber(clip.out_seconds)) return false;
    const transcript = transcriptForFileIndex(clip.manifest_file_index);
    return Array.isArray(transcript)
      && transcriptOverlapsClip(transcript, clip.in_seconds, clip.out_seconds);
  });
}

function sceneHasCaptions(scene) {
  return typeof scene.captions === "string" && scene.captions.trim() !== "";
}

// Plan-lint thresholds (D4). straddle_removed_min_s is aligned with the
// storyboarder's "merge keep-spans when the gap is <0.8s" craft rule —
// sanctioned merges must be lint-silent.
const PLAN_LINT_THRESHOLDS = Object.freeze({
  out_seconds_tolerance_s: 0.1,
  hook_max_s: 3.5,
  scene_sum_tolerance_s: 0.5,
  target_drift_ratio: 0.20,
  scene_clip_sum_ratio: 0.15,
  broll_min_hold_s: 1.5,
  broll_span_tolerance_s: 0.25,
  straddle_removed_min_s: 0.8,
  short_duration_range_tolerance_s: 0.5,
});

function round1(value) {
  return Math.round(value * 10) / 10;
}

function sceneIdOf(scene) {
  return isPlainObject(scene) && isNonEmptyString(scene.scene_id) ? scene.scene_id : null;
}

function eachClip(scenes, fn) {
  scenes.forEach((scene, sceneIx) => {
    if (!isPlainObject(scene) || !Array.isArray(scene.source_clips)) return;
    scene.source_clips.forEach((clip, clipIx) => {
      if (!isPlainObject(clip)) return;
      fn(scene, sceneIx, clip, clipIx);
    });
  });
}

function clipHasWindow(clip) {
  return isFiniteNumber(clip.in_seconds) && isFiniteNumber(clip.out_seconds);
}

function resolvePlacementClip(placement, sceneById) {
  const ref = placement.clip;
  if (!isPlainObject(ref) || !isNonEmptyString(ref.scene_id) || !Number.isInteger(ref.clip_index)) return null;
  const entry = sceneById.get(ref.scene_id);
  if (!entry || !Array.isArray(entry.scene.source_clips)) return null;
  const clip = entry.scene.source_clips[ref.clip_index];
  return isPlainObject(clip) ? clip : null;
}

function lintManifestBounds(scenes, manifest, errors) {
  const files = isPlainObject(manifest) && Array.isArray(manifest.files) ? manifest.files : null;
  if (!files) return;
  eachClip(scenes, (scene, i, clip, j) => {
    if (!Number.isInteger(clip.manifest_file_index) || clip.manifest_file_index < 0) return;
    if (clip.manifest_file_index >= files.length) {
      errors.push({
        code: "PLAN_MANIFEST_INDEX_OUT_OF_RANGE",
        message: `scenes[${i}].source_clips[${j}].manifest_file_index ${clip.manifest_file_index} is out of range — manifest has ${files.length} file(s)`,
        scene_index: i,
        scene_id: sceneIdOf(scene),
        clip_index: j,
        data: { manifest_file_index: clip.manifest_file_index, file_count: files.length },
      });
      return;
    }
    const file = files[clip.manifest_file_index];
    const duration = isPlainObject(file) && isFiniteNumber(file.duration_seconds) ? file.duration_seconds : null;
    if (
      duration !== null && isFiniteNumber(clip.out_seconds)
      && clip.out_seconds > duration + PLAN_LINT_THRESHOLDS.out_seconds_tolerance_s
    ) {
      errors.push({
        code: "PLAN_CLIP_OUT_OF_BOUNDS",
        message: `scenes[${i}].source_clips[${j}] out_seconds ${round1(clip.out_seconds)}s exceeds file duration ${round1(duration)}s (file ${clip.manifest_file_index}: ${path.basename(String(file.path || ""))})`,
        scene_index: i,
        scene_id: sceneIdOf(scene),
        clip_index: j,
        data: { out_seconds: clip.out_seconds, duration_seconds: duration, manifest_file_index: clip.manifest_file_index },
      });
    }
  });
}

function lintCaptionsOnSilent(scenes, transcript, errors, transcriptForFileIndex) {
  // Captions vs transcript: a captioned scene that pulls from a silent stretch
  // of the source is the "captions don't reflect what the source actually
  // says" failure mode. Each clip is checked against ITS file's transcript
  // (via transcriptForFileIndex) — the winner transcript is only the fallback.
  if (!Array.isArray(transcript) || transcript.length === 0) return;
  const resolveTranscript = typeof transcriptForFileIndex === "function"
    ? transcriptForFileIndex
    : () => transcript;
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene)) return;
    if (!sceneHasCaptions(scene)) return;
    if (!Array.isArray(scene.source_clips) || scene.source_clips.length === 0) return;
    if (!clipHasSpokenWords(scene, resolveTranscript)) {
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

function lintBrollPlacements(parsed, scenes, sceneById, errors) {
  const placements = Array.isArray(parsed.broll_placements) ? parsed.broll_placements : [];
  const allAroll = [];
  eachClip(scenes, (scene, i, clip) => {
    if (clipRoleOf(clip) === "a_roll" && clipHasWindow(clip)) allAroll.push(clip);
  });
  placements.forEach((p, k) => {
    if (!isPlainObject(p) || !isPlainObject(p.clip)) return;
    const ns = p.narration_span;
    if (!isPlainObject(ns) || !isFiniteNumber(ns.start_seconds) || !isFiniteNumber(ns.end_seconds)) return;
    const entry = isNonEmptyString(p.clip.scene_id) ? sceneById.get(p.clip.scene_id) : null;
    const sceneAroll = entry && Array.isArray(entry.scene.source_clips)
      ? entry.scene.source_clips.filter((c) => isPlainObject(c) && clipRoleOf(c) === "a_roll" && clipHasWindow(c))
      : [];
    const pool = sceneAroll.length > 0 ? sceneAroll : allAroll;
    const scopeLabel = sceneAroll.length > 0 ? `in scene "${p.clip.scene_id}"` : "anywhere in the storyboard";
    const overlaps = pool.some((c) => c.in_seconds < ns.end_seconds && c.out_seconds > ns.start_seconds);
    if (!overlaps) {
      errors.push({
        code: "PLAN_NARRATION_SPAN_OUTSIDE_SCENE",
        message: `broll_placements[${k}] narration_span ${round1(ns.start_seconds)}–${round1(ns.end_seconds)}s does not overlap any a_roll clip window ${scopeLabel}`,
        placement_index: k,
        scene_id: isNonEmptyString(p.clip.scene_id) ? p.clip.scene_id : null,
        data: { start_seconds: ns.start_seconds, end_seconds: ns.end_seconds },
      });
    }
    const refClip = resolvePlacementClip(p, sceneById);
    if (refClip && clipHasWindow(refClip)) {
      const clipDur = refClip.out_seconds - refClip.in_seconds;
      const spanDur = ns.end_seconds - ns.start_seconds;
      if (clipDur > spanDur + PLAN_LINT_THRESHOLDS.broll_span_tolerance_s) {
        errors.push({
          code: "PLAN_BROLL_LONGER_THAN_SPAN",
          message: `broll_placements[${k}] clip runs ${round1(clipDur)}s but covers a ${round1(spanDur)}s narration span — trim the b_roll clip to the span`,
          placement_index: k,
          scene_id: isNonEmptyString(p.clip.scene_id) ? p.clip.scene_id : null,
          clip_index: Number.isInteger(p.clip.clip_index) ? p.clip.clip_index : null,
          data: { clip_duration_seconds: clipDur, span_duration_seconds: spanDur },
        });
      }
    }
  });
}

// Hook-first/-length are RETENTION heuristics (social short-form) — the active
// ruleset (preset-driven) can disable either; long-form/cinematic/tutorial
// open however the format wants.
function warnHookShape(scenes, warnings, disabledRules) {
  const disabled = disabledRules instanceof Set ? disabledRules : new Set();
  const first = scenes.length > 0 && isPlainObject(scenes[0]) ? scenes[0] : null;
  if (!first) return;
  if (first.purpose !== "hook") {
    if (disabled.has("PLAN_HOOK_NOT_FIRST")) return;
    warnings.push({
      code: "PLAN_HOOK_NOT_FIRST",
      message: `scenes[0] has purpose "${first.purpose}" — short-form cuts should open on a hook scene`,
      scene_index: 0,
      scene_id: sceneIdOf(first),
      data: { purpose: typeof first.purpose === "string" ? first.purpose : null },
    });
  } else if (isFiniteNumber(first.target_duration_seconds) && first.target_duration_seconds > PLAN_LINT_THRESHOLDS.hook_max_s) {
    if (disabled.has("PLAN_HOOK_TOO_LONG")) return;
    warnings.push({
      code: "PLAN_HOOK_TOO_LONG",
      message: `hook scene is ${round1(first.target_duration_seconds)}s — hooks land in ≤3.5s; front-load the decisive moment`,
      scene_index: 0,
      scene_id: sceneIdOf(first),
      data: { target_duration_seconds: first.target_duration_seconds },
    });
  }
}

function warnDurations(parsed, scenes, targetSeconds, warnings) {
  const sceneSum = scenes.reduce(
    (acc, s) => acc + (isPlainObject(s) && isFiniteNumber(s.target_duration_seconds) ? s.target_duration_seconds : 0),
    0,
  );
  const total = isFiniteNumber(parsed.total_target_duration_seconds) ? parsed.total_target_duration_seconds : null;
  if (total !== null && Math.abs(sceneSum - total) > PLAN_LINT_THRESHOLDS.scene_sum_tolerance_s) {
    warnings.push({
      code: "PLAN_SCENE_SUM_MISMATCH",
      message: `scene durations sum to ${round1(sceneSum)}s but total_target_duration_seconds is ${round1(total)}s (Δ${round1(Math.abs(sceneSum - total))}s)`,
      data: { scene_sum_seconds: sceneSum, total_target_duration_seconds: total },
    });
  }
  if (total !== null && isFiniteNumber(targetSeconds) && targetSeconds > 0) {
    const ratio = Math.abs(total - targetSeconds) / targetSeconds;
    if (ratio > PLAN_LINT_THRESHOLDS.target_drift_ratio) {
      warnings.push({
        code: "PLAN_TARGET_DRIFT",
        message: `storyboard total ${round1(total)}s drifts ${Math.round(ratio * 100)}% from the ${round1(targetSeconds)}s target`,
        data: { total_target_duration_seconds: total, target_seconds: targetSeconds, drift_ratio: ratio },
      });
    }
  }
  scenes.forEach((scene, i) => {
    if (!isPlainObject(scene) || !Array.isArray(scene.source_clips)) return;
    if (!isFiniteNumber(scene.target_duration_seconds) || scene.target_duration_seconds <= 0) return;
    const aroll = scene.source_clips.filter((c) => isPlainObject(c) && clipRoleOf(c) === "a_roll" && clipHasWindow(c));
    if (aroll.length === 0) return;
    const sum = aroll.reduce((acc, c) => acc + (c.out_seconds - c.in_seconds), 0);
    const ratio = Math.abs(sum - scene.target_duration_seconds) / scene.target_duration_seconds;
    if (ratio > PLAN_LINT_THRESHOLDS.scene_clip_sum_ratio) {
      warnings.push({
        code: "PLAN_SCENE_CLIP_SUM_MISMATCH",
        message: `scenes[${i}] a_roll clips sum to ${round1(sum)}s vs scene target ${round1(scene.target_duration_seconds)}s (Δ${Math.round(ratio * 100)}%)`,
        scene_index: i,
        scene_id: sceneIdOf(scene),
        data: { aroll_sum_seconds: sum, target_duration_seconds: scene.target_duration_seconds, mismatch_ratio: ratio },
      });
    }
  });
}

function warnBrollHolds(scenes, warnings) {
  eachClip(scenes, (scene, i, clip, j) => {
    if (clipRoleOf(clip) !== "b_roll" || !clipHasWindow(clip)) return;
    const duration = clip.out_seconds - clip.in_seconds;
    if (duration < PLAN_LINT_THRESHOLDS.broll_min_hold_s) {
      warnings.push({
        code: "PLAN_BROLL_TOO_SHORT",
        message: `scenes[${i}].source_clips[${j}] b_roll holds only ${round1(duration)}s — under 1.5s reads as a glitch`,
        scene_index: i,
        scene_id: sceneIdOf(scene),
        clip_index: j,
        data: { duration_seconds: duration },
      });
    }
  });
}

function warnBrollRepeats(parsed, sceneById, warnings) {
  const placements = Array.isArray(parsed.broll_placements) ? parsed.broll_placements : [];
  const ordered = placements
    .map((p, k) => ({ p, k }))
    .filter(({ p }) => isPlainObject(p) && isPlainObject(p.clip))
    .map(({ p, k }) => {
      const nsStart = isPlainObject(p.narration_span) && isFiniteNumber(p.narration_span.start_seconds)
        ? p.narration_span.start_seconds
        : null;
      const insertAt = isFiniteNumber(p.insert_at_seconds) ? p.insert_at_seconds : null;
      return { p, k, sortKey: nsStart !== null ? nsStart : (insertAt !== null ? insertAt : k) };
    })
    .sort((a, b) => a.sortKey - b.sortKey);
  for (let n = 1; n < ordered.length; n += 1) {
    const prev = ordered[n - 1];
    const cur = ordered[n];
    const prevRef = prev.p.clip;
    const curRef = cur.p.clip;
    let repeated = isNonEmptyString(prevRef.scene_id) && prevRef.scene_id === curRef.scene_id
      && Number.isInteger(prevRef.clip_index) && prevRef.clip_index === curRef.clip_index;
    if (!repeated) {
      const a = resolvePlacementClip(prev.p, sceneById);
      const b = resolvePlacementClip(cur.p, sceneById);
      repeated = Boolean(
        a && b
        && isNonEmptyString(a.source_path) && a.source_path === b.source_path
        && clipHasWindow(a) && clipHasWindow(b)
        && a.in_seconds < b.out_seconds && a.out_seconds > b.in_seconds,
      );
    }
    if (repeated) {
      warnings.push({
        code: "PLAN_BROLL_REPEATED_BACK_TO_BACK",
        message: `broll_placements[${prev.k}] and [${cur.k}] reuse the same b_roll segment back-to-back — vary the cutaway`,
        placement_index: cur.k,
        scene_id: isNonEmptyString(curRef.scene_id) ? curRef.scene_id : null,
        data: {
          placement_indexes: [prev.k, cur.k],
          clip_index: Number.isInteger(curRef.clip_index) ? curRef.clip_index : null,
        },
      });
    }
  }
}

function warnKeyMomentCoverage(scenes, state, warnings) {
  const intent = state && isPlainObject(state.intent) ? state.intent : null;
  const answers = intent && isPlainObject(intent.answers) ? intent.answers : null;
  const rawMoments = answers ? intentAnswerRaw(answers.key_moments) : null;
  if (typeof rawMoments !== "string" || rawMoments === "") return;
  // Branch-A resolved format: "27.9–42.1s". 0 parseable ranges -> skip.
  const ranges = [];
  const re = /(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*s/g;
  let m;
  while ((m = re.exec(rawMoments)) !== null) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push({ start, end });
  }
  if (ranges.length === 0) return;
  const windows = [];
  eachClip(scenes, (scene, i, clip) => {
    if (clipHasWindow(clip)) windows.push(clip);
  });
  for (const range of ranges) {
    const covered = windows.some((c) => c.in_seconds < range.end && c.out_seconds > range.start);
    if (!covered) {
      warnings.push({
        code: "PLAN_KEY_MOMENT_UNCOVERED",
        message: `key moment ${round1(range.start)}–${round1(range.end)}s is not covered by any source clip — the user named this moment explicitly`,
        data: { start_seconds: range.start, end_seconds: range.end },
      });
    }
  }
}

// --- Typed-overlay plan lint (P3) ---------------------------------------------
// Overlay timings are SCENE-relative. Bounds violations are errors (the
// overlay would render outside its scene); the rest are craft warnings the
// human rules on at the plan gate.
const OVERLAY_DWELL_DEFAULT_S = 1.2;
const OVERLAY_BOUNDS_TOLERANCE_S = 0.05;
// Types that carry text the viewer must READ (dwell floor applies).
const OVERLAY_TEXT_TYPES = new Set([
  "title_card", "lower_third", "callout", "caption_block", "chapter_marker",
  "section_title", "data_viz", "cta", "end_card",
]);
// Types that fight for the same screen real estate: overlapping two from one
// group reads as collision.
const OVERLAY_CONFLICT_GROUPS = Object.freeze([
  { name: "bottom-band", types: new Set(["lower_third", "caption_block", "kinetic_caption", "cta"]) },
  { name: "full-frame", types: new Set(["title_card", "end_card"]) },
]);

function overlayLabel(overlay) {
  return `${overlay.type || "?"} "${overlay.id || "?"}"`;
}

function platformProfileFromState(state) {
  const answers = state && isPlainObject(state.intent) && isPlainObject(state.intent.answers)
    ? state.intent.answers
    : null;
  const tp = answers ? answers.target_platform : null;
  return isPlainObject(tp) && isPlainObject(tp.profile) ? tp.profile : null;
}

function lintOverlays(scenes, ctx, errors, warnings) {
  const resolveTranscript = typeof ctx.transcriptForFileIndex === "function" ? ctx.transcriptForFileIndex : null;
  const hasTranscript = Array.isArray(ctx.transcript) && ctx.transcript.length > 0;
  const profile = platformProfileFromState(ctx.state);
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene)) return;
    const overlays = typedOverlaysOf(scene).filter(
      (o) => isFiniteNumber(o.start_seconds) && isFiniteNumber(o.end_seconds) && o.end_seconds > o.start_seconds,
    );
    if (overlays.length === 0) return;
    const sceneDur = isFiniteNumber(scene.target_duration_seconds) ? scene.target_duration_seconds : null;

    for (const overlay of overlays) {
      // Bounds (error): the composer re-times scene-relative -> master; an
      // overlay past the scene end would bleed into the next scene or vanish.
      if (sceneDur !== null && overlay.end_seconds > sceneDur + OVERLAY_BOUNDS_TOLERANCE_S) {
        errors.push({
          code: "PLAN_OVERLAY_OUT_OF_BOUNDS",
          message: `scenes[${ix}] overlay ${overlayLabel(overlay)} runs ${round1(overlay.start_seconds)}–${round1(overlay.end_seconds)}s but the scene is only ${round1(sceneDur)}s — overlay timings are scene-relative and must fit inside the scene`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          overlay_id: overlay.id || null,
          data: { start_seconds: overlay.start_seconds, end_seconds: overlay.end_seconds, scene_duration_seconds: sceneDur },
        });
      }
      // Readability dwell (warning) on text-bearing types.
      const dwellMin = isPlainObject(overlay.motion) && isFiniteNumber(overlay.motion.dwell_min_s)
        ? overlay.motion.dwell_min_s
        : OVERLAY_DWELL_DEFAULT_S;
      const dur = overlay.end_seconds - overlay.start_seconds;
      if (OVERLAY_TEXT_TYPES.has(overlay.type) && dur < dwellMin) {
        warnings.push({
          code: "PLAN_OVERLAY_DWELL_TOO_SHORT",
          message: `scenes[${ix}] overlay ${overlayLabel(overlay)} shows for only ${round1(dur)}s — text needs ≥${round1(dwellMin)}s to read`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          overlay_id: overlay.id || null,
          data: { duration_seconds: dur, dwell_min_s: dwellMin },
        });
      }
      // Safe-area (warning): a bottom-anchored overlay with a y-offset inside
      // the platform's bottom UI band gets eaten by platform chrome.
      if (profile && isPlainObject(overlay.position) && typeof overlay.position.anchor === "string"
        && overlay.position.anchor.startsWith("bottom")
        && Array.isArray(overlay.position.offset_px) && isFiniteNumber(overlay.position.offset_px[1])
        && isFiniteNumber(profile.safe_bottom_px)
        && overlay.position.offset_px[1] < profile.safe_bottom_px) {
        warnings.push({
          code: "PLAN_OVERLAY_SAFE_AREA",
          message: `scenes[${ix}] overlay ${overlayLabel(overlay)} anchors ${overlay.position.anchor} at y-offset ${overlay.position.offset_px[1]}px — inside the platform's ${profile.safe_bottom_px}px bottom safe band (platform UI covers it)`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          overlay_id: overlay.id || null,
          data: { offset_px: overlay.position.offset_px, safe_bottom_px: profile.safe_bottom_px },
        });
      }
      // Kinetic captions sync to the transcript — a scene with no spoken words
      // has nothing to sync.
      if (overlay.type === "kinetic_caption" && hasTranscript && resolveTranscript
        && !clipHasSpokenWords(scene, resolveTranscript)) {
        warnings.push({
          code: "PLAN_KINETIC_CAPTION_NO_SPEECH",
          message: `scenes[${ix}] plans a kinetic_caption (${overlayLabel(overlay)}) but none of the scene's clips overlap transcript words — there is no speech to word-sync`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          overlay_id: overlay.id || null,
        });
      }
    }

    // Conflicting-type overlap (warning): two overlays from one real-estate
    // group active at the same moment.
    for (const group of OVERLAY_CONFLICT_GROUPS) {
      const members = overlays.filter((o) => group.types.has(o.type));
      for (let a = 0; a < members.length; a += 1) {
        for (let b = a + 1; b < members.length; b += 1) {
          const x = members[a];
          const y = members[b];
          if (x.start_seconds < y.end_seconds && y.start_seconds < x.end_seconds) {
            warnings.push({
              code: "PLAN_OVERLAY_CONFLICT",
              message: `scenes[${ix}] overlays ${overlayLabel(x)} and ${overlayLabel(y)} overlap in time and both occupy the ${group.name} — they will collide on screen`,
              scene_index: ix,
              scene_id: sceneIdOf(scene),
              data: { overlay_ids: [x.id || null, y.id || null], group: group.name },
            });
          }
        }
      }
    }
  });
}

// Per-render-unit <video> budget (warning): clips + planned PiP overlays. The
// caller picks the unit — the whole timeline normally, each declared segment
// when segments[] chunk the render, each short in fan-out (its scenes view).
function warnVideoBudget(scenes, label, warnings) {
  const budget = hostProfile.videoBudget();
  const count = scenes.reduce((acc, s) => acc + sceneVideoCount(s), 0);
  if (count > budget) {
    const pips = scenes.reduce(
      (acc, s) => acc + typedOverlaysOf(s).filter((o) => o.type === "pip").length,
      0,
    );
    warnings.push({
      code: "PLAN_VIDEO_BUDGET_EXCEEDED",
      message: `${label} plans ${count} <video> elements (${pips} from PiP overlays) against the host budget of ${budget} — composition QC will warn/error at COMPOSE; merge clips or drop PiPs`,
      data: { video_count: count, pip_count: pips, budget },
    });
  }
}

function warnCleanSpeechStraddles(scenes, cleanSpeech, warnings) {
  if (!isPlainObject(cleanSpeech) || !Array.isArray(cleanSpeech.keep_spans)) return;
  const removedEntries = Array.isArray(cleanSpeech.removed) ? cleanSpeech.removed : [];
  eachClip(scenes, (scene, i, clip, j) => {
    if (clipRoleOf(clip) !== "a_roll" || !clipHasWindow(clip)) return;
    if (clip.manifest_file_index !== cleanSpeech.file_index) return;
    const removed = removedWithin(cleanSpeech.keep_spans, clip.in_seconds, clip.out_seconds);
    // clean-cut emits gap cuts down to 0.18s and per-filler removals — exactly
    // what the storyboarder's <0.8s merge rule deliberately keeps, so those
    // must NOT warn.
    const bigRemovedInside = removedEntries.some((r) => isPlainObject(r)
      && isFiniteNumber(r.start) && isFiniteNumber(r.end)
      && r.start > clip.in_seconds && r.end < clip.out_seconds
      && (r.end - r.start) >= PLAN_LINT_THRESHOLDS.straddle_removed_min_s);
    if (removed.seconds > PLAN_LINT_THRESHOLDS.straddle_removed_min_s || bigRemovedInside) {
      warnings.push({
        code: "PLAN_CLIP_STRADDLES_REMOVED_SPAN",
        message: `scenes[${i}].source_clips[${j}] contains ${round1(removed.seconds)}s of removed dead-air/filler — snap the cuts to clean_speech keep-span boundaries (merged gaps under 0.8s are fine)`,
        scene_index: i,
        scene_id: sceneIdOf(scene),
        clip_index: j,
        data: { removed_seconds: removed.seconds, removed_intervals: removed.intervals },
      });
    }
  });
}

// context = { state, manifest, transcript, cleanSpeech, targetSeconds,
// lintRules } — all best-effort/nullable. lintRules (activeLintRules(state))
// gates the preset-dependent checks: hook heuristics under `retention` only,
// clean-speech straddles only when the preset's editorial.clean_cut is on.
// Absent lintRules => v2.1 behavior (every rule on). Returns
// { errors: Finding[], warnings: Finding[] }; Finding = { code, message,
// scene_id?, scene_index?, clip_index?, placement_index?, data? }. No cap here
// — the caller caps for display.
function lintStoryboardPlan(parsed, context) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(parsed)) {
    return { errors: [{ code: "PLAN_INVALID_DOCUMENT", message: "storyboard must be a JSON object" }], warnings };
  }
  const ctx = isPlainObject(context) ? context : {};
  const rules = isPlainObject(ctx.lintRules) ? ctx.lintRules : null;
  const disabled = rules && rules.disabled instanceof Set ? rules.disabled : new Set();
  const cleanCutOn = rules ? rules.clean_cut === true : true;
  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const sceneById = new Map();
  scenes.forEach((scene, ix) => {
    if (isPlainObject(scene) && isNonEmptyString(scene.scene_id)) sceneById.set(scene.scene_id, { scene, index: ix });
  });

  lintManifestBounds(scenes, ctx.manifest, errors);
  lintCaptionsOnSilent(scenes, ctx.transcript, errors, ctx.transcriptForFileIndex);
  lintBrollPlacements(parsed, scenes, sceneById, errors);
  lintOverlays(scenes, ctx, errors, warnings);

  // B-roll gaps: informational warnings, never blockers — the plan gate is
  // where the human decides "upload these N shots or hold on the spine".
  (Array.isArray(parsed.broll_placements) ? parsed.broll_placements : []).forEach((p, k) => {
    if (!isGapPlacement(p)) return;
    warnings.push({
      code: "PLAN_BROLL_GAP_UNFILLED",
      message: `broll_placements[${k}] wants coverage the ingested footage can't supply — "${typeof p.description === "string" ? p.description : "?"}" (~${isFiniteNumber(p.desired_duration_seconds) ? round1(p.desired_duration_seconds) : "?"}s for scene "${typeof p.scene_ref === "string" ? p.scene_ref : "?"}"). Upload matching footage and re-ingest (the PLAN→INGEST back-edge), or approve the plan without it.`,
      placement_index: k,
      scene_id: isNonEmptyString(p.scene_ref) ? p.scene_ref : null,
      data: {
        description: typeof p.description === "string" ? p.description : null,
        desired_duration_seconds: isFiniteNumber(p.desired_duration_seconds) ? p.desired_duration_seconds : null,
        scene_ref: isNonEmptyString(p.scene_ref) ? p.scene_ref : null,
      },
    });
  });

  warnHookShape(scenes, warnings, disabled);
  warnDurations(parsed, scenes, ctx.targetSeconds, warnings);
  warnBrollHolds(scenes, warnings);
  warnBrollRepeats(parsed, sceneById, warnings);
  // Budget per render unit: when segments[] chunk the render, the caller
  // (validateStoryboardContent) checks each segment instead — the whole-doc
  // sum may legitimately exceed the budget there.
  if (!storyboardHasSegments(parsed)) {
    warnVideoBudget(scenes, "the timeline", warnings);
  }
  // Fan-out runs key-moment coverage ONCE document-globally (a moment covered
  // by ANY short counts), not per short — see validateStoryboardContent.
  if (ctx.suppress_key_moment_check !== true) {
    warnKeyMomentCoverage(scenes, ctx.state, warnings);
  }
  if (cleanCutOn) {
    warnCleanSpeechStraddles(scenes, ctx.cleanSpeech, warnings);
  }

  return { errors, warnings };
}

// Chaptered-ruleset extras (long-form/tutorial/podcast presets). Single-timeline
// only — segments[] is mutually exclusive with shorts[].
const CHAPTERS_MISSING_MIN_TOTAL_S = 480; // ≥8 min without chapters is unnavigable
const SECTION_IMBALANCE_RATIO = 3;
const SECTION_IMBALANCE_MIN_S = 60;

function segmentDurationSeconds(segment, sceneById) {
  if (!isPlainObject(segment) || !Array.isArray(segment.scene_ids)) return null;
  let sum = 0;
  for (const sceneId of segment.scene_ids) {
    const entry = isNonEmptyString(sceneId) ? sceneById.get(sceneId) : null;
    const d = entry && isFiniteNumber(entry.scene.target_duration_seconds) ? entry.scene.target_duration_seconds : null;
    if (d === null) return null;
    sum += d;
  }
  return sum;
}

function lintChapterRules(parsed, warnings) {
  const total = isFiniteNumber(parsed.total_target_duration_seconds) ? parsed.total_target_duration_seconds : null;
  const segments = Array.isArray(parsed.segments) ? parsed.segments.filter(isPlainObject) : [];
  if (segments.length === 0) {
    if (total !== null && total >= CHAPTERS_MISSING_MIN_TOTAL_S) {
      warnings.push({
        code: "PLAN_CHAPTERS_MISSING",
        message: `a ${round1(total)}s video under a chaptered preset declares no segments[] — viewers can't navigate; add narrative acts/chapters (they also become YouTube chapter markers at PACKAGE)`,
        data: { total_target_duration_seconds: total },
      });
    }
    return;
  }
  if (segments.length >= 3) {
    const sceneById = new Map();
    (Array.isArray(parsed.scenes) ? parsed.scenes : []).forEach((scene, ix) => {
      if (isPlainObject(scene) && isNonEmptyString(scene.scene_id)) sceneById.set(scene.scene_id, { scene, index: ix });
    });
    const durations = segments
      .map((segment) => ({ segment, seconds: segmentDurationSeconds(segment, sceneById) }))
      .filter((entry) => entry.seconds !== null);
    if (durations.length >= 3) {
      const sorted = durations.map((e) => e.seconds).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      for (const { segment, seconds } of durations) {
        if (median > 0 && seconds > median * SECTION_IMBALANCE_RATIO && seconds - median >= SECTION_IMBALANCE_MIN_S) {
          warnings.push({
            code: "PLAN_SECTION_IMBALANCE",
            message: `segment "${segment.segment_id}" runs ${round1(seconds)}s vs a ${round1(median)}s median section — consider splitting it (sections over ${SECTION_IMBALANCE_RATIO}x the median read as a wall)`,
            segment_id: isNonEmptyString(segment.segment_id) ? segment.segment_id : null,
            data: { segment_seconds: seconds, median_seconds: median },
          });
        }
      }
    }
  }
}

// Context loaders — all best-effort: a missing/corrupt artifact silently
// disables its check (graceful absence is NEVER a blocker here).
function loadManifestDocument(state) {
  const manifestPath = state && isPlainObject(state.manifest) && typeof state.manifest.path === "string"
    ? state.manifest.path
    : null;
  if (!manifestPath) return null;
  try {
    return readJsonFile(manifestPath);
  } catch {
    return null;
  }
}

function loadCleanSpeech(state) {
  // WP3 stamps state.inspect.clean_speech_path; older sessions still write the
  // file on disk without the state field, so fall back to the canonical path.
  let file = state && isPlainObject(state.inspect) && typeof state.inspect.clean_speech_path === "string" && state.inspect.clean_speech_path
    ? state.inspect.clean_speech_path
    : null;
  if (!file) {
    try {
      const fallback = inspectCleanSpeechPath(state && state.project_id);
      if (fs.existsSync(fallback)) file = fallback;
    } catch {
      return null;
    }
  }
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = readJsonFile(file);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.keep_spans)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveTargetSeconds(state, parsed) {
  const intent = state && isPlainObject(state.intent) ? state.intent : null;
  const answers = intent && isPlainObject(intent.answers) ? intent.answers : null;
  const answer = answers ? answers.target_duration : undefined;
  if (isPlainObject(answer) && isFiniteNumber(answer.seconds)) return answer.seconds;
  const fromRaw = parseDurationToSeconds(intentAnswerRaw(answer));
  if (isFiniteNumber(fromRaw)) return fromRaw;
  if (isPlainObject(parsed.target) && isFiniteNumber(parsed.target.duration_seconds)) return parsed.target.duration_seconds;
  return null;
}

// Intent target-duration spec for fan-out lint: canonical object first, legacy
// raw-string parse second. { seconds, range, per_deliverable }.
function resolveIntentDurationSpec(state) {
  const intent = state && isPlainObject(state.intent) ? state.intent : null;
  const answers = intent && isPlainObject(intent.answers) ? intent.answers : null;
  const answer = answers ? answers.target_duration : undefined;
  if (isPlainObject(answer)) {
    return {
      seconds: isFiniteNumber(answer.seconds) ? answer.seconds : null,
      range: isPlainObject(answer.range)
        && isFiniteNumber(answer.range.min_seconds) && isFiniteNumber(answer.range.max_seconds)
        ? { min_seconds: answer.range.min_seconds, max_seconds: answer.range.max_seconds }
        : null,
      per_deliverable: answer.per_deliverable === true,
    };
  }
  return parseDurationSpec(intentAnswerRaw(answer));
}

// Global error: duplicate scene_ids anywhere in the document. Pre-cut clips
// are named <scene_id>-<clip_index>.mp4 and compose/source/ is one flat
// namespace, so a duplicate silently overwrites another scene's clip.
function lintDuplicateSceneIds(parsed) {
  const errors = [];
  const seen = new Map(); // scene_id -> first location label
  for (const timeline of storyboardTimelines(parsed)) {
    timeline.scenes.forEach((scene, ix) => {
      if (!isPlainObject(scene) || !isNonEmptyString(scene.scene_id)) return;
      const at = timeline.short_id !== null
        ? `shorts["${timeline.short_id}"].scenes[${ix}]`
        : `scenes[${ix}]`;
      const prior = seen.get(scene.scene_id);
      if (prior) {
        errors.push({
          code: "PLAN_DUPLICATE_SCENE_ID",
          message: `scene_id "${scene.scene_id}" at ${at} duplicates ${prior} — scene_ids must be unique across the whole storyboard (pre-cut clips are named <scene_id>-<clip_index>.mp4)`,
          scene_id: scene.scene_id,
          ...(timeline.short_id !== null ? { short_id: timeline.short_id } : {}),
        });
      } else {
        seen.set(scene.scene_id, at);
      }
    });
  }
  return errors;
}

function warnShortDurationRange(timeline, range, warnings) {
  const total = timeline.total_target_duration_seconds;
  if (!isFiniteNumber(total) || !range) return;
  const tol = PLAN_LINT_THRESHOLDS.short_duration_range_tolerance_s;
  if (total < range.min_seconds - tol || total > range.max_seconds + tol) {
    warnings.push({
      code: "PLAN_SHORT_DURATION_OUT_OF_RANGE",
      message: `short "${timeline.short_id}" totals ${round1(total)}s — outside the per-short target range ${round1(range.min_seconds)}–${round1(range.max_seconds)}s`,
      short_id: timeline.short_id,
      data: {
        total_target_duration_seconds: total,
        min_seconds: range.min_seconds,
        max_seconds: range.max_seconds,
      },
    });
  }
}

function tagFindingsWithShortId(findings, shortId) {
  if (shortId === null || shortId === undefined) return findings;
  return findings.map((f) => ({
    ...f,
    short_id: shortId,
    message: typeof f.message === "string" ? `[${shortId}] ${f.message}` : f.message,
  }));
}

function validateStoryboardContent(parsed, state) {
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["storyboard must be a JSON object"], warnings: [] };
  }
  const winnerTranscript = loadTranscript(state && state.inspect && state.inspect.transcript_path);
  // Preset-driven ruleset (retention/chaptered/montage/general) + the
  // clean-cut editorial flag, resolved once per validation pass.
  const lintRules = activeLintRules(isPlainObject(state) ? state : null);
  const baseContext = {
    state: isPlainObject(state) ? state : null,
    manifest: loadManifestDocument(state),
    transcript: winnerTranscript,
    transcriptForFileIndex: buildTranscriptResolver(state, winnerTranscript),
    cleanSpeech: loadCleanSpeech(state),
    lintRules,
  };
  const errors = [...lintDuplicateSceneIds(parsed)];
  const warnings = [];

  if (!storyboardHasShorts(parsed)) {
    const context = { ...baseContext, targetSeconds: resolveTargetSeconds(state, parsed) };
    const result = lintStoryboardPlan(parsed, context);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (lintRules.chapter_rules) {
      lintChapterRules(parsed, warnings);
    }
    // Segments chunk the render: the budget applies PER SEGMENT.
    if (storyboardHasSegments(parsed)) {
      for (const segment of storyboardSegments(parsed)) {
        warnVideoBudget(segment.scenes, `segment "${segment.segment_id}"`, warnings);
      }
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  // Fan-out: every check runs per short on a per-short view; findings carry
  // short_id and a [short_id] message prefix (codes unchanged, so the fix
  // recipes keyed on codes stay valid).
  const spec = resolveIntentDurationSpec(state);
  // Per-short drift target: the intent figure only when it IS per-short
  // (per_deliverable without a range); with a range the range check replaces
  // drift; otherwise target.duration_seconds is the per-short ideal.
  let perShortTarget = null;
  if (spec.range) perShortTarget = null;
  else if (spec.per_deliverable) perShortTarget = spec.seconds;
  else if (isPlainObject(parsed.target) && isFiniteNumber(parsed.target.duration_seconds)) {
    perShortTarget = parsed.target.duration_seconds;
  }

  for (const timeline of storyboardTimelines(parsed)) {
    const view = {
      ...parsed,
      scenes: timeline.scenes,
      total_target_duration_seconds: timeline.total_target_duration_seconds,
      broll_placements: timeline.broll_placements,
    };
    const result = lintStoryboardPlan(view, {
      ...baseContext,
      targetSeconds: perShortTarget,
      suppress_key_moment_check: true,
    });
    errors.push(...tagFindingsWithShortId(result.errors, timeline.short_id));
    warnings.push(...tagFindingsWithShortId(result.warnings, timeline.short_id));
    if (spec.range) warnShortDurationRange(timeline, spec.range, warnings);
  }
  warnKeyMomentCoverage(allStoryboardScenes(parsed), state, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_VERSIONS,
  RENDER_SEGMENTATIONS,
  PURPOSES,
  PACINGS,
  CLIP_ROLES,
  SCENE_TRANSITIONS,
  PLAN_LINT_THRESHOLDS,
  BROLL_RENDER_MODES,
  allStoryboardScenes,
  clipRoleOf,
  collectBrollGaps,
  expectedTimelineDurationSeconds,
  findTimeline,
  isGapPlacement,
  lintStoryboardPlan,
  sceneVideoCount,
  storyboardHasSegments,
  storyboardHasShorts,
  storyboardSegments,
  storyboardTimelines,
  typedOverlaysOf,
  validateStoryboard,
  validateStoryboardContent,
};
