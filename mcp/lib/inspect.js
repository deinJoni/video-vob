"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("./envelope.js");
const { writeFileAtomic, readJsonFile } = require("./storage.js");
const { runFfmpegBlocking } = require("./ffmpeg-runner.js");
const { runHyperframesWithRetry, buildTranscribeArgv } = require("./hyperframes-runner.js");
const {
  inspectAudioPath,
  inspectCleanSpeechPath,
  inspectContactSheetPath,
  inspectDir,
  inspectSummaryPath,
  inspectThumbsDir,
  inspectTranscriptParagraphsPath,
  inspectTranscriptPath,
  inspectTranscriptSummaryPath,
  segmentCacheDir,
  segmentCachePath,
  segmentsPath,
} = require("./paths.js");
const { buildTranscriptSummary } = require("./transcript-summary.js");
const { detectSceneChanges } = require("./scene-detector.js");
const { detectSilences } = require("./silence-detector.js");
const { computeCleanSpans } = require("./clean-cut.js");
const { buildSegments } = require("./segment-model.js");
const { attachTranscriptOverlap, extractSegmentKeyframes } = require("./segment-signals.js");

const THUMB_TIMEOUT_MS = 120 * 1000;
const AUDIO_TIMEOUT_MS = 180 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;
const CONTACT_SHEET_TIMEOUT_MS = 120 * 1000;
const CONTACT_SHEET_COLS = 5;
const CONTACT_SHEET_CELL_WIDTH = 320;
const DEFAULT_THUMB_INTERVAL_SECONDS = 3;
const DEFAULT_SAMPLE_THUMB_COUNT = 7;
// Clean-speech (filler/dead-air) detection uses a quieter silence floor than the
// segmenter (-30dB): at -40dB true dead air and quiet speech both register as
// "silent", and clean-cut's word-density gate then separates them.
const CLEAN_SPEECH_NOISE_DB = -40;
const CLEAN_SPEECH_MIN_SILENCE = 0.4;

// Segment detection parameters. Bumping any of these (or SEGMENT_SCHEMA_VERSION)
// invalidates the per-file detection cache.
const SEGMENT_SCHEMA_VERSION = "1.0";
const SCENE_THRESHOLD = 0.4;
const SILENCE_NOISE_DB = -30;
const SILENCE_MIN_SECONDS = 0.5;
const MIN_SEGMENT_SECONDS = 0.4;
// Scene detection decodes the whole stream, so it is the slowest INSPECT step
// on long/4K sources; give it room. The content-hash cache makes re-runs free.
const SCENE_DETECT_TIMEOUT_MS = 8 * 60 * 1000;
const SILENCE_DETECT_TIMEOUT_MS = 5 * 60 * 1000;
const DETECT_PARAMS = Object.freeze({
  sceneThreshold: SCENE_THRESHOLD,
  noiseDb: SILENCE_NOISE_DB,
  minSilenceSeconds: SILENCE_MIN_SECONDS,
});

