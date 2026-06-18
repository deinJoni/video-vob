"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, snapshotsDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { signalstatsLuma } = require("../ffprobe.js");
const { classifyStillLuma, resolveThresholds } = require("../still-qc.js");
const { findTimeline } = require("../storyboard-schema.js");
const { planSegmentById } = require("../render-segments.js");
const { evaluateStillCaptionContrast, resolveContrastThresholds } = require("../visual-legibility.js");

const REPORT_NAME = "stills-qc.json";
const MAX_INLINE_FINDINGS = 10;

function nowIso() {
  return new Date().toISOString();
}

// (v3.9.1) Resolve everything the deterministic caption-CONTRAST check needs,
// ONCE, from disk + state: the scoped scene list (for timecode->scene mapping,
// scoped to the active short/segment exactly like snapshot-keyframes), the
// platform caption-band geometry, the declared caption text color
// (target.design), and the thresholds. Returns null whenever the check can't run
// (no platform dims, no storyboard, no scenes in scope) — the contrast pass is
// then skipped entirely. DEGRADES, never throws: the whole pass is advisory.
function resolveContrastContext(projectId, state) {
  try {
    const answers = state && state.intent && typeof state.intent === "object" && state.intent.answers
      ? state.intent.answers
      : {};
    const platformSlot = answers.target_platform && typeof answers.target_platform === "object"
      ? answers.target_platform
      : null;
    const profile = platformSlot && platformSlot.profile && typeof platformSlot.profile === "object"
      ? platformSlot.profile
      : null;
    if (!profile || !(Number(profile.width) > 0) || !(Number(profile.height) > 0)) return null;
    const caps = profile.caption_defaults && typeof profile.caption_defaults === "object"
      ? profile.caption_defaults
      : {};
    const platform = {
      width: Number(profile.width),
      height: Number(profile.height),
      safeTopPx: Number(profile.safe_top_px) > 0 ? Number(profile.safe_top_px) : 0,
      safeBottomPx: Number(profile.safe_bottom_px) > 0 ? Number(profile.safe_bottom_px) : 0,
      anchor: typeof caps.anchor === "string" ? caps.anchor : "bottom",
      offsetPx: Number(caps.offset_px) > 0 ? Number(caps.offset_px) : null,
    };

    let sb = null;
    try {
      sb = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8"));
    } catch {
      return null;
    }
    const composition = state && state.composition && typeof state.composition === "object"
      ? state.composition
      : {};
    const activeShortId = typeof composition.short_id === "string" && composition.short_id !== ""
      ? composition.short_id
      : null;
    const activeSegmentId = typeof composition.segment_id === "string" && composition.segment_id !== ""
      ? composition.segment_id
      : null;
    const planSegment = activeSegmentId ? planSegmentById(state, activeSegmentId) : null;

    const timeline = findTimeline(sb, activeShortId);
    let scenes = timeline && Array.isArray(timeline.scenes) ? timeline.scenes : null;
    if (planSegment && Array.isArray(planSegment.scene_ids) && planSegment.scene_ids.length > 0 && Array.isArray(scenes)) {
      const wanted = new Set(planSegment.scene_ids);
      scenes = scenes.filter((s) => s && typeof s.scene_id === "string" && wanted.has(s.scene_id));
    }
    if (!Array.isArray(scenes) || scenes.length === 0) return null;

    const targetDesign = sb && sb.target && typeof sb.target === "object" ? sb.target.design : null;
    return { scenes, platform, targetDesign, thresholds: resolveContrastThresholds() };
  } catch {
    return null;
  }
}

