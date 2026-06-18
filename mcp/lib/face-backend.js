"use strict";

// Optional pluggable face-presence backend for INSPECT take-quality scoring (v3.9).
//
// Mirrors `asr-backend.js`: detect an available engine → run a Python driver over
// a BATCH of the keyframes INSPECT already extracted → parse JSON → attach a
// per-segment `face` read that `take-quality.js` folds into the visual sub-score.
// DEGRADES, never throws: when no backend is installed (the common case) every
// segment gets `face:null` and the strength score is computed from the other
// components (delivery + exposure + sharpness). Purely ADVISORY — face is ~8% of
// the composite and only nudges take selection; it never gates anything.
//
// Backend: OpenCV's bundled Haar frontal-face cascade (`pip install
// opencv-python-headless` — the cascade XML ships with the package, no model
// download, CPU, fast on the 512w keyframes). Frontal-only is fine: A-roll
// talking-heads are frontal by definition, and the signal is advisory. The
// detect→order structure leaves room to add mediapipe later without touching
// callers.
//
// Knobs (all optional; env wins):
//   VOB_FACE_BACKEND   auto|opencv|none   (default auto; `none` disables)
//   VOB_FACE_TIMEOUT_MS  per-batch driver timeout (default 120s)
//   VOB_PYTHON         python interpreter (shared with asr-backend)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { spawnWithShutdown } = require("./spawn-with-shutdown.js");
const { resolvePython } = require("./asr-backend.js");

const FACE_DRIVER = path.join(__dirname, "visual", "face_detect.py");
const DETECT_TIMEOUT_MS = 20 * 1000;
const ALL_BACKENDS = Object.freeze(["opencv"]);

let metaSeq = 0;

function nowIso() { return new Date().toISOString(); }

function faceTimeoutMs() {
  const raw = process.env.VOB_FACE_TIMEOUT_MS;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120 * 1000;
}

function configuredBackend() {
  const raw = (process.env.VOB_FACE_BACKEND || "").trim().toLowerCase();
  return raw || "auto";
}

function disabled() { return configuredBackend() === "none"; }

// Duplicated from asr-backend.js (not exported there): is a Python module
// importable under the resolved interpreter?
function pythonModuleAvailable(py, moduleName) {
  if (!py) return false;
  try {
    const out = spawnSync(py.cmd, ["-c", `import ${moduleName}`], { encoding: "utf8", timeout: DETECT_TIMEOUT_MS });
    return out.status === 0;
  } catch {
    return false;
  }
}

// Duplicated from asr-backend.js: scan a driver's stdout bottom-up for the last
// JSON line (the result envelope). The Python driver prints exactly one.
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

// The `import cv2` probe is a Python interpreter spawn (~150–400ms cold). Cache
// it per-process like asr-backend's resolvePython — availability can't change
// mid-run, and `attachFaceFeatures` runs once PER FILE in the INSPECT loop, so an
// uncached probe would re-spawn Python for every video file. (`selected` below is
// recomputed live from VOB_FACE_BACKEND each call, so the env knob still applies.)
let _faceProbe;
function probeFaceModules() {
  if (_faceProbe !== undefined) return _faceProbe;
  const py = resolvePython();
  _faceProbe = { python: py, opencv: pythonModuleAvailable(py, "cv2") };
  return _faceProbe;
}

// Probe each backend's availability (cached import check). Used by attach + the
// vob_doctor preflight. Honors VOB_FACE_BACKEND (`none` → nothing selected; an
// explicit name → only that backend).
function detectFaceBackends() {
  const { python: py, opencv } = probeFaceModules();
  const backends = [
    {
      name: "opencv",
      available: opencv,
      runnable: opencv,
      requires: "python3 + `pip install opencv-python-headless`",
      detail: opencv
        ? `python module cv2 present (${py ? py.cmd : "python"}); bundled Haar frontal cascade`
        : (py ? "python present, cv2 not importable" : "no python interpreter found"),
    },
  ];
  const cfg = configuredBackend();
  let selected = null;
  if (cfg === "none") selected = null;
  else if (cfg === "auto") selected = backends.find((b) => b.runnable) ? "opencv" : null;
  else selected = (cfg === "opencv" && opencv) ? "opencv" : null;
  return { python: py, backends, selected, available: selected != null };
}

