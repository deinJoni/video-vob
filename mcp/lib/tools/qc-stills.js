"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, snapshotsDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { signalstatsLuma } = require("../ffprobe.js");
const { classifyStillLuma, resolveThresholds } = require("../still-qc.js");

const REPORT_NAME = "stills-qc.json";
const MAX_INLINE_FINDINGS = 10;

function nowIso() {
  return new Date().toISOString();
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
  readSessionStateStrict(id);

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
  });

  // glaring first, then taste; stable within a severity (frame order preserved).
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "glaring" ? -1 : 1));
  const glaringCount = findings.filter((f) => f.severity === "glaring").length;
  const tasteCount = findings.length - glaringCount;

  const ranAt = nowIso();
  const report = {
    ran_at: ranAt,
    count: stills.length,
    frames_probed: probedCount,
    frames_unprobed: unprobed.length,
    glaring_count: glaringCount,
    taste_count: tasteCount,
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
    + "flat (qc/still_flat) frames. This is automated QC-C: run it right after vob_snapshot_keyframes "
    + "in COMPOSE self-QC. Advisory, non-gating; ~1-3s, pure ffprobe (no render, no browser). Pass the "
    + "snapshot's `timecodes` to stamp each finding with its time. Findings carry severity glaring|taste.",
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
