"use strict";

const { initProject } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_init_project",
  description: "Create the session directory and initial state.json (phase INGEST). Errors STATE_CONFLICT if the project exists (resume instead). Optional derived_from stamps style lineage from an existing project (NOT_FOUND if it doesn't exist). Returns {created, project_id, session_dir, phase, style}.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      target: { type: "object", additionalProperties: true },
      derived_from: { type: "string" },
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
