"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("./envelope.js");
const { writeFileAtomic, readJsonFile } = require("./storage.js");
const { runFfmpegBlocking, inputAutorotateArgs } = require("./ffmpeg-runner.js");
const { asrTranscribe, resolvedAsrParams } = require("./asr-backend.js");
const {
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
  inspectStripsLegendPath,
  inspectSummaryPath,
  inspectThumbsDir,
  inspectTranscriptParagraphsPath,
  inspectTranscriptPath,
  inspectTranscriptSummaryPath,
  inspectTranscriptsDir,
  segmentCacheDir,
  segmentCachePath,
  segmentsPath,
  transcriptCacheDir,
  transcriptCachePath,
} = require("./paths.js");
const { buildTranscriptSummary } = require("./transcript-summary.js");
const { detectSceneChanges } = require("./scene-detector.js");
const { detectSilences } = require("./silence-detector.js");
const {
  analyzeAudioFile,
  audioAnalysisDisabled,
  buildNormalizationAdvisory,
  pickCleanAudioSource,
  AUDIO_ANALYSIS_TARGET_LUFS,
  AUDIO_ANALYSIS_TRUE_PEAK_CEILING,
} = require("./audio-analysis.js");
const { computeCleanSpans } = require("./clean-cut.js");
const { buildSegments } = require("./segment-model.js");
const {
  attachAudioFeatures,
  attachTranscriptOverlap,
  buildSegmentStrips,
  extractSegmentKeyframes,
} = require("./segment-signals.js");
const { attachVisualFeatures } = require("./visual-quality.js");
const { attachFaceFeatures } = require("./face-backend.js");
const { attachCleanliness, attachTakeStrength, summarizeTakeQuality } = require("./take-quality.js");
const { mapWithConcurrency } = require("./concurrency.js");
const { thumbConcurrency } = require("./host-profile.js");
const { probeKeyframeInterval } = require("./ffprobe.js");
const { rankHookCandidates, buildInspectDigest } = require("./inspect-digest.js");

const THUMB_TIMEOUT_MS = 120 * 1000;
// Per-seek timeout for one single-frame thumbnail extract (KEYFRAME_TIMEOUT_MS
// precedent — one input-side seek decodes ~one GOP, 60s is generous).
const THUMB_SEEK_TIMEOUT_MS = 60 * 1000;
// Hard grid cap per file, even for an explicit thumb_interval_seconds (the
// default-interval math already targets ~120). Seek cost is O(grid), so a
// pathological tiny interval on a long source must not spawn thousands of
// seeks; dropped slots surface as a thumbnails_truncated warning.
const MAX_THUMBS_PER_FILE = 400;
// Stop scheduling new seeks after this many real failures — a pipeline that
// keeps failing is a dead decoder, not scattered bad frames.
const THUMB_FAILURE_BAIL = 5;
const AUDIO_TIMEOUT_MS = 180 * 1000;
const CONTACT_SHEET_TIMEOUT_MS = 120 * 1000;
const CONTACT_SHEET_COLS = 5;
const CONTACT_SHEET_CELL_WIDTH = 320;
// Chunk contact sheets at ≤40 cells (5 cols × ≤8 rows): a single 600-cell tile
// collapses to ~50px smears after the vision pipeline's ~1.15MP downscale,
// making the orchestrator's mandatory visual grounding nominal.
const CONTACT_SHEET_MAX_CELLS = 40;
const DEFAULT_THUMB_INTERVAL_SECONDS = 3;
// Default thumb interval scales with duration to cap thumbs at ~this many per
// file (≤3 sheets/file); an explicit thumb_interval_seconds is honored verbatim.
const MAX_DEFAULT_THUMBS_PER_FILE = 120;
const DEFAULT_SAMPLE_THUMB_COUNT = 7;
// Clean-speech (filler/dead-air) detection uses a quieter silence floor than the
// segmenter (-30dB): at -40dB true dead air and quiet speech both register as
// "silent", and clean-cut's word-density gate then separates them.
const CLEAN_SPEECH_NOISE_DB = -40;
const CLEAN_SPEECH_MIN_SILENCE = 0.4;

// Segment detection parameters. Bumping any of these (or SEGMENT_SCHEMA_VERSION)
// invalidates the per-file detection cache.
const SEGMENT_SCHEMA_VERSION = "1.0";
// segments.json document version (additive v1.1 fields: energy/speech-rate/
// loudness/transcript per file; v1.2 adds the per-segment take-quality layer:
// visual heuristics `luma_mean`/`sharpness`, `clean_fraction`, and the composite
// `strength` block). The CACHE check stays on SEGMENT_SCHEMA_VERSION — bumping
// that would force a re-run of the expensive scene decode.
const SEGMENTS_DOC_VERSION = "1.2";
const FEATURES_VERSION = 1; // audio_features cache slot version
const SCENE_THRESHOLD = 0.4;
// Adaptive fallback: a long, video-bearing file that yields ZERO cuts at the
// standard threshold is usually soft-cut (slow dissolves/vlog) or a single-shot
// interview — both collapse to one giant silence-only segment, starving the
// storyboarder of clip-level granularity. Retry ONCE at this lower threshold.
const RETRY_SCENE_THRESHOLD = 0.2;
const SCENE_RETRY_MIN_SECONDS = 45; // don't bother retrying short clips
const SILENCE_NOISE_DB = -30;
const SILENCE_MIN_SECONDS = 0.5;
const MIN_SEGMENT_SECONDS = 0.4;
// Scene detection decodes the whole stream, so it is the slowest INSPECT step
// on long/4K sources; give it room. The content-hash cache makes re-runs free.
// These are the FLOOR for short clips; durationAwareTimeout() scales them up for
// long sources (a 44-min HEVC decodes well past a fixed 8-min cap), which is
// what used to make vob_inspect_source time out on 100% of real podcast inputs.
const SCENE_DETECT_TIMEOUT_MS = 8 * 60 * 1000;
const SILENCE_DETECT_TIMEOUT_MS = 5 * 60 * 1000;
const SCENE_DETECT_CEILING_MS = 60 * 60 * 1000;
const SILENCE_DETECT_CEILING_MS = 30 * 60 * 1000;
const AUDIO_EXTRACT_CEILING_MS = 30 * 60 * 1000;
const DETECT_PARAMS = Object.freeze({
  sceneThreshold: SCENE_THRESHOLD,
  retrySceneThreshold: RETRY_SCENE_THRESHOLD,
  noiseDb: SILENCE_NOISE_DB,
  minSilenceSeconds: SILENCE_MIN_SECONDS,
});

const TRANSCRIPT_CACHE_VERSION = "1.0";
const LOW_CONFIDENCE_P = 0.55;
const LOW_CONFIDENCE_MAX = 15;

// Seek-mode auto-detection. Exact input seeks (-ss before -i) are "fast" only
// to the previous keyframe — ffmpeg then DECODES FORWARD to the exact target,
// so per-seek cost is ~one GOP decode. Dense GOPs (≤ the threshold) keep that
// bounded; on sparse-GOP heavy sources (long-GOP HEVC interviews) every seek
// silently decodes many seconds of high-bitrate video and the whole grid
// degenerates into the full-stream decode the seek rework was meant to kill.
// Files probed above the threshold switch to keyframe-aligned seeks
// (-noaccurate_seek: emit the seek-landing keyframe, exactly one decoded frame
// per extract) — drift is bounded by the GOP and reported, never silent.
const THUMB_SEEK_GOP_THRESHOLD_SECONDS = 4;
// Short files can't accumulate a pathological decode-forward bill; skip the
// probe and keep exact seeks (bit-identical to prior behavior).
const THUMB_SEEK_PROBE_MIN_DURATION_SECONDS = 60;

function nowIso() {
  return new Date().toISOString();
}

// A timeout that grows with source duration. Long sources (31–44 min HEVC, the
// real inputs) decode far slower than the short-clip baseline, so a fixed cap
// guarantees a timeout. We scale by `perSecondMs` of source (a generous
// multiple of expected decode time), floored at `baseMs`, capped at `ceilingMs`,
// and fully overridable via `envVar` (a positive-int ms value).
function durationAwareTimeout({ baseMs, durationSeconds, perSecondMs, ceilingMs, envVar }) {
  const override = Number.parseInt((process.env[envVar] || "").trim(), 10);
  if (Number.isInteger(override) && override > 0) return override;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return baseMs;
  return Math.min(ceilingMs, Math.max(baseMs, Math.round(durationSeconds * perSecondMs)));
}

