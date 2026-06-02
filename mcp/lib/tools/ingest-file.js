"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  manifestPath,
  statePath,
} = require("../paths.js");
const {
  readJsonFile,
  withSessionLock,
  writeFileAtomic,
} = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");
const { checkHyperframesAvailable } = require("../hyperframes-runner.js");
const { checkFfmpegAvailable } = require("../ffmpeg-runner.js");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
// Audio-only drops are first-class: a bare voiceover/narration track is a valid
// spine source (stream-layout prior 'narration'). Accept common audio
// containers so they're ingested rather than silently skipped.
const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".wma"]);
const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

function nowIso() {
  return new Date().toISOString();
}

function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveSource(rawSourcePath) {
  if (typeof rawSourcePath !== "string" || !rawSourcePath.trim()) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "source_path must be a non-empty string");
  }
  const resolved = path.resolve(rawSourcePath.trim());
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new ToolError(ERROR_CODES.NOT_FOUND, `source_path does not exist: ${resolved}`);
    }
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source_path could not be stat'd: ${error.message || String(error)}`,
    );
  }
  return { resolved, stat };
}

function enumerateFiles(resolved, stat) {
  if (stat.isFile()) {
    if (!isMediaFile(resolved)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `source_path is not a recognized media file (extension must be one of ${[...MEDIA_EXTENSIONS].join(", ")}): ${resolved}`,
      );
    }
    return [resolved];
  }
  if (!stat.isDirectory()) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source_path must be a media file or directory: ${resolved}`,
    );
  }
  const entries = fs.readdirSync(resolved)
    .map((name) => path.join(resolved, name))
    .filter((entry) => {
      try {
        return fs.statSync(entry).isFile() && isMediaFile(entry);
      } catch {
        return false;
      }
    })
    .sort();
  if (entries.length === 0) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `no recognized media files in directory: ${resolved}`,
    );
  }
  return entries;
}

// Stream-layout prior, set BEFORE any content analysis. Audio-only drops are a
// first-class narration/VO spine; silent video is a B-roll candidate; a file
// with both is ambiguous (let INSPECT/classification decide).
function streamLayoutPrior(summary) {
  if (summary.has_audio && !summary.has_video) return "narration";
  if (summary.has_video && !summary.has_audio) return "broll";
  return null;
}

function fileSignature(filePath) {
  const st = fs.statSync(filePath);
  return { size_bytes: st.size, mtime_ms: Math.round(st.mtimeMs) };
}

// Streaming SHA-256 of the file content. Only invoked for new/changed files
// (the size+mtime fast-path in buildManifest avoids re-hashing on re-drops),
// so the cost of hashing a large source is paid once.
function hashFile(filePath) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    let bytesRead;
    // eslint-disable-next-line no-cond-assign
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      h.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function probeOneFile(filePath) {
  const sig = fileSignature(filePath);
  const probe = probeFile(filePath);
  const summary = summarizeProbe(filePath, probe);
  return {
    ...summary,
    size_bytes: sig.size_bytes,
    mtime_ms: sig.mtime_ms,
    hash: hashFile(filePath),
    prior: streamLayoutPrior(summary),
    probe,
  };
}

// Hash-keyed, additive, incremental merge. Prior manifest entries are kept
// (a file ingested in an earlier drop survives even if it's not in this drop),
// then the currently-enumerated files are overlaid: an unchanged file (same
// path + size + mtime, with a hash already on record) reuses its prior entry
// untouched (no re-probe, no re-hash); a new or changed file is freshly
// probed + hashed. Never a full rebuild.
function buildManifest({ projectId, sourcePath, files, priorManifest }) {
  const byPath = new Map();
  const priorFiles = priorManifest && Array.isArray(priorManifest.files) ? priorManifest.files : [];
  for (const entry of priorFiles) {
    if (entry && typeof entry.path === "string") byPath.set(entry.path, entry);
  }

  let reprobedCount = 0;
  let reusedCount = 0;
  for (const filePath of files) {
    const prior = byPath.get(filePath);
    let sig = null;
    try { sig = fileSignature(filePath); } catch { sig = null; }
    const unchanged = prior
      && sig
      && Number(prior.size_bytes) === sig.size_bytes
      && Number(prior.mtime_ms) === sig.mtime_ms
      && typeof prior.hash === "string"
      && prior.has_video !== undefined
      && prior.prior !== undefined;
    if (unchanged) {
      reusedCount += 1;
    } else {
      byPath.set(filePath, probeOneFile(filePath));
      reprobedCount += 1;
    }
  }

  const mergedFiles = Array.from(byPath.values());
  const videoStreamCount = mergedFiles.reduce(
    (sum, entry) => sum + (Number(entry.video_streams) || 0),
    0,
  );
  if (videoStreamCount === 0) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source contains no playable video streams (across all ingested files): ${sourcePath}`,
    );
  }

  return {
    project_id: projectId,
    source_path: sourcePath,
    ingested_at: nowIso(),
    file_count: mergedFiles.length,
    video_stream_count: videoStreamCount,
    new_or_changed_count: reprobedCount,
    reused_count: reusedCount,
    files: mergedFiles,
  };
}

