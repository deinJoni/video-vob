"use strict";

const fs = require("fs");
const path = require("path");

const { segmentKeyframesDir, inspectStripsDir, inspectStripPath, inspectStripListPath } = require("./paths.js");
const { runFfmpegBlocking, inputAutorotateArgs } = require("./ffmpeg-runner.js");
const { mapWithConcurrency } = require("./concurrency.js");
const { thumbConcurrency } = require("./host-profile.js");

const KEYFRAME_TIMEOUT_MS = 60 * 1000;
// Bound the number of ffmpeg single-frame extracts per file. A pathological
// source (hundreds of micro-cuts) shouldn't spawn hundreds of ffmpeg calls;
// excess non-silence segments get keyframe_path:null and the caller logs the
// truncation (no silent capping).
const DEFAULT_MAX_KEYFRAMES = 80;

// Contact-strip geometry. Cells must stay legible after the vision pipeline's
// ~1.15MP downscale: portrait cells are tall, so 3 cols keeps each cell
// ≥~300px wide; landscape fits 4 cols × 3 rows within the ≤~12-cell budget.
const STRIP_COLS_LANDSCAPE = 4;
const STRIP_COLS_PORTRAIT = 3;
const STRIP_MAX_CELLS_LANDSCAPE = 12;
const STRIP_MAX_CELLS_PORTRAIT = 9;
const STRIP_MIN_CELLS = 2; // <2 keyframes → no strip (read the single)
const STRIP_TIMEOUT_MS = 60 * 1000; // per strip; input is ≤12 small JPEGs

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

// Attach transcript_text / word_count / has_speech / speech_rate_wpm to each
// segment, derived from the word-level transcript ({ text, start, end }
// entries). Pure. Segments for a file with no transcript get empty text / zero
// words / has_speech:false. speech_rate_wpm is words-per-minute over the WHOLE
// segment window — dead air inside the segment lowers it, which is the signal
// (a low-wpm "speech" segment is padded delivery).
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
      speech_rate_wpm: hits.length > 0 && seg.duration_seconds > 0
        ? Math.round((hits.length / seg.duration_seconds) * 60 * 10) / 10
        : null,
    };
  });
}