function envPositiveIntMs(envVar, fallbackMs) {
  const override = Number.parseInt((process.env[envVar] || "").trim(), 10);
  return Number.isInteger(override) && override > 0 ? override : fallbackMs;
}

function pickSampleThumbs(thumbPaths, targetCount = DEFAULT_SAMPLE_THUMB_COUNT) {
  if (!Array.isArray(thumbPaths) || thumbPaths.length === 0) return [];
  if (thumbPaths.length <= targetCount) return thumbPaths.slice();
  const picks = new Set();
  for (let i = 0; i < targetCount; i += 1) {
    const idx = Math.round((i * (thumbPaths.length - 1)) / (targetCount - 1));
    picks.add(idx);
  }
  return Array.from(picks).sort((a, b) => a - b).map((i) => thumbPaths[i]);
}

// Resolve exact-vs-keyframe seeking for a file's single-frame extracts (grid
// thumbs AND segment keyframes — both share the pathology). The probe is
// demux-only (packet key flags over a few sampled windows, no decoding), so it
// costs seconds where the wrong mode costs tens of minutes. Probe failure on a
// long source picks keyframe mode: an unprobeable file is the last place to
// bet on accurate decode-forward, and keyframe seeks are the cheap-safe side.
// VOB_THUMB_SEEK_MODE=exact|keyframe forces one mode for every file.
function resolveThumbSeekMode({ sourcePath, durationSeconds }) {
  const knob = (process.env.VOB_THUMB_SEEK_MODE || "").trim().toLowerCase();
  if (knob === "exact" || knob === "keyframe") {
    return { mode: knob, est_gop_seconds: null, source: "env" };
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < THUMB_SEEK_PROBE_MIN_DURATION_SECONDS) {
    return { mode: "exact", est_gop_seconds: null, source: "short_source" };
  }
  let probe = null;
  try {
    probe = probeKeyframeInterval(sourcePath, { durationSeconds });
  } catch {
    probe = null;
  }
  if (!probe) {
    return { mode: "keyframe", est_gop_seconds: null, source: "probe_failed" };
  }
  if (probe.sparse || (Number.isFinite(probe.est_gop_seconds) && probe.est_gop_seconds > THUMB_SEEK_GOP_THRESHOLD_SECONDS)) {
    return { mode: "keyframe", est_gop_seconds: probe.est_gop_seconds, source: "probe" };
  }
  return { mode: "exact", est_gop_seconds: probe.est_gop_seconds, source: "probe" };
}

function clearInspectDir(projectId) {
  const dir = inspectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(inspectThumbsDir(projectId), { recursive: true });
}

// Seek-based thumbnail extraction: one input-side -ss single-frame extract per
// grid point (the extractSegmentKeyframes pattern) instead of a single
// fps=1/N pass. The fps filter decodes EVERY frame regardless of interval, so
// on long/high-bitrate sources (18-min 35Mbps HEVC) it outruns any sane
// timeout; per-seek cost is ~one GOP decode, making the pass O(grid size).
//
// Numbering is GRID-TRUE: frame_K is always source second (K-1)*interval — the
// storyboarder's cut-point math and the image2 contact-sheet reads both depend
// on it. A failed/skipped slot is filled with a copy of the nearest successful
// frame (stand-in) so the sequence stays contiguous without shifting later
// frames; stand-in slots are reported, never silent.
//
// seekMode "exact" decodes from the previous keyframe to the precise grid
// second (default; frame_K shows EXACTLY second (K-1)*interval). "keyframe"
// adds -noaccurate_seek so each extract emits the seek-landing keyframe — one
// decoded frame regardless of GOP length, at the cost of frame_K showing the
// nearest keyframe AT/BEFORE its grid second (drift ≤ one GOP; the caller
// reports it). The grid timestamps themselves never move in either mode.
//
// Never throws — failures degrade to warnings at the caller (INSPECT's real
// payload is digest/segments/transcripts; triage images must not abort it).
async function extractThumbnailsForFile({ projectId, fileIndex, sourcePath, intervalSeconds, durationSeconds = null, seekMode = "exact" }) {
  const result = { paths: [], attempted: 0, failed: 0, skipped: 0, standins: [], truncated: 0, noDuration: false, mode: seekMode };
  const fileSubdir = path.join(inspectThumbsDir(projectId), `file_${fileIndex}`);
  try {
    fs.mkdirSync(fileSubdir, { recursive: true });
  } catch {
    result.attempted = 1;
    result.failed = 1;
    return result;
  }

  // Timestamp grid: k*interval, clamped strictly inside the stream (a seek at
  // or past the last frame yields zero output). Unknown duration -> single
  // t=0 attempt.
  const grid = [];
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const limit = Math.max(0, durationSeconds - 0.1);
    const fullCount = Math.max(1, Math.floor(limit / intervalSeconds) + 1);
    const gridCount = Math.min(fullCount, MAX_THUMBS_PER_FILE);
    result.truncated = fullCount - gridCount;
    for (let k = 0; k < gridCount; k += 1) grid.push(k * intervalSeconds);
  } else {
    grid.push(0);
    result.noDuration = true;
  }
  result.attempted = grid.length;

  const seekTimeoutMs = envPositiveIntMs("VOB_THUMB_SEEK_TIMEOUT_MS", THUMB_SEEK_TIMEOUT_MS);
  // Soft pass deadline (same scaling the old single-pass timeout used): past
  // it, remaining seeks are skipped instead of the whole INSPECT throwing.
  const passDeadlineMs = durationAwareTimeout({
    baseMs: THUMB_TIMEOUT_MS,
    durationSeconds,
    perSecondMs: 500,
    ceilingMs: SCENE_DETECT_CEILING_MS,
    envVar: "VOB_THUMB_TIMEOUT_MS",
  });
  const startedAt = Date.now();
  let failureCount = 0;

  // Single-frame decodes are far lighter than the heavy-encode tier; pool size
  // is the host-profile thumb_concurrency (RAM default 2–4, tunable up on big
  // hosts via .vob-config/host.json / VOB_THUMB_CONCURRENCY).
  const concurrency = thumbConcurrency();
  // Keyframe mode needs BOTH halves: -noaccurate_seek (input) emits from the
  // seek-landing keyframe instead of decode-discarding up to the target, and
  // -fps_mode passthrough (output) stops the sync layer from DROPPING those
  // pre-target frames — without it ffmpeg silently decodes forward to the
  // target anyway and writes the exact frame, costing the full GOP decode the
  // mode exists to avoid (measured: ~6x on a 20s-GOP 35Mbps HEVC, worse as
  // GOPs grow).
  const seekInputArgs = seekMode === "keyframe" ? ["-noaccurate_seek"] : [];
  const seekOutputArgs = seekMode === "keyframe" ? ["-fps_mode", "passthrough"] : [];
  const outcomes = await mapWithConcurrency(grid, concurrency, async (t, k) => {
    if (failureCount >= THUMB_FAILURE_BAIL || Date.now() - startedAt > passDeadlineMs) {
      return { ok: false, skipped: true };
    }
    const tmpPath = path.join(fileSubdir, `t_${k}.tmp.jpg`);
    let r = null;
    try {
      // scale=480:-2 + q4: thumbs are orientation/triage frames, not
      // classification evidence — ~10× smaller than full-res q3.
      r = await runFfmpegBlocking(
        [
          "-y",
          ...inputAutorotateArgs(),
          ...seekInputArgs,
          "-ss", String(t),
          "-i", sourcePath,
          "-frames:v", "1",
          ...seekOutputArgs,
          "-vf", "scale=480:-2",
          "-q:v", "4",
          "-update", "1",
          tmpPath,
        ],
        { timeoutMs: seekTimeoutMs },
      );
    } catch {
      r = null;
    }
    // exit 0 with no output file is real (seek past the video stream's last
    // frame inside a longer container, attached_pic-only streams) — existsSync
    // is part of the success predicate, like extractSegmentKeyframes.
    if (r && !r.timed_out && r.exit_code === 0 && fs.existsSync(tmpPath)) {
      return { ok: true, tmpPath };
    }
    failureCount += 1;
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort tmp cleanup */ }
    return { ok: false, skipped: false };
  });

  const successKs = [];
  for (let k = 0; k < outcomes.length; k += 1) {
    const o = outcomes[k];
    if (o && o.ok) successKs.push(k);
    else if (o && o.skipped) result.skipped += 1;
  }
  result.failed = grid.length - successKs.length - result.skipped;
  if (successKs.length === 0) return result;

  const frameName = (k) => `frame_${String(k + 1).padStart(4, "0")}.jpg`;
  // successKs ascends, so on equidistant ties the previous neighbor wins (the
  // frame more likely still on screen at the missing slot's timestamp).
  const nearestSuccess = (k) => {
    let best = successKs[0];
    for (const s of successKs) {
      if (Math.abs(s - k) < Math.abs(best - k)) best = s;
    }
    return best;
  };
  const successSet = new Set(successKs);
  for (const k of successKs) {
    fs.renameSync(path.join(fileSubdir, `t_${k}.tmp.jpg`), path.join(fileSubdir, frameName(k)));
  }
  for (let k = 0; k < grid.length; k += 1) {
    const finalPath = path.join(fileSubdir, frameName(k));
    if (successSet.has(k)) {
      result.paths.push(finalPath);
      continue;
    }
    try {
      fs.copyFileSync(path.join(fileSubdir, frameName(nearestSuccess(k))), finalPath);
      result.standins.push(k + 1); // 1-based, matching frame_%04d names
      result.paths.push(finalPath);
    } catch {
      // Disk-level copy failure leaves a numbering hole; the contact-sheet
      // build for this file will degrade and warn (it reads sequentially).
    }
  }
  return result;
}

