"use strict";

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const {
  SESSION_LOCK_NAME,
  SESSION_LOCK_STALE_MS,
} = require("./constants.js");
const {
  sessionDir,
  sessionLockPath,
} = require("./paths.js");
const {
  ERROR_CODES,
  ToolError,
} = require("./envelope.js");

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = siblingTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function siblingTempPath(filePath) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

function writeFileExclusiveAtomic(filePath, content, { mode } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = siblingTempPath(filePath);
  const writeOptions = { flag: "wx" };
  if (mode != null) writeOptions.mode = mode;
  try {
    fs.writeFileSync(tempPath, content, writeOptions);
    try {
      fs.linkSync(tempPath, filePath);
      return true;
    } catch (error) {
      if (error && error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function normalizeMaxJsonlRecords(maxRecords) {
  if (maxRecords == null) return null;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) {
    throw new Error("maxRecords must be a positive integer");
  }
  return maxRecords;
}

function trimJsonlFile(filePath, maxRecords) {
  const normalizedMaxRecords = normalizeMaxJsonlRecords(maxRecords);
  if (normalizedMaxRecords == null || !fs.existsSync(filePath)) {
    return { trimmed: false, total: 0, retained: 0 };
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length <= normalizedMaxRecords) {
    return { trimmed: false, total: lines.length, retained: lines.length };
  }

  const retainedLines = lines.slice(-normalizedMaxRecords);
  writeFileAtomic(filePath, `${retainedLines.join("\n")}\n`);
  return { trimmed: true, total: lines.length, retained: retainedLines.length };
}

function appendJsonlLines(filePath, documents, { maxRecords = null } = {}) {
  const normalizedMaxRecords = normalizeMaxJsonlRecords(maxRecords);
  if (!Array.isArray(documents)) {
    throw new Error("documents must be an array");
  }
  if (documents.length === 0) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(
    filePath,
    `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
    "utf8",
  );
  if (normalizedMaxRecords != null) {
    trimJsonlFile(filePath, normalizedMaxRecords);
  }
}

function appendJsonlLine(filePath, document, { maxRecords = null } = {}) {
  appendJsonlLines(filePath, [document], { maxRecords });
}

function writeMarkdownMirror(markdownPath, content, response) {
  try {
    writeFileAtomic(markdownPath, content);
    response.written_md = markdownPath;
  } catch (error) {
    response.markdown_sync_error = error.message || String(error);
  }
}

function appendMarkdownMirror(markdownPath, content, response) {
  try {
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.appendFileSync(markdownPath, content, "utf8");
    response.written_md = markdownPath;
  } catch (error) {
    response.markdown_sync_error = error.message || String(error);
  }
}

function loadJsonDocumentStrict(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Malformed ${label}: ${filePath} (${error.message || String(error)})`);
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed ${label}: ${filePath} (expected object)`);
  }

  return parsed;
}

function isSessionDirEffectivelyEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return true;
  }

  const entries = fs.readdirSync(dirPath).filter((entry) => entry !== SESSION_LOCK_NAME);
  return entries.length === 0;
}

function tryAcquireSessionLock(lockPathValue) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = `${JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
    token,
  }, null, 2)}\n`;
  return writeFileExclusiveAtomic(lockPathValue, payload, { mode: 0o600 })
    ? token
    : null;
}

function readSessionLockSnapshot(lockPathValue) {
  let stats;
  try {
    stats = fs.statSync(lockPathValue);
  } catch {
    return null;
  }

  let timestampMs = Number.NaN;
  let contentHash = null;
  if (stats.isFile()) {
    try {
      const content = fs.readFileSync(lockPathValue, "utf8");
      contentHash = crypto.createHash("sha256").update(content).digest("hex");
      const parsed = JSON.parse(content);
      timestampMs = Date.parse(parsed.timestamp);
    } catch {}
  }

  const staleReferenceMs = Number.isFinite(timestampMs) ? timestampMs : stats.mtimeMs;
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isDirectory: stats.isDirectory(),
    contentHash,
    isStale: Date.now() - staleReferenceMs > SESSION_LOCK_STALE_MS,
  };
}

function removeStaleSessionLock(lockPathValue, snapshot) {
  if (!snapshot || !snapshot.isStale) {
    return false;
  }

  let currentStats;
  try {
    currentStats = fs.statSync(lockPathValue);
  } catch {
    return false;
  }
  if (currentStats.dev !== snapshot.dev || currentStats.ino !== snapshot.ino) {
    return false;
  }
  if (currentStats.isDirectory() !== snapshot.isDirectory) {
    return false;
  }
  if (currentStats.size !== snapshot.size || currentStats.mtimeMs !== snapshot.mtimeMs) {
    return false;
  }
  if (!snapshot.isDirectory) {
    let currentContentHash = null;
    try {
      currentContentHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(lockPathValue, "utf8"))
        .digest("hex");
    } catch {
      return false;
    }
    if (currentContentHash !== snapshot.contentHash) {
      return false;
    }
  }

  fs.rmSync(lockPathValue, { recursive: snapshot.isDirectory, force: true });
  return true;
}

// Process-level lock cleanup: the lock is normally released by withSessionLock's
// finally, else by the 5-min staleness sweep. But a killed server (CLI restart,
// OOM, Ctrl-C) — possibly mid-COMPOSE-materialization, which holds the lock
// across minutes of ffmpeg / remove-bg — would otherwise strand EVERY vob_* call
// on that project until the stale timeout. Track held locks and release the ones
// we own on exit/SIGINT/SIGTERM.
const heldLocks = new Map(); // lockPath -> token
let lockCleanupRegistered = false;

function releaseHeldLockFile(lockPathValue, token) {
  try {
    const current = JSON.parse(fs.readFileSync(lockPathValue, "utf8"));
    if (current && current.token === token) fs.rmSync(lockPathValue, { force: true });
  } catch { /* gone / unreadable — nothing to release */ }
}

function releaseAllHeldLocks() {
  for (const [lockPathValue, token] of heldLocks) releaseHeldLockFile(lockPathValue, token);
  heldLocks.clear();
}

function ensureLockCleanupRegistered() {
  if (lockCleanupRegistered) return;
  lockCleanupRegistered = true;
  process.on("exit", releaseAllHeldLocks); // sync-only; covers normal/forced exit
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      releaseAllHeldLocks();
      // No prior handler existed (default was immediate termination) — preserve
      // that with the conventional 128+signal exit code after cleaning up.
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

function acquireSessionLock(domain) {
  const dir = sessionDir(domain);
  fs.mkdirSync(dir, { recursive: true });
  ensureLockCleanupRegistered();

  const lockPathValue = sessionLockPath(domain);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = tryAcquireSessionLock(lockPathValue);
    if (token) {
      heldLocks.set(lockPathValue, token);
      return () => {
        // Token-precise map removal: a stale release after a same-path re-acquire
        // must not drop the live entry the signal handler would clean.
        if (heldLocks.get(lockPathValue) === token) heldLocks.delete(lockPathValue);
        releaseHeldLockFile(lockPathValue, token);
      };
    }

    const staleSnapshot = readSessionLockSnapshot(lockPathValue);
    if (attempt === 0 && staleSnapshot && staleSnapshot.isStale) {
      try {
        removeStaleSessionLock(lockPathValue, staleSnapshot);
      } catch {}
      continue;
    }

    throw new ToolError(ERROR_CODES.STATE_CONFLICT, `Session lock busy: ${dir}`);
  }

  throw new ToolError(ERROR_CODES.STATE_CONFLICT, `Session lock busy: ${dir}`);
}

// Async-aware: if the callback returns a promise, the lock is held until the
// promise settles and released exactly once. Sync callbacks behave as before.
function withSessionLock(domain, callback) {
  const release = acquireSessionLock(domain);
  let result;
  try {
    result = callback();
  } catch (error) {
    release();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return Promise.resolve(result).finally(release);
  }
  release();
  return result;
}

module.exports = {
  acquireSessionLock,
  appendJsonlLine,
  appendJsonlLines,
  appendMarkdownMirror,
  isSessionDirEffectivelyEmpty,
  loadJsonDocumentStrict,
  readJsonFile,
  trimJsonlFile,
  readSessionLockSnapshot,
  removeStaleSessionLock,
  tryAcquireSessionLock,
  withSessionLock,
  writeFileAtomic,
  writeFileExclusiveAtomic,
  writeMarkdownMirror,
};
