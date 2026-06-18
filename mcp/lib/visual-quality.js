"use strict";

// Cheap per-segment VISUAL quality heuristics (v3.9 — upstream INSPECT signal).
//
// Reads the per-segment keyframes INSPECT ALREADY extracted to disk
// (`inspect/segment_keyframes/file_<i>/seg_<n>.jpg`, 512w) and measures two cheap
// proxies with ffmpeg — exposure (mean luma, `signalstats`) and focus/sharpness
// (`blurdetect`) — in ONE pass per frame. No video re-decode (the frames are tiny
// JPEGs already on disk), so this is near-free relative to the keyframe extraction
// that produced them. The numbers feed `take-quality.js`, which turns them (with
// the audio signals) into a per-segment strength score.
//
// DEGRADES, never throws — the house posture for INSPECT side artifacts:
//   • VOB_VISUAL_QUALITY=off                → skipped, all visual fields null
//   • ffmpeg lacks `blurdetect` (pre-5.0)   → retry signalstats-only; sharpness null
//   • a single frame fails to decode/parse  → that segment's visual fields null
//   • the whole pass blows its deadline     → remaining segments null
// A segment with null visual fields still gets a delivery-only strength score.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runFfmpegBlocking } = require("./ffmpeg-runner.js");
const { escapeFilterPath } = require("./silence-detector.js");
const { mapWithConcurrency } = require("./concurrency.js");
const { thumbConcurrency } = require("./host-profile.js");

const FRAME_TIMEOUT_MS = envPositiveInt("VOB_VISUAL_QUALITY_FRAME_TIMEOUT_MS", 30 * 1000);
// Whole-pass soft deadline (0 = none). Mirrors the thumbnail pass's deadline
// posture so a pathological source can't make the visual pass dominate INSPECT.
const PASS_TIMEOUT_MS = envPositiveInt("VOB_VISUAL_QUALITY_TIMEOUT_MS", 0);

let metaSeq = 0;

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function disabled() {
  const v = String(process.env.VOB_VISUAL_QUALITY || "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "none";
}

function round1(x) { return typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10) / 10 : null; }
function round4(x) { return typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null; }

// Parse the per-frame metadata dump (one frame's worth — these are single-image
// inputs). `metadata=print` emits `lavfi.<key>=<value>` lines.
function parseVisualMeta(text) {
  const num = (re) => {
    const m = String(text || "").match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    blur: num(/lavfi\.blur=([\d.]+)/),
    ymin: num(/lavfi\.signalstats\.YMIN=([\d.]+)/),
    yavg: num(/lavfi\.signalstats\.YAVG=([\d.]+)/),
    ymax: num(/lavfi\.signalstats\.YMAX=([\d.]+)/),
  };
}

const MISSING_FILTER_RE = /No such filter|Unknown filter|Cannot find|blurdetect/i;

