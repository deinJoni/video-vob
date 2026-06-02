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

function buildClipCutArgv({ src, out, inSeconds, outSeconds, dropAudio }) {
  // `-i <src>` before `-ss` does decode-then-seek: slower but frame-accurate,
  // and required for HEVC (input-side `-ss` lands on the previous keyframe
  // and corrupts the cut). The clip is re-encoded to H.264 + yuv420p so
  // headless Chrome can decode it reliably regardless of source codec.
  const argv = [
    "-y",
    "-i", src,
    "-ss", String(inSeconds),
    "-to", String(outSeconds),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
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
    argv.push("-c:a", "aac", "-b:a", "128k");
  }
  argv.push(out);
  return argv;
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
  PREFLIGHT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  buildClipCutArgv,
  checkFfmpegAvailable,
  cutClip,
  runFfmpegBlocking,
  runFfmpegSync,
};
