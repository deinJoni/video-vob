"use strict";

// Pluggable ASR (speech-to-text) backend.
//
// WHY THIS EXISTS: INSPECT used to call `hyperframes transcribe` directly, which
// depends on whisper-cpp being installed in the hyperframes runtime. On hosts
// where whisper-cpp is absent that call silently returns "no speech" even on
// crystal-clear narration — which makes burned captions inexpressible through
// the whole downstream FSM (the entire point of the caption-shorts workflow).
// There was also no preflight: you only learned ASR was dead after INSPECT
// burned ~10 minutes.
//
// This module turns ASR into a detected, pluggable backend with fallback:
//   - faster-whisper  (Python `faster_whisper`)   — fast CPU int8, word timings
//   - openai-whisper   (Python `whisper`)          — reference implementation
//   - hyperframes      (`hyperframes transcribe`)  — the original path (whisper-cpp)
// `auto` (default) picks the first DETECTED backend in that order and, at
// transcription time, falls through to the next on a runtime failure. Every
// backend writes the SAME canonical word-level transcript: a JSON array of
// {text,start,end} (see mcp/lib/clean-cut.js / segment-signals.js consumers).
//
// Knobs (all optional; env wins):
//   VOB_ASR_BACKEND   auto|faster-whisper|openai-whisper|hyperframes|none
//   VOB_ASR_MODEL     model name/path (default "small.en")
//   VOB_ASR_LANGUAGE  language code, or "auto" to detect
//   VOB_PYTHON        python interpreter to use (default: python3 then python)
//   VOB_ASR_NO_FALLBACK  when set with an explicit backend, do not try others

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { spawnWithShutdown } = require("./spawn-with-shutdown.js");
const { runHyperframesWithRetry, buildTranscribeArgv } = require("./hyperframes-runner.js");

const ASR_DRIVER_DIR = path.join(__dirname, "asr");
const FASTER_WHISPER_DRIVER = path.join(ASR_DRIVER_DIR, "faster_whisper_transcribe.py");
const OPENAI_WHISPER_DRIVER = path.join(ASR_DRIVER_DIR, "openai_whisper_transcribe.py");
const WHISPERX_DRIVER = path.join(ASR_DRIVER_DIR, "whisperx_transcribe.py");

const DEFAULT_MODEL = "small.en";
const DETECT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 15 * 60 * 1000;

// Backends that this module can actually RUN (whisper.cpp standalone is detected
// for diagnostics but not driven directly — its JSON lacks reliable word
// timings; install faster-whisper instead). `auto` tries them in this order.
// whisperx is FIRST when present: it is faster-whisper PLUS wav2vec2 forced
// alignment, giving karaoke-grade word timing (a real per-word `p`). It is the
// only backend that emits `aligned:true`; everything else is native-timestamp.
const RUNNABLE_BACKENDS = Object.freeze(["whisperx", "faster-whisper", "openai-whisper", "hyperframes"]);
const ALL_BACKENDS = Object.freeze(["whisperx", "faster-whisper", "openai-whisper", "hyperframes", "whisper-cpp"]);

// Forced alignment is ON by default and only turned off by an explicit knob.
// Read at order-resolution AND inside the whisperx driver (same env contract),
// so `VOB_ALIGN=0` makes `auto` skip whisperx entirely (→ faster-whisper native
// timings) rather than running whisperx in a pointless transcribe-only mode.
function wantAlignment() {
  const knob = (process.env.VOB_ALIGN || "").trim().toLowerCase();
  return !(knob === "0" || knob === "off" || knob === "false" || knob === "no");
}

function nowIso() {
  return new Date().toISOString();
}

function configuredBackend() {
  const raw = (process.env.VOB_ASR_BACKEND || "").trim().toLowerCase();
  if (!raw) return "auto";
  return raw;
}

function configuredModel(model) {
  if (typeof model === "string" && model.trim()) return model.trim();
  const env = (process.env.VOB_ASR_MODEL || "").trim();
  return env || DEFAULT_MODEL;
}