// Build one or more contact sheets for a file's thumbs, chunked at ≤40 cells
// each in frame order. A single chunk keeps the v1 name (back-compat); multiple
// chunks write contact_sheet_file_<i>_<k>.jpg. Returns all sheet paths.
async function buildContactSheets({ projectId, fileIndex, thumbCount }) {
  if (thumbCount <= 0) return [];
  const chunkCount = Math.ceil(thumbCount / CONTACT_SHEET_MAX_CELLS);
  const pattern = path.join(inspectThumbsDir(projectId), `file_${fileIndex}`, "frame_%04d.jpg");
  const outPaths = [];
  for (let k = 0; k < chunkCount; k += 1) {
    const cells = Math.min(CONTACT_SHEET_MAX_CELLS, thumbCount - k * CONTACT_SHEET_MAX_CELLS);
    const cols = Math.min(CONTACT_SHEET_COLS, cells);
    const rows = Math.ceil(cells / cols);
    const outPath = chunkCount === 1
      ? inspectContactSheetPath(projectId, fileIndex)
      : path.join(inspectDir(projectId), `contact_sheet_file_${fileIndex}_${k}.jpg`);
    // image2 sequence with -start_number selects the chunk; -frames:v 1 after
    // tile stops once the chunk's grid is filled.
    const result = await runFfmpegBlocking(
      [
        "-y",
        "-start_number", String(1 + k * CONTACT_SHEET_MAX_CELLS),
        "-i", pattern,
        "-vf", `scale=${CONTACT_SHEET_CELL_WIDTH}:-1,tile=${cols}x${rows}`,
        "-frames:v", "1",
        "-q:v", "3",
        outPath,
      ],
      { timeoutMs: CONTACT_SHEET_TIMEOUT_MS },
    );
    if (result.timed_out) {
      throw new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `ffmpeg contact sheet build timed out for file_${fileIndex}`,
        { stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
      );
    }
    if (result.exit_code !== 0 || !fs.existsSync(outPath)) {
      const stderrPreview = (result.stderr || "").trim().slice(0, 2000) || null;
      throw new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `ffmpeg contact sheet build failed (exit ${result.exit_code}) for file_${fileIndex}`,
        { exit_code: result.exit_code, stderr_preview: stderrPreview },
      );
    }
    outPaths.push(outPath);
  }
  return outPaths;
}

async function extractAudio({ sourcePath, outPath, durationSeconds = null }) {
  const timeoutMs = durationAwareTimeout({
    baseMs: AUDIO_TIMEOUT_MS,
    durationSeconds,
    perSecondMs: 200,
    ceilingMs: AUDIO_EXTRACT_CEILING_MS,
    envVar: "VOB_AUDIO_EXTRACT_TIMEOUT_MS",
  });
  const result = await runFfmpegBlocking(
    [
      "-y",
      "-i", sourcePath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-acodec", "pcm_s16le",
      outPath,
    ],
    { timeoutMs },
  );
  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg audio extraction timed out for ${sourcePath}`,
      { stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }
  if (result.exit_code !== 0 || !fs.existsSync(outPath)) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 2000) || null;
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg audio extraction failed (exit ${result.exit_code}) for ${sourcePath}`,
      { exit_code: result.exit_code, stderr_preview: stderrPreview },
    );
  }
}

// Transcribe via the pluggable ASR backend (faster-whisper / openai-whisper /
// hyperframes), which writes the canonical [{text,start,end,p?}] transcript to
// expectedTranscriptPath and falls through backends on failure. This is what
// keeps transcription alive on hosts where hyperframes' whisper-cpp is absent.
async function transcribeAudio({ audioPath, inspectDirAbs, expectedTranscriptPath, durationSeconds = null }) {
  const res = await asrTranscribe({
    audioPath,
    outPath: expectedTranscriptPath,
    projectDir: inspectDirAbs,
    durationSeconds,
  });
  if (res.ok) {
    return { ok: true, word_count: res.word_count || 0, backend: res.backend, language: res.language || null, aligned: res.aligned === true, attempts: res.attempts || [] };
  }
  return { ok: false, reason: res.reason || "transcription_failed", attempts: res.attempts || [] };
}

// --- Transcript cache (content-hash keyed, session root) ---------------------

// Keyed by manifest file.hash + the resolved ASR params (backend/model/language)
// that determine transcript CONTENT. Lives at transcript_cache/ next to
// segment_cache/ so it survives clearInspectDir. Stores SUCCESSES only.
function readTranscriptCache(projectId, hash, params) {
  if (typeof hash !== "string" || !hash) return null;
  let cachePath;
  try { cachePath = transcriptCachePath(projectId, hash); } catch { return null; }
  if (!fs.existsSync(cachePath)) return null;
  let doc;
  try { doc = readJsonFile(cachePath); } catch { return null; }
  if (!doc || doc.schema_version !== TRANSCRIPT_CACHE_VERSION) return null;
  const p = doc.params || {};
  if (p.backend !== params.backend || p.model !== params.model || p.language !== params.language) return null;
  // `align` keys karaoke-grade timing: a cache written before alignment was
  // available (p.align undefined → false) is NOT served when alignment is now
  // wanted (params.align true). Missing == false keeps pre-v3.2 caches valid
  // when no alignment backend is present.
  if ((p.align === true) !== (params.align === true)) return null;
  if (!Array.isArray(doc.words)) return null;
  return {
    words: doc.words,
    word_count: Number.isFinite(doc.word_count) ? doc.word_count : doc.words.length,
    backend_used: doc.backend_used || null,
    // The DETECTED language (distinct from params.language, the configured one) —
    // surfaced so cache hits stay language-aware for hook scoring.
    language: typeof doc.detected_language === "string" ? doc.detected_language : null,
    aligned: doc.aligned === true,
  };
}

function writeTranscriptCache(projectId, hash, params, words, backendUsed, aligned, detectedLanguage) {
  if (typeof hash !== "string" || !hash || !Array.isArray(words)) return;
  let cachePath;
  try { cachePath = transcriptCachePath(projectId, hash); } catch { return; }
  fs.mkdirSync(transcriptCacheDir(projectId), { recursive: true });
  // words stored COMPACT (no indent) — a 6k-word transcript ≈ 350KB.
  writeFileAtomic(cachePath, `${JSON.stringify({
    schema_version: TRANSCRIPT_CACHE_VERSION,
    file_hash: hash,
    params,
    backend_used: backendUsed || null,
    detected_language: typeof detectedLanguage === "string" ? detectedLanguage : null,
    aligned: aligned === true,
    word_count: words.length,
    words,
    created_at: nowIso(),
  })}\n`);
}

// --- Segment detection (cached by manifest file content hash) --------------

