"use strict";

const { spawnSync } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { spawnWithShutdown, DEFAULT_MAX_OUTPUT_BYTES } = require("./spawn-with-shutdown.js");

const FFMPEG_INSTALL_HINT =
  "Install ffmpeg (https://ffmpeg.org/download.html) and ensure `ffmpeg` is on PATH. " +
  "macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt-get install ffmpeg`.";

const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
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
  PREFLIGHT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  checkFfmpegAvailable,
  runFfmpegBlocking,
  runFfmpegSync,
};
