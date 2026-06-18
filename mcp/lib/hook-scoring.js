"use strict";

// Semantic hook scoring (v3.9) — rhetorical hook-archetype classification +
// scoring for cold-open candidate ranking. PURE module: no I/O, no requires, so
// it is unit-testable from synthetic inputs (the `hook` walker phase does exactly
// that). `inspect-digest.js::rankHookCandidates` assembles sentences from the
// winner file's transcript, computes each sentence's CONTEXT signals (energy
// z-score vs the file, paragraph-start, early-in-file, overlapping take-quality
// strength) and feeds (text + context) through `scoreHook()`; the returned
// {score, signals, hook_type, components} supersede the legacy inline lexicon.
//
// Why this is a faithful SUPERSET: in legacy mode ({enriched:false}) scoreHook
// reproduces the exact weights the old inline scorer used (question +2, number
// +1, claim +≤2, second_person +0.5, paragraph_start +0.75/1.0, early +0.5/1.0,
// energy +1.0/1.5 or +0.5/0.75, short -1, long -0.5, greeting -3), so
// VOB_HOOK_SCORING=off is byte-equivalent to the pre-v3.9.x ranking. Enriched
// mode (the default) ADDS rhetorical hook archetypes (curiosity gap, promise,
// contrarian, stakes), a self-containment adjustment (a cold-open that opens
// mid-thought is weaker), a specificity bonus, and a take-quality strength blend
// (a well-delivered line is a better hook) — all additive, all bounded.
//
// Crosslingual & fail-safe: the STRUCTURAL signals (question punctuation incl.
// fullwidth ？, digits, length, paragraph-start, early, energy, strength) score
// in any language; the English PHRASE families gate to English (a non-English
// source leans on the structural signals, exactly as the legacy scorer did, so
// the ranking never degrades vs today). Every missing input is simply skipped.

// --- the hook archetypes (priority order: strongest cold-open type first) ----
// hook_type is the dominant matched family; ties break by this order. `none`
// means no recognized rhetorical pattern (the candidate ranked on structure
// alone — energy/position/strength).
// Priority order for picking the DOMINANT hook_type when a sentence matches
// several families: concrete signals first (question, number), then the SPECIFIC
// multiword rhetorical structures (curiosity gap / contrarian / stakes / promise)
// — these are deliberate hook constructions — then the GENERIC single-word
// signals (a lone superlative ⇒ bold_claim, a lone "you" ⇒ direct_address) as the
// catch-all. (Affects only the label, never the score.)
const HOOK_TYPES = Object.freeze([
  "question",        // poses the loop the video answers
  "number_stat",     // a concrete figure / "N ways" / "%" / "$"
  "curiosity_gap",   // withholds the payoff ("here's what nobody tells you")
  "contrarian",      // pattern interrupt ("actually", "everyone thinks … but")
  "stakes",          // negative / loss-framed ("the #1 mistake", "stop", "don't")
  "promise",         // value-forward ("how to", "by the end you'll")
  "bold_claim",      // superlative / absolute ("never", "the only", "#1")
  "direct_address",  // second person early ("you", "your")
  "none",
]);

