"use strict";

const { runDoctor } = require("../doctor.js");

// Host-level preflight: no project_id required (it diagnoses the machine, not a
// session). When project_id IS given, the report additionally resolves that
// project's video-type preset (report.video_types.project) — best-effort, never
// a failure.
function doctor(args) {
  return runDoctor({ projectId: args && args.project_id ? args.project_id : null });
}

module.exports = Object.freeze({
  name: "vob_doctor",
  description: "Preflight the host before (or during) a run: checks ffmpeg, ffprobe, hyperframes, and the ASR/transcription backend (faster-whisper / openai-whisper / hyperframes-whisper-cpp), reports host RAM and the derived render-worker + heavy-encode concurrency ceilings and GPU backend, the video-type preset table (built-in + .vob-config/video-types.json user presets + VOB_VIDEO_TYPE override; with project_id, that project's resolved preset under report.video_types.project), and lists advisories for known gotchas (DJI bogus rotation, <video> render fragility, Docker-banned). Returns { ok, summary, host, tuning, video_types, checks[], advisories[], blockers[], warnings[] }. `ok:false` means a hard dependency (ffmpeg/ffprobe) is missing; a missing ASR engine is a WARNING (install faster-whisper, or pass skip_transcription at INSPECT). Run this at the start of a session — especially before a long INSPECT on a big source — so a dead transcription backend or missing binary surfaces in seconds instead of after minutes of work. Takes no required arguments.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: [],
  },
  handler: doctor,
  role_bundles: ["orchestrator"],
  mutating: false,
  global_preapproval: true,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: [],
  hook_required: false,
});
