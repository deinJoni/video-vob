"use strict";

// Silence detection via ffmpeg's `silencedetect` audio filter.
//
// We run a decode-only pass (`-f null -`) and parse the filter's log lines off
// **stderr** (ffmpeg emits all filter/log/banner output there, not stdout).
// silencedetect prints, per detected gap:
//   [silencedetect @ ...] silence_start: 12.345
//   [silencedetect @ ...] silence_end: 14.901 | silence_duration: 2.556
// We pair each start with the next end, in emission order.
//
// A detection miss (no audio stream, ffmpeg error, timeout) is NOT thrown:
// the caller (inspect.js) decides whether a miss is fatal, and usually it
// isn't. We return a structured { ok:false, ..., reason } instead, and reserve
// thrown plain Errors for programmer misuse (bad arguments).

const { runFfmpegBlocking, FFMPEG_TIMEOUT_MS } = require("./ffmpeg-runner.js");

// silencedetect log lines. The "@ 0x..." instance address varies, so we anchor
// on the keyword and a numeric value (ffmpeg uses a plain decimal, e.g. 1.5,
// 0, or 12.345; scientific notation does not appear for these timestamps).
const START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

async function detectSilences(filePath, {
  noiseDb = -30,
  minSilenceSeconds = 0.5,
  durationSeconds = null,
  timeoutMs = FFMPEG_TIMEOUT_MS,
} = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("detectSilences: filePath is required");
  }
  if (!Number.isFinite(noiseDb)) {
    throw new Error("detectSilences: noiseDb must be a finite number");
  }
  if (!Number.isFinite(minSilenceSeconds) || minSilenceSeconds <= 0) {
    throw new Error("detectSilences: minSilenceSeconds must be > 0");
  }
  if (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new Error("detectSilences: durationSeconds must be a non-negative number or null");
  }

  // noise threshold is in dB (e.g. -30dB); d is the minimum silence duration.
  const filter = `silencedetect=noise=${noiseDb}dB:d=${minSilenceSeconds}`;
  const argv = [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-af", filter,
    "-f", "null",
    "-",
  ];

  let result;
  try {
    result = await runFfmpegBlocking(argv, { timeoutMs });
  } catch (error) {
    // runFfmpegBlocking only throws on hard spawn failure (e.g. ENOENT).
    return {
      ok: false,
      silences: [],
      noiseDb,
      minSilenceSeconds,
      reason: error && error.message ? error.message : String(error),
    };
  }

  const stderr = result.stderr || "";
  const parsed = parseSilenceLog(stderr, durationSeconds);

  // ffmpeg failed or timed out AND we got nothing parseable → detection miss.
  // (A clean decode pass exits 0; a missing/corrupt input or timeout does not.
  // If despite a non-zero exit we still parsed intervals, prefer the data.)
  if ((!result.ok || result.timed_out) && parsed.silences.length === 0) {
    const stderrTail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
    const reason = result.timed_out
      ? `ffmpeg timed out after ${timeoutMs}ms`
      : `ffmpeg exited with code ${result.exit_code}${stderrTail ? `: ${stderrTail}` : ""}`;
    return { ok: false, silences: [], noiseDb, minSilenceSeconds, reason };
  }

  const out = {
    ok: true,
    silences: parsed.silences,
    noiseDb,
    minSilenceSeconds,
  };
  if (parsed.note) out.note = parsed.note;
  return out;
}

// Walk stderr lines in order, pairing each silence_start with the next
// silence_end. Returns sorted, non-degenerate intervals. A trailing start
// with no matching end means silence ran to EOF: close it at durationSeconds
// if known, otherwise drop it and record a note.
function parseSilenceLog(stderr, durationSeconds) {
  const lines = stderr.split(/\r?\n/);
  const intervals = [];
  let pendingStart = null; // number | null
  let note = null;

  for (const line of lines) {
    const sm = line.match(START_RE);
    if (sm) {
      // Two starts in a row shouldn't happen, but if it does, keep the latest
      // (ffmpeg would have emitted an end first in normal operation).
      pendingStart = Number(sm[1]);
      continue;
    }
    const em = line.match(END_RE);
    if (em && pendingStart != null) {
      const end = Number(em[1]);
      const start = pendingStart;
      pendingStart = null;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        intervals.push({ start, end });
      }
    }
  }

  // Unpaired trailing start → silence runs to EOF.
  if (pendingStart != null && Number.isFinite(pendingStart)) {
    if (durationSeconds != null && durationSeconds > pendingStart) {
      intervals.push({ start: pendingStart, end: durationSeconds });
    } else {
      note = `trailing silence_start at ${pendingStart}s had no silence_end (silence to EOF); ` +
        (durationSeconds == null
          ? "durationSeconds not provided, so the interval was dropped"
          : `durationSeconds (${durationSeconds}) was not after the start, so the interval was dropped`);
    }
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  return { silences: intervals, note };
}

module.exports = { detectSilences, parseSilenceLog };