// The cache lives at the SESSION ROOT (segment_cache/<hash>.json), NOT under
// inspect/, so it survives clearInspectDir between runs. A cache hit reuses the
// raw scene cuts + silence intervals (the expensive ffmpeg passes) when the
// file content and detector params are unchanged.
function readDetectionCache(projectId, hash) {
  if (typeof hash !== "string" || !hash) return null;
  let cachePath;
  try { cachePath = segmentCachePath(projectId, hash); } catch { return null; }
  if (!fs.existsSync(cachePath)) return null;
  let doc;
  try { doc = readJsonFile(cachePath); } catch { return null; }
  if (!doc || doc.schema_version !== SEGMENT_SCHEMA_VERSION) return null;
  const p = doc.params || {};
  if (
    p.sceneThreshold !== DETECT_PARAMS.sceneThreshold
    || p.retrySceneThreshold !== DETECT_PARAMS.retrySceneThreshold
    || p.noiseDb !== DETECT_PARAMS.noiseDb
    || p.minSilenceSeconds !== DETECT_PARAMS.minSilenceSeconds
  ) return null;
  if (!Array.isArray(doc.scene_cuts) || !Array.isArray(doc.silences)) return null;
  // scene_detected records whether scene_cuts is AUTHORITATIVE (the pass actually
  // ran) vs. an empty placeholder from a skip_scene_detection run. Old caches
  // (predating the field) were always full detections -> treat missing as true.
  // scene_detection_basis records HOW the cuts were obtained (scene / retry /
  // single-shot) so the storyboarder knows the clip granularity it's working with.
  // audio_features passes through untouched; the features_version check happens
  // at the call site (a v1 cache lacking it stays valid for silences/scenes).
  return {
    scene_cuts: doc.scene_cuts,
    silences: doc.silences,
    scene_detected: doc.scene_detected !== false,
    scene_detection_basis: typeof doc.scene_detection_basis === "string" ? doc.scene_detection_basis : null,
    audio_features: doc.audio_features || null,
  };
}

function writeDetectionCache(projectId, hash, sceneCuts, silences, sceneDetected, audioFeatures, sceneBasis) {
  if (typeof hash !== "string" || !hash) return;
  let cachePath;
  try { cachePath = segmentCachePath(projectId, hash); } catch { return; }
  fs.mkdirSync(segmentCacheDir(projectId), { recursive: true });
  writeFileAtomic(cachePath, `${JSON.stringify({
    schema_version: SEGMENT_SCHEMA_VERSION,
    file_hash: hash,
    params: DETECT_PARAMS,
    scene_cuts: sceneCuts,
    scene_detected: sceneDetected === true,
    scene_detection_basis: typeof sceneBasis === "string" ? sceneBasis : null,
    silences,
    audio_features: audioFeatures
      ? {
        features_version: FEATURES_VERSION,
        window_seconds: 0.5,
        loudness: audioFeatures.loudness || null,
        energy_windows: audioFeatures.energy_windows || [],
      }
      : null,
    detected_at: nowIso(),
  }, null, 2)}\n`);
}

// Split each manifest file into segments (the unit of classification/editing):
// scene-cut + silence detection (cached) -> buildSegments -> transcript overlap
// + energy aggregates -> representative keyframes -> contact strips. Returns a
// per-file summary + roll-up counts + strip legend entries.
async function segmentSourceFiles({ projectId, manifest, transcriptsByFile, skipSceneDetection = false, seekModeByFile = new Map(), cleanByFile = null }) {
  const fileSummaries = [];
  const stripEntries = [];
  const featuresByFile = new Map();
  let totalSegments = 0;
  let totalKeyframes = 0;
  let truncatedKeyframes = 0;
  let stripFailures = 0;
  let visualScored = 0;
  let visualFailed = 0;
  let visualBackend = null;
  let faceBackend = null;

  for (let i = 0; i < manifest.files.length; i += 1) {
    const file = manifest.files[i];
    if (!file || typeof file.path !== "string") continue;
    const duration = Number(file.duration_seconds);
    const hasVideo = file.has_video === true || Number(file.video_streams) > 0;
    const hasAudio = file.has_audio === true || Number(file.audio_streams) > 0;

    if (!Number.isFinite(duration) || duration <= 0) {
      fileSummaries.push({
        file_index: i, path: file.path, duration_seconds: null,
        prior: file.prior || null, has_video: hasVideo, has_audio: hasAudio,
        segment_count: 0, segments: [], skipped_reason: "no_duration",
      });
      continue;
    }

    // Scene cuts + silences are cached together by content hash, but tracked
    // independently: an audio-only file has no scenes (sceneDetected starts
    // true), and a skip_scene_detection run caches its silences WITHOUT claiming
    // scene detection happened — so a later full run reuses the cached silences
    // and only re-runs the (expensive) scene decode, never trusting a skipped
    // scene_cuts:[] as authoritative.
    let sceneCuts = [];
    let silences = [];
    let sceneDetected = !hasVideo;
    // How the cuts were obtained, surfaced to the storyboarder so it knows the
    // clip granularity it has: audio_only | scene | low_threshold_retry |
    // single_shot | silence_only | detect_failed | skipped | cached.
    let sceneBasis = hasVideo ? null : "audio_only";
    const cached = readDetectionCache(projectId, file.hash);
    if (cached && cached.scene_detected) {
      sceneCuts = cached.scene_cuts;
      sceneDetected = true;
      sceneBasis = cached.scene_detection_basis || "cached";
    }

    if (hasVideo && !skipSceneDetection && !sceneDetected) {
      const sceneTimeoutMs = durationAwareTimeout({
        baseMs: SCENE_DETECT_TIMEOUT_MS, durationSeconds: duration,
        perSecondMs: 500, ceilingMs: SCENE_DETECT_CEILING_MS,
        envVar: "VOB_SCENE_DETECT_TIMEOUT_MS",
      });
      const sc = await detectSceneChanges(file.path, { threshold: SCENE_THRESHOLD, timeoutMs: sceneTimeoutMs });
      if (!sc.ok) {
        sceneCuts = [];
        sceneBasis = "detect_failed";
      } else if (sc.cuts.length > 0) {
        sceneCuts = sc.cuts;
        sceneBasis = "scene";
      } else if (duration >= SCENE_RETRY_MIN_SECONDS) {
        // Zero cuts on a long file: retry once at the lower threshold before
        // accepting silence-only segmentation.
        const rc = await detectSceneChanges(file.path, { threshold: RETRY_SCENE_THRESHOLD, timeoutMs: sceneTimeoutMs });
        if (rc.ok && rc.cuts.length > 0) {
          sceneCuts = rc.cuts;
          sceneBasis = "low_threshold_retry";
        } else {
          // rc.ok + 0 cuts = genuinely single-shot (silence-only segmentation);
          // rc not-ok = the retry itself failed/timed out (the primary already
          // found 0), so the basis is detect_failed, not a successful "scene".
          sceneCuts = [];
          sceneBasis = rc.ok ? "single_shot" : "detect_failed";
        }
      } else {
        // Short clip with no cuts — silence/whole-clip segmentation is expected.
        sceneCuts = [];
        sceneBasis = "silence_only";
      }
      sceneDetected = true;
    } else if (hasVideo && skipSceneDetection && !sceneDetected) {
      sceneBasis = "skipped";
    }

    // Audio pass: a v1 cache hit that lacks features re-runs the (cheap, audio-
    // only) pass to add them, while still honoring cached scene authority. The
    // scene decode is never re-run because of features.
    let audioFeatures = null;
    const cachedHasFeatures = Boolean(cached && cached.audio_features
      && cached.audio_features.features_version === FEATURES_VERSION);
    if (hasAudio && (!cached || !cachedHasFeatures)) {
      fs.mkdirSync(inspectAudioFeaturesDir(projectId), { recursive: true });
      const silenceTimeoutMs = durationAwareTimeout({
        baseMs: SILENCE_DETECT_TIMEOUT_MS, durationSeconds: duration,
        perSecondMs: 150, ceilingMs: SILENCE_DETECT_CEILING_MS,
        envVar: "VOB_SILENCE_DETECT_TIMEOUT_MS",
      });
      const sd = await detectSilences(file.path, {
        noiseDb: SILENCE_NOISE_DB, minSilenceSeconds: SILENCE_MIN_SECONDS,
        durationSeconds: duration, timeoutMs: silenceTimeoutMs,
        features: {
          energyLogPath: inspectEnergyLogPath(projectId, i),
          stderrLogPath: inspectFeaturesStderrLogPath(projectId, i),
        },
      });
      silences = sd.ok ? sd.silences : (cached ? cached.silences : []);
      audioFeatures = sd.features || null;
    } else if (cached) {
      silences = cached.silences;
      audioFeatures = cachedHasFeatures ? cached.audio_features : null;
    }
    if (audioFeatures) {
      featuresByFile.set(i, {
        loudness: audioFeatures.loudness || null,
        energy_windows: audioFeatures.energy_windows || [],
        window_seconds: audioFeatures.window_seconds || 0.5,
      });
    }

    // Persist when there's something new to store: a first detection, an
    // upgrade from "scenes skipped" to "scenes detected", or fresh features.
    if (!cached || (sceneDetected && !cached.scene_detected) || (audioFeatures && !cachedHasFeatures)) {
      writeDetectionCache(projectId, file.hash, sceneCuts, silences, sceneDetected, audioFeatures, sceneBasis);
    }

    let segments = buildSegments({
      fileIndex: i, durationSeconds: duration,
      sceneCuts, silences, minSegmentSeconds: MIN_SEGMENT_SECONDS,
    });
    // Per-file transcripts: EVERY speech-bearing file gets real overlap fields,
    // not just the winner (the old single-transcript gate left multi-file
    // B-roll speech invisible to classification).
    segments = attachTranscriptOverlap(segments, transcriptsByFile.get(i) || null);
    segments = attachAudioFeatures(
      segments,
      audioFeatures ? audioFeatures.energy_windows : null,
      0.5,
      audioFeatures && audioFeatures.loudness ? audioFeatures.loudness.lufs_integrated : null,
    );
    const kf = await extractSegmentKeyframes({
      projectId,
      fileIndex: i,
      sourcePath: file.path,
      hasVideo,
      segments,
      seekMode: (seekModeByFile.get(i) || {}).mode === "keyframe" ? "keyframe" : "exact",
    });
    segments = kf.segments;
    totalKeyframes += kf.extracted;
    truncatedKeyframes += kf.truncated;
    totalSegments += segments.length;

    // Take-quality layer (v3.9): cheap visual heuristics on the already-extracted
    // keyframes (exposure + sharpness — no video re-decode), per-segment
    // cleanliness from the winner file's clean-cut removed spans, then a composite
    // per-segment `strength` score so the storyboarder can pick the BEST take of a
    // moment, not just a spoken one. All degrade-don't-die: any missing input →
    // null fields, never aborts INSPECT.
    const vq = await attachVisualFeatures(segments, { hasVideo });
    segments = vq.segments;
    visualScored += vq.scored;
    visualFailed += vq.failed;
    if (vq.backend) visualBackend = vq.backend;
    // Optional face-presence (pluggable; degrades to face:null when no backend).
    const fq = await attachFaceFeatures(segments, { hasVideo });
    segments = fq.segments;
    if (fq.backend) faceBackend = fq.backend;
    const removedForFile = cleanByFile && cleanByFile.file_index === i ? cleanByFile.removed : null;
    segments = attachCleanliness(segments, removedForFile);
    segments = attachTakeStrength(segments);

    const strips = hasVideo
      ? await buildSegmentStrips({ projectId, fileIndex: i, segments })
      : { strips: [], failed: 0 };
    stripEntries.push(...strips.strips);
    stripFailures += strips.failed;

    fileSummaries.push({
      file_index: i,
      path: file.path,
      duration_seconds: duration,
      prior: file.prior || null,
      has_video: hasVideo,
      has_audio: hasAudio,
      scene_cut_count: sceneCuts.length,
      scene_detection_basis: sceneBasis,
      silence_count: silences.length,
      segment_count: segments.length,
      loudness: audioFeatures ? audioFeatures.loudness || null : null,
      energy_window_seconds: audioFeatures ? 0.5 : null,
      transcript_path: transcriptsByFile.has(i) ? inspectFileTranscriptPath(projectId, i) : null,
      transcript_word_count: transcriptsByFile.has(i) ? transcriptsByFile.get(i).length : 0,
      segments,
    });
  }

  return {
    fileSummaries,
    totalSegments,
    totalKeyframes,
    truncatedKeyframes,
    stripEntries,
    stripFailures,
    featuresByFile,
    visualScored,
    visualFailed,
    visualBackend,
    faceBackend,
  };
}

