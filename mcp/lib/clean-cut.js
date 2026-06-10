"use strict";

// Transcript-driven clean cut. Turns a word-level transcript (+ optional audio
// silence map) into a list of KEEP spans of the source that, concatenated, give
// a clean continuous voiceover — fillers, dead air, and flubbed retakes removed.
//
// Signals and why both are needed:
//   - Whisper-style ASR DROPS non-lexical fillers ("um"/"uh") and its word
//     timings are LOOSE (they overcover, bridging real pauses). So word gaps
//     alone under-detect dead air.
//   - ffmpeg `silencedetect` accurately marks quiet regions, but at a sane noise
//     floor it also flags inter-syllable quiet inside speech.
// The fix: cut LONG silences but PROTECT every transcribed (kept) word with a
// small pad. Cutting (silence âˆ’ protected-words) removes only the dead air
// BETWEEN phrases — and the untranscribed "um" that lives in that dead air goes
// with it. A filler LEXICON catches fillers the ASR did transcribe; a RETAKE
// detector drops an earlier flubbed take when a cleaner near-duplicate follows
// ("always take the best one that uses the proper words").
//
// With no silence map, falls back to cutting inter-word gaps > maxGapSeconds.
// Output spans are in SOURCE time; buildTimeline() maps source -> compressed
// output time so callers can re-time B-roll and captions.

const DEFAULT_FILLERS = new Set([
  "um", "uh", "er", "ah", "eh", "hmm", "mm", "mhm", "umm", "uhh", "uhm",
  "erm", "hm", "huh", "mmm", "uhhuh", "mmhmm",
]);

// Discourse fillers OFF by default — deleting "like"/"so"/"you know" mid-sentence
// risks breaking grammar. Enable via options.removeDiscourseFillers.
const DISCOURSE_SINGLE = new Set([
  "like", "basically", "actually", "literally", "honestly", "right",
]);

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9']/g, "");
}
function isNum(n) { return typeof n === "number" && Number.isFinite(n); }

const DEFAULTS = Object.freeze({
  minSilenceCutSeconds: 0.5,  // only silences this long (or longer) are cut
  maxWordsInSilence: 1,       // cut a silence only if <= this many word-midpoints fall inside
                              // (dead air has <=1 loose word spanning it; quiet speech is dense)
  maxGapSeconds: 0.6,         // fallback when no silence map: word gap > this is cut
  silenceEdgePadSeconds: 0.08,// leave this much silence at each cut edge (natural breath)
  wordProtectPadSeconds: 0.1, // (fallback path only) keep this much audio around kept words
  minCutSeconds: 0.18,        // ignore cut fragments shorter than this
  mergeGapSeconds: 0.14,      // merge kept spans separated by less than this
  minSpanSeconds: 0.2,        // drop kept spans shorter than this
  removeDiscourseFillers: false,
  retakeMinWords: 3,
  retakeMaxGapSeconds: 6,
});

// ---- interval algebra over [{start,end}] (ascending, disjoint after merge) ----
function mergeIntervals(list) {
  const xs = list.filter((i) => i && i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const x of xs) {
    const prev = out[out.length - 1];
    if (prev && x.start <= prev.end) prev.end = Math.max(prev.end, x.end);
    else out.push({ ...x });
  }
  return out;
}
// from âˆ’ minus  (both will be merged internally)
function subtractIntervals(from, minus) {
  const f = mergeIntervals(from);
  const m = mergeIntervals(minus);
  const out = [];
  for (const seg of f) {
    let cursor = seg.start;
    for (const cut of m) {
      if (cut.end <= cursor || cut.start >= seg.end) continue;
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start, seg.end) });
      cursor = Math.max(cursor, cut.end);
      if (cursor >= seg.end) break;
    }
    if (cursor < seg.end) out.push({ start: cursor, end: seg.end });
  }
  return out.filter((i) => i.end > i.start);
}

