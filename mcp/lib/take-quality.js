"use strict";

// Per-segment take-quality / "strength" scoring (v3.9 — upstream INSPECT signal).
//
// PURE: no I/O, no ffmpeg, never throws. Turns the per-segment signals INSPECT
// already computes — delivery energy (`energy_rms_db`), pace (`speech_rate_wpm`),
// clean-speech cleanliness (`clean_fraction`) — plus the cheap visual heuristics
// from `visual-quality.js` (exposure `luma_mean`, focus `sharpness`, optional
// `face`) — into ONE 0–1 `strength` score + tier + flags per segment. The point
// is leverage: INSPECT used to say what is SPOKEN and what is A/B-roll, but never
// what is GOOD. With a strength score the storyboarder can pick the BEST take of a
// moment (strong delivery, sharp focus, well-exposed, no flubs) instead of merely
// a spoken one — better input to every downstream decision.
//
// Fail-safe by construction: every missing input degrades to a `null` component
// and the composite renormalizes over whatever is present (the score is `null`
// only when nothing is measurable). Energy + sharpness are scored RELATIVE to the
// file's own distribution (mic gain / lens / lighting are constant within a shoot,
// so "strong" means "among the better takes in THIS footage"); pace + exposure use
// absolute "good" bands. Advisory only — nothing here gates or rejects a save.

const STRONG_THRESHOLD = 0.66;
const USABLE_THRESHOLD = 0.40;

// Composite split for a SPOKEN take (renormalized when one side is absent — a
// silent b-roll take scores on visual alone, a model-free lint harness with no
// keyframes scores on delivery alone).
const DELIVERY_WEIGHT = 0.6;
const VISUAL_WEIGHT = 0.4;

// Delivery sub-weights (energy/pace/cleanliness) and visual sub-weights
// (sharpness/exposure/face). Each renormalizes over present components.
const W_ENERGY = 0.42;
const W_PACE = 0.33;
const W_CLEAN = 0.25;
const W_SHARP = 0.45;
const W_EXPOSURE = 0.35;
const W_FACE = 0.20;