// Per-segment energy aggregates from 0.5s RMS windows. Pure. A window covers
// [t, t+windowSeconds); it belongs to a segment when its midpoint falls inside
// [start_seconds, end_seconds). Segments with zero windows get nulls.
function attachAudioFeatures(segments, energyWindows, windowSeconds = 0.5) {
  if (!Array.isArray(segments)) return [];
  const windows = Array.isArray(energyWindows)
    ? energyWindows.filter((w) => w && Number.isFinite(w.t) && Number.isFinite(w.rms_db))
    : [];
  return segments.map((seg) => {
    if (windows.length === 0) {
      return { ...seg, energy_rms_db: null, energy_peak_db: null };
    }
    const hits = windows.filter((w) => {
      const mid = w.t + windowSeconds / 2;
      return mid >= seg.start_seconds && mid < seg.end_seconds;
    });
    if (hits.length === 0) {
      return { ...seg, energy_rms_db: null, energy_peak_db: null };
    }
    const mean = hits.reduce((a, w) => a + w.rms_db, 0) / hits.length;
    const peak = hits.reduce((a, w) => Math.max(a, w.rms_db), -Infinity);
    return {
      ...seg,
      energy_rms_db: Math.round(mean * 10) / 10,
      energy_peak_db: Math.round(peak * 10) / 10,
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
// doesn't need frame-accurate seeking — which is also why seekMode:"keyframe"
// (-noaccurate_seek: emit the seek-landing keyframe, decode exactly one frame
// instead of a keyframe-to-midpoint run) is safe here: on the sparse-GOP heavy
// sources where INSPECT chooses it, the accurate decode-forward is what used
// to eat the 60s per-extract budget. Extracts run pooled at the host's
// thumb_concurrency. Returns the enriched segments plus counts so the caller
// can report any truncation.
async function extractSegmentKeyframes({
  projectId,
  fileIndex,
  sourcePath,
  hasVideo,
  segments,
  maxKeyframes = DEFAULT_MAX_KEYFRAMES,
  seekMode = "exact",
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

  // First maxKeyframes non-silence segments get an extraction slot (same
  // first-come cap as the old serial loop); the rest are truncated.
  let truncated = 0;
  const jobs = [];
  const plan = segments.map((seg) => {
    if (seg.is_silence) return { seg, job: null };
    if (jobs.length >= maxKeyframes) {
      truncated += 1;
      return { seg, job: null };
    }
    const job = { seg, outPath: path.join(dir, `seg_${seg.index}.jpg`) };
    jobs.push(job);
    return { seg, job };
  });

  // Keyframe mode needs both halves — -noaccurate_seek (input) AND
  // -fps_mode passthrough (output); without the latter ffmpeg's sync layer
  // drops the pre-target frames and decodes forward anyway (see
  // extractThumbnailsForFile in inspect.js).
  const seekInputArgs = seekMode === "keyframe" ? ["-noaccurate_seek"] : [];
  const seekOutputArgs = seekMode === "keyframe" ? ["-fps_mode", "passthrough"] : [];
  const okByJob = new Map();
  await mapWithConcurrency(jobs, thumbConcurrency(), async (job) => {
    // scale=512:-2: agent-facing classification evidence, downscaled at
    // extraction (full-res frames cost ~2.5–8× the vision tokens for zero
    // signal gain). Human-facing stills (snapshot_keyframes) stay full-res.
    const result = await runFfmpegBlocking(
      ["-y", ...inputAutorotateArgs(), ...seekInputArgs, "-ss", String(midpoint(job.seg)), "-i", sourcePath, "-frames:v", "1", ...seekOutputArgs, "-vf", "scale=512:-2", "-q:v", "3", job.outPath],
      { timeoutMs: KEYFRAME_TIMEOUT_MS },
    );
    okByJob.set(job, !result.timed_out && result.exit_code === 0 && fs.existsSync(job.outPath));
  });

  let extracted = 0;
  let failed = 0;
  const out = plan.map(({ seg, job }) => {
    if (!job) return { ...seg, keyframe_path: null };
    if (okByJob.get(job)) {
      extracted += 1;
      return { ...seg, keyframe_path: job.outPath };
    }
    failed += 1;
    return { ...seg, keyframe_path: null };
  });
  return { segments: out, extracted, truncated, failed };
}

// --- Contact strips ---------------------------------------------------------

function round3(v) {
  return +Number(v).toFixed(3);
}

// Width/height from a JPEG's SOF marker. Zero-dep orientation probe for strip
// layout; null on any parse failure (caller defaults to landscape).
function jpegDimensions(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    // Standalone markers (RSTn, SOI/EOI) carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const size = buf.readUInt16BE(i + 2);
    // SOF0–SOF15 minus the non-frame markers DHT(C4)/JPG(C8)/DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + size;
  }
  return null;
}

/**
 * Tile a file's per-segment keyframes into contact strips (≤ STRIP_MAX_CELLS
 * cells each, STRIP_COLS columns, row-major). Zero-dep: concat demuxer + tile
 * filter. Returns legend entries; never throws on build failure (fallback =
 * inspector reads downscaled singles).
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {number} args.fileIndex
 * @param {Array}  args.segments   enriched segments (post-extractSegmentKeyframes;
 *                                 entries with keyframe_path:null are skipped)
 * @returns {Promise<{strips: object[], failed: number}>}
 */
async function buildSegmentStrips({ projectId, fileIndex, segments }) {
  const cells = (Array.isArray(segments) ? segments : [])
    .filter((s) => s && typeof s.keyframe_path === "string");
  if (cells.length < STRIP_MIN_CELLS) return { strips: [], failed: 0 };

  fs.mkdirSync(inspectStripsDir(projectId), { recursive: true });

  // One orientation per file (cells from the same file share it).
  const dims = jpegDimensions(cells[0].keyframe_path);
  const portrait = Boolean(dims && dims.height > dims.width);
  const maxCells = portrait ? STRIP_MAX_CELLS_PORTRAIT : STRIP_MAX_CELLS_LANDSCAPE;
  const stripCols = portrait ? STRIP_COLS_PORTRAIT : STRIP_COLS_LANDSCAPE;

  const strips = [];
  let failed = 0;
  for (let k = 0; k * maxCells < cells.length; k += 1) {
    const chunk = cells.slice(k * maxCells, (k + 1) * maxCells);
    const listPath = inspectStripListPath(projectId, fileIndex, k);
    const stripPath = inspectStripPath(projectId, fileIndex, k);
    const lines = ["ffconcat version 1.0"];
    for (const seg of chunk) {
      lines.push(`file '${seg.keyframe_path.replace(/'/g, "'\\''")}'`);
    }
    try {
      fs.writeFileSync(listPath, `${lines.join("\n")}\n`);
    } catch {
      failed += 1;
      continue;
    }
    const cols = Math.min(stripCols, chunk.length);
    const rows = Math.ceil(chunk.length / stripCols);
    let result;
    try {
      // No rescale needed — keyframes are already 512w; same file ⇒ same cell
      // size. tile pads a partial last row with black; the legend marks valid cells.
      result = await runFfmpegBlocking(
        ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "3", stripPath],
        { timeoutMs: STRIP_TIMEOUT_MS },
      );
    } catch {
      failed += 1;
      continue;
    }
    if (result.timed_out || result.exit_code !== 0 || !fs.existsSync(stripPath)) {
      failed += 1;
      continue;
    }
    strips.push({
      file_index: fileIndex,
      strip_index: k,
      path: stripPath,
      cols,
      rows,
      cell_count: chunk.length,
      cells: chunk.map((seg, c) => ({
        cell: c, // row-major reading order
        row: Math.floor(c / cols),
        col: c % cols,
        segment_index: seg.index,
        timestamp_seconds: round3(midpoint(seg)),
        start_seconds: round3(seg.start_seconds),
        end_seconds: round3(seg.end_seconds),
      })),
    });
  }
  return { strips, failed };
}

module.exports = {
  attachAudioFeatures,
  attachTranscriptOverlap,
  buildSegmentStrips,
  extractSegmentKeyframes,
  jpegDimensions,
  wordsInWindow,
  DEFAULT_MAX_KEYFRAMES,
};
