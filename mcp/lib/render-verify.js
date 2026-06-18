"use strict";

const { probeFile, summarizeProbe, signalstatsLuma, measureMaxVolumeDb } = require("./ffprobe.js");

const DURATION_DRIFT_THRESHOLD_S = 0.5;

// Content-QC knobs (advisory; never gate). A render can pass duration/dims/has-
// audio yet be all-black (a dropped <video> clip — a documented low-RAM render
// fragility) or silent (a failed audio mux): duration is correct, so plain drift
// can't see it. We sample a few frames' peak luma and measure max audio volume.
const DEFAULT_CONTENT_SAMPLES = 6;
function blackYmax() {
  const v = Number(process.env.VOB_QC_BLACK_YMAX);
  return Number.isFinite(v) && v >= 0 ? v : 24; // matches still-qc's black floor
}
function silentMaxDb() {
  const v = Number(process.env.VOB_RENDER_SILENT_MAX_DB);
  return Number.isFinite(v) ? v : -60; // max_volume at/below this = no audible program
}

// Sample peak luma at evenly-spaced points (avoiding the fade-in/out edges) and
// flag frames with nothing bright rendered. Best-effort: unprobed samples are
// counted separately, never treated as black.
function sampleBlackFrames(mp4Path, durationSeconds, samples) {
  const n = Math.max(1, Math.min(Number.isInteger(samples) ? samples : DEFAULT_CONTENT_SAMPLES, 16));
  const lo = durationSeconds * 0.1;
  const hi = durationSeconds * 0.9;
  const step = n > 1 ? (hi - lo) / (n - 1) : 0;
  const thresh = blackYmax();
  const blackTimecodes = [];
  let probed = 0;
  for (let i = 0; i < n; i += 1) {
    const t = Math.round((lo + step * i) * 1000) / 1000;
    const luma = signalstatsLuma(mp4Path, { seekSeconds: t });
    if (!luma || luma.probed !== true || !Number.isFinite(luma.ymax)) continue;
    probed += 1;
    if (luma.ymax <= thresh) blackTimecodes.push(t);
  }
  return { sampled: n, probed, black_timecodes: blackTimecodes };
}

// Post-render verification: ffprobe the MP4 and compare to the storyboard
// expectation. NEVER throws — a probe failure must not fail a succeeded render.
// With checkContent:true (preview + full render) it ALSO samples luma/volume and
// folds in advisory black-frame / silent-audio flags.
function verifyRenderedMp4({ mp4Path, expectedDurationSeconds = null, checkContent = false, contentSamples = DEFAULT_CONTENT_SAMPLES }) {
  try {
    const summary = summarizeProbe(mp4Path, probeFile(mp4Path));
    const dur = Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null;
    const expected = Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : null;
    const drift = dur !== null && expected !== null ? Math.round((dur - expected) * 1000) / 1000 : null;
    const hasAudio = summary.has_audio === true;
    const out = {
      probed: true,
      error: null,
      duration_seconds: dur,
      width: summary.primary_video ? summary.primary_video.width : null,
      height: summary.primary_video ? summary.primary_video.height : null,
      has_audio: hasAudio,
      expected_duration_seconds: expected,
      duration_drift_seconds: drift,
      drift_exceeds_threshold: drift !== null && Math.abs(drift) > DURATION_DRIFT_THRESHOLD_S,
    };

    if (checkContent && dur !== null && dur > 0) {
      try {
        const black = sampleBlackFrames(mp4Path, dur, contentSamples);
        out.content_checked = true;
        out.black_frame_count = black.black_timecodes.length;
        out.black_timecodes = black.black_timecodes;
        // "all black" is the strong signal (every probed sample was dark) — a
        // dropped clip across the whole render; some-black is a partial drop.
        out.all_black = black.probed > 0 && black.black_timecodes.length === black.probed;
        if (hasAudio) {
          const vol = measureMaxVolumeDb(mp4Path);
          out.max_volume_db = vol.measured ? vol.max_volume_db : null;
          out.silent_audio = vol.measured ? vol.max_volume_db <= silentMaxDb() : false;
        } else {
          out.max_volume_db = null;
          out.silent_audio = false;
        }
      } catch {
        // content QC is advisory — a probe hiccup must not fail verification
        out.content_checked = false;
      }
    }
    return out;
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
