"use strict";

const fs = require("fs");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");

function nowIso() {
  return new Date().toISOString();
}

function confirmPreview(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const preview = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
      ? state.preview
      : null;
    if (!preview || typeof preview.render_path !== "string" || !preview.render_path) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "no preview recorded in state — call vob_render_preview before vob_confirm_preview",
      );
    }
    if (!fs.existsSync(preview.render_path)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `preview file referenced by state is not on disk: ${preview.render_path}`,
      );
    }
    // Revision cross-check (PREVIEW#9, defense-in-depth): confirming a preview
    // that predates the current composition would bless a render of OLD files —
    // the PREVIEW->RENDER gate's stale-binding is the backstop, but confirmation
    // shouldn't depend solely on the save-time reset side-effect.
    const composition = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
      ? state.composition : null;
    const compRev = composition && Number.isInteger(composition.revision_count) ? composition.revision_count : null;
    const previewRev = Number.isInteger(preview.composition_revision_rendered) ? preview.composition_revision_rendered : null;
    if (compRev !== null && previewRev !== null && previewRev !== compRev) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `cannot confirm: preview was rendered against composition revision ${previewRev} but the composition is now revision ${compRev} — re-run vob_render_preview, then confirm`,
        { composition_revision: compRev, composition_revision_rendered: previewRev },
      );
    }

    const ts = nowIso();
    const next = {
      ...state,
      preview: {
        ...preview,
        confirmed: true,
        confirmed_at: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "preview_confirmed", at: ts, revision_count: preview.revision_count },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      render_path: preview.render_path,
      confirmed: true,
      confirmed_at: ts,
      revision_count: preview.revision_count,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_confirm_preview",
  description: "Mark the latest preview render as user-confirmed. Required before PREVIEW -> RENDER will unlock. Errors if no preview has been rendered or the file is missing from disk. A subsequent vob_render_preview call resets confirmation to false.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: confirmPreview,
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
