"use strict";

// Pure classifier for the auto-QC-of-stills pass (vob_qc_stills). Takes the
// full-range (0-255) luma stats of ONE rendered still (from
// ffprobe.signalstatsLuma) and decides whether the frame is a QC-C failure:
// black/empty (a dropped clip or timed-out seek that exited 0), blown out, or a
// suspiciously flat single tone. No I/O — unit-testable in isolation.
//
// Severity uses the COMPOSE self-QC vocabulary ("glaring" | "taste"), NOT the
// composition-qc error/warning enum: a different tool with a different consumer
// (the orchestrator routes glaring → composer auto-retry, taste → a user note).
// vob_qc_stills is advisory and gates nothing.

const DEFAULTS = Object.freeze({
  // peak luma at/below this ⇒ nothing bright rendered anywhere (24 leaves margin
  // over TV-range black=16 and dithering).
  blackYmax: 24,
  // min luma at/above this ⇒ the whole frame is near-white.
  blownYmin: 232,
  // (ymax-ymin) at/below this ⇒ near-single-tone frame (half-loaded / solid bg).
  flatRange: 24,
});

function resolveThresholds(env) {
  const e = env || process.env;
  const pick = (raw, fallback) => {
    const x = Number(raw);
    return Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  return {
    blackYmax: pick(e.VOB_QC_BLACK_YMAX, DEFAULTS.blackYmax),
    blownYmin: pick(e.VOB_QC_BLOWN_YMIN, DEFAULTS.blownYmin),
    flatRange: pick(e.VOB_QC_FLAT_RANGE, DEFAULTS.flatRange),
  };
}

// luma: { probed, ymin, yavg, ymax }. Returns a finding { code, severity,
// message } or null (clean / unprobeable — the caller records unprobed frames
// separately so they're never silently treated as clean).
function classifyStillLuma(luma, thresholds) {
  const t = thresholds || resolveThresholds();
  if (!luma || luma.probed === false) return null;
  const { ymin, ymax } = luma;
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) return null;

  if (ymax <= t.blackYmax) {
    return {
      code: "qc/still_black",
      severity: "glaring",
      message: `frame rendered with no visible content (peak luma ${ymax.toFixed(0)}/255 ≤ ${t.blackYmax}) — likely a dropped clip, a timed-out seek, or a blank scene`,
    };
  }
  if (ymin >= t.blownYmin) {
    return {
      code: "qc/still_blown_out",
      severity: "glaring",
      message: `frame is blown out (min luma ${ymin.toFixed(0)}/255 ≥ ${t.blownYmin}) — likely a full-white flash or a missing clip behind a white layer`,
    };
  }
  if (ymax - ymin <= t.flatRange) {
    return {
      code: "qc/still_flat",
      severity: "taste",
      message: `frame is nearly a single flat tone (luma range ${(ymax - ymin).toFixed(0)} ≤ ${t.flatRange}) — fine for a solid title card, suspicious mid-scene`,
    };
  }
  return null;
}

module.exports = { DEFAULTS, resolveThresholds, classifyStillLuma };
