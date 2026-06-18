"use strict";

const fs = require("fs");
const path = require("path");
const { removedWithin } = require("./clean-cut.js");
const { intentAnswerRaw } = require("./intent-schema.js");
const { inspectCleanSpeechPath } = require("./paths.js");
const { parseDurationSpec, parseDurationToSeconds, parseSingleDuration, canonicalizePlatform } = require("./platform-profiles.js");
const { readJsonFile } = require("./storage.js");
const {
  activeLintRules,
  OVERLAY_TYPES,
  SEAM_TRANSITION_TYPES,
  isShaderTransition,
  resolveActiveVideoType,
  transitionDurationOf,
  transitionTypeOf,
} = require("./video-types.js");
const { glueDowngrades } = require("./transition-glue.js");
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
// Kinetic-caption animation styles the composer implements (caption_segments).
const CAPTION_ANIMATIONS = Object.freeze(["pop", "word-by-word", "karaoke"]);

const PURPOSE_SET = new Set(PURPOSES);
const PACING_SET = new Set(PACINGS);
const CLIP_ROLE_SET = new Set(CLIP_ROLES);
const SCENE_TRANSITION_SET = new Set(SCENE_TRANSITIONS);
const CAPTION_ANIMATION_SET = new Set(CAPTION_ANIMATIONS);
// "karaoke"/"word-by-word" highlight at the WORD level — they need frame-accurate
// per-word timing, which only forced alignment (INSPECT P1,
// state.inspect.transcript_aligned) produces. "pop" animates the whole chunk and
// tolerates approximate timing. The unaligned-karaoke plan-lint keys on this set.
const WORD_LEVEL_CAPTION_ANIMATIONS = new Set(["word-by-word", "karaoke"]);
// fast=2 / medium=1 / slow=0 — the rhythm-arc lint ranks scenes by pace.
const PACING_RANK = Object.freeze({ slow: 0, medium: 1, fast: 2 });

// Per-clip playback speed bounds (source_clips[i].speed). Beyond this range atempo
// chains get long and the footage reads as unusable; default is 1 (no change).
const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;

// Multi-cell layouts (split-screen / multi-crop — e.g. a 2-up speaker stack,
// before/after, reaction PiP). A scene.layout composites its named source_clips
// into ONE pre-rendered clip at COMPOSE entry (layout-materialize.js), so the
// composition references a single <video> regardless of cell count — keeping the
// host <video> budget honest AND sidestepping the multi-<video> render fragility
// that drove this footage off-rails. Loosely validated + FAIL-SAFE (like
// transition_in / target.design): a malformed layout NEVER rejects the save —
// plan-lint WARNS (PLAN_LAYOUT_*) and the materializer degrades (the composer
// then falls back to CSS-positioned cells). Advisory at COMPOSE QC (no hard
// binding, unlike a typed overlay).
const LAYOUT_TYPES = Object.freeze(["split_horizontal", "split_vertical", "grid_2x2", "pip"]);
const LAYOUT_TYPE_SET = new Set(LAYOUT_TYPES);
// Canonical cell count per layout type (the plan-lint cell-count check).
const LAYOUT_CELL_COUNTS = Object.freeze({ split_horizontal: 2, split_vertical: 2, grid_2x2: 4, pip: 2 });

function clipRoleOf(clip) {
  return clip && typeof clip.role === "string" && clip.role.trim() ? clip.role : "a_roll";
}

// A clip's normalized speed (default 1 for absent/invalid) — kept in lockstep with
// ffmpeg-runner.js::normalizeClipSpeed so the lint's computed output duration equals
// the materialized FILE length.
function clipSpeedOf(clip) {
  return clip && isFiniteNumber(clip.speed) && clip.speed > 0 ? clip.speed : 1;
}

// A clip's OUTPUT (on-screen) duration: raw source span / speed. THE single helper
// every "raw span vs authored output target" lint must use, or a sped clip
// false-rejects (its raw span no longer equals its on-timeline footprint).
function effectiveClipDuration(clip) {
  if (!isPlainObject(clip) || !isFiniteNumber(clip.in_seconds) || !isFiniteNumber(clip.out_seconds)) return 0;
  return (clip.out_seconds - clip.in_seconds) / clipSpeedOf(clip);
}

// A scene's multi-cell layout when it is STRUCTURALLY a layout — scene.layout is
// an object with a non-empty `type` string and ≥2 cells each carrying a
// non-negative integer clip_index. Returns the normalized layout (type, cells,
// audio_cell, gap_px, background) or null. The single accessor every layout
// consumer (sceneVideoCount, plan-lint, the materializer, the symlinker) uses,
// so "what counts as a layout scene" is defined once. Note this is intentionally
// loose: an off-vocabulary type or out-of-range clip_index still parses (so the
// materializer can try/degrade and plan-lint can warn specifically) — full
// validity is the plan-lint's job (warnLayouts), not this accessor's.
function sceneLayoutOf(scene) {
  if (!isPlainObject(scene) || !isPlainObject(scene.layout)) return null;
  const layout = scene.layout;
  if (!isNonEmptyString(layout.type) || !Array.isArray(layout.cells)) return null;
  const cells = layout.cells
    .filter((c) => isPlainObject(c) && Number.isInteger(c.clip_index) && c.clip_index >= 0)
    .map((c) => ({ clip_index: c.clip_index, fit: isNonEmptyString(c.fit) ? c.fit : "cover" }));
  if (cells.length < 2) return null;
  return {
    type: layout.type,
    cells,
    audio_cell: Number.isInteger(layout.audio_cell) && layout.audio_cell >= 0 ? layout.audio_cell : 0,
    gap_px: isFiniteNumber(layout.gap_px) && layout.gap_px >= 0 ? layout.gap_px : 0,
    background: isNonEmptyString(layout.background) ? layout.background : null,
  };
}

// <video> elements a scene costs the composition: one per source clip plus one
// per planned PiP overlay (a pip carries a <video> by definition). The single
// budget-accounting function — render-segments chunking and plan lint both use
// it, so a PiP-heavy segment auto-splits and over-budget plans warn early.
// A layout scene composites its cells into ONE pre-rendered clip at COMPOSE
// entry (layout-materialize.js), so it costs a SINGLE <video> regardless of how
// many cells it stacks — that is the whole point of the layout primitive (a
// 2-up speaker stack is 1 element, not 2, so it fits the host budget and dodges
// the multi-<video> render fragility).
function sceneVideoCount(scene) {
  if (!scene || typeof scene !== "object") return 0;
  const clips = sceneLayoutOf(scene)
    ? 1
    : (Array.isArray(scene.source_clips) ? scene.source_clips.length : 0);
  const pips = Array.isArray(scene.overlays)
    ? scene.overlays.filter((o) => o !== null && typeof o === "object" && !Array.isArray(o) && o.type === "pip").length
    : 0;
  return clips + pips;
}

// A scene's on-screen A-roll seconds. Normal scenes play their a_roll clips
// SEQUENTIALLY → the effective-duration SUM. A LAYOUT scene plays its cells
// CONCURRENTLY (the composite's length is the longest cell) → the MAX over the
// layout cells. Using this everywhere a "scene's a_roll length" is needed keeps
// the duration lints from double-counting a split-screen's stacked clips.
function sceneArollOutputSeconds(scene) {
  if (!isPlainObject(scene) || !Array.isArray(scene.source_clips)) return 0;
  const layout = sceneLayoutOf(scene);
  if (layout) {
    let max = 0;
    for (const cell of layout.cells) {
      const clip = scene.source_clips[cell.clip_index];
      if (isPlainObject(clip) && clipHasWindow(clip)) max = Math.max(max, effectiveClipDuration(clip));
    }
    return max;
  }
  let sum = 0;
  for (const c of scene.source_clips) {
    if (isPlainObject(c) && clipRoleOf(c) === "a_roll" && clipHasWindow(c)) sum += effectiveClipDuration(c);
  }
  return sum;
}

// A scene's TOTAL on-screen seconds, for whole-cut feasibility — broader than
// sceneArollOutputSeconds (which is a_roll-only, for the a_roll-vs-target check).
// A scene can legitimately be filled by full-frame b_roll with NO a_roll spine
// (the scene-clip-sum lint skips those), so feasibility must count them or it
// false-flags a b-roll-driven cut as too short. Precedence: layout (max cell) →
// a_roll spine sum → full-frame footage sum (b_roll/other, no a_roll) →
// target_duration_seconds (a clipless overlay/title card — authored length, no
// footage to derive from, so never penalize it).
function sceneOutputSeconds(scene) {
  if (!isPlainObject(scene)) return 0;
  const aroll = sceneArollOutputSeconds(scene);
  if (aroll > 0) return aroll; // layout or a_roll spine governs the length
  const clips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
  let footage = 0;
  for (const c of clips) {
    if (isPlainObject(c) && clipHasWindow(c)) footage += effectiveClipDuration(c);
  }
  if (footage > 0) return footage; // full-frame b_roll-driven scene
  return isFiniteNumber(scene.target_duration_seconds) && scene.target_duration_seconds > 0
    ? scene.target_duration_seconds
    : 0;
}