function ingestFile(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const { resolved: sourcePath, stat } = resolveSource(args && args.source_path);
  const files = enumerateFiles(sourcePath, stat);

  // Read the prior manifest (best-effort) so the merge is incremental/additive
  // rather than a full rebuild. Probing/hashing happens outside the session
  // lock; only the manifest + state write below are locked.
  const manifestFile = manifestPath(id);
  let priorManifest = null;
  if (fs.existsSync(manifestFile)) {
    try { priorManifest = readJsonFile(manifestFile); } catch { priorManifest = null; }
  }
  const manifest = buildManifest({ projectId: id, sourcePath, files, priorManifest });

  // Best-effort preflight for downstream CLI deps. Non-fatal at INGEST — the
  // lint/render/package tools fail loudly on their own if a binary disappears
  // later. Recorded so the orchestrator can warn the user proactively at
  // INGEST instead of after a BRIEF/STORYBOARD round trip, and so the
  // RENDER -> PACKAGE gate can surface ffmpeg gaps with a clear blocker.
  const hyperframes = checkHyperframesAvailable();
  const ffmpeg = checkFfmpegAvailable();

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const ts = nowIso();
    const next = {
      ...state,
      manifest: {
        path: manifestFile,
        source_path: sourcePath,
        ingested_at: manifest.ingested_at,
        file_count: manifest.file_count,
        video_stream_count: manifest.video_stream_count,
      },
      dependencies: {
        ...(state.dependencies && typeof state.dependencies === "object" && !Array.isArray(state.dependencies) ? state.dependencies : {}),
        hyperframes,
        ffmpeg,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "ingest_recorded",
          source_path: sourcePath,
          file_count: manifest.file_count,
          video_stream_count: manifest.video_stream_count,
          new_or_changed_count: manifest.new_or_changed_count,
          reused_count: manifest.reused_count,
          at: ts,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      manifest_path: manifestFile,
      source_path: sourcePath,
      file_count: manifest.file_count,
      video_stream_count: manifest.video_stream_count,
      new_or_changed_count: manifest.new_or_changed_count,
      reused_count: manifest.reused_count,
      files: manifest.files.map(({ probe: _probe, ...summary }) => summary),
      hyperframes,
      ffmpeg,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_ingest_file",
  description: "Probe a video/audio file (or directory) with ffprobe and write a hash-keyed manifest.json plus a state.json summary. INCREMENTAL + ADDITIVE: re-running merges with the existing manifest — unchanged files (same path+size+mtime) reuse their prior probe+hash, new/changed files are re-probed and re-hashed, and files from earlier drops are preserved. Each entry carries {hash, container, resolution, fps, has_video, has_audio} plus a stream-layout `prior` ('narration' for audio-only, 'broll' for silent video, null for both). Returns new_or_changed_count/reused_count. Errors if ffprobe is missing, the merged manifest has no playable video stream, or the project is uninitialized.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      source_path: { type: "string", minLength: 1 },
    },
    required: ["project_id", "source_path"],
  },
  handler: ingestFile,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["manifest.json", "state.json"],
  hook_required: false,
});
