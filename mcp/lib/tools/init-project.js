"use strict";

const { initProject } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_init_project",
  description: "Create the session directory and initial state.json (phase INGEST). Errors STATE_CONFLICT if the project exists (resume instead). Optional design_profile names a reusable design profile (look tokens + stylistic editorial defaults) to stamp; an UNKNOWN name is non-fatal — the project is still created and the result carries a `warning` (fail-safe; replaces the old --like derived_from/NOT_FOUND path). Returns {created, project_id, session_dir, phase, design_profile, warning?}.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      target: { type: "object", additionalProperties: true },
      design_profile: { type: "string" },
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
