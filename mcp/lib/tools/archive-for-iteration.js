"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { archiveForIteration } = require("../archival.js");

function nowIso() {
  return new Date().toISOString();
}

// Standalone archival entrypoint. The primary archival code path is inside
// transitionPhase() — back-edges from RENDER/PACKAGE/ITERATE to COMPOSE or
// STORYBOARD trigger archival atomically. This tool exposes the same
// underlying helper for tests, recovery, or out-of-band cleanup. The
// orchestrator does NOT call it directly; it's NOT in the orchestrator's
// allowed-tools list. Registering it here keeps the audit story uniform.
function archiveForIterationTool(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const archive = archiveForIteration(state, { from: state.phase, to: null });
    if (!archive) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "nothing to archive — neither renders/ nor package/ exists for this project",
      );
    }
    const ts = nowIso();
    let next = archive.apply(state);
    next = {
      ...next,
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "iteration_archived",
          at: ts,
          archive_version: archive.record.version,
          paths: archive.record.paths,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      archive_version: archive.record.version,
      archived_at: archive.record.archived_at,
      paths: archive.record.paths,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_archive_for_iteration",
  description: "Standalone archival of the current iteration's renders/ and package/ into archive/v<N>/. Normally invoked automatically by phase transitions out of RENDER/PACKAGE/ITERATE; this tool exists for tests and recovery. Bumps iteration.current_version and clears state.preview, state.render, state.package. Throws NOT_FOUND if there is nothing to archive.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: archiveForIterationTool,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["archive/v*/renders", "archive/v*/package", "archive/v*/snapshot.json", "state.json"],
  hook_required: false,
});
