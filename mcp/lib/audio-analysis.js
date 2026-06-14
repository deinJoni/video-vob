"use strict";

// Per-channel loudness / balance / phase-correlation analysis at INSPECT.
//
// The point: capture once, at INSPECT, everything a later normalization step
// would need to make audio "broadcast-clean" a pure LOOKUP rather than a second
// full decode. We learn per-channel RMS/peak (astats), integrated loudness +
// true-peak (ebur128), and — for stereo — the running phase correlation
// (aphasemeter) that tells us if the two channels would mono-cancel.
//
// ONE decode pass per file (`-f null -`) carries the whole filter chain. Like
// silence-detector.js we tee stderr to a FILE rather than parsing the in-memory
// buffer: ebur128 prints ~1.7KB/s of momentary lines, which overflows the
// in-memory output cap on a long file and would truncate the EOF astats summary
// (the per-channel block we actually need). For the same reason the per-frame
// aphasemeter values go to a SEPARATE log file via `ametadata=mode=print` —
// there can be tens of thousands of them and they would drown everything else.
//
// This pass must NEVER abort INSPECT: every public function is wrapped so it
// degrades to a structured `{ ok:false, ... }` (or a null) instead of throwing.

const fs = require("fs");
const path = require("path");
const { runFfmpegBlocking } = require("./ffmpeg-runner.js");
// escapeFilterPath is exported by silence-detector.js — reuse the exact helper
// so ametadata file= escaping is identical across both passes.
const { escapeFilterPath } = require("./silence-detector.js");

const AUDIO_ANALYSIS_TARGET_LUFS = -14; // short-form platform reference level
const AUDIO_ANALYSIS_TRUE_PEAK_CEILING = -1; // dBTP ceiling after gain

// ebur128 summary fields, parsed identically to silence-detector's parseLoudness
// (last match wins → the EOF summary block when present; running value when the
// log got truncated; `nan` / no match → null).
const LUFS_RE = /I:\s*(-?[0-9.]+|nan)\s*LUFS/g;
const LRA_RE = /LRA:\s*(-?[0-9.]+|nan)\s*LU(?![A-Z])/g;
const TPK_RE = /(?:^|\s)Peak:\s*(-?[0-9.]+|nan)\s*dBFS/gm;

// astats per-channel lines. The "[Parsed_astats_<idx> @ 0x...]" prefix varies,
// so we anchor on the keyword (mirroring silence-detector's START_RE/END_RE).
// A value may be `-inf`/`inf` (a truly silent channel) — we capture it as a
// token and map it to null downstream, never 0 (a dead channel is NOT 0 dB).
const CHANNEL_RE = /\bChannel:\s*(\d+)/;
const OVERALL_RE = /\bOverall\b/;
const ASTATS_RMS_RE = /\bRMS level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i;
const ASTATS_PEAK_RE = /\bPeak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i;

// aphasemeter prints `lavfi.aphasemeter.phase=<num>` per frame into the phase log.
const PHASE_RE = /lavfi\.aphasemeter\.phase=(-?\d+(?:\.\d+)?)/g;

// Exotic ffmpeg build missing aphasemeter/astats/ebur128 → retry without the
// phase meter so the loudness contract never regresses (mirrors silence-detector).
const MISSING_FILTER_RE = /No such filter|Error reinitializing filters|Error initializing filter/i;

// --- tiny pure helpers -------------------------------------------------------

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function round1(n) {
  return isFiniteNum(n) ? Math.round(n * 10) / 10 : null;
}

function round3(n) {
  return isFiniteNum(n) ? Math.round(n * 1000) / 1000 : null;
}

