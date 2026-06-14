"use strict";

const os = require("os");
const path = require("path");
const { SESSION_LOCK_NAME } = require("./constants.js");

function assertSafeProjectId(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error("project_id must be a non-empty string");
  }
  const trimmed = projectId.trim();
  if (/[\/\\]/.test(trimmed) || /(?:^|\.)\.\.(?:\.|$)/.test(trimmed)) {
    throw new Error(`project_id contains invalid path characters: ${trimmed}`);
  }
  return trimmed;
}

function sessionsRoot() {
  return path.join(os.homedir(), "video-vob-sessions");
}

function sessionDir(projectId) {
  return path.join(sessionsRoot(), assertSafeProjectId(projectId));
}

function statePath(projectId) {
  return path.join(sessionDir(projectId), "state.json");
}

function sessionLockPath(projectId) {
  return path.join(sessionDir(projectId), SESSION_LOCK_NAME);
}

function manifestPath(projectId) {
  return path.join(sessionDir(projectId), "manifest.json");
}

function briefPath(projectId) {
  return path.join(sessionDir(projectId), "brief.md");
}

function ingestDir(projectId) {
  return path.join(sessionDir(projectId), "ingest");
}

function inspectDir(projectId) {
  return path.join(sessionDir(projectId), "inspect");
}

function inspectThumbsDir(projectId) {
  return path.join(inspectDir(projectId), "thumbs");
}

function inspectAudioPath(projectId) {
  return path.join(inspectDir(projectId), "audio.wav");
}

function inspectTranscriptPath(projectId) {
  return path.join(inspectDir(projectId), "transcript.json");
}

function inspectCleanSpeechPath(projectId) {
  return path.join(inspectDir(projectId), "clean_speech.json");
}

// Per-channel loudness / balance / phase analysis + the −14 LUFS normalization
// advisory (v3.1 P2). Regenerated each INSPECT run like the other inspect/ files.
function inspectAudioAnalysisPath(projectId) {
  return path.join(inspectDir(projectId), "audio_analysis.json");
}

function inspectSummaryPath(projectId) {
  return path.join(inspectDir(projectId), "inspect.json");
}

function inspectContactSheetPath(projectId, fileIndex) {
  return path.join(inspectDir(projectId), `contact_sheet_file_${fileIndex}.jpg`);
}

function inspectTranscriptSummaryPath(projectId) {
  return path.join(inspectDir(projectId), "transcript_summary.md");
}

function inspectTranscriptParagraphsPath(projectId) {
  return path.join(inspectDir(projectId), "transcript_paragraphs.json");
}

// Segment artifacts produced by INSPECT. segments.json is the authoritative
// per-file segment list (the unit of classification/editing); keyframes are the
// representative frames the inspector subagent reads. Both live under inspect/
// and are regenerated each run (clearInspectDir wipes the tree).
function segmentsPath(projectId) {
  return path.join(inspectDir(projectId), "segments.json");
}

// The three classification pools written by the inspector subagent (via
// vob_save_classification) from segments.json: A-roll spine, B-roll index,
// and the ambiguous-segment review bucket.
function arollPoolPath(projectId) {
  return path.join(inspectDir(projectId), "aroll_pool.json");
}

function brollIndexPath(projectId) {
  return path.join(inspectDir(projectId), "broll_index.json");
}

function reviewPoolPath(projectId) {
  return path.join(inspectDir(projectId), "review.json");
}

function segmentKeyframesDir(projectId) {
  return path.join(inspectDir(projectId), "segment_keyframes");
}

function segmentKeyframePath(projectId, fileIndex, segmentIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  const si = assertNonNegativeInt(segmentIndex, "segment_index");
  return path.join(segmentKeyframesDir(projectId), `file_${fi}`, `seg_${si}.jpg`);
}

