"use strict";

const { readState } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_read_state",
  description: "Return the full state.json document for a project, including transition history.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: readState,
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
