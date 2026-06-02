"use strict";

// ffmpeg scene-change detection. Runs the `select=gt(scene,T)` filter chained
// into `showinfo`, which logs one line per surviving frame (i.e. each frame
// whose scene-change score exceeded the threshold) to STDERR. We parse those
// lines' `pts_time:<seconds>` to recover the cut timestamps.
//
// A detection miss is rarely fatal upstream (INSPECT can proceed without scene
// cuts), so an ffmpeg failure RESOLVES with { ok:false, reason } rather than
// throwing — the caller decides. Plain Errors are reserved for caller misuse.

const { runFfmpegBlocking, FFMPEG_TIMEOUT_MS } = require("./ffmpeg-runner.js");

// showinfo emits frame metadata to stderr; we only need the presentation
// timestamp. Example fragment:
//   [Parsed_showinfo_1 @ 0x...] n:0 pts:... pts_time:1.001 duration:...
const PTS_TIME_RE = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;

// The very first decoded frame (t≈0) is reported by showinfo regardless of any
// scene change, so we discard cuts below this floor as spurious.
const MIN_CUT_SECONDS = 0.05;

/**
 * Detect scene-change timestamps in a video file.
 *
 * @param {string} filePath - path to the media file to analyze.
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.4] - scene score threshold in [0,1]; higher
 *   = fewer, harder cuts.
 * @param {number} [opts.timeoutMs] - ffmpeg timeout.
 * @returns {Promise<{ok:boolean, cuts:number[], threshold:number, reason?:string}>}
 *   cuts: sorted-ascending scene-change timestamps in seconds, t≈0 dropped.
 *   On ffmpeg failure with nothing parseable: { ok:false, cuts:[], reason }.
 *   No video stream / no cuts is success: { ok:true, cuts:[] }.
 */
async function detectSceneChanges(filePath, { threshold = 0.4, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("detectSceneChanges: filePath is required");
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("detectSceneChanges: threshold must be a number in [0,1]");
  }

  // The comma inside select=gt(scene,T) must be backslash-escaped, else the
  // filtergraph parser reads it as a filter separator. `-f null -` decodes the
  // whole stream and discards output; `-an` skips audio; `-nostats` quiets the
  // progress line so stderr is just banner-free showinfo output.
  const argv = [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-filter:v", `select='gt(scene\\,${threshold})',showinfo`,
    "-an",
    "-f", "null",
    "-",
  ];

  let result;
  try {
    result = await runFfmpegBlocking(argv, { timeoutMs });
  } catch (error) {
    // runFfmpegBlocking throws ToolError only on hard spawn failure (e.g.
    // ffmpeg not on PATH). Surface it as a structured miss, not a throw.
    return { ok: false, cuts: [], threshold, reason: error.message || String(error) };
  }

  const stderr = result.stderr || "";
  const cuts = parsePtsTimes(stderr);

  // If we parsed cuts, trust them even on a non-zero exit (ffmpeg can emit a
  // benign non-zero on EOF for `-f null` with some builds). Only treat
  // timeout / failure as fatal when there is nothing to show for it.
  if ((result.timed_out || result.exit_code !== 0) && cuts.length === 0) {
    if (result.timed_out) {
      return { ok: false, cuts: [], threshold, reason: "ffmpeg_timed_out" };
    }
    // A file with no video stream is NOT an error per the contract — the
    // `-filter:v`+`-f null` pipeline produces no output stream and ffmpeg
    // exits non-zero with one of these signatures. Treat as "no cuts".
    if (hasNoVideoStream(stderr)) {
      return { ok: true, cuts: [], threshold };
    }
    return { ok: false, cuts: [], threshold, reason: `ffmpeg_exit_${result.exit_code}` };
  }

  return { ok: true, cuts, threshold };
}

// When the input has no video stream, the `-filter:v` graph has nothing to
// attach to and `-f null -` yields an empty output, so ffmpeg aborts with one
// of these messages (wording varies across versions). We must not mistake this
// for a genuine failure — it just means "zero cuts".
function hasNoVideoStream(stderr) {
  return /Output file does not contain any stream/i.test(stderr)
    || /does not contain any stream/i.test(stderr)
    || /Cannot find a matching stream/i.test(stderr)
    || /Stream map .* matches no streams/i.test(stderr);
}

// Extract, de-dupe, floor-filter, and sort all pts_time values from showinfo
// stderr output.
function parsePtsTimes(stderr) {
  const seen = new Set();
  let match;
  PTS_TIME_RE.lastIndex = 0;
  while ((match = PTS_TIME_RE.exec(stderr)) !== null) {
    const t = Number(match[1]);
    if (Number.isFinite(t) && t >= MIN_CUT_SECONDS) {
      // Round to ms to collapse float-formatting dupes of the same frame.
      seen.add(Math.round(t * 1000) / 1000);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

module.exports = {
  detectSceneChanges,
  MIN_CUT_SECONDS,
};
