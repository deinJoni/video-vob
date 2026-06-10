"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("./envelope.js");
const { writeFileAtomic, readJsonFile } = require("./storage.js");
const { runFfmpegBlocking, inputAutorotateArgs } = require("./ffmpeg-runner.js");
const { asrTranscribe, resolvedAsrParams } = require("./asr-backend.js");
const {
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
const { computeCleanSpans } = require("./clean-cut.js");
const { buildSegments } = require("./segment-model.js");
const {
  attachAudioFeatures,
  attachTranscriptOverlap,
  buildSegmentStrips,
  extractSegmentKeyframes,
} = require("./segment-signals.js");
const { rankHookCandidates, buildInspectDigest } = require("./inspect-digest.js");

const THUMB_TIMEOUT_MS = 120 * 1000;
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
// loudness/transcript per file). The CACHE check stays on SEGMENT_SCHEMA_VERSION
// — bumping that would force a re-run of the expensive scene decode.
const SEGMENTS_DOC_VERSION = "1.1";
const FEATURES_VERSION = 1; // audio_features cache slot version
const SCENE_THRESHOLD = 0.4;
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
  noiseDb: SILENCE_NOISE_DB,
  minSilenceSeconds: SILENCE_MIN_SECONDS,
});

const TRANSCRIPT_CACHE_VERSION = "1.0";
const LOW_CONFIDENCE_P = 0.55;
const LOW_CONFIDENCE_MAX = 15;

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

function clearInspectDir(projectId) {
  const dir = inspectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(inspectThumbsDir(projectId), { recursive: true });
}

async function extractThumbnailsForFile({ projectId, fileIndex, sourcePath, intervalSeconds, durationSeconds = null }) {
  const thumbsRoot = inspectThumbsDir(projectId);
  const fileSubdir = path.join(thumbsRoot, `file_${fileIndex}`);
  fs.mkdirSync(fileSubdir, { recursive: true });
  const pattern = path.join(fileSubdir, "frame_%04d.jpg");
  // Thumb extraction decodes the whole stream too — scale its timeout like
  // scene detection rather than guaranteeing a timeout on long sources.
  const timeoutMs = durationAwareTimeout({
    baseMs: THUMB_TIMEOUT_MS,
    durationSeconds,
    perSecondMs: 500,
    ceilingMs: SCENE_DETECT_CEILING_MS,
    envVar: "VOB_THUMB_TIMEOUT_MS",
  });
  // scale=480:-2 + q4: thumbs are orientation/triage frames, not classification
  // evidence — ~10× smaller than full-res q3, visually clean at agent scale.
  const result = await runFfmpegBlocking(
    [
      "-y",
      ...inputAutorotateArgs(),
      "-i", sourcePath,
      "-vf", `fps=1/${intervalSeconds},scale=480:-2`,
      "-q:v", "4",
      pattern,
    ],
    { timeoutMs },
  );
  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg thumbnail extraction timed out for ${sourcePath}`,
      { stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 2000) || null;
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg thumbnail extraction failed (exit ${result.exit_code}) for ${sourcePath}`,
      { exit_code: result.exit_code, stderr_preview: stderrPreview },
    );
  }
  const entries = fs.readdirSync(fileSubdir)
    .filter((name) => name.endsWith(".jpg"))
    .sort()
    .map((name) => path.join(fileSubdir, name));
  return entries;
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
    return { ok: true, word_count: res.word_count || 0, backend: res.backend, attempts: res.attempts || [] };
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
  if (!Array.isArray(doc.words)) return null;
  return {
    words: doc.words,
    word_count: Number.isFinite(doc.word_count) ? doc.word_count : doc.words.length,
    backend_used: doc.backend_used || null,
  };
}

function writeTranscriptCache(projectId, hash, params, words, backendUsed) {
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
    || p.noiseDb !== DETECT_PARAMS.noiseDb
    || p.minSilenceSeconds !== DETECT_PARAMS.minSilenceSeconds
  ) return null;
  if (!Array.isArray(doc.scene_cuts) || !Array.isArray(doc.silences)) return null;
  // scene_detected records whether scene_cuts is AUTHORITATIVE (the pass actually
  // ran) vs. an empty placeholder from a skip_scene_detection run. Old caches
  // (predating the field) were always full detections -> treat missing as true.
  // audio_features passes through untouched; the features_version check happens
  // at the call site (a v1 cache lacking it stays valid for silences/scenes).
  return {
    scene_cuts: doc.scene_cuts,
    silences: doc.silences,
    scene_detected: doc.scene_detected !== false,
    audio_features: doc.audio_features || null,
  };
}