// Automated QC-C for the COMPOSE self-QC loop: analyze the snapshot stills the
// composer already produced (compose/snapshots/*.png) with ffprobe luma stats
// and flag black/empty/blown/flat frames. Advisory, non-gating — the
// orchestrator routes `glaring` findings into the composer auto-retry and
// `taste` findings into the user note. Pure ffprobe; no render, no browser.
async function qcStills(args) {
  const id = assertSafeProjectId(args && args.project_id);

  // Fail fast on a bad project_id (same error shape as every other tool) BEFORE
  // the potentially many ffprobe spawns; the lock block re-reads for the write.
  // We keep the read to resolve the (advisory) caption-contrast context below.
  const state = readSessionStateStrict(id);

  const snapsDir = snapshotsDir(id);
  const stills = fs.existsSync(snapsDir)
    ? fs
        .readdirSync(snapsDir)
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort()
        .map((name) => path.join(snapsDir, name))
    : [];
  if (stills.length === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `no snapshot stills found in ${snapsDir} — run vob_snapshot_keyframes first`,
    );
  }

  // Optional timecode echo (the same array passed to vob_snapshot_keyframes):
  // used ONLY to stamp finding.timecode_seconds, and only when it lines up 1:1
  // with the stills (hyperframes names PNGs in timecode order, but we don't
  // hard-depend on it — degrade to frame_index + filename otherwise).
  const rawTimecodes = Array.isArray(args && args.timecodes) ? args.timecodes : null;
  const timecodes = rawTimecodes && rawTimecodes.length === stills.length
    ? rawTimecodes.map((t) => (Number.isFinite(Number(t)) ? Number(t) : null))
    : null;

  // (v3.9.1) Caption-contrast context — only when timecodes line up 1:1 with the
  // stills (the contrast check maps each still's time to a scene to know whether
  // a caption is even there). null => the pass is skipped (no platform dims, no
  // storyboard, no scoped scenes, or no aligned timecodes). Advisory throughout.
  const contrastCtx = timecodes ? resolveContrastContext(id, state) : null;

  const thresholds = resolveThresholds();
  const findings = [];
  const unprobed = [];
  let probedCount = 0;

  stills.forEach((still, index) => {
    const base = path.basename(still);
    let luma;
    try {
      luma = signalstatsLuma(still);
    } catch (error) {
      luma = { probed: false, error: error && error.message ? error.message : String(error) };
    }
    if (!luma || luma.probed === false) {
      unprobed.push({ frame_index: index, still: base, error: luma ? luma.error : "unknown" });
      return;
    }
    probedCount += 1;
    const finding = classifyStillLuma(luma, thresholds);
    if (finding) {
      findings.push({
        frame_index: index,
        still: base,
        timecode_seconds: timecodes ? timecodes[index] : null,
        code: finding.code,
        severity: finding.severity,
        message: finding.message,
        ymin: luma.ymin,
        yavg: luma.yavg,
        ymax: luma.ymax,
      });
    }

    // (v3.9.1) Deterministic caption-contrast (Pillar B). Only fires when this
    // still's timecode lands in a scene that PLANS captions; otherwise null
    // (a caption-free bright lower-third never false-trips). Same glaring/taste
    // routing as the luma findings. DEGRADES to null on any missing input.
    if (contrastCtx) {
      let cf = null;
      try {
        cf = evaluateStillCaptionContrast({
          stillPath: still,
          scenes: contrastCtx.scenes,
          timeSeconds: timecodes[index],
          platform: contrastCtx.platform,
          targetDesign: contrastCtx.targetDesign,
          thresholds: contrastCtx.thresholds,
        });
      } catch {
        cf = null; // advisory must never abort the pass (parity with the luma probe above)
      }
      if (cf) {
        findings.push({
          frame_index: index,
          still: base,
          timecode_seconds: timecodes[index],
          code: cf.code,
          severity: cf.severity,
          message: cf.message,
          contrast_ratio: cf.contrast_ratio,
          bg_luma: cf.bg_luma,
          text_color: cf.text_color,
        });
      }
    }
  });

  // glaring first, then taste; stable within a severity (frame order preserved).
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "glaring" ? -1 : 1));
  const glaringCount = findings.filter((f) => f.severity === "glaring").length;
  const tasteCount = findings.length - glaringCount;
  const captionContrastCount = findings.filter((f) => f.code === "qc/caption_low_contrast").length;

  const ranAt = nowIso();
  const report = {
    ran_at: ranAt,
    count: stills.length,
    frames_probed: probedCount,
    frames_unprobed: unprobed.length,
    glaring_count: glaringCount,
    taste_count: tasteCount,
    caption_contrast_count: captionContrastCount,
    contrast_checked: Boolean(contrastCtx),
    thresholds,
    findings,
    unprobed,
  };
  const reportPath = path.join(snapsDir, REPORT_NAME);
  writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const next = {
      ...stateNow,
      last_updated: ranAt,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "stills_qc_run",
          at: ranAt,
          count: stills.length,
          frames_probed: probedCount,
          frames_unprobed: unprobed.length,
          glaring_count: glaringCount,
          taste_count: tasteCount,
          caption_contrast_count: captionContrastCount,
          report_path: reportPath,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      report_path: reportPath,
      count: stills.length,
      frames_probed: probedCount,
      frames_unprobed: unprobed.length,
      glaring_count: glaringCount,
      taste_count: tasteCount,
      caption_contrast_count: captionContrastCount,
      contrast_checked: Boolean(contrastCtx),
      findings: findings.slice(0, MAX_INLINE_FINDINGS),
      findings_truncated: Math.max(0, findings.length - MAX_INLINE_FINDINGS),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_qc_stills",
  description:
    "Auto-QC the CURRENT composition's snapshot stills (compose/snapshots/*.png) with ffprobe luma "
    + "stats — flags black/empty/half-loaded (qc/still_black), blown-out (qc/still_blown_out), and "
    + "flat (qc/still_flat) frames (automated QC-C), AND caption legibility (automated QC-B): a "
    + "deterministic WCAG-ish caption-contrast check (qc/caption_low_contrast) that samples the "
    + "background luma under the platform caption safe band on stills whose timecode lands in a "
    + "caption-bearing scene. Run it right after vob_snapshot_keyframes in COMPOSE self-QC. Advisory, "
    + "non-gating; ~1-3s, pure ffprobe (no render, no browser). Pass the snapshot's `timecodes` (1:1 "
    + "with the stills) to stamp each finding with its time and enable the caption-contrast check. "
    + "Findings carry severity glaring|taste.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      timecodes: { type: "array", items: { type: "number", minimum: 0 } },
    },
    required: ["project_id"],
  },
  handler: qcStills,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["compose/snapshots/stills-qc.json", "state.json"],
  hook_required: false,
});
