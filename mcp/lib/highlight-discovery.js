"use strict";

// Highlight discovery (v0.3.11) — the GENERATIVE selection pass that turns the
// INSPECT signal stack into a ranked set of short-worthy candidate windows, one
// per future fan-out short. PURE module: no I/O, no requires, never throws — the
// `highlights` walker phase exercises it from synthetic inputs, exactly like
// `hook-scoring.js` and `take-quality.js`.
//
// The leverage: the app already computes every signal a good highlight wants —
// rhetorical hook archetypes + scores (hook-scoring.js → inspect.json
// hook_candidates[]), per-segment take-quality `strength` (take-quality.js →
// segments.json), clean-cut keep-spans (clean-cut.js → clean_speech.json), and
// the user's named key_moments. Today those signals are consumed only
// DEFENSIVELY (as PLAN warnings). This module runs them FORWARD: it scores each
// non-silence speech segment as a cold-open SEED, grows a window from each strong
// seed to a natural payoff (snapping to clean-speech / segment boundaries and
// targeting the intent duration), scores the whole window, dedupes overlaps, and
// returns the top-N. The storyboarder then authors one schema-1.1 short per
// candidate window; everything from COMPOSE onward is the existing fan-out path.
//
// v1 is SINGLE-SOURCE: candidates come from the winner file only
// (summary.transcribed_file_index), because hook-candidate / keep-span seconds
// are file-specific. Cross-file highlights are out of scope.
//
// Source-relative by construction (like take-quality): energy is scored vs the
// file's own distribution, so "strong" means best-of-THIS-source. Fail-safe by
// construction: any missing input degrades to a neutral component, and if nothing
// clears the minimum window score the result is an empty candidate list with a
// `notes` reason — never an exception, never a gate.

// ---- tunables (overridable via opts) ---------------------------------------
const DEFAULT_COUNT = 3;          // highlights to propose when count is unspecified
const MAX_HIGHLIGHTS = 10;        // hard cap — we never propose a 50-short fan-out
const DEFAULT_TARGET_SECONDS = 30;
const DEFAULT_MIN_SECONDS = 15;
const DEFAULT_MAX_SECONDS = 75;
const ABS_MIN_WINDOW_SECONDS = 3; // below this a "short" is not viable
const MIN_WINDOW_SCORE = 0.35;    // a window must clear this to be proposed
const OVERLAP_FRACTION = 0.25;    // dedupe: drop a window overlapping an accepted
                                  // one by more than this fraction of the shorter
const HOOK_SCORE_REF = 6.0;       // hook score that maps to full "opening pull"
const PAUSE_GAP_SECONDS = 0.35;   // a removed/silence gap this long after a window
                                  // end counts as a natural pause (self-containment)

// Window-score component weights. weightedAvg renormalizes over PRESENT
// components, so the key-moment term simply drops out when the user named none
// (its 0.20 redistributes) — no artificial penalty for moment-less sources.
const W_HOOK = 0.35;       // opening pull (the seed's hook archetype/score)
const W_DELIVERY = 0.30;   // sustained take-quality strength across the window
const W_SELF = 0.15;       // self-containment (clean start + payoff end + hook open)
const W_KEYMOMENT = 0.20;  // coverage of a user-named key moment

function isNum(x) { return typeof x === "number" && Number.isFinite(x); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function round2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
function round3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }

