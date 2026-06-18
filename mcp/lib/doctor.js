"use strict";

// vob doctor — a single up-front preflight of everything a real job depends on,
// so the tribal knowledge that used to live in memory files becomes a guard
// rail you run before burning 10 minutes on a doomed INSPECT.
//
// Checks: ffmpeg, ffprobe, hyperframes, and the ASR backend (the silent killer
// of the captioned-shorts workflow); plus host RAM and the derived render-worker
// / heavy-encode-concurrency ceilings, the GPU backend, and advisories for the
// known footage/render gotchas (DJI bogus rotation, <video> render fragility,
// Docker-is-banned).

const os = require("os");

const { checkFfmpegAvailable } = require("./ffmpeg-runner.js");
const { checkHyperframesAvailable, describeHyperframesInvocation, resolveBrowserGpuMode, renderWorkerArgs, checkRemoveBackgroundAvailable, resolveRemoveBgDevice } = require("./hyperframes-runner.js");
const { checkAsrAvailable } = require("./asr-backend.js");
const { checkFaceAvailable } = require("./face-backend.js");
const { recommendedHeavyEncodeConcurrency } = require("./concurrency.js");
const hostProfile = require("./host-profile.js");
const { describeVideoTypes, resolveActiveVideoType } = require("./video-types.js");

const GIB = 1024 * 1024 * 1024;

function checkFfprobe() {
  // ffprobe ships with ffmpeg; probe it via a trivial spawn.
  const { spawnSync } = require("child_process");
  try {
    const out = spawnSync("ffprobe", ["-version"], { encoding: "utf8", timeout: 15000 });
    if (out.status === 0) {
      const m = (out.stdout || "").match(/ffprobe version\s+(\S+)/i);
      return { ok: true, version: m ? m[1] : null, error: null };
    }
    return { ok: false, version: null, error: (out.stderr || "").slice(0, 200) || `exit ${out.status}` };
  } catch (error) {
    return { ok: false, version: null, error: error.message || String(error) };
  }
}

function level(ok, warnOnly = false) {
  if (ok) return "ok";
  return warnOnly ? "warn" : "error";
}

// Best-effort per-project video-type resolution for the report — a missing or
// unreadable project must never fail the doctor.
function resolveProjectVideoType(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) return null;
  try {
    // Lazy require: session-state pulls the FSM stack, which the doctor only
    // needs for this one optional lookup.
    const { readSessionStateStrict } = require("./session-state.js");
    const state = readSessionStateStrict(projectId.trim());
    const vt = resolveActiveVideoType(state);
    return {
      project_id: projectId.trim(),
      canonical: vt.canonical,
      source: vt.source,
      lint_ruleset: vt.preset.lint_ruleset,
      segmentation: vt.preset.render.segmentation,
      clean_cut: vt.preset.editorial.clean_cut,
      platform_default: vt.preset.platform_default,
    };
  } catch {
    return null;
  }
}

