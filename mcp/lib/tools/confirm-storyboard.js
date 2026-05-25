"use strict";

const fs = require("fs");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");

function nowIso() {
  return new Date().toISOString();
}

function confirmStoryboard(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const storyboard = state.storyboard && typeof state.storyboard === "object" && !Array.isArray(state.storyboard)
      ? state.storyboard
      : null;
    if (!storyboard || typeof storyboard.artifact_path !== "string" || !storyboard.artifact_path) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "no storyboard recorded in state — call vob_save_storyboard before vob_confirm_storyboard",
      );
    }
    if (!fs.existsSync(storyboard.artifact_path)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `storyboard artifact referenced by state is not on disk: ${storyboard.artifact_path}`,
      );
    }

    const ts = nowIso();
    const next = {
      ...state,
      storyboard: {
        ...storyboard,
        confirmed: true,
        confirmed_at: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "storyboard_confirmed", at: ts },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      artifact_path: storyboard.artifact_path,
      markdown_path: storyboard.markdown_path,
      confirmed: true,
      confirmed_at: ts,
      revision_count: storyboard.revision_count,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_confirm_storyboard",
  description: "Mark the saved storyboard as user-confirmed. Required before STORYBOARD -> COMPOSE will unlock. Errors if no storyboard has been saved. A subsequent vob_save_storyboard call resets confirmation to false.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: confirmStoryboard,
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