function computeCleanSpans({ words, durationSeconds = null, silences = [], options = {} } = {}) {
  const o = { ...DEFAULTS, fillers: DEFAULT_FILLERS, ...options };
  const fillers = o.fillers instanceof Set ? o.fillers : new Set(o.fillers || []);

  const src = (Array.isArray(words) ? words : [])
    .filter((w) => w && isNum(w.start) && isNum(w.end) && w.end > w.start)
    .slice().sort((a, b) => a.start - b.start);

  const removed = [];
  if (src.length === 0) return { keepSpans: [], removed, stats: emptyStats() };
  const dur = isNum(durationSeconds) ? durationSeconds : src[src.length - 1].end + o.wordProtectPadSeconds;

  // 1) Filler-lexicon words -> forced cuts (not protected, not kept).
  const fillerCuts = [];
  const afterFillers = [];
  for (const w of src) {
    const n = norm(w.text);
    if (fillers.has(n) || (o.removeDiscourseFillers && DISCOURSE_SINGLE.has(n))) {
      fillerCuts.push({ start: w.start, end: w.end });
      removed.push({ start: w.start, end: w.end, reason: fillers.has(n) ? "filler_word" : "discourse_filler", text: w.text });
    } else {
      afterFillers.push(w);
    }
  }

  // 2) Retake detection: an L-word normalized run (L >= retakeMinWords)
  //    immediately followed by an equal run -> drop the EARLIER run.
  const toks = afterFillers.map((w) => norm(w.text));
  const flagged = new Set();
  const maxLen = Math.min(12, Math.floor(afterFillers.length / 2));
  for (let len = maxLen; len >= o.retakeMinWords; len--) {
    for (let i = 0; i + 2 * len <= afterFillers.length; i++) {
      let already = false;
      for (let k = 0; k < len; k++) if (flagged.has(i + k) || flagged.has(i + len + k)) { already = true; break; }
      if (already) continue;
      let match = true;
      for (let k = 0; k < len; k++) if (!toks[i + k] || toks[i + k] !== toks[i + len + k]) { match = false; break; }
      if (!match) continue;
      if (afterFillers[i + len].start - afterFillers[i + len - 1].end <= o.retakeMaxGapSeconds) {
        for (let k = 0; k < len; k++) flagged.add(i + k);
      }
    }
  }
  const retakeCuts = [];
  const keptWords = [];
  for (let i = 0; i < afterFillers.length; i++) {
    if (flagged.has(i)) { retakeCuts.push({ start: afterFillers[i].start, end: afterFillers[i].end }); removed.push({ start: afterFillers[i].start, end: afterFillers[i].end, reason: "retake", text: afterFillers[i].text }); }
    else keptWords.push(afterFillers[i]);
  }

  // 3) Dead-air cuts. TRUST the silence map, not word timings: Whisper word
  //    boundaries are unreliable across pauses (it will timestamp a single
  //    "word" across a 2.5s silence), so protecting by word spans would leave
  //    the dead air in. Cut each silence trimmed by silenceEdgePad so we keep a
  //    natural breath and never clip the word that abuts the silence.
  let deadAir;
  const sil = mergeIntervals((Array.isArray(silences) ? silences : []).filter((s) => s && isNum(s.start) && isNum(s.end)))
    .filter((s) => s.end - s.start >= o.minSilenceCutSeconds);
  if (sil.length > 0) {
    // Density gate: a silence is real dead air only if at most maxWordsInSilence
    // transcribed word-midpoints fall inside it. Whisper bridges a pause into one
    // loose word (<=1 midpoint -> cut); genuinely quiet SPEECH is densely packed
    // with words (many midpoints -> keep). dB level alone can't tell them apart.
    // Count words whose BODY overlaps the silence at all (no edge tolerance): a
    // word straddling a silence edge must still count, else dropping it from the
    // count flips KEEP->CUT and the cut clips that very word. >1 overlapping word
    // => real (quiet) speech => keep; <=1 => a single loose word bridging a pause
    // => dead air => cut.
    const overlaps = (s) => keptWords.filter((w) => w.end > s.start && w.start < s.end).length;
    deadAir = sil
      .filter((s) => overlaps(s) <= o.maxWordsInSilence)
      .map((s) => ({ start: s.start + o.silenceEdgePadSeconds, end: s.end - o.silenceEdgePadSeconds }))
      .filter((c) => c.end - c.start >= o.minCutSeconds);
  } else {
    // fallback (no silence map): inter-word gaps > maxGapSeconds, padded.
    deadAir = [];
    for (let i = 1; i < keptWords.length; i++) {
      const gap = keptWords[i].start - keptWords[i - 1].end;
      if (gap > o.maxGapSeconds) deadAir.push({ start: keptWords[i - 1].end + o.wordProtectPadSeconds, end: keptWords[i].start - o.wordProtectPadSeconds });
    }
    deadAir = deadAir.filter((c) => c.end - c.start >= o.minCutSeconds);
  }
  for (const c of deadAir) removed.push({ start: +c.start.toFixed(3), end: +c.end.toFixed(3), reason: "gap", text: null });

  // 4) keep = [0,dur] âˆ’ (filler + retake + dead-air); clamp, merge, drop tiny.
  const allCuts = mergeIntervals([...fillerCuts, ...retakeCuts, ...deadAir]);
  let keep = subtractIntervals([{ start: 0, end: dur }], allCuts);
  // merge close + drop tiny
  const merged = [];
  for (const s of keep) {
    const prev = merged[merged.length - 1];
    if (prev && s.start - prev.end <= o.mergeGapSeconds) prev.end = s.end;
    else merged.push({ ...s });
  }
  const spans = merged
    .filter((s) => s.end - s.start >= o.minSpanSeconds)
    .map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), text: labelSpan(s, keptWords) }));

  const keptSeconds = spans.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    keepSpans: spans,
    removed,
    stats: {
      source_seconds: +dur.toFixed(3),
      kept_seconds: +keptSeconds.toFixed(3),
      removed_seconds: +(dur - keptSeconds).toFixed(3),
      compression_ratio: +(keptSeconds / dur).toFixed(3),
      span_count: spans.length,
      words_total: src.length,
      words_kept: keptWords.length,
      fillers_removed: removed.filter((r) => r.reason === "filler_word" || r.reason === "discourse_filler").length,
      retakes_removed: removed.filter((r) => r.reason === "retake").length,
      gaps_cut: removed.filter((r) => r.reason === "gap").length,
      silence_driven: sil.length > 0,
    },
  };
}