// Detection cache lives at the SESSION ROOT (NOT under inspect/) so it survives
// clearInspectDir between INSPECT runs. Keyed by manifest file content hash +
// detector params, mirroring the clip-materialize sidecar pattern, so a
// re-dropped/unchanged file skips re-running ffmpeg scene+silence detection.
function segmentCacheDir(projectId) {
  return path.join(sessionDir(projectId), "segment_cache");
}

function segmentCachePath(projectId, fileHash) {
  if (typeof fileHash !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileHash)) {
    throw new Error(`segmentCachePath requires a safe hash string, got ${fileHash}`);
  }
  return path.join(segmentCacheDir(projectId), `${fileHash}.json`);
}

// --- WP3: INSPECT v2 artifacts ---------------------------------------------
function inspectTranscriptsDir(projectId) {
  return path.join(inspectDir(projectId), "transcripts");
}

function inspectFileTranscriptPath(projectId, fileIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  return path.join(inspectTranscriptsDir(projectId), `file_${fi}.json`);
}

function inspectDigestPath(projectId) {
  return path.join(inspectDir(projectId), "digest.md");
}

function inspectStripsDir(projectId) {
  return path.join(inspectDir(projectId), "strips");
}

function inspectStripPath(projectId, fileIndex, stripIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  const si = assertNonNegativeInt(stripIndex, "strip_index");
  return path.join(inspectStripsDir(projectId), `file_${fi}_strip_${si}.jpg`);
}

function inspectStripListPath(projectId, fileIndex, stripIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  const si = assertNonNegativeInt(stripIndex, "strip_index");
  return path.join(inspectStripsDir(projectId), `file_${fi}_strip_${si}.ffconcat`);
}

function inspectStripsLegendPath(projectId) {
  return path.join(inspectStripsDir(projectId), "legend.json");
}

function inspectAudioFeaturesDir(projectId) {
  return path.join(inspectDir(projectId), "audio_features");
}

function inspectEnergyLogPath(projectId, fileIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  return path.join(inspectAudioFeaturesDir(projectId), `file_${fi}_rms.log`);
}

function inspectFeaturesStderrLogPath(projectId, fileIndex) {
  const fi = assertNonNegativeInt(fileIndex, "file_index");
  return path.join(inspectAudioFeaturesDir(projectId), `file_${fi}_detect.stderr.log`);
}

// Transcript cache lives at the SESSION ROOT (sibling of segment_cache/) so it
// survives clearInspectDir — same rationale as segmentCacheDir above.
function transcriptCacheDir(projectId) {
  return path.join(sessionDir(projectId), "transcript_cache");
}

function transcriptCachePath(projectId, fileHash) {
  if (typeof fileHash !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileHash)) {
    throw new Error(`transcriptCachePath requires a safe hash string, got ${fileHash}`);
  }
  return path.join(transcriptCacheDir(projectId), `${fileHash}.json`);
}

// Stderr tee log for the render tools (D6): render-preview.js uses kind
// "preview" (renders/preview-<ts>.log), render-full.js uses kind "render"
// (renders/render-<ts>.log). stamp = the caller's filename-safe timestamp slug.
function renderStderrLogPath(projectId, kind, stamp) {
  if (kind !== "render" && kind !== "preview") {
    throw new Error(`renderStderrLogPath kind must be "render"|"preview", got ${kind}`);
  }
  if (typeof stamp !== "string" || !/^[A-Za-z0-9._-]+$/.test(stamp)) {
    throw new Error(`renderStderrLogPath requires a safe stamp, got ${stamp}`);
  }
  return path.join(rendersDir(projectId), `${kind}-${stamp}.log`);
}

// PLAN-phase artifacts beyond the storyboard itself. plan/broll_gaps.json is
// the b-roll "shopping list": coverage the cut wants that the ingested footage
// can't supply (placements with source:"gap"), regenerated on every storyboard
// save and surfaced at the plan gate.
function planDir(projectId) {
  return path.join(sessionDir(projectId), "plan");
}

function brollGapsPath(projectId) {
  return path.join(planDir(projectId), "broll_gaps.json");
}

