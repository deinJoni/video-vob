"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  manifestPath: ingestManifestPath,
  packageDir,
  packageFinalMp4Path,
  packageManifestPath,
  packageReadmePath,
  packageThumbnailPath,
  rendersDir,
  sessionDir,
  statePath,
} = require("../paths.js");
const { readJsonFile, withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");
const { runFfmpegBlocking, checkFfmpegAvailable } = require("../ffmpeg-runner.js");
const { renderPackageReadme } = require("../package-readme.js");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const VERSION_FILE_PATH = path.join(PROJECT_ROOT, ".vob", "VERSION");
const RENDER_PROFILES_PATH = path.join(PROJECT_ROOT, ".vob-config", "render-profiles.json");
const DEFAULT_THUMBNAIL_PERCENT = 10;

function nowIso() {
  return new Date().toISOString();
}

function readVideoVobVersion() {
  try {
    return fs.readFileSync(VERSION_FILE_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readThumbnailPercent(target) {
  let profiles = null;
  try {
    profiles = readJsonFile(RENDER_PROFILES_PATH);
  } catch {
    profiles = null;
  }
  const format = target && typeof target === "object" && typeof target.format === "string"
    ? target.format.trim().toLowerCase()
    : null;
  if (profiles && format && profiles[format] && Number.isFinite(profiles[format].thumbnail_timestamp_percent)) {
    return Number(profiles[format].thumbnail_timestamp_percent);
  }
  if (profiles && Number.isFinite(profiles.thumbnail_timestamp_percent)) {
    return Number(profiles.thumbnail_timestamp_percent);
  }
  return DEFAULT_THUMBNAIL_PERCENT;
}

function sessionRelative(projectId, absPath) {
  return path.relative(sessionDir(projectId), absPath);
}

function cleanupOnFailure(pkgRoot) {
  try {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  } catch {}
}

async function packageOutput(args) {
  const id = assertSafeProjectId(args && args.project_id);

  const state = readSessionStateStrict(id);
  const render = state.render && typeof state.render === "object" && !Array.isArray(state.render)
    ? state.render
    : null;
  if (!render || typeof render.mp4_path !== "string" || !render.mp4_path) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no full render recorded in state — call vob_render_full before vob_package_output",
    );
  }
  if (!fs.existsSync(render.mp4_path)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `render file referenced by state is not on disk: ${render.mp4_path}`,
    );
  }
  if (render.confirmed !== true) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      "full render has not been confirmed — call vob_confirm_render before vob_package_output",
    );
  }

  const dependencies = state.dependencies && typeof state.dependencies === "object" ? state.dependencies : {};
  const ffmpegInfo = dependencies.ffmpeg && typeof dependencies.ffmpeg === "object" ? dependencies.ffmpeg : null;
  if (ffmpegInfo && ffmpegInfo.ok === false) {
    // The INGEST preflight is a stale snapshot — re-check ffmpeg live before
    // blocking, so a transient flake at INGEST (an npx/launch hiccup) doesn't
    // wedge PACKAGE when ffmpeg is actually present. Only block if STILL missing.
    const live = checkFfmpegAvailable();
    if (live.ok !== true) {
      throw new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `ffmpeg is required to package the output but is not available: ${live.error || ffmpegInfo.error || "unknown error"}. Install ffmpeg and retry.`,
      );
    }
  }

  const pkgRoot = packageDir(id);
  if (fs.existsSync(pkgRoot)) {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(pkgRoot, { recursive: true });

  const finalMp4 = packageFinalMp4Path(id);
  const thumbnail = packageThumbnailPath(id);
  const manifestFile = packageManifestPath(id);
  const readmeFile = packageReadmePath(id);

  try {
    fs.copyFileSync(render.mp4_path, finalMp4);
  } catch (error) {
    cleanupOnFailure(pkgRoot);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `failed to copy render into package/: ${error.message || String(error)}`,
    );
  }

  let probe;
  try {
    probe = probeFile(finalMp4);
  } catch (error) {
    cleanupOnFailure(pkgRoot);
    throw error;
  }
  const summary = summarizeProbe(finalMp4, probe);

  const durationSeconds = Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : 0;
  const thumbnailPercent = readThumbnailPercent(state.target);
  const thumbnailAtSeconds = Math.max(0, Math.min(durationSeconds * (thumbnailPercent / 100), Math.max(0, durationSeconds - 0.01)));

  const ffmpegResult = await runFfmpegBlocking(
    [
      "-y",
      "-ss", thumbnailAtSeconds.toFixed(3),
      "-i", finalMp4,
      "-vframes", "1",
      "-q:v", "2",
      thumbnail,
    ],
    { cwd: pkgRoot },
  );
  if (ffmpegResult.timed_out) {
    cleanupOnFailure(pkgRoot);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      "ffmpeg thumbnail extraction timed out",
      { stderr_preview: (ffmpegResult.stderr || "").trim().slice(0, 1000) || null },
    );
  }
  if (ffmpegResult.exit_code !== 0 || !fs.existsSync(thumbnail)) {
    cleanupOnFailure(pkgRoot);
    const stderrPreview = (ffmpegResult.stderr || "").trim().slice(0, 2000) || null;
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg thumbnail extraction failed (exit ${ffmpegResult.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: ffmpegResult.exit_code, signal: ffmpegResult.signal, stderr_preview: stderrPreview },
    );
  }

  const ingestManifestAbs = ingestManifestPath(id);
  let ingestManifest = null;
  try {
    ingestManifest = readJsonFile(ingestManifestAbs);
  } catch {
    ingestManifest = null;
  }
  const primarySource = ingestManifest && Array.isArray(ingestManifest.files) && ingestManifest.files[0]
    ? ingestManifest.files[0].path || null
    : null;

  const packagedAt = nowIso();
  const iterationVersion = state.iteration && Number.isInteger(state.iteration.current_version) && state.iteration.current_version > 0
    ? state.iteration.current_version
    : 1;

  const composition = state.composition && typeof state.composition === "object" ? state.composition : null;
  const preview = state.preview && typeof state.preview === "object" ? state.preview : null;
  const storyboard = state.storyboard && typeof state.storyboard === "object" ? state.storyboard : null;
  const hyperframesInfo = dependencies.hyperframes && typeof dependencies.hyperframes === "object" ? dependencies.hyperframes : null;

  const renderFileSize = (() => {
    try { return fs.statSync(finalMp4).size; } catch { return null; }
  })();
  const thumbnailFileSize = (() => {
    try { return fs.statSync(thumbnail).size; } catch { return null; }
  })();

  const manifest = {
    manifest_version: "1.0",
    video_vob_version: readVideoVobVersion(),
    project_id: id,
    title: id,
    iteration_version: iterationVersion,
    packaged_at: packagedAt,
    target: state.target == null ? null : state.target,
    video: {
      path: "final.mp4",
      duration_seconds: Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null,
      width: summary.primary_video ? summary.primary_video.width : null,
      height: summary.primary_video ? summary.primary_video.height : null,
      file_size_bytes: renderFileSize,
      codec: summary.primary_video ? summary.primary_video.codec : null,
      frame_rate: summary.primary_video ? summary.primary_video.frame_rate : null,
    },
    thumbnail: {
      path: "thumbnail.jpg",
      extracted_at_seconds: thumbnailAtSeconds,
      extracted_at_percent: thumbnailPercent,
      file_size_bytes: thumbnailFileSize,
    },
    source: {
      ingest_manifest_path: ingestManifestAbs ? sessionRelative(id, ingestManifestAbs) : null,
      primary_source_path: primarySource,
      file_count: ingestManifest && Number.isInteger(ingestManifest.file_count) ? ingestManifest.file_count : null,
    },
    lineage: {
      storyboard_revision: storyboard && Number.isInteger(storyboard.revision_count) ? storyboard.revision_count : null,
      composition_revision: composition && Number.isInteger(composition.revision_count) ? composition.revision_count : null,
      preview_revision: preview && Number.isInteger(preview.revision_count) ? preview.revision_count : null,
      render_revision: Number.isInteger(render.revision_count) ? render.revision_count : null,
      derived_from: state.style && state.style.derived_from ? state.style.derived_from : null,
    },
    render: {
      rendered_at: render.rendered_at || null,
      render_duration_seconds: Number.isFinite(render.render_duration_seconds) ? render.render_duration_seconds : null,
      engine: "hyperframes",
      engine_version: hyperframesInfo && hyperframesInfo.version ? hyperframesInfo.version : null,
    },
  };

  writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileAtomic(readmeFile, renderPackageReadme(manifest));

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const next = {
      ...stateNow,
      package: {
        directory_path: sessionRelative(id, pkgRoot),
        final_mp4_path: sessionRelative(id, finalMp4),
        thumbnail_path: sessionRelative(id, thumbnail),
        manifest_path: sessionRelative(id, manifestFile),
        readme_path: sessionRelative(id, readmeFile),
        packaged_at: packagedAt,
        iteration_version: iterationVersion,
      },
      last_updated: packagedAt,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "package_built",
          at: packagedAt,
          iteration_version: iterationVersion,
          files: 4,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      directory_path: pkgRoot,
      final_mp4_path: finalMp4,
      thumbnail_path: thumbnail,
      manifest_path: manifestFile,
      readme_path: readmeFile,
      packaged_at: packagedAt,
      iteration_version: iterationVersion,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_package_output",
  description: "Assemble the shippable package: copy the confirmed full render into package/final.mp4, extract a thumbnail via ffmpeg (default 10% of duration; configurable via .vob-config/render-profiles.json), ffprobe the rendered MP4 for authoritative duration/dimensions, write package/manifest.json with all metadata, and derive package/README.md from the manifest. Requires state.render with confirmed:true and the MP4 on disk. Overwrites any existing package/ directory. Appends 'package_built' to history.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: packageOutput,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["package/final.mp4", "package/thumbnail.jpg", "package/manifest.json", "package/README.md", "state.json"],
  hook_required: false,
});
