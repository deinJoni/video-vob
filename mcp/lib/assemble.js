"use strict";

// Segment assembly (v3 P2): join rendered segment partials into ONE deliverable
// — ffmpeg concat + boundary transitions + an optional master audio bed —
// entirely in ffmpeg, no browser. Two paths:
//
//   FAST: every boundary is a hard cut and there is no music bed → concat
//   demuxer with STREAM COPY (lossless, near-instant; partials come off the
//   same hyperframes pipeline so codec params match). Falls back to the
//   re-encode path if the copy concat fails.
//
//   RE-ENCODE: concat filter, with `fade` boundaries implemented as a
//   DURATION-PRESERVING dip-to-black (0.25s fade-out on A + 0.25s fade-in on
//   B) rather than xfade — xfade overlaps the inputs and shortens the total,
//   which would poison the drift verification; dip-to-black keeps
//   sum(partials) exact. The music bed is looped to program length, pre-gained,
//   and sidechain-ducked under the program audio (fixed-gain fallback when the
//   duck graph fails).

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("./envelope.js");
const { runFfmpegBlocking } = require("./ffmpeg-runner.js");
const { probeFile, summarizeProbe } = require("./ffprobe.js");
const { stderrTail } = require("./spawn-with-shutdown.js");

const FADE_SECONDS = 0.25;
const DEFAULT_MUSIC_GAIN_DB = -12;
const ASSEMBLE_FLOOR_TIMEOUT_MS = 10 * 60 * 1000;
const ASSEMBLE_PER_SECOND_MS = 4 * 1000;
const ASSEMBLE_CEILING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function assembleTimeoutMs(totalDurationSeconds) {
  if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0) return ASSEMBLE_FLOOR_TIMEOUT_MS;
  return Math.min(
    ASSEMBLE_CEILING_TIMEOUT_MS,
    Math.max(ASSEMBLE_FLOOR_TIMEOUT_MS, Math.round(totalDurationSeconds * ASSEMBLE_PER_SECOND_MS)),
  );
}

// concat demuxer list line: file 'path' with single quotes escaped the ffmpeg
// way ('\'' splice).
function concatListBody(paths) {
  return `${paths.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join("\n")}\n`;
}

function buildCopyConcatArgv({ listPath, outPath }) {
  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
}

// Re-encode graph. partials: [{ mp4_path, duration_seconds, has_audio,
// fade_in, fade_out }] in timeline order.
function buildFilterConcatArgv({ partials, outPath, music = null, duck = true }) {
  const argv = ["-y"];
  for (const p of partials) argv.push("-i", p.mp4_path);
  const musicIndex = partials.length;
  if (music) argv.push("-stream_loop", "-1", "-i", music.path);

  const allAudio = partials.every((p) => p.has_audio);
  const chains = [];
  const concatInputs = [];
  partials.forEach((p, i) => {
    const fades = [];
    if (p.fade_in) fades.push(`fade=t=in:st=0:d=${FADE_SECONDS}`);
    if (p.fade_out && Number.isFinite(p.duration_seconds) && p.duration_seconds > FADE_SECONDS) {
      fades.push(`fade=t=out:st=${(p.duration_seconds - FADE_SECONDS).toFixed(3)}:d=${FADE_SECONDS}`);
    }
    const vops = ["format=yuv420p", "setsar=1", ...fades].join(",");
    chains.push(`[${i}:v]${vops}[v${i}]`);
    concatInputs.push(`[v${i}]`);
    if (allAudio) concatInputs.push(`[${i}:a]`);
  });
  chains.push(`${concatInputs.join("")}concat=n=${partials.length}:v=1:a=${allAudio ? 1 : 0}${allAudio ? "[vcat][acat]" : "[vcat]"}`);

  let audioOutLabel = allAudio ? "[acat]" : null;
  if (music) {
    chains.push(`[${musicIndex}:a]volume=${music.gain_db}dB[mvol]`);
    if (allAudio) {
      if (duck) {
        chains.push("[acat]asplit=2[aprog][akey]");
        chains.push("[mvol][akey]sidechaincompress=threshold=0.02:ratio=12:attack=25:release=400[mduck]");
        chains.push("[aprog][mduck]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]");
      } else {
        chains.push("[acat][mvol]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]");
      }
      audioOutLabel = "[aout]";
    } else {
      audioOutLabel = "[mvol]"; // music is the sole bed; -shortest caps it at video length
    }
  }

  argv.push("-filter_complex", chains.join(";"));
  argv.push("-map", "[vcat]");
  if (audioOutLabel) argv.push("-map", audioOutLabel);
  argv.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  );
  if (audioOutLabel) {
    argv.push("-c:a", "aac", "-b:a", "256k", "-ar", "48000");
  } else {
    argv.push("-an");
  }
  if (music && !allAudio) argv.push("-shortest");
  argv.push(outPath);
  return argv;
}

