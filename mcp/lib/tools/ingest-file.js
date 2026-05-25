"use strict";

const fs = require("fs");
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

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

function nowIso() {
  return new Date().toISOString();
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
    if (!isVideoFile(resolved)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `source_path is not a recognized video file (extension must be one of ${[...VIDEO_EXTENSIONS].join(", ")}): ${resolved}`,
      );
    }
    return [resolved];
  }
  if (!stat.isDirectory()) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source_path must be a video file or directory: ${resolved}`,
    );
  }
  const entries = fs.readdirSync(resolved)
    .map((name) => path.join(resolved, name))
    .filter((entry) => {
      try {
        return fs.statSync(entry).isFile() && isVideoFile(entry);
      } catch {
        return false;
      }
    })
    .sort();
  if (entries.length === 0) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `no recognized video files in directory: ${resolved}`,
    );
  }
  return entries;
}

function buildManifest({ projectId, sourcePath, files }) {
  const probedFiles = files.map((filePath) => {
    const probe = probeFile(filePath);
    const summary = summarizeProbe(filePath, probe);
    return { ...summary, probe };
  });

  const videoStreamCount = probedFiles.reduce(
    (sum, entry) => sum + (Number(entry.video_streams) || 0),
    0,
  );
  if (videoStreamCount === 0) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `source contains no playable video streams: ${sourcePath}`,
    );
  }

  return {
    project_id: projectId,
    source_path: sourcePath,
    ingested_at: nowIso(),
    file_count: probedFiles.length,
    video_stream_count: videoStreamCount,
    files: probedFiles,
  };
}

function ingestFile(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const { resolved: sourcePath, stat } = resolveSource(args && args.source_path);
  const files = enumerateFiles(sourcePath, stat);
  const manifest = buildManifest({ projectId: id, sourcePath, files });

  // Best-effort hyperframes preflight. Non-fatal — the lint/render tools fail
  // loudly on their own if hyperframes disappears later. Recorded so the
  // orchestrator can warn the user proactively at INGEST instead of after a
  // BRIEF/STORYBOARD round trip.
  const hyperframes = checkHyperframesAvailable();

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const manifestFile = manifestPath(id);
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
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "ingest_recorded",
          source_path: sourcePath,
          file_count: manifest.file_count,
          video_stream_count: manifest.video_stream_count,
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
      files: manifest.files.map(({ probe: _probe, ...summary }) => summary),
      hyperframes,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_ingest_file",
  description: "Probe a video file (or directory of video files) with ffprobe and write a manifest.json plus a state.json summary of source_path + counts. Errors if ffprobe is missing, the source has no playable video stream, or the project has not been initialized.",
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