function writeDetectionCache(projectId, hash, sceneCuts, silences, sceneDetected, audioFeatures) {
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
async function segmentSourceFiles({ projectId, manifest, transcriptsByFile, skipSceneDetection = false }) {
  const fileSummaries = [];
  const stripEntries = [];
  const featuresByFile = new Map();
  let totalSegments = 0;
  let totalKeyframes = 0;
  let truncatedKeyframes = 0;
  let stripFailures = 0;

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
    const cached = readDetectionCache(projectId, file.hash);
    if (cached && cached.scene_detected) {
      sceneCuts = cached.scene_cuts;
      sceneDetected = true;
    }

    if (hasVideo && !skipSceneDetection && !sceneDetected) {
      const sceneTimeoutMs = durationAwareTimeout({
        baseMs: SCENE_DETECT_TIMEOUT_MS, durationSeconds: duration,
        perSecondMs: 500, ceilingMs: SCENE_DETECT_CEILING_MS,
        envVar: "VOB_SCENE_DETECT_TIMEOUT_MS",
      });
      const sc = await detectSceneChanges(file.path, { threshold: SCENE_THRESHOLD, timeoutMs: sceneTimeoutMs });
      sceneCuts = sc.ok ? sc.cuts : [];
      sceneDetected = true;
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
      writeDetectionCache(projectId, file.hash, sceneCuts, silences, sceneDetected, audioFeatures);
    }

    let segments = buildSegments({
      fileIndex: i, durationSeconds: duration,
      sceneCuts, silences, minSegmentSeconds: MIN_SEGMENT_SECONDS,
    });
    // Per-file transcripts: EVERY speech-bearing file gets real overlap fields,
    // not just the winner (the old single-transcript gate left multi-file
    // B-roll speech invisible to classification).
    segments = attachTranscriptOverlap(segments, transcriptsByFile.get(i) || null);
    segments = attachAudioFeatures(segments, audioFeatures ? audioFeatures.energy_windows : null);
    const kf = await extractSegmentKeyframes({ projectId, fileIndex: i, sourcePath: file.path, hasVideo, segments });
    segments = kf.segments;
    totalKeyframes += kf.extracted;
    truncatedKeyframes += kf.truncated;
    totalSegments += segments.length;

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

async function runInspect({ projectId, manifest, options = {} }) {
  const explicitInterval = Number.isFinite(options.thumb_interval_seconds) && options.thumb_interval_seconds > 0
    ? options.thumb_interval_seconds
    : null;
  const skipTranscription = options.skip_transcription === true;
  const skipSceneDetection = options.skip_scene_detection === true;

  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "manifest has no files to inspect");
  }

  clearInspectDir(projectId);

  const inspectRootAbs = inspectDir(projectId);
  const thumbsRootAbs = inspectThumbsDir(projectId);
  const audioAbs = inspectAudioPath(projectId);
  const transcriptAbs = inspectTranscriptPath(projectId);
  const summaryAbs = inspectSummaryPath(projectId);

  const thumbPaths = [];
  const thumbCountsByFile = new Map();
  let appliedThumbInterval = explicitInterval != null ? explicitInterval : DEFAULT_THUMB_INTERVAL_SECONDS;
  for (let i = 0; i < manifest.files.length; i += 1) {
    const file = manifest.files[i];
    if (!file || typeof file.path !== "string") continue;
    const fileDuration = Number(file.duration_seconds);
    const intervalForFile = explicitInterval != null
      ? explicitInterval
      : Math.max(
        DEFAULT_THUMB_INTERVAL_SECONDS,
        Math.ceil((Number.isFinite(fileDuration) ? fileDuration : 0) / MAX_DEFAULT_THUMBS_PER_FILE),
      );
    appliedThumbInterval = Math.max(appliedThumbInterval, intervalForFile);
    const created = await extractThumbnailsForFile({
      projectId,
      fileIndex: i,
      sourcePath: file.path,
      intervalSeconds: intervalForFile,
      durationSeconds: Number.isFinite(fileDuration) ? fileDuration : null,
    });
    thumbPaths.push(...created);
    thumbCountsByFile.set(i, created.length);
  }

  const contactSheetPaths = [];
  for (const [fileIndex, count] of thumbCountsByFile.entries()) {
    if (count <= 0) continue;
    const sheets = await buildContactSheets({ projectId, fileIndex, thumbCount: count });
    contactSheetPaths.push(...sheets);
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
        if (words) writeTranscriptCache(projectId, file.hash, asrParams, words, tr.backend);
      }
      perFile.set(idx, {
        ok: tr.ok && !!words,
        path: tr.ok && words ? outPath : null,
        words,
        word_count: words ? words.length : 0,
        backend: tr.backend || null,
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
    projectId, manifest, transcriptsByFile, skipSceneDetection,
  });
  const segmentsPathOut = segmentsPath(projectId);
  writeFileAtomic(segmentsPathOut, `${JSON.stringify({
    schema_version: SEGMENTS_DOC_VERSION,
    project_id: projectId,
    generated_at: nowIso(),
    params: { ...DETECT_PARAMS, minSegmentSeconds: MIN_SEGMENT_SECONDS },
    total_segments: segmentation.totalSegments,
    files: segmentation.fileSummaries,
  }, null, 2)}\n`);

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
      lowConfidenceWords: collectLowConfidenceWords(winnerWords),
      asr: { backend: asrBackend, skippedReason },
      sceneDetectionSkipped: skipSceneDetection,
      transcribedFileIndex,
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
    thumbs_dir: thumbsRootAbs,
    thumb_paths: thumbPaths,
    sample_thumb_paths: pickSampleThumbs(thumbPaths),
    contact_sheet_paths: contactSheetPaths,
    audio_present: audioPresent,
    audio_path: audioPathOut,
    speech_detected: speechDetected,
    asr_backend: asrBackend,
    asr_attempts: asrAttempts,
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
    paragraph_count: paragraphCount,
    word_count: wordCount,
    segments_path: segmentsPathOut,
    segment_count: segmentation.totalSegments,
    segment_keyframe_count: segmentation.totalKeyframes,
    segment_keyframes_truncated: segmentation.truncatedKeyframes,
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
