"use strict";

const { spawnSync } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { spawnWithShutdown, DEFAULT_MAX_OUTPUT_BYTES } = require("./spawn-with-shutdown.js");

const HYPERFRAMES_INSTALL_HINT =
  "video-vob runs hyperframes via `npx hyperframes`. Ensure Node.js 20+ is installed and `npx` resolves on PATH. " +
  "If `npx` cannot reach the package (offline, corp network), install it explicitly: `npm i -g hyperframes`. " +
  "See https://github.com/heygen-com/hyperframes for details.";

const LINT_TIMEOUT_MS = 60 * 1000;
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const FULL_RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

function runHyperframesSync(subArgv, { cwd, timeoutMs = LINT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSync(
      "npx",
      ["--yes", "hyperframes", ...subArgv],
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
      `npx hyperframes invocation failed: ${error.message || String(error)}. ${HYPERFRAMES_INSTALL_HINT}`,
    );
  }

  if (result.error && result.error.code === "ENOENT") {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `npx not found on PATH. ${HYPERFRAMES_INSTALL_HINT}`,
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
      `npx hyperframes invocation failed: ${result.error.message || String(result.error)}. ${HYPERFRAMES_INSTALL_HINT}`,
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

function runHyperframesBlocking(subArgv, { cwd, timeoutMs = RENDER_TIMEOUT_MS, stderrLogPath = null } = {}) {
  return spawnWithShutdown(
    "npx",
    ["--yes", "hyperframes", ...subArgv],
    {
      cwd,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stderrLogPath,
      installHint: HYPERFRAMES_INSTALL_HINT,
    },
  );
}

function checkHyperframesAvailable({ timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = runHyperframesSync(["--version"], { timeoutMs });
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
      error: stderrPreview || `npx hyperframes --version exited with status ${result.exit_code}`,
      checked_at: new Date().toISOString(),
    };
  }
  const versionMatch = (result.stdout || "").trim().match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/);
  return {
    ok: true,
    version: versionMatch ? versionMatch[1] : (result.stdout || "").trim().slice(0, 64) || null,
    error: null,
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  HYPERFRAMES_INSTALL_HINT,
  LINT_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  FULL_RENDER_TIMEOUT_MS,
  PREFLIGHT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  checkHyperframesAvailable,
  runHyperframesBlocking,
  runHyperframesSync,
};