// --- legacy lexical regexes (moved here from inspect-digest.js, verbatim) -----
const INTERROGATIVE_RE = /^(who|what|when|where|why|how|did|do|does|is|are|can|could|would|should|have|has|will)$/i;
const NUMBER_WORD_RE = /\b(hundred|thousand|million|billion|percent|half|double|triple|times)\b/i;
const CLAIM_RE = /\b(never|always|nobody|no one|everyone|every|biggest|worst|best|only|secret|mistake|wrong|stop|truth|insane|crazy|free|hate|love|guarantee|warning|problem|nothing|impossible)\b/gi;
const SECOND_PERSON_RE = /\byou(r|rs)?\b/i;
const GREETING_RE = /^(hi|hey|hello|welcome|what's up|good (morning|afternoon|evening)|today (i|we)|in this video|so today|my name is|i('m| am) (going to|gonna))/i;
// Question punctuation is language-agnostic (incl. fullwidth ？ and CJK
// sentence-final question particles 吗/呢/吧 followed by ？).
const QUESTION_PUNCT_RE = /[?？]["')\]]*\s*$/;

// --- NEW v3.9 rhetorical families (English phrase patterns) ------------------
// Multiword, deliberately low-overlap with the single CLAIM_RE words so the new
// signal is mostly additive rather than double-counting.
const CURIOSITY_RE = /\b(the secret|nobody (tells|talks)|no one (tells|talks)|here'?s (why|what|how|the)|the real reason|the truth (about|is)|turns out|what if|you won'?t believe|this is why|the catch|what they don'?t|until you|the reason (why|that))\b/i;
const PROMISE_RE = /\b(how to|i'?ll show you|i will show you|you'?ll (learn|see|get|know|be able)|by the end|here'?s how|the (easiest|fastest|best) way|step[ -]by[ -]step|the trick (to|is)|in (this|today'?s) (video|guide|tutorial))\b/i;
const CONTRARIAN_RE = /\b(actually|unpopular opinion|hot take|contrary to|the problem with|think again|everyone (thinks|says|does|believes)|most people (think|believe|get)|you'?ve been (doing|told)|forget everything)\b/i;
const STAKES_RE = /\b(mistake|don'?t|never (do|make)|avoid|warning|the danger|costly|before you|ruin|stop (doing|making|wasting)|you'?re (losing|wasting|killing))\b/i;
// CJK sentence-final question particles (a cheap crosslingual question signal).
const CJK_QUESTION_RE = /(吗|呢|吧)\s*[?？]?\s*$/;
// A leading dangling connective / pronoun ⇒ the line opens mid-thought, a weaker
// cold-open even when energetic. English-only (CJK fragmenting is unreliable).
const MID_THOUGHT_RE = /^(and|so|but|because|then|also|plus|however|anyway|which|that|it|they|this|these|those|he|she|we)\b/i;
// Self-contained declarative opener: a determiner / "there is" / a clear subject.
const SELF_CONTAINED_RE = /^(the|a|an|every|most|here'?s|there(?:'?s| (is|are))|why|what|how|when|did|do|does|is|are|can|i |we |you )/i;
// Specificity: a leading digit, a proper-noun-ish capitalized word mid-sentence,
// or a number+unit. Concrete openers out-hook vague ones.
const PROPER_NOUN_RE = /\b[A-Z][a-z]{2,}\b/;
const NUMBER_UNIT_RE = /\b\d+\s*(%|percent|x|seconds?|minutes?|hours?|days?|weeks?|months?|years?|dollars?|\$)/i;

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function distinctClaimCount(text) {
  CLAIM_RE.lastIndex = 0;
  const seen = new Set();
  let m;
  while ((m = CLAIM_RE.exec(text)) !== null) seen.add(m[1].toLowerCase());
  return seen.size;
}

/**
 * Classify a sentence into the rhetorical hook families it matches and return
 * the dominant hook_type + the lexical (text-derived) score contribution.
 *
 * @param {string} text
 * @param {boolean} isEnglish  gates the English phrase families
 * @param {boolean} enriched   when false, only the legacy families fire
 * @returns {{families:string[], hook_type:string, lexical:number, signals:string[]}}
 */
function classifyHook(text, isEnglish, enriched) {
  const t = String(text == null ? "" : text);
  const firstWord = (t.split(/\s+/)[0] || "").replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
  const signals = [];
  const families = [];
  let lexical = 0;

  // --- legacy families (preserved exactly) ---
  // The CJK sentence-final question particle is an ENRICHED-only signal so that
  // legacy mode (VOB_HOOK_SCORING=off) stays byte-equivalent to the pre-v3.9.x
  // scorer for non-English sources too.
  const isQuestion = QUESTION_PUNCT_RE.test(t)
    || (isEnglish && INTERROGATIVE_RE.test(firstWord))
    || (enriched && !isEnglish && CJK_QUESTION_RE.test(t));
  if (isQuestion) {
    lexical += 2.0; signals.push("question"); families.push("question");
  }
  const isNumber = /\d/.test(t) || (isEnglish && NUMBER_WORD_RE.test(t));
  if (isNumber) {
    lexical += 1.0; signals.push("number"); families.push("number_stat");
  }
  if (isEnglish) {
    const claims = distinctClaimCount(t);
    if (claims > 0) {
      lexical += Math.min(claims, 2); signals.push("claim"); families.push("bold_claim");
    }
    if (SECOND_PERSON_RE.test(t)) {
      lexical += 0.5; signals.push("second_person"); families.push("direct_address");
    }
  }

  // --- NEW rhetorical families (enriched mode, English phrases only) ---
  if (enriched && isEnglish) {
    if (CURIOSITY_RE.test(t)) { lexical += 1.5; signals.push("curiosity_gap"); families.push("curiosity_gap"); }
    if (PROMISE_RE.test(t)) { lexical += 1.0; signals.push("promise"); families.push("promise"); }
    if (CONTRARIAN_RE.test(t)) { lexical += 1.0; signals.push("contrarian"); families.push("contrarian"); }
    if (STAKES_RE.test(t)) { lexical += 1.0; signals.push("stakes"); families.push("stakes"); }
  }

  // Cap the cumulative lexical/family bonus so a keyword-stuffed ramble can't
  // out-rank a crisp claim purely on volume.
  if (lexical > 5.0) lexical = 5.0;

  // Dominant hook_type = the highest-priority matched family (HOOK_TYPES order).
  let hook_type = "none";
  for (const ty of HOOK_TYPES) {
    if (ty !== "none" && families.includes(ty)) { hook_type = ty; break; }
  }
  return { families, hook_type, lexical, signals };
}

/**
 * Score ONE cold-open candidate sentence. PURE — no env reads. The caller
 * supplies the CONTEXT signals it computed (energy z-score, paragraph-start,
 * early-in-file, overlapping take-quality strength) and whether the source is
 * English; this function owns the TEXT-derived scoring + the (faithful) folding
 * of the context contributions.
 *
 * @param {object} a
 * @param {string}  a.text
 * @param {number}  a.wordCount
 * @param {boolean} a.isEnglish
 * @param {number|null} [a.energyZ]          z-score of the sentence's energy vs the file (or null)
 * @param {boolean} [a.isParagraphStart]
 * @param {boolean} [a.isEarly]              starts within the first 20% of the file
 * @param {number|null} [a.strengthScore]    take-quality strength (0–1) overlapping the window, or null
 * @param {boolean} [a.enriched=true]        false ⇒ legacy weights only (VOB_HOOK_SCORING=off)
 * @returns {{score:number, signals:string[], hook_type:string, components:object}}
 */
function scoreHook({
  text,
  wordCount,
  isEnglish,
  energyZ = null,
  isParagraphStart = false,
  isEarly = false,
  strengthScore = null,
  enriched = true,
} = {}) {
  const t = String(text == null ? "" : text);
  const wc = isNum(wordCount) ? wordCount : t.split(/\s+/).filter(Boolean).length;
  const cls = classifyHook(t, !!isEnglish, !!enriched);
  const signals = cls.signals.slice();
  let score = cls.lexical;
  const components = { lexical: +cls.lexical.toFixed(3) };

  // --- context signals (faithful to the legacy scorer) ---
  if (isParagraphStart) {
    const pts = isEnglish ? 0.75 : 1.0;
    score += pts; signals.push("paragraph_start"); components.paragraph_start = pts;
  }
  if (isEarly) {
    const pts = isEnglish ? 0.5 : 1.0;
    score += pts; signals.push("early"); components.early = pts;
  }
  if (isNum(energyZ)) {
    if (energyZ >= 1.0) {
      const pts = isEnglish ? 1.0 : 1.5;
      score += pts; signals.push("energy_high"); components.energy = pts;
    } else if (energyZ >= 0) {
      const pts = isEnglish ? 0.5 : 0.75;
      score += pts; signals.push("energy_above_avg"); components.energy = pts;
    }
  }

  // --- length / greeting penalties (legacy) ---
  if (wc < 5) { score -= 1.0; signals.push("short_penalty"); }
  if (wc > 25) { score -= 0.5; signals.push("long_penalty"); }
  if (isEnglish && GREETING_RE.test(t)) { score -= 3.0; signals.push("greeting_penalty"); }

  // --- NEW v3.9 enrichments (additive, bounded) ---
  if (enriched) {
    // Self-containment: a cold-open that opens mid-thought is weaker; a clean
    // self-contained opener is stronger. English-only (CJK fragmenting unreliable).
    if (isEnglish) {
      if (MID_THOUGHT_RE.test(t)) {
        score -= 1.0; signals.push("mid_thought"); components.self_containment = -1.0;
      } else if (SELF_CONTAINED_RE.test(t)) {
        score += 0.5; signals.push("self_contained"); components.self_containment = 0.5;
      }
    }
    // Specificity: a concrete figure or a named entity out-hooks the vague.
    if (NUMBER_UNIT_RE.test(t) || (isEnglish && PROPER_NOUN_RE.test(t.replace(/^\S+\s*/, "")))) {
      score += 0.5; signals.push("specific"); components.specificity = 0.5;
    }
    // Strength blend: a well-delivered line is a better hook (and a flubbed/quiet
    // one a worse one). Centered at 0.5 so a median take is neutral; bounded ±0.5.
    if (isNum(strengthScore)) {
      const adj = Math.max(-0.5, Math.min(0.5, (strengthScore - 0.5)));
      score += adj; components.strength = +adj.toFixed(3);
      if (adj >= 0.2) signals.push("strong_take");
      else if (adj <= -0.2) signals.push("weak_take");
    }
  }

  return { score, signals, hook_type: cls.hook_type, components };
}

module.exports = {
  HOOK_TYPES,
  classifyHook,
  scoreHook,
  // exported so inspect-digest can reuse the canonical regexes if needed
  INTERROGATIVE_RE,
  QUESTION_PUNCT_RE,
};
