"use strict";

// INSPECT digest + hook-candidate ranking. PURE module — no I/O, no requires —
// so both functions are unit-testable without a fixture. inspect.js calls them
// at the end of runInspect and writes the markdown to inspect/digest.md, the
// compact handoff the orchestrator reads INSTEAD of N thumbnail singles.

// --- hook-candidate scoring (weights are normative; see spec D5) -------------

const INTERROGATIVE_RE = /^(who|what|when|where|why|how|did|do|does|is|are|can|could|would|should|have|has|will)$/i;
const QUESTION_END_RE = /\?["')\]]*\s*$/;
const NUMBER_WORD_RE = /\b(hundred|thousand|million|billion|percent|half|double|triple|times)\b/i;
const CLAIM_RE = /\b(never|always|nobody|no one|everyone|every|biggest|worst|best|only|secret|mistake|wrong|stop|truth|insane|crazy|free|hate|love|guarantee|warning|problem|nothing|impossible)\b/gi;
const SECOND_PERSON_RE = /\byou(r|rs)?\b/i;
const GREETING_RE = /^(hi|hey|hello|welcome|what's up|good (morning|afternoon|evening)|today (i|we)|in this video|so today|my name is|i('m| am) (going to|gonna))/i;
const SENTENCE_END_RE = /[.?!]["')\]]*$/;

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

function distinctClaimCount(text) {
  CLAIM_RE.lastIndex = 0;
  const seen = new Set();
  let m;
  while ((m = CLAIM_RE.exec(text)) !== null) seen.add(m[1].toLowerCase());
  return seen.size;
}

function containingParagraph(paragraphs, start) {
  for (const p of Array.isArray(paragraphs) ? paragraphs : []) {
    if (p && isNum(p.start) && isNum(p.end) && start >= p.start - 1e-3 && start <= p.end + 1e-3) {
      return p;
    }
  }
  return null;
}

/**
 * Rank cold-open hook candidates from the winner file's transcript.
 *
 * @param {object} args
 * @param {Array|null} args.words           canonical [{text,start,end,p?}]
 * @param {Array}      args.paragraphs      [{n,start,end,text}] (or [])
 * @param {Array|null} args.energyWindows   [{t,rms_db}] 0.5s windows (or null)
 * @param {number|null} args.durationSeconds source duration
 * @returns {Array} ≤5 entries: {rank, score, start_seconds, end_seconds, paragraph, text, signals}
 */
function rankHookCandidates({ words, paragraphs, energyWindows, durationSeconds } = {}) {
  const sentences = assembleSentences(words);
  if (sentences.length === 0) return [];

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
    const signals = [];
    let score = 0;
    const firstWord = (s.text.split(/\s+/)[0] || "").replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
    if (QUESTION_END_RE.test(s.text) || INTERROGATIVE_RE.test(firstWord)) {
      score += 2.0; signals.push("question");
    }
    if (/\d/.test(s.text) || NUMBER_WORD_RE.test(s.text)) {
      score += 1.0; signals.push("number");
    }
    const claims = distinctClaimCount(s.text);
    if (claims > 0) {
      score += Math.min(claims, 2); signals.push("claim");
    }
    if (SECOND_PERSON_RE.test(s.text)) {
      score += 0.5; signals.push("second_person");
    }
    const para = containingParagraph(paragraphs, s.start);
    if (para && s.start <= para.start + 0.75) {
      score += 0.75; signals.push("paragraph_start");
    }
    if (isNum(durationSeconds) && s.start <= 0.2 * durationSeconds) {
      score += 0.5; signals.push("early");
    }
    if (windows.length > 0) {
      // Window midpoint t+0.25 inside [start,end) attributes it to this sentence.
      const hits = windows.filter((w) => w.t + 0.25 >= s.start && w.t + 0.25 < s.end);
      if (hits.length > 0) {
        const mean = hits.reduce((a, w) => a + w.rms_db, 0) / hits.length;
        const z = sigma > 0 ? (mean - mu) / sigma : 0;
        if (z >= 1.0) {
          score += 1.0; signals.push("energy_high");
        } else if (z >= 0) {
          score += 0.5; signals.push("energy_above_avg");
        }
      }
    }
    if (s.word_count < 5) {
      score -= 1.0; signals.push("short_penalty");
    }
    if (s.word_count > 25) {
      score -= 0.5; signals.push("long_penalty");
    }
    if (GREETING_RE.test(s.text)) {
      score -= 3.0; signals.push("greeting_penalty");
    }
    return { sentence: s, score, signals, paragraph: para ? para.n : null };
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
  for (const h of hooks) {
    const para = h.paragraph != null ? `¶${h.paragraph}, ` : "";
    lines.push(`${h.rank}. **[${fmtMmSsT(h.start_seconds)}–${fmtMmSsT(h.end_seconds)}]** (${para}score ${h.score.toFixed(2)}; ${h.signals.join(", ")})`);
    lines.push(`   "${h.text}"`);
  }
  return lines.join("\n");
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
    lines.push("| seg | span | dur | type | energy | wpm | words |");
    lines.push("|-----|------|-----|------|--------|-----|-------|");
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
        lines.push(`| ${label} | ${fmtMmSsT(seg.start_seconds)}–${fmtMmSsT(last.end_seconds)} | ${(last.end_seconds - seg.start_seconds).toFixed(1)} | silence | ${isNum(seg.energy_rms_db) ? seg.energy_rms_db : "—"} | — | |`);
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
      lines.push(`| ${seg.index} | ${fmtMmSsT(seg.start_seconds)}–${fmtMmSsT(seg.end_seconds)} | ${seg.duration_seconds.toFixed(1)} | ${type} | ${isNum(seg.energy_rms_db) ? seg.energy_rms_db : "—"} | ${isNum(seg.speech_rate_wpm) ? seg.speech_rate_wpm : "—"} | ${words} |`);
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
    segmentTableSection(fileSummaries),
    audioSection(audio),
    visualIndexSection(strips, thumbs),
    captionRiskSection(lowConfidenceWords),
  ].join("\n\n") + "\n";
}

module.exports = { rankHookCandidates, buildInspectDigest };