function probePartial(mp4Path) {
  try {
    const summary = summarizeProbe(mp4Path, probeFile(mp4Path));
    return {
      duration_seconds: Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null,
      has_audio: summary.has_audio === true,
    };
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `assembly: could not probe segment partial ${mp4Path}: ${error.message || String(error)}`,
    );
  }
}

// assembleSegments({ segments, outPath, musicPath, musicGainDb, stderrLogPath })
//   segments: [{ segment_id, mp4_path, transition_out }] in timeline order
// -> { path: "copy"|"filter"|"filter_no_duck", out_path, music, partials }
async function assembleSegments({ segments, outPath, musicPath = null, musicGainDb = null, stderrLogPath = null }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "assembleSegments: segments must be a non-empty ordered array");
  }
  for (const seg of segments) {
    if (!seg || typeof seg.mp4_path !== "string" || !fs.existsSync(seg.mp4_path)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `assembly: segment partial missing on disk: ${seg && seg.segment_id} -> ${seg && seg.mp4_path}`,
      );
    }
  }
  const probed = segments.map((seg) => ({ ...seg, ...probePartial(seg.mp4_path) }));
  const totalSeconds = probed.reduce((acc, p) => acc + (Number.isFinite(p.duration_seconds) ? p.duration_seconds : 0), 0);
  const timeoutMs = assembleTimeoutMs(totalSeconds);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Boundary k sits between partial k and k+1; "fade" there = fade-out on k +
  // fade-in on k+1 (dip-to-black, duration-preserving).
  const partials = probed.map((p, i) => ({
    ...p,
    fade_out: i < probed.length - 1 && p.transition_out === "fade",
    fade_in: i > 0 && probed[i - 1].transition_out === "fade",
  }));
  const anyFade = partials.some((p) => p.fade_in || p.fade_out);
  const music = musicPath
    ? { path: musicPath, gain_db: Number.isFinite(musicGainDb) ? musicGainDb : DEFAULT_MUSIC_GAIN_DB }
    : null;

  if (!anyFade && !music) {
    const listPath = `${outPath}.concat.txt`;
    fs.writeFileSync(listPath, concatListBody(partials.map((p) => p.mp4_path)));
    try {
      const copy = await runFfmpegBlocking(buildCopyConcatArgv({ listPath, outPath }), { timeoutMs, stderrLogPath });
      if (!copy.timed_out && copy.exit_code === 0 && fs.existsSync(outPath)) {
        return { path: "copy", out_path: outPath, music: null, partials, total_input_seconds: totalSeconds };
      }
      // fall through to the re-encode path (mismatched params, odd container...)
    } finally {
      try { fs.rmSync(listPath, { force: true }); } catch {}
    }
  }

  const run = (duck) => runFfmpegBlocking(
    buildFilterConcatArgv({ partials, outPath, music, duck }),
    { timeoutMs, stderrLogPath },
  );
  let result = await run(true);
  let pathTaken = "filter";
  if (music && (result.timed_out || result.exit_code !== 0 || !fs.existsSync(outPath))) {
    // Duck-graph fallback: fixed-gain mix (PRD risk #3 — sidechain quality/
    // availability). Only retried when a music bed was requested.
    result = await run(false);
    pathTaken = "filter_no_duck";
  }
  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `assembly ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`,
      { stderr_preview: stderrTail(result.stderr, 1000), stderr_log_path: stderrLogPath },
    );
  }
  if (result.exit_code !== 0 || !fs.existsSync(outPath)) {
    const stderrPreview = stderrTail(result.stderr, 2000);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `assembly ffmpeg failed (exit ${result.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_preview: stderrPreview, stderr_log_path: stderrLogPath },
    );
  }
  return {
    path: pathTaken,
    out_path: outPath,
    music: music ? { path: music.path, gain_db: music.gain_db, ducked: pathTaken === "filter" } : null,
    partials,
    total_input_seconds: totalSeconds,
  };
}

module.exports = {
  DEFAULT_MUSIC_GAIN_DB,
  FADE_SECONDS,
  assembleSegments,
  assembleTimeoutMs,
  buildCopyConcatArgv,
  buildFilterConcatArgv,
};