function configuredLanguage(language) {
  const val = typeof language === "string" && language.trim()
    ? language.trim()
    : (process.env.VOB_ASR_LANGUAGE || "").trim();
  if (!val || val.toLowerCase() === "auto") return "";
  return val;
}

// --- binary / interpreter resolution ---------------------------------------

function whichBinary(name) {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = spawnSync(finder, [name], { encoding: "utf8", timeout: 8000 });
    if (out.status === 0) {
      const first = (out.stdout || "").split(/\r?\n/)[0].trim();
      return first || null;
    }
  } catch { /* not found */ }
  return null;
}

let _python = undefined;
function resolvePython() {
  if (_python !== undefined) return _python;
  const candidates = [];
  const override = (process.env.VOB_PYTHON || "").trim();
  if (override) candidates.push(override);
  candidates.push("python3", "python");
  for (const cmd of candidates) {
    try {
      const out = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 8000 });
      if (out.status === 0 || /python/i.test(`${out.stdout || ""}${out.stderr || ""}`)) {
        const ver = `${out.stdout || ""}${out.stderr || ""}`.trim().split(/\r?\n/)[0] || null;
        _python = { cmd, version: ver };
        return _python;
      }
    } catch { /* try next */ }
  }
  _python = null;
  return _python;
}

function pythonModuleAvailable(py, moduleName) {
  if (!py) return false;
  try {
    const out = spawnSync(py.cmd, ["-c", `import ${moduleName}`], { encoding: "utf8", timeout: DETECT_TIMEOUT_MS });
    return out.status === 0;
  } catch {
    return false;
  }
}

function whisperCppBinary() {
  for (const name of ["whisper-cli", "whisper-cpp", "whisper.cpp", "main"]) {
    const found = whichBinary(name);
    if (found) return { name, path: found };
  }
  return null;
}

// --- detection (cheap; used by INGEST preflight + vob_doctor) ----------------

// Probe each backend's availability. Intentionally avoids running any actual
// transcription. faster-whisper/openai-whisper require a python import (a few
// hundred ms each); hyperframes ASR availability cannot be fully verified
// without running it (its internal whisper-cpp dependency is opaque), so it is
// reported as "present but unverified" when the hyperframes binary resolves.
function detectAsrBackends() {
  const py = resolvePython();
  const whisperX = pythonModuleAvailable(py, "whisperx");
  const fasterWhisper = pythonModuleAvailable(py, "faster_whisper");
  const openaiWhisper = pythonModuleAvailable(py, "whisper");
  const whisperCpp = whisperCppBinary();

  const backends = [
    {
      name: "whisperx",
      available: whisperX,
      // `runnable` is pure availability (module present). Whether `auto` actually
      // USES it also depends on wantAlignment() — gated in resolveBackendOrder —
      // so VOB_ALIGN=0 doesn't have to fight the detection layer.
      runnable: whisperX,
      aligns: true,
      requires: "python3 + `pip install whisperx`",
      detail: whisperX ? `python module present (${py ? py.cmd : "python"}); wav2vec2 forced alignment` : (py ? "python present, whisperx module not importable" : "no python interpreter found"),
    },
    {
      name: "faster-whisper",
      available: fasterWhisper,
      runnable: fasterWhisper,
      requires: "python3 + `pip install faster-whisper`",
      detail: fasterWhisper ? `python module present (${py ? py.cmd : "python"})` : (py ? "python present, faster_whisper module not importable" : "no python interpreter found"),
    },
    {
      name: "openai-whisper",
      available: openaiWhisper,
      runnable: openaiWhisper,
      requires: "python3 + `pip install openai-whisper`",
      detail: openaiWhisper ? `python module present (${py ? py.cmd : "python"})` : (py ? "python present, whisper module not importable" : "no python interpreter found"),
    },
    {
      name: "whisper-cpp",
      available: Boolean(whisperCpp),
      runnable: false, // detected for diagnostics; not driven directly
      requires: "whisper.cpp binary on PATH (or used via hyperframes)",
      detail: whisperCpp ? `binary: ${whisperCpp.path}` : "no whisper.cpp binary on PATH",
    },
  ];

  const selected = resolveBackendOrder("auto", backends)[0] || null;
  return { python: py, backends, selected };
}

