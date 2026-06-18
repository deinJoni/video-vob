"use strict";

const fs = require("fs");
const path = require("path");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, deliverablesDir, sessionDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { currentIterationVersion } = require("../archival.js");
const { missingShortDeliverables } = require("../phase-gates.js");

function nowIso() {
  return new Date().toISOString();
}

function finalizeIteration(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const pkg = state.package && typeof state.package === "object" && !Array.isArray(state.package)
      ? state.package
      : null;
    // Import-only (escape-hatch) projects have no single-timeline package — their
    // externally-recorded deliverables are the output. Accept those too.
    const externalDeliverables = state.external_import === true
      && Array.isArray(state.deliverables) && state.deliverables.length > 0
      && fs.existsSync(deliverablesDir(id));
    const packageDirectoryPath = pkg && typeof pkg.directory_path === "string" && pkg.directory_path
      ? pkg.directory_path
      : (externalDeliverables ? path.relative(sessionDir(id), deliverablesDir(id)) : null);
    if (!packageDirectoryPath) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "no package or external deliverables recorded in state — call vob_package_output (or vob_import_deliverable) before vob_finalize_iteration",
      );
    }
    // Fan-out completeness backstop (mirrors the PACKAGE→ITERATE gate): import
    // with set_phase:true jumps straight to PACKAGE WITHOUT crossing the gate, so
    // finalizing here could silently bless a partial short set. Refuse until every
    // short has a recorded deliverable — the same shared helper the gate uses.
    const missingShorts = missingShortDeliverables(state);
    if (missingShorts.length > 0) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `cannot finalize: ${missingShorts.length} short(s) have no recorded deliverable (${missingShorts.join(", ")}) — record each with vob_import_deliverable before vob_finalize_iteration`,
        { missing_short_ids: missingShorts },
      );
    }

    const version = currentIterationVersion(state);
    const ts = nowIso();
    const prevIteration = state.iteration && typeof state.iteration === "object" && !Array.isArray(state.iteration)
      ? state.iteration
      : null;
    const archive = prevIteration && Array.isArray(prevIteration.archive) ? prevIteration.archive : [];

    const next = {
      ...state,
      iteration: {
        current_version: version,
        archive,
        finalized_at: ts,
        finalized_version: version,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "iteration_finalized", at: ts, iteration_version: version },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      iteration_version: version,
      package_directory_path: packageDirectoryPath,
      finalized_at: ts,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_finalize_iteration",
  description: "Mark the current iteration as complete (the user reached ITERATE phase with a packaged output). Records iteration.current_version and a 'iteration_finalized' history event. Idempotent — re-calling without an intervening back-edge is a no-op in terms of version numbering. Requires state.package OR externally-imported deliverables (vob_import_deliverable) to exist.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: finalizeIteration,
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
