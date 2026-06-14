"use strict";

// Chunk-level caption sidecars (.srt + .vtt) derived from the storyboard's
// planned scene.caption_segments[]. ONE implementation, shared by the package
// path (vob_package_output) and the per-deliverable import path
// (vob_import_deliverable) — never a second copy.
//
// Timing is OUTPUT-time, off the same cumulative scene-target-duration cursor
// resolveThumbnailMoment / chaptersFromStoryboard already trust. The load-
// bearing subtlety: caption_segments carry SOURCE-time offsets (the original
// take's timeline), so each cue is re-timed exactly as the composer does —
// `cursor + (seg.start_seconds - clip.in_seconds)` reading the scene's first
// source clip (mirror of m5-walker compose()). Cue ends clamp to the probed
// output duration; the timing basis is the storyboard scene targets (the same
// known scene-duration-vs-cut drift chapters already declare), NOT a per-word
// alignment — hence level:"chunk", timing_basis:"storyboard_target".

const { captionSegmentsOf } = require("./storyboard-schema.js");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// HH:MM:SS,mmm (SRT, comma fraction) / HH:MM:SS.mmm (VTT, dot fraction). Both
// clamp to >= 0 and always zero-pad hours (extends youtubeStamp to ms).
function stampParts(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return {
    h: String(h).padStart(2, "0"),
    m: String(m).padStart(2, "0"),
    s: String(s).padStart(2, "0"),
    ms: String(milli).padStart(3, "0"),
  };
}

function stampSrt(seconds) {
  const p = stampParts(seconds);
  return `${p.h}:${p.m}:${p.s},${p.ms}`;
}

function stampVtt(seconds) {
  const p = stampParts(seconds);
  return `${p.h}:${p.m}:${p.s}.${p.ms}`;
}

// buildCaptionSidecar(storyboard, { durationSeconds }) ->
//   { srt, vtt, segment_count } | null
//
// Walks storyboard.scenes in OUTPUT-time order; returns null when the input is
// not a single-timeline scenes[] object or when no cue survives. The fan-out
// path passes { scenes: timeline.scenes } for the active short.
function buildCaptionSidecar(storyboard, options) {
  if (!isPlainObject(storyboard) || !Array.isArray(storyboard.scenes)) return null;
  const durationSeconds = options && Number.isFinite(options.durationSeconds)
    ? options.durationSeconds
    : null;
  if (durationSeconds === null || durationSeconds <= 0) return null;

  const cues = [];
  let cursor = 0;
  for (const scene of storyboard.scenes) {
    const d = Number(scene && scene.target_duration_seconds);
    // Malformed scene durations break every downstream cue offset — stop
    // accumulating and emit what we have (mirrors the cursor = NaN; break guard
    // in resolveThumbnailMoment).
    if (!Number.isFinite(d) || d <= 0) break;
    // SOURCE-time -> OUTPUT-time: subtract the scene's first clip in-point, the
    // exact transform the composer applies (omitting it lands every cue
    // in_seconds too late for any scene cut from the middle of a take, then the
    // cueStart >= durationSeconds guard silently drops them).
    const clip = (Array.isArray(scene.source_clips) && scene.source_clips[0]) || {};
    const inSec = Number(clip.in_seconds) || 0;
    for (const seg of captionSegmentsOf(scene)) {
      let cueStart = cursor + (seg.start_seconds - inSec);
      let cueEnd = cursor + (seg.end_seconds - inSec);
      if (cueStart < 0) cueStart = 0;
      cueEnd = Math.min(cueEnd, durationSeconds);
      // The cursor can overrun the real cut (durationSeconds is the probed
      // post-loudnorm final) — drop cues that fall off the end or collapse.
      if (cueStart >= durationSeconds || cueEnd <= cueStart) continue;
      cues.push({ start: cueStart, end: cueEnd, text: String(seg.text).trim() });
    }
    cursor += d;
  }

  if (cues.length === 0) return null;

  const srtBlocks = [];
  const vttBlocks = [];
  cues.forEach((cue, ix) => {
    const i = ix + 1;
    srtBlocks.push(`${i}\n${stampSrt(cue.start)} --> ${stampSrt(cue.end)}\n${cue.text}\n`);
    vttBlocks.push(`${stampVtt(cue.start)} --> ${stampVtt(cue.end)}\n${cue.text}\n`);
  });

  return {
    srt: srtBlocks.join("\n"),
    vtt: `WEBVTT\n\n${vttBlocks.join("\n")}`,
    segment_count: cues.length,
  };
}

module.exports = { buildCaptionSidecar, stampSrt, stampVtt };
