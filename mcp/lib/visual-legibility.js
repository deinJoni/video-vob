"use strict";

// Deterministic caption-CONTRAST check (v3.9.1 — the engine half of the
// visual-critic feature, the walker-testable companion to the model critic).
//
// Closes the long-standing QC-B "ceded to the human" gap: nothing in the stack
// measured whether a burned-in caption is actually READABLE against what's
// behind it (the white-caption-on-a-bright-shot slop defect). This module turns
// a rendered still + the platform caption safe band into a WCAG-ish contrast
// ratio and an advisory finding (`qc/caption_low_contrast`).
//
// Why the safe band and not exact per-caption boxes: `hyperframes inspect` only
// reports geometry for OVERFLOWING elements — there is no way to get a
// non-overflowing caption's bounding box. So we sample the background luma in the
// region the platform profile says captions live in (lower-middle third by
// default), and only at stills whose timecode lands in a scene that PLANS
// captions. That keeps the check pure-ffprobe (no browser), deterministic, and
// low-false-positive.
//
// Posture: ADVISORY + DEGRADE-NEVER-THROW, exactly like still-qc.js. Any missing
// input (no dims, no scene timeline, an unprobeable region) → emit nothing. The
// finding folds into vob_qc_stills' findings list and rides the existing
// glaring → composer auto-fix / taste → user-note routing. NEVER an error: the
// COMPOSE→PREVIEW gate (errors only) is unchanged.
//
// The pure functions (contrast math, color parse, band geometry, timecode→scene
// mapping, classification) are unit-tested source-free by the `visualqc` walker
// phase. The ONE impure helper (sampleRegionLuma) takes an injectable signalstats
// fn so it's testable without ffmpeg.

const { signalstatsLuma } = require("./ffprobe.js");

