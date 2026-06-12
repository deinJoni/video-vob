"use strict";

const { readStateSummary } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_read_state_summary",
  description: "The orchestrator's working view: phase, iteration version, style lineage, dependency failures, and a per-slot digest (paths, confirmed/lint/render flags, revision counts, intent answers + missing keys, platform profile). Covers every routine phase decision without a full state read.",
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