// Distinct low-ASR-confidence words (likely caption misspellings: names, jargon)
// for the digest's caption-risk section. Empty when the backend emits no `p`.
function collectLowConfidenceWords(words) {
  const out = [];
  const seen = new Set();
  for (const w of Array.isArray(words) ? words : []) {
    if (!w || typeof w.text !== "string" || typeof w.p !== "number" || !(w.p < LOW_CONFIDENCE_P)) continue;
    const stripped = w.text.replace(/[^\p{L}\p{N}']/gu, "");
    if (stripped.length < 3) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: w.text.trim(), at_seconds: Number.isFinite(w.start) ? +w.start.toFixed(3) : null });
    if (out.length >= LOW_CONFIDENCE_MAX) break;
  }
  return out;
}

// Resolve an audio file's channel count + layout for the analysis pass. Prefers
// the v3.2 enriched manifest detail (audio_streams_detail) but falls back to the
// retained raw ffprobe `probe` (legacy/unchanged manifest entries lack the
// enriched field) so the pass works on any manifest vintage.
function resolveAudioStreamInfo(file) {
  const detail = Array.isArray(file && file.audio_streams_detail) ? file.audio_streams_detail : null;
  if (detail && detail.length > 0) {
    const d = detail[0] || {};
    return {
      channels: Number.isFinite(d.channels) ? d.channels : null,
      channel_layout: typeof d.channel_layout === "string" ? d.channel_layout : null,
    };
  }
  const streams = file && file.probe && Array.isArray(file.probe.streams) ? file.probe.streams : [];
  const a = streams.find((s) => s && s.codec_type === "audio");
  if (a) {
    const ch = Number(a.channels);
    return {
      channels: Number.isFinite(ch) ? ch : null,
      channel_layout: typeof a.channel_layout === "string" ? a.channel_layout : null,
    };
  }
  return { channels: null, channel_layout: null };
}

// v3.2 P2 — per audio file: per-channel loudness/balance/phase analysis on the
// ORIGINAL stream (not the mono ASR downmix), the −14 LUFS normalization
// advisory, and the clean-voice-track hint. Writes inspect/audio_analysis.json
// and returns a compact summary for state/result/digest. Best-effort: a failure
// (or VOB_DISABLE_AUDIO_ANALYSIS) returns null and never aborts INSPECT.
async function runAudioAnalysisPass({ projectId, manifest, audioFileIndices, transcriptsByFile }) {
  if (audioAnalysisDisabled() || !Array.isArray(audioFileIndices) || audioFileIndices.length === 0) {
    return null;
  }
  const workDir = inspectAudioFeaturesDir(projectId);
  try { fs.mkdirSync(workDir, { recursive: true }); } catch { /* best-effort */ }

  const fileResults = [];
  const advisoryEntries = [];
  const cleanEntries = [];
  for (const idx of audioFileIndices) {
    const file = manifest.files[idx];
    if (!file || typeof file.path !== "string") continue;
    const { channels, channel_layout: channelLayout } = resolveAudioStreamInfo(file);
    let analysis;
    try {
      analysis = await analyzeAudioFile(file.path, {
        channels,
        channelLayout,
        durationSeconds: Number(file.duration_seconds),
        fileIndex: idx,
        workDir,
      });
    } catch (error) {
      analysis = { ok: false, path: file.path, reason: error && error.message ? error.message : String(error), notes: [] };
    }
    fileResults.push({ file_index: idx, ...analysis });
    advisoryEntries.push({ file_index: idx, analysis: analysis && analysis.ok ? analysis : null });
    cleanEntries.push({
      file_index: idx,
      analysis: analysis && analysis.ok ? analysis : null,
      prior: file.prior || null,
      word_count: transcriptsByFile.has(idx) ? (transcriptsByFile.get(idx) || []).length : 0,
    });
  }

  const normalization = buildNormalizationAdvisory(advisoryEntries, {
    targetLufs: AUDIO_ANALYSIS_TARGET_LUFS,
    truePeakCeiling: AUDIO_ANALYSIS_TRUE_PEAK_CEILING,
  });
  const cleanAudioSource = pickCleanAudioSource(cleanEntries);

  const analysisPath = inspectAudioAnalysisPath(projectId);
  try {
    writeFileAtomic(analysisPath, `${JSON.stringify({
      schema_version: "1.0",
      project_id: projectId,
      generated_at: nowIso(),
      target_lufs: AUDIO_ANALYSIS_TARGET_LUFS,
      true_peak_ceiling: AUDIO_ANALYSIS_TRUE_PEAK_CEILING,
      files: fileResults,
      normalization,
      clean_audio_source: cleanAudioSource,
    }, null, 2)}\n`);
  } catch { return null; }

  const advByFile = new Map(normalization.files.map((f) => [f.file_index, f]));
  const audioSummary = {
    analysis_path: analysisPath,
    file_count: fileResults.length,
    target_lufs: AUDIO_ANALYSIS_TARGET_LUFS,
    any_clip_risk: normalization.any_clip_risk,
    any_quiet: normalization.any_quiet,
    clean_audio_source_index: cleanAudioSource ? cleanAudioSource.file_index : null,
    files: fileResults.map((f) => {
      const adv = advByFile.get(f.file_index) || null;
      return {
        file_index: f.file_index,
        layout: f.ok ? f.layout : null,
        lufs_integrated: f.ok && f.loudness ? f.loudness.lufs_integrated : null,
        balance: f.ok ? f.balance : null,
        dead_channel: f.ok ? f.dead_channel : null,
        out_of_phase: f.ok ? f.out_of_phase : null,
        gain_to_target_db: adv ? adv.gain_db : null,
        clip_risk: adv ? adv.clip_risk : false,
      };
    }),
  };
  return { analysisPath, audioSummary };
}

