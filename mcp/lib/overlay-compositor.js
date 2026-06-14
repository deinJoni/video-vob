"use strict";

// First-class "overlay-over-base" composite via ffmpeg.
//
// WHY THIS IS A SUPPORTED MODE, NOT A WORKAROUND: headless-Chrome continuous
// capture (the hyperframes <video> render path) is fragile on constrained hosts
// — a composition containing <video> elements can die mid-capture ("Target
// closed" / BeginFrame timeouts). The reliable pattern that real jobs fall back
// to is: render the GRAPHICS as a TRANSPARENT overlay (no <video> in the
// composition, captured via the steadier screenshot/alpha path), cut the base
// footage with ffmpeg, then composite overlay-over-base and mux the base audio
// — entirely in ffmpeg, no continuous browser capture. This module makes that
// composite a code-backed operation instead of tribal knowledge.
//
// It is deliberately decoupled from how the overlay was produced (hyperframes
// alpha render, a PNG/WebM sequence, an exported ProRes 4444, etc.) — it takes
// finished files. vob_import_deliverable wires it into the FSM record.

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("./envelope.js");
const { runFfmpegBlocking, inputAutorotateArgs } = require("./ffmpeg-runner.js");
const { stderrTail } = require("./spawn-with-shutdown.js");

const COMPOSITE_TIMEOUT_MS = 30 * 60 * 1000;

// Build the ffmpeg argv for overlay-over-base.
//   base       opaque footage video (the cut spine / A-roll)
//   overlay    video WITH ALPHA (graphics/captions), same dimensions as base
//   out        destination mp4
//   audio      "base" (default, mux base audio) | "none" | <path to audio/video>
//   scaleToBase  scale the overlay to the base resolution before compositing
//   crf, preset  H.264 quality knobs
function buildOverlayCompositeArgv({ base, overlay, out, audio = "base", scaleToBase = false, crf = 18, preset = "medium" }) {
  const argv = ["-y", ...inputAutorotateArgs(), "-i", base, "-i", overlay];
  const audioIsPath = typeof audio === "string" && audio !== "base" && audio !== "none";
  if (audioIsPath) argv.push("-i", audio);

  // Overlay filter. eof_action=pass lets the base continue if the overlay is
  // shorter; format=auto preserves alpha blending.
  const filter = scaleToBase
    ? "[1:v][0:v]scale2ref=w=iw:h=ih[ov][bv];[bv][ov]overlay=format=auto:eof_action=pass[v]"
    : "[0:v][1:v]overlay=format=auto:eof_action=pass[v]";
  argv.push("-filter_complex", filter, "-map", "[v]");

  if (audio === "base") {
    argv.push("-map", "0:a?");
  } else if (audioIsPath) {
    argv.push("-map", "2:a:0?");
  } // "none" => no audio map

  argv.push(
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  );
  if (audio !== "none") {
    argv.push("-c:a", "aac", "-b:a", "192k");
  } else {
    argv.push("-an");
  }
  // NB: no -shortest. The overlay filter (eof_action=pass, base as the main
  // input) already caps the output at the BASE length — keeping the overlay
  // composited for as long as the base runs and passing the base through after
  // a shorter overlay ends. -shortest would instead truncate the deliverable to
  // the shorter input (e.g. a captions overlay that ends before the footage).
  argv.push(out);
  return argv;
}

