"use strict";

// Layout / legibility QC (v3.3) — the pure-function half of the `hyperframes
// inspect` fold-in. The runner (hyperframes-runner.js::runInspect) does the
// browser render; this module decides WHEN to spend it, parses the report, and
// maps overflow issues into the merged-lint findings list as ADVISORY findings.
//
// Invariant: these findings are NEVER errors. A too-tight safe area is a
// judgment call and inspect's pixel tolerance is a heuristic, so overflow folds
// in as warnings (off-canvas as info) — the COMPOSE->PREVIEW gate (errors only)
// is unchanged. Captions stay advisory; the only caption ERROR remains the
// pre-existing exact:true binding contract in composition-qc.js.

const {
  allStoryboardScenes,
  findTimeline,
  captionSegmentsOf,
  typedOverlaysOf,
} = require("./storyboard-schema.js");

// --- mode knob ---------------------------------------------------------------
// VOB_LAYOUT_QC: "off" never runs; "always" runs whenever there's a composition
// to inspect; "auto" (default) defers to shouldRunLayoutQc (captions/overlays in
// the active scope). Unrecognized -> "auto".
function layoutQcMode() {
  const raw = (process.env.VOB_LAYOUT_QC || "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
  if (raw === "always" || raw === "on" || raw === "force" || raw === "1") return "always";
  return "auto";
}

// --- scoping -----------------------------------------------------------------
// The scenes whose captions/overlays this composition realizes: a fan-out short,
// a render segment, or (default) the whole document.
function scenesInScope(storyboard, { activeShortId = null, activeSegment = null } = {}) {
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) return [];
  if (activeShortId) {
    const tl = findTimeline(storyboard, activeShortId);
    return tl && Array.isArray(tl.scenes) ? tl.scenes : [];
  }
  const all = allStoryboardScenes(storyboard);
  if (activeSegment && Array.isArray(activeSegment.scene_ids) && activeSegment.scene_ids.length > 0) {
    const want = new Set(activeSegment.scene_ids);
    return all.filter((s) => s && want.has(s.scene_id));
  }
  return all;
}

// True when the active scope has >=1 object-form caption_segment OR >=1 typed
// overlay — something geometric to measure. Plain-string captions/overlays
// (freeform notes) are not binding layout elements, so they don't trigger a
// (costly) browser render. captionSegmentsOf/typedOverlaysOf already filter to
// object form.
function shouldRunLayoutQc(storyboard, scope = {}) {
  const scenes = scenesInScope(storyboard, scope);
  for (const scene of scenes) {
    if (!scene) continue;
    if (captionSegmentsOf(scene).length > 0) return true;
    if (typedOverlaysOf(scene).length > 0) return true;
  }
  return false;
}

// --- report parsing ----------------------------------------------------------
// Tolerant parse of `hyperframes inspect --json` stdout (shape: { schemaVersion,
// duration, samples[], ok, issueCount, issues[{code,severity,time,selector,
// containerSelector,text,overflow,fixHint,...}], truncated }). Mirrors
// parseLintReport's failure tolerance.
function parseInspectReport(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    return { ok: false, issues: [], sample_count: 0, issue_count: 0, truncated: false, parse_error: "empty stdout" };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, issues: [], sample_count: 0, issue_count: 0, truncated: false, parse_error: err.message || String(err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, issues: [], sample_count: 0, issue_count: 0, truncated: false, parse_error: "expected JSON object" };
  }
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i) => i && typeof i === "object") : [];
  const sampleCount = Array.isArray(parsed.samples)
    ? parsed.samples.length
    : (Number.isInteger(parsed.sampleCount) ? parsed.sampleCount : 0);
  return {
    ok: true,
    issues,
    sample_count: sampleCount,
    issue_count: Number.isInteger(parsed.issueCount) ? parsed.issueCount : issues.length,
    truncated: parsed.truncated === true,
    parse_error: null,
  };
}

// --- finding builders --------------------------------------------------------
function makeFinding(severity, rule, message) {
  return { severity, rule, message, file: null, line: null, column: null, source: "vob" };
}

// A run-status note (inspect timed out / crashed / unparseable). Info, so it
// never affects warnings_only/clean status — purely informational visibility.
function layoutAdvisory(rule, message) {
  return makeFinding("info", rule, message);
}

const ATTR_ID_RE = /data-vob-(caption|overlay)-id\s*=\s*"([^"]+)"/i;

