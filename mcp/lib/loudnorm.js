"use strict";

// Shared two-pass loudness normalization to -14 LUFS / -1 dBTP (audio-only
// re-encode, video stream copied). Extracted from package-output so the
// deliverables path (vob_import_deliverable { normalize:true }) applies the
// SAME pass — fan-out shorts and escape-hatch imports are no longer the only
// un-normalized outputs. Every non-applied exit records a skipped_reason and
// the caller CONTINUES un-normalized — loudness is polish, not a gate.

const fs = require("fs");
const path = require("path");

const {
  runFfmpegBlocking,
  buildLoudnormMeasureArgv,
  buildLoudnormApplyArgv,
  parseLoudnormStats,
  LOUDNORM_TIMEOUT_MS,
  LOUDNORM_TARGET,
} = require("./ffmpeg-runner.js");
const { stderrTail } = require("./spawn-with-shutdown.js");

// normalizeLoudnessInPlace({ mp4Path, summaryPre }) -> {
//   applied, skipped_reason, error, measured_input_i, measured_input_tp }
// summaryPre = summarizeProbe(...) of the input (audio_streams gates the pass).
async function normalizeLoudnessInPlace({ mp4Path, summaryPre }) {
  const knob = (process.env.VOB_NO_LOUDNORM || "").trim().toLowerCase();
  const base = { applied: false, skipped_reason: null, error: null, measured_input_i: null, measured_input_tp: null };
  if (knob === "1" || knob === "on" || knob === "true" || knob === "yes") {
    return { ...base, skipped_reason: "disabled_via_env" };
  }
  if (!summaryPre || summaryPre.audio_streams === 0) {
    return { ...base, skipped_reason: "no_audio" };
  }
  const measure = await runFfmpegBlocking(buildLoudnormMeasureArgv({ input: mp4Path }), { timeoutMs: LOUDNORM_TIMEOUT_MS });
  const measured = measure.timed_out || measure.exit_code !== 0 ? null : parseLoudnormStats(measure.stderr);
  if (!measured) {
    return { ...base, skipped_reason: "measure_failed", error: stderrTail(measure.stderr, 1000) };
  }
  if (measured.input_i === "-inf") {
    return { ...base, skipped_reason: "silent_audio" };
  }
  const inputI = Number(measured.input_i);
  const inputTp = Number(measured.input_tp);
  const measuredNums = {
    measured_input_i: Number.isFinite(inputI) ? inputI : null,
    measured_input_tp: Number.isFinite(inputTp) ? inputTp : null,
  };
  if (Number.isFinite(inputI) && Math.abs(inputI - LOUDNORM_TARGET.i) <= 0.5
    && Number.isFinite(inputTp) && inputTp <= LOUDNORM_TARGET.tp) {
    return { ...base, ...measuredNums, skipped_reason: "already_within_tolerance" };
  }
  const tmp = path.join(path.dirname(mp4Path), `${path.basename(mp4Path)}.loudnorm.tmp.mp4`);
  const apply = await runFfmpegBlocking(
    buildLoudnormApplyArgv({ input: mp4Path, output: tmp, measured }),
    { timeoutMs: LOUDNORM_TIMEOUT_MS },
  );
  if (apply.timed_out || apply.exit_code !== 0 || !fs.existsSync(tmp)) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ...base, ...measuredNums, skipped_reason: "apply_failed", error: stderrTail(apply.stderr, 1000) };
  }
  fs.renameSync(tmp, mp4Path);
  return { ...base, ...measuredNums, applied: true };
}

module.exports = { normalizeLoudnessInPlace };