// --- visual-critic spawn gate (Pillar A) -------------------------------------
// VOB_VISUAL_CRITIC: "off" never spawns the visual-critic (the orchestrator
// falls back to its inline self-QC); "always" spawns it whenever there is a
// composition to judge; "auto" (default) spawns it when the active scope carries
// captions / typed overlays / a design look (mirrors VOB_LAYOUT_QC). Surfaced via
// read_state_summary.visual_critic_mode so the orchestrator — which cannot read
// process.env — can honor it. Unrecognized -> "auto".
function visualCriticMode(env) {
  const raw = String((env || process.env).VOB_VISUAL_CRITIC || "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
  if (raw === "always" || raw === "on" || raw === "force" || raw === "1") return "always";
  return "auto";
}

// --- WCAG-style luminance + contrast (pure) ----------------------------------

// sRGB gamma → linear, for one 0-255 channel. (WCAG 2.x relative-luminance def.)
function srgbChannel(c) {
  const s = Math.min(Math.max(Number(c), 0), 255) / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// Relative luminance [0,1] of an sRGB color we KNOW the RGB of (the caption's
// declared text color). The accurate side of the comparison.
function srgbRelativeLuminance(r, g, b) {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

// Relative luminance [0,1] from a signalstats luma (Y, 0-255). We only have luma
// for the background region (ffprobe signalstats reports Y, not linear RGB), so
// this is an APPROXIMATION — treat the gray of value Y as an sRGB gray and
// linearize it. Good enough for an advisory contrast heuristic.
function lumaToRelativeLuminance(luma255) {
  if (!Number.isFinite(luma255)) return null;
  return srgbChannel(luma255);
}

// WCAG contrast ratio of two relative luminances ∈ [0,1] → [1,21].
function contrastRatio(lA, lB) {
  if (!Number.isFinite(lA) || !Number.isFinite(lB)) return null;
  const a = Math.min(Math.max(lA, 0), 1);
  const b = Math.min(Math.max(lB, 0), 1);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- color parsing (pure) ----------------------------------------------------

const NAMED_COLORS = Object.freeze({
  white: [255, 255, 255],
  black: [0, 0, 0],
  // a viewer's caption is almost always white or near-black; the rest is
  // best-effort so a token like "yellow" still resolves rather than degrading.
  yellow: [255, 255, 0],
  red: [255, 0, 0],
  cyan: [0, 255, 255],
});

function clampByte(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.round(n), 0), 255);
}

// Parse a CSS-ish color string to [r,g,b] (0-255) or null. Handles #rgb / #rgba /
// #rrggbb / #rrggbbaa, rgb()/rgba(), and a few named colors. Alpha is ignored
// (a caption's text color drives contrast; a translucent caption is a separate
// legibility problem the visual-critic model judges).
function parseColorRgb(color) {
  if (typeof color !== "string") return null;
  const s = color.trim().toLowerCase();
  if (!s) return null;
  if (NAMED_COLORS[s]) return NAMED_COLORS[s].slice();
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
  if (m) {
    // Percentage rgb (e.g. `rgb(50%, 50%, 50%)`) would be mis-read as raw 0-255
    // (50% -> 50, not 128) — degrade to null (the caller then assumes white)
    // rather than compute a wrong contrast.
    if (s.includes("%")) return null;
    const rgb = [clampByte(m[1]), clampByte(m[2]), clampByte(m[3])];
    return rgb.every((v) => v != null) ? rgb : null;
  }
  return null;
}

// Relative luminance of a color string, or null if unparseable.
function parseColorLuma(color) {
  const rgb = parseColorRgb(color);
  return rgb ? srgbRelativeLuminance(rgb[0], rgb[1], rgb[2]) : null;
}

// The caption text color the composition declared, from target.design — or null
// (the caller then assumes white, the dominant default and the worst case for a
// bright background, but caps severity at `taste` because it's an assumption).
function captionTextColor(targetDesign) {
  if (!targetDesign || typeof targetDesign !== "object") return null;
  const cs = targetDesign.caption_style;
  if (cs && typeof cs === "object") {
    for (const k of ["color", "text_color", "fill"]) {
      if (typeof cs[k] === "string" && cs[k].trim()) return cs[k].trim();
    }
  }
  const pal = targetDesign.palette;
  if (pal && typeof pal === "object") {
    for (const k of ["caption", "text", "foreground", "fg"]) {
      if (typeof pal[k] === "string" && pal[k].trim()) return pal[k].trim();
    }
  }
  return null;
}

// --- thresholds + classification (pure) --------------------------------------

const CONTRAST_DEFAULTS = Object.freeze({
  // below this ⇒ a finding at all (WCAG AA for large text is 3.0:1 — captions
  // are large overlay text, so 3.0 is the "comfortable" floor).
  tasteRatio: 3.0,
  // below this ⇒ glaring (genuinely hard to read), but only when the text color
  // is KNOWN (not assumed white) — see classifyCaptionContrast.
  glaringRatio: 2.0,
});

function resolveContrastThresholds(env) {
  const e = env || process.env;
  const pick = (raw, fb) => {
    const x = Number(raw);
    return Number.isFinite(x) && x > 0 ? x : fb;
  };
  const tasteRatio = pick(e.VOB_QC_CONTRAST_TASTE, CONTRAST_DEFAULTS.tasteRatio);
  let glaringRatio = pick(e.VOB_QC_CONTRAST_GLARING, CONTRAST_DEFAULTS.glaringRatio);
  if (glaringRatio > tasteRatio) glaringRatio = tasteRatio;
  return { tasteRatio, glaringRatio };
}

// Turn a contrast ratio into a finding (or null = fine). `colorKnown=false` (the
// caller assumed white text) caps severity at `taste`: we never force a re-render
// on an assumption. Returns { code, severity, message } — extra evidence fields
// are attached by evaluateStillCaptionContrast.
function classifyCaptionContrast(ratio, { thresholds = resolveContrastThresholds(), colorKnown = true, assumedNote = "" } = {}) {
  if (!Number.isFinite(ratio)) return null;
  const t = thresholds;
  if (ratio >= t.tasteRatio) return null;
  const glaring = colorKnown && ratio < t.glaringRatio;
  const assumed = colorKnown ? "" : ` ${assumedNote || "(assuming white caption text)"}`;
  return {
    code: "qc/caption_low_contrast",
    severity: glaring ? "glaring" : "taste",
    message:
      `caption text has low contrast (~${ratio.toFixed(1)}:1) against the background in the caption `
      + `safe band${assumed} — add a scrim/plate behind the caption, darken the lower-third, or `
      + `recolor the text (WCAG-ish heuristic; advisory)`,
  };
}

// --- caption-band geometry (pure) --------------------------------------------

// The rectangle (in still pixels) where captions live, from the platform profile.
// Anchored at the bottom by default (lower-middle third). Returns {x,y,w,h} ints
// or null when the profile can't give us a sane band (no dims → degrade → skip).
function captionBandRect({ width, height, safeTopPx = 0, safeBottomPx = 0, anchor = "bottom", offsetPx = null } = {}) {
  const W = Number(width);
  const H = Number(height);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null;
  const safeTop = Number.isFinite(Number(safeTopPx)) && safeTopPx > 0 ? Number(safeTopPx) : 0;
  const safeBottom = Number.isFinite(Number(safeBottomPx)) && safeBottomPx > 0 ? Number(safeBottomPx) : 0;
  const off = Number.isFinite(Number(offsetPx)) && offsetPx > 0 ? Number(offsetPx) : null;

  // A band tall enough to contain a 1-2 line caption: ~16% of height, floored at
  // 80px, capped at 40% of height.
  const bandH = Math.min(Math.max(Math.round(H * 0.16), 80), Math.round(H * 0.4));
  // Horizontal: center 86% (captions don't run edge-to-edge).
  const x = Math.round(W * 0.07);
  const w = Math.round(W * 0.86);

  const a = String(anchor || "bottom").toLowerCase();
  let top;
  if (a === "top") {
    const margin = off != null ? off : safeTop;
    top = margin;
  } else if (a === "center" || a === "middle") {
    top = Math.round((H - bandH) / 2);
  } else {
    // bottom (default): the caption sits `off` (or the bottom safe inset) up from
    // the bottom edge.
    const margin = off != null ? off : safeBottom;
    top = H - margin - bandH;
  }
  // Clamp inside the frame.
  top = Math.min(Math.max(Math.round(top), 0), Math.max(0, H - 1));
  let h = bandH;
  if (top + h > H) h = H - top;
  if (h <= 0 || w <= 0) return null;
  return { x, y: top, w, h };
}

// --- timecode → scene mapping (pure) -----------------------------------------

function sceneHasCaptions(scene) {
  if (!scene || typeof scene !== "object") return false;
  const cs = scene.caption_segments;
  if (Array.isArray(cs) && cs.length > 0) return true;
  const c = scene.captions;
  if (Array.isArray(c)) return c.length > 0;
  if (typeof c === "string") return c.trim() !== "";
  if (c && typeof c === "object") return true;
  return false;
}

// The scene covering output-time `t` (cumulative target_duration_seconds cursor —
// the same math snapshot-keyframes uses). null when the timeline is malformed
// (any non-positive duration) or `t` is past the end (degrade → skip).
function sceneAtTime(scenes, t) {
  if (!Array.isArray(scenes) || scenes.length === 0 || !Number.isFinite(t) || t < 0) return null;
  let cursor = 0;
  for (const sc of scenes) {
    const d = sc && Number(sc.target_duration_seconds);
    if (!Number.isFinite(d) || d <= 0) return null;
    if (t < cursor + d) return sc;
    cursor += d;
  }
  // A boundary sample exactly at/just past the final scene end → the last scene.
  if (t <= cursor + 0.05) return scenes[scenes.length - 1];
  return null;
}

// --- region sampling (impure; injectable signalstats for tests) --------------

// Mean luma (0-255) of a sub-rectangle of a still, via ffprobe signalstats with a
// crop. DEGRADES to null on any failure. `signalstats` is injectable so the
// walker can exercise the orchestration without ffmpeg.
function sampleRegionLuma(stillPath, rect, { signalstats = signalstatsLuma } = {}) {
  if (typeof stillPath !== "string" || !stillPath || !rect) return null;
  let res;
  try {
    res = signalstats(stillPath, { crop: rect });
  } catch {
    return null;
  }
  if (!res || res.probed === false || !Number.isFinite(res.yavg)) return null;
  return res.yavg;
}

// --- the one orchestration entrypoint qc_stills calls ------------------------

// Evaluate caption contrast for ONE still. Returns a finding (with evidence
// fields) or null. Null whenever there's nothing to check or anything degrades:
//   • the still's timecode lands in a scene that plans no captions → null
//   • the platform profile can't give a band → null
//   • the region can't be probed → null
// `scenes` MUST already be scoped to the active short/segment (the caller scopes
// it, exactly like layout-qc) so the cursor math matches the composition.
function evaluateStillCaptionContrast({
  stillPath,
  scenes,
  timeSeconds,
  platform,
  targetDesign,
  thresholds = resolveContrastThresholds(),
  signalstats = signalstatsLuma,
} = {}) {
  if (!Number.isFinite(timeSeconds)) return null;
  const scene = sceneAtTime(scenes, timeSeconds);
  if (!scene || !sceneHasCaptions(scene)) return null;

  const rect = captionBandRect(platform || {});
  if (!rect) return null;

  const bgLuma = sampleRegionLuma(stillPath, rect, { signalstats });
  if (!Number.isFinite(bgLuma)) return null;
  const bgL = lumaToRelativeLuminance(bgLuma);

  const declared = captionTextColor(targetDesign);
  const declaredL = declared != null ? parseColorLuma(declared) : null;
  const colorKnown = Number.isFinite(declaredL);
  const textL = colorKnown ? declaredL : 1.0; // assume white when undeclared/unparseable
  // Distinguish "no color declared" from "declared but unparseable" so the
  // finding's assumption note is accurate (both cases cap severity at taste).
  const assumedNote = colorKnown
    ? ""
    : (declared != null
      ? `(caption color "${declared}" not parseable — assuming white text)`
      : "(assuming white caption text — none declared in target.design)");

  const ratio = contrastRatio(textL, bgL);
  const finding = classifyCaptionContrast(ratio, { thresholds, colorKnown, assumedNote });
  if (!finding) return null;
  return {
    ...finding,
    contrast_ratio: Math.round(ratio * 100) / 100,
    bg_luma: Math.round(bgLuma),
    text_color: colorKnown ? declared : null,
    region: rect,
    scene_id: typeof scene.scene_id === "string" ? scene.scene_id : null,
  };
}

module.exports = {
  // spawn gate
  visualCriticMode,
  // pure
  srgbRelativeLuminance,
  lumaToRelativeLuminance,
  contrastRatio,
  parseColorRgb,
  parseColorLuma,
  captionTextColor,
  resolveContrastThresholds,
  classifyCaptionContrast,
  captionBandRect,
  sceneHasCaptions,
  sceneAtTime,
  CONTRAST_DEFAULTS,
  // impure (injectable)
  sampleRegionLuma,
  evaluateStillCaptionContrast,
};