async function runInspect({ projectId, manifest, options = {} }) {
  const explicitInterval = Number.isFinite(options.thumb_interval_seconds) && options.thumb_interval_seconds > 0
    ? options.thumb_interval_seconds
    : null;
  const skipTranscription = options.skip_transcription === true;
  const skipSceneDetection = options.skip_scene_detection === true;
  const skipThumbnails = options.skip_thumbnails === true;

  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "manifest has no files to inspect");
  }

  clearInspectDir(projectId);

  // Per-file seek mode for ALL single-frame extracts this run (grid thumbs AND
  // segment keyframes — skip_thumbnails doesn't skip segmentation, so the mode
  // is resolved regardless). Demux-only probe, a few seconds per long file.
  const seekModeByFile = new Map();
  for (let i = 0; i < manifest.files.length; i += 1) {
    const file = manifest.files[i];
    if (!file || typeof file.path !== "string") continue;
    if (!(file.has_video === true || Number(file.video_streams) > 0)) continue;
    const fileDuration = Number(file.duration_seconds);
    seekModeByFile.set(i, resolveThumbSeekMode({
      sourcePath: file.path,
      durationSeconds: Number.isFinite(fileDuration) ? fileDuration : null,
    }));
  }
  const thumbSeekModes = Array.from(seekModeByFile.entries()).map(([fileIndex, m]) => ({
    file_index: fileIndex,
    mode: m.mode,
    est_gop_seconds: m.est_gop_seconds,
  }));

  const inspectRootAbs = inspectDir(projectId);
  const thumbsRootAbs = inspectThumbsDir(projectId);
  const audioAbs = inspectAudioPath(projectId);
  const transcriptAbs = inspectTranscriptPath(projectId);
  const summaryAbs = inspectSummaryPath(projectId);

  // Thumbnails + contact sheets are triage artifacts and must never abort
  // INSPECT (the real payload is digest/segments/transcripts) — every failure
  // here degrades to a warnings[] entry instead of a throw.
  const thumbPaths = [];
  const thumbCountsByFile = new Map();
  const warnings = [];
  let thumbFailedCount = 0;
  let appliedThumbInterval = explicitInterval != null ? explicitInterval : DEFAULT_THUMB_INTERVAL_SECONDS;
  // skip_thumbnails skips the grid + contact sheets ONLY — segment keyframes
  // and strips (the classification basis) still extract below.
  for (let i = 0; !skipThumbnails && i < manifest.files.length; i += 1) {
    const file = manifest.files[i];
    if (!file || typeof file.path !== "string") continue;
    // Audio-only manifest entries (e.g. a narration .wav) have no frames to
    // thumbnail — running ffmpeg's video filter on them used to kill INSPECT.
    const hasVideo = file.has_video === true || Number(file.video_streams) > 0;
    if (!hasVideo) continue;
    const fileDuration = Number(file.duration_seconds);
    const intervalForFile = explicitInterval != null
      ? explicitInterval
      : Math.max(
        DEFAULT_THUMB_INTERVAL_SECONDS,
        Math.ceil((Number.isFinite(fileDuration) ? fileDuration : 0) / MAX_DEFAULT_THUMBS_PER_FILE),
      );
    appliedThumbInterval = Math.max(appliedThumbInterval, intervalForFile);
    const seekInfo = seekModeByFile.get(i) || { mode: "exact", est_gop_seconds: null };
    if (seekInfo.mode === "keyframe") {
      const gopNote = Number.isFinite(seekInfo.est_gop_seconds)
        ? `est. keyframe interval ~${seekInfo.est_gop_seconds}s`
        : "keyframe interval unmeasurable (sparse or probe failed)";
      warnings.push({
        code: "thumbnails_keyframe_mode",
        file_index: i,
        message: `file ${i} uses keyframe-aligned fast seeks (${gopNote}): thumbs are real frames and fine for visual grounding, but frame_K shows the nearest keyframe at/before second (K-1)*interval — treat thumb-derived timestamps as approximate and snap cut points to transcript/silence times`,
      });
    }
    let t;
    try {
      t = await extractThumbnailsForFile({
        projectId,
        fileIndex: i,
        sourcePath: file.path,
        intervalSeconds: intervalForFile,
        durationSeconds: Number.isFinite(fileDuration) ? fileDuration : null,
        seekMode: seekInfo.mode,
      });
    } catch (error) {
      t = { paths: [], attempted: 1, failed: 1, skipped: 0, standins: [], truncated: 0, noDuration: false };
      warnings.push({
        code: "thumbnails_failed",
        file_index: i,
        message: `thumbnail extraction threw for file ${i}: ${error && error.message ? error.message : String(error)}`,
      });
    }
    thumbPaths.push(...t.paths);
    thumbCountsByFile.set(i, t.paths.length);
    thumbFailedCount += t.failed + t.skipped;
    if (t.noDuration) {
      warnings.push({
        code: "thumbnails_no_duration",
        file_index: i,
        message: `file ${i} has no usable duration in the manifest — attempted a single t=0 thumbnail only`,
      });
    }
    if (t.truncated > 0) {
      warnings.push({
        code: "thumbnails_truncated",
        file_index: i,
        message: `thumbnail grid for file ${i} clamped at ${MAX_THUMBS_PER_FILE} (dropped ${t.truncated} slot(s)) — raise thumb_interval_seconds for a sparser grid`,
      });
    }
    if (t.paths.length === 0 && t.attempted > 0) {
      warnings.push({
        code: "thumbnails_failed",
        file_index: i,
        message: `all ${t.attempted} thumbnail seek(s) failed for file ${i} — no thumbs or contact sheet; ground from segment keyframes/strips instead`,
      });
    } else if (t.failed + t.skipped > 0) {
      const standinPreview = t.standins.slice(0, 10).join(", ")
        + (t.standins.length > 10 ? ` (+${t.standins.length - 10} more)` : "");
      warnings.push({
        code: "thumbnails_partial",
        file_index: i,
        message: `${t.failed} thumbnail seek(s) failed${t.skipped > 0 ? ` and ${t.skipped} were skipped (deadline/bail)` : ""} for file ${i}; frame slot(s) [${standinPreview}] are stand-in copies of the nearest extracted frame — frame_K↔timestamp mapping is unchanged`,
      });
    }
  }

  const contactSheetPaths = [];
  for (const [fileIndex, count] of thumbCountsByFile.entries()) {
    if (count <= 0) continue;
    try {
      const sheets = await buildContactSheets({ projectId, fileIndex, thumbCount: count });
      contactSheetPaths.push(...sheets);
    } catch (error) {
      warnings.push({
        code: "contact_sheet_failed",
        file_index: fileIndex,
        message: `contact sheet build failed for file ${fileIndex}: ${error && error.message ? error.message : String(error)} — read individual thumbs or segment strips instead`,
      });
    }
  }

  // Transcribe EVERY audio file (content-hash cached) and keep them all as
  // per-file transcripts; the most-worded file is the narration spine winner.
  // Multi-file shoots often carry ambient audio on B-roll and the real
  // voiceover on a different (e.g. later) clip, so the first audio file is not
  // necessarily the spine. The winner's audio + transcript become the canonical
  // inspect/audio.wav + inspect/transcript.json (back-compat).
  const audioFileIndices = manifest.files
    .map((f, i) => (f && Number(f.audio_streams) > 0 ? i : -1))
    .filter((i) => i >= 0);
  let transcribedFileIndex = -1;
  let audioPresent = false;
  let audioPathOut = null;
  let speechDetected = false;
  let transcriptPathOut = null;
  let wordCount = 0;
  let skippedReason = null;
  let asrBackend = null;
  let asrAttempts = null;
  let winnerLanguage = null; // detected language of the winner transcript (for crosslingual hook scoring)
  let transcriptAligned = false; // winner timing is karaoke-grade (forced-aligned)?
  let transcriptsSummary = [];
  let transcriptCacheHits = 0;
  const transcriptsByFile = new Map(); // idx -> canonical words (ok files only)

  if (audioFileIndices.length === 0) {
    skippedReason = "no_audio_stream";
  } else if (skipTranscription) {
    transcribedFileIndex = audioFileIndices[0];
    await extractAudio({
      sourcePath: manifest.files[transcribedFileIndex].path,
      outPath: audioAbs,
      durationSeconds: Number(manifest.files[transcribedFileIndex].duration_seconds),
    });
    audioPresent = true;
    audioPathOut = audioAbs;
    skippedReason = "user_opt_out";
  } else {
    audioPresent = true;
    const asrParams = resolvedAsrParams();
    fs.mkdirSync(inspectTranscriptsDir(projectId), { recursive: true });
    const tmpRoot = path.join(inspectRootAbs, ".transcribe-tmp");
    const perFile = new Map(); // idx -> { ok, path, words, word_count, backend, from_cache, reason, attempts, wav }
    for (const idx of audioFileIndices) {
      const file = manifest.files[idx];
      const outPath = inspectFileTranscriptPath(projectId, idx);
      const cached = readTranscriptCache(projectId, file.hash, asrParams);
      if (cached) {
        writeFileAtomic(outPath, `${JSON.stringify(cached.words)}\n`);
        perFile.set(idx, {
          ok: true, path: outPath, words: cached.words,
          word_count: cached.word_count, backend: cached.backend_used,
          language: cached.language || null,
          aligned: cached.aligned === true,
          from_cache: true, reason: null, attempts: null, wav: null,
        });
        continue;
      }
      const tmpDir = path.join(tmpRoot, `file_${idx}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpWav = path.join(tmpDir, "audio.wav");
      const fileDuration = Number(file.duration_seconds);
      // One corrupt file must not kill INSPECT for the others: record the
      // failure and let winner selection run over whatever succeeded.
      let tr;
      try {
        await extractAudio({ sourcePath: file.path, outPath: tmpWav, durationSeconds: fileDuration });
        tr = await transcribeAudio({
          audioPath: tmpWav, inspectDirAbs: tmpDir,
          expectedTranscriptPath: outPath, durationSeconds: fileDuration,
        });
      } catch (error) {
        tr = { ok: false, reason: error && error.message ? error.message : "transcription_failed", attempts: null };
      }
      let words = null;
      if (tr.ok) {
        try {
          const w = readJsonFile(outPath);
          if (Array.isArray(w)) words = w;
        } catch { words = null; }
        if (words) writeTranscriptCache(projectId, file.hash, asrParams, words, tr.backend, tr.aligned, tr.language);
      }
      perFile.set(idx, {
        ok: tr.ok && !!words,
        path: tr.ok && words ? outPath : null,
        words,
        word_count: words ? words.length : 0,
        backend: tr.backend || null,
        language: tr.language || null,
        aligned: tr.aligned === true,
        from_cache: false,
        reason: tr.ok ? null : (tr.reason || "transcription_failed"),
        attempts: tr.attempts || null,
        wav: tmpWav,
      });
    }
    for (const [idx, info] of perFile) {
      if (info.ok && Array.isArray(info.words)) transcriptsByFile.set(idx, info.words);
    }
    // Winner: most-worded, FIRST on ties.
    let winnerIdx = audioFileIndices[0];
    for (const idx of audioFileIndices) {
      if ((perFile.get(idx).word_count || 0) > (perFile.get(winnerIdx).word_count || 0)) winnerIdx = idx;
    }
    transcribedFileIndex = winnerIdx;
    const win = perFile.get(winnerIdx);
    asrBackend = win.backend;
    asrAttempts = win.attempts;
    winnerLanguage = win.language || null;
    // audio.wav: copy the winner's temp wav, or (cache hit ⇒ no wav) extract it now.
    if (win.wav && fs.existsSync(win.wav)) {
      try { fs.copyFileSync(win.wav, audioAbs); audioPathOut = audioAbs; } catch { audioPathOut = null; }
    } else {
      try {
        await extractAudio({
          sourcePath: manifest.files[winnerIdx].path,
          outPath: audioAbs,
          durationSeconds: Number(manifest.files[winnerIdx].duration_seconds),
        });
        audioPathOut = audioAbs;
      } catch { audioPathOut = null; }
    }
    if (win.ok) {
      fs.copyFileSync(win.path, transcriptAbs); // canonical inspect/transcript.json (back-compat)
      transcriptPathOut = transcriptAbs;
      wordCount = win.word_count;
      speechDetected = wordCount > 0;
      transcriptAligned = win.aligned === true;
    } else {
      skippedReason = win.reason || "transcription_failed";
    }
    transcriptsSummary = audioFileIndices.map((idx) => {
      const info = perFile.get(idx);
      return {
        file_index: idx,
        path: info.path,
        word_count: info.word_count,
        backend: info.backend,
        aligned: info.aligned === true,
        from_cache: info.from_cache === true,
        reason: info.ok ? null : (info.reason || "transcription_failed"),
      };
    });
    transcriptCacheHits = transcriptsSummary.filter((t) => t.from_cache).length;
    // Per-file transcripts persist; only the temp wavs are removed.
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
  const fileWithAudio = transcribedFileIndex >= 0 ? manifest.files[transcribedFileIndex] : undefined;

  let transcriptSummaryPathOut = null;
  let transcriptParagraphsPathOut = null;
  let paragraphCount = 0;
  let paragraphsOut = [];
  if (transcriptPathOut) {
    try {
      const transcript = JSON.parse(fs.readFileSync(transcriptPathOut, "utf8"));
      const { paragraphs, markdown } = buildTranscriptSummary(transcript, {
        sourceLabel: fileWithAudio ? path.basename(fileWithAudio.path) : "",
      });
      if (paragraphs.length > 0) {
        const mdPath = inspectTranscriptSummaryPath(projectId);
        const jsonPath = inspectTranscriptParagraphsPath(projectId);
        writeFileAtomic(mdPath, markdown);
        writeFileAtomic(jsonPath, `${JSON.stringify(paragraphs, null, 2)}\n`);
        transcriptSummaryPathOut = mdPath;
        transcriptParagraphsPathOut = jsonPath;
        paragraphCount = paragraphs.length;
        paragraphsOut = paragraphs;
      }
    } catch {
      // Best-effort derived artifact. transcript.json remains authoritative
      // for the captions-vs-transcript gate.
    }
  }

  // Clean-speech keep-spans: dead air + fillers removed from the narration spine
  // so the storyboarder can build a filler-free A-roll. Best-effort planning aid
  // (transcript.json stays authoritative). Writes inspect/clean_speech.json with
  // keep_spans (source time) the composer concatenates into one clean spine clip.
  let cleanSpeechPathOut = null;
  let cleanSpeechStatsOut = null;
  let cleanRemovedSpans = null; // winner-file filler/dead-air/flub spans → per-segment cleanliness
  if (transcriptPathOut && transcribedFileIndex >= 0) {
    try {
      const words = readJsonFile(transcriptPathOut);
      const spineDur = fileWithAudio && Number.isFinite(fileWithAudio.duration_seconds) ? fileWithAudio.duration_seconds : null;
      if (Array.isArray(words) && words.length > 0) {
        const cleanSilenceTimeoutMs = durationAwareTimeout({
          baseMs: SILENCE_DETECT_TIMEOUT_MS, durationSeconds: spineDur,
          perSecondMs: 150, ceilingMs: SILENCE_DETECT_CEILING_MS,
          envVar: "VOB_SILENCE_DETECT_TIMEOUT_MS",
        });
        const det = await detectSilences(audioPathOut, { noiseDb: CLEAN_SPEECH_NOISE_DB, minSilenceSeconds: CLEAN_SPEECH_MIN_SILENCE, durationSeconds: spineDur, timeoutMs: cleanSilenceTimeoutMs });
        const clean = computeCleanSpans({ words, durationSeconds: spineDur, silences: (det && det.silences) || [] });
        const outPath = inspectCleanSpeechPath(projectId);
        writeFileAtomic(outPath, `${JSON.stringify({
          schema_version: "1.0",
          project_id: projectId,
          file_index: transcribedFileIndex,
          generated_at: nowIso(),
          params: { noise_db: CLEAN_SPEECH_NOISE_DB, min_silence_seconds: CLEAN_SPEECH_MIN_SILENCE },
          keep_spans: clean.keepSpans,
          removed: clean.removed,
          stats: clean.stats,
        }, null, 2)}\n`);
        cleanSpeechPathOut = outPath;
        cleanSpeechStatsOut = clean.stats;
        cleanRemovedSpans = Array.isArray(clean.removed) ? clean.removed : null;
      }
    } catch {
      // best-effort: clean_speech is an optional planning aid
    }
  }

  // Segment detection: split each file into segments (scene cuts + silence),
  // attach transcript overlap + energy + a representative keyframe per
  // non-silence segment, and write the authoritative inspect/segments.json. The
  // segment is the unit downstream phases (classification, storyboard) consume
  // — not the raw file.
  const segmentation = await segmentSourceFiles({
    projectId, manifest, transcriptsByFile, skipSceneDetection, seekModeByFile,
    cleanByFile: cleanRemovedSpans
      ? { file_index: transcribedFileIndex, removed: cleanRemovedSpans }
      : null,
  });
  // Compact per-source take-quality aggregate (strong/usable/weak counts + the
  // strongest takes) for state/summary/digest. Best-effort: empty when nothing
  // scored. (segments.json already carries the full per-segment `strength`.)
  let takeQuality = null;
  try {
    takeQuality = {
      ...summarizeTakeQuality(segmentation.fileSummaries),
      visual_scored: segmentation.visualScored,
      visual_failed: segmentation.visualFailed,
      visual_backend: segmentation.visualBackend,
      face_backend: segmentation.faceBackend,
    };
  } catch { takeQuality = null; }
  const segmentsPathOut = segmentsPath(projectId);
  writeFileAtomic(segmentsPathOut, `${JSON.stringify({
    schema_version: SEGMENTS_DOC_VERSION,
    project_id: projectId,
    generated_at: nowIso(),
    params: { ...DETECT_PARAMS, minSegmentSeconds: MIN_SEGMENT_SECONDS },
    total_segments: segmentation.totalSegments,
    files: segmentation.fileSummaries,
  }, null, 2)}\n`);

  // Audio analysis (v3.2 P2): per-channel loudness/balance/phase + normalization
  // advisory + clean-track hint on the ORIGINAL audio. Best-effort, never aborts.
  let audioAnalysisPathOut = null;
  let audioSummaryOut = null;
  try {
    const aa = await runAudioAnalysisPass({ projectId, manifest, audioFileIndices, transcriptsByFile });
    if (aa) {
      audioAnalysisPathOut = aa.analysisPath;
      audioSummaryOut = aa.audioSummary;
    }
  } catch {
    // best-effort: audio analysis is an optional planning aid
  }

  // Strip legend: one JSON mapping every strip cell -> {segment, timestamps}.
  // Strip failures are non-fatal (singles fallback); strip_count reflects reality.
  let stripsLegendPathOut = null;
  if (segmentation.stripEntries.length > 0) {
    const legendPath = inspectStripsLegendPath(projectId);
    writeFileAtomic(legendPath, `${JSON.stringify({
      schema_version: "1.0",
      project_id: projectId,
      generated_at: nowIso(),
      cell_width: 512,
      strip_count: segmentation.stripEntries.length,
      strips: segmentation.stripEntries,
    }, null, 2)}\n`);
    stripsLegendPathOut = legendPath;
  }

  // Hook candidates + digest: best-effort derived artifacts (same posture as
  // transcript_summary). The digest renders even with no transcript/scenes —
  // the walker's skip_transcription smoke depends on that.
  const winnerWords = transcriptsByFile.get(transcribedFileIndex) || null;
  const winnerFeatures = segmentation.featuresByFile.get(transcribedFileIndex) || null;
  let hookCandidates = [];
  try {
    hookCandidates = rankHookCandidates({
      words: winnerWords,
      paragraphs: paragraphsOut,
      energyWindows: winnerFeatures ? winnerFeatures.energy_windows : null,
      durationSeconds: fileWithAudio ? Number(fileWithAudio.duration_seconds) : null,
      language: winnerLanguage,
    }) || [];
  } catch { hookCandidates = []; }
  let digestPathOut = null;
  try {
    const digestMarkdown = buildInspectDigest({
      projectId,
      generatedAt: nowIso(),
      manifestFiles: manifest.files,
      fileSummaries: segmentation.fileSummaries,
      transcripts: transcriptsSummary,
      paragraphs: paragraphsOut,
      cleanSpeechStats: cleanSpeechStatsOut,
      hookCandidates,
      strips: {
        stripCount: segmentation.stripEntries.length,
        legendPath: stripsLegendPathOut,
        failures: segmentation.stripFailures,
      },
      thumbs: {
        count: thumbPaths.length,
        failed: thumbFailedCount,
        skipped: skipThumbnails,
        approximate: thumbSeekModes.filter((m) => m.mode === "keyframe"),
      },
      lowConfidenceWords: collectLowConfidenceWords(winnerWords),
      asr: { backend: asrBackend, skippedReason, aligned: transcriptAligned },
      audio: audioSummaryOut,
      sceneDetectionSkipped: skipSceneDetection,
      transcribedFileIndex,
      takeQuality,
    });
    writeFileAtomic(inspectDigestPath(projectId), digestMarkdown);
    digestPathOut = inspectDigestPath(projectId);
  } catch {
    // best-effort derived artifact; digest_path:null signals the miss
  }

  const summary = {
    schema_version: "1.0",
    project_id: projectId,
    generated_at: nowIso(),
    thumb_interval_seconds: appliedThumbInterval,
    thumb_count: thumbPaths.length,
    thumb_failed_count: thumbFailedCount,
    thumbnails_skipped: skipThumbnails,
    thumb_seek_modes: thumbSeekModes,
    thumbs_dir: thumbsRootAbs,
    thumb_paths: thumbPaths,
    sample_thumb_paths: pickSampleThumbs(thumbPaths),
    contact_sheet_paths: contactSheetPaths,
    warnings,
    audio_present: audioPresent,
    audio_path: audioPathOut,
    speech_detected: speechDetected,
    asr_backend: asrBackend,
    asr_attempts: asrAttempts,
    transcript_aligned: transcriptAligned,
    audio_analysis_path: audioAnalysisPathOut,
    audio: audioSummaryOut,
    scene_detection_skipped: skipSceneDetection,
    transcript_path: transcriptPathOut,
    transcript_summary_path: transcriptSummaryPathOut,
    transcript_paragraphs_path: transcriptParagraphsPathOut,
    clean_speech_path: cleanSpeechPathOut,
    clean_speech_stats: cleanSpeechStatsOut,
    digest_path: digestPathOut,
    transcripts: transcriptsSummary,
    transcript_cache_hits: transcriptCacheHits,
    strips_legend_path: stripsLegendPathOut,
    strip_count: segmentation.stripEntries.length,
    strip_failures: segmentation.stripFailures,
    hook_candidates: hookCandidates,
    hook_candidate_count: hookCandidates.length,
    // (v3.9) The file the hook candidates were ranked on — their start/end are in
    // THIS file's source seconds, so the plan-lint hook-grounding check only
    // compares an opening clip drawn from this same file (else it skips).
    transcribed_file_index: transcribedFileIndex,
    paragraph_count: paragraphCount,
    word_count: wordCount,
    segments_path: segmentsPathOut,
    segment_count: segmentation.totalSegments,
    segment_keyframe_count: segmentation.totalKeyframes,
    segment_keyframes_truncated: segmentation.truncatedKeyframes,
    take_quality: takeQuality,
    skipped_reason: skippedReason,
  };

  writeFileAtomic(summaryAbs, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

module.exports = {
  runInspect,
  pickSampleThumbs,
  DEFAULT_THUMB_INTERVAL_SECONDS,
  DEFAULT_SAMPLE_THUMB_COUNT,
};