async function compositeOverlayOverBase({ basePath, overlayPath, outPath, audio = "base", scaleToBase = false, timeoutMs = COMPOSITE_TIMEOUT_MS } = {}) {
  if (typeof basePath !== "string" || !basePath) throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "compositeOverlayOverBase: basePath is required");
  if (typeof overlayPath !== "string" || !overlayPath) throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "compositeOverlayOverBase: overlayPath is required");
  if (typeof outPath !== "string" || !outPath) throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "compositeOverlayOverBase: outPath is required");
  if (!fs.existsSync(basePath)) throw new ToolError(ERROR_CODES.NOT_FOUND, `overlay composite: base not found: ${basePath}`);
  if (!fs.existsSync(overlayPath)) throw new ToolError(ERROR_CODES.NOT_FOUND, `overlay composite: overlay not found: ${overlayPath}`);
  const audioIsPath = typeof audio === "string" && audio !== "base" && audio !== "none";
  if (audioIsPath && !fs.existsSync(audio)) throw new ToolError(ERROR_CODES.NOT_FOUND, `overlay composite: audio source not found: ${audio}`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const argv = buildOverlayCompositeArgv({ base: basePath, overlay: overlayPath, out: outPath, audio, scaleToBase });
  const result = await runFfmpegBlocking(argv, { timeoutMs });
  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `overlay composite timed out after ${Math.round(timeoutMs / 1000)}s`,
      { stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }
  if (result.exit_code !== 0 || !fs.existsSync(outPath)) {
    const stderrPreview = stderrTail(result.stderr, 2000);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `overlay composite failed (exit ${result.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_preview: stderrPreview, argv },
    );
  }
  return { ok: true, out_path: outPath, argv };
}

// --- Subject-compositing backdrop (v3.3) -------------------------------------
//
// Path (b) of subject compositing: a designed backdrop the matted subject sits
// over, generated with ffmpeg from a `design_token` (no synthesized photo/scene —
// just a solid or a 2-stop linear gradient straight off target.design tokens).
// The result is fed to compositeOverlayOverBase as the BASE, the matte .webm as
// the alpha overlay, and the subject's PRE-CUT clip as the audio source:
//
//   const bd = await generateBackdrop({ fill, width, height, durationSeconds, outPath });
//   await compositeOverlayOverBase({ basePath: bd.out_path,
//     overlayPath: mattePath(...), audio: transcodedClipPath(...), scaleToBase: true });
//
// (For a clip_ref / scene_base backdrop, skip generateBackdrop and pass the
// ingested clip's pre-cut path as basePath — clip-over-clip needs no generation.)
// compositeOverlayOverBase already covers the subject composite as-is:
// overlay=format=auto preserves the matte's alpha, and `audio` accepts the
// subject clip's path so the subject's SPEECH wins over a (muted) backdrop.

// Map a design-token fill string to an ffmpeg color (named, or #RRGGBB -> 0xRRGGBB);
// anything unparseable falls back to black (a solid, never a synthesized scene).
function normalizeFfmpegColor(fill) {
  if (typeof fill !== "string" || !fill.trim()) return "black";
  const s = fill.trim();
  if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return `0x${s.slice(1)}`;
  if (/^0x[0-9a-fA-F]{6,8}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `0x${s}`;
  if (/^[a-zA-Z]+$/.test(s)) return s.toLowerCase();
  return "black";
}

// Pull the first two hex stops out of a CSS gradient string for a 2-stop linear
// ffmpeg gradient. Returns [c0, c1] (0xRRGGBB) or null (=> solid).
function extractGradientColors(fill) {
  if (typeof fill !== "string") return null;
  const hexes = fill.match(/#([0-9a-fA-F]{6})/g);
  if (hexes && hexes.length >= 2) return [`0x${hexes[0].slice(1)}`, `0x${hexes[1].slice(1)}`];
  return null;
}

function buildBackdropArgv({ fill, width, height, durationSeconds, fps = 30, out }) {
  const w = Math.max(2, Math.round(Number(width) || 1080));
  const h = Math.max(2, Math.round(Number(height) || 1920));
  const d = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Number(durationSeconds) : 1;
  const r = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  const gradient = extractGradientColors(fill);
  // NB: only the first two color STOPS are honored, and the gradient is always
  // top→bottom — the CSS angle (e.g. "90deg") is ignored. Path (b) backdrops are
  // intentionally simple; for a precise multi-stop / angled gradient, use path (a)
  // (a real CSS background on an HTML/CSS backdrop div).
  const src = gradient
    ? `gradients=s=${w}x${h}:c0=${gradient[0]}:c1=${gradient[1]}:x0=0:y0=0:x1=0:y1=${h}:d=${d}:r=${r}`
    : `color=c=${normalizeFfmpegColor(fill)}:s=${w}x${h}:d=${d}:r=${r}`;
  return [
    "-y",
    "-f", "lavfi",
    "-i", src,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-g", "30",
    "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    out,
  ];
}

async function generateBackdrop({ fill, width, height, durationSeconds, fps = 30, outPath, timeoutMs = COMPOSITE_TIMEOUT_MS } = {}) {
  if (typeof outPath !== "string" || !outPath) throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "generateBackdrop: outPath is required");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const argv = buildBackdropArgv({ fill, width, height, durationSeconds, fps, out: outPath });
  const result = await runFfmpegBlocking(argv, { timeoutMs });
  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `backdrop generation timed out after ${Math.round(timeoutMs / 1000)}s`,
      { stderr_preview: stderrTail(result.stderr, 800) },
    );
  }
  if (result.exit_code !== 0 || !fs.existsSync(outPath)) {
    const stderrPreview = stderrTail(result.stderr, 1200);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `backdrop generation failed (exit ${result.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, stderr_preview: stderrPreview, argv },
    );
  }
  return { ok: true, out_path: outPath, argv };
}

module.exports = {
  COMPOSITE_TIMEOUT_MS,
  buildOverlayCompositeArgv,
  compositeOverlayOverBase,
  buildBackdropArgv,
  generateBackdrop,
};