function normText(s) {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

function maxOverflowPx(overflow) {
  if (!overflow || typeof overflow !== "object") return null;
  let max = null;
  for (const k of ["right", "left", "top", "bottom"]) {
    const v = Number(overflow[k]);
    if (Number.isFinite(v)) max = max == null ? v : Math.max(max, v);
  }
  return max;
}

function fmtTime(t) {
  const n = Number(t);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "?";
}

// Map hyperframes inspect issues -> vob findings (always advisory). One finding
// per overflowing element (grouped by selector) so a text_box_overflow +
// canvas_overflow on the SAME element don't double-report. Attribution: an
// element whose selector/containerSelector carries data-vob-caption-id /
// data-vob-overlay-id, or whose rendered text matches a planned caption/overlay
// in the active scope -> vob/caption_overflow (warning); anything else ->
// vob/layout_overflow (warning). An element that ONLY runs off the canvas (often
// an intentional mid-transition slide) -> info, to keep the report low-noise.
function mapInspectIssues(report, { storyboard = null, activeShortId = null, activeSegment = null } = {}) {
  if (!report || report.ok === false || !Array.isArray(report.issues) || report.issues.length === 0) return [];

  // Planned caption/overlay text in the active scope, for text-based attribution
  // when the inspect selector doesn't carry the binding id (it usually doesn't).
  const plannedText = new Map(); // normalized text -> { kind, id }
  for (const scene of scenesInScope(storyboard, { activeShortId, activeSegment })) {
    if (!scene) continue;
    for (const seg of captionSegmentsOf(scene)) {
      const t = normText(seg && seg.text);
      if (t && !plannedText.has(t)) plannedText.set(t, { kind: "caption", id: typeof seg.id === "string" && seg.id ? seg.id : null });
    }
    for (const ov of typedOverlaysOf(scene)) {
      const t = normText(ov && ov.content);
      if (t && !plannedText.has(t)) plannedText.set(t, { kind: "overlay", id: typeof ov.id === "string" && ov.id ? ov.id : null });
    }
  }

  // Group by selector (fall back to text), keeping the strongest overflow:
  // a box/text/container overflow outranks a pure off-canvas one.
  const groups = new Map();
  let synthetic = 0;
  for (const issue of report.issues) {
    const code = typeof issue.code === "string" ? issue.code : "overflow";
    const key = (typeof issue.selector === "string" && issue.selector)
      || (typeof issue.text === "string" && issue.text)
      || `__${synthetic++}`;
    const rank = code === "canvas_overflow" ? 0 : 1;
    const prev = groups.get(key);
    if (!prev || rank > prev.rank) groups.set(key, { issue, code, rank });
  }

  const findings = [];
  for (const { issue, code } of groups.values()) {
    const selector = typeof issue.selector === "string" ? issue.selector : "";
    const containerSelector = typeof issue.containerSelector === "string" ? issue.containerSelector : "";
    const text = typeof issue.text === "string" ? issue.text : "";

    let attribution = null;
    const m = selector.match(ATTR_ID_RE) || containerSelector.match(ATTR_ID_RE);
    if (m) {
      attribution = { kind: m[1].toLowerCase(), id: m[2] };
    } else {
      const hit = plannedText.get(normText(text));
      if (hit) attribution = hit;
    }

    const offCanvasOnly = code === "canvas_overflow";
    const severity = offCanvasOnly ? "info" : "warning";
    const rule = attribution ? "vob/caption_overflow" : "vob/layout_overflow";
    const px = maxOverflowPx(issue.overflow);
    const who = attribution
      ? `${attribution.kind}${attribution.id ? ` "${attribution.id}"` : ""}`
      : (selector || "an element");
    const where = offCanvasOnly ? "extends off the composition canvas" : "overflows its container box";
    const fixHint = typeof issue.fixHint === "string" && issue.fixHint ? ` ${issue.fixHint}` : "";
    const message = `${who} ${where}${px != null ? ` by ~${Math.round(px)}px` : ""}`
      + `${text ? ` ("${text.slice(0, 48)}${text.length > 48 ? "…" : ""}")` : ""}`
      + ` at t≈${fmtTime(issue.time)}s.${fixHint}`;
    findings.push(makeFinding(severity, rule, message));
  }
  return findings;
}

module.exports = {
  layoutQcMode,
  scenesInScope,
  shouldRunLayoutQc,
  parseInspectReport,
  mapInspectIssues,
  layoutAdvisory,
};