function storyboardPath(projectId) {
  return path.join(sessionDir(projectId), "storyboard.json");
}

function storyboardMarkdownPath(projectId) {
  return path.join(sessionDir(projectId), "storyboard.md");
}

function composeDir(projectId) {
  return path.join(sessionDir(projectId), "compose");
}

function composeSourceDir(projectId) {
  return path.join(composeDir(projectId), "source");
}

// Where `hyperframes snapshot` writes key-frame PNGs (cwd-relative `snapshots/`).
function snapshotsDir(projectId) {
  return path.join(composeDir(projectId), "snapshots");
}

function transcodedDir(projectId) {
  return path.join(sessionDir(projectId), "transcoded");
}

function transcodedClipsDir(projectId) {
  return path.join(transcodedDir(projectId), "clips");
}

function assertSafeSceneId(sceneId) {
  if (typeof sceneId !== "string" || !sceneId.trim()) {
    throw new Error("scene_id must be a non-empty string");
  }
  const trimmed = sceneId.trim();
  if (/[\/\\]/.test(trimmed) || /(?:^|\.)\.\.(?:\.|$)/.test(trimmed)) {
    throw new Error(`scene_id contains invalid path characters: ${trimmed}`);
  }
  return trimmed;
}

function assertNonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer (got ${value})`);
  }
  return value;
}

function transcodedClipStem(sceneId, clipIndex) {
  return `${assertSafeSceneId(sceneId)}-${assertNonNegativeInt(clipIndex, "clip_index")}`;
}

function transcodedClipPath(projectId, sceneId, clipIndex) {
  return path.join(transcodedClipsDir(projectId), `${transcodedClipStem(sceneId, clipIndex)}.mp4`);
}

function transcodedClipSidecarPath(projectId, sceneId, clipIndex) {
  return path.join(transcodedClipsDir(projectId), `${transcodedClipStem(sceneId, clipIndex)}.json`);
}

function previewDir(projectId) {
  return path.join(sessionDir(projectId), "preview");
}

function rendersDir(projectId) {
  return path.join(sessionDir(projectId), "renders");
}

// Segment partials (v3 segmented render) live at the SESSION ROOT, deliberately
// NOT under renders/: the per-segment cycle runs RENDER→COMPOSE back-edges, and
// any back-edge out of RENDER auto-archives renders/ — partials parked there
// would be swept mid-cycle and dangle the segment registry. Same rationale as
// deliverables/. The ASSEMBLED final still lands in renders/ (it IS the cut).
function segmentRendersDir(projectId) {
  return path.join(sessionDir(projectId), "segment_renders");
}

function assertSafeSegmentId(segmentId) {
  if (typeof segmentId !== "string" || !segmentId.trim()) {
    throw new Error("segment_id must be a non-empty string");
  }
  const trimmed = segmentId.trim();
  if (/[\/\\]/.test(trimmed) || /(?:^|\.)\.\.(?:\.|$)/.test(trimmed)) {
    throw new Error(`segment_id contains invalid path characters: ${trimmed}`);
  }
  return trimmed;
}

function segmentRenderPath(projectId, segmentId, stamp) {
  if (typeof stamp !== "string" || !/^[A-Za-z0-9._-]+$/.test(stamp)) {
    throw new Error(`segmentRenderPath requires a safe stamp, got ${stamp}`);
  }
  return path.join(segmentRendersDir(projectId), `${assertSafeSegmentId(segmentId)}-${stamp}.mp4`);
}

function segmentRenderLogPath(projectId, segmentId, stamp) {
  if (typeof stamp !== "string" || !/^[A-Za-z0-9._-]+$/.test(stamp)) {
    throw new Error(`segmentRenderLogPath requires a safe stamp, got ${stamp}`);
  }
  return path.join(segmentRendersDir(projectId), `${assertSafeSegmentId(segmentId)}-${stamp}.log`);
}

function packageDir(projectId) {
  return path.join(sessionDir(projectId), "package");
}

function packageFinalMp4Path(projectId) {
  return path.join(packageDir(projectId), "final.mp4");
}

function packageThumbnailPath(projectId) {
  return path.join(packageDir(projectId), "thumbnail.jpg");
}

function packageCaptionsSrtPath(projectId) {
  return path.join(packageDir(projectId), "captions.srt");
}

function packageCaptionsVttPath(projectId) {
  return path.join(packageDir(projectId), "captions.vtt");
}

function packagePostersDir(projectId) {
  return path.join(packageDir(projectId), "posters");
}

function packageManifestPath(projectId) {
  return path.join(packageDir(projectId), "manifest.json");
}

function packageReadmePath(projectId) {
  return path.join(packageDir(projectId), "README.md");
}

// Multi-aspect dumb-crop variants (opt-in, labeled-lossy). Lives UNDER package/,
// so it is wiped/recreated every package run and archived with the rest of
// package/ on a back-edge — never under deliverables/.
function packageVariantsDir(projectId) {
  return path.join(packageDir(projectId), "variants");
}

// Where externally-produced finals are recorded (the multi-deliverable / clip
// fan-out escape hatch — vob_import_deliverable). A TOP-LEVEL session dir, NOT
// under package/, so the single-timeline vob_package_output (which wipes
// package/ on every run) can never delete imported deliverables.
function deliverablesDir(projectId) {
  return path.join(sessionDir(projectId), "deliverables");
}

function archiveDir(projectId) {
  return path.join(sessionDir(projectId), "archive");
}

function archiveVersionDir(projectId, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`archive version must be a positive integer, got ${version}`);
  }
  return path.join(archiveDir(projectId), `v${version}`);
}

function archiveSnapshotPath(projectId, version) {
  return path.join(archiveVersionDir(projectId, version), "snapshot.json");
}

module.exports = {
  archiveDir,
  archiveSnapshotPath,
  archiveVersionDir,
  arollPoolPath,
  assertSafeProjectId,
  assertSafeSceneId,
  briefPath,
  brollGapsPath,
  brollIndexPath,
  planDir,
  reviewPoolPath,
  composeDir,
  composeSourceDir,
  ingestDir,
  inspectAudioAnalysisPath,
  inspectAudioFeaturesDir,
  inspectAudioPath,
  inspectCleanSpeechPath,
  inspectContactSheetPath,
  inspectDigestPath,
  inspectDir,
  inspectEnergyLogPath,
  inspectFeaturesStderrLogPath,
  inspectFileTranscriptPath,
  inspectStripListPath,
  inspectStripPath,
  inspectStripsDir,
  inspectStripsLegendPath,
  inspectSummaryPath,
  inspectThumbsDir,
  inspectTranscriptParagraphsPath,
  inspectTranscriptPath,
  inspectTranscriptSummaryPath,
  inspectTranscriptsDir,
  manifestPath,
  deliverablesDir,
  packageCaptionsSrtPath,
  packageCaptionsVttPath,
  packageDir,
  packageFinalMp4Path,
  packageManifestPath,
  packagePostersDir,
  packageReadmePath,
  packageThumbnailPath,
  packageVariantsDir,
  previewDir,
  renderStderrLogPath,
  rendersDir,
  assertSafeSegmentId,
  segmentRenderLogPath,
  segmentRenderPath,
  segmentRendersDir,
  segmentCacheDir,
  segmentCachePath,
  segmentKeyframePath,
  segmentKeyframesDir,
  segmentsPath,
  sessionDir,
  sessionLockPath,
  sessionsRoot,
  snapshotsDir,
  statePath,
  storyboardMarkdownPath,
  storyboardPath,
  transcodedClipPath,
  transcodedClipSidecarPath,
  transcodedClipStem,
  transcodedClipsDir,
  transcodedDir,
  transcriptCacheDir,
  transcriptCachePath,
};
