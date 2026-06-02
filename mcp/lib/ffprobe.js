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
    has_video: videoStreams.length > 0,
    has_audio: audioStreams.length > 0,
    resolution: width && height ? `${width}x${height}` : null,
    fps: parseFrameRate(frameRateStr),
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
  probeFile,
  summarizeProbe,
};