// (v3.8) The REALIZED on-screen duration of a scope's scenes — the speed/layout-
// baked cut the composer actually builds, summed via sceneOutputSeconds. This is
// what render drift verification should expect (NOT the declared
// total_target_duration_seconds, which is the plan's aspiration and legitimately
// differs — the whole reason PLAN_DURATION_INFEASIBLE exists). Returns 0 when no
// scene resolves, so callers fall back to the declared total.
function realizedScopeDurationSeconds(scenes) {
  if (!Array.isArray(scenes)) return 0;
  let total = 0;
  for (const scene of scenes) total += sceneOutputSeconds(scene);
  return Math.round(total * 1000) / 1000;
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
  // Optional per-clip playback speed (default 1; >1 faster, <1 slow-mo). Baked into
  // the materialized clip via setpts/atempo, so the clip's OUTPUT (on-screen) length
  // is (out-in)/speed. Bounded to a sane editorial range — beyond it atempo chains
  // get long and the footage is unusable.
  if (clip.speed !== undefined && clip.speed !== null
    && (!isFiniteNumber(clip.speed) || clip.speed < SPEED_MIN || clip.speed > SPEED_MAX)) {
    errors.push(`${where}.speed must be a number in [${SPEED_MIN}, ${SPEED_MAX}] when present (1 = normal; 0.5 = half-speed slow-mo; 2 = double-speed)`);
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

// Object-form caption_segments from a scene (non-objects filtered out) — the
// mode-agnostic accessor COMPOSE QC + consumers read (mirror typedOverlaysOf).
function captionSegmentsOf(scene) {
  if (!isPlainObject(scene) || !Array.isArray(scene.caption_segments)) return [];
  return scene.caption_segments.filter((s) => isPlainObject(s));
}

// Optional per-scene caption_segments (SOURCE-time): the storyboarder's timed
// caption plan — now a first-class, lint-bound layer. No cross-check against
// `captions` — that string stays the human-readable summary. All the v3 fields
// (emphasis_words / animation / style_ref / position) are optional and additive
// (no schema-version gate, same as target.fps); plain {text,start,end,emphasis?}
// stays valid forever.
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
  // emphasis_words: which words inside `text` the composer animates/colors.
  if (seg.emphasis_words !== undefined && seg.emphasis_words !== null) {
    if (!Array.isArray(seg.emphasis_words) || !seg.emphasis_words.every((w) => isNonEmptyString(w))) {
      errors.push(`${where}.emphasis_words must be an array of non-empty strings when present`);
    }
  }
  if (seg.animation !== undefined && seg.animation !== null && !CAPTION_ANIMATION_SET.has(seg.animation)) {
    errors.push(`${where}.animation must be one of: ${CAPTION_ANIMATIONS.join(", ")} when present`);
  }
  // style_ref: a freeform handle into the design system's caption look (e.g. a
  // target.design caption_style name); the composer interprets it.
  if (seg.style_ref !== undefined && seg.style_ref !== null && !isNonEmptyString(seg.style_ref)) {
    errors.push(`${where}.style_ref must be a non-empty string when present`);
  }
  if (seg.position !== undefined && seg.position !== null) {
    const p = seg.position;
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
  // Optional binding id + `exact` opt-in (caption binding). An authored `id`
  // lands in data-vob-caption-id and makes the caption checkable in COMPOSE QC;
  // `exact:true` upgrades a missing binding from a warning to an error and so
  // REQUIRES an id (a hard contract needs a stable handle). Both optional and
  // additive — plain {text,start,end} stays valid forever. id reuses the
  // overlay attribute-safe shape; ids are document-globally unique (validated in
  // validateStoryboard, a namespace separate from overlay ids).
  if (seg.id !== undefined && seg.id !== null && !OVERLAY_ID_RE.test(String(seg.id))) {
    errors.push(`${where}.id must be a short attribute-safe string (letters/digits/._:-, e.g. "cap-1")`);
  }
  if (seg.exact !== undefined && seg.exact !== null && typeof seg.exact !== "boolean") {
    errors.push(`${where}.exact must be a boolean when present`);
  }
  if (seg.exact === true && !isNonEmptyString(seg.id)) {
    errors.push(`${where}.exact:true is a binding contract — it must carry an attribute-safe \`id\` (the composer stamps it as data-vob-caption-id)`);
  }
}

// Optional target.design: a machine-readable mirror of the brief's Design
// language section — structured look tokens the composer renders from (and
// --like copies verbatim instead of "mirror the vibe"). Additive and
// non-version-gated like target.fps. Loosely shape-checked on purpose: there is
// NO engine-side font allowlist (the only font constraint is hyperframes' own
// lint — see the font-kit invariant), and caption_style/motion/grade are
// freeform conventions, not enums, so the brief's tone table can grow without a
// schema edit. Every field is optional.
function validateDesign(design, errors, where = "target.design") {
  if (!isPlainObject(design)) {
    errors.push(`${where} must be an object when present`);
    return;
  }
  for (const block of ["palette", "typography"]) {
    if (design[block] === undefined || design[block] === null) continue;
    if (!isPlainObject(design[block])) {
      errors.push(`${where}.${block} must be an object when present`);
      continue;
    }
    for (const [k, v] of Object.entries(design[block])) {
      if (v !== undefined && v !== null && !isNonEmptyString(v)) {
        errors.push(`${where}.${block}.${k} must be a non-empty string when present (${block === "palette" ? "hex or CSS color" : "a font-kit family name"})`);
      }
    }
  }
  for (const field of ["caption_style", "motion", "grade"]) {
    if (design[field] !== undefined && design[field] !== null && !isNonEmptyString(design[field])) {
      errors.push(`${where}.${field} must be a non-empty string when present`);
    }
  }
}

// Optional target.distribution: post-copy metadata the packager surfaces at
// PACKAGE / import (title/description/hashtags/cta the human pastes into the
// upload form). Additive and non-version-gated like target.design/target.fps,
// loosely shape-checked on purpose: distribution is advisory creative copy, so
// it NEVER lints and never gates — only a malformed *shape* rejects at save.
// Every field is optional.
function validateDistribution(distribution, errors, where = "target.distribution") {
  if (!isPlainObject(distribution)) {
    errors.push(`${where} must be an object when present`);
    return;
  }
  for (const field of ["title", "description", "cta"]) {
    if (distribution[field] !== undefined && distribution[field] !== null && !isNonEmptyString(distribution[field])) {
      errors.push(`${where}.${field} must be a non-empty string when present`);
    }
  }
  if (distribution.hashtags !== undefined && distribution.hashtags !== null) {
    if (!Array.isArray(distribution.hashtags)) {
      errors.push(`${where}.hashtags must be an array of non-empty strings when present`);
    } else {
      distribution.hashtags.forEach((tag, ix) => {
        if (!isNonEmptyString(tag)) {
          errors.push(`${where}.hashtags[${ix}] must be a non-empty string`);
        }
      });
    }
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
  // transition_in / transition_out (v3.3): widened to the typed transition layer
  // — a string in the active vocabulary OR an object { type, duration_seconds?,
  // direction?, intensity? }. Validation is LOOSE and FAIL-SAFE (mirrors
  // target.design): an unknown / off-vocabulary / wrong-typed value NEVER rejects
  // the save — it falls back to a hard cut and plan-lint WARNS (PLAN_TRANSITION_*).
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
//   subject (v3.3) — a real clip MATTED off its filmed background (hyperframes
//                  remove-background) and composited over a declared `backdrop`.
//                  A concrete clip-referencing placement (never a gap); the
//                  matte is a content-hash-cached COMPOSE-entry side effect.
const BROLL_RENDER_MODES = Object.freeze(["full_frame", "pip", "overlay", "subject"]);
const BROLL_RENDER_MODE_SET = new Set(BROLL_RENDER_MODES);

// Backdrop kinds a subject (render_mode:"subject") may be composited onto.
// design_token (a solid/gradient/target.design palette key) | clip_ref (another
// INGESTED clip already in the plan, {scene_id, clip_index}) | scene_base (the
// subject scene's own first clip). NO synthesized/stock/AI backdrops — the same
// ingested-only contract as the B-roll gap rule. The enum is enforced as a
// human-visible plan-lint WARNING (PLAN_SUBJECT_BACKDROP_NOT_INGESTED), not a
// hard shape error, so the "no synthesized backdrop" rule is legible at the gate.
const BACKDROP_KINDS = Object.freeze(["design_token", "clip_ref", "scene_base"]);
const BACKDROP_KIND_SET = new Set(BACKDROP_KINDS);

// Shape-check a subject placement's backdrop. SHAPE ONLY — the kind-enum +
// ingested-resolution semantics are the plan lint's job (a warning, never a
// block), so a synthesized-backdrop kind reaches the human at the gate rather
// than silently rejecting the save. Here we only reject a structurally broken
// backdrop (a subject with nothing to composite onto, or a mistyped field).
function validateBackdrop(backdrop, where, errors) {
  if (!isPlainObject(backdrop)) {
    errors.push(`${where} is required for render_mode:"subject" and must be an object { kind, ... }`);
    return;
  }
  if (backdrop.kind !== undefined && backdrop.kind !== null && !isNonEmptyString(backdrop.kind)) {
    errors.push(`${where}.kind must be a non-empty string when present`);
  }
  // For a RECOGNIZED kind, enforce its required field as a SHAPE error — a
  // recognized-but-incomplete backdrop renders WRONG (a fill-less design_token
  // silently falls back to black; a clip-less clip_ref has no base). An
  // UNRECOGNIZED/missing kind is NOT a shape error — the plan lint warns
  // PLAN_SUBJECT_BACKDROP_NOT_INGESTED (the human-visible ingested-only guard; a
  // bad kind WARNS and the save stands, per the PRD contract).
  if (backdrop.kind === "design_token" && !isNonEmptyString(backdrop.fill)) {
    errors.push(`${where}.fill is required for a design_token backdrop (a target.design palette key, a #hex, or a CSS gradient)`);
  }
  if (backdrop.kind === "clip_ref" && !isPlainObject(backdrop.clip)) {
    errors.push(`${where}.clip is required for a clip_ref backdrop — { scene_id, clip_index }`);
  }
  if (backdrop.fill !== undefined && backdrop.fill !== null && !isNonEmptyString(backdrop.fill)) {
    errors.push(`${where}.fill must be a non-empty string when present (a target.design palette key, a #hex, or a CSS gradient)`);
  }
  if (backdrop.clip !== undefined && backdrop.clip !== null) {
    const ref = backdrop.clip;
    if (!isPlainObject(ref) || !isNonEmptyString(ref.scene_id) || !Number.isInteger(ref.clip_index) || ref.clip_index < 0) {
      errors.push(`${where}.clip must be { scene_id, clip_index } (clip_index a non-negative integer) when present`);
    }
  }
  if (backdrop.blur_px !== undefined && backdrop.blur_px !== null
    && (!isFiniteNumber(backdrop.blur_px) || backdrop.blur_px < 0)) {
    errors.push(`${where}.blur_px must be a non-negative finite number when present`);
  }
}

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
      } else if (isPlainObject(p.motion)) {
        // Object form (subject in/out transitions): { in?, out? } — reuses the
        // overlay motion vocabulary. Freeform-string treatment notes ("ken_burns",
        // "speed_ramp") stay valid for the rectangular render modes.
        for (const field of ["in", "out"]) {
          if (p.motion[field] !== undefined && p.motion[field] !== null && !isNonEmptyString(p.motion[field])) {
            errors.push(`${where}.motion.${field} must be a non-empty string when present`);
          }
        }
      } else if (!isNonEmptyString(p.motion)) {
        errors.push(`${where}.motion must be a non-empty string (treatment note) or an object { in?, out? } when present`);
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
      if (p.render_mode === "subject") {
        errors.push(`${where} declares render_mode:"subject" but is a gap — subject compositing needs a real clip to matte, not a coverage wish (use a concrete clip placement)`);
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
    // Subject compositing (render_mode:"subject"): a concrete clip matted off its
    // background and composited over a `backdrop`. The clip ref above is the
    // subject footage; here we shape-check the backdrop + on-backdrop placement.
    if (p.render_mode === "subject") {
      validateBackdrop(p.backdrop, `${where}.backdrop`, errors);
      if (p.position !== undefined && p.position !== null) {
        const pos = p.position;
        if (!isPlainObject(pos)) {
          errors.push(`${where}.position must be an object when present`);
        } else {
          if (pos.anchor !== undefined && pos.anchor !== null && !OVERLAY_ANCHOR_SET.has(pos.anchor)) {
            errors.push(`${where}.position.anchor must be one of: ${OVERLAY_ANCHORS.join(", ")}`);
          }
          if (pos.scale !== undefined && pos.scale !== null
            && (!isFiniteNumber(pos.scale) || pos.scale <= 0 || pos.scale > 1)) {
            errors.push(`${where}.position.scale must be a number in (0, 1] when present (fraction of the frame the subject fills)`);
          }
          if (pos.offset_px !== undefined && pos.offset_px !== null
            && (!Array.isArray(pos.offset_px) || pos.offset_px.length !== 2 || !pos.offset_px.every((n) => isFiniteNumber(n)))) {
            errors.push(`${where}.position.offset_px must be a [x, y] pair of finite numbers when present`);
          }
        }
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

// --- Subject compositing (schema 1.2 render_mode, v3.3) ----------------------
function isSubjectPlacement(p) {
  return isPlainObject(p) && p.render_mode === "subject" && !isGapPlacement(p);
}

// Every subject placement across both document forms, normalized for the matte
// materializer (matte-materialize.js) and the compose/source symlinker. Each
// entry resolves to the pre-cut clip key (scene_id, clip_index) the matte is
// lifted from, plus its OUTPUT seconds (raw span / speed) for the host budget.
// Fan-out-aware (mirrors collectBrollGaps): scene_ids are document-globally
// unique, so (scene_id, clip_index) is an unambiguous matte key across shorts.
function collectSubjectPlacements(parsed) {
  const out = [];
  for (const timeline of storyboardTimelines(parsed)) {
    const clipsByScene = new Map();
    for (const scene of timeline.scenes) {
      if (isPlainObject(scene) && isNonEmptyString(scene.scene_id)) {
        clipsByScene.set(scene.scene_id, Array.isArray(scene.source_clips) ? scene.source_clips : []);
      }
    }
    timeline.broll_placements.forEach((p, ix) => {
      if (!isSubjectPlacement(p)) return;
      const ref = isPlainObject(p.clip) ? p.clip : null;
      const sceneId = ref && isNonEmptyString(ref.scene_id) ? ref.scene_id : null;
      const clipIndex = ref && Number.isInteger(ref.clip_index) ? ref.clip_index : null;
      const sceneClips = sceneId && clipsByScene.has(sceneId) ? clipsByScene.get(sceneId) : null;
      const clip = sceneClips && clipIndex !== null && clipIndex >= 0 && clipIndex < sceneClips.length
        ? sceneClips[clipIndex]
        : null;
      out.push({
        short_id: timeline.short_id,
        placement_index: ix,
        scene_id: sceneId,
        clip_index: clipIndex,
        backdrop: isPlainObject(p.backdrop) ? p.backdrop : null,
        position: isPlainObject(p.position) ? p.position : null,
        motion: p.motion !== undefined ? p.motion : null,
        clip_seconds: isPlainObject(clip) ? effectiveClipDuration(clip) : null,
        resolved: Boolean(clip),
      });
    });
  }
  return out;
}

// --- Multi-cell layouts (split-screen / multi-crop, v3.4) --------------------
// Every scene carrying a usable scene.layout, normalized for the layout
// materializer (layout-materialize.js) and the compose/source symlinker. Each
// entry resolves its cells to (scene_id, clip_index) keys into the already-pre-
// cut clips the composite is built from. Fan-out-aware (mirrors
// collectSubjectPlacements): scene_ids are document-globally unique, so a scene
// is an unambiguous layout key across shorts.
function collectSceneLayouts(parsed) {
  const out = [];
  for (const timeline of storyboardTimelines(parsed)) {
    for (const scene of timeline.scenes) {
      const layout = sceneLayoutOf(scene);
      if (!layout) continue;
      const clips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
      out.push({
        short_id: timeline.short_id,
        scene_id: scene.scene_id,
        type: layout.type,
        cells: layout.cells,
        audio_cell: layout.audio_cell,
        gap_px: layout.gap_px,
        background: layout.background,
        source_clips_count: clips.length,
        // Whether every cell resolves to a real source clip — the materializer
        // skips (degrades) a layout whose cell points past source_clips.
        resolved: layout.cells.every((c) => c.clip_index < clips.length),
      });
    }
  }
  return out;
}

// Normalize a storyboard's target.distribution into the post-copy block the
// packager (and the fan-out deliverables manifest) emit. Chapters-agnostic on
// purpose: chapters_paste_block is a single-timeline/segmented concept layered
// on by package-output.js (the one place with chapters); fan-out shorts carry
// no document-level segments. Returns null only when distribution is entirely
// absent/not-a-plain-object; otherwise the normalized block, even with some
// null fields, so an editor sees which fields the storyboarder filled.
function distributionFromStoryboard(sb) {
  const d = sb && isPlainObject(sb.target) ? sb.target.distribution : undefined;
  if (!isPlainObject(d)) return null;
  const hashtags = Array.isArray(d.hashtags)
    ? d.hashtags.filter((t) => isNonEmptyString(t)).map((t) => t.trim())
    : [];
  return {
    title: isNonEmptyString(d.title) ? d.title : null,
    description: isNonEmptyString(d.description) ? d.description : null,
    hashtags,
    hashtags_line: hashtags.length > 0 ? hashtags.join(" ") : null,
    cta: isNonEmptyString(d.cta) ? d.cta : null,
  };
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
    // segment.transition_out is the render-chunk SEAM (cut/fade/dip). A non-seam
    // value is normalized to a dip-to-black "fade" at the render plan
    // (transition-glue::seamOf), not rejected (PRD-02 §7.3) — only a non-string
    // is malformed.
    if (segment.transition_out !== undefined && segment.transition_out !== null
      && typeof segment.transition_out !== "string") {
      errors.push(`${where}.transition_out must be a string when present (a render seam: "cut" or "fade")`);
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
    // v3: optional structured design tokens (mirror of the brief Design language).
    if (input.target.design !== undefined && input.target.design !== null) {
      validateDesign(input.target.design, errors);
    }
    // PACKAGE-phase post-copy metadata (title/description/hashtags/cta).
    // Loosely shape-checked, never linted/gated — same family as target.design.
    if (input.target.distribution !== undefined && input.target.distribution !== null) {
      validateDistribution(input.target.distribution, errors);
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
  // Authored caption_segment ids are DOCUMENT-global too (they become
  // data-vob-caption-id element bindings; COMPOSE QC matches by id across the
  // composition). Separate namespace from overlay ids. Only AUTHORED ids are
  // checked — id-less captions stay freeform.
  {
    const seenCaptionIds = new Map();
    for (const timeline of storyboardTimelines(input)) {
      timeline.scenes.forEach((scene, ix) => {
        for (const seg of captionSegmentsOf(scene)) {
          if (!isNonEmptyString(seg.id)) continue;
          const at = timeline.short_id !== null
            ? `shorts["${timeline.short_id}"].scenes[${ix}]`
            : `scenes[${ix}]`;
          const prior = seenCaptionIds.get(seg.id);
          if (prior) {
            errors.push(`caption id "${seg.id}" at ${at} duplicates ${prior} — caption ids must be unique across the document`);
          } else {
            seenCaptionIds.set(seg.id, at);
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
  caption_chunk_max_words: 7,
  caption_chunk_max_chars: 42,
  caption_window_tolerance_s: 0.1,
  // (v3.4) Significant reuse of the same source seconds by two a_roll clips —
  // the "pulled-forward hook overlapped the body / repeated whole lines" defect.
  // Small overlaps (a few frames at a cut) are intentional and below this floor.
  clip_span_overlap_min_s: 0.75,
  // (v3.4) Caption-text-vs-transcript content fit. A caption whose content words
  // largely DON'T appear in the words actually spoken in its chosen source window
  // is captioning the wrong span. Deliberately permissive (paraphrase/cleanup is
  // legitimate) — only a STRONG mismatch warns, and only when there is enough
  // speech + enough caption text to judge.
  caption_text_match_min_ratio: 0.34,
  caption_text_min_content_words: 3,
  // (v3.4) Repeated whole caption lines across scenes (substantial lines only).
  caption_repeat_min_content_words: 4,
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
      // OUTPUT play length (raw span / speed): a 4s clip at 2x plays 2s on screen
      // and correctly fits a 2.5s narration span.
      const clipDur = effectiveClipDuration(refClip);
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

// (v3.8) Retention-only: a hook scene that opens on footage with NO spoken words
// rarely retains — the first ~3s want a verbal claim/question. Ruleset-gated
// (off for chaptered/montage/general, like the other hook rules) and fail-safe
// (no transcript → skip; overlay-only hook → skip).
function warnHookNoSpeech(scenes, ctx, disabledRules, warnings) {
  const disabled = disabledRules instanceof Set ? disabledRules : new Set();
  if (disabled.has("PLAN_HOOK_NO_SPEECH")) return;
  const first = scenes.length > 0 && isPlainObject(scenes[0]) ? scenes[0] : null;
  if (!first || first.purpose !== "hook") return;
  if (!Array.isArray(ctx.transcript) || ctx.transcript.length === 0) return;
  if (!Array.isArray(first.source_clips) || first.source_clips.length === 0) return;
  const resolveTranscript = typeof ctx.transcriptForFileIndex === "function"
    ? ctx.transcriptForFileIndex
    : () => ctx.transcript;
  if (!clipHasSpokenWords(first, resolveTranscript)) {
    warnings.push({
      code: "PLAN_HOOK_NO_SPEECH",
      message: `the hook scene (scenes[0]) opens on footage with no spoken words — under retention, a verbal claim/question in the first ~3s is the strongest hook; open on a spoken line, or add a caption/VO that states the hook`,
      scene_index: 0,
      scene_id: sceneIdOf(first),
    });
  }
}

// Rhythm-arc lints over the existing scene `pacing` field (no schema change).
//   PLAN_PACING_MONOTONE — ≥4 scenes all the SAME pace read as a flat edit
//     (universal: an all-identical pacing track is monotonous in any format).
//   PLAN_RHYTHM_ARC_INVERTED — the opening scene is the (uniquely) slowest while
//     a later scene is faster: the energy is back-loaded. A RETENTION heuristic
//     (front-load the energy); the non-retention rulesets disable it because
//     cinematic/long-form legitimately build to a climax.
function warnPacingArc(scenes, warnings, disabledRules) {
  const disabled = disabledRules instanceof Set ? disabledRules : new Set();
  const paced = scenes.filter((s) => isPlainObject(s) && typeof s.pacing === "string" && s.pacing in PACING_RANK);
  if (paced.length < 3) return; // too short to have an arc
  if (paced.length >= 4 && !disabled.has("PLAN_PACING_MONOTONE")) {
    const distinct = new Set(paced.map((s) => s.pacing));
    if (distinct.size === 1) {
      warnings.push({
        code: "PLAN_PACING_MONOTONE",
        message: `all ${paced.length} scenes share pacing "${paced[0].pacing}" — vary the rhythm so the edit breathes (a flat pacing track reads as monotonous)`,
        data: { pacing: paced[0].pacing, scene_count: paced.length },
      });
    }
  }
  if (!disabled.has("PLAN_RHYTHM_ARC_INVERTED")) {
    const ranks = paced.map((s) => PACING_RANK[s.pacing]);
    const firstRank = ranks[0];
    const maxRank = Math.max(...ranks);
    const minRank = Math.min(...ranks);
    if (firstRank === minRank && firstRank < maxRank) {
      const peakIx = ranks.findIndex((r) => r === maxRank);
      warnings.push({
        code: "PLAN_RHYTHM_ARC_INVERTED",
        message: `the opening scene is the slowest-paced ("${paced[0].pacing}") while scene ${peakIx + 1} runs "${paced[peakIx].pacing}" — front-load the energy (open at or near your fastest; don't make the viewer wait for the pace to pick up)`,
        scene_index: 0,
        scene_id: sceneIdOf(paced[0]),
        data: { hook_pacing: paced[0].pacing, peak_pacing: paced[peakIx].pacing },
      });
    }
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
    // OUTPUT length: each clip's on-screen length is (out-in)/speed, so a 10s raw
    // clip at 2x correctly fills a 5s scene target instead of false-rejecting at
    // 10s. A LAYOUT scene's cells play concurrently → the MAX cell, not the sum
    // (sceneArollOutputSeconds handles both), so a 2-up doesn't false-trip here.
    const sum = sceneArollOutputSeconds(scene);
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
    // The viewer sees the OUTPUT hold = raw span / speed: a 3s clip at 3x flashes by
    // in 1s (warns); a 1s clip at 0.5x holds 2s (clean).
    const duration = effectiveClipDuration(clip);
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

// Parse a free-text key_moments answer into ranges + single points. Permissive
// and FAIL-SAFE (an unparseable answer yields nothing — never a false positive):
// handles "27.9–42.1s", "1:02-1:10", "27.9 to 42.1 seconds" (ranges) and
// "42s", "1:05", "open on the laugh at 42s" (single points). Ranges are consumed
// from the residual first so a range's bounds aren't re-counted as points. A bare
// integer with no unit/colon is only honored INSIDE a range (where the connector
// disambiguates it as a timestamp), never as a standalone point.
function parseKeyMoments(raw) {
  const TS = String.raw`\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?`;
  const UNIT = String.raw`(?:\s*(?:s|sec|secs|seconds))?`;
  const ranges = [];
  let residual = String(raw);
  const rangeRE = new RegExp(`(${TS})${UNIT}\\s*(?:[\\u2013\\u2014-]|to)\\s*(${TS})${UNIT}`, "gi");
  residual = residual.replace(rangeRE, (full, a, b) => {
    const start = parseSingleDuration(String(a).trim());
    const end = parseSingleDuration(String(b).trim());
    if (start !== null && end !== null) {
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) ranges.push({ start: lo, end: hi });
    }
    return " "; // consume so the bounds aren't re-read as points
  });
  const points = [];
  const pointRE = new RegExp(`(\\d{1,2}:\\d{2}(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s*(?:s|sec|secs|seconds))`, "gi");
  let m;
  while ((m = pointRE.exec(residual)) !== null) {
    const v = parseSingleDuration(m[1].replace(/\s+/g, ""));
    if (v !== null && Number.isFinite(v)) points.push(v);
  }
  return { ranges, points };
}

function warnKeyMomentCoverage(scenes, state, warnings) {
  const intent = state && isPlainObject(state.intent) ? state.intent : null;
  const answers = intent && isPlainObject(intent.answers) ? intent.answers : null;
  const rawMoments = answers ? intentAnswerRaw(answers.key_moments) : null;
  if (typeof rawMoments !== "string" || rawMoments.trim() === "") return;
  const { ranges, points } = parseKeyMoments(rawMoments);
  if (ranges.length === 0 && points.length === 0) return;
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
  // A single named point is covered when some clip window contains it (±0.5s).
  const POINT_TOL_S = 0.5;
  for (const p of points) {
    const covered = windows.some((c) => c.in_seconds - POINT_TOL_S <= p && c.out_seconds + POINT_TOL_S >= p);
    if (!covered) {
      warnings.push({
        code: "PLAN_KEY_MOMENT_UNCOVERED",
        message: `key moment at ${round1(p)}s is not covered by any source clip — the user named this moment explicitly`,
        data: { start_seconds: p, end_seconds: p },
      });
    }
  }
}

// (v3.8) Captions-on-silent for the FIRST-CLASS caption_segments[] layer. The
// legacy `scene.captions` string is covered by STORYBOARD_CAPTIONS_ON_SILENT_SEGMENT
// (an error); the v3.2 caption_segments layer — now the primary burned-caption
// plan — had no such check, so a storyboarder could author captions over a
// fully-silent scene and nothing flagged it. WARNING (caption_segments are
// advisory at COMPOSE-QC, so plan-lint stays warning-only for them). Only runs
// when a transcript exists at all (fail-safe: no speech anywhere -> skip) and
// skips scenes already covered by the legacy-string error.
function warnCaptionSegmentsOnSilent(scenes, ctx, warnings) {
  if (!Array.isArray(ctx.transcript) || ctx.transcript.length === 0) return;
  const resolveTranscript = typeof ctx.transcriptForFileIndex === "function"
    ? ctx.transcriptForFileIndex
    : () => ctx.transcript;
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene)) return;
    if (sceneHasCaptions(scene)) return; // the legacy-string error path handles this scene
    const segs = captionSegmentsOf(scene);
    if (segs.length === 0 || !segs.some((s) => isNonEmptyString(s.text))) return;
    if (!Array.isArray(scene.source_clips) || scene.source_clips.length === 0) return;
    if (!clipHasSpokenWords(scene, resolveTranscript)) {
      warnings.push({
        code: "PLAN_CAPTION_SEGMENTS_ON_SILENT",
        message: `scenes[${ix}] has caption_segments but none of its source_clips overlap any transcript word — burned captions would be unsupported by source speech (pull from a spoken clip, or drop the captions here)`,
        scene_index: ix,
        scene_id: sceneIdOf(scene),
      });
    }
  });
}

// (v3.8) Intent-enforcement teeth. The v3.7 optional creative keys (pacing /
// speed / layout / transition / caption-animation intent) are threaded into the
// storyboarder SPAWN, but until now nothing verified the storyboarder honored
// them — a user who explicitly asked for "fast / split-screen / whip-pans /
// karaoke" could get a slow, single-cell, all-cut, no-animation plan with a
// clean gate. These read the recorded intent answer and WARN (never block;
// permissive keyword matching; fail-safe when the key is absent/unparseable)
// when a clearly-expressed creative intent isn't reflected in the plan. Like
// key-moment coverage they run ONCE document-globally (a layout/transition in
// ANY short satisfies the intent) — the fan-out path suppresses the per-short
// call and re-runs over all scenes.
const INTENT_PACING_FAST_RE = /\b(fast|faster|fast-?paced|quick|quick-?cuts?|snappy|punchy|energetic|high-?energy|rapid|frenetic|upbeat)\b/i;
const INTENT_PACING_SLOW_RE = /\b(slow|slower|slow-?paced|calm|relaxed|measured|gentle|meditative|contemplative|laid-?back)\b/i;
const INTENT_LAYOUT_MULTI_RE = /\b(split-?screen|split|side-?by-?side|grid|2-?up|two-?up|multi-?cam|multicam|picture-?in-?picture|pip|reaction|comparison|before-?and-?after)\b/i;
const INTENT_TRANSITION_RE = /\b(transitions?|whip-?pan|whip|dissolve|cross-?fade|fade|dip-?to-?black|dip|slide|wipe|zoom|spin|glitch|swipe)\b/i;
const INTENT_TRANSITION_NONE_RE = /\b(no transitions?|hard cuts?|cuts? only|straight cuts?|jump cuts?|just cuts?)\b/i;
const INTENT_CAPTION_ANIM_RE = /\b(kinetic|animated|word-?by-?word|karaoke|pop(?:-?up)?|bouncy|typewriter)\b/i;

function warnIntentUnmet(parsed, scenes, ctx, warnings) {
  const state = isPlainObject(ctx) ? ctx.state : null;
  const answers = state && isPlainObject(state.intent) && isPlainObject(state.intent.answers)
    ? state.intent.answers : null;
  if (!answers) return;
  const txt = (key) => (intentAnswerRaw(answers[key]) || "").toLowerCase();

  // 1) Pacing intent vs the scene pacing track.
  const pacingText = `${txt("pacing_intent")} ${txt("speed_intent")}`.trim();
  const paced = scenes.filter((s) => isPlainObject(s) && typeof s.pacing === "string" && s.pacing in PACING_RANK);
  if (paced.length >= 2 && pacingText) {
    const wantsFast = INTENT_PACING_FAST_RE.test(pacingText);
    const wantsSlow = INTENT_PACING_SLOW_RE.test(pacingText);
    const fastCount = paced.filter((s) => s.pacing === "fast").length;
    const fastRatio = fastCount / paced.length;
    if (wantsFast && !wantsSlow && fastRatio < 0.5) {
      warnings.push({
        code: "PLAN_PACING_INTENT_IGNORED",
        message: `you asked for fast/snappy pacing but only ${fastCount}/${paced.length} scenes are paced "fast" — tighten the cut (shorter scenes, more "fast" pacing)`,
        data: { intent: pacingText, fast_scenes: fastCount, paced_scenes: paced.length },
      });
    } else if (wantsSlow && !wantsFast && fastRatio > 0.5) {
      warnings.push({
        code: "PLAN_PACING_INTENT_IGNORED",
        message: `you asked for slow/calm pacing but ${fastCount}/${paced.length} scenes are paced "fast" — ease the rhythm (longer holds, fewer "fast" scenes)`,
        data: { intent: pacingText, fast_scenes: fastCount, paced_scenes: paced.length },
      });
    }
  }

  // 2) Layout intent vs actual multi-cell layouts (document-global).
  if (INTENT_LAYOUT_MULTI_RE.test(txt("layout_intent"))) {
    const layouts = collectSceneLayouts(parsed);
    if (!Array.isArray(layouts) || layouts.length === 0) {
      warnings.push({
        code: "PLAN_LAYOUT_INTENT_UNMET",
        message: `you asked for a split-screen / multi-cell layout but no scene declares a layout{} — add scene.layout (split_vertical / split_horizontal / grid_2x2 / pip) where the comparison belongs`,
        data: { intent: txt("layout_intent") },
      });
    }
  }

  // 3) Transition intent vs actual transitions (every transition_in is a cut).
  const transitionText = txt("transition_intent");
  if (INTENT_TRANSITION_RE.test(transitionText) && !INTENT_TRANSITION_NONE_RE.test(transitionText)) {
    const anyNonCut = scenes.some((s) => isPlainObject(s) && s.transition_in != null
      && transitionTypeOf(s.transition_in) !== "cut");
    if (!anyNonCut) {
      warnings.push({
        code: "PLAN_TRANSITION_INTENT_UNMET",
        message: `you asked for transitions but every scene uses a hard cut (no scene.transition_in) — add transition_in (e.g. fade / dip / slide / zoom) on the scenes that should flow`,
        data: { intent: transitionText },
      });
    }
  }

  // 4) Caption-animation intent vs any planned caption animation.
  const capIntent = txt("caption_animation_intent");
  if (INTENT_CAPTION_ANIM_RE.test(capIntent) || CAPTION_ANIMATIONS.some((a) => capIntent.includes(a))) {
    const anyAnimated = scenes.some((s) => captionSegmentsOf(s)
      .some((seg) => isPlainObject(seg) && isNonEmptyString(seg.animation)));
    if (!anyAnimated) {
      warnings.push({
        code: "PLAN_CAPTION_ANIMATION_INTENT_UNMET",
        message: `you asked for animated/kinetic captions but no caption_segments[].animation is set — add animation:"pop" (or word-by-word / karaoke if the transcript is forced-aligned) to the captioned scenes`,
        data: { intent: capIntent },
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

// Shared safe-band check for any positioned element (typed overlay OR caption
// segment). offset_px[1] is the inset from the anchored edge, so a top-anchored
// element inside safe_top_px (or bottom inside safe_bottom_px) gets occluded by
// platform UI chrome. Returns {band, safe_px} or null (fail-safe on any missing
// field). Generalizes the old bottom-only overlay check to the top band too —
// the profiles already ship safe_top_px.
function safeBandIntrusion(profile, position) {
  if (!profile || !isPlainObject(position) || typeof position.anchor !== "string"
    || !Array.isArray(position.offset_px) || !isFiniteNumber(position.offset_px[1])) return null;
  const y = position.offset_px[1];
  if (position.anchor.startsWith("bottom") && isFiniteNumber(profile.safe_bottom_px) && y < profile.safe_bottom_px) {
    return { band: "bottom", safe_px: profile.safe_bottom_px };
  }
  if (position.anchor.startsWith("top") && isFiniteNumber(profile.safe_top_px) && y < profile.safe_top_px) {
    return { band: "top", safe_px: profile.safe_top_px };
  }
  return null;
}

// caption_segments[].position safe-band check (companion to the overlay one in
// lintOverlays). WARNING — captions in a platform UI band get occluded.
function warnCaptionPositionSafeArea(scenes, ctx, warnings) {
  const profile = platformProfileFromState(ctx.state);
  if (!profile) return;
  scenes.forEach((scene, ix) => {
    captionSegmentsOf(scene).forEach((seg, segIx) => {
      const sa = safeBandIntrusion(profile, seg.position);
      if (sa) {
        warnings.push({
          code: "PLAN_CAPTION_SAFE_AREA",
          message: `scenes[${ix}].caption_segments[${segIx}] anchors ${seg.position.anchor} at y-offset ${seg.position.offset_px[1]}px — inside the platform's ${sa.safe_px}px ${sa.band} safe band (platform UI covers it); move it clear of the band`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { offset_px: seg.position.offset_px, band: sa.band, safe_px: sa.safe_px },
        });
      }
    });
  });
}

// (v3.8) Floor lints: A-roll has a b_roll-hold floor but no scene/output floor.
// PLAN_SCENE_EMPTY — a scene with no footage AND no overlays AND no layout
// renders nothing. PLAN_SCENE_TOO_SHORT — a clip-bearing scene that realizes a
// sub-readable flash of footage reads as a glitch. Both WARNINGS, universal.
const SCENE_MIN_OUTPUT_S = 0.7;
function warnSceneFloors(scenes, warnings) {
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene)) return;
    const hasClips = Array.isArray(scene.source_clips) && scene.source_clips.length > 0;
    const hasOverlays = typedOverlaysOf(scene).length > 0
      || (Array.isArray(scene.overlays) && scene.overlays.length > 0);
    const hasLayout = Boolean(sceneLayoutOf(scene));
    if (!hasClips && !hasOverlays && !hasLayout) {
      warnings.push({
        code: "PLAN_SCENE_EMPTY",
        message: `scenes[${ix}] has no source_clips, no overlays, and no layout — it would render nothing; give it footage/overlays or remove it`,
        scene_index: ix,
        scene_id: sceneIdOf(scene),
      });
      return;
    }
    if (hasClips) {
      const out = sceneOutputSeconds(scene);
      if (isFiniteNumber(out) && out > 0 && out < SCENE_MIN_OUTPUT_S) {
        warnings.push({
          code: "PLAN_SCENE_TOO_SHORT",
          message: `scenes[${ix}] realizes only ${round1(out)}s of footage — under ~${SCENE_MIN_OUTPUT_S}s reads as a glitch; lengthen it or merge it into a neighbor`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { output_seconds: out },
        });
      }
    }
  });
}

// (v3.8) Target-vs-intent consistency: the storyboarder is INSTRUCTED to copy
// the canonical platform + profile fps into target, but nothing verified it —
// platform/duration drift was caught NEVER at PLAN, fps only at COMPOSE. Both
// WARNINGS, fail-safe (skip when intent has no canonical platform/profile, or
// when target.platform doesn't canonicalize to a recognized platform).
// Document-global (one target block) — runs once, gated by suppress_intent_check.
function warnTargetVsIntent(parsed, ctx, warnings) {
  const state = isPlainObject(ctx) ? ctx.state : null;
  const answers = state && isPlainObject(state.intent) && isPlainObject(state.intent.answers)
    ? state.intent.answers : null;
  const tp = answers && isPlainObject(answers.target_platform) ? answers.target_platform : null;
  const target = isPlainObject(parsed.target) ? parsed.target : null;
  if (!tp || !target) return;
  const intentCanonical = isNonEmptyString(tp.canonical) ? tp.canonical : null;
  if (intentCanonical && isNonEmptyString(target.platform)) {
    let c = null;
    try { c = canonicalizePlatform(target.platform); } catch { c = null; }
    if (c && c.recognized === true && c.canonical !== intentCanonical) {
      warnings.push({
        code: "PLAN_TARGET_PLATFORM_DRIFT",
        message: `storyboard target.platform "${target.platform}" (→ ${c.canonical}) differs from the chosen platform "${intentCanonical}" — downstream geometry / safe bands / caption defaults follow target.platform; set it to match the intent`,
        data: { target_platform: target.platform, target_canonical: c.canonical, intent_canonical: intentCanonical },
      });
    }
  }
  const profileFps = isPlainObject(tp.profile) && isFiniteNumber(tp.profile.fps) ? tp.profile.fps : null;
  if (profileFps && isFiniteNumber(target.fps) && Math.abs(target.fps - profileFps) > 0.01) {
    warnings.push({
      code: "PLAN_TARGET_FPS_DRIFT",
      message: `storyboard target.fps ${target.fps} differs from the platform profile fps ${profileFps}${intentCanonical ? ` (${intentCanonical})` : ""} — the composer renders at target.fps; align them so motion/caption timing match the platform`,
      data: { target_fps: target.fps, profile_fps: profileFps },
    });
  }
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
      // Safe-area (warning): a top- OR bottom-anchored overlay with a y-offset
      // inside the platform's UI band gets eaten by platform chrome.
      const overlaySa = safeBandIntrusion(profile, overlay.position);
      if (overlaySa) {
        warnings.push({
          code: "PLAN_OVERLAY_SAFE_AREA",
          message: `scenes[${ix}] overlay ${overlayLabel(overlay)} anchors ${overlay.position.anchor} at y-offset ${overlay.position.offset_px[1]}px — inside the platform's ${overlaySa.safe_px}px ${overlaySa.band} safe band (platform UI covers it)`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          overlay_id: overlay.id || null,
          data: { offset_px: overlay.position.offset_px, band: overlaySa.band, safe_px: overlaySa.safe_px },
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

// --- Caption-plan lint (v3) ---------------------------------------------------
// caption_segments are SOURCE-time; the composer re-times each against the
// containing scene clip (master = clip_start + (seg_start - clip.in_seconds)).
// All caption lints are WARNINGS (advisory — the composer legitimately
// re-chunks/animates captions; a hard error would false-reject good cuts).
//   PLAN_CAPTION_CHUNK_TOO_LONG    — a chunk runs long enough to overflow / not
//                                    read as a kinetic caption.
//   PLAN_CAPTION_EMPHASIS_NOT_IN_TEXT — an emphasis_word isn't in `text`, so the
//                                    composer has nothing to emphasize.
//   PLAN_CAPTION_TIMING_DRIFT      — the segment's source-time window falls
//                                    outside every clip in its scene, so the
//                                    composer's re-timing math lands it at the
//                                    wrong place (it can't be cut to the cut).
//   PLAN_CAPTION_EXACT_UNALIGNED   — a caption marked exact:true (a binding
//                                    text/timing contract — COMPOSE QC errors if
//                                    its element is missing) sits on an unaligned
//                                    transcript, so its window is approximate.
function captionContainedInScene(seg, scene) {
  const tol = PLAN_LINT_THRESHOLDS.caption_window_tolerance_s;
  const clips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
  return clips.some((c) => isPlainObject(c) && clipHasWindow(c)
    && seg.start_seconds >= c.in_seconds - tol && seg.end_seconds <= c.out_seconds + tol);
}

function lintCaptionSegments(scenes, warnings, transcriptAligned) {
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene) || !Array.isArray(scene.caption_segments)) return;
    const hasClipWindow = (Array.isArray(scene.source_clips) ? scene.source_clips : [])
      .some((c) => isPlainObject(c) && clipHasWindow(c));
    scene.caption_segments.forEach((seg, segIx) => {
      if (!isPlainObject(seg)) return;
      if (isNonEmptyString(seg.text)) {
        const trimmed = seg.text.trim();
        const words = trimmed.split(/\s+/).length;
        if (words > PLAN_LINT_THRESHOLDS.caption_chunk_max_words || trimmed.length > PLAN_LINT_THRESHOLDS.caption_chunk_max_chars) {
          warnings.push({
            code: "PLAN_CAPTION_CHUNK_TOO_LONG",
            message: `scenes[${ix}].caption_segments[${segIx}] is ${words} words / ${trimmed.length} chars ("${trimmed.slice(0, 40)}${trimmed.length > 40 ? "…" : ""}") — kinetic caption chunks read best at ≤${PLAN_LINT_THRESHOLDS.caption_chunk_max_words} words; split it on a clause boundary`,
            scene_index: ix,
            scene_id: sceneIdOf(scene),
            data: { words, chars: trimmed.length },
          });
        }
      }
      if (Array.isArray(seg.emphasis_words) && isNonEmptyString(seg.text)) {
        const haystack = seg.text.toLowerCase();
        const missing = seg.emphasis_words.filter((w) => isNonEmptyString(w) && !haystack.includes(w.toLowerCase()));
        if (missing.length > 0) {
          warnings.push({
            code: "PLAN_CAPTION_EMPHASIS_NOT_IN_TEXT",
            message: `scenes[${ix}].caption_segments[${segIx}] emphasis_words ${JSON.stringify(missing)} do not appear in the caption text "${seg.text.trim().slice(0, 40)}" — the composer can't emphasize a word that isn't there`,
            scene_index: ix,
            scene_id: sceneIdOf(scene),
            data: { missing },
          });
        }
      }
      // Timing drift: the segment must live inside one of the scene's clip
      // windows or it cannot be re-timed onto the cut. Only meaningful when the
      // scene HAS clip windows (overlay-only scenes are exempt).
      if (hasClipWindow && isFiniteNumber(seg.start_seconds) && isFiniteNumber(seg.end_seconds)
        && !captionContainedInScene(seg, scene)) {
        warnings.push({
          code: "PLAN_CAPTION_TIMING_DRIFT",
          message: `scenes[${ix}].caption_segments[${segIx}] window ${round1(seg.start_seconds)}–${round1(seg.end_seconds)}s falls outside the scene's source clip windows — caption_segments are SOURCE-time and must sit inside a clip so the composer can re-time them to the cut`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { start_seconds: seg.start_seconds, end_seconds: seg.end_seconds },
        });
      }
      // Karaoke / word-by-word highlight at the WORD level — they need
      // frame-accurate per-word timing, which only forced alignment (INSPECT P1,
      // state.inspect.transcript_aligned) provides. On an unaligned transcript the
      // words drift; warn and steer to chunk-level "pop" (or an alignment
      // backend). Feasibility, not editorial style — so it's universal (not
      // ruleset-gated): a tutorial or long-form karaoke caption needs alignment too.
      if (transcriptAligned !== true && isNonEmptyString(seg.animation)
        && WORD_LEVEL_CAPTION_ANIMATIONS.has(seg.animation)) {
        warnings.push({
          code: "PLAN_CAPTION_KARAOKE_UNALIGNED",
          message: `scenes[${ix}].caption_segments[${segIx}] asks for "${seg.animation}" (word-level) animation, but the transcript is not forced-aligned (INSPECT reported transcript_aligned=false) — per-word timing is approximate, so karaoke will drift. Use animation:"pop" (chunk-level, timing-tolerant) here, or re-run INSPECT with an alignment backend (pip install whisperx)`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { animation: seg.animation, transcript_aligned: false },
        });
      }
      // An exact caption is a binding contract (COMPOSE QC errors if its element
      // is missing), but a hard text/timing contract built on approximate
      // (unaligned) word timings can land off the cut. Warn — same alignment
      // signal as the karaoke lint. The ERROR severity for an unbound exact
      // caption lives ONLY in COMPOSE-phase QC; caption plan-lint stays
      // all-warnings.
      if (seg.exact === true && transcriptAligned !== true) {
        warnings.push({
          code: "PLAN_CAPTION_EXACT_UNALIGNED",
          message: `scenes[${ix}].caption_segments[${segIx}] is marked exact:true (a binding text/timing contract) but the transcript is not forced-aligned (transcript_aligned=false) — its window is approximate. Drop exact for a flexible caption, or re-run INSPECT with an alignment backend (pip install whisperx)`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { exact: true, transcript_aligned: false },
        });
      }
    });
  });
}

// Typed scene transitions (v3.3) — all WARNINGS, never blockers (taste, not
// safety; determinism is hyperframes' own lint). transition_in is the rich
// intra-composition transition INTO a scene; cut/dip/fade are seam-expressible
// and universally available, so they never warn for being "off vocabulary".
function lintTransitions(parsed, scenes, ctx, disabled, warnings) {
  const active = resolveActiveVideoType(isPlainObject(ctx) ? ctx.state : null);
  const vocab = new Set(Array.isArray(active.preset.transition_vocabulary) ? active.preset.transition_vocabulary : []);
  const shadersOk = hostProfile.shaderTransitionsAllowed();
  const distinctTypes = new Set();

  scenes.forEach((scene, ix) => {
    // scene 0 has nothing to transition FROM — its transition_in is a no-op.
    if (!isPlainObject(scene) || ix === 0) return;
    const ti = scene.transition_in;
    const type = transitionTypeOf(ti);
    if (type === "cut") return;
    distinctTypes.add(type);

    if (isShaderTransition(ti)) {
      // A shader type is RECOGNIZED (not "unknown"); it just needs a capable host.
      if (!shadersOk) {
        warnings.push({
          code: "PLAN_TRANSITION_BUDGET",
          message: `scenes[${ix}].transition_in "${type}" is a WebGL shader transition, but shader transitions are off on this host (low capacity / un-vendored) — the composer will substitute the nearest CSS transition (e.g. glitch→whip_pan, cross_warp→crossfade)`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { type, shader_transitions_allowed: false },
        });
      }
    } else if (!vocab.has(type) && !SEAM_TRANSITION_TYPES.includes(type)) {
      warnings.push({
        code: "PLAN_TRANSITION_UNKNOWN_TYPE",
        message: `scenes[${ix}].transition_in "${type}" is not in the ${active.canonical} transition vocabulary (${[...vocab].join(", ")}) — it will fall back to a hard cut; pick one of the offered types`,
        scene_index: ix,
        scene_id: sceneIdOf(scene),
        data: { type, vocabulary: [...vocab] },
      });
    }

    // Too long (only when an explicit duration is given): a transition paints
    // over EXISTING scene frames, so > half the shorter adjacent scene eats the shot.
    const dur = transitionDurationOf(ti);
    if (dur !== null) {
      const prev = scenes[ix - 1];
      const adj = [
        isPlainObject(prev) && isFiniteNumber(prev.target_duration_seconds) ? prev.target_duration_seconds : null,
        isFiniteNumber(scene.target_duration_seconds) ? scene.target_duration_seconds : null,
      ].filter((v) => v !== null);
      if (adj.length > 0) {
        const shorter = Math.min(...adj);
        if (dur > 0.5 * shorter) {
          warnings.push({
            code: "PLAN_TRANSITION_TOO_LONG",
            message: `scenes[${ix}].transition_in "${type}" runs ${round1(dur)}s — over half the shorter adjacent scene (${round1(shorter)}s); keep it ≤${round1(0.5 * shorter)}s so it doesn't eat the shot`,
            scene_index: ix,
            scene_id: sceneIdOf(scene),
            data: { duration_seconds: dur, shorter_adjacent_seconds: shorter },
          });
        }
      }
    }
  });

  // Inconsistent: > 3 distinct transition types in one timeline reads random
  // rather than intentional. Gated OFF under montage (variety is the point).
  if (!disabled.has("PLAN_TRANSITION_INCONSISTENT") && distinctTypes.size > 3) {
    warnings.push({
      code: "PLAN_TRANSITION_INCONSISTENT",
      message: `this timeline mixes ${distinctTypes.size} distinct transition types (${[...distinctTypes].join(", ")}) — settle on a consistent transition language (≤3) so the cuts feel intentional`,
      data: { types: [...distinctTypes] },
    });
  }

  // Downgraded: a glue group (scenes joined by a non-cut, non-seam transition_in)
  // that exceeds the host <video> hard cap can't render in one composition, so
  // the render plan splits it and the broken transition becomes a seam. Only
  // meaningful when the render is actually chunked (auto/manual segmentation).
  const requested = isNonEmptyString(parsed.render_segmentation)
    ? parsed.render_segmentation
    : active.preset.render.segmentation;
  // Fan-out shorts always render single (no chunking), so a glue group can't be
  // split there — only a real segmented single-timeline render can downgrade.
  if (requested !== "single" && !storyboardHasShorts(parsed)) {
    const budget = hostProfile.videoBudget();
    const hardCap = hostProfile.videoHardCap();
    const narrative = storyboardSegments(parsed);
    const runs = narrative.length > 0 ? narrative.map((s) => s.scenes) : [scenes];
    for (const run of runs) {
      for (const dg of glueDowngrades(run, budget, hardCap, sceneVideoCount)) {
        warnings.push({
          code: "PLAN_TRANSITION_DOWNGRADED",
          message: `the transition into scene "${dg.scene_id}" ("${dg.from_type}") glues more <video> elements than the host renders in one composition (>${hardCap}) — the render plan will split there and downgrade it to a "${dg.to_seam}" seam; shorten the glued run or simplify those scenes to keep it intra-composition`,
          scene_id: dg.scene_id,
          data: { from_type: dg.from_type, to_seam: dg.to_seam, hard_cap: hardCap },
        });
      }
    }
  }
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

// Subject-compositing plan lint (v3.3) — WARNINGS only, never blocks sign-off
// (consistent with the B-roll-gap + overlay warnings). Runs per render unit:
// lintStoryboardPlan is invoked once for a single timeline and once per short in
// fan-out (on a per-short view), so both `parsed.broll_placements` and the budget
// tally are correctly scoped.
//   PLAN_SUBJECT_BACKDROP_NOT_INGESTED — the no-synthesized-backdrop guard, made
//     human-visible at the plan gate: a backdrop kind outside BACKDROP_KINDS, a
//     design_token without a fill, or a clip_ref/scene_base that doesn't resolve
//     to a real ingested clip.
//   PLAN_SUBJECT_BUDGET_EXCEEDED — total subject seconds in this render unit
//     exceed the host budget; matting (per-frame inference) will be slow here.
function lintSubjectPlacements(parsed, sceneById, warnings) {
  const placements = Array.isArray(parsed.broll_placements) ? parsed.broll_placements : [];
  let subjectSecondsTotal = 0;
  const seenBudget = new Set(); // count each unique clip's matte cost once
  placements.forEach((p, k) => {
    if (!isSubjectPlacement(p)) return;
    const sceneId = isPlainObject(p.clip) && isNonEmptyString(p.clip.scene_id) ? p.clip.scene_id : null;
    const backdrop = isPlainObject(p.backdrop) ? p.backdrop : null;
    const kind = backdrop && typeof backdrop.kind === "string" ? backdrop.kind : null;
    let detail = null;
    if (!kind || !BACKDROP_KIND_SET.has(kind)) {
      detail = `backdrop kind ${kind ? `"${kind}"` : "(missing)"} is not one of ${BACKDROP_KINDS.join(", ")}`;
    } else if (kind === "design_token") {
      if (!isNonEmptyString(backdrop.fill)) {
        detail = "design_token backdrop has no fill (a palette key, #hex, or CSS gradient)";
      }
    } else if (kind === "clip_ref") {
      const ref = isPlainObject(backdrop.clip) ? backdrop.clip : null;
      const entry = ref && isNonEmptyString(ref.scene_id) ? sceneById.get(ref.scene_id) : null;
      const clips = entry && Array.isArray(entry.scene.source_clips) ? entry.scene.source_clips : null;
      if (!ref || !clips || !Number.isInteger(ref.clip_index) || ref.clip_index < 0 || ref.clip_index >= clips.length) {
        detail = `clip_ref backdrop ${ref ? `${ref.scene_id}-${ref.clip_index}` : "(missing clip)"} does not resolve to an ingested clip`;
      }
    } else if (kind === "scene_base") {
      const entry = sceneId ? sceneById.get(sceneId) : null;
      const clips = entry && Array.isArray(entry.scene.source_clips) ? entry.scene.source_clips : null;
      if (!clips || clips.length === 0) {
        detail = `scene_base backdrop for scene "${sceneId || "?"}" has no source clip to sit behind the subject`;
      }
    }
    if (detail) {
      warnings.push({
        code: "PLAN_SUBJECT_BACKDROP_NOT_INGESTED",
        message: `broll_placements[${k}] subject: ${detail} — the backdrop must be a design token, an ingested clip, or the scene's own base (no synthesized/stock/AI backdrops)`,
        placement_index: k,
        scene_id: sceneId,
        data: { backdrop_kind: kind },
      });
    }
    const ref = isPlainObject(p.clip) ? p.clip : null;
    const entry = ref && isNonEmptyString(ref.scene_id) ? sceneById.get(ref.scene_id) : null;
    const clip = entry && Array.isArray(entry.scene.source_clips) && Number.isInteger(ref.clip_index)
      ? entry.scene.source_clips[ref.clip_index]
      : null;
    if (isPlainObject(clip)) {
      const bkey = `${ref.scene_id}:${ref.clip_index}`;
      if (!seenBudget.has(bkey)) {
        seenBudget.add(bkey);
        subjectSecondsTotal += effectiveClipDuration(clip);
      }
    }
  });
  if (subjectSecondsTotal > 0) {
    const budget = hostProfile.subjectBudget().subjectSecondsMax;
    if (subjectSecondsTotal > budget) {
      warnings.push({
        code: "PLAN_SUBJECT_BUDGET_EXCEEDED",
        message: `${round1(subjectSecondsTotal)}s of subject footage planned against the host budget of ${budget}s — background matting (remove-background) runs per frame, so this render unit will matte slowly on this host (raise VOB_SUBJECT_SECONDS_MAX, split the work, or drop a subject treatment)`,
        data: { subject_seconds: round1(subjectSecondsTotal), subject_seconds_max: budget },
      });
    }
  }
}

// --- Span / caption / transcript content lints (v3.4) ------------------------
// These close the gap a tester hit: a storyboard that passes plan-lint but is
// editorially wrong because the chosen SPANS were never checked against what the
// transcript actually says — pulled-forward hook spans overlapping the body,
// repeated lines, and a hook that grabbed the wrong sentence. All WARNINGS
// (advisory, like every other span/caption lint; the human accepts-or-fixes at
// the plan gate).

// Lowercased alphanumeric tokens of length >= minLen (apostrophes folded out so
// "don't" -> "dont"). The shared normalizer for content-overlap comparisons.
function contentTokens(text, minLen = 3) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= minLen);
}

// PLAN_CLIP_SPAN_OVERLAP — two a_roll clips drawn from the SAME source file reuse
// overlapping source seconds, so the same footage/words play twice (the
// "pulled-forward hook overlapped the body / repeated whole lines" defect).
// Geometric only (no transcript needed); a sweep over clips sorted by in_seconds.
function warnClipSpanOverlap(scenes, warnings) {
  const byFile = new Map(); // manifest_file_index -> [{sceneIx, clipIx, scene_id, in, out}]
  eachClip(scenes, (scene, i, clip, j) => {
    if (clipRoleOf(clip) !== "a_roll" || !clipHasWindow(clip)) return;
    if (!Number.isInteger(clip.manifest_file_index)) return;
    if (!byFile.has(clip.manifest_file_index)) byFile.set(clip.manifest_file_index, []);
    byFile.get(clip.manifest_file_index).push({
      sceneIx: i, clipIx: j, scene_id: sceneIdOf(scene), in: clip.in_seconds, out: clip.out_seconds,
    });
  });
  const min = PLAN_LINT_THRESHOLDS.clip_span_overlap_min_s;
  const seen = new Set();
  for (const clips of byFile.values()) {
    if (clips.length < 2) continue;
    clips.sort((a, b) => a.in - b.in);
    for (let a = 0; a < clips.length; a += 1) {
      for (let b = a + 1; b < clips.length; b += 1) {
        if (clips[b].in >= clips[a].out - 1e-9) break; // sorted: no later clip can overlap
        const overlap = Math.min(clips[a].out, clips[b].out) - Math.max(clips[a].in, clips[b].in);
        if (overlap < min) continue;
        const key = `${clips[a].sceneIx}:${clips[a].clipIx}|${clips[b].sceneIx}:${clips[b].clipIx}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push({
          code: "PLAN_CLIP_SPAN_OVERLAP",
          message: `scenes[${clips[a].sceneIx}].source_clips[${clips[a].clipIx}] (${round1(clips[a].in)}–${round1(clips[a].out)}s) and scenes[${clips[b].sceneIx}].source_clips[${clips[b].clipIx}] (${round1(clips[b].in)}–${round1(clips[b].out)}s) reuse ${round1(overlap)}s of the SAME source footage — the same words will play twice (a pulled-forward hook overlapping the body reads as a repeat). Pick distinct spans.`,
          scene_index: clips[a].sceneIx,
          scene_id: clips[a].scene_id,
          clip_index: clips[a].clipIx,
          data: { overlap_seconds: round1(overlap), other_scene_index: clips[b].sceneIx, other_clip_index: clips[b].clipIx },
        });
      }
    }
  }
}

// The clip whose [in,out] window contains a caption segment's [start,end]
// (±tolerance) — the segment is re-timed against it, so its transcript file is
// the one to check the caption text against. Returns the clip or null.
function containingClipForCaption(seg, scene) {
  const tol = PLAN_LINT_THRESHOLDS.caption_window_tolerance_s;
  const clips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
  return clips.find((c) => isPlainObject(c) && clipHasWindow(c)
    && seg.start_seconds >= c.in_seconds - tol && seg.end_seconds <= c.out_seconds + tol) || null;
}

// PLAN_CAPTION_TEXT_MISMATCH — a caption whose content words largely DON'T appear
// in the transcript words actually spoken in its chosen source window. Catches
// "the span grabbed the wrong sentence": the burned caption claims one line but
// the footage under it says something else. Fails safe (skips) when there is no
// transcript, no containing clip, too little speech in the window, or too short
// a caption to judge — and only a STRONG mismatch (below the match ratio) warns,
// so legitimate paraphrase/cleanup never false-positives.
function lintCaptionTranscriptFit(scenes, ctx, warnings) {
  const resolveTranscript = typeof ctx.transcriptForFileIndex === "function" ? ctx.transcriptForFileIndex : null;
  if (!resolveTranscript) return;
  const minWords = PLAN_LINT_THRESHOLDS.caption_text_min_content_words;
  const minRatio = PLAN_LINT_THRESHOLDS.caption_text_match_min_ratio;
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene) || !Array.isArray(scene.caption_segments)) return;
    scene.caption_segments.forEach((seg, segIx) => {
      if (!isPlainObject(seg) || !isNonEmptyString(seg.text)
        || !isFiniteNumber(seg.start_seconds) || !isFiniteNumber(seg.end_seconds)) return;
      const clip = containingClipForCaption(seg, scene);
      if (!clip || !Number.isInteger(clip.manifest_file_index)) return;
      const transcript = resolveTranscript(clip.manifest_file_index);
      if (!Array.isArray(transcript) || transcript.length === 0) return;
      // Words spoken inside the caption's source window.
      const windowText = transcript
        .filter((e) => isPlainObject(e) && isFiniteNumber(e.start) && isFiniteNumber(e.end)
          && e.end > seg.start_seconds && e.start < seg.end_seconds && typeof e.text === "string")
        .map((e) => e.text)
        .join(" ");
      const windowTokens = new Set(contentTokens(windowText));
      if (windowTokens.size < minWords) return; // not enough speech to judge (silence handled elsewhere)
      const capTokens = contentTokens(seg.text);
      if (capTokens.length < minWords) return; // too short a caption to judge confidently
      const matched = capTokens.filter((t) => windowTokens.has(t)).length;
      const ratio = matched / capTokens.length;
      if (ratio < minRatio) {
        warnings.push({
          code: "PLAN_CAPTION_TEXT_MISMATCH",
          message: `scenes[${ix}].caption_segments[${segIx}] text "${seg.text.trim().slice(0, 48)}" barely matches the words actually spoken in its ${round1(seg.start_seconds)}–${round1(seg.end_seconds)}s source window ("${windowText.trim().slice(0, 48)}…") — the caption may be on the WRONG span (only ${Math.round(ratio * 100)}% of its words are in that window). Verify the clip in/out picks the line the caption claims.`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { match_ratio: Math.round(ratio * 100) / 100, caption: seg.text.trim().slice(0, 80), window_text: windowText.trim().slice(0, 80) },
        });
      }
    });
  });
}

// PLAN_CAPTION_REPEATED — the same substantial caption line appears in two scenes
// (the "repeated whole lines" defect). Normalized-content-token identity; only
// lines with enough content words to be meaningful are compared. Modeled on
// warnBrollRepeats but over caption_segments[].text.
function warnRepeatedCaptionLines(scenes, warnings) {
  const minWords = PLAN_LINT_THRESHOLDS.caption_repeat_min_content_words;
  const firstSeen = new Map(); // normalized text -> { sceneIx, segIx, text }
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene) || !Array.isArray(scene.caption_segments)) return;
    scene.caption_segments.forEach((seg, segIx) => {
      if (!isPlainObject(seg) || !isNonEmptyString(seg.text)) return;
      const tokens = contentTokens(seg.text);
      if (tokens.length < minWords) return;
      const norm = tokens.join(" ");
      const prior = firstSeen.get(norm);
      if (prior) {
        warnings.push({
          code: "PLAN_CAPTION_REPEATED",
          message: `scenes[${ix}].caption_segments[${segIx}] repeats the caption line from scenes[${prior.sceneIx}] ("${prior.text.slice(0, 48)}") — the same line is captioned twice; cut one or pick a distinct beat.`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { first_scene_index: prior.sceneIx, text: prior.text.slice(0, 80) },
        });
      } else {
        firstSeen.set(norm, { sceneIx: ix, segIx, text: seg.text.trim() });
      }
    });
  });
}

// PLAN_DURATION_INFEASIBLE (v3.4) — the REALIZED cut (sum of a_roll OUTPUT
// seconds, which already bakes per-clip speed via effectiveClipDuration) lands
// outside the requested duration window. Distinct from PLAN_TARGET_DRIFT /
// PLAN_SHORT_DURATION_OUT_OF_RANGE, which compare the AUTHORED scene/total
// targets: this catches the "~1.25× speed + 60–90s" contradiction a tester hit,
// where the footage available at the planned speed simply can't fill the window
// no matter what targets are authored. Speed-attributed so the lever is obvious.
function warnDurationFeasibility(scenes, ctx, warnings) {
  const spec = isPlainObject(ctx.durationSpec) ? ctx.durationSpec : null;
  let lo = null;
  let hi = null;
  let windowLabel = null;
  if (spec && spec.range) {
    const tol = PLAN_LINT_THRESHOLDS.short_duration_range_tolerance_s;
    lo = spec.range.min_seconds - tol;
    hi = spec.range.max_seconds + tol;
    windowLabel = `${round1(spec.range.min_seconds)}–${round1(spec.range.max_seconds)}s`;
  } else if (isFiniteNumber(ctx.targetSeconds) && ctx.targetSeconds > 0) {
    const r = PLAN_LINT_THRESHOLDS.target_drift_ratio;
    lo = ctx.targetSeconds * (1 - r);
    hi = ctx.targetSeconds * (1 + r);
    windowLabel = `~${round1(ctx.targetSeconds)}s (±${Math.round(r * 100)}%)`;
  } else {
    return; // no intent window/target to judge feasibility against
  }

  let realized = 0;
  const speeds = [];
  for (const scene of scenes) {
    // The scene's on-screen length: a split-screen's stacked cells play
    // concurrently (longest cell), an a_roll spine governs an a_roll scene, a
    // full-frame b_roll-driven scene counts its footage, a clipless title card
    // its authored target — sceneOutputSeconds resolves all of these, so a
    // b-roll-driven cut isn't false-flagged as too short.
    realized += sceneOutputSeconds(scene);
  }
  eachClip(scenes, (scene, i, clip) => {
    if (clipHasWindow(clip)) speeds.push(clipSpeedOf(clip));
  });
  if (realized <= 0) return; // nothing on screen to judge

  const sped = speeds.some((s) => Math.abs(s - 1) > 1e-3);
  const medianSpeed = speeds.length ? speeds.slice().sort((a, b) => a - b)[Math.floor(speeds.length / 2)] : 1;
  const speedNote = sped ? ` (footage plays at ~${round1(medianSpeed)}× the planned speed)` : "";
  if (realized < lo) {
    warnings.push({
      code: "PLAN_DURATION_INFEASIBLE",
      message: `the cut as built realizes ~${round1(realized)}s of footage${speedNote} but the requested duration is ${windowLabel} — there isn't enough source at this speed to fill the window. Slow the clips (lower speed), add footage (a B-roll gap / re-ingest), or lower the target.`,
      data: { realized_seconds: round1(realized), window_low_seconds: round1(lo), window_high_seconds: round1(hi), median_speed: round1(medianSpeed) },
    });
  } else if (realized > hi) {
    warnings.push({
      code: "PLAN_DURATION_INFEASIBLE",
      message: `the cut as built realizes ~${round1(realized)}s of footage${speedNote} but the requested duration is ${windowLabel} — it overruns the window. Cut scenes/clips or speed the footage up.`,
      data: { realized_seconds: round1(realized), window_low_seconds: round1(lo), window_high_seconds: round1(hi), median_speed: round1(medianSpeed) },
    });
  }
}

// PLAN_LAYOUT_* (v3.4) — multi-cell layout warnings. The layout primitive is
// fail-safe (a malformed layout never rejects the save); these warnings surface
// the problem at the plan gate, and the materializer degrades (the composer
// falls back to CSS-positioned cells) if a layout can't be built.
function warnLayouts(scenes, warnings) {
  scenes.forEach((scene, ix) => {
    if (!isPlainObject(scene) || !isPlainObject(scene.layout)) return;
    const layout = sceneLayoutOf(scene);
    if (!layout) {
      warnings.push({
        code: "PLAN_LAYOUT_INVALID",
        message: `scenes[${ix}].layout is present but not usable — a layout needs a "type" string and a "cells" array of ≥2 { clip_index } entries; it will be ignored (the scene renders without a split). Fix or drop it.`,
        scene_index: ix,
        scene_id: sceneIdOf(scene),
      });
      return;
    }
    if (!LAYOUT_TYPE_SET.has(layout.type)) {
      warnings.push({
        code: "PLAN_LAYOUT_UNKNOWN_TYPE",
        message: `scenes[${ix}].layout.type "${layout.type}" is not one of ${LAYOUT_TYPES.join(", ")} — the materializer will fall back to a vertical stack; pick a known type.`,
        scene_index: ix,
        scene_id: sceneIdOf(scene),
        data: { type: layout.type },
      });
    }
    const clipCount = Array.isArray(scene.source_clips) ? scene.source_clips.length : 0;
    for (const cell of layout.cells) {
      if (cell.clip_index >= clipCount) {
        warnings.push({
          code: "PLAN_LAYOUT_CELL_OUT_OF_RANGE",
          message: `scenes[${ix}].layout cell clip_index ${cell.clip_index} is out of range — the scene has ${clipCount} source_clips. The layout can't reference a clip that isn't there.`,
          scene_index: ix,
          scene_id: sceneIdOf(scene),
          data: { clip_index: cell.clip_index, source_clips_count: clipCount },
        });
      }
    }
    const want = LAYOUT_CELL_COUNTS[layout.type];
    if (Number.isInteger(want) && layout.cells.length !== want) {
      warnings.push({
        code: "PLAN_LAYOUT_CELL_COUNT",
        message: `scenes[${ix}].layout type "${layout.type}" expects ${want} cells but has ${layout.cells.length} — extra cells are dropped / missing cells leave gaps.`,
        scene_index: ix,
        scene_id: sceneIdOf(scene),
        data: { type: layout.type, cells: layout.cells.length, expected: want },
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
  // INSPECT P1 marks the winner transcript karaoke-grade (forced-aligned). Word-
  // level caption animations need it; the caption lint warns when they don't have it.
  const transcriptAligned = isPlainObject(ctx.state) && isPlainObject(ctx.state.inspect)
    ? ctx.state.inspect.transcript_aligned === true
    : false;
  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const sceneById = new Map();
  scenes.forEach((scene, ix) => {
    if (isPlainObject(scene) && isNonEmptyString(scene.scene_id)) sceneById.set(scene.scene_id, { scene, index: ix });
  });

  lintManifestBounds(scenes, ctx.manifest, errors);
  lintCaptionsOnSilent(scenes, ctx.transcript, errors, ctx.transcriptForFileIndex);
  lintBrollPlacements(parsed, scenes, sceneById, errors);
  lintOverlays(scenes, ctx, errors, warnings);
  lintCaptionSegments(scenes, warnings, transcriptAligned);
  warnCaptionSegmentsOnSilent(scenes, ctx, warnings);
  warnCaptionPositionSafeArea(scenes, ctx, warnings);
  lintTransitions(parsed, scenes, ctx, disabled, warnings);
  lintSubjectPlacements(parsed, sceneById, warnings);
  // (v3.4) Span / caption content vs the transcript + multi-cell layout — all
  // warnings (advisory at the plan gate, like every other span/caption lint).
  warnClipSpanOverlap(scenes, warnings);
  lintCaptionTranscriptFit(scenes, ctx, warnings);
  warnRepeatedCaptionLines(scenes, warnings);
  warnLayouts(scenes, warnings);

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
  warnHookNoSpeech(scenes, ctx, disabled, warnings);
  warnPacingArc(scenes, warnings, disabled);
  warnSceneFloors(scenes, warnings);
  warnDurations(parsed, scenes, ctx.targetSeconds, warnings);
  warnDurationFeasibility(scenes, ctx, warnings);
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
  // Intent-enforcement teeth run document-globally (a layout/transition/caption
  // animation in ANY short satisfies the intent) — the fan-out path suppresses
  // the per-short call and re-runs once over all scenes.
  if (ctx.suppress_intent_check !== true) {
    warnIntentUnmet(parsed, scenes, ctx, warnings);
    warnTargetVsIntent(parsed, ctx, warnings);
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
    const context = {
      ...baseContext,
      targetSeconds: resolveTargetSeconds(state, parsed),
      // (v3.4) the intent duration spec ({seconds, range?, per_deliverable}) so
      // the feasibility lint can judge the REALIZED cut against the window.
      durationSpec: resolveIntentDurationSpec(state),
    };
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
      // Per-short feasibility: the same intent spec (its range, when per-short,
      // applies to each short's realized cut).
      durationSpec: spec,
      suppress_key_moment_check: true,
      suppress_intent_check: true,
    });
    errors.push(...tagFindingsWithShortId(result.errors, timeline.short_id));
    warnings.push(...tagFindingsWithShortId(result.warnings, timeline.short_id));
    if (spec.range) warnShortDurationRange(timeline, spec.range, warnings);
  }
  warnKeyMomentCoverage(allStoryboardScenes(parsed), state, warnings);
  warnIntentUnmet(parsed, allStoryboardScenes(parsed), baseContext, warnings);
  warnTargetVsIntent(parsed, baseContext, warnings);

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
  CAPTION_ANIMATIONS,
  LAYOUT_TYPES,
  PLAN_LINT_THRESHOLDS,
  BROLL_RENDER_MODES,
  BACKDROP_KINDS,
  allStoryboardScenes,
  buildTranscriptResolver,
  captionSegmentsOf,
  clipRoleOf,
  clipSpeedOf,
  collectBrollGaps,
  collectSceneLayouts,
  collectSubjectPlacements,
  loadTranscript,
  sceneLayoutOf,
  distributionFromStoryboard,
  effectiveClipDuration,
  expectedTimelineDurationSeconds,
  realizedScopeDurationSeconds,
  findTimeline,
  isGapPlacement,
  isSubjectPlacement,
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
