"use strict";

const fs = require("fs");
const path = require("path");
const { removedWithin } = require("./clean-cut.js");
const { intentAnswerRaw } = require("./intent-schema.js");
const { inspectCleanSpeechPath } = require("./paths.js");
const { parseDurationSpec, parseDurationToSeconds } = require("./platform-profiles.js");
const { readJsonFile } = require("./storage.js");

const SCHEMA_VERSION = "1.0";
// 1.1 adds the optional top-level shorts[] (multi-short fan-out). A document
// with shorts[] MUST declare 1.1; scenes-form documents may use either.
const SCHEMA_VERSIONS = Object.freeze(["1.0", "1.1"]);
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

function validateScene(scene, ix, errors, wherePrefix = "") {
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

function validateBrollPlacementsList(placements, scenes, wherePrefix, errors) {
  if (placements === undefined || placements === null) return;
  if (!Array.isArray(placements)) {
    errors.push(`${wherePrefix}broll_placements must be an array when present`);
    return;
  }
  const sceneClips = buildSceneClipIndex(scenes);
  placements.forEach((p, ix) => {
    const where = `${wherePrefix}broll_placements[${ix}]`;
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

function validateBrollPlacements(input, errors) {
  validateBrollPlacementsList(input.broll_placements, input.scenes, "", errors);
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

function validateShort(short, ix, seenShortIds, errors) {
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
    short.scenes.forEach((scene, sceneIx) => validateScene(scene, sceneIx, errors, `${where}.`));
  }
  validateBrollPlacementsList(short.broll_placements, short.scenes, `${where}.`, errors);
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
  if (hasShorts && input.schema_version !== "1.1") {
    errors.push('schema_version must be "1.1" when shorts[] is present');
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
  if (hasShorts) {
    // Fan-out form: shorts[] carries the timelines; the top-level timeline
    // fields must be absent (one source of truth).
    if (!Array.isArray(input.shorts) || input.shorts.length === 0) {
      errors.push("shorts must be a non-empty array when present");
    } else {
      const seenShortIds = new Set();
      input.shorts.forEach((short, ix) => validateShort(short, ix, seenShortIds, errors));
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
      input.scenes.forEach((scene, ix) => validateScene(scene, ix, errors));
    }
    if (!isFiniteNumber(input.total_target_duration_seconds) || input.total_target_duration_seconds <= 0) {
      errors.push("total_target_duration_seconds must be a positive finite number");
    }
    validateBrollPlacements(input, errors);
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

function warnHookShape(scenes, warnings) {
  const first = scenes.length > 0 && isPlainObject(scenes[0]) ? scenes[0] : null;
  if (!first) return;
  if (first.purpose !== "hook") {
    warnings.push({
      code: "PLAN_HOOK_NOT_FIRST",
      message: `scenes[0] has purpose "${first.purpose}" — short-form cuts should open on a hook scene`,
      scene_index: 0,
      scene_id: sceneIdOf(first),
      data: { purpose: typeof first.purpose === "string" ? first.purpose : null },
    });
  } else if (isFiniteNumber(first.target_duration_seconds) && first.target_duration_seconds > PLAN_LINT_THRESHOLDS.hook_max_s) {
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

// context = { state, manifest, transcript, cleanSpeech, targetSeconds } — all
// best-effort/nullable. Returns { errors: Finding[], warnings: Finding[] };
// Finding = { code, message, scene_id?, scene_index?, clip_index?,
// placement_index?, data? }. No cap here — the caller caps for display.
function lintStoryboardPlan(parsed, context) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(parsed)) {
    return { errors: [{ code: "PLAN_INVALID_DOCUMENT", message: "storyboard must be a JSON object" }], warnings };
  }
  const ctx = isPlainObject(context) ? context : {};
  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const sceneById = new Map();
  scenes.forEach((scene, ix) => {
    if (isPlainObject(scene) && isNonEmptyString(scene.scene_id)) sceneById.set(scene.scene_id, { scene, index: ix });
  });

  lintManifestBounds(scenes, ctx.manifest, errors);
  lintCaptionsOnSilent(scenes, ctx.transcript, errors, ctx.transcriptForFileIndex);
  lintBrollPlacements(parsed, scenes, sceneById, errors);

  warnHookShape(scenes, warnings);
  warnDurations(parsed, scenes, ctx.targetSeconds, warnings);
  warnBrollHolds(scenes, warnings);
  warnBrollRepeats(parsed, sceneById, warnings);
  // Fan-out runs key-moment coverage ONCE document-globally (a moment covered
  // by ANY short counts), not per short — see validateStoryboardContent.
  if (ctx.suppress_key_moment_check !== true) {
    warnKeyMomentCoverage(scenes, ctx.state, warnings);
  }
  warnCleanSpeechStraddles(scenes, ctx.cleanSpeech, warnings);

  return { errors, warnings };
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
  const baseContext = {
    state: isPlainObject(state) ? state : null,
    manifest: loadManifestDocument(state),
    transcript: winnerTranscript,
    transcriptForFileIndex: buildTranscriptResolver(state, winnerTranscript),
    cleanSpeech: loadCleanSpeech(state),
  };
  const errors = [...lintDuplicateSceneIds(parsed)];
  const warnings = [];

  if (!storyboardHasShorts(parsed)) {
    const context = { ...baseContext, targetSeconds: resolveTargetSeconds(state, parsed) };
    const result = lintStoryboardPlan(parsed, context);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
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
  PURPOSES,
  PACINGS,
  CLIP_ROLES,
  SCENE_TRANSITIONS,
  PLAN_LINT_THRESHOLDS,
  allStoryboardScenes,
  clipRoleOf,
  expectedTimelineDurationSeconds,
  findTimeline,
  lintStoryboardPlan,
  storyboardHasShorts,
  storyboardTimelines,
  validateStoryboard,
  validateStoryboardContent,
};
