"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("./envelope.js");
const { writeFileAtomic } = require("./storage.js");
const { runFfmpegBlocking } = require("./ffmpeg-runner.js");
const { runHyperframesBlocking } = require("./hyperframes-runner.js");
const {
  inspectAudioPath,
  inspectDir,
  inspectSummaryPath,
  inspectThumbsDir,
  inspectTranscriptPath,
} = require("./paths.js");

const THUMB_TIMEOUT_MS = 120 * 1000;
const AUDIO_TIMEOUT_MS = 180 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_THUMB_INTERVAL_SECONDS = 3;

function nowIso() {
  return new Date().toISOString();
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
  const result = await runHyperframesBlocking(
    ["transcribe", "--json", "-d", inspectDirAbs, audioPath],
    { timeoutMs: TRANSCRIBE_TIMEOUT_MS },
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
  }

  const fileWithAudio = manifest.files.find((f) => f && Number(f.audio_streams) > 0);
  let audioPresent = false;
  let audioPathOut = null;
  let speechDetected = false;
  let transcriptPathOut = null;
  let wordCount = 0;
  let skippedReason = null;

  if (fileWithAudio) {
    await extractAudio({ sourcePath: fileWithAudio.path, outPath: audioAbs });
    audioPresent = true;
    audioPathOut = audioAbs;

    if (skipTranscription) {
      skippedReason = "user_opt_out";
    } else {
      const transcribeResult = await transcribeAudio({
        audioPath: audioAbs,
        inspectDirAbs: inspectRootAbs,
        expectedTranscriptPath: transcriptAbs,
      });
      if (transcribeResult.ok) {
        transcriptPathOut = transcriptAbs;
        wordCount = transcribeResult.word_count || 0;
        speechDetected = wordCount > 0;
      } else {
        skippedReason = transcribeResult.reason;
      }
    }
  } else {
    skippedReason = "no_audio_stream";
  }

  const summary = {
    schema_version: "1.0",
    project_id: projectId,
    generated_at: nowIso(),
    thumb_interval_seconds: intervalSeconds,
    thumb_count: thumbPaths.length,
    thumbs_dir: thumbsRootAbs,
    thumb_paths: thumbPaths,
    audio_present: audioPresent,
    audio_path: audioPathOut,
    speech_detected: speechDetected,
    transcript_path: transcriptPathOut,
    word_count: wordCount,
    peaks_seconds: [],
    skipped_reason: skippedReason,
  };

  writeFileAtomic(summaryAbs, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

module.exports = {
  runInspect,
  DEFAULT_THUMB_INTERVAL_SECONDS,
};