// Preflight summary for vob_doctor (warn-only — face is optional). Never throws.
function checkFaceAvailable() {
  try {
    const det = detectFaceBackends();
    const available = det.backends.filter((b) => b.runnable).map((b) => b.name);
    let error = null;
    if (!det.available) {
      error = disabled()
        ? "face detection disabled (VOB_FACE_BACKEND=none)"
        : det.python
          ? "no face-detection backend importable — `pip install opencv-python-headless` to enable take-quality face scoring"
          : "no python interpreter found";
    }
    return {
      ok: det.available,
      selected: det.selected,
      available_backends: available,
      all_backends: det.backends,
      python: det.python ? { cmd: det.python.cmd, version: det.python.version } : null,
      error,
      checked_at: nowIso(),
    };
  } catch (e) {
    return {
      ok: false, selected: null, available_backends: [], all_backends: [], python: null,
      error: e && e.message ? e.message : String(e), checked_at: nowIso(),
    };
  }
}

// Run the Python driver over a batch of image paths. Returns a Map path→{present,
// count, area_frac, centered} or null on any failure (degrade). One spawn for the
// whole batch amortizes the Python + cv2 import startup over all of a file's
// keyframes.
async function runFaceDriver(imagePaths, { projectDir = null, timeoutMs = null } = {}) {
  const py = resolvePython();
  if (!py) return null;
  metaSeq += 1;
  const inPath = path.join(os.tmpdir(), `vob-face-in-${process.pid}-${metaSeq}.json`);
  const outPath = path.join(os.tmpdir(), `vob-face-out-${process.pid}-${metaSeq}.json`);
  const cleanup = () => {
    try { fs.unlinkSync(inPath); } catch { /* best-effort */ }
    try { fs.unlinkSync(outPath); } catch { /* best-effort */ }
  };
  try { fs.writeFileSync(inPath, JSON.stringify(imagePaths)); } catch { cleanup(); return null; }

  let result;
  try {
    result = await spawnWithShutdown(py.cmd, [FACE_DRIVER, inPath, outPath], {
      cwd: projectDir || undefined,
      env: process.env,
      timeoutMs: timeoutMs || faceTimeoutMs(),
      captureStdoutViaFile: true,
    });
  } catch { cleanup(); return null; }

  const envelope = parseEnvelope(result.stdout);
  let parsed = null;
  if (!result.timed_out && envelope && envelope.ok === true && fs.existsSync(outPath)) {
    try { parsed = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch { parsed = null; }
  }
  cleanup();
  if (!Array.isArray(parsed)) return null;

  const map = new Map();
  for (const r of parsed) {
    if (!r || typeof r.path !== "string") continue;
    map.set(r.path, {
      present: r.present === true,
      count: Number.isInteger(r.count) ? r.count : 0,
      area_frac: typeof r.area_frac === "number" ? r.area_frac : null,
      centered: typeof r.centered === "boolean" ? r.centered : null,
    });
  }
  return map;
}

function withNullFace(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => ({ ...s, face: s && s.face !== undefined ? s.face : null }));
}

// Attach a per-segment `face` read to the non-silence segments of a file by
// batch-detecting over their keyframes. Returns the enriched segments + counts +
// the backend used (null when unavailable/disabled). Degrade-don't-die.
async function attachFaceFeatures(segments, { hasVideo = true, projectDir = null, timeoutMs = null } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  if (disabled() || !hasVideo) return { segments: withNullFace(segs), scored: 0, failed: 0, backend: null };

  const det = detectFaceBackends();
  if (!det.available) return { segments: withNullFace(segs), scored: 0, failed: 0, backend: null };

  const jobs = [];
  segs.forEach((seg, i) => {
    if (seg && !seg.is_silence && typeof seg.keyframe_path === "string") jobs.push({ i, path: seg.keyframe_path });
  });
  if (jobs.length === 0) return { segments: withNullFace(segs), scored: 0, failed: 0, backend: null };

  const faceByPath = await runFaceDriver(jobs.map((j) => j.path), { projectDir, timeoutMs });
  if (!faceByPath) return { segments: withNullFace(segs), scored: 0, failed: 0, backend: null };

  const byIndex = new Map();
  let scored = 0;
  let failed = 0;
  for (const j of jobs) {
    const f = faceByPath.get(j.path);
    if (f) { byIndex.set(j.i, f); scored += 1; } else { failed += 1; }
  }
  const out = segs.map((seg, i) => (byIndex.has(i)
    ? { ...seg, face: byIndex.get(i) }
    : { ...seg, face: seg && seg.face !== undefined ? seg.face : null }));
  return { segments: out, scored, failed, backend: det.selected };
}

module.exports = {
  ALL_BACKENDS,
  attachFaceFeatures,
  checkFaceAvailable,
  detectFaceBackends,
  parseEnvelope,
};
