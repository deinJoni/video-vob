"use strict";

const { probeFile, summarizeProbe } = require("./ffprobe.js");

const DURATION_DRIFT_THRESHOLD_S = 0.5;

// Post-render verification: ffprobe the MP4 and compare to the storyboard
// expectation. NEVER throws — a probe failure must not fail a succeeded render.
function verifyRenderedMp4({ mp4Path, expectedDurationSeconds = null }) {
  try {
    const summary = summarizeProbe(mp4Path, probeFile(mp4Path));
    const dur = Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null;
    const expected = Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : null;
    const drift = dur !== null && expected !== null ? Math.round((dur - expected) * 1000) / 1000 : null;
    return {
      probed: true,
      error: null,
      duration_seconds: dur,
      width: summary.primary_video ? summary.primary_video.width : null,
      height: summary.primary_video ? summary.primary_video.height : null,
      has_audio: summary.has_audio === true,
      expected_duration_seconds: expected,
      duration_drift_seconds: drift,
      drift_exceeds_threshold: drift !== null && Math.abs(drift) > DURATION_DRIFT_THRESHOLD_S,
    };
  } catch (error) {
    return {
      probed: false,
      error: String((error && error.message) || error),
      duration_seconds: null,
      width: null,
      height: null,
      has_audio: null,
      expected_duration_seconds: Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : null,
      duration_drift_seconds: null,
      drift_exceeds_threshold: false,
    };
  }
}

module.exports = { DURATION_DRIFT_THRESHOLD_S, verifyRenderedMp4 };
