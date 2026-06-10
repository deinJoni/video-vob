"use strict";

// Silence detection via ffmpeg's `silencedetect` audio filter.
//
// We run a decode-only pass (`-f null -`) and parse the filter's log lines off
// **stderr** (ffmpeg emits all filter/log/banner output there, not stdout).
// silencedetect prints, per detected gap:
//   [silencedetect @ ...] silence_start: 12.345
//   [silencedetect @ ...] silence_end: 14.901 | silence_duration: 2.556
// We pair each start with the next end, in emission order.
//
// A detection miss (no audio stream, ffmpeg error, timeout) is NOT thrown:
// the caller (inspect.js) decides whether a miss is fatal, and usually it
// isn't. We return a structured { ok:false, ..., reason } instead, and reserve
// thrown plain Errors for programmer misuse (bad arguments).

const fs = require("fs");
const { runFfmpegBlocking, FFMPEG_TIMEOUT_MS } = require("./ffmpeg-runner.js");

// silencedetect log lines. The "@ 0x..." instance address varies, so we anchor
// on the keyword and a numeric value (ffmpeg uses a plain decimal, e.g. 1.5,
// 0, or 12.345; scientific notation does not appear for these timestamps).
const START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

// ebur128 summary fields. Momentary lines carry running values; the summary
// block is last, so last-match = summary when present, best-effort running
// value when truncated. `nan` / no match → null.
const LUFS_RE = /I:\s*(-?[0-9.]+|nan)\s*LUFS/g;
const LRA_RE = /LRA:\s*(-?[0-9.]+|nan)\s*LU(?![A-Z])/g;
const TPK_RE = /(?:^|\s)Peak:\s*(-?[0-9.]+|nan)\s*dBFS/gm;

// Audio-feature chain failed because the build lacks ebur128/astats — retry
// with the plain v1 silencedetect filter so the silence contract never regresses.
const MISSING_FILTER_RE = /No such filter|Error reinitializing filters|Error initializing filter/i;

const ENERGY_WINDOW_SECONDS = 0.5;

function audioFeaturesDisabled() {
  const knob = (process.env.VOB_DISABLE_AUDIO_FEATURES || "").trim().toLowerCase();
  return knob === "1" || knob === "on" || knob === "true" || knob === "yes";
}

// ffmpeg filter-option escaping for a file path (ametadata file=...). Quoted
// form handles spaces in a homedir; colon escaping covers exotic prefixes.
function escapeFilterPath(p) {
  const escaped = String(p)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\\\'")
    .replace(/:/g, "\\:");
  return `'${escaped}'`;
}

// Pair each `pts_time:` line with the following `RMS_level=` line (the
// ametadata print format). -inf/non-finite levels → -99.
function parseEnergyLog(text) {
  const windows = [];
  let pendingT = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const tm = line.match(/pts_time:(\S+)/);
    if (tm) {
      const t = Number(tm[1]);
      pendingT = Number.isFinite(t) ? t : null;
      continue;
    }
    const rm = line.match(/RMS_level=(\S+)/);
    if (rm && pendingT != null) {
      const v = Number(rm[1]);
      windows.push({ t: pendingT, rms_db: Number.isFinite(v) ? Math.round(v * 10) / 10 : -99 });
      pendingT = null;
    }
  }
  return windows;
}

