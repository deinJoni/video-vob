"use strict";

// Render segmentation (v3 P2) — the length unlock. A long-form video is N
// consecutive render segments + a join (vob_assemble_video): each segment is a
// normal hyperframes composition that fits the host <video> budget, rendered
// through the SAME compose/preview/render cycle as a fan-out short, with the
// partials parked in <session>/segment_renders/ and concatenated at assembly.
//
// Two segment notions, deliberately distinct:
//   - NARRATIVE segments (storyboard.segments[]): human-planned acts/chapters.
//     Drive chapter markers at PACKAGE; under "manual" they ARE the render units.
//   - RENDER segments (this module): engine-derived chunks. "auto" chunks
//     consecutive scenes to the <video> budget, respecting narrative boundaries
//     when declared; "single" is the v2.1 one-composition path (no machinery).
//
// The derived plan is STAMPED into state.render_plan at COMPOSE entry (like
// transcoded_clips) so every consumer reads one truth; registry entries
// (state.segment_renders) bind to the plan via storyboard_revision + scene_ids
// — re-saving the storyboard invalidates every partial (the plan changed).

const fs = require("fs");

const hostProfile = require("./host-profile.js");
const {
  sceneVideoCount,
  storyboardHasShorts,
  storyboardSegments,
} = require("./storyboard-schema.js");
const { resolveActiveVideoType } = require("./video-types.js");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sceneDuration(scene) {
  const d = isPlainObject(scene) ? Number(scene.target_duration_seconds) : NaN;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function chunkRow(segmentId, title, scenes, transitionOut) {
  return {
    segment_id: segmentId,
    title,
    scene_ids: scenes.map((s) => s.scene_id),
    target_duration_seconds: Math.round(scenes.reduce((acc, s) => acc + sceneDuration(s), 0) * 1000) / 1000,
    video_count: scenes.reduce((acc, s) => acc + sceneVideoCount(s), 0),
    transition_out: transitionOut || "cut",
  };
}

// Greedy budget chunking of consecutive scenes — never splits a scene; a
// single over-budget scene gets its own chunk (composition QC then warns/errors
// on it as today). Pure and deterministic for a given (scenes, budget).
function chunkScenesToBudget(scenes, budget) {
  const chunks = [];
  let current = [];
  let currentCount = 0;
  for (const scene of scenes) {
    const cost = sceneVideoCount(scene);
    if (current.length > 0 && currentCount + cost > budget) {
      chunks.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(scene);
    currentCount += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// deriveRenderPlan({ storyboard, state }) ->
//   { mode: "single" } |
//   { mode: "segmented", segmentation: "auto"|"manual", video_budget,
//     segments: [{ segment_id, title, scene_ids, target_duration_seconds,
//                  video_count, transition_out }] }
// Mode resolution: storyboard.render_segmentation > preset render.segmentation
// > "single". Fan-out (shorts[]) is always single (each short is its own
// render). "auto" that fits in one chunk collapses to single — zero overhead
// when segmentation isn't needed.
function deriveRenderPlan({ storyboard, state }) {
  const sb = isPlainObject(storyboard) ? storyboard : null;
  if (!sb || storyboardHasShorts(sb)) return { mode: "single" };
  const scenes = Array.isArray(sb.scenes) ? sb.scenes.filter(isPlainObject) : [];
  if (scenes.length === 0) return { mode: "single" };

  const preset = resolveActiveVideoType(state).preset;
  const requested = isNonEmptyString(sb.render_segmentation)
    ? sb.render_segmentation
    : preset.render.segmentation;
  if (requested === "single") return { mode: "single" };

  const budget = hostProfile.videoBudget();
  const narrative = storyboardSegments(sb);

  if (requested === "manual") {
    if (narrative.length === 0) return { mode: "single" }; // schema enforces; belt-and-braces
    return {
      mode: "segmented",
      segmentation: "manual",
      video_budget: budget,
      segments: narrative.map((seg) => chunkRow(seg.segment_id, seg.title, seg.scenes, seg.transition_out)),
    };
  }

  // auto: chunk within narrative boundaries when declared, else across all
  // scenes. Splitting a narrative segment yields "<id>-p1", "<id>-p2", ... with
  // hard cuts at the intra splits and the narrative transition_out on its last
  // part.
  const segments = [];
  if (narrative.length > 0) {
    for (const seg of narrative) {
      const chunks = chunkScenesToBudget(seg.scenes, budget);
      if (chunks.length === 1) {
        segments.push(chunkRow(seg.segment_id, seg.title, chunks[0], seg.transition_out));
      } else {
        chunks.forEach((chunk, ix) => {
          const last = ix === chunks.length - 1;
          segments.push(chunkRow(
            `${seg.segment_id}-p${ix + 1}`,
            `${seg.title} (part ${ix + 1})`,
            chunk,
            last ? seg.transition_out : "cut",
          ));
        });
      }
    }
  } else {
    const chunks = chunkScenesToBudget(scenes, budget);
    chunks.forEach((chunk, ix) => {
      segments.push(chunkRow(`seg-${ix + 1}`, `Segment ${ix + 1}`, chunk, "cut"));
    });
  }
  if (segments.length <= 1) return { mode: "single" };
  return { mode: "segmented", segmentation: "auto", video_budget: budget, segments };
}

// --- plan/state accessors ------------------------------------------------------

function renderPlanOf(state) {
  const plan = state && isPlainObject(state.render_plan) ? state.render_plan : null;
  return plan && plan.mode === "segmented" && Array.isArray(plan.segments) && plan.segments.length > 0
    ? plan
    : null;
}

function planSegmentById(state, segmentId) {
  const plan = renderPlanOf(state);
  if (!plan || !isNonEmptyString(segmentId)) return null;
  return plan.segments.find((s) => s.segment_id === segmentId) || null;
}

function activeCompositionSegmentId(state) {
  const composition = state && isPlainObject(state.composition) ? state.composition : null;
  return composition && isNonEmptyString(composition.segment_id) ? composition.segment_id : null;
}

function sameSceneIds(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// Registry validity: a segment's partial counts only when (1) the registry
// entry exists, (2) its mp4 is on disk, (3) it was rendered against the
// CURRENT storyboard revision, and (4) its scene_ids still match the plan
// segment. Returns { byId, missing, stale } — `missing` lists every plan
// segment without a valid partial (stale ⊆ reported reasons).
function validSegmentRenders(state) {
  const plan = renderPlanOf(state);
  const registry = state && isPlainObject(state.segment_renders) ? state.segment_renders : {};
  const storyboardRevision = state && isPlainObject(state.storyboard) && Number.isInteger(state.storyboard.revision_count)
    ? state.storyboard.revision_count
    : null;
  const byId = new Map();
  const missing = [];
  const stale = [];
  if (!plan) return { plan: null, byId, missing, stale };
  for (const segment of plan.segments) {
    const entry = isPlainObject(registry[segment.segment_id]) ? registry[segment.segment_id] : null;
    if (!entry || typeof entry.mp4_path !== "string" || !entry.mp4_path || !fs.existsSync(entry.mp4_path)) {
      missing.push(segment.segment_id);
      continue;
    }
    const revisionOk = storyboardRevision === null
      || (Number.isInteger(entry.storyboard_revision) && entry.storyboard_revision === storyboardRevision);
    const scenesOk = sameSceneIds(entry.scene_ids, segment.scene_ids);
    if (!revisionOk || !scenesOk) {
      missing.push(segment.segment_id);
      stale.push(segment.segment_id);
      continue;
    }
    byId.set(segment.segment_id, entry);
  }
  return { plan, byId, missing, stale };
}

module.exports = {
  activeCompositionSegmentId,
  chunkScenesToBudget,
  deriveRenderPlan,
  planSegmentById,
  renderPlanOf,
  sceneVideoCount,
  validSegmentRenders,
};