function labelSpan(span, words) {
  const inside = words.filter((w) => w.end > span.start && w.start < span.end).map((w) => w.text);
  return inside.join(" ");
}

function emptyStats() {
  return { source_seconds: 0, kept_seconds: 0, removed_seconds: 0, compression_ratio: 0, span_count: 0, words_total: 0, words_kept: 0, fillers_removed: 0, retakes_removed: 0, gaps_cut: 0, silence_driven: false };
}

// Removed (non-kept) time inside [start,end], from a keep_spans list.
// For plan lint: an a_roll clip straddles a removed span when seconds > threshold.
function removedWithin(keepSpans, start, end) {
  if (!Array.isArray(keepSpans) || !isNum(start) || !isNum(end) || end <= start) {
    return { intervals: [], seconds: 0 };
  }
  const intervals = subtractIntervals([{ start, end }], keepSpans);
  const seconds = +intervals.reduce((a, i) => a + (i.end - i.start), 0).toFixed(3);
  return { intervals, seconds };
}

// Map source time -> compressed output time. keepSpans ascending, disjoint.
function buildTimeline(keepSpans) {
  const spans = (Array.isArray(keepSpans) ? keepSpans : []).slice().sort((a, b) => a.start - b.start);
  let acc = 0;
  const segments = spans.map((s) => {
    const seg = { srcStart: s.start, srcEnd: s.end, compStart: acc, compEnd: acc + (s.end - s.start), text: s.text };
    acc = seg.compEnd;
    return seg;
  });
  const totalSeconds = acc;
  function mapSourceToComp(t) {
    for (const seg of segments) if (t >= seg.srcStart && t <= seg.srcEnd) return seg.compStart + (t - seg.srcStart);
    for (const seg of segments) if (t < seg.srcStart) return seg.compStart;
    return totalSeconds;
  }
  return { totalSeconds: +totalSeconds.toFixed(3), segments, mapSourceToComp };
}

module.exports = { computeCleanSpans, buildTimeline, mergeIntervals, subtractIntervals, removedWithin, DEFAULT_FILLERS, DEFAULTS };
