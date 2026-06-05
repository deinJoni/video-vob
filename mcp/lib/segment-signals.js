"use strict";

const fs = require("fs");
const path = require("path");

const { segmentKeyframesDir } = require("./paths.js");
const { runFfmpegBlocking, inputAutorotateArgs } = require("./ffmpeg-runner.js");

const KEYFRAME_TIMEOUT_MS = 60 * 1000;
// Bound the number of ffmpeg single-frame extracts per file. A pathological
// source (hundreds of micro-cuts) shouldn't spawn hundreds of ffmpeg calls;
// excess non-silence segments get keyframe_path:null and the caller logs the
// truncation (no silent capping).
const DEFAULT_MAX_KEYFRAMES = 80;

// --- Pure transcript-span overlap -----------------------------------------

// Words whose [start,end] overlap the segment window [segStart, segEnd).
function wordsInWindow(words, segStart, segEnd) {
  if (!Array.isArray(words)) return [];
  return words.filter(
    (w) => w
      && Number.isFinite(w.start)
      && Number.isFinite(w.end)
      && w.end > segStart
      && w.start < segEnd,
  );
}

// Attach transcript_text / word_count / has_speech to each segment, derived
// from the word-level transcript ({ text, start, end } entries). Pure. Segments
// for a file with no transcript get empty text / zero words / has_speech:false.
function attachTranscriptOverlap(segments, transcriptWords) {
  if (!Array.isArray(segments)) return [];
  return segments.map((seg) => {
    const hits = wordsInWindow(transcriptWords, seg.start_seconds, seg.end_seconds);
    const text = hits
      .map((w) => (typeof w.text === "string" ? w.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      ...seg,
      transcript_text: text,
      word_count: hits.length,
      has_speech: hits.length > 0,
    };
  });
}

// --- Representative keyframes ----------------------------------------------

function midpoint(seg) {
  const m = (Number(seg.start_seconds) + Number(seg.end_seconds)) / 2;
  return Number.isFinite(m) && m >= 0 ? m : Number(seg.start_seconds) || 0;
}

// Extract one representative keyframe (segment midpoint) per NON-silence
// segment for a video-bearing file. Silent segments and audio-only files get
// keyframe_path:null (silence is dropped before storyboard; audio has no
// frames). Input-side -ss makes each extract fast; a representative frame
// doesn't need frame-accurate seeking. Returns the enriched segments plus
// counts so the caller can report any truncation.
async function extractSegmentKeyframes({
  projectId,
  fileIndex,
  sourcePath,
  hasVideo,
  segments,
  maxKeyframes = DEFAULT_MAX_KEYFRAMES,
}) {
  if (!Array.isArray(segments)) return { segments: [], extracted: 0, truncated: 0, failed: 0 };
  if (!hasVideo) {
    return {
      segments: segments.map((seg) => ({ ...seg, keyframe_path: null })),
      extracted: 0,
      truncated: 0,
      failed: 0,
    };
  }

  const dir = path.join(segmentKeyframesDir(projectId), `file_${fileIndex}`);
  fs.mkdirSync(dir, { recursive: true });

  let extracted = 0;
  let truncated = 0;
  let failed = 0;
  const out = [];
  for (const seg of segments) {
    if (seg.is_silence) {
      out.push({ ...seg, keyframe_path: null });
      continue;
    }
    if (extracted >= maxKeyframes) {
      truncated += 1;
      out.push({ ...seg, keyframe_path: null });
      continue;
    }
    const outPath = path.join(dir, `seg_${seg.index}.jpg`);
    const result = await runFfmpegBlocking(
      ["-y", ...inputAutorotateArgs(), "-ss", String(midpoint(seg)), "-i", sourcePath, "-frames:v", "1", "-q:v", "3", outPath],
      { timeoutMs: KEYFRAME_TIMEOUT_MS },
    );
    if (!result.timed_out && result.exit_code === 0 && fs.existsSync(outPath)) {
      extracted += 1;
      out.push({ ...seg, keyframe_path: outPath });
    } else {
      failed += 1;
      out.push({ ...seg, keyframe_path: null });
    }
  }
  return { segments: out, extracted, truncated, failed };
}

module.exports = {
  attachTranscriptOverlap,
  extractSegmentKeyframes,
  wordsInWindow,
  DEFAULT_MAX_KEYFRAMES,
};