function disabled() {
  const v = String(process.env.VOB_TAKE_QUALITY || "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "none";
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function isNum(x) { return typeof x === "number" && Number.isFinite(x); }
function round2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }

function median(values) {
  const a = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Robust spread ≈ 1.4826·MAD, floored so a near-uniform (or tiny) sample can't
// blow the z up to ±∞. The floor keeps relative scores near 0.5 (no strong
// claim) when the file has too few comparable takes to rank confidently.
function robustSpread(values, floor) {
  const a = (Array.isArray(values) ? values : []).filter(isNum);
  const m = median(a);
  if (m == null) return floor;
  const mad = median(a.map((v) => Math.abs(v - m))) || 0;
  return Math.max(1.4826 * mad, floor);
}

function logistic(z, k) { return 1 / (1 + Math.exp(-k * z)); }

// A raw value's position within a {median, spread} distribution, mapped to 0..1
// by a logistic (median → 0.5, +1·spread → ~0.75, −1·spread → ~0.25). Null when
// the value or the distribution is unusable.
function relativeScore(value, stats, k = 1.1) {
  if (!isNum(value) || !stats || !isNum(stats.median) || !isNum(stats.spread) || stats.spread <= 0) return null;
  return clamp01(logistic((value - stats.median) / stats.spread, k));
}

// Speech-rate "engagement" band (wpm). Conversational, well-paced delivery
// (~120–180 wpm) scores full; halting/draggy (very low — a padded, low-density
// "speech" segment) and rushed (very high) ramp down. Null when not speech.
function paceScore(wpm) {
  if (!isNum(wpm)) return null;
  if (wpm <= 0) return 0.15;
  // Floor the sub-30 region at the halting anchor (0.2): the 30→70 ramp must only
  // interpolate UPWARD — applied below 30 it goes negative-of-anchor and dips
  // under the wpm=0 floor, a non-monotone trough where a 1-word held segment
  // would outrank a wordless one.
  if (wpm < 30) return 0.2;
  if (wpm < 70) return clamp01(0.2 + (wpm - 30) / (70 - 30) * (0.35 - 0.2));
  if (wpm < 120) return clamp01(0.35 + (wpm - 70) / (120 - 70) * (1.0 - 0.35));
  if (wpm <= 180) return 1.0;
  if (wpm <= 250) return clamp01(1.0 - (wpm - 180) / (250 - 180) * (1.0 - 0.35));
  return 0.2;
}

// Exposure band on mean luma (0–255). A broad mid-range [55,200] scores full;
// crushed shadows (underexposed) and blown highlights (overexposed) ramp down.
function exposureScore(luma) {
  if (!isNum(luma)) return null;
  if (luma < 20) return 0.1;
  if (luma < 55) return clamp01(0.2 + (luma - 20) / (55 - 20) * (1.0 - 0.2));
  if (luma <= 200) return 1.0;
  if (luma <= 235) return clamp01(1.0 - (luma - 200) / (235 - 200) * (1.0 - 0.3));
  return 0.15;
}

// Optional face term. Null backend → null (omitted from the composite). For a
// SPOKEN take a missing face is a real demerit (an A-roll talking-head wants the
// subject visible); for b-roll a missing face is neutral (null). A present,
// well-sized, centered face is the strongest signal.
function faceScore(face, isSpeech) {
  if (face == null || typeof face !== "object") return null;
  if (face.present !== true) return isSpeech ? 0.35 : null;
  let s = 0.7;
  if (isNum(face.area_frac) && face.area_frac >= 0.03 && face.area_frac <= 0.55) s += 0.2;
  if (face.centered === true) s += 0.1;
  return clamp01(s);
}

// Weighted mean over the present (non-null) components; null when none present.
function weightedAvg(pairs) {
  let wSum = 0;
  let acc = 0;
  for (const [score, weight] of pairs) {
    if (isNum(score) && isNum(weight) && weight > 0) { wSum += weight; acc += score * weight; }
  }
  return wSum > 0 ? acc / wSum : null;
}

// File-level distributions for the RELATIVE components (energy over speech
// segments; sharpness over every keyframe that scored). Absolute-band components
// (pace, exposure, face) don't need file stats.
function fileTakeStats(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const speechEnergy = segs.filter((s) => s && s.has_speech === true && isNum(s.energy_rms_db)).map((s) => s.energy_rms_db);
  const sharpVals = segs.filter((s) => s && isNum(s.sharpness)).map((s) => s.sharpness);
  return {
    energy: { median: median(speechEnergy), spread: robustSpread(speechEnergy, 3.0) },
    sharpness: { median: median(sharpVals), spread: robustSpread(sharpVals, 0.02) },
  };
}

// Score ONE segment against its file's stats. Returns the `strength` block or
// null (silence, or nothing measurable). Collects human-readable flags for the
// digest / storyboarder ("low_energy", "soft_focus", "filler_heavy", ...).
function computeSegmentStrength(seg, fileStats) {
  if (!seg || seg.is_silence === true) return null;
  const stats = fileStats || fileTakeStats([seg]);
  const isSpeech = seg.has_speech === true;
  const flags = [];

  // --- delivery (verbal/audio) ---
  const energy = relativeScore(seg.energy_rms_db, stats.energy);
  if (isNum(energy) && energy < 0.27) flags.push("low_energy");
  const pace = paceScore(seg.speech_rate_wpm);
  if (isNum(seg.speech_rate_wpm)) {
    if (seg.speech_rate_wpm < 80) flags.push("halting");
    else if (seg.speech_rate_wpm > 220) flags.push("rushed");
  }
  const cleanliness = isNum(seg.clean_fraction) ? clamp01(seg.clean_fraction) : null;
  if (isNum(cleanliness) && cleanliness < 0.6) flags.push("filler_heavy");
  const delivery = isSpeech
    ? weightedAvg([[energy, W_ENERGY], [pace, W_PACE], [cleanliness, W_CLEAN]])
    : null;

  // --- visual ---
  const sharpness = relativeScore(seg.sharpness, stats.sharpness);
  if (isNum(sharpness) && sharpness < 0.25) flags.push("soft_focus");
  const exposure = exposureScore(seg.luma_mean);
  if (isNum(seg.luma_mean)) {
    if (seg.luma_mean < 40) flags.push("underexposed");
    else if (seg.luma_mean > 225) flags.push("overexposed");
  }
  const face = faceScore(seg.face, isSpeech);
  if (seg.face && seg.face.present === false && isSpeech) flags.push("no_face");
  const visual = weightedAvg([[sharpness, W_SHARP], [exposure, W_EXPOSURE], [face, W_FACE]]);

  // --- composite ---
  const score = weightedAvg([[delivery, DELIVERY_WEIGHT], [visual, VISUAL_WEIGHT]]);
  // Nothing measurable (no audio features, no keyframe) → null, same as silence.
  // When score is null both delivery and visual are null, so no component fired
  // and flags is empty — returning null loses nothing and keeps the contract
  // clean: `strength` is a scored object or null, never a hollow {score:null}.
  if (score == null) return null;
  const tier = score >= STRONG_THRESHOLD ? "strong" : score >= USABLE_THRESHOLD ? "usable" : "weak";

  return {
    score: round2(score),
    tier,
    delivery: round2(delivery),
    visual: round2(visual),
    components: {
      energy: round2(energy),
      pace: round2(pace),
      cleanliness: round2(cleanliness),
      sharpness: round2(sharpness),
      exposure: round2(exposure),
      face: round2(face),
    },
    flags,
  };
}

// Attach a `strength` block to every segment in a file (computes file stats
// once). When VOB_TAKE_QUALITY=off every segment gets strength:null (the field
// stays present so downstream shape is stable). Pure.
function attachTakeStrength(segments) {
  if (!Array.isArray(segments)) return [];
  if (disabled()) return segments.map((s) => ({ ...s, strength: null }));
  const stats = fileTakeStats(segments);
  return segments.map((s) => ({ ...s, strength: computeSegmentStrength(s, stats) }));
}

function overlapSeconds(spans, start, end) {
  let acc = 0;
  for (const sp of Array.isArray(spans) ? spans : []) {
    const a = Number(sp && sp.start);
    const b = Number(sp && sp.end);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo) acc += hi - lo;
  }
  return acc;
}

// Per-segment cleanliness = fraction of the SPOKEN segment window NOT covered by
// clean-cut's `removed[]` spans (fillers, dead air, flubbed retakes). Lower =
// more filler/dead-air = a weaker take. Only meaningful for the winner file's
// speech segments (clean_speech is computed on the narration spine); everything
// else gets clean_fraction:null. Pure.
function attachCleanliness(segments, removedSpans) {
  if (!Array.isArray(segments)) return [];
  if (!Array.isArray(removedSpans)) return segments.map((s) => ({ ...s, clean_fraction: null }));
  return segments.map((s) => {
    if (!s || s.is_silence === true || s.has_speech !== true || !(s.duration_seconds > 0)) {
      return { ...s, clean_fraction: null };
    }
    const ov = overlapSeconds(removedSpans, s.start_seconds, s.end_seconds);
    return { ...s, clean_fraction: round2(clamp01(1 - ov / s.duration_seconds)) };
  });
}

// Compact, lean aggregate over all files' scored segments — for state.inspect,
// read_state_summary, and the digest's "strongest takes" list.
function summarizeTakeQuality(fileSummaries, { topN = 8 } = {}) {
  const scored = [];
  for (const f of Array.isArray(fileSummaries) ? fileSummaries : []) {
    for (const s of Array.isArray(f && f.segments) ? f.segments : []) {
      if (s && s.strength && isNum(s.strength.score)) {
        scored.push({
          file_index: f.file_index,
          segment_index: s.index,
          start_seconds: s.start_seconds,
          end_seconds: s.end_seconds,
          score: s.strength.score,
          tier: s.strength.tier,
          has_speech: s.has_speech === true,
        });
      }
    }
  }
  const countTier = (t) => scored.filter((x) => x.tier === t).length;
  const strongest = scored.slice().sort((a, b) => b.score - a.score).slice(0, topN);
  return {
    scored_segments: scored.length,
    strong: countTier("strong"),
    usable: countTier("usable"),
    weak: countTier("weak"),
    median_score: round2(median(scored.map((x) => x.score))),
    strongest,
  };
}

module.exports = {
  attachTakeStrength,
  attachCleanliness,
  computeSegmentStrength,
  fileTakeStats,
  summarizeTakeQuality,
  // exposed for tests / tuning
  paceScore,
  exposureScore,
  relativeScore,
  STRONG_THRESHOLD,
  USABLE_THRESHOLD,
};
