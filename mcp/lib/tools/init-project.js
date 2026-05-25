"use strict";

const { initProject } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_init_project",
  description: "Initialize a new video-vob project: create the session directory and write the initial state.json (phase=INGEST). Errors if the project already exists.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      target: { type: "object", additionalProperties: true },
    },
    required: ["project_id"],
  },
  handler: initProject,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["state.json"],
  hook_required: false,
});
