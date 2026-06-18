"use strict";

// INSPECT digest + hook-candidate ranking. PURE-ish module (no file I/O; it does
// `require("./hook-scoring")` — itself a pure, no-I/O scorer — so both functions
// stay unit-testable without a fixture). inspect.js calls them at the end of
// runInspect and writes the markdown to inspect/digest.md, the compact handoff
// the orchestrator reads INSTEAD of N thumbnail singles.

const { scoreHook } = require("./hook-scoring");

// --- sentence assembly for hook ranking --------------------------------------
// The hook LEXICON + rhetorical-archetype scoring lives in hook-scoring.js (the
// v3.9 semantic scorer). Here we only assemble sentences and compute the
// per-sentence CONTEXT signals (energy z-score, paragraph-start, early-in-file,
// overlapping take strength) that we hand to scoreHook().

// Terminal punctuation INCLUDES CJK fullwidth stops (。？！) so non-English
// sentences flush on punctuation rather than only on gaps/the 30-word cap.
const SENTENCE_END_RE = /[.?!。？！]["')\]]*$/;

const MAX_SENTENCE_WORDS = 30;
const SENTENCE_GAP_SECONDS = 1.0;
const MIN_HOOK_SCORE = 1.0;
const MAX_HOOK_CANDIDATES = 5;

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function truncateText(text, max) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Walk words in start order, flushing a sentence on terminal punctuation, a
// >1s gap to the next word, or a 30-word cap. Sentences under 3 words are noise.
function assembleSentences(words) {
  const src = (Array.isArray(words) ? words : [])
    .filter((w) => w && typeof w.text === "string" && isNum(w.start) && isNum(w.end))
    .slice()
    .sort((a, b) => a.start - b.start);
  const sentences = [];
  let cur = null;
  for (let i = 0; i < src.length; i += 1) {
    const w = src[i];
    if (!cur) cur = { words: [], start: w.start, end: w.end };
    cur.words.push(w.text);
    cur.end = w.end;
    const next = src[i + 1];
    const flush = SENTENCE_END_RE.test(w.text.trim())
      || (next ? next.start - w.end > SENTENCE_GAP_SECONDS : true)
      || cur.words.length >= MAX_SENTENCE_WORDS;
    if (flush) {
      const text = cur.words.join(" ").replace(/\s+/g, " ").trim();
      if (cur.words.length >= 3 && text) {
        sentences.push({ text, start: cur.start, end: cur.end, word_count: cur.words.length });
      }
      cur = null;
    }
  }
  return sentences;
}

function containingParagraph(paragraphs, start) {
  for (const p of Array.isArray(paragraphs) ? paragraphs : []) {
    if (p && isNum(p.start) && isNum(p.end) && start >= p.start - 1e-3 && start <= p.end + 1e-3) {
      return p;
    }
  }
  return null;
}

// Max take-quality strength.score over the segments overlapping [start,end), or
// null when no scored segment overlaps. Lets a well-delivered candidate out-rank
// a flat one in enriched mode (segments carry the v3.9 take-quality `strength`).
function maxStrengthOverlap(segments, start, end) {
  if (!Array.isArray(segments)) return null;
  let best = null;
  for (const seg of segments) {
    if (!seg || !isNum(seg.start_seconds) || !isNum(seg.end_seconds)) continue;
    if (start < seg.end_seconds && end > seg.start_seconds) {
      const sc = seg.strength && isNum(seg.strength.score) ? seg.strength.score : null;
      if (sc != null && (best == null || sc > best)) best = sc;
    }
  }
  return best;
}

/**
 * Rank cold-open hook candidates from the winner file's transcript. The
 * per-sentence rhetorical scoring + archetype classification lives in
 * hook-scoring.js (the v3.9 semantic scorer); here we assemble sentences, compute
 * the per-sentence CONTEXT signals, and shape the ≤5 ranked candidates.
 *
 * @param {object} args
 * @param {Array|null} args.words           canonical [{text,start,end,p?}]
 * @param {Array}      args.paragraphs      [{n,start,end,text}] (or [])
 * @param {Array|null} args.energyWindows   [{t,rms_db}] 0.5s windows (or null)
 * @param {number|null} args.durationSeconds source duration
 * @param {string|null} args.language        detected language code (e.g. "en", "zh")
 * @param {Array|null} args.segments         winner file's segments (carry take `strength`); enriched-mode only
 * @returns {Array} ≤5 entries: {rank, score, start_seconds, end_seconds, paragraph, hook_type, text, signals}
 */
function rankHookCandidates({ words, paragraphs, energyWindows, durationSeconds, language, segments } = {}) {
  const sentences = assembleSentences(words);
  if (sentences.length === 0) return [];

  // The lexical hook signals are English regexes (gated inside scoreHook); on a
  // non-English source the ranking leans on the language-agnostic ones (energy,
  // position, digits, question punctuation, take strength). VOB_HOOK_SCORING=off
  // disables the v3.9 enrichments and reproduces the legacy weights exactly.
  const isEnglish = !language || /^en/i.test(String(language));
  const enriched = !/^off$/i.test(String(process.env.VOB_HOOK_SCORING || ""));

  // File-level energy stats (population σ); skipped entirely without windows.
  const windows = Array.isArray(energyWindows)
    ? energyWindows.filter((w) => w && isNum(w.t) && isNum(w.rms_db))
    : [];
  let mu = null;
  let sigma = null;
  if (windows.length > 0) {
    mu = windows.reduce((a, w) => a + w.rms_db, 0) / windows.length;
    sigma = Math.sqrt(windows.reduce((a, w) => a + (w.rms_db - mu) ** 2, 0) / windows.length);
  }

  const scored = sentences.map((s) => {
    const para = containingParagraph(paragraphs, s.start);
    const isParagraphStart = !!(para && s.start <= para.start + 0.75);
    const isEarly = isNum(durationSeconds) && s.start <= 0.2 * durationSeconds;
    let energyZ = null;
    if (windows.length > 0) {
      // Window midpoint t+0.25 inside [start,end) attributes it to this sentence.
      const hits = windows.filter((w) => w.t + 0.25 >= s.start && w.t + 0.25 < s.end);
      if (hits.length > 0) {
        const mean = hits.reduce((a, w) => a + w.rms_db, 0) / hits.length;
        energyZ = sigma > 0 ? (mean - mu) / sigma : 0;
      }
    }
    const strengthScore = enriched ? maxStrengthOverlap(segments, s.start, s.end) : null;
    const r = scoreHook({
      text: s.text,
      wordCount: s.word_count,
      isEnglish,
      energyZ,
      isParagraphStart,
      isEarly,
      strengthScore,
      enriched,
    });
    return { sentence: s, score: r.score, signals: r.signals, hook_type: r.hook_type, paragraph: para ? para.n : null };
  });

  return scored
    .filter((c) => c.score >= MIN_HOOK_SCORE)
    .sort((a, b) => b.score - a.score || a.sentence.start - b.sentence.start)
    .slice(0, MAX_HOOK_CANDIDATES)
    .map((c, i) => ({
      rank: i + 1,
      score: +c.score.toFixed(2),
      start_seconds: +c.sentence.start.toFixed(3),
      end_seconds: +c.sentence.end.toFixed(3),
      paragraph: c.paragraph,
      hook_type: c.hook_type,
      text: truncateText(c.sentence.text, 200),
      signals: c.signals,
    }));
}

// --- digest markdown ---------------------------------------------------------

const MAX_PARAGRAPH_LINES = 30;
const MAX_SEGMENT_ROWS_PER_FILE = 40;

function baseName(p) {
  const s = String(p == null ? "" : p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function fmtDuration(s) { // "4:12"
  if (!isNum(s) || s < 0) return "—";
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function fmtMmSs(s) { // "01:24"
  if (!isNum(s) || s < 0) return "00:00";
  const total = Math.floor(s);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function fmtMmSsT(s) { // "00:14.2"
  if (!isNum(s) || s < 0) return "00:00.0";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
}

function filesSection({ manifestFiles, fileSummaries, transcripts, sceneDetectionSkipped }) {
  const summariesByIndex = new Map(
    (Array.isArray(fileSummaries) ? fileSummaries : []).map((f) => [f.file_index, f]),
  );
  const transcriptsByIndex = new Map(
    (Array.isArray(transcripts) ? transcripts : []).map((t) => [t.file_index, t]),
  );
  const lines = [
    "## Files",
    "| # | file | duration | res@fps | prior | segments | speech | LUFS | notes |",
    "|---|------|----------|---------|-------|----------|--------|------|-------|",
  ];
  const files = Array.isArray(manifestFiles) ? manifestFiles : [];
  files.forEach((file, i) => {
    const fs = summariesByIndex.get(i) || null;
    const tr = transcriptsByIndex.get(i) || null;
    const hasVideo = file && (file.has_video === true || Number(file.video_streams) > 0);
    const hasAudio = file && (file.has_audio === true || Number(file.audio_streams) > 0);
    const res = file && file.resolution ? `${file.resolution}${isNum(file.fps) ? `@${file.fps}` : ""}` : "—";
    const segs = fs && Array.isArray(fs.segments) ? fs.segments : [];
    const silent = segs.filter((s) => s && s.is_silence).length;
    const segCell = fs ? `${fs.segment_count}${silent > 0 ? ` (${silent} silent)` : ""}` : "—";
    const speech = fs && fs.transcript_word_count > 0 ? `${fs.transcript_word_count} w` : "—";
    const lufs = fs && fs.loudness && isNum(fs.loudness.lufs_integrated) ? String(fs.loudness.lufs_integrated) : "—";
    const notes = [];
    if (sceneDetectionSkipped && hasVideo) notes.push("scene detection skipped");
    // Surface low clip granularity so the storyboarder knows it can't cut on
    // shot boundaries (no scene cuts → silence-only partition of the file).
    const basis = fs && typeof fs.scene_detection_basis === "string" ? fs.scene_detection_basis : null;
    if (hasVideo && (basis === "single_shot" || basis === "silence_only")) {
      notes.push("single-shot/soft — silence-only segmentation (no shot-level cuts)");
    } else if (basis === "low_threshold_retry") {
      notes.push("soft cuts (low-threshold detect)");
    } else if (basis === "detect_failed") {
      notes.push("scene detect failed — silence-only");
    }
    if (tr && tr.path == null) notes.push(`transcription failed${tr.reason ? `: ${tr.reason}` : ""}`);
    if (hasAudio && !hasVideo) notes.push("audio-only");
    if (!hasAudio) notes.push("no audio");
    if (tr && tr.from_cache === true) notes.push("from cache");
    lines.push(`| ${i} | ${baseName(file && file.path)} | ${fmtDuration(file && Number(file.duration_seconds))} | ${res} | ${(file && file.prior) || "—"} | ${segCell} | ${speech} | ${lufs} | ${notes.join("; ")} |`);
  });
  return lines.join("\n");
}

function transcriptMapSection({ paragraphs, asr }) {
  const lines = ["## Transcript map"];
  const ps = Array.isArray(paragraphs) ? paragraphs : [];
  if (ps.length === 0) {
    lines.push(`n/a — ${(asr && asr.skippedReason) || "no transcript"}`);
    return lines.join("\n");
  }
  // Word-timing accuracy: aligned (forced alignment) is karaoke-grade; otherwise
  // native Whisper timestamps drift across pauses — snap cuts to silence times,
  // and word-by-word caption highlighting will be approximate.
  if (asr && asr.aligned === true) {
    lines.push(`Word timing: **aligned** (forced alignment${asr.backend ? ` via ${asr.backend}` : ""}) — karaoke-grade, safe for word-by-word caption highlighting.`);
  } else {
    lines.push("Word timing: approximate (native timestamps — no alignment backend). Karaoke highlighting will drift; `pip install whisperx` for frame-accurate word timing.");
  }
  for (const p of ps.slice(0, MAX_PARAGRAPH_LINES)) {
    lines.push(`- ¶${p.n} [${fmtMmSs(p.start)}–${fmtMmSs(p.end)}] ${truncateText(p.text, 120)}`);
  }
  if (ps.length > MAX_PARAGRAPH_LINES) {
    lines.push(`(+${ps.length - MAX_PARAGRAPH_LINES} more — see transcript_summary.md)`);
  }
  return lines.join("\n");
}

function cleanSpeechSection(stats) {
  const lines = ["## Clean speech (filler/dead-air removal)"];
  if (!stats || !isNum(stats.source_seconds) || stats.source_seconds <= 0) {
    lines.push("n/a — clean-cut not computed (no transcript)");
    return lines.join("\n");
  }
  const pct = Math.round((stats.kept_seconds / stats.source_seconds) * 100);
  lines.push(`kept ${stats.kept_seconds.toFixed(1)}s of ${stats.source_seconds.toFixed(1)}s (${pct}%) · ${stats.span_count} spans · ${stats.fillers_removed} fillers · ${stats.retakes_removed} retakes · ${stats.gaps_cut} gaps cut`);
  lines.push("Plan a_roll cuts on keep-span boundaries: clean_speech.json `keep_spans` (source time).");
  return lines.join("\n");
}

// Hooks are ranked from the WINNER file's transcript — name it in the header
// so multi-file drops don't get the wrong file cited in the brief.
function hookCandidatesSection(hookCandidates, { transcribedFileIndex, manifestFiles } = {}) {
  const files = Array.isArray(manifestFiles) ? manifestFiles : [];
  const winner = isNum(transcribedFileIndex) && transcribedFileIndex >= 0 && files[transcribedFileIndex]
    ? ` (from file ${transcribedFileIndex} — ${baseName(files[transcribedFileIndex].path)})`
    : "";
  const lines = [`## Hook candidates${winner}`];
  const hooks = Array.isArray(hookCandidates) ? hookCandidates : [];
  if (hooks.length === 0) {
    lines.push("n/a — none scored ≥ 1.0 (or no transcript)");
    return lines.join("\n");
  }
  lines.push("Open scene 0 on the strongest — the `hook_type` (question / number_stat / bold_claim / curiosity_gap / contrarian / stakes / promise) names the archetype; realize it as the cold-open kinetic claim. Match the opening clip to a ranked candidate or note why you deviated.");
  for (const h of hooks) {
    const para = h.paragraph != null ? `¶${h.paragraph}, ` : "";
    const ht = h.hook_type && h.hook_type !== "none" ? `_${h.hook_type}_ ` : "";
    lines.push(`${h.rank}. **[${fmtMmSsT(h.start_seconds)}–${fmtMmSsT(h.end_seconds)}]** ${ht}(${para}score ${h.score.toFixed(2)}; ${h.signals.join(", ")})`);
    lines.push(`   "${h.text}"`);
  }
  return lines.join("\n");
}

// v3.9 — the take-quality leaderboard: the strongest scored takes across all
// files, ranked, so the storyboarder opens hooks / key beats on the BEST take of
// a moment (not just a spoken one). Full per-segment `strength` lives in
// segments.json; this is the digest-facing summary. Best-effort: "n/a" when
// take-quality is off or nothing scored.
function strongestTakesSection(takeQuality) {
  const lines = ["## Strongest takes"];
  const tq = takeQuality && typeof takeQuality === "object" ? takeQuality : null;
  if (!tq || !Array.isArray(tq.strongest) || tq.strongest.length === 0) {
    lines.push("n/a — no takes scored (take-quality off, or no scorable segments).");
    return lines.join("\n");
  }
  const med = isNum(tq.median_score) ? tq.median_score.toFixed(2) : "—";
  const visual = tq.visual_backend
    ? `visuals via ${tq.visual_backend}`
    : "audio-only (no visual heuristics this run)";
  lines.push(`${tq.scored_segments} scored — **${tq.strong} strong · ${tq.usable} usable · ${tq.weak} weak** (median ${med}; ${visual}).`);
  lines.push("Open hooks & key beats on the strongest; ranked across all files. The `take` column in the segment table (and `strength.flags` in segments.json) say why a weak take is weak.");
  lines.push("");
  lines.push("| rank | file | seg | span | score | tier |");
  lines.push("|------|------|-----|------|-------|------|");
  tq.strongest.slice(0, 8).forEach((t, k) => {
    const span = `${fmtMmSsT(t.start_seconds)}–${fmtMmSsT(t.end_seconds)}`;
    lines.push(`| ${k + 1} | ${t.file_index} | ${t.segment_index} | ${span} | ${isNum(t.score) ? t.score.toFixed(2) : "—"} | ${t.tier || "—"} |`);
  });
  return lines.join("\n");
}

// Compact per-segment take-quality cell: tier + score + the top couple of flags
// (the actionable "why" — low_energy / soft_focus / filler_heavy / …).
function takeCell(seg) {
  const st = seg && seg.strength;
  if (!st || !isNum(st.score)) return "—";
  const flags = Array.isArray(st.flags) && st.flags.length ? ` ${st.flags.slice(0, 2).join(",")}` : "";
  return `${st.tier || "?"} ${st.score.toFixed(2)}${flags}`;
}

function segmentTableSection(fileSummaries) {
  const lines = ["## Segment table"];
  const files = (Array.isArray(fileSummaries) ? fileSummaries : [])
    .filter((f) => f && Array.isArray(f.segments) && f.segments.length > 0);
  if (files.length === 0) {
    lines.push("n/a — no segments detected");
    return lines.join("\n");
  }
  for (const f of files) {
    lines.push(`### file ${f.file_index} — ${baseName(f.path)}`);
    lines.push("| seg | span | dur | type | energy | wpm | take | words |");
    lines.push("|-----|------|-----|------|--------|-----|------|-------|");
    const segs = f.segments;
    let nonSilence = 0;
    let omitted = 0;
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i];
      if (seg.is_silence) {
        // Collapse consecutive silences into one merged-span row.
        let j = i;
        while (j + 1 < segs.length && segs[j + 1].is_silence) j += 1;
        const last = segs[j];
        const label = j > i ? `${seg.index}–${last.index}` : String(seg.index);
        lines.push(`| ${label} | ${fmtMmSsT(seg.start_seconds)}–${fmtMmSsT(last.end_seconds)} | ${(last.end_seconds - seg.start_seconds).toFixed(1)} | silence | ${isNum(seg.energy_rms_db) ? seg.energy_rms_db : "—"} | — | — | |`);
        i = j + 1;
        continue;
      }
      if (nonSilence >= MAX_SEGMENT_ROWS_PER_FILE) {
        omitted += 1;
        i += 1;
        continue;
      }
      const type = seg.has_speech ? "speech" : "visual";
      const words = seg.transcript_text
        ? `"${truncateText(seg.transcript_text, 60)}" (${seg.word_count}w)`
        : "";
      lines.push(`| ${seg.index} | ${fmtMmSsT(seg.start_seconds)}–${fmtMmSsT(seg.end_seconds)} | ${seg.duration_seconds.toFixed(1)} | ${type} | ${isNum(seg.energy_rms_db) ? seg.energy_rms_db : "—"} | ${isNum(seg.speech_rate_wpm) ? seg.speech_rate_wpm : "—"} | ${takeCell(seg)} | ${words} |`);
      nonSilence += 1;
      i += 1;
    }
    if (omitted > 0) lines.push(`(+${omitted} more — see segments.json)`);
  }
  return lines.join("\n");
}

function visualIndexSection(strips, thumbs) {
  const stripCount = strips && isNum(strips.stripCount) ? strips.stripCount : 0;
  const failures = strips && isNum(strips.failures) ? strips.failures : 0;
  const thumbCount = thumbs && isNum(thumbs.count) ? thumbs.count : 0;
  const thumbsFailed = thumbs && isNum(thumbs.failed) ? thumbs.failed : 0;
  const lines = ["## Visual index"];
  if (stripCount > 0) {
    lines.push(`- strips: ${stripCount} strip(s) (≤12 cells each) at inspect/strips/ — cell→segment legend: strips/legend.json`);
  } else {
    lines.push("- strips: none — read per-segment stills directly");
  }
  lines.push("- per-segment stills (512w): inspect/segment_keyframes/file_<i>/seg_<n>.jpg");
  if (thumbCount > 0) {
    lines.push("- full thumbs (480w): inspect/thumbs/file_<i>/ · contact sheets: inspect/contact_sheet_file_<i>*.jpg");
  } else if (thumbs && thumbs.skipped === true) {
    lines.push("- full thumbs: skipped by request (skip_thumbnails) — ground from strips / per-segment stills");
  } else {
    lines.push("- full thumbs: none — ground from strips / per-segment stills");
  }
  const approx = thumbs && Array.isArray(thumbs.approximate) ? thumbs.approximate : [];
  if (thumbCount > 0 && approx.length > 0) {
    const desc = approx
      .map((a) => `file ${a.file_index}${isNum(a.est_gop_seconds) ? ` (±~${a.est_gop_seconds}s)` : ""}`)
      .join(", ");
    lines.push(`NB: keyframe-aligned thumbs for ${desc} — frames are real and fine for grounding, but frame_K shows the nearest keyframe at/before its grid second; snap cut points to transcript/silence times.`);
  }
  if (failures > 0) {
    lines.push(`WARNING: ${failures} strip(s) failed to build — read the listed segment keyframes individually.`);
  }
  if (thumbCount > 0 && thumbsFailed > 0) {
    lines.push(`WARNING: ${thumbsFailed} thumbnail grid slot(s) failed — filled with stand-in copies of neighboring frames (frame_K↔timestamp mapping unchanged; see inspect.json warnings).`);
  }
  return lines.join("\n");
}

// v3.2 P2 — per-file loudness/channel layout/balance + the −14 LUFS gain plan
// and the recommended clean voice track. `audio` is the compact summary from
// runAudioAnalysisPass (or null when the pass was disabled / found no audio).
function audioSection(audio) {
  const lines = ["## Audio"];
  if (!audio || !Array.isArray(audio.files) || audio.files.length === 0) {
    lines.push("n/a — audio analysis disabled or no audio streams");
    return lines.join("\n");
  }
  lines.push(`| # | LUFS | layout | balance | →${audio.target_lufs} LUFS | clip risk | flags |`);
  lines.push("|---|------|--------|---------|---------|-----------|-------|");
  for (const f of audio.files) {
    const flags = [];
    if (f.dead_channel) flags.push(`${f.dead_channel} dead`);
    if (f.out_of_phase) flags.push("out-of-phase");
    const gain = isNum(f.gain_to_target_db) ? `${f.gain_to_target_db > 0 ? "+" : ""}${f.gain_to_target_db} dB` : "—";
    lines.push(`| ${f.file_index} | ${isNum(f.lufs_integrated) ? f.lufs_integrated : "—"} | ${f.layout || "—"} | ${f.balance || "—"} | ${gain} | ${f.clip_risk ? "⚠ yes" : "no"} | ${flags.join(", ")} |`);
  }
  if (audio.clean_audio_source_index != null) {
    lines.push(`Recommended clean voice track: file ${audio.clean_audio_source_index}.`);
  }
  const advisories = [];
  if (audio.any_clip_risk) advisories.push("normalizing to target would clip — a limiter/true-peak pass is needed");
  if (audio.any_quiet) advisories.push("one or more files are quiet (large positive gain)");
  if (advisories.length) lines.push(`NB: ${advisories.join("; ")}. Full per-channel detail: inspect/audio_analysis.json.`);
  else lines.push("Per-channel detail + normalization advisory: inspect/audio_analysis.json.");
  return lines.join("\n");
}

function captionRiskSection(lowConfidenceWords) {
  const lines = ["## Caption risk (low-confidence words)"];
  const words = Array.isArray(lowConfidenceWords) ? lowConfidenceWords : [];
  if (words.length === 0) {
    lines.push("n/a — no confidence data");
    return lines.join("\n");
  }
  lines.push(words.map((w) => `"${w.text}" (${fmtMmSs(w.at_seconds)})`).join(" · "));
  lines.push("Verify spellings with the user before captions burn them in.");
  return lines.join("\n");
}

/**
 * Build inspect/digest.md. Sections appear in a fixed order; an empty input
 * keeps its heading with an "n/a — <reason>" line so consumers can rely on
 * section presence. Budget ≤~4k tokens for a 40-min source (caps: 30 paragraph
 * lines, 40 non-silence segment rows/file, 5 hooks, 15 caption-risk words).
 */
function buildInspectDigest({
  projectId,
  generatedAt,
  manifestFiles,
  fileSummaries,
  transcripts,
  paragraphs,
  cleanSpeechStats,
  hookCandidates,
  strips,
  thumbs,
  lowConfidenceWords,
  asr,
  audio,
  sceneDetectionSkipped,
  transcribedFileIndex,
  takeQuality,
} = {}) {
  const header = [
    `# INSPECT digest — ${projectId}`,
    "",
    `*Generated ${generatedAt}. Machine-readable: inspect.json · segments.json ·`,
    "strips/legend.json · transcripts/ · clean_speech.json.*",
  ].join("\n");

  return [
    header,
    filesSection({ manifestFiles, fileSummaries, transcripts, sceneDetectionSkipped }),
    transcriptMapSection({ paragraphs, asr }),
    cleanSpeechSection(cleanSpeechStats),
    hookCandidatesSection(hookCandidates, { transcribedFileIndex, manifestFiles }),
    strongestTakesSection(takeQuality),
    segmentTableSection(fileSummaries),
    audioSection(audio),
    visualIndexSection(strips, thumbs),
    captionRiskSection(lowConfidenceWords),
  ].join("\n\n") + "\n";
}

module.exports = { rankHookCandidates, buildInspectDigest };