// Map an astats dB token to a number. `-inf`/`inf` (and any non-finite) → null:
// a silent channel has no meaningful dB value, and 0 would be a loud LIE.
function dbTokenToNum(tok) {
  if (tok == null) return null;
  const s = String(tok).trim().toLowerCase();
  if (s === "-inf" || s === "inf" || s === "+inf" || s === "nan") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function audioAnalysisDisabled() {
  const knob = (process.env.VOB_DISABLE_AUDIO_ANALYSIS || "").trim().toLowerCase();
  return knob === "1" || knob === "on" || knob === "true" || knob === "yes";
}

// --- pure parsers ------------------------------------------------------------

// Walk astats EOF lines in order. `Channel: N` opens a new channel record; the
// FIRST RMS/Peak line within that channel wins (astats prints several stats per
// channel, RMS/Peak first). `Overall` ends the per-channel section — we ignore
// the Overall block for per-channel output. Returns one entry per numbered
// channel, ascending by channel index. PURE: no I/O.
function parseAstatsPerChannel(stderrText) {
  const lines = String(stderrText || "").split(/\r?\n/);
  const byChannel = new Map(); // channel number -> { channel, rms_db, peak_db }
  let current = null; // the record we're currently assigning RMS/Peak into
  let inOverall = false;

  for (const line of lines) {
    if (OVERALL_RE.test(line)) {
      // Stop assigning to channels once the Overall summary starts.
      inOverall = true;
      current = null;
      continue;
    }
    const cm = line.match(CHANNEL_RE);
    if (cm) {
      inOverall = false;
      const n = Number(cm[1]);
      if (Number.isFinite(n)) {
        if (!byChannel.has(n)) {
          byChannel.set(n, { channel: n, rms_db: null, peak_db: null });
        }
        current = byChannel.get(n);
      } else {
        current = null;
      }
      continue;
    }
    if (inOverall || !current) continue;

    // First RMS / first Peak within this channel wins.
    if (current.rms_db === null) {
      const rm = line.match(ASTATS_RMS_RE);
      if (rm) {
        current.rms_db = round1(dbTokenToNum(rm[1]));
        continue;
      }
    }
    if (current.peak_db === null) {
      const pm = line.match(ASTATS_PEAK_RE);
      if (pm) {
        current.peak_db = round1(dbTokenToNum(pm[1]));
        continue;
      }
    }
  }

  return [...byChannel.values()].sort((a, b) => a.channel - b.channel);
}

// Last-match-wins loudness parse, identical semantics to silence-detector.
function parseLoudness(stderrText) {
  const text = String(stderrText || "");
  const lastMatch = (re) => {
    re.lastIndex = 0;
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    return last;
  };
  const num = (s) => {
    if (s == null || s === "nan") return null;
    const n = Number(s);
    return Number.isFinite(n) ? round1(n) : null;
  };
  return {
    lufs_integrated: num(lastMatch(LUFS_RE)),
    lra_lu: num(lastMatch(LRA_RE)),
    true_peak_dbtp: num(lastMatch(TPK_RE)),
  };
}

// Mean of all per-frame phase values in the phase log, rounded to 3 places.
// aphasemeter reports correlation in [-1, 1] (1 = identical channels / mono,
// 0 = decorrelated, -1 = inverted / mono-cancelling). null when nothing parsed.
function parsePhaseCorrelation(phaseText) {
  const text = String(phaseText || "");
  PHASE_RE.lastIndex = 0;
  let m;
  let sum = 0;
  let count = 0;
  while ((m = PHASE_RE.exec(text)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  if (count === 0) return null;
  return round3(sum / count);
}

// --- the main pass -----------------------------------------------------------

// Build the decode filter chain. The phase meter rides only on (possibly)
// stereo files: aphasemeter REQUIRES ≥2 channels and is meaningless / errors on
// mono or >2 channels, so we add it only when channels===2 OR channels==null
// (unknown — let ffmpeg tell us, and the missing-filter retry covers the rest).
function buildFilterChain({ withPhase, phaseLogPath }) {
  const parts = ["astats=metadata=0:reset=0"];
  if (withPhase) {
    parts.push("aphasemeter=video=0");
    parts.push(
      `ametadata=mode=print:key=lavfi.aphasemeter.phase:file=${escapeFilterPath(phaseLogPath)}`,
    );
  }
  parts.push("ebur128=peak=true");
  return parts.join(",");
}

function effectiveTimeoutMs(timeoutMs, durationSeconds) {
  if (isFiniteNum(timeoutMs) && timeoutMs > 0) return timeoutMs;
  // ≈1× real-time, floored at 3 min, capped at 20 min.
  const scaled = Math.round((isFiniteNum(durationSeconds) ? durationSeconds : 0) * 1000);
  return Math.min(20 * 60 * 1000, Math.max(3 * 60 * 1000, scaled));
}

async function analyzeAudioFile(filePath, {
  channels = null,
  channelLayout = null,
  durationSeconds = null,
  fileIndex = 0,
  workDir,
  timeoutMs = null,
} = {}) {
  // Wrap EVERYTHING — this pass must never abort INSPECT.
  try {
    if (typeof filePath !== "string" || !filePath) {
      return { ok: false, path: filePath || null, reason: "filePath is required", notes: [] };
    }
    if (typeof workDir !== "string" || !workDir) {
      return { ok: false, path: filePath, reason: "workDir is required", notes: [] };
    }

    const stderrLogPath = path.join(workDir, `audioanalysis_${fileIndex}.stderr.log`);
    const phaseLogPath = path.join(workDir, `audioanalysis_${fileIndex}.phase.log`);
    const cleanup = () => {
      for (const p of [stderrLogPath, phaseLogPath]) {
        try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
      }
    };

    // Phase meter only on (possibly) stereo. Never on mono (===1) or >2 channels.
    const mayBeStereo = channels === 2 || channels == null;
    const timeout = effectiveTimeoutMs(timeoutMs, durationSeconds);

    // One run helper: spawn ffmpeg, read the teed stderr FILE (in-memory stderr
    // is the fallback when the file read fails), and clear the phase log first
    // so a retry can't re-read stale values.
    const runOnce = async (withPhase) => {
      try { fs.rmSync(phaseLogPath, { force: true }); } catch { /* ignore */ }
      const filter = buildFilterChain({ withPhase, phaseLogPath });
      const argv = ["-hide_banner", "-nostats", "-i", filePath, "-af", filter, "-f", "null", "-"];
      let result;
      try {
        result = await runFfmpegBlocking(argv, { timeoutMs: timeout, stderrLogPath });
      } catch (error) {
        // runFfmpegBlocking only throws on hard spawn failure (e.g. ENOENT).
        return { result: null, stderr: "", error: error && error.message ? error.message : String(error) };
      }
      let stderr = result.stderr || "";
      try { stderr = fs.readFileSync(stderrLogPath, "utf8"); } catch { stderr = result.stderr || ""; }
      return { result, stderr, error: null };
    };

    // First attempt: with phase if the file may be stereo.
    let attempt = await runOnce(mayBeStereo);
    let perChannel = parseAstatsPerChannel(attempt.stderr);
    let loudness = parseLoudness(attempt.stderr);
    let correlation = mayBeStereo ? parsePhaseCorrelation(readFileSafe(phaseLogPath)) : null;
    let degraded = false;

    const parsedNothing = (pc, ld, corr) =>
      pc.length === 0
      && ld.lufs_integrated == null && ld.lra_lu == null && ld.true_peak_dbtp == null
      && corr == null;

    const runFailed = (a) =>
      a.error != null || a.result == null || !a.result.ok || a.result.timed_out;

    // DEGRADE: an exotic build lacking aphasemeter (or astats/ebur128) → retry
    // ONCE with the no-phase chain so loudness/per-channel still come back.
    if (mayBeStereo
        && runFailed(attempt)
        && parsedNothing(perChannel, loudness, correlation)
        && MISSING_FILTER_RE.test(attempt.stderr)) {
      degraded = true;
      attempt = await runOnce(false);
      perChannel = parseAstatsPerChannel(attempt.stderr);
      loudness = parseLoudness(attempt.stderr);
      correlation = null; // no phase meter in the degraded chain
    }

    // If even now we parsed NOTHING, this is a genuine miss.
    if (parsedNothing(perChannel, loudness, correlation)) {
      cleanup();
      const reason = attempt.error
        ? attempt.error
        : attempt.result && attempt.result.timed_out
          ? `ffmpeg timed out after ${timeout}ms`
          : attempt.result
            ? `ffmpeg exited with code ${attempt.result.exit_code}`
            : "audio analysis produced no parseable output";
      return { ok: false, path: filePath, reason, notes: [] };
    }

    cleanup();
    return deriveResult({
      filePath,
      channelsParam: channels,
      channelLayout,
      perChannel,
      loudness,
      correlation,
      degraded,
    });
  } catch (error) {
    return {
      ok: false,
      path: typeof filePath === "string" ? filePath : null,
      reason: error && error.message ? error.message : String(error),
      notes: [],
    };
  }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

// Turn raw parsed values into the rich per-file analysis object (PURE-ish — no
// I/O; split out so the derivation logic is easy to reason about / test).
function deriveResult({
  filePath, channelsParam, channelLayout, perChannel, loudness, correlation, degraded,
}) {
  const resolvedChannels = perChannel.length > 0
    ? perChannel.length
    : (isFiniteNum(channelsParam) ? channelsParam : null);
  const isStereo = resolvedChannels === 2;
  const notes = [];

  // Per-channel with a "silent" flag: no peak, or peak below the noise floor.
  const per_channel = perChannel.map((c) => ({
    channel: c.channel,
    rms_db: c.rms_db,
    peak_db: c.peak_db,
    silent: c.peak_db == null || c.peak_db < -70,
  }));

  // Stereo balance from the two channel RMS values (L − R). Positive ⇒ left is
  // louder. center band is ±1.5 dB.
  let balance_db = null;
  let balance = null;
  if (isStereo && per_channel.length === 2
      && isFiniteNum(per_channel[0].rms_db) && isFiniteNum(per_channel[1].rms_db)) {
    balance_db = round1(per_channel[0].rms_db - per_channel[1].rms_db);
    if (balance_db != null) {
      if (Math.abs(balance_db) < 1.5) balance = "center";
      else if (balance_db > 0) balance = "left";
      else balance = "right";
    }
  }

  // dual-mono: stereo, essentially identical loudness AND near-perfect positive
  // correlation (an unknown correlation is tolerated — quiet identical channels
  // can read as no-phase-data). Phase < -0.2 over a stereo file ⇒ the channels
  // partially invert and would mono-cancel.
  let dual_mono = null;
  let out_of_phase = null;
  if (isStereo) {
    dual_mono = balance_db != null
      && Math.abs(balance_db) < 0.3
      && (correlation == null || correlation > 0.97);
    out_of_phase = correlation != null && correlation < -0.2;
  }

  // dead_channel: in a stereo file, EXACTLY one side silent → name the dead side.
  let dead_channel = null;
  if (isStereo && per_channel.length === 2) {
    const leftSilent = per_channel[0].silent;
    const rightSilent = per_channel[1].silent;
    if (leftSilent && !rightSilent) dead_channel = "left";
    else if (rightSilent && !leftSilent) dead_channel = "right";
  }

  // layout
  let layout = null;
  if (resolvedChannels === 1) layout = "mono";
  else if (resolvedChannels === 2) layout = dual_mono ? "dual_mono" : "stereo";
  else if (isFiniteNum(resolvedChannels) && resolvedChannels > 2) layout = "multi";

  // Human-readable flags.
  if (dead_channel) notes.push(`${dead_channel} channel dead`);
  if (out_of_phase) notes.push("out of phase (mono-cancellation risk)");
  if (dual_mono) notes.push("dual-mono");
  if (balance === "left" || balance === "right") {
    notes.push(`audio leans ${balance} (${balance_db > 0 ? "+" : ""}${balance_db} dB)`);
  }
  if (degraded) notes.push("phase analysis unavailable (degraded)");

  return {
    ok: true,
    path: filePath,
    channels: resolvedChannels,
    channel_layout: channelLayout || null,
    layout,
    per_channel,
    loudness: {
      lufs_integrated: loudness.lufs_integrated,
      lra_lu: loudness.lra_lu,
      true_peak_dbtp: loudness.true_peak_dbtp,
    },
    balance_db,
    balance,
    correlation,
    dual_mono,
    out_of_phase,
    dead_channel,
    degraded,
    notes,
  };
}

// --- advisories --------------------------------------------------------------

// Project the −14 LUFS normalization for each file from its measured loudness,
// so later normalization is a lookup and clip risk is known up front. PURE.
function buildNormalizationAdvisory(entries, {
  targetLufs = AUDIO_ANALYSIS_TARGET_LUFS,
  truePeakCeiling = AUDIO_ANALYSIS_TRUE_PEAK_CEILING,
} = {}) {
  const files = [];
  let any_clip_risk = false;
  let any_quiet = false;
  let any_loud = false;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const analysis = entry && entry.analysis;
    const lufs = analysis && analysis.loudness ? analysis.loudness.lufs_integrated : null;
    if (!isFiniteNum(lufs)) continue; // skip files with no finite integrated loudness

    const truePeak = analysis.loudness.true_peak_dbtp;
    const gain_db = round1(targetLufs - lufs);
    const projected_true_peak_dbtp = isFiniteNum(truePeak) ? round1(truePeak + gain_db) : null;
    const clip_risk = projected_true_peak_dbtp != null && projected_true_peak_dbtp > truePeakCeiling;
    const quiet = lufs < targetLufs - 6;
    const loud = lufs > targetLufs + 3;

    if (clip_risk) any_clip_risk = true;
    if (quiet) any_quiet = true;
    if (loud) any_loud = true;

    files.push({
      file_index: entry.file_index,
      lufs_integrated: lufs,
      gain_db,
      projected_true_peak_dbtp,
      clip_risk,
      quiet,
      loud,
    });
  }

  return {
    target_lufs: targetLufs,
    true_peak_ceiling: truePeakCeiling,
    files,
    any_clip_risk,
    any_quiet,
    any_loud,
  };
}

// Pick the file most likely to be the clean voice/spine track. PURE. Scoring is
// heuristic: a "narration" prior is a strong signal, raw word count scales the
// likelihood that this is the talking head, and audio defects (dead channel,
// out-of-phase, no measurable loudness) penalize. A mild bonus keeps integrated
// loudness in a speech-ish band (~−14..−24 LUFS). Returns the top POSITIVE
// scorer, or null when nothing scores positively / no entries.
function pickCleanAudioSource(entries, {} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return null;

  let best = null;
  let bestScore = 0; // strictly positive required to win

  for (const entry of list) {
    if (!entry) continue;
    const analysis = entry.analysis || null;
    const wordCount = isFiniteNum(entry.word_count) ? entry.word_count : 0;
    const reasons = [];
    let score = 0;

    if (entry.prior === "narration") {
      score += 50;
      reasons.push("narration prior");
    }

    if (wordCount > 0) {
      // Log-ish scaling so a 4000-word file doesn't swamp a 400-word one, but
      // more speech is still clearly better. ~0..40 over a realistic range.
      score += Math.min(40, Math.round(Math.sqrt(wordCount) * 1.2));
      reasons.push(`${wordCount} words`);
    }

    const lufs = analysis && analysis.loudness ? analysis.loudness.lufs_integrated : null;
    if (!isFiniteNum(lufs)) {
      score -= 20;
    } else {
      // Speech-ish loudness band gets a mild nudge.
      if (lufs <= -14 && lufs >= -24) score += 8;
      reasons.push(`${lufs} LUFS`);
    }

    if (analysis && analysis.dead_channel) {
      score -= 30;
      reasons.push(`${analysis.dead_channel} channel dead`);
    }
    if (analysis && analysis.out_of_phase) {
      score -= 25;
      reasons.push("out of phase");
    }

    if (score > bestScore) {
      bestScore = score;
      best = { file_index: entry.file_index, reason: reasons.join(", ") };
    }
  }

  return best;
}

module.exports = {
  analyzeAudioFile,
  buildNormalizationAdvisory,
  pickCleanAudioSource,
  audioAnalysisDisabled,
  parseAstatsPerChannel,
  AUDIO_ANALYSIS_TARGET_LUFS,
  AUDIO_ANALYSIS_TRUE_PEAK_CEILING,
};
