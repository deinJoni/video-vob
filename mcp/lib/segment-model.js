"use strict";

// Pure segment construction. Given a video's duration plus the raw outputs of
// the scene-cut and silence detectors, partition [0, duration] into a flat,
// non-overlapping, gap-free list of segments. NO ffmpeg, NO I/O — fully
// synchronous and deterministic so it can be unit-tested without a fixture and
// reasoned about in isolation from detection noise.
//
// The detectors are noisy: scene cuts can land a few ms apart, silence edges
// can coincide with a cut, and either can produce slivers far too short to be a
// usable clip. This module is the single place that reconciles them into a
// boundary set and emits only segments worth cutting.

// Boundaries closer than this are treated as the same point (sub-frame jitter
// from the detectors). 1ms is well below any meaningful clip granularity.
const BOUNDARY_EPSILON = 1e-3;

const SOURCE_SCENE = "scene";
const SOURCE_SILENCE = "silence";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Clamp to [0, duration], drop non-finite / out-of-range values, de-dupe within
// BOUNDARY_EPSILON, return ascending. Always includes 0 and duration as anchors.
function collectBoundaries(durationSeconds, sceneCuts, silences) {
  const raw = [0, durationSeconds];
  for (const cut of sceneCuts) {
    if (isFiniteNumber(cut)) raw.push(cut);
  }
  for (const s of silences) {
    if (s && isFiniteNumber(s.start)) raw.push(s.start);
    if (s && isFiniteNumber(s.end)) raw.push(s.end);
  }

  // Clamp then keep only in-range, then sort so de-dupe can be a linear pass.
  const clamped = raw
    .map((b) => Math.min(Math.max(b, 0), durationSeconds))
    .filter((b) => b >= 0 && b <= durationSeconds)
    .sort((a, b) => a - b);

  const deduped = [];
  for (const b of clamped) {
    if (deduped.length === 0 || b - deduped[deduped.length - 1] > BOUNDARY_EPSILON) {
      deduped.push(b);
    }
  }
  return deduped;
}

// True if `t` lies inside any silence interval. Used for is_silence via the
// segment midpoint (a midpoint inside a silence interval == >50% of the
// segment, since silence edges are themselves boundaries, so a segment never
// straddles a single silence edge — it is wholly inside or wholly outside).
function pointInSilence(t, silences) {
  for (const s of silences) {
    if (!s || !isFiniteNumber(s.start) || !isFiniteNumber(s.end)) continue;
    if (t >= s.start && t <= s.end) return true;
  }
  return false;
}

// Does a boundary at `t` coincide (within epsilon) with any value in `points`?
function touches(t, points) {
  for (const p of points) {
    if (isFiniteNumber(p) && Math.abs(t - p) <= BOUNDARY_EPSILON) return true;
  }
  return false;
}

// Which detector(s) contributed a boundary (start OR end) of a segment.
// 0 and duration are structural anchors, not detector output, so they
// contribute nothing on their own.
function segmentSources(start, end, sceneCuts, silenceEdges) {
  const out = [];
  const onScene = touches(start, sceneCuts) || touches(end, sceneCuts);
  const onSilence = touches(start, silenceEdges) || touches(end, silenceEdges);
  if (onScene) out.push(SOURCE_SCENE);
  if (onSilence) out.push(SOURCE_SILENCE);
  return out;
}

/**
 * buildSegments — partition [0, durationSeconds] into coalesced segments.
 *
 * @param {object} args
 * @param {number} args.fileIndex          passed through to every segment as file_index
 * @param {number} args.durationSeconds     total media duration; <= 0 -> []
 * @param {number[]} [args.sceneCuts]       scene-cut timestamps (seconds)
 * @param {{start:number,end:number}[]} [args.silences]  silence intervals (seconds)
 * @param {number} [args.minSegmentSeconds] segments shorter than this are merged away
 * @returns {Array<{file_index:number,index:number,start_seconds:number,end_seconds:number,
 *                   duration_seconds:number,is_silence:boolean,sources:string[]}>}
 */
function buildSegments({
  fileIndex,
  durationSeconds,
  sceneCuts = [],
  silences = [],
  minSegmentSeconds = 0.4,
} = {}) {
  if (!isFiniteNumber(durationSeconds) || durationSeconds <= 0) return [];
  if (!Array.isArray(sceneCuts)) sceneCuts = [];
  if (!Array.isArray(silences)) silences = [];
  const minSeg = isFiniteNumber(minSegmentSeconds) && minSegmentSeconds > 0 ? minSegmentSeconds : 0;

  const boundaries = collectBoundaries(durationSeconds, sceneCuts, silences);
  // collectBoundaries always returns at least [0, duration] (anchors survive
  // de-dupe unless duration ~= 0, excluded above), so >= 2 boundaries here.

  // All silence edges, as a flat list, for source attribution.
  const silenceEdges = [];
  for (const s of silences) {
    if (s && isFiniteNumber(s.start)) silenceEdges.push(s.start);
    if (s && isFiniteNumber(s.end)) silenceEdges.push(s.end);
  }

  // Raw segments from adjacent boundary pairs, each carrying its own boundary
  // pair so sources/is_silence can be recomputed after coalescing.
  const raw = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    raw.push({ start: boundaries[i], end: boundaries[i + 1] });
  }

  // COALESCE: never emit a segment shorter than minSeg. A sub-min segment is
  // absorbed into its previous segment (extending that segment's end); if it is
  // the first segment, it is absorbed into the next instead (extending that
  // segment's start backward). We keep merging until every kept segment is
  // >= minSeg. Because each merge only ever grows a neighbour, and the total
  // span is fixed at durationSeconds, this terminates.
  const coalesced = [];
  for (const seg of raw) {
    const dur = seg.end - seg.start;
    if (dur < minSeg && coalesced.length > 0) {
      // Merge into previous: extend its end to swallow this sliver.
      coalesced[coalesced.length - 1].end = seg.end;
    } else {
      coalesced.push({ start: seg.start, end: seg.end });
    }
  }
  // Edge case: the very first segment was itself sub-min. It got pushed (no
  // previous to merge into), so a leading sliver can survive the forward pass.
  // Fold it forward into its successor. Repeat in case the successor was also
  // sub-min after the forward pass collapsed everything to one segment.
  while (coalesced.length > 1 && coalesced[0].end - coalesced[0].start < minSeg) {
    const head = coalesced.shift();
    coalesced[0].start = head.start;
  }
  // If only one segment remains it spans the whole duration regardless of
  // minSeg — we never drop the sole segment (the media is always fully covered).

  const silenceList = silences;
  return coalesced.map((seg, index) => {
    const midpoint = (seg.start + seg.end) / 2;
    return {
      file_index: fileIndex,
      index,
      start_seconds: seg.start,
      end_seconds: seg.end,
      duration_seconds: seg.end - seg.start,
      is_silence: pointInSilence(midpoint, silenceList),
      sources: segmentSources(seg.start, seg.end, sceneCuts, silenceEdges),
    };
  });
}

module.exports = {
  buildSegments,
  // exported for testing / reuse — pure helpers
  collectBoundaries,
  pointInSilence,
  BOUNDARY_EPSILON,
};
