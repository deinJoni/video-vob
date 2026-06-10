"use strict";

const { transitionPhase } = require("../session-state.js");
const { PHASE_VALUES } = require("../constants.js");

module.exports = Object.freeze({
  name: "vob_transition_phase",
  description: "Apply one validated FSM transition. Refuses unknown edges; refuses gate-blocked transitions unless override_reason is given; blockers marked non-overridable (inspect acknowledgement, preview/render confirmation) refuse override entirely. Entering COMPOSE blocks while scene clips are pre-cut (cached on re-entry). Returns {from, to, archived, clips, phase_summary} — no full state echo.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      to_phase: { type: "string", enum: [...PHASE_VALUES] },
      override_reason: {
        type: "string",
        description: "Auditable reason recorded in history when bypassing a gate.",
      },
    },
    required: ["project_id", "to_phase"],
  },
  handler: transitionPhase,
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
