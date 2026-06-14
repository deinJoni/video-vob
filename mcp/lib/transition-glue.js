"use strict";

// Scene-transition glue + render-chunk packing (v3.3). A non-cut, NON-seam
// transition_in (video-types::isGlueTransition) means "render this scene in the
// SAME composition as the previous one" — the transition is intra-composition
// and cannot be expressed as an ffmpeg seam. deriveRenderPlan packs GLUE GROUPS
// (not bare scenes) to the host <video> budget; a glue group that still exceeds
// the hard cap is split at the cheapest internal boundary with the broken
// transition DOWNGRADED to a seam (dissolve family -> "fade"/dip-to-black, else
// -> "cut"). The plan lint surfaces those downgrades as PLAN_TRANSITION_DOWNGRADED.
//
// Kept dependency-light (video-types only; the per-scene <video> cost is passed
// in as getCost) so BOTH render-segments.js and storyboard-schema.js can import
// it without a require cycle (storyboard-schema <-> render-segments would
// otherwise deadlock on each other's partial exports at load time).

const { isGlueTransition, transitionTypeOf } = require("./video-types.js");

// A broken glue transition becomes a seam: the dissolve family degrades to a
// duration-preserving dip-to-black ("fade", what vob_assemble_video produces);
// kinetic/reveal/shader degrade to a hard "cut" (half a slide across an ffmpeg
// join would look broken, so don't pretend).
const DISSOLVE_FAMILY = new Set(["crossfade", "blur_dissolve", "focus_pull", "dip", "fade"]);

function seamForBrokenTransition(type) {
  return DISSOLVE_FAMILY.has(type) ? "fade" : "cut";
}

// Normalize any transition_out value to the ONLY two seams vob_assemble_video
// understands: "cut" (stream copy) or "fade" (0.25s dip-to-black). A non-seam
// transition_out (e.g. a kinetic "whip_pan" mistakenly placed on the seam field)
// degrades — dissolve family / dip / fade -> "fade", everything else -> "cut"
// (PRD-02 §7.3). This is where the schema's loosened transition_out lands safely.
function seamOf(value) {
  if (typeof value !== "string") return "cut";
  const t = value.trim().toLowerCase();
  if (t === "" || t === "cut") return "cut";
  return DISSOLVE_FAMILY.has(t) ? "fade" : "cut";
}

// Maximal runs of consecutive scenes joined by a glue transition_in.
function glueGroups(scenes) {
  const groups = [];
  for (const scene of scenes) {
    const glued = groups.length > 0 && isGlueTransition(scene && scene.transition_in);
    if (glued) groups[groups.length - 1].push(scene);
    else groups.push([scene]);
  }
  return groups;
}

function groupCost(group, getCost) {
  return group.reduce((acc, s) => acc + getCost(s), 0);
}

// Greedy pack consecutive scenes to a cap by getCost; never splits a scene (an
// over-cap single scene becomes its own run, as before — composition QC warns/
// errors on it). Identical in shape to the historical chunkScenesToBudget.
function greedyPack(scenes, cap, getCost) {
  const runs = [];
  let current = [];
  let count = 0;
  for (const scene of scenes) {
    const cost = getCost(scene);
    if (current.length > 0 && count + cost > cap) {
      runs.push(current);
      current = [];
      count = 0;
    }
    current.push(scene);
    count += cost;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

// Pack a consecutive scene list into render chunks, keeping glue groups intact.
// Returns { chunks: [{ scenes, outSeam }], downgrades: [{ scene_id, from_type,
// to_seam, reason }] }. outSeam is the transition_out to the NEXT chunk
// ("cut" for a budget-driven boundary; the downgrade seam for a forced glue
// split); the caller sets the LAST chunk's transition_out (narrative seam/"cut").
//
// With NO glue transitions (every transition_in cut/seam) this reduces exactly
// to the historical greedy budget pack — back-compat for all-cut storyboards.
function packScenesGlueAware(scenes, budget, hardCap, getCost) {
  const cap = Math.max(1, hardCap);
  const downgrades = [];
  // 1. Atomic units = glue groups, splitting any group over the hard cap.
  const units = []; // { scenes, forcedSeam: null | "cut" | "fade" }
  for (const group of glueGroups(scenes)) {
    if (groupCost(group, getCost) <= cap) {
      units.push({ scenes: group, forcedSeam: null });
      continue;
    }
    const subRuns = greedyPack(group, cap, getCost);
    subRuns.forEach((run, ix) => {
      if (ix === 0) {
        units.push({ scenes: run, forcedSeam: null });
        return;
      }
      const t = transitionTypeOf(run[0] && run[0].transition_in);
      const seam = seamForBrokenTransition(t);
      downgrades.push({
        scene_id: run[0] && run[0].scene_id,
        from_type: t,
        to_seam: seam,
        reason: "glue_group_over_hard_cap",
      });
      units.push({ scenes: run, forcedSeam: seam });
    });
  }
  // 2. Greedy-pack units into chunks by the (soft) budget. A forced-seam unit
  // ALWAYS starts a new chunk; the chunk it closes carries that forced seam. A
  // single glue group between budget and hardCap renders as one over-budget
  // chunk (intended — glue beats the soft target; QC warns, doesn't error).
  const chunks = [];
  let current = null; // { scenes, count }
  for (const unit of units) {
    const unitCost = groupCost(unit.scenes, getCost);
    if (current !== null && (unit.forcedSeam !== null || current.count + unitCost > budget)) {
      // Seam to the next chunk: a FORCED glue split carries its downgrade seam; a
      // budget-driven boundary takes the next chunk's first scene's transition_in
      // (a seam-expressible dip/fade there → a dip-to-black seam, else a cut — the
      // first scene of any glue group always has a non-glue transition_in).
      const seam = unit.forcedSeam !== null
        ? unit.forcedSeam
        : seamOf(transitionTypeOf(unit.scenes[0] && unit.scenes[0].transition_in));
      chunks.push({ scenes: current.scenes, outSeam: seam });
      current = null;
    }
    if (current === null) current = { scenes: [], count: 0 };
    current.scenes.push(...unit.scenes);
    current.count += unitCost;
  }
  if (current !== null) chunks.push({ scenes: current.scenes, outSeam: "cut" });
  return { chunks, downgrades };
}

// Convenience for the plan lint: just the downgrades a scene list would force.
function glueDowngrades(scenes, budget, hardCap, getCost) {
  return packScenesGlueAware(scenes, budget, hardCap, getCost).downgrades;
}

module.exports = {
  glueGroups,
  packScenesGlueAware,
  glueDowngrades,
  seamOf,
};
