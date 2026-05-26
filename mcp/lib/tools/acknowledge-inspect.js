"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");

function nowIso() {
  return new Date().toISOString();
}

function acknowledgeInspect(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const inspect = state.inspect && typeof state.inspect === "object" && !Array.isArray(state.inspect)
      ? state.inspect
      : null;
    if (!inspect || !inspect.completed_at) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        "no completed inspect to acknowledge — call vob_inspect_source first",
      );
    }
    const ts = nowIso();
    const next = {
      ...state,
      inspect: {
        ...inspect,
        user_acknowledged: true,
        acknowledged_at: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "inspect_acknowledged", at: ts },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
    return {
      project_id: id,
      user_acknowledged: true,
      acknowledged_at: ts,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_acknowledge_inspect",
  description: "Record that the orchestrator has surfaced the inspect artifacts (thumbs, transcript) to the user and that the user has been given the opportunity to look. Sets state.inspect.user_acknowledged:true. Required by the INSPECT -> INTENT gate. The two-step (inspect then acknowledge) separates the extraction from the human-in-the-loop moment in the audit log.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: acknowledgeInspect,
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
