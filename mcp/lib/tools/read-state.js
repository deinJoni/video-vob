"use strict";

const { readState } = require("../session-state.js");

module.exports = Object.freeze({
  name: "vob_read_state",
  description: "Full state.json document. By default history is replaced by {history_count, last_history_event}, transcoded_clips by a count digest, and dependencies by failure entries; pass include:[\"history\",\"clips\",\"dependencies\"] to restore any of them. Prefer vob_read_state_summary for routine phase decisions.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      include: {
        type: "array",
        items: { type: "string", enum: ["history", "clips", "dependencies"] },
        maxItems: 3,
        description: "Opt back in to heavy sections omitted by default.",
      },
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