// Return the ordered list of RUNNABLE backend names to attempt, given a config
// ("auto" or a specific name) and the detected availability.
function resolveBackendOrder(backend, detectedBackends) {
  const availability = new Map((detectedBackends || []).map((b) => [b.name, b.runnable]));
  const isUp = (name) => {
    if (name === "hyperframes") {
      // hyperframes ASR availability is best-effort: we try it if selected /
      // auto and let a runtime failure fall through. Treat as "attemptable".
      return true;
    }
    if (name === "whisperx") {
      // whisperx is only worth picking for its alignment; with VOB_ALIGN off it
      // would run transcribe-only (coarser than faster-whisper native timings),
      // so auto skips it. An EXPLICIT backend:"whisperx" still forces it below.
      return availability.get("whisperx") === true && wantAlignment();
    }
    return availability.get(name) === true;
  };

  if (backend && backend !== "auto" && backend !== "none") {
    if (!RUNNABLE_BACKENDS.includes(backend)) return [];
    const order = [backend];
    if (!process.env.VOB_ASR_NO_FALLBACK) {
      for (const b of RUNNABLE_BACKENDS) if (b !== backend && isUp(b)) order.push(b);
    }
    return order;
  }
  if (backend === "none") return [];
  // auto: detected runnable backends in preference order, hyperframes last.
  return RUNNABLE_BACKENDS.filter((b) => isUp(b));
}

// Preflight-shaped summary, mirroring checkFfmpegAvailable / checkHyperframesAvailable.
function checkAsrAvailable() {
  const cfg = configuredBackend();
  let detection;
  try {
    detection = detectAsrBackends();
  } catch (error) {
    return {
      ok: false, backend: cfg, selected: null, available_backends: [],
      python: null, error: error.message || String(error), checked_at: nowIso(),
    };
  }
  const runnableAvailable = detection.backends.filter((b) => b.runnable && b.available).map((b) => b.name);
  const order = resolveBackendOrder(cfg, detection.backends);
  const selected = order[0] || null;
  // Alignment (karaoke-grade word timing) is available iff an alignment-capable
  // backend (whisperx) is present. Reported so the orchestrator/doctor can warn
  // "word timing will be approximate (no alignment backend) — pip install whisperx".
  const alignBackend = detection.backends.find((b) => b.aligns && b.runnable && b.available);
  const alignmentAvailable = Boolean(alignBackend);
  // "ok" = we have at least one attemptable backend. hyperframes is attemptable
  // but unverified, so ok-via-hyperframes-only is a soft yes with a caveat.
  const haveRunnable = runnableAvailable.length > 0;
  const haveHyperframesFallback = order.includes("hyperframes");
  const ok = cfg === "none" ? false : (haveRunnable || haveHyperframesFallback);
  let error = null;
  if (cfg === "none") {
    error = "ASR disabled (VOB_ASR_BACKEND=none)";
  } else if (!haveRunnable) {
    error = "no local ASR engine detected (faster-whisper / openai-whisper). hyperframes transcribe will be tried but needs whisper-cpp; install faster-whisper (`pip install faster-whisper`) for a reliable backend.";
  }
  return {
    ok,
    backend: cfg,
    selected,
    available_backends: runnableAvailable,
    all_backends: detection.backends,
    alignment_available: alignmentAvailable,
    alignment_backend: alignBackend ? alignBackend.name : null,
    alignment_enabled: wantAlignment(),
    python: detection.python ? { cmd: detection.python.cmd, version: detection.python.version } : null,
    error,
    checked_at: nowIso(),
  };
}

// --- transcription -----------------------------------------------------------