function median(values) {
  const a = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Robust spread ≈ 1.4826·MAD, floored so a near-uniform/tiny sample can't blow the
// z to ±∞ (mirrors take-quality.js — keeps relative scores near 0.5 when the file
// has too few comparable takes to rank confidently).
function robustSpread(values, floor) {
  const a = (Array.isArray(values) ? values : []).filter(isNum);
  const m = median(a);
  if (m == null) return floor;
  const mad = median(a.map((v) => Math.abs(v - m))) || 0;
  return Math.max(1.4826 * mad, floor);
}

function logistic(z, k) { return 1 / (1 + Math.exp(-k * z)); }

// A raw value's position within a {median, spread} distribution mapped to 0..1
// (median → 0.5, +1·spread → ~0.75). Null when unusable. (Inlined copy of
// take-quality.relativeScore so this module stays require-free + pure.)
function relativeScore(value, stats, k = 1.1) {
  if (!isNum(value) || !stats || !isNum(stats.median) || !isNum(stats.spread) || stats.spread <= 0) return null;
  return clamp01(logistic((value - stats.median) / stats.spread, k));
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

// ---- interval helpers (tiny, local) ----------------------------------------
function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const lo = Math.max(aStart, bStart);
  const hi = Math.min(aEnd, bEnd);
  return hi > lo ? hi - lo : 0;
}

function sortedUnique(values) {
  const a = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((x, y) => x - y);
  const out = [];
  for (const v of a) if (out.length === 0 || v - out[out.length - 1] > 1e-3) out.push(v);
  return out;
}

// Largest value in the ascending list that is <= t (+epsilon); null if none.
function nearestAtOrBelow(sorted, t) {
  let pick = null;
  for (const v of sorted) {
    if (v <= t + 1e-3) pick = v; else break;
  }
  return pick;
}

function inKeepSpan(t, keepSpans) {
  for (const s of keepSpans) {
    if (s && isNum(s.start) && isNum(s.end) && t >= s.start - 1e-3 && t <= s.end + 1e-3) return s;
  }
  return null;
}

function alignsTo(t, sorted) {
  for (const v of sorted) if (Math.abs(v - t) < 1e-2) return true;
  return false;
}

// Normalize the canonical intent target_duration ({seconds, range:{min,max}}) +
// any explicit override into a {min, mid, max} band in seconds. Always returns a
// sane band even with no intent (the feature defaults to a ~30s short).
function resolveTargetBand(target) {
  const t = target && typeof target === "object" ? target : {};
  let min = isNum(t.min_seconds) ? t.min_seconds : null;
  let max = isNum(t.max_seconds) ? t.max_seconds : null;
  let mid = isNum(t.seconds) ? t.seconds : null;
  // A contradictory explicit band (min > max) is a malformed override — swap
  // rather than silently dropping the caller's max.
  if (isNum(min) && isNum(max) && min > max) { const tmp = min; min = max; max = tmp; }
  if (min == null && mid != null) min = mid * 0.66;
  if (max == null && mid != null) max = mid * 1.5;
  if (min == null) min = DEFAULT_MIN_SECONDS;
  if (max == null) max = DEFAULT_MAX_SECONDS;
  if (mid == null) mid = (min + max) / 2;
  min = Math.max(ABS_MIN_WINDOW_SECONDS, min);
  if (max < min + 1) max = min + 1;
  mid = Math.min(Math.max(mid, min), max);
  return { min, mid, max };
}

// ---- seed / window primitives ----------------------------------------------

// The max overlapping hook-candidate score at [start,end], normalized to 0..1
// against HOOK_SCORE_REF, plus the dominant hook_type/text of that candidate.
// A start with no overlapping hook gets {norm:0, hook_type:"none", text:null}.
function hookPullAt(hookCandidates, start, end) {
  let best = null;
  for (const h of Array.isArray(hookCandidates) ? hookCandidates : []) {
    if (!h || !isNum(h.start_seconds) || !isNum(h.end_seconds)) continue;
    if (overlapSeconds(start, end, h.start_seconds, h.end_seconds) <= 0) continue;
    if (!best || (isNum(h.score) && h.score > best.score)) best = h;
  }
  if (!best) return { norm: 0, hook_type: "none", text: null, signals: [] };
  return {
    norm: clamp01((isNum(best.score) ? best.score : 0) / HOOK_SCORE_REF),
    hook_type: typeof best.hook_type === "string" ? best.hook_type : "none",
    text: typeof best.text === "string" ? best.text : null,
    signals: Array.isArray(best.signals) ? best.signals : [],
  };
}

// Named key moments (from parseKeyMoments → {ranges:[{start,end}], points:[n]})
// that fall inside [start,end]. Points use a small tolerance. Returns labeled
// refs for the candidate output + a coverage count.
function keyMomentRefs(keyMoments, start, end) {
  const km = keyMoments && typeof keyMoments === "object" ? keyMoments : {};
  const ranges = Array.isArray(km.ranges) ? km.ranges : [];
  const points = Array.isArray(km.points) ? km.points : [];
  const refs = [];
  for (const r of ranges) {
    if (!r || !isNum(r.start) || !isNum(r.end)) continue;
    if (overlapSeconds(start, end, r.start, r.end) > 0) {
      refs.push({ type: "range", start_seconds: round3(r.start), end_seconds: round3(r.end), label: `${fmtMmSs(r.start)}–${fmtMmSs(r.end)}` });
    }
  }
  const TOL = 0.5;
  for (const p of points) {
    if (!isNum(p)) continue;
    if (p >= start - TOL && p <= end + TOL) {
      refs.push({ type: "point", start_seconds: round3(p), end_seconds: round3(p), label: fmtMmSs(p) });
    }
  }
  return { refs, total: ranges.length + points.length };
}

function fmtMmSs(s) {
  const v = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(v / 60);
  const sec = v % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Is there a pause (a removed span or a silence segment) right after `t`?
// A clean window that ends on a pause is a more self-contained payoff.
function pauseAfter(t, removedSpans, silenceSegments) {
  for (const r of Array.isArray(removedSpans) ? removedSpans : []) {
    if (r && isNum(r.start) && isNum(r.end) && r.start >= t - 0.05 && r.end - r.start >= PAUSE_GAP_SECONDS && r.start <= t + 1.0) return true;
  }
  for (const s of Array.isArray(silenceSegments) ? silenceSegments : []) {
    if (s && isNum(s.start_seconds) && isNum(s.end_seconds)
      && s.start_seconds >= t - 0.05 && s.start_seconds <= t + 1.0
      && s.end_seconds - s.start_seconds >= PAUSE_GAP_SECONDS) return true;
  }
  return false;
}

// Snap a raw start to a clean phrase boundary while PRESERVING the seed position:
// the nearest segment start at/before t (a clean cut point near the hook), NOT the
// enclosing keep-span start — else a long continuous keep span (an already-edited
// talk with little dead air) would collapse every seed onto one window. Keep-spans
// are used only to AVOID dead air: if t lands in a removed gap (no keep-span), jump
// to the next keep-span start. Falls back to t when neither grid exists.
function snapStart(t, keepSpans, segStarts) {
  const spans = Array.isArray(keepSpans) ? keepSpans : [];
  let at = t;
  if (spans.length > 0 && !inKeepSpan(at, spans)) {
    let next = null;
    for (const s of spans) if (s && isNum(s.start) && s.start > at && (!next || s.start < next)) next = s.start;
    if (next != null) at = next;
  }
  const starts = Array.isArray(segStarts) ? segStarts : [];
  if (starts.length > 0) {
    const cand = nearestAtOrBelow(starts, at);
    // Snap to the nearest segment start at/before `at`, but never back across a
    // keep-span boundary into dead air (the cand must itself be inside a keep span).
    if (cand != null && (spans.length === 0 || inKeepSpan(cand, spans))) return cand;
  }
  return at;
}

// Choose a clean END for a window starting at winStart, targeting ~band.mid length.
// Candidate boundaries come from BOTH the keep-span ends (phrase ends before a
// pause — the best payoffs) and the segment ends (finer cut points, so a long keep
// span still yields multiple distinct windows). Preference: a keep-span end in
// range, else a segment end in range, each CLOSEST to winStart+mid; then a viable
// boundary nearest the grown end; finally the clamped grown end. Null when no
// viable end >= winStart+ABS_MIN exists.
function snapEnd(winStart, grownEnd, band, keepSpanEnds, segEnds, sourceDuration) {
  const cap = isNum(sourceDuration) ? sourceDuration : Infinity;
  const lo = winStart + band.min;
  const hi = Math.min(winStart + band.max, cap);
  const ideal = Math.min(winStart + band.mid, hi);
  const viableFloor = winStart + ABS_MIN_WINDOW_SECONDS;

  const pickClosest = (arr, ref) => {
    const xs = arr.filter((e) => isNum(e) && e > viableFloor && e <= cap + 1e-3);
    if (xs.length === 0) return null;
    xs.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
    return xs[0];
  };

  const keepInRange = (Array.isArray(keepSpanEnds) ? keepSpanEnds : []).filter((e) => e >= lo - 1e-3 && e <= hi + 1e-3);
  const keepPick = pickClosest(keepInRange, ideal);
  if (keepPick != null) return keepPick;

  const segInRange = (Array.isArray(segEnds) ? segEnds : []).filter((e) => e >= lo - 1e-3 && e <= hi + 1e-3);
  const segPick = pickClosest(segInRange, ideal);
  if (segPick != null) return segPick;

  // No boundary in band: nearest viable boundary (keep ∪ seg) to the grown end,
  // clamped into [lo,hi].
  const refEnd = Math.min(Math.max(grownEnd, lo), hi);
  const anyPick = pickClosest([...(keepSpanEnds || []), ...(segEnds || [])].filter((e) => e <= hi + 1e-3), refEnd);
  if (anyPick != null) return anyPick;

  const clamped = Math.min(Math.max(grownEnd, lo), hi);
  return clamped >= viableFloor ? clamped : null;
}

// Grow a window forward from a seed speech segment to ~target length, then snap
// both edges to the boundary grids. Returns the snapped {start,end} or null when
// no viable window fits.
function growWindow(seed, speechSorted, band, keepSpans, segStarts, segEnds, sourceDuration) {
  const rawStart = seed.start_seconds;
  // Grow the raw end forward by appending consecutive segments until we pass the
  // target midpoint (the snap step then trims to a clean boundary in-band).
  let grownEnd = seed.end_seconds;
  for (const seg of speechSorted) {
    if (seg.start_seconds < seed.start_seconds - 1e-3) continue;
    if (seg.end_seconds - rawStart > band.max) break;
    grownEnd = seg.end_seconds;
    if (grownEnd - rawStart >= band.mid) break;
  }
  const winStart = snapStart(rawStart, keepSpans, segStarts);
  const keepEnds = (Array.isArray(keepSpans) ? keepSpans : []).map((s) => (s && isNum(s.end) ? s.end : null)).filter(isNum);
  const winEnd = snapEnd(winStart, Math.max(grownEnd, winStart + band.mid * 0.5), band, keepEnds, segEnds, sourceDuration);
  if (winEnd == null) return null;
  const dur = winEnd - winStart;
  if (dur < ABS_MIN_WINDOW_SECONDS || winEnd <= winStart) return null;
  return { start: winStart, end: winEnd };
}

// Mean take-quality strength over the window's speech segments (energy-relative
// fallback when no segment carries `strength`). Null only when nothing measurable.
function sustainedDelivery(start, end, speechSorted, energyStats) {
  const strengths = [];
  const energies = [];
  for (const seg of speechSorted) {
    if (overlapSeconds(start, end, seg.start_seconds, seg.end_seconds) <= 0) continue;
    if (seg.strength && isNum(seg.strength.score)) strengths.push(seg.strength.score);
    const e = relativeScore(seg.energy_rms_db, energyStats);
    if (isNum(e)) energies.push(e);
  }
  if (strengths.length > 0) return median(strengths);
  if (energies.length > 0) return median(energies);
  return null;
}

/**
 * discoverHighlights — the generative selection pass. PURE.
 *
 * @param {object} a
 * @param {Array}  a.hookCandidates        inspect.json hook_candidates[] (winner file)
 * @param {Array}  a.segments              winner file's segments[] (segments.json files[i].segments)
 * @param {Array}  a.keepSpans             clean_speech.json keep_spans [{start,end,text}]
 * @param {Array}  [a.removedSpans]        clean_speech.json removed [{start,end,...}]
 * @param {object} [a.keyMoments]          parseKeyMoments output {ranges,points}
 * @param {number} [a.sourceFileIndex]     winner file index (→ candidate.source_file_index)
 * @param {number|null} [a.sourceDurationSeconds]
 * @param {object} [a.target]              {seconds?, min_seconds?, max_seconds?}
 * @param {number|null} [a.count]          desired N (clamped to [1, MAX_HIGHLIGHTS])
 * @param {object} [a.options]             {minWindowScore?, overlapFraction?}
 * @returns {{candidates:Array, notes:string, stats:object}}
 */
function discoverHighlights(input = {}) {
  // Coerce defensively — the contract is "never throws", and JS default params
  // only fire on `undefined`, not `null`. The tool boundary already passes a
  // constructed object, but a direct `discoverHighlights(null)` / `{options:null}`
  // must still degrade, not crash.
  const a = input && typeof input === "object" ? input : {};
  const {
    hookCandidates = [],
    segments = [],
    keepSpans = [],
    removedSpans = [],
    keyMoments = { ranges: [], points: [] },
    sourceFileIndex = 0,
    sourceDurationSeconds = null,
    target = {},
    count = null,
    options = {},
  } = a;
  const opts = options && typeof options === "object" ? options : {};
  const hookArr = Array.isArray(hookCandidates) ? hookCandidates : [];
  const keepArr = Array.isArray(keepSpans) ? keepSpans : [];
  const removedArr = Array.isArray(removedSpans) ? removedSpans : [];

  const notes = [];
  const minScore = isNum(opts.minWindowScore) ? opts.minWindowScore : MIN_WINDOW_SCORE;
  const overlapFrac = isNum(opts.overlapFraction) ? opts.overlapFraction : OVERLAP_FRACTION;
  const wantRaw = isNum(count) ? Math.floor(count) : DEFAULT_COUNT;
  const want = Math.max(1, Math.min(MAX_HIGHLIGHTS, wantRaw));
  if (isNum(count) && wantRaw > MAX_HIGHLIGHTS) notes.push(`requested ${wantRaw} highlights, capped at ${MAX_HIGHLIGHTS}`);

  const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && isNum(s.start_seconds) && isNum(s.end_seconds) && s.end_seconds > s.start_seconds);
  const speech = segs.filter((s) => s.is_silence !== true && s.has_speech === true);
  const silenceSegs = segs.filter((s) => s.is_silence === true);
  const speechSorted = speech.slice().sort((a, b) => a.start_seconds - b.start_seconds);

  if (speechSorted.length === 0) {
    return { candidates: [], notes: "no speech segments in the winner file — nothing to extract", stats: emptyStats() };
  }

  const band = resolveTargetBand(target);
  // Energy distribution for relative scoring (file-relative, like take-quality).
  const energyStats = {
    median: median(speechSorted.map((s) => s.energy_rms_db)),
    spread: robustSpread(speechSorted.map((s) => s.energy_rms_db), 3.0),
  };
  // Boundary grids for snapping (segment + keep-span starts/ends). Segment
  // boundaries include silence-segment edges — a window can end at the start of a
  // pause, the cleanest payoff.
  const segStarts = sortedUnique(segs.map((s) => s.start_seconds));
  const segEnds = sortedUnique(segs.map((s) => s.end_seconds));
  const keepStartsSorted = sortedUnique(keepArr.map((s) => s && s.start));
  const keepEndsSorted = sortedUnique(keepArr.map((s) => s && s.end));

  // 1+2) Seed every non-silence speech segment; score the WINDOW grown from it.
  const grown = [];
  let droppedShort = 0;
  for (const seed of speechSorted) {
    const win = growWindow(seed, speechSorted, band, keepArr, segStarts, segEnds, sourceDurationSeconds);
    if (!win) { droppedShort += 1; continue; }
    const hook = hookPullAt(hookArr, seed.start_seconds, seed.end_seconds);
    const delivery = sustainedDelivery(win.start, win.end, speechSorted, energyStats);
    const km = keyMomentRefs(keyMoments, win.start, win.end);

    // Self-containment: a clean phrase start (a keep-span start after a pause is
    // cleanest; a bare segment start is fine), a payoff that ends on a pause /
    // keep-span end, and an actual rhetorical hook opening the window.
    const startsClean = alignsTo(win.start, keepStartsSorted) ? 1 : (alignsTo(win.start, segStarts) ? 0.7 : 0.4);
    const endsOnPause = pauseAfter(win.end, removedArr, silenceSegs);
    const endsOnKeep = alignsTo(win.end, keepEndsSorted);
    const endScore = endsOnPause ? 1 : (endsOnKeep ? 0.85 : (alignsTo(win.end, segEnds) ? 0.6 : 0.4));
    const hookOpen = hook.hook_type !== "none" ? 1 : 0.5;
    const selfContainment = clamp01((startsClean + endScore + hookOpen) / 3);

    // Key-moment term: null when the user named none (drops out of weightedAvg);
    // else a strong boost for covering one, a penalty for covering none.
    const keyMomentScore = km.total === 0 ? null : (km.refs.length > 0 ? clamp01(0.6 + 0.1 * km.refs.length) : 0.2);

    // Duration fit: 1 inside the band, ramping down outside (snapping keeps most
    // windows in-band; the fallback path can land slightly off).
    const dur = win.end - win.start;
    let durationFit = 1;
    if (dur < band.min) durationFit = clamp01(dur / band.min);
    else if (dur > band.max) durationFit = clamp01(band.max / dur);

    const base = weightedAvg([
      [hook.norm, W_HOOK],
      [delivery, W_DELIVERY],
      [selfContainment, W_SELF],
      [keyMomentScore, W_KEYMOMENT],
    ]);
    const score = base == null ? 0 : clamp01(base) * durationFit;

    grown.push({
      seed,
      start: win.start,
      end: win.end,
      score,
      hook_type: hook.hook_type,
      hook_text: hook.text,
      hook_signals: hook.signals,
      key_moment_refs: km.refs,
      components: {
        hook: round2(hook.norm),
        delivery: round2(delivery),
        self_containment: round2(selfContainment),
        key_moment: round2(keyMomentScore),
        duration_fit: round2(durationFit),
      },
      delivery,
    });
  }
  if (droppedShort > 0) notes.push(`${droppedShort} seed window(s) dropped as too short for a viable cut`);

  // 4) Rank + greedy overlap dedupe (keep the higher score). Tie-break earlier.
  const ranked = grown
    .filter((g) => g.score >= minScore)
    .sort((a, b) => b.score - a.score || a.start - b.start);

  const accepted = [];
  for (const g of ranked) {
    if (accepted.length >= want) break;
    const clashes = accepted.some((acc) => {
      const ov = overlapSeconds(g.start, g.end, acc.start, acc.end);
      const shorter = Math.min(g.end - g.start, acc.end - acc.start);
      return shorter > 0 && ov / shorter > overlapFrac;
    });
    if (!clashes) accepted.push(g);
  }

  const belowThreshold = grown.length - ranked.length;
  if (accepted.length === 0) {
    const why = grown.length === 0
      ? "no viable windows could be grown from the source"
      : `no window cleared the minimum score (${minScore}) — signals too weak for confident extraction`;
    return { candidates: [], notes: notesString([...notes, why]), stats: { ...emptyStats(), seeds: speechSorted.length, grown: grown.length, below_threshold: belowThreshold } };
  }
  if (accepted.length < want) notes.push(`found ${accepted.length} distinct highlight(s) (requested ${want}) — source has limited non-overlapping material`);

  // 5) Finalize: re-rank, build reason + suggested_title.
  const candidates = accepted
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .map((g, i) => ({
      rank: i + 1,
      score: round2(g.score),
      source_file_index: sourceFileIndex,
      start_seconds: round3(g.start),
      end_seconds: round3(g.end),
      duration_seconds: round2(g.end - g.start),
      hook_type: g.hook_type,
      key_moment_refs: g.key_moment_refs,
      reason: buildReason(g),
      suggested_title: suggestTitle(g, speechSorted),
      components: g.components,
    }));

  return {
    candidates,
    notes: notesString(notes),
    stats: {
      seeds: speechSorted.length,
      grown: grown.length,
      below_threshold: belowThreshold,
      proposed: candidates.length,
      target_band: { min_seconds: round2(band.min), mid_seconds: round2(band.mid), max_seconds: round2(band.max) },
    },
  };
}

function emptyStats() {
  return { seeds: 0, grown: 0, below_threshold: 0, proposed: 0, target_band: null };
}

function notesString(arr) {
  const list = (Array.isArray(arr) ? arr : []).filter((s) => typeof s === "string" && s.trim());
  return list.length ? list.join("; ") : "";
}

function buildReason(g) {
  const parts = [];
  if (g.hook_type && g.hook_type !== "none") parts.push(`${g.hook_type.replace(/_/g, " ")} hook`);
  else parts.push("strong opening take");
  const tier = isNum(g.delivery) ? (g.delivery >= 0.66 ? "strong" : g.delivery >= 0.4 ? "solid" : "uneven") : null;
  if (tier) parts.push(`${tier} sustained delivery`);
  if (g.key_moment_refs && g.key_moment_refs.length > 0) {
    parts.push(`covers key moment ${g.key_moment_refs.map((r) => r.label).join(", ")}`);
  }
  return capitalize(parts.join("; "));
}

// A hint only (the storyboarder/composer own the real title). First ~8 words of
// the seed's hook sentence (or the window's opening transcript), cleaned up.
function suggestTitle(g, speechSorted) {
  let text = typeof g.hook_text === "string" && g.hook_text.trim() ? g.hook_text : null;
  if (!text) {
    const opener = speechSorted.find((s) => Math.abs(s.start_seconds - g.start) < 1.5 && typeof s.transcript_text === "string" && s.transcript_text.trim());
    text = opener ? opener.transcript_text : null;
  }
  if (!text) return null;
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  const cleaned = words.replace(/[.,;:!?…"']+$/g, "").trim();
  return cleaned ? capitalize(cleaned) : null;
}

function capitalize(s) {
  const str = String(s == null ? "" : s).trim();
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

module.exports = {
  discoverHighlights,
  // exposed for tests / tuning
  resolveTargetBand,
  growWindow,
  snapStart,
  snapEnd,
  hookPullAt,
  keyMomentRefs,
  DEFAULT_COUNT,
  MAX_HIGHLIGHTS,
  DEFAULT_TARGET_SECONDS,
  DEFAULT_MIN_SECONDS,
  DEFAULT_MAX_SECONDS,
  MIN_WINDOW_SCORE,
  OVERLAP_FRACTION,
};