function lastMatch(re, text) {
  re.lastIndex = 0;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

function parseLoudness(stderrText) {
  const num = (s) => {
    if (s == null || s === "nan") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  return {
    lufs_integrated: num(lastMatch(LUFS_RE, stderrText)),
    lra_lu: num(lastMatch(LRA_RE, stderrText)),
    true_peak_dbtp: num(lastMatch(TPK_RE, stderrText)),
  };
}

async function detectSilences(filePath, {
  noiseDb = -30,
  minSilenceSeconds = 0.5,
  durationSeconds = null,
  timeoutMs = FFMPEG_TIMEOUT_MS,
  features = null, // { energyLogPath, stderrLogPath } | null — null = v1 behavior
} = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("detectSilences: filePath is required");
  }
  if (!Number.isFinite(noiseDb)) {
    throw new Error("detectSilences: noiseDb must be a finite number");
  }
  if (!Number.isFinite(minSilenceSeconds) || minSilenceSeconds <= 0) {
    throw new Error("detectSilences: minSilenceSeconds must be > 0");
  }
  if (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new Error("detectSilences: durationSeconds must be a non-negative number or null");
  }
  if (features != null && (typeof features.energyLogPath !== "string" || typeof features.stderrLogPath !== "string")) {
    throw new Error("detectSilences: features requires { energyLogPath, stderrLogPath }");
  }

  const featuresRequested = features != null;
  const featuresEnabled = featuresRequested && !audioFeaturesDisabled();

  // noise threshold is in dB (e.g. -30dB); d is the minimum silence duration.
  // The feature chain rides the SAME decode pass: ebur128 for loudness, then
  // mono/8kHz resample + asetnsamples=4000 ⇒ exact 0.5s astats RMS windows
  // printed to the energy log file via ametadata.
  let filter = `silencedetect=noise=${noiseDb}dB:d=${minSilenceSeconds}`;
  if (featuresEnabled) {
    filter += ",ebur128=peak=true"
      + ",aformat=channel_layouts=mono,aresample=8000,asetnsamples=n=4000"
      + ",astats=metadata=1:reset=1"
      + `,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${escapeFilterPath(features.energyLogPath)}`;
  }
  const argv = [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-af", filter,
    "-f", "null",
    "-",
  ];

  let result;
  try {
    result = await runFfmpegBlocking(argv, {
      timeoutMs,
      stderrLogPath: featuresEnabled ? features.stderrLogPath : null,
    });
  } catch (error) {
    // runFfmpegBlocking only throws on hard spawn failure (e.g. ENOENT).
    return {
      ok: false,
      silences: [],
      noiseDb,
      minSilenceSeconds,
      reason: error && error.message ? error.message : String(error),
    };
  }

  // With features enabled, parse the teed log FILE, not result.stderr: ebur128
  // prints ~1.7KB/s of momentary lines, which overflows the 4MB in-memory cap
  // at ~40min and would truncate late silencedetect lines.
  let stderr = result.stderr || "";
  if (featuresEnabled) {
    try { stderr = fs.readFileSync(features.stderrLogPath, "utf8"); } catch { stderr = result.stderr || ""; }
  }
  const parsed = parseSilenceLog(stderr, durationSeconds);

  // Exotic ffmpeg build missing ebur128/astats: re-run ONCE with the plain v1
  // filter so the silence contract can never regress because of the chain.
  if (featuresEnabled && (!result.ok || result.timed_out) && parsed.silences.length === 0
      && MISSING_FILTER_RE.test(stderr)) {
    const plain = await detectSilences(filePath, { noiseDb, minSilenceSeconds, durationSeconds, timeoutMs });
    return { ...plain, features: null };
  }

  // ffmpeg failed or timed out AND we got nothing parseable → detection miss.
  // (A clean decode pass exits 0; a missing/corrupt input or timeout does not.
  // If despite a non-zero exit we still parsed intervals, prefer the data.)
  if ((!result.ok || result.timed_out) && parsed.silences.length === 0) {
    const stderrTail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
    const reason = result.timed_out
      ? `ffmpeg timed out after ${timeoutMs}ms`
      : `ffmpeg exited with code ${result.exit_code}${stderrTail ? `: ${stderrTail}` : ""}`;
    return { ok: false, silences: [], noiseDb, minSilenceSeconds, reason };
  }

  const out = {
    ok: true,
    silences: parsed.silences,
    noiseDb,
    minSilenceSeconds,
  };
  if (parsed.note) out.note = parsed.note;
  if (featuresRequested) {
    out.features = null; // null = chain disabled, or ran but produced nothing parseable
    if (featuresEnabled) {
      let energyWindows = [];
      try { energyWindows = parseEnergyLog(fs.readFileSync(features.energyLogPath, "utf8")); } catch { energyWindows = []; }
      const loudness = parseLoudness(stderr);
      const haveAny = energyWindows.length > 0
        || loudness.lufs_integrated != null || loudness.lra_lu != null || loudness.true_peak_dbtp != null;
      if (haveAny) {
        out.features = { loudness, energy_windows: energyWindows, window_seconds: ENERGY_WINDOW_SECONDS };
      }
    }
  }
  return out;
}

// Walk stderr lines in order, pairing each silence_start with the next
// silence_end. Returns sorted, non-degenerate intervals. A trailing start
// with no matching end means silence ran to EOF: close it at durationSeconds
// if known, otherwise drop it and record a note.
function parseSilenceLog(stderr, durationSeconds) {
  const lines = stderr.split(/\r?\n/);
  const intervals = [];
  let pendingStart = null; // number | null
  let note = null;

  for (const line of lines) {
    const sm = line.match(START_RE);
    if (sm) {
      // Two starts in a row shouldn't happen, but if it does, keep the latest
      // (ffmpeg would have emitted an end first in normal operation).
      pendingStart = Number(sm[1]);
      continue;
    }
    const em = line.match(END_RE);
    if (em && pendingStart != null) {
      const end = Number(em[1]);
      const start = pendingStart;
      pendingStart = null;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        intervals.push({ start, end });
      }
    }
  }

  // Unpaired trailing start → silence runs to EOF.
  if (pendingStart != null && Number.isFinite(pendingStart)) {
    if (durationSeconds != null && durationSeconds > pendingStart) {
      intervals.push({ start: pendingStart, end: durationSeconds });
    } else {
      note = `trailing silence_start at ${pendingStart}s had no silence_end (silence to EOF); ` +
        (durationSeconds == null
          ? "durationSeconds not provided, so the interval was dropped"
          : `durationSeconds (${durationSeconds}) was not after the start, so the interval was dropped`);
    }
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  return { silences: intervals, note };
}

module.exports = { detectSilences, parseSilenceLog, parseEnergyLog, escapeFilterPath };
