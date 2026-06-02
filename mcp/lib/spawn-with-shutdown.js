"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SIGKILL_GRACE_MS = 5 * 1000;

// Monotonic suffix so concurrent captures don't collide on a temp filename.
let stdoutCaptureSeq = 0;

// Generic detached-process runner with SIGTERM → grace → SIGKILL shutdown,
// per-stream output capping, and optional stderr-tee to a log file for
// long-running processes whose progress the user wants to tail.
//
// Returns a Promise resolving to a normalized result object. Throws ToolError
// only on hard spawn failure (ENOENT, etc.) — non-zero exits and timeouts
// resolve with structured fields the caller can react to.
// `captureStdoutViaFile`: route the child's stdout to a real file descriptor
// instead of a pipe, then read it back after exit. This is a workaround for a
// truncation bug: `npx hyperframes <cmd> --json` piped through Node's stdio
// truncates at exactly 8192 bytes on child exit (reproduced with both detached
// and non-detached pipes), corrupting any JSON payload past that size. The same
// command writing to a file (or a shell pipe) emits the full output. Affected
// callers that PARSE large stdout (lint) must set this; callers that only need
// small envelopes (transcribe) or don't parse stdout (render) need not.
function spawnWithShutdown(cmd, argv, {
  cwd,
  env,
  timeoutMs,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  sigkillGraceMs = SIGKILL_GRACE_MS,
  stderrLogPath = null,
  captureStdoutViaFile = false,
  installHint = "",
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("spawnWithShutdown requires a positive timeoutMs");
  }

  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;
    let settled = false;

    // Optional file-backed stdout capture (see note above).
    let stdoutFd = null;
    let stdoutFilePath = null;
    if (captureStdoutViaFile) {
      stdoutCaptureSeq += 1;
      stdoutFilePath = path.join(os.tmpdir(), `vob-stdout-${process.pid}-${stdoutCaptureSeq}.tmp`);
      try {
        stdoutFd = fs.openSync(stdoutFilePath, "w");
      } catch {
        // Fall back to pipe capture if the temp file can't be opened.
        stdoutFd = null;
        stdoutFilePath = null;
      }
    }

    // Read back and clean up the file-backed stdout, honoring the byte cap.
    function finalizeStdoutFile() {
      if (stdoutFd !== null) {
        try { fs.closeSync(stdoutFd); } catch {}
        stdoutFd = null;
      }
      if (!stdoutFilePath) return null;
      let buf = null;
      try { buf = fs.readFileSync(stdoutFilePath); } catch { buf = null; }
      try { fs.unlinkSync(stdoutFilePath); } catch {}
      stdoutFilePath = null;
      if (buf && buf.length > maxOutputBytes) {
        stdoutTruncated = true;
        return buf.subarray(0, maxOutputBytes);
      }
      return buf;
    }

    let stderrLogStream = null;
    if (typeof stderrLogPath === "string" && stderrLogPath) {
      try {
        fs.mkdirSync(path.dirname(stderrLogPath), { recursive: true });
        stderrLogStream = fs.createWriteStream(stderrLogPath, { flags: "a" });
      } catch (error) {
        // Logging failures are non-fatal — the render still proceeds. Drop the
        // log silently rather than fail the render for a missing log dir.
        stderrLogStream = null;
      }
    }

    function closeLog() {
      if (stderrLogStream) {
        try { stderrLogStream.end(); } catch {}
        stderrLogStream = null;
      }
    }

    let child;
    try {
      child = spawn(cmd, argv, {
        cwd,
        // When undefined, Node defaults to process.env — identical to the
        // pre-existing behavior. Callers that pass env do so deliberately.
        env,
        detached: true,
        stdio: ["ignore", stdoutFd !== null ? stdoutFd : "pipe", "pipe"],
      });
    } catch (error) {
      closeLog();
      finalizeStdoutFile();
      const hint = installHint ? ` ${installHint}` : "";
      reject(new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `${cmd} spawn failed: ${error.message || String(error)}.${hint}`,
      ));
      return;
    }

    function killGroup(signal) {
      if (!child || !child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    }

    const timer = setTimeout(() => {
      killed = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, sigkillGraceMs);
    }, timeoutMs);

    // When stdout is file-backed, child.stdout is null (no pipe to read).
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const remaining = maxOutputBytes - stdoutBytes;
        if (remaining > 0) {
          if (chunk.length > remaining) {
            stdoutChunks.push(chunk.subarray(0, remaining));
            stdoutTruncated = true;
          } else {
            stdoutChunks.push(chunk);
          }
        } else {
          stdoutTruncated = true;
        }
        stdoutBytes += chunk.length;
      });
    }

    child.stderr.on("data", (chunk) => {
      if (stderrLogStream) {
        try { stderrLogStream.write(chunk); } catch {}
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (remaining > 0) {
        if (chunk.length > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
        }
      } else {
        stderrTruncated = true;
      }
      stderrBytes += chunk.length;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLog();
      finalizeStdoutFile();
      const hint = installHint ? ` ${installHint}` : "";
      if (error && error.code === "ENOENT") {
        reject(new ToolError(
          ERROR_CODES.INTERNAL_ERROR,
          `${cmd} not found on PATH.${hint}`,
        ));
        return;
      }
      reject(new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `${cmd} invocation failed: ${error.message || String(error)}.${hint}`,
      ));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLog();
      const fileStdout = finalizeStdoutFile();
      const stdout = fileStdout !== null
        ? fileStdout.toString("utf8")
        : Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        ok: !killed && code === 0,
        exit_code: code,
        signal,
        stdout,
        stderr,
        timed_out: killed,
        truncated: stdoutTruncated || stderrTruncated,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        duration_ms: Date.now() - start,
      });
    });
  });
}

module.exports = {
  spawnWithShutdown,
  SIGKILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
};