// Parse the LAST JSON object/array found in a backend's stdout (the drivers
// print their envelope as the final stdout line; library logging may precede it).
function parseEnvelope(stdout) {
  const text = (stdout || "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || (line[0] !== "{" && line[0] !== "[")) continue;
    try { return JSON.parse(line); } catch { /* keep scanning upward */ }
  }
  return null;
}

function countWordsInFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function runPythonDriver({ driver, audioPath, outPath, model, language, projectDir, timeoutMs }) {
  const py = resolvePython();
  if (!py) return { ok: false, reason: "python_not_found" };
  const result = await spawnWithShutdown(
    py.cmd,
    [driver, audioPath, outPath, model, language],
    {
      cwd: projectDir,
      env: process.env,
      timeoutMs,
      captureStdoutViaFile: true,
    },
  );
  if (result.timed_out) return { ok: false, reason: "transcription_timeout", stderr: (result.stderr || "").slice(0, 800) };
  const envelope = parseEnvelope(result.stdout);
  if (result.exit_code !== 0 || !envelope || envelope.ok !== true) {
    const detail = (envelope && envelope.error) || (result.stderr || "").slice(0, 800) || `exit ${result.exit_code}`;
    return { ok: false, reason: "transcription_failed", detail, exit_code: result.exit_code };
  }
  if (!fs.existsSync(outPath)) return { ok: false, reason: "transcription_file_missing", expected_path: outPath };
  const wordCount = Number.isFinite(envelope.wordCount) ? Number(envelope.wordCount) : countWordsInFile(outPath);
  // `aligned` is the karaoke-grade marker: only the whisperx driver sets it true
  // (forced alignment ran). faster-whisper/openai-whisper omit it → native
  // timings → aligned:false.
  return { ok: true, word_count: wordCount, model: envelope.model || model, language: envelope.language || null, aligned: envelope.aligned === true };
}

// hyperframes transcribe writes transcript.json into its `-d <dir>` (= projectDir);
// normalize it to outPath. Preserves the original INSPECT behavior exactly.
async function runHyperframesBackend({ audioPath, outPath, projectDir, timeoutMs }) {
  const result = await runHyperframesWithRetry(
    buildTranscribeArgv({ inspectDirAbs: projectDir, audioPath }),
    { timeoutMs, captureStdoutViaFile: true, maxAttempts: 2 },
  );
  if (result.timed_out) return { ok: false, reason: "transcription_timeout", stderr: (result.stderr || "").slice(0, 800) };
  if (result.exit_code !== 0) {
    return { ok: false, reason: "transcription_failed", detail: (result.stderr || "").slice(0, 800), exit_code: result.exit_code };
  }
  const meta = parseEnvelope(result.stdout);
  if (!meta || meta.ok === false) {
    return { ok: false, reason: "transcription_unparseable", stdout_preview: (result.stdout || "").slice(0, 400) };
  }
  const writtenPath = typeof meta.transcriptPath === "string" && meta.transcriptPath ? meta.transcriptPath : outPath;
  if (!fs.existsSync(writtenPath)) return { ok: false, reason: "transcription_file_missing", expected_path: writtenPath };
  if (writtenPath !== outPath) {
    try { fs.copyFileSync(writtenPath, outPath); } catch (error) { return { ok: false, reason: "transcription_copy_failed", detail: error.message }; }
  }
  const wordCount = Number.isFinite(meta.wordCount) ? Number(meta.wordCount) : countWordsInFile(outPath);
  return { ok: true, word_count: wordCount };
}

async function runBackend(name, ctx) {
  if (name === "whisperx") return runPythonDriver({ driver: WHISPERX_DRIVER, ...ctx });
  if (name === "faster-whisper") return runPythonDriver({ driver: FASTER_WHISPER_DRIVER, ...ctx });
  if (name === "openai-whisper") return runPythonDriver({ driver: OPENAI_WHISPER_DRIVER, ...ctx });
  if (name === "hyperframes") return runHyperframesBackend(ctx);
  return { ok: false, reason: "unknown_backend" };
}

// Transcribe `audioPath` to the canonical `outPath` ([{text,start,end}]).
// Tries the configured/auto backend order, falling through on runtime failure.
// Returns { ok, backend, word_count, attempts } or { ok:false, reason, attempts }.
async function asrTranscribe({ audioPath, outPath, projectDir, durationSeconds = null, backend = null, model = null, language = null, timeoutMs = null } = {}) {
  const cfg = (backend && String(backend).trim().toLowerCase()) || configuredBackend();
  const detection = detectAsrBackends();
  const order = resolveBackendOrder(cfg, detection.backends);
  const resolvedModel = configuredModel(model);
  const resolvedLanguage = configuredLanguage(language);
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : transcribeTimeoutForDuration(durationSeconds);

  if (order.length === 0) {
    return { ok: false, reason: cfg === "none" ? "asr_disabled" : "no_asr_backend", attempts: [], requested_backend: cfg };
  }

  const ctx = { audioPath, outPath, projectDir, model: resolvedModel, language: resolvedLanguage, timeoutMs: effectiveTimeout };
  const attempts = [];
  for (const name of order) {
    let res;
    try {
      res = await runBackend(name, ctx);
    } catch (error) {
      res = { ok: false, reason: "backend_threw", detail: error.message || String(error) };
    }
    attempts.push({ backend: name, ok: res.ok, reason: res.ok ? null : res.reason, detail: res.detail || null });
    if (res.ok) {
      return { ok: true, backend: name, word_count: res.word_count || 0, model: resolvedModel, language: res.language || resolvedLanguage || null, aligned: res.aligned === true, attempts };
    }
  }
  return { ok: false, reason: attempts.length ? attempts[attempts.length - 1].reason : "no_asr_backend", attempts, requested_backend: cfg };
}

// The resolved ASR configuration that determines transcript CONTENT — used as
// the transcript-cache key. Knob semantics unchanged (VOB_ASR_BACKEND/MODEL/
// LANGUAGE). With backend "auto", a host that switches engines between runs
// reuses the cache — acceptable: every backend writes the same canonical contract.
function resolvedAsrParams() {
  const backend = configuredBackend();
  // `align` keys the transcript cache so a non-aligned transcript is never
  // served as aligned. When whisperx becomes available on a host that earlier
  // cached faster-whisper output, `align` flips true and busts the stale slot;
  // a host with no alignment backend keeps align:false and reuses its cache.
  let align = false;
  try {
    if (wantAlignment()) {
      if (backend === "whisperx") {
        align = true;
      } else if (backend === "auto") {
        const det = detectAsrBackends();
        const wx = (det.backends || []).find((b) => b.name === "whisperx");
        align = Boolean(wx && wx.runnable);
      }
    }
  } catch { align = false; }
  return {
    backend,
    model: configuredModel(null),
    language: configuredLanguage(null) || "auto",
    align,
  };
}

// faster-whisper small.en on CPU runs near real-time; openai-whisper can be a
// few× slower. Give a generous, duration-scaled budget so long podcast sources
// (31–44 min) are not cut off mid-transcription — the failure mode that made
// the FSM unusable on real inputs. Bounded by a ceiling and overridable.
function transcribeTimeoutForDuration(durationSeconds) {
  const override = Number.parseInt((process.env.VOB_ASR_TIMEOUT_MS || "").trim(), 10);
  if (Number.isInteger(override) && override > 0) return override;
  const base = DEFAULT_TRANSCRIBE_TIMEOUT_MS;
  const ceiling = 90 * 60 * 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return base;
  // ~3× real-time budget covers slow CPU + model-load on first run.
  const scaled = Math.round(durationSeconds * 1000 * 3);
  return Math.min(ceiling, Math.max(base, scaled));
}

module.exports = {
  ALL_BACKENDS,
  RUNNABLE_BACKENDS,
  DEFAULT_MODEL,
  asrTranscribe,
  checkAsrAvailable,
  detectAsrBackends,
  resolveBackendOrder,
  resolvedAsrParams,
  transcribeTimeoutForDuration,
  resolvePython,
};
