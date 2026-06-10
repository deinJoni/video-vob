"use strict";

const { spawnSync } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { spawnWithShutdown, DEFAULT_MAX_OUTPUT_BYTES } = require("./spawn-with-shutdown.js");

const FFMPEG_INSTALL_HINT =
  "Install ffmpeg (https://ffmpeg.org/download.html) and ensure `ffmpeg` is on PATH. " +
  "macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt-get install ffmpeg`.";

const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
const CLIP_CUT_TIMEOUT_MS = 10 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

function runFfmpegSync(argv, { cwd, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSync(
      "ffmpeg",
      argv,
      {
        encoding: "utf8",
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg invocation failed: ${error.message || String(error)}. ${FFMPEG_INSTALL_HINT}`,
    );
  }

  if (result.error && result.error.code === "ENOENT") {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg not found on PATH. ${FFMPEG_INSTALL_HINT}`,
    );
  }
  if (result.error && result.error.code === "ETIMEDOUT") {
    return {
      ok: false,
      timed_out: true,
      exit_code: null,
      signal: result.signal || "SIGTERM",
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  if (result.error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg invocation failed: ${result.error.message || String(result.error)}. ${FFMPEG_INSTALL_HINT}`,
    );
  }

  return {
    ok: result.status === 0,
    timed_out: false,
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// Some cameras (notably DJI Osmo Pocket / drone clips) write a BOGUS display
// rotation tag (e.g. rotation=-90) into otherwise display-correct footage, so
// ffmpeg's default autorotation double-rotates the picture. Setting
// VOB_DISABLE_AUTOROTATE adds `-noautorotate` to the INPUT side of every video
// decode (must precede `-i`), turning that tribal gotcha into one knob. Left OFF
// by default — flipping it unconditionally would mis-orient legitimately rotated
// phone footage. vob_doctor / INGEST surface a hint when a rotation tag is seen.
function inputAutorotateArgs() {
  const knob = (process.env.VOB_DISABLE_AUTOROTATE || "").trim().toLowerCase();
  if (knob === "1" || knob === "on" || knob === "true" || knob === "yes") {
    return ["-noautorotate"];
  }
  return [];
}

function runFfmpegBlocking(argv, { cwd, timeoutMs = FFMPEG_TIMEOUT_MS, stderrLogPath = null } = {}) {
  return spawnWithShutdown(
    "ffmpeg",
    argv,
    {
      cwd,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stderrLogPath,
      installHint: FFMPEG_INSTALL_HINT,
    },
  );
}

// Input-side -ss (fast seek): ffmpeg seeks to the nearest preceding keyframe,
// then decodes-and-DISCARDS up to the exact timestamp — frame-accurate under
// re-encode (the "lands on the previous keyframe" corruption applies only to
// stream-copy, which we never do here). This turns COMPOSE entry on a 30-40 min
// source from O(sum of clip end-times) decode into O(sum of clip durations).
// -t (duration) is used instead of -to because input-side -ss resets the
// timeline to 0 at the seek point.
function buildClipCutArgv({ src, out, inSeconds, outSeconds, dropAudio }) {
  const argv = [
    "-y",
    ...inputAutorotateArgs(),
    "-ss", String(inSeconds),
    "-i", src,
    "-t", (outSeconds - inSeconds).toFixed(3),
    "-c:v", "libx264",
    "-preset", "medium", // was fast — clips are short + sidecar-cached; spend the
    "-crf", "18",        // encode time once. crf 20->18 + medium cuts the double-
                         // generation loss on the A-roll (clip is re-encoded again
                         // by the hyperframes capture).
    // Dense keyframes (~1 per second at 30fps): every output frame is at most a
    // few frames from a keyframe, so headless-Chrome seeks during capture are
    // fast. WITHOUT this the pre-cut defaults to ~8s GOPs; single-track renders
    // survive (one seek/frame) but a B-roll/multi-track cut seeks the spine AND
    // an overlapping cutaway per frame, and on a low-RAM host each seek blows
    // Chrome's 30s protocolTimeout → "BeginFrame auto-worker calibration timed
    // out" → render aborts. Harmless for single-track (just slightly larger files).
    "-g", "30",
    "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  if (dropAudio) {
    argv.push("-an");
  } else {
    argv.push("-c:a", "aac", "-b:a", "192k"); // was 128k — voice intermediate headroom
  }
  argv.push(out);
  return argv;
}

// --- Two-pass loudnorm (PACKAGE) ---------------------------------------------
// Pass 1 measures, pass 2 applies with linear=true (one-pass dynamic loudnorm
// pumps); the video stream is copied untouched. Target: -14 LUFS / -1 dBTP
// (the short-form platform reference level).
const LOUDNORM_TIMEOUT_MS = 10 * 60 * 1000;
const LOUDNORM_TARGET = Object.freeze({ i: -14, tp: -1, lra: 11 });

function buildLoudnormMeasureArgv({ input }) {
  return ["-hide_banner", "-nostats", "-i", input, "-map", "0:a:0",
    "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"];
}

// `measured` fields are the strings parsed from pass 1 (parseLoudnormStats).
function buildLoudnormApplyArgv({ input, output, measured }) {
  const af = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}`
    + `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}`
    + `:offset=${measured.target_offset}:linear=true:print_format=summary`;
  return ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy",
    "-af", af,
    "-c:a", "aac", "-b:a", "256k",
    "-ar", "48000", // loudnorm internally resamples to 192kHz; restore 48k
    "-movflags", "+faststart",
    output];
}

// Parse the JSON block loudnorm prints to stderr: take the substring from the
// LAST "{" preceding the last occurrence of "input_i" to the next balanced "}".
// Returns { input_i, input_tp, input_lra, input_thresh, target_offset } as
// STRINGS (loudnorm emits them quoted), or null on any miss.
function parseLoudnormStats(stderr) {
  const s = typeof stderr === "string" ? stderr : "";
  const keyIndex = s.lastIndexOf('"input_i"');
  if (keyIndex === -1) return null;
  const open = s.lastIndexOf("{", keyIndex);
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(s.slice(open, close + 1));
  } catch {
    return null;
  }
  const out = {};
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (typeof parsed[key] !== "string" || parsed[key] === "") return null;
    out[key] = parsed[key];
  }
  return out;
}

async function cutClip({ src, out, inSeconds, outSeconds, dropAudio = false, timeoutMs = CLIP_CUT_TIMEOUT_MS } = {}) {
  if (typeof src !== "string" || !src) throw new Error("cutClip: src is required");
  if (typeof out !== "string" || !out) throw new Error("cutClip: out is required");
  if (!Number.isFinite(inSeconds) || inSeconds < 0) throw new Error("cutClip: inSeconds must be >= 0");
  if (!Number.isFinite(outSeconds) || outSeconds <= inSeconds) {
    throw new Error("cutClip: outSeconds must be > inSeconds");
  }
  const argv = buildClipCutArgv({ src, out, inSeconds, outSeconds, dropAudio });
  const result = await runFfmpegBlocking(argv, { timeoutMs });
  return { ...result, argv };
}

function checkFfmpegAvailable({ timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = runFfmpegSync(["-version"], { timeoutMs });
  } catch (error) {
    return { ok: false, version: null, error: error.message || String(error), checked_at: new Date().toISOString() };
  }
  if (result.timed_out) {
    return { ok: false, version: null, error: "preflight timed out", checked_at: new Date().toISOString() };
  }
  if (!result.ok) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 500);
    return {
      ok: false,
      version: null,
      error: stderrPreview || `ffmpeg -version exited with status ${result.exit_code}`,
      checked_at: new Date().toISOString(),
    };
  }
  // ffmpeg banner starts with: "ffmpeg version 6.0 ..."
  const firstLine = (result.stdout || "").split("\n")[0] || "";
  const versionMatch = firstLine.match(/ffmpeg version\s+(\S+)/i);
  return {
    ok: true,
    version: versionMatch ? versionMatch[1] : firstLine.slice(0, 64) || null,
    error: null,
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  FFMPEG_INSTALL_HINT,
  FFMPEG_TIMEOUT_MS,
  CLIP_CUT_TIMEOUT_MS,
  LOUDNORM_TIMEOUT_MS,
  LOUDNORM_TARGET,
  PREFLIGHT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  buildClipCutArgv,
  buildLoudnormApplyArgv,
  buildLoudnormMeasureArgv,
  checkFfmpegAvailable,
  cutClip,
  inputAutorotateArgs,
  parseLoudnormStats,
  runFfmpegBlocking,
  runFfmpegSync,
};