// Run all checks and return a structured report. `ok` is true only when there
// are no hard blockers (a missing ASR engine is a WARNING, not a blocker — the
// user can pass skip_transcription or install one — but ffmpeg/ffprobe missing
// is a blocker because nothing downstream runs).
function runDoctor({ projectId = null } = {}) {
  const platform = process.platform;
  const totalmem = (() => { try { return os.totalmem(); } catch { return 0; } })();
  const freemem = (() => { try { return os.freemem(); } catch { return 0; } })();
  const cpus = (() => { try { return os.cpus().length; } catch { return 0; } })();
  const lowRam = totalmem > 0 && totalmem < 10 * GIB;

  const ffmpeg = checkFfmpegAvailable();
  const ffprobe = checkFfprobe();
  const hyperframes = checkHyperframesAvailable();
  // The exact resolved hyperframes invocation (+ pin env) — surfaced so bespoke
  // escape-hatch work under <session>/work/ runs the SAME pinned binary.
  const hfInvocation = (() => { try { return describeHyperframesInvocation(); } catch { return null; } })();
  const asr = checkAsrAvailable();
  const removeBg = checkRemoveBackgroundAvailable();
  const face = checkFaceAvailable();

  const workerArgs = renderWorkerArgs();
  const renderWorkers = workerArgs.length === 2 ? workerArgs[1] : "auto (hyperframes calibrates)";
  const encodeCap = recommendedHeavyEncodeConcurrency();
  const gpuMode = resolveBrowserGpuMode();
  // Per-machine tuning resolution (env > .vob-config/host.json > capacity tier
  // > RAM default), with the source of each effective value.
  const tuning = hostProfile.describe();

  const checks = [];

  checks.push({
    name: "ffmpeg",
    level: level(ffmpeg.ok),
    detail: ffmpeg.ok ? `present (${ffmpeg.version || "version?"})` : (ffmpeg.error || "not found"),
    recommendation: ffmpeg.ok ? null : "Install ffmpeg (Debian/Ubuntu: apt-get install ffmpeg). REQUIRED — INSPECT/COMPOSE/PACKAGE all use it.",
    blocker: !ffmpeg.ok,
  });

  checks.push({
    name: "ffprobe",
    level: level(ffprobe.ok),
    detail: ffprobe.ok ? `present (${ffprobe.version || "version?"})` : (ffprobe.error || "not found"),
    recommendation: ffprobe.ok ? null : "ffprobe ships with ffmpeg — installing ffmpeg provides it. REQUIRED for INGEST.",
    blocker: !ffprobe.ok,
  });

  checks.push({
    name: "hyperframes",
    level: level(hyperframes.ok, true),
    detail: hyperframes.ok
      ? `present (${hyperframes.version || "version?"})${hfInvocation ? ` — engine runs: ${hfInvocation.command} [${hfInvocation.resolution}]` : ""}`
      : (hyperframes.error || "not found"),
    recommendation: hyperframes.ok
      ? (hfInvocation
        ? `For sanctioned bespoke work under <session>/work/, run the SAME pinned binary the engine uses — NOT npx (which floats the version): \`${hfInvocation.command} <args>\`. Export these to match in-pipeline behavior: ${Object.entries(hfInvocation.pin_env).map(([k, v]) => `${k}=${v}`).join(" ")}. Then QC the work/ composition with vob_lint_composition { project_id, compose_dir } before rendering.`
        : null)
      : "Install hyperframes (`npm i -g hyperframes`) — required to render compositions. Not needed for overlay-over-base/import-only flows.",
    blocker: false,
    resolved_command: hfInvocation ? hfInvocation.command : null,
    pin_env: hfInvocation ? hfInvocation.pin_env : null,
  });

  checks.push({
    name: "asr-backend",
    level: level(asr.ok, true),
    detail: asr.ok
      ? `usable: ${asr.available_backends.length ? asr.available_backends.join(", ") : "(hyperframes/whisper-cpp only — unverified)"}; selected=${asr.selected || "?"}; `
        + (asr.alignment_available
          ? `alignment: ${asr.alignment_backend} (karaoke-grade word timing${asr.alignment_enabled ? "" : ", DISABLED via VOB_ALIGN"})`
          : "alignment: none (word timing approximate)")
      : (asr.error || "no ASR backend"),
    recommendation: asr.available_backends.length
      ? (asr.alignment_available
        ? null
        : "Transcription works, but word timing is approximate (native Whisper timestamps drift across pauses). For karaoke-grade word-by-word caption timing, `pip install whisperx` (faster-whisper + wav2vec2 forced alignment; no HF token, no diarization).")
      : "No local ASR engine detected. `pip install whisperx` (recommended — also gives karaoke-grade word timing) or `pip install faster-whisper` so INSPECT can transcribe — without it captions/transcripts are unavailable and you must pass skip_transcription. hyperframes transcribe needs whisper-cpp.",
    blocker: false,
    backends: asr.all_backends || [],
    alignment_available: asr.alignment_available === true,
    alignment_backend: asr.alignment_backend || null,
    python: asr.python || null,
  });

  // face-detection (take-quality v3.9): an OPTIONAL backend that adds a face
  // term to the per-segment strength score. Absent is the common case and NEVER
  // a problem — the score just omits face — so ok:false is warn-only and never
  // flips the doctor.
  checks.push({
    name: "face-detection",
    level: level(face.ok, true),
    detail: face.ok
      ? `available: ${face.available_backends.join(", ")}; selected=${face.selected || "?"} — take-quality scores include a face term`
      : (face.error || "no face-detection backend"),
    recommendation: face.ok
      ? null
      : "OPTIONAL. INSPECT take-quality scores takes without it (delivery + exposure + sharpness). To add a face-presence term, `pip install opencv-python-headless` (bundled Haar cascade, no model download). Disable entirely with VOB_FACE_BACKEND=none.",
    blocker: false,
    backends: face.all_backends || [],
    python: face.python || null,
  });

  // remove-background (subject compositing v3.3): the local matte model. A
  // missing backend or un-downloaded weights is a WARNING — subject mode is
  // optional, so ok:false NEVER flips the doctor (only ffmpeg/ffprobe do).
  const rbDevice = resolveRemoveBgDevice();
  checks.push({
    name: "remove-background",
    level: level(removeBg.ok, true),
    detail: removeBg.ok
      ? `present (providers: ${removeBg.providers && removeBg.providers.length ? removeBg.providers.join(", ") : "?"}; `
        + `model ${removeBg.model_cached === true ? "cached" : removeBg.model_cached === false ? "NOT cached — first matte downloads weights" : "?"}; `
        + `device=${rbDevice})`
      : (removeBg.error || "not available"),
    recommendation: removeBg.ok
      ? (removeBg.model_cached === false
        ? "Subject compositing will download the background-removal model weights on the first matte (one-time, tens-to-hundreds of MB). The matte timeout floor is generous; pre-warm by running one `hyperframes remove-background` if you want it cached before COMPOSE."
        : null)
      : "Only needed for render_mode:\"subject\" (matted talking-head / PiP). hyperframes ships the model; coreml on Apple Silicon, cpu fallback (VOB_REMOVE_BG_DEVICE). Ignore if no storyboard uses subject mode.",
    blocker: false,
    providers: removeBg.providers || [],
    model_cached: removeBg.model_cached,
    device: rbDevice,
  });

  // Video-type presets (v3): the resolved table + sources, mirroring the
  // report.tuning pattern. With a project_id, also that project's resolution.
  const videoTypes = {
    ...describeVideoTypes(),
    project: resolveProjectVideoType(projectId),
  };
  checks.push({
    name: "video-types",
    level: "ok",
    detail: `presets: ${videoTypes.built_in.join(", ")}`
      + (videoTypes.user_defined.length ? ` + user: ${videoTypes.user_defined.join(", ")}` : "")
      + (videoTypes.env_override ? ` | VOB_VIDEO_TYPE=${videoTypes.env_override}` : "")
      + (videoTypes.project
        ? ` | ${videoTypes.project.project_id}: ${videoTypes.project.canonical} [${videoTypes.project.source}] (lint=${videoTypes.project.lint_ruleset}, segmentation=${videoTypes.project.segmentation}, clean_cut=${videoTypes.project.clean_cut})`
        : ""),
    recommendation: videoTypes.user_defined.length > 0 || videoTypes.env_override
      ? null
      : "To define custom presets, drop a .vob-config/video-types.json (see video-types.example.json) or set VOB_VIDEO_TYPE in the MCP launch env.",
    blocker: false,
  });

  // Host capacity + derived ceilings.
  const tuningLine = tuning.settings.map((s) => `${s.setting}=${s.value} [${s.source}]`).join(", ");
  checks.push({
    name: "host-capacity",
    level: lowRam ? "warn" : "ok",
    detail: `platform=${platform}, ram=${totalmem ? (totalmem / GIB).toFixed(1) : "?"}GiB total / ${freemem ? (freemem / GIB).toFixed(1) : "?"}GiB free, cpus=${cpus}` +
      (tuning.capacity ? ` | capacity tier: ${tuning.capacity}` : "") +
      ` | tuning: ${tuningLine}`,
    recommendation: lowRam
      ? `Low-RAM host: render pinned to ${renderWorkers} worker(s); cap heavy concurrent encodes at ${encodeCap}. Run full renders in the background and expect long, blocking jobs.`
      : (tuning.config_present
        ? null
        : `To tune any of these per machine, drop a .vob-config/host.json (e.g. {"capacity":"high"}) or set the VOB_* env in the MCP launch config. Defaults shown are RAM-derived.`),
    blocker: false,
    render_workers: renderWorkers,
    heavy_encode_concurrency: encodeCap,
    gpu_mode: gpuMode || "(hyperframes default)",
  });

  // Static advisories — known footage / render gotchas, surfaced as guard rails.
  const advisories = [
    {
      name: "dji-rotation",
      detail: "DJI Osmo/drone clips can carry a bogus display-rotation tag that ffmpeg double-rotates. If a deliverable comes out sideways, set VOB_DISABLE_AUTOROTATE=1 (adds -noautorotate to decodes). INGEST flags sources whose probe reports a non-zero rotation.",
    },
    {
      name: "video-render-fragility",
      detail: "On constrained hosts, hyperframes continuous capture of compositions containing <video> can die mid-render (Target closed / BeginFrame timeout). Fallbacks: VOB_FORCE_SCREENSHOT=1 (discrete capture), or render graphics as a transparent overlay and composite over an ffmpeg-cut base (overlay-over-base mode; see vob_import_deliverable composite).",
    },
    {
      name: "docker-banned",
      detail: "Rendering is ALWAYS native on the host. Docker is intentionally unsupported across the pipeline — never enable it.",
    },
    {
      name: "subject-compositing",
      detail: "render_mode:\"subject\" mattes a subject off its background (hyperframes remove-background, local — coreml/cpu, no cloud) and composites it over a designed/ingested backdrop. First run downloads the model weights; matting is per-frame (slow on long clips), capped by VOB_SUBJECT_SECONDS_MAX. NO synthesized/stock backdrops — design token, an ingested clip, or the scene's own base only.",
    },
  ];

  const blockers = checks.filter((c) => c.blocker).map((c) => c.name);
  const warnings = checks.filter((c) => c.level === "warn").map((c) => c.name);
  const ok = blockers.length === 0;

  return {
    ok,
    checked_at: new Date().toISOString(),
    summary: ok
      ? (warnings.length ? `ready, with ${warnings.length} warning(s): ${warnings.join(", ")}` : "all systems go")
      : `BLOCKED: ${blockers.join(", ")} missing`,
    host: {
      platform,
      total_ram_gib: totalmem ? Number((totalmem / GIB).toFixed(2)) : null,
      free_ram_gib: freemem ? Number((freemem / GIB).toFixed(2)) : null,
      cpus,
      low_ram: lowRam,
      render_workers: renderWorkers,
      heavy_encode_concurrency: encodeCap,
      gpu_mode: gpuMode || null,
    },
    tuning,
    video_types: videoTypes,
    // The exact pinned hyperframes invocation for bespoke escape-hatch work.
    hyperframes_invocation: hfInvocation,
    checks,
    advisories,
    blockers,
    warnings,
  };
}

module.exports = { runDoctor };