// One ffmpeg pass over a single keyframe image. `withBlur` prepends the
// `blurdetect` filter; on a build that lacks it the caller retries without.
async function analyzeOnce(imagePath, withBlur) {
  metaSeq += 1;
  const metaPath = path.join(os.tmpdir(), `vob-vq-${process.pid}-${metaSeq}.txt`);
  const chain = `${withBlur ? "blurdetect," : ""}signalstats,metadata=mode=print:file=${escapeFilterPath(metaPath)}`;
  let result;
  try {
    result = await runFfmpegBlocking(
      ["-y", "-an", "-i", imagePath, "-vf", chain, "-frames:v", "1", "-f", "null", "-"],
      { timeoutMs: FRAME_TIMEOUT_MS },
    );
  } catch (error) {
    // runFfmpegBlocking can THROW (ENOENT, a non-timeout spawn error) after ffmpeg
    // already created the metadata dump — clean it up before bailing so the throw
    // path doesn't leak a /tmp file.
    try { fs.unlinkSync(metaPath); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  }
  let text = "";
  try { text = fs.readFileSync(metaPath, "utf8"); } catch { /* metadata file may be absent on failure */ }
  try { fs.unlinkSync(metaPath); } catch { /* best-effort cleanup */ }

  if (result.timed_out) return { ok: false, reason: "timeout" };
  const failed = result.exit_code !== 0;
  if (withBlur && failed && (!text || MISSING_FILTER_RE.test(String(result.stderr || "")))) {
    return { ok: false, missingFilter: true, reason: "blurdetect_unavailable" };
  }
  const meta = parseVisualMeta(text);
  if (!Number.isFinite(meta.yavg)) return { ok: false, reason: failed ? "ffmpeg_failed" : "parse_failed" };

  return {
    ok: true,
    luma_mean: round1(meta.yavg),
    luma_min: Number.isFinite(meta.ymin) ? meta.ymin : null,
    luma_max: Number.isFinite(meta.ymax) ? meta.ymax : null,
    sharpness: Number.isFinite(meta.blur) ? round4(1 / (1 + meta.blur)) : null,
    visual_basis: Number.isFinite(meta.blur) ? "blurdetect" : "exposure_only",
  };
}

// Analyze one keyframe, degrading from blurdetect → exposure-only if the filter
// is unavailable on this ffmpeg build.
async function analyzeKeyframeImage(imagePath) {
  if (typeof imagePath !== "string" || imagePath === "") return { ok: false, reason: "no_path" };
  if (!fs.existsSync(imagePath)) return { ok: false, reason: "missing_file" };
  let r = await analyzeOnce(imagePath, true);
  if (!r.ok && r.missingFilter) r = await analyzeOnce(imagePath, false);
  return r;
}

function withNullVisual(seg) {
  return { ...seg, luma_mean: null, sharpness: null, visual_basis: null };
}

// Attach `luma_mean` / `sharpness` / `visual_basis` to every non-silence segment
// that has a keyframe on disk, by analyzing that keyframe. Returns the enriched
// segments plus counts. Pooled at the host's thumb concurrency; honors the
// optional whole-pass deadline. Degrades the whole pass to null-visual on any
// systemic failure (disabled, no video, no keyframes).
async function attachVisualFeatures(segments, { hasVideo = true } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  if (disabled() || !hasVideo) {
    return { segments: segs.map(withNullVisual), scored: 0, failed: 0, backend: null };
  }
  const jobs = [];
  segs.forEach((seg, i) => {
    if (seg && !seg.is_silence && typeof seg.keyframe_path === "string") jobs.push({ seg, i });
  });
  if (jobs.length === 0) {
    return { segments: segs.map(withNullVisual), scored: 0, failed: 0, backend: null };
  }

  const deadline = PASS_TIMEOUT_MS > 0 ? Date.now() + PASS_TIMEOUT_MS : null;
  const byIndex = new Map();
  let scored = 0;
  let failed = 0;
  let sawBlur = false;
  let sawExposureOnly = false;

  await mapWithConcurrency(jobs, thumbConcurrency(), async (job) => {
    if (deadline != null && Date.now() > deadline) { failed += 1; return; }
    const r = await analyzeKeyframeImage(job.seg.keyframe_path);
    if (r.ok) {
      byIndex.set(job.i, r);
      scored += 1;
      if (r.visual_basis === "blurdetect") sawBlur = true;
      else sawExposureOnly = true;
    } else {
      failed += 1;
    }
  });

  const out = segs.map((seg, i) => {
    const r = byIndex.get(i);
    if (!r) return withNullVisual(seg);
    return { ...seg, luma_mean: r.luma_mean, sharpness: r.sharpness, visual_basis: r.visual_basis };
  });
  const backend = sawBlur ? "blurdetect" : sawExposureOnly ? "exposure_only" : null;
  return { segments: out, scored, failed, backend };
}

module.exports = {
  attachVisualFeatures,
  analyzeKeyframeImage,
  parseVisualMeta,
};
