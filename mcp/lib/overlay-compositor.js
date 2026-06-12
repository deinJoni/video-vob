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

module.exports = {
  COMPOSITE_TIMEOUT_MS,
  buildOverlayCompositeArgv,
  compositeOverlayOverBase,
};
