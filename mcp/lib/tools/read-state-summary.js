"use strict";

const { readStateSummary } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_read_state_summary",
  description: "Compact session view: returns project_id, phase, target, last_updated. Use this instead of vob_read_state when you only need the current phase.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: readStateSummary,
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
