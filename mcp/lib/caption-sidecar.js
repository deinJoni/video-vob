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
// output duration.
//
// (v3.4) WORD-ANCHORING: a tester noticed the sidecars drifted from the
// burned-in karaoke captions because the cue windows came from the storyboarder's
// APPROXIMATE chunk windows while the burn-in uses the forced-aligned per-word
// times. When a forced-aligned transcript is available (transcriptAligned:true +
// a per-file resolver), each cue's start/end is re-anchored to the actual word
// times of the words in the chunk (first matched word's start → last matched
// word's end), so the sidecar matches what's on screen. Falls back to the
// storyboard chunk window when alignment is absent or no word matches — hence the
// returned timing_basis is "forced_aligned" only when at least one cue was
// word-anchored, else "storyboard_target".

const { captionSegmentsOf } = require("./storyboard-schema.js");

// Animations that highlight per WORD (vs chunk-level "pop") — the only ones that
// benefit from a word-level VTT export. Mirrors storyboard-schema's set.
const WORD_LEVEL_ANIMS = new Set(["word-by-word", "karaoke"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Lowercased alphanumeric word tokens (apostrophes folded) for matching caption
// text against transcript words.
function wordTokens(text) {
  if (typeof text !== "string") return [];
  return text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

// Re-anchor a caption segment's [start,end] to the forced-aligned word times of
// the words it actually contains. `words` is the {text,start,end} array for the
// segment's source file. Returns { start, end } from the first/last word in the
// segment window whose token matches a caption token, or null when there is no
// usable match (caller keeps the storyboard chunk window).
function alignedWindow(words, seg) {
  if (!Array.isArray(words) || words.length === 0) return null;
  if (!Number.isFinite(seg.start_seconds) || !Number.isFinite(seg.end_seconds)) return null;
  const capTokens = new Set(wordTokens(seg.text));
  if (capTokens.size === 0) return null;
  const pad = 0.5; // catch words straddling the chunk boundary
  let first = null;
  let last = null;
  for (const w of words) {
    if (!isPlainObject(w) || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    if (w.end <= seg.start_seconds - pad || w.start >= seg.end_seconds + pad) continue;
    const toks = wordTokens(w.text);
    if (!toks.some((t) => capTokens.has(t))) continue;
    if (first === null || w.start < first) first = w.start;
    if (last === null || w.end > last) last = w.end;
  }
  if (first === null || last === null || last <= first) return null;
  return { start: first, end: last };
}

// (v3.8) Word-level VTT cue body: the forced-aligned transcript words inside the
// segment window, each prefixed with its OUTPUT-time tag (<HH:MM:SS.mmm>word) so
// a player/editor can highlight per word — the karaoke export the engine already
// pays for alignment to produce but used to discard. `words` is the file's
// {text,start,end} array; offsets map SOURCE→OUTPUT via cursor − inSec. Every tag
// is CLAMPED to the cue's [cueStart,cueEnd] window — WebVTT requires inline
// timestamps within the cue and non-decreasing, and the cue window can be the
// alignedWindow (matched words only) while a non-matching word maps earlier.
// Returns the tagged string, or null when no word falls in the window.
function wordTaggedCue(words, seg, inSec, cursor, cueStart, cueEnd) {
  if (!Array.isArray(words) || !Number.isFinite(seg.start_seconds) || !Number.isFinite(seg.end_seconds)) return null;
  const pad = 0.3;
  const parts = [];
  for (const w of words) {
    if (!isPlainObject(w) || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    if (w.end <= seg.start_seconds - pad || w.start >= seg.end_seconds + pad) continue;
    const tok = String(w.text == null ? "" : w.text).trim();
    if (!tok) continue;
    let t = cursor + (w.start - inSec);
    if (t < cueStart) t = cueStart; // keep inline tags within the cue (non-decreasing)
    if (t > cueEnd) break; // past the cue end
    parts.push(`<${stampVtt(t)}>${tok}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
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

// buildCaptionSidecar(storyboard, { durationSeconds, transcriptForFileIndex?, transcriptAligned? }) ->
//   { srt, vtt, segment_count, timing_basis } | null
//
// Walks storyboard.scenes in OUTPUT-time order; returns null when the input is
// not a single-timeline scenes[] object or when no cue survives. The fan-out
// path passes { scenes: timeline.scenes } for the active short.
//
// transcriptForFileIndex(fileIndex) -> [{text,start,end}] | null and
// transcriptAligned (bool) opt the cues into word-anchored timing (the same word
// times the burn-in uses); absent, the storyboard chunk windows are used as before.
function buildCaptionSidecar(storyboard, options) {
  if (!isPlainObject(storyboard) || !Array.isArray(storyboard.scenes)) return null;
  const durationSeconds = options && Number.isFinite(options.durationSeconds)
    ? options.durationSeconds
    : null;
  if (durationSeconds === null || durationSeconds <= 0) return null;
  const resolver = options && typeof options.transcriptForFileIndex === "function"
    ? options.transcriptForFileIndex
    : null;
  const aligned = options && options.transcriptAligned === true && resolver !== null;

  const cues = [];
  let cursor = 0;
  let usedAligned = false;
  let usedWordLevel = false;
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
    const fileIdx = Number.isInteger(clip.manifest_file_index) ? clip.manifest_file_index : null;
    const words = aligned && fileIdx !== null ? resolver(fileIdx) : null;
    for (const seg of captionSegmentsOf(scene)) {
      // Word-anchor the cue window to the aligned word times when available, so
      // the sidecar matches the burned-in (karaoke) timing rather than the
      // storyboarder's approximate chunk window.
      let segStart = seg.start_seconds;
      let segEnd = seg.end_seconds;
      const refined = Array.isArray(words) ? alignedWindow(words, seg) : null;
      if (refined) {
        segStart = refined.start;
        segEnd = refined.end;
        usedAligned = true;
      }
      let cueStart = cursor + (segStart - inSec);
      let cueEnd = cursor + (segEnd - inSec);
      if (cueStart < 0) cueStart = 0;
      cueEnd = Math.min(cueEnd, durationSeconds);
      // The cursor can overrun the real cut (durationSeconds is the probed
      // post-loudnorm final) — drop cues that fall off the end or collapse.
      if (cueStart >= durationSeconds || cueEnd <= cueStart) continue;
      // Word-level VTT export for a planned word-level animation (karaoke /
      // word-by-word) on an aligned transcript — the engine already has the
      // per-word times, so spend them on the sidecar too. SRT stays chunk-level.
      let wordVtt = null;
      if (Array.isArray(words) && WORD_LEVEL_ANIMS.has(seg.animation)) {
        wordVtt = wordTaggedCue(words, seg, inSec, cursor, cueStart, cueEnd);
        if (wordVtt) usedWordLevel = true;
      }
      cues.push({ start: cueStart, end: cueEnd, text: String(seg.text).trim(), wordVtt });
    }
    cursor += d;
  }

  if (cues.length === 0) return null;

  const srtBlocks = [];
  const vttBlocks = [];
  cues.forEach((cue, ix) => {
    const i = ix + 1;
    // SRT carries the plain chunk text (inline word tags aren't portable in SRT);
    // VTT carries the per-word tags when present (chunk text otherwise).
    srtBlocks.push(`${i}\n${stampSrt(cue.start)} --> ${stampSrt(cue.end)}\n${cue.text}\n`);
    vttBlocks.push(`${stampVtt(cue.start)} --> ${stampVtt(cue.end)}\n${cue.wordVtt || cue.text}\n`);
  });

  return {
    srt: srtBlocks.join("\n"),
    vtt: `WEBVTT\n\n${vttBlocks.join("\n")}`,
    segment_count: cues.length,
    timing_basis: usedAligned ? "forced_aligned" : "storyboard_target",
    // "word" when at least one cue got per-word VTT tags, else "chunk".
    level: usedWordLevel ? "word" : "chunk",
  };
}

module.exports = { buildCaptionSidecar, stampSrt, stampVtt };
