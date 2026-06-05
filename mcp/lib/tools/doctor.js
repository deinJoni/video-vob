"use strict";

const { runDoctor } = require("../doctor.js");

// Host-level preflight: no project_id required (it diagnoses the machine, not a
// session). project_id is accepted but optional/ignored so the orchestrator can
// pass it uniformly.
function doctor() {
  return runDoctor();
}

module.exports = Object.freeze({
  name: "vob_doctor",
  description: "Preflight the host before (or during) a run: checks ffmpeg, ffprobe, hyperframes, and the ASR/transcription backend (faster-whisper / openai-whisper / hyperframes-whisper-cpp), reports host RAM and the derived render-worker + heavy-encode concurrency ceilings and GPU backend, and lists advisories for known gotchas (DJI bogus rotation, <video> render fragility, Docker-banned). Returns { ok, summary, host, checks[], advisories[], blockers[], warnings[] }. `ok:false` means a hard dependency (ffmpeg/ffprobe) is missing; a missing ASR engine is a WARNING (install faster-whisper, or pass skip_transcription at INSPECT). Run this at the start of a session — especially before a long INSPECT on a big source — so a dead transcription backend or missing binary surfaces in seconds instead of after minutes of work. Takes no required arguments.",
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
