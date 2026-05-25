"use strict";

const fs = require("fs");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");

function nowIso() {
  return new Date().toISOString();
}

function confirmBrief(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const brief = state.brief && typeof state.brief === "object" && !Array.isArray(state.brief)
      ? state.brief
      : null;
    if (!brief || typeof brief.path !== "string" || !brief.path) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "no brief recorded in state — call vob_save_brief before vob_confirm_brief",
      );
    }
    if (!fs.existsSync(brief.path)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `brief file referenced by state is not on disk: ${brief.path}`,
      );
    }

    const ts = nowIso();
    const next = {
      ...state,
      brief: {
        ...brief,
        confirmed: true,
        confirmed_at: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "brief_confirmed", at: ts },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      brief_path: brief.path,
      confirmed: true,
      confirmed_at: ts,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_confirm_brief",
  description: "Mark the saved brief as user-confirmed. Required before BRIEF -> STORYBOARD will unlock. Errors if no brief has been saved. A subsequent vob_save_brief call resets confirmation to false.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: confirmBrief,
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
