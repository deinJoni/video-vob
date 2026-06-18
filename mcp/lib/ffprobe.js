"use strict";

const { spawnSync } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");

const FFPROBE_INSTALL_HINT =
  "Install ffmpeg (https://ffmpeg.org/download.html) and ensure ffprobe is on PATH. macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt-get install ffmpeg`.";

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_STDERR_PREVIEW = 1000;

function probeFile(filePath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSync(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffprobe invocation failed: ${error.message || String(error)}. ${FFPROBE_INSTALL_HINT}`,
    );
  }

  if (result.error && result.error.code === "ENOENT") {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffprobe not found on PATH. ${FFPROBE_INSTALL_HINT}`,
    );
  }
  if (result.error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffprobe invocation failed: ${result.error.message || String(result.error)}. ${FFPROBE_INSTALL_HINT}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(0, MAX_STDERR_PREVIEW).trim();
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffprobe exited with status ${result.status} for ${filePath}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffprobe output for ${filePath} was not valid JSON: ${error.message || String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffprobe output for ${filePath} was not a JSON object`,
    );
  }

  return parsed;
}

// Parse an ffprobe frame-rate string ("30000/1001", "30/1", "29.97") to a
// number of frames per second, or null if it can't be read.
function parseFrameRate(rateStr) {
  if (typeof rateStr !== "string" || !rateStr.trim()) return null;
  const ratio = rateStr.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (ratio) {
    const num = Number(ratio[1]);
    const den = Number(ratio[2]);
    return den > 0 && Number.isFinite(num) ? num / den : null;
  }
  const flat = Number(rateStr);
  return Number.isFinite(flat) && flat > 0 ? flat : null;
}

// Display rotation, in degrees, from either the legacy `tags.rotate` or the
// newer Display Matrix side data. Cameras like DJI write a bogus rotation tag on
// already-display-correct footage, so surfacing this lets INGEST/doctor warn
// about the autorotate gotcha (see inputAutorotateArgs in ffmpeg-runner.js).
function readRotation(stream) {
  if (!stream || typeof stream !== "object") return 0;
  const tagRotate = stream.tags && stream.tags.rotate != null ? Number(stream.tags.rotate) : null;
  if (Number.isFinite(tagRotate) && tagRotate !== 0) return tagRotate;
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const sd of sideData) {
    if (sd && sd.rotation != null && Number.isFinite(Number(sd.rotation)) && Number(sd.rotation) !== 0) {
      return Number(sd.rotation);
    }
  }
  return 0;
}

// --- Keyframe-density probe ---------------------------------------------------

const KEYFRAME_PROBE_WINDOW_SECONDS = 20;
const KEYFRAME_PROBE_TIMEOUT_MS = 30 * 1000;
// Window starts as fractions of duration. Skipping t=0 matters: -read_intervals
// lands each window on a seek point, so the very first packet of a window is a
// keyframe by construction — only the GAPS between keyframes inside a window
// carry GOP information.
const KEYFRAME_PROBE_WINDOW_STARTS = [0.05, 0.45, 0.85];

// Estimate the video keyframe interval (GOP length, seconds) by demuxing a few
// short windows and reading packet key flags — no decoding, so this stays cheap
// (a few seconds of IO) even on 35Mbps HEVC. Returns:
//   { est_gop_seconds: number|null, sparse: boolean, keyframe_count, packet_count }
// where sparse:true means no two keyframes landed inside any sampled window
// (GOP > window length — only an upper-bound-exceeded signal, no estimate), or
// null when the probe itself failed (spawn error, timeout, zero video packets).
function probeKeyframeInterval(filePath, { durationSeconds, timeoutMs = KEYFRAME_PROBE_TIMEOUT_MS } = {}) {
  if (typeof filePath !== "string" || !filePath) return null;
  const dur = Number(durationSeconds);
  const windowLen = KEYFRAME_PROBE_WINDOW_SECONDS;
  let starts;
  if (Number.isFinite(dur) && dur > windowLen * 2) {
    const maxStart = Math.max(0, dur - windowLen - 0.5);
    const seen = new Set();
    starts = KEYFRAME_PROBE_WINDOW_STARTS
      .map((f) => Math.min(maxStart, Math.round(f * dur)))
      .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  } else {
    starts = [0];
  }
  const intervals = starts.map((s) => `${s}%+${windowLen}`).join(",");

  let result;
  try {
    result = spawnSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,dts_time,flags",
        "-of", "csv=p=0",
        "-read_intervals", intervals,
        filePath,
      ],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;

  let packetCount = 0;
  let keyframeCount = 0;
  const keyTimes = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    packetCount += 1;
    if (!/K/.test(parts[2])) continue;
    keyframeCount += 1;
    const t = Number(parts[0]) || Number(parts[1]); // pts_time, dts_time fallback ("N/A" -> NaN)
    if (Number.isFinite(t)) keyTimes.push(t);
  }
  if (packetCount === 0) return null;

  // Gaps between consecutive keyframes, but only those that fit inside one
  // window — a gap spanning two sampled windows says nothing about the GOP.
  keyTimes.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < keyTimes.length; i += 1) {
    const gap = keyTimes[i] - keyTimes[i - 1];
    if (gap > 0.01 && gap <= windowLen + 1) gaps.push(gap);
  }
  if (gaps.length === 0) {
    return { est_gop_seconds: null, sparse: true, keyframe_count: keyframeCount, packet_count: packetCount };
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return {
    est_gop_seconds: Math.round(median * 100) / 100,
    sparse: false,
    keyframe_count: keyframeCount,
    packet_count: packetCount,
  };
}

// --- Per-still luma stats (auto-QC of snapshot frames) -----------------------

const SIGNALSTATS_TIMEOUT_MS = 15 * 1000;

// Escape a filename for use inside a `-f lavfi -i "movie=<path>,signalstats"`
// filtergraph. `movie=` takes the path as its first arg, so the filtergraph
// metacharacters (`\` `:` `'` `,` `[` `]`) must be backslash-escaped or a path
// containing one would split the graph. Plain paths pass through unchanged.
function escapeLavfiSource(p) {
  return String(p)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// Full-range (0-255) luma min/avg/max for a single still image, via ffprobe's
// lavfi `signalstats` filter. Returns { probed:true, ymin, yavg, ymax } or
// { probed:false, error } — DEGRADES, never throws: auto-QC is advisory and an
// unprobeable frame must not abort the pass. `ymax` is the discriminator for a
// blank/dropped-clip frame (nothing bright rendered → low ymax) vs an
// intentionally dark frame with a bright subject (high ymax).
function signalstatsLuma(filePath, { timeoutMs = SIGNALSTATS_TIMEOUT_MS, seekSeconds = null, crop = null } = {}) {
  if (typeof filePath !== "string" || !filePath) {
    return { probed: false, error: "no path" };
  }
  // Optional seek into the source: `movie=<file>:seek_point=<s>` reads the frame
  // at <s> instead of frame 0 — lets a caller sample luma ACROSS a video (the
  // appended colon is the real option separator; the filename's own colons are
  // escaped by escapeLavfiSource). Default (null) preserves the first-frame
  // behavior every existing caller (still QC) relies on.
  const seekOpt = Number.isFinite(seekSeconds) && seekSeconds > 0 ? `:seek_point=${seekSeconds}` : "";
  // Optional crop to a sub-rectangle BEFORE signalstats, so a caller can read the
  // luma of just one region of the frame (the v3.9.1 caption-contrast check
  // samples the background under the caption safe band). `crop` is
  // {w,h,x,y} in pixels; the colons in `crop=w:h:x:y` are the filter's own arg
  // separators (NOT path separators), so they're appended after escapeLavfiSource.
  // Invalid/zero dims fall through to the whole-frame read. Default (null)
  // preserves the whole-frame behavior every existing caller relies on.
  const cropOpt = (crop
    && Number.isFinite(crop.w) && crop.w > 0
    && Number.isFinite(crop.h) && crop.h > 0
    && Number.isFinite(crop.x) && crop.x >= 0
    && Number.isFinite(crop.y) && crop.y >= 0)
    ? `,crop=${Math.round(crop.w)}:${Math.round(crop.h)}:${Math.round(crop.x)}:${Math.round(crop.y)}`
    : "";
  const argv = [
    "-v", "error",
    "-f", "lavfi",
    "-i", `movie=${escapeLavfiSource(filePath)}${seekOpt}${cropOpt},signalstats`,
    "-show_entries", "frame_tags=lavfi.signalstats.YMIN,lavfi.signalstats.YAVG,lavfi.signalstats.YMAX",
    "-of", "default=noprint_wrappers=1",
  ];
  // When seeking into a video, cap output to ONE frame — otherwise signalstats
  // would emit every frame from the seek to EOF (huge stdout + a full decode).
  // The no-seek still path (single image) is left exactly as it was.
  if (seekOpt) argv.push("-read_intervals", "%+#1");
  let result;
  try {
    result = spawnSync(
      "ffprobe",
      argv,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    return { probed: false, error: error.message || String(error) };
  }
  if (result.error) {
    return { probed: false, error: result.error.message || String(result.error) };
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { probed: false, error: `ffprobe exited with status ${result.status}` };
  }
  // Single still → one frame; .match grabs the first (only) occurrence.
  const read = (re) => {
    const m = result.stdout.match(re);
    return m ? Number(m[1]) : NaN;
  };
  const ymin = read(/lavfi\.signalstats\.YMIN=([\d.]+)/);
  const yavg = read(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  const ymax = read(/lavfi\.signalstats\.YMAX=([\d.]+)/);
  if (![ymin, yavg, ymax].every(Number.isFinite)) {
    return { probed: false, error: "could not parse signalstats luma from ffprobe output" };
  }
  return { probed: true, ymin, yavg, ymax };
}

const VOLUMEDETECT_TIMEOUT_MS = 5 * 60 * 1000;

// Max/mean audio volume (dBFS) over the whole file via ffmpeg volumedetect.
// Audio-only decode (-vn) so it's far cheaper than a video pass. Used to flag a
// SILENT render (a failed audio mux): max_volume at/below the silence floor means
// no audible program even though the file "has audio". NEVER throws — returns
// { measured:false } on any failure (advisory, like signalstatsLuma).
function measureMaxVolumeDb(filePath, { timeoutMs = VOLUMEDETECT_TIMEOUT_MS } = {}) {
  if (typeof filePath !== "string" || !filePath) return { measured: false, error: "no path" };
  let result;
  try {
    result = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-vn", "-i", filePath, "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    return { measured: false, error: error.message || String(error) };
  }
  if (result && result.error) return { measured: false, error: result.error.message || String(result.error) };
  // volumedetect writes to stderr: "[Parsed_volumedetect_0 @ ..] max_volume: -3.2 dB".
  // Match `-inf` too — perfect digital silence (a dead mux) reads as `-inf dB` on
  // some ffmpeg builds, and that's the case the silent-audio flag most needs.
  const text = `${(result && result.stderr) || ""}`;
  const max = text.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
  const mean = text.match(/mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
  if (!max) return { measured: false, error: "could not parse max_volume" };
  const parseDb = (s) => (/inf/i.test(s) ? -Infinity : Number(s));
  return { measured: true, max_volume_db: parseDb(max[1]), mean_volume_db: mean ? parseDb(mean[1]) : null };
}

// Per-audio-stream detail for the v3.2 audio-analysis pass (channels/layout/
// sample rate/bit depth/language). Additive: the scalar `audio_streams` count
// stays for back-compat. bit_depth prefers bits_per_raw_sample (the true source
// depth) over bits_per_sample (0 for compressed codecs).
function summarizeAudioStream(s, index) {
  const channels = Number(s.channels);
  const sampleRate = Number(s.sample_rate);
  const rawDepth = Number(s.bits_per_raw_sample);
  const sampDepth = Number(s.bits_per_sample);
  const lang = s.tags && typeof s.tags === "object" ? (s.tags.language || s.tags.LANGUAGE || null) : null;
  return {
    index: Number.isFinite(Number(s.index)) ? Number(s.index) : index,
    codec: s.codec_name || null,
    channels: Number.isFinite(channels) && channels > 0 ? channels : null,
    channel_layout: typeof s.channel_layout === "string" ? s.channel_layout : null,
    sample_rate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null,
    bit_depth: Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : (Number.isFinite(sampDepth) && sampDepth > 0 ? sampDepth : null),
    language: typeof lang === "string" && lang ? lang : null,
    default: Boolean(s.disposition && s.disposition.default),
  };
}

function summarizeProbe(filePath, probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter(
    (s) => s && s.codec_type === "video" && Number(s.width) > 0 && Number(s.height) > 0,
  );
  const audioStreams = streams.filter((s) => s && s.codec_type === "audio");

  const format = probe.format && typeof probe.format === "object" ? probe.format : {};
  const durationSeconds = Number(format.duration);
  const primary = videoStreams[0];
  const formatName = typeof format.format_name === "string" ? format.format_name : null;
  const width = primary ? Number(primary.width) || null : null;
  const height = primary ? Number(primary.height) || null : null;
  const frameRateStr = primary ? (primary.avg_frame_rate || primary.r_frame_rate || null) : null;
  const rotation = primary ? readRotation(primary) : 0;

  return {
    path: filePath,
    format: formatName,
    // `container`, `resolution`, `fps`, `has_video`, `has_audio` are the
    // spec's manifest-entry fields; `format`/`primary_video` are kept for
    // backward compatibility with the brief/storyboard/composer prose that
    // already reads them.
    container: formatName,
    duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    video_streams: videoStreams.length,
    audio_streams: audioStreams.length,
    audio_streams_detail: audioStreams.map((s, i) => summarizeAudioStream(s, i)),
    has_video: videoStreams.length > 0,
    has_audio: audioStreams.length > 0,
    resolution: width && height ? `${width}x${height}` : null,
    fps: parseFrameRate(frameRateStr),
    rotation,
    has_rotation: Number.isFinite(rotation) && rotation !== 0,
    primary_video: primary
      ? {
          codec: primary.codec_name || null,
          width,
          height,
          frame_rate: frameRateStr,
        }
      : null,
  };
}

module.exports = {
  FFPROBE_INSTALL_HINT,
  measureMaxVolumeDb,
  probeFile,
  probeKeyframeInterval,
  signalstatsLuma,
  summarizeProbe,
};