function nowIso() {
  return new Date().toISOString();
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

async function extractThumbnailsForFile({ projectId, fileIndex, sourcePath, intervalSeconds }) {
  const thumbsRoot = inspectThumbsDir(projectId);
  const fileSubdir = path.join(thumbsRoot, `file_${fileIndex}`);
  fs.mkdirSync(fileSubdir, { recursive: true });
  const pattern = path.join(fileSubdir, "frame_%04d.jpg");
  const result = await runFfmpegBlocking(
    [
      "-y",
      "-i", sourcePath,
      "-vf", `fps=1/${intervalSeconds}`,
      "-q:v", "3",
      pattern,
    ],
    { timeoutMs: THUMB_TIMEOUT_MS },
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

async function buildContactSheet({ projectId, fileIndex, thumbCount, outPath }) {
  if (thumbCount <= 0) return null;
  const cols = Math.min(CONTACT_SHEET_COLS, thumbCount);
  const rows = Math.ceil(thumbCount / cols);
  const inputGlob = path.join(inspectThumbsDir(projectId), `file_${fileIndex}`, "frame_*.jpg");
  const result = await runFfmpegBlocking(
    [
      "-y",
      "-pattern_type", "glob",
      "-i", inputGlob,
      "-vf", `scale=${CONTACT_SHEET_CELL_WIDTH}:-1,tile=${cols}x${rows}`,
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
  return outPath;
}

async function extractAudio({ sourcePath, outPath }) {
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
    { timeoutMs: AUDIO_TIMEOUT_MS },
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

function parseStdoutJson(stdout) {
  // hyperframes transcribe --json prints a metadata envelope to stdout
  // (e.g. { ok, model, wordCount, durationSeconds, transcriptPath }). The
  // actual transcript file is written separately by hyperframes itself.
  const trimmed = (stdout || "").trim();
  if (!trimmed) return null;
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace === -1) return null;
  try {
    return JSON.parse(trimmed.slice(firstBrace));
  } catch {
    return null;
  }
}

async function transcribeAudio({ audioPath, inspectDirAbs, expectedTranscriptPath }) {
  // -d <inspectDir> tells hyperframes where the project root is; it writes
  // transcript.json into that directory (sibling of audio.wav). --json makes
  // stdout return a metadata envelope rather than the transcript text.
  const result = await runHyperframesWithRetry(
    buildTranscribeArgv({ inspectDirAbs, audioPath }),
    { timeoutMs: TRANSCRIBE_TIMEOUT_MS, captureStdoutViaFile: true, maxAttempts: 2 },
  );
  if (result.timed_out) {
    return { ok: false, reason: "transcription_timeout", stderr: (result.stderr || "").slice(0, 1000) };
  }
  if (result.exit_code !== 0) {
    return {
      ok: false,
      reason: "transcription_failed",
      stderr: (result.stderr || "").slice(0, 2000),
      exit_code: result.exit_code,
    };
  }
  const meta = parseStdoutJson(result.stdout);
  if (!meta || meta.ok === false) {
    return { ok: false, reason: "transcription_unparseable", stdout_preview: (result.stdout || "").slice(0, 500) };
  }
  const wordCount = Number.isFinite(meta.wordCount) ? Number(meta.wordCount) : 0;
  const writtenPath = typeof meta.transcriptPath === "string" && meta.transcriptPath
    ? meta.transcriptPath
    : expectedTranscriptPath;
  if (!fs.existsSync(writtenPath)) {
    return { ok: false, reason: "transcription_file_missing", expected_path: writtenPath };
  }
  if (writtenPath !== expectedTranscriptPath) {
    // Normalize to the canonical inspect/transcript.json path.
    fs.copyFileSync(writtenPath, expectedTranscriptPath);
  }
  return { ok: true, word_count: wordCount };
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
  return { scene_cuts: doc.scene_cuts, silences: doc.silences };
}

function writeDetectionCache(projectId, hash, sceneCuts, silences) {
  if (typeof hash !== "string" || !hash) return;
  let cachePath;
  try { cachePath = segmentCachePath(projectId, hash); } catch { return; }
  fs.mkdirSync(segmentCacheDir(projectId), { recursive: true });
  writeFileAtomic(cachePath, `${JSON.stringify({
    schema_version: SEGMENT_SCHEMA_VERSION,
    file_hash: hash,
    params: DETECT_PARAMS,
    scene_cuts: sceneCuts,
    silences,
    detected_at: nowIso(),
  }, null, 2)}\n`);
}

// Split each manifest file into segments (the unit of classification/editing):
// scene-cut + silence detection (cached) -> buildSegments -> transcript overlap
// -> representative keyframes. Returns a per-file summary + roll-up counts.
async function segmentSourceFiles({ projectId, manifest, transcriptWords, transcribedFileIndex }) {
  const fileSummaries = [];
  let totalSegments = 0;
  let totalKeyframes = 0;
  let truncatedKeyframes = 0;

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

    let sceneCuts = [];
    let silences = [];
    const cached = readDetectionCache(projectId, file.hash);
    if (cached) {
      sceneCuts = cached.scene_cuts;
      silences = cached.silences;
    } else {
      if (hasVideo) {
        const sc = await detectSceneChanges(file.path, { threshold: SCENE_THRESHOLD, timeoutMs: SCENE_DETECT_TIMEOUT_MS });
        sceneCuts = sc.ok ? sc.cuts : [];
      }
      if (hasAudio) {
        const sd = await detectSilences(file.path, {
          noiseDb: SILENCE_NOISE_DB, minSilenceSeconds: SILENCE_MIN_SECONDS,
          durationSeconds: duration, timeoutMs: SILENCE_DETECT_TIMEOUT_MS,
        });
        silences = sd.ok ? sd.silences : [];
      }
      writeDetectionCache(projectId, file.hash, sceneCuts, silences);
    }

    let segments = buildSegments({
      fileIndex: i, durationSeconds: duration,
      sceneCuts, silences, minSegmentSeconds: MIN_SEGMENT_SECONDS,
    });
    // Transcript overlap only maps onto the transcribed file's timeline; other
    // files get empty transcript fields.
    segments = attachTranscriptOverlap(segments, i === transcribedFileIndex ? transcriptWords : null);
    const kf = await extractSegmentKeyframes({ projectId, fileIndex: i, sourcePath: file.path, hasVideo, segments });
    segments = kf.segments;
    totalKeyframes += kf.extracted;
    truncatedKeyframes += kf.truncated;
    totalSegments += segments.length;

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
      segments,
    });
  }

  return { fileSummaries, totalSegments, totalKeyframes, truncatedKeyframes };
}

async function runInspect({ projectId, manifest, options = {} }) {
  const intervalSeconds = Number.isFinite(options.thumb_interval_seconds) && options.thumb_interval_seconds > 0
    ? options.thumb_interval_seconds
    : DEFAULT_THUMB_INTERVAL_SECONDS;
  const skipTranscription = options.skip_transcription === true;

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
  for (let i = 0; i < manifest.files.length; i += 1) {
    const file = manifest.files[i];
    if (!file || typeof file.path !== "string") continue;
    const created = await extractThumbnailsForFile({
      projectId,
      fileIndex: i,
      sourcePath: file.path,
      intervalSeconds,
    });
    thumbPaths.push(...created);
    thumbCountsByFile.set(i, created.length);
  }

  const contactSheetPaths = [];
  for (const [fileIndex, count] of thumbCountsByFile.entries()) {
    if (count <= 0) continue;
    const sheetPath = inspectContactSheetPath(projectId, fileIndex);
    await buildContactSheet({ projectId, fileIndex, thumbCount: count, outPath: sheetPath });
    contactSheetPaths.push(sheetPath);
  }

  // Pick the narration spine: transcribe EVERY audio file and keep the one with
  // the most words. Multi-file shoots often carry ambient audio on B-roll and
  // the real voiceover on a different (e.g. later) clip, so the first audio file
  // is not necessarily the spine. The winner's audio + transcript become the
  // canonical inspect/audio.wav + inspect/transcript.json. Single audio file →
  // the loop runs once (same result as before, just transcribed via a temp dir).
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

  if (audioFileIndices.length === 0) {
    skippedReason = "no_audio_stream";
  } else if (skipTranscription) {
    transcribedFileIndex = audioFileIndices[0];
    await extractAudio({ sourcePath: manifest.files[transcribedFileIndex].path, outPath: audioAbs });
    audioPresent = true;
    audioPathOut = audioAbs;
    skippedReason = "user_opt_out";
  } else {
    audioPresent = true;
    const tmpRoot = path.join(inspectRootAbs, ".transcribe-tmp");
    let best = null;
    for (const idx of audioFileIndices) {
      const tmpDir = path.join(tmpRoot, `file_${idx}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpWav = path.join(tmpDir, "audio.wav");
      const tmpTranscript = path.join(tmpDir, "transcript.json");
      await extractAudio({ sourcePath: manifest.files[idx].path, outPath: tmpWav });
      const tr = await transcribeAudio({ audioPath: tmpWav, inspectDirAbs: tmpDir, expectedTranscriptPath: tmpTranscript });
      const wc = tr.ok ? (tr.word_count || 0) : 0;
      if (!best || wc > best.wordCount) {
        best = { idx, wordCount: wc, ok: tr.ok, reason: tr.reason || null, wav: tmpWav, transcript: tr.ok ? tmpTranscript : null };
      }
    }
    transcribedFileIndex = best.idx;
    try { fs.copyFileSync(best.wav, audioAbs); audioPathOut = audioAbs; } catch { audioPathOut = null; }
    if (best.ok && best.transcript && fs.existsSync(best.transcript)) {
      fs.copyFileSync(best.transcript, transcriptAbs);
      transcriptPathOut = transcriptAbs;
      wordCount = best.wordCount;
      speechDetected = wordCount > 0;
    } else {
      skippedReason = best.reason || "transcription_failed";
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
  const fileWithAudio = transcribedFileIndex >= 0 ? manifest.files[transcribedFileIndex] : undefined;

  let transcriptSummaryPathOut = null;
  let transcriptParagraphsPathOut = null;
  let paragraphCount = 0;
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
  if (transcriptPathOut && transcribedFileIndex >= 0) {
    try {
      const words = readJsonFile(transcriptPathOut);
      const spineDur = fileWithAudio && Number.isFinite(fileWithAudio.duration_seconds) ? fileWithAudio.duration_seconds : null;
      if (Array.isArray(words) && words.length > 0) {
        const det = await detectSilences(audioPathOut, { noiseDb: CLEAN_SPEECH_NOISE_DB, minSilenceSeconds: CLEAN_SPEECH_MIN_SILENCE, durationSeconds: spineDur });
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
      }
    } catch {
      // best-effort: clean_speech is an optional planning aid
    }
  }

  // Segment detection: split each file into segments (scene cuts + silence),
  // attach transcript overlap + a representative keyframe per non-silence
  // segment, and write the authoritative inspect/segments.json. The segment is
  // the unit downstream phases (classification, storyboard) consume — not the
  // raw file.
  let transcriptWords = null;
  if (transcriptPathOut) {
    try {
      const t = readJsonFile(transcriptPathOut);
      if (Array.isArray(t)) transcriptWords = t;
    } catch { transcriptWords = null; }
  }
  const segmentation = await segmentSourceFiles({
    projectId, manifest, transcriptWords, transcribedFileIndex,
  });
  const segmentsPathOut = segmentsPath(projectId);
  writeFileAtomic(segmentsPathOut, `${JSON.stringify({
    schema_version: SEGMENT_SCHEMA_VERSION,
    project_id: projectId,
    generated_at: nowIso(),
    params: { ...DETECT_PARAMS, minSegmentSeconds: MIN_SEGMENT_SECONDS },
    total_segments: segmentation.totalSegments,
    files: segmentation.fileSummaries,
  }, null, 2)}\n`);

  const summary = {
    schema_version: "1.0",
    project_id: projectId,
    generated_at: nowIso(),
    thumb_interval_seconds: intervalSeconds,
    thumb_count: thumbPaths.length,
    thumbs_dir: thumbsRootAbs,
    thumb_paths: thumbPaths,
    sample_thumb_paths: pickSampleThumbs(thumbPaths),
    contact_sheet_paths: contactSheetPaths,
    audio_present: audioPresent,
    audio_path: audioPathOut,
    speech_detected: speechDetected,
    transcript_path: transcriptPathOut,
    transcript_summary_path: transcriptSummaryPathOut,
    transcript_paragraphs_path: transcriptParagraphsPathOut,
    clean_speech_path: cleanSpeechPathOut,
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
