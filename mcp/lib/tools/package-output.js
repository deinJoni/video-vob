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
  storyboardPath,
} = require("../paths.js");
const { readJsonFile, withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");
const {
  runFfmpegBlocking,
  checkFfmpegAvailable,
  buildLoudnormMeasureArgv,
  buildLoudnormApplyArgv,
  parseLoudnormStats,
  LOUDNORM_TIMEOUT_MS,
  LOUDNORM_TARGET,
} = require("../ffmpeg-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { thumbnailTimestampPercent, canonicalizePlatform } = require("../platform-profiles.js");
const { renderPackageReadme } = require("../package-readme.js");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const VERSION_FILE_PATH = path.join(PROJECT_ROOT, ".vob", "VERSION");

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

// Platform for the thumbnail percent: canonical intent answer first (v2 object
// {raw,canonical,profile} or legacy string), falling back to the init-time
// state.target.format hint, else "" -> vertical profile (percent 10).
function thumbnailPercentForIntent(state) {
  const answers = state && state.intent && state.intent.answers ? state.intent.answers : {};
  const tp = answers.target_platform;
  const platformRaw = ((tp && typeof tp === "object" && !Array.isArray(tp))
    ? (tp.canonical || tp.raw || "")
    : (typeof tp === "string" ? tp : null))
    || (state && state.target && typeof state.target.format === "string" ? state.target.format : "");
  return thumbnailTimestampPercent(canonicalizePlatform(platformRaw || "").canonical);
}

// Pick the thumbnail moment: midpoint of the storyboard hook scene in OUTPUT
// time (scene starts are cumulative target durations), clamped to the probed
// duration; fall back to the configured percent (default 10%).
function resolveThumbnailMoment({ projectId, durationSeconds, state }) {
  let sb = null;
  try {
    sb = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8"));
  } catch {}
  if (sb && Array.isArray(sb.scenes)) {
    let cursor = 0;
    for (const scene of sb.scenes) {
      const d = Number(scene && scene.target_duration_seconds);
      if (!Number.isFinite(d) || d <= 0) { cursor = NaN; break; }
      if (scene.purpose === "hook") {
        const at = Math.max(0, Math.min(cursor + d / 2, Math.max(0, durationSeconds - 0.01)));
        return { seconds: at, strategy: "hook_scene_midpoint", hook_scene_id: scene.scene_id || null };
      }
      cursor += d;
    }
  }
  const percent = thumbnailPercentForIntent(state);
  const at = Math.max(0, Math.min(durationSeconds * (percent / 100), Math.max(0, durationSeconds - 0.01)));
  return { seconds: at, strategy: "percent", hook_scene_id: null, percent };
}

// Two-pass loudnorm to -14 LUFS / -1 dBTP on the packaged final.mp4. Audio-only
// re-encode (video stream copied). Every non-applied exit records a
// skipped_reason and packaging CONTINUES un-normalized — loudness is polish,
// not a gate.
async function runLoudnormPass({ finalMp4, summaryPre }) {
  const knob = (process.env.VOB_NO_LOUDNORM || "").trim().toLowerCase();
  const base = { applied: false, skipped_reason: null, error: null, measured_input_i: null, measured_input_tp: null };
  if (knob === "1" || knob === "on" || knob === "true" || knob === "yes") {
    return { ...base, skipped_reason: "disabled_via_env" };
  }
  if (!summaryPre || summaryPre.audio_streams === 0) {
    return { ...base, skipped_reason: "no_audio" };
  }
  const measure = await runFfmpegBlocking(buildLoudnormMeasureArgv({ input: finalMp4 }), { timeoutMs: LOUDNORM_TIMEOUT_MS });
  const measured = measure.timed_out || measure.exit_code !== 0 ? null : parseLoudnormStats(measure.stderr);
  if (!measured) {
    return { ...base, skipped_reason: "measure_failed", error: stderrTail(measure.stderr, 1000) };
  }
  if (measured.input_i === "-inf") {
    return { ...base, skipped_reason: "silent_audio" };
  }
  const inputI = Number(measured.input_i);
  const inputTp = Number(measured.input_tp);
  const measuredNums = {
    measured_input_i: Number.isFinite(inputI) ? inputI : null,
    measured_input_tp: Number.isFinite(inputTp) ? inputTp : null,
  };
  if (Number.isFinite(inputI) && Math.abs(inputI - LOUDNORM_TARGET.i) <= 0.5
    && Number.isFinite(inputTp) && inputTp <= LOUDNORM_TARGET.tp) {
    return { ...base, ...measuredNums, skipped_reason: "already_within_tolerance" };
  }
  const tmp = path.join(path.dirname(finalMp4), "final.loudnorm.tmp.mp4");
  const apply = await runFfmpegBlocking(
    buildLoudnormApplyArgv({ input: finalMp4, output: tmp, measured }),
    { timeoutMs: LOUDNORM_TIMEOUT_MS },
  );
  if (apply.timed_out || apply.exit_code !== 0 || !fs.existsSync(tmp)) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ...base, ...measuredNums, skipped_reason: "apply_failed", error: stderrTail(apply.stderr, 1000) };
  }
  fs.renameSync(tmp, finalMp4);
  return { ...base, ...measuredNums, applied: true };
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
  const summaryPre = summarizeProbe(finalMp4, probe);

  // Loudness normalization BEFORE the thumbnail/manifest probe: the post-
  // normalization re-probe is the authoritative summary for everything below.
  const loudnorm = await runLoudnormPass({ finalMp4, summaryPre });
  let summary = summaryPre;
  if (loudnorm.applied) {
    try {
      summary = summarizeProbe(finalMp4, probeFile(finalMp4));
    } catch (error) {
      cleanupOnFailure(pkgRoot);
      throw error;
    }
  }

  const durationSeconds = Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : 0;
  const thumbnailMoment = resolveThumbnailMoment({ projectId: id, durationSeconds, state });
  const thumbnailAtSeconds = thumbnailMoment.seconds;

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
      { stderr_preview: stderrTail(ffmpegResult.stderr, 1000) },
    );
  }
  if (ffmpegResult.exit_code !== 0 || !fs.existsSync(thumbnail)) {
    cleanupOnFailure(pkgRoot);
    const stderrPreview = stderrTail(ffmpegResult.stderr, 2000);
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

  // Expected duration from the storyboard total — drives the drift field.
  let expectedDurationSeconds = null;
  try {
    const sbTotal = Number(JSON.parse(fs.readFileSync(storyboardPath(id), "utf8")).total_target_duration_seconds);
    expectedDurationSeconds = Number.isFinite(sbTotal) && sbTotal > 0 ? sbTotal : null;
  } catch {}
  const durationDriftSeconds = Number.isFinite(summary.duration_seconds) && expectedDurationSeconds !== null
    ? Math.round((summary.duration_seconds - expectedDurationSeconds) * 1000) / 1000
    : null;

  const manifest = {
    manifest_version: "1.1",
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
      expected_duration_seconds: expectedDurationSeconds,
      duration_drift_seconds: durationDriftSeconds,
    },
    thumbnail: {
      path: "thumbnail.jpg",
      extracted_at_seconds: thumbnailAtSeconds,
      extracted_at_percent: durationSeconds > 0
        ? Math.round((thumbnailAtSeconds / durationSeconds) * 1000) / 10
        : null,
      strategy: thumbnailMoment.strategy,
      hook_scene_id: thumbnailMoment.hook_scene_id,
      file_size_bytes: thumbnailFileSize,
    },
    audio: {
      loudnorm_applied: loudnorm.applied,
      loudnorm_target: { i: LOUDNORM_TARGET.i, tp: LOUDNORM_TARGET.tp, lra: LOUDNORM_TARGET.lra },
      measured_input_i: loudnorm.measured_input_i,
      measured_input_tp: loudnorm.measured_input_tp,
      skipped_reason: loudnorm.skipped_reason,
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
      quality: render.quality ?? null,
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
          loudnorm_applied: loudnorm.applied,
          thumbnail_strategy: thumbnailMoment.strategy,
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
  description: "Assemble package/: copy the confirmed render to final.mp4, two-pass loudness-normalize the audio to −14 LUFS/−1 dBTP (audio-only re-encode, video stream copied; VOB_NO_LOUDNORM=1 skips), extract the thumbnail at the storyboard hook-scene midpoint (fallback: 10%), write manifest.json (v1.1) + README.md. Wipes package/ first. Requires render.confirmed:true.",
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
