"use strict";

const { spawnSync } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { spawnWithShutdown, DEFAULT_MAX_OUTPUT_BYTES } = require("./spawn-with-shutdown.js");

const FFMPEG_INSTALL_HINT =
  "Install ffmpeg (https://ffmpeg.org/download.html) and ensure `ffmpeg` is on PATH. " +
  "macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt-get install ffmpeg`.";

const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
const CLIP_CUT_TIMEOUT_MS = 10 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

function runFfmpegSync(argv, { cwd, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSync(
      "ffmpeg",
      argv,
      {
        encoding: "utf8",
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg invocation failed: ${error.message || String(error)}. ${FFMPEG_INSTALL_HINT}`,
    );
  }

  if (result.error && result.error.code === "ENOENT") {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg not found on PATH. ${FFMPEG_INSTALL_HINT}`,
    );
  }
  if (result.error && result.error.code === "ETIMEDOUT") {
    return {
      ok: false,
      timed_out: true,
      exit_code: null,
      signal: result.signal || "SIGTERM",
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  if (result.error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg invocation failed: ${result.error.message || String(result.error)}. ${FFMPEG_INSTALL_HINT}`,
    );
  }

  return {
    ok: result.status === 0,
    timed_out: false,
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// Some cameras (notably DJI Osmo Pocket / drone clips) write a BOGUS display
// rotation tag (e.g. rotation=-90) into otherwise display-correct footage, so
// ffmpeg's default autorotation double-rotates the picture. Setting
// VOB_DISABLE_AUTOROTATE adds `-noautorotate` to the INPUT side of every video
// decode (must precede `-i`), turning that tribal gotcha into one knob. Left OFF
// by default — flipping it unconditionally would mis-orient legitimately rotated
// phone footage. vob_doctor / INGEST surface a hint when a rotation tag is seen.
function inputAutorotateArgs() {
  const knob = (process.env.VOB_DISABLE_AUTOROTATE || "").trim().toLowerCase();
  if (knob === "1" || knob === "on" || knob === "true" || knob === "yes") {
    return ["-noautorotate"];
  }
  return [];
}

function runFfmpegBlocking(argv, { cwd, timeoutMs = FFMPEG_TIMEOUT_MS, stderrLogPath = null } = {}) {
  return spawnWithShutdown(
    "ffmpeg",
    argv,
    {
      cwd,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stderrLogPath,
      installHint: FFMPEG_INSTALL_HINT,
    },
  );
}

// A per-clip speed multiplier (>1 faster, <1 slow-mo). A positive finite number;
// anything else (absent/0/negative/NaN) means 1 = no change. Kept in lockstep
// with storyboard-schema.js::effectiveClipDuration so the materialized FILE length
// equals the lint's computed output duration: (out-in)/speed.
function normalizeClipSpeed(speed) {
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

// ffmpeg's atempo accepts only 0.5–2.0 per instance, so decompose any positive
// factor into a chain whose product = speed (e.g. 4 → atempo=2,atempo=2 ;
// 0.25 → atempo=0.5,atempo=0.5). atempo preserves pitch — sped-up dialogue stays
// natural, no chipmunk effect.
function atempoChain(speed) {
  const factors = [];
  let remaining = speed;
  while (remaining > 2.0 + 1e-9) { factors.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5 - 1e-9) { factors.push(0.5); remaining /= 0.5; }
  factors.push(Math.round(remaining * 1e6) / 1e6);
  return factors.map((f) => `atempo=${f}`).join(",");
}

// Input-side -ss (fast seek): ffmpeg seeks to the nearest preceding keyframe,
// then decodes-and-DISCARDS up to the exact timestamp — frame-accurate under
// re-encode (the "lands on the previous keyframe" corruption applies only to
// stream-copy, which we never do here). This turns COMPOSE entry on a 30-40 min
// source from O(sum of clip end-times) decode into O(sum of clip durations).
// -t (duration) is used instead of -to because input-side -ss resets the
// timeline to 0 at the seek point.
//
// `speed` (default 1) bakes a constant playback-rate change into the pre-cut clip
// via setpts (video) + atempo (audio): the materialized file's real duration
// becomes (out-in)/speed, so the composer references it unchanged (data-media-start=0,
// data-duration = the shorter file length) and drift verification stays honest.
// CRITICAL: -t must be the POST-speed length — setpts compresses output PTS, and a
// slow-mo (speed<1) clip is LONGER than its raw span, so a raw -t would truncate it.
// speed=1 takes the byte-identical no-filter path, so existing clip caches never churn.
function buildClipCutArgv({ src, out, inSeconds, outSeconds, dropAudio, speed }) {
  const spd = normalizeClipSpeed(speed);
  const applySpeed = Math.abs(spd - 1) > 1e-9;
  const outDuration = (outSeconds - inSeconds) / spd;
  const argv = [
    "-y",
    ...inputAutorotateArgs(),
    "-ss", String(inSeconds),
    "-i", src,
    "-t", outDuration.toFixed(3),
    ...(applySpeed ? ["-filter:v", `setpts=PTS/${spd}`] : []),
    "-c:v", "libx264",
    "-preset", "medium", // was fast — clips are short + sidecar-cached; spend the
    "-crf", "18",        // encode time once. crf 20->18 + medium cuts the double-
                         // generation loss on the A-roll (clip is re-encoded again
                         // by the hyperframes capture).
    // Dense keyframes (~1 per second at 30fps): every output frame is at most a
    // few frames from a keyframe, so headless-Chrome seeks during capture are
    // fast. WITHOUT this the pre-cut defaults to ~8s GOPs; single-track renders
    // survive (one seek/frame) but a B-roll/multi-track cut seeks the spine AND
    // an overlapping cutaway per frame, and on a low-RAM host each seek blows
    // Chrome's 30s protocolTimeout → "BeginFrame auto-worker calibration timed
    // out" → render aborts. Harmless for single-track (just slightly larger files).
    "-g", "30",
    "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  if (dropAudio) {
    argv.push("-an");
  } else {
    if (applySpeed) argv.push("-filter:a", atempoChain(spd));
    argv.push("-c:a", "aac", "-b:a", "192k"); // was 128k — voice intermediate headroom
  }
  argv.push(out);
  return argv;
}

// --- Two-pass loudnorm (PACKAGE) ---------------------------------------------
// Pass 1 measures, pass 2 applies with linear=true (one-pass dynamic loudnorm
// pumps); the video stream is copied untouched. Target: -14 LUFS / -1 dBTP
// (the short-form platform reference level).
const LOUDNORM_TIMEOUT_MS = 10 * 60 * 1000;
const LOUDNORM_TARGET = Object.freeze({ i: -14, tp: -1, lra: 11 });

function buildLoudnormMeasureArgv({ input }) {
  return ["-hide_banner", "-nostats", "-i", input, "-map", "0:a:0",
    "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"];
}

// `measured` fields are the strings parsed from pass 1 (parseLoudnormStats).
function buildLoudnormApplyArgv({ input, output, measured }) {
  const af = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}`
    + `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}`
    + `:offset=${measured.target_offset}:linear=true:print_format=summary`;
  return ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy",
    "-af", af,
    "-c:a", "aac", "-b:a", "256k",
    "-ar", "48000", // loudnorm internally resamples to 192kHz; restore 48k
    "-movflags", "+faststart",
    output];
}

// Parse the JSON block loudnorm prints to stderr: take the substring from the
// LAST "{" preceding the last occurrence of "input_i" to the next balanced "}".
// Returns { input_i, input_tp, input_lra, input_thresh, target_offset } as
// STRINGS (loudnorm emits them quoted), or null on any miss.
function parseLoudnormStats(stderr) {
  const s = typeof stderr === "string" ? stderr : "";
  const keyIndex = s.lastIndexOf('"input_i"');
  if (keyIndex === -1) return null;
  const open = s.lastIndexOf("{", keyIndex);
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(s.slice(open, close + 1));
  } catch {
    return null;
  }
  const out = {};
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (typeof parsed[key] !== "string" || parsed[key] === "") return null;
    out[key] = parsed[key];
  }
  return out;
}

// --- Multi-cell layout composite (split-screen / multi-crop, v3.4) -----------
//
// Composite N already-pre-cut clips into ONE clip at the output dimensions, so a
// split-screen scene (e.g. a 2-up speaker stack) costs a SINGLE <video> element
// in the composition instead of N — keeping the host <video> budget honest AND
// dodging the multi-<video> headless-Chrome render fragility that drove this
// footage off-rails. Each cell is scaled+cropped to COVER its region (no
// letterboxing) unless its `fit` is "contain" (scaled to fit + padded with
// `background`). Audio is taken from one cell (audio_cell — the speaker's a_roll
// clip), mapped optionally so a muted cell doesn't fail the mux.
//
// Layout types (cells are 0-indexed in order):
//   split_vertical    cell0 top / cell1 bottom (the vertical 2-up speaker stack)
//   split_horizontal  cell0 left / cell1 right
//   grid_2x2          cells 0..3 → 2×2 grid (row-major)
//   pip               cell0 full-frame base, cell1 inset (bottom-right)
// An unknown type or an odd cell count falls back to a vertical stack of the
// cells given (deterministic, never throws) — plan-lint already warned.
// Restrict a backdrop color to a safe ffmpeg color token (a name like "black"
// or a #hex), so a layout.background string can never inject filtergraph syntax
// (a comma/colon would otherwise start a new filter). Anything else → "black".
function safeColor(background) {
  return typeof background === "string" && /^#?[0-9A-Za-z]{1,16}$/.test(background) ? background : "black";
}

function cellFilter(idx, w, h, fit, background) {
  const W = Math.round(w);
  const H = Math.round(h);
  if (fit === "contain") {
    return `[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,`
      + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${safeColor(background)},setsar=1[v${idx}]`;
  }
  // cover: fill the region then crop the overflow.
  return `[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v${idx}]`;
}

function buildLayoutCompositeArgv({ inputs, type, outPath, width, height, cells = null, audioCell = 0, background = "black" } = {}) {
  // libx264 + yuv420p require EVEN master dims (an odd dim aborts the encode).
  // Floor to even here too, so a stray odd dimension can never reach the encoder.
  const W = Math.round(width) - (Math.round(width) % 2);
  const H = Math.round(height) - (Math.round(height) % 2);
  const n = Array.isArray(inputs) ? inputs.length : 0;
  const fitOf = (i) => (cells && cells[i] && cells[i].fit === "contain" ? "contain" : "cover");
  const argv = ["-y"];
  for (const inp of inputs) argv.push(...inputAutorotateArgs(), "-i", inp);

  const steps = [];
  let outv = "[outv]";
  if (type === "pip" && n >= 2) {
    const insetW = Math.round(W / 3);
    steps.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base]`);
    steps.push(`[1:v]scale=${insetW}:-2,setsar=1[ins]`);
    steps.push(`[base][ins]overlay=W-w-${Math.round(W * 0.04)}:H-h-${Math.round(H * 0.04)}[outv]`);
  } else if (type === "split_horizontal" && n >= 2) {
    const cw = Math.floor(W / 2);
    steps.push(cellFilter(0, cw, H, fitOf(0), background));
    steps.push(cellFilter(1, cw, H, fitOf(1), background));
    steps.push(`[v0][v1]hstack=inputs=2,scale=${W}:${H},setsar=1[outv]`);
  } else if (type === "grid_2x2" && n >= 4) {
    const cw = Math.floor(W / 2);
    const ch = Math.floor(H / 2);
    for (let i = 0; i < 4; i += 1) steps.push(cellFilter(i, cw, ch, fitOf(i), background));
    steps.push(`[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale=${W}:${H},setsar=1[outv]`);
  } else {
    // split_vertical (and the safe fallback for anything else): stack the cells
    // top-to-bottom, each W × H/count.
    const count = Math.max(2, n);
    const ch = Math.floor(H / count);
    const labels = [];
    for (let i = 0; i < count; i += 1) {
      steps.push(cellFilter(i, W, ch, fitOf(i), background));
      labels.push(`[v${i}]`);
    }
    steps.push(`${labels.join("")}vstack=inputs=${count},scale=${W}:${H},setsar=1[outv]`);
  }

  argv.push("-filter_complex", steps.join(";"));
  argv.push("-map", outv);
  // Audio from the chosen cell (optional: a muted b_roll cell has no audio).
  const aCell = Number.isInteger(audioCell) && audioCell >= 0 && audioCell < n ? audioCell : 0;
  argv.push("-map", `${aCell}:a?`);
  argv.push(
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-g", "30", "-keyint_min", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  );
  return argv;
}

async function compositeLayout({ inputs, type, outPath, width, height, cells = null, audioCell = 0, background = "black", timeoutMs = CLIP_CUT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 2) throw new Error("compositeLayout: need >= 2 input clips");
  if (typeof outPath !== "string" || !outPath) throw new Error("compositeLayout: outPath is required");
  const argv = buildLayoutCompositeArgv({ inputs, type, outPath, width, height, cells, audioCell, background });
  const result = await runFfmpegBlocking(argv, { timeoutMs });
  return { ...result, argv };
}

async function cutClip({ src, out, inSeconds, outSeconds, dropAudio = false, speed = 1, timeoutMs = CLIP_CUT_TIMEOUT_MS } = {}) {
  if (typeof src !== "string" || !src) throw new Error("cutClip: src is required");
  if (typeof out !== "string" || !out) throw new Error("cutClip: out is required");
  if (!Number.isFinite(inSeconds) || inSeconds < 0) throw new Error("cutClip: inSeconds must be >= 0");
  if (!Number.isFinite(outSeconds) || outSeconds <= inSeconds) {
    throw new Error("cutClip: outSeconds must be > inSeconds");
  }
  const argv = buildClipCutArgv({ src, out, inSeconds, outSeconds, dropAudio, speed });
  const result = await runFfmpegBlocking(argv, { timeoutMs });
  return { ...result, argv };
}

function checkFfmpegAvailable({ timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = runFfmpegSync(["-version"], { timeoutMs });
  } catch (error) {
    return { ok: false, version: null, error: error.message || String(error), checked_at: new Date().toISOString() };
  }
  if (result.timed_out) {
    return { ok: false, version: null, error: "preflight timed out", checked_at: new Date().toISOString() };
  }
  if (!result.ok) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 500);
    return {
      ok: false,
      version: null,
      error: stderrPreview || `ffmpeg -version exited with status ${result.exit_code}`,
      checked_at: new Date().toISOString(),
    };
  }
  // ffmpeg banner starts with: "ffmpeg version 6.0 ..."
  const firstLine = (result.stdout || "").split("\n")[0] || "";
  const versionMatch = firstLine.match(/ffmpeg version\s+(\S+)/i);
  return {
    ok: true,
    version: versionMatch ? versionMatch[1] : firstLine.slice(0, 64) || null,
    error: null,
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  FFMPEG_INSTALL_HINT,
  FFMPEG_TIMEOUT_MS,
  CLIP_CUT_TIMEOUT_MS,
  LOUDNORM_TIMEOUT_MS,
  LOUDNORM_TARGET,
  PREFLIGHT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  buildClipCutArgv,
  buildLayoutCompositeArgv,
  buildLoudnormApplyArgv,
  buildLoudnormMeasureArgv,
  checkFfmpegAvailable,
  compositeLayout,
  cutClip,
  inputAutorotateArgs,
  normalizeClipSpeed,
  parseLoudnormStats,
  runFfmpegBlocking,
  runFfmpegSync,
};
