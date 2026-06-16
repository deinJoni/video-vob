"use strict";

const fs = require("fs");
const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");

function nowIso() {
  return new Date().toISOString();
}

function confirmRender(args) {
  const id = assertSafeProjectId(args && args.project_id);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const render = state.render && typeof state.render === "object" && !Array.isArray(state.render)
      ? state.render
      : null;
    if (!render || typeof render.mp4_path !== "string" || !render.mp4_path) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "no full render recorded in state — call vob_render_full before vob_confirm_render",
      );
    }
    if (!fs.existsSync(render.mp4_path)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `render file referenced by state is not on disk: ${render.mp4_path}`,
      );
    }

    const ts = nowIso();
    const next = {
      ...state,
      render: {
        ...render,
        confirmed: true,
        confirmed_at: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "render_confirmed",
          at: ts,
          revision_count: render.revision_count,
          ...(typeof render.segment_id === "string" && render.segment_id ? { segment_id: render.segment_id } : {}),
        },
      ],
    };
    // Segmented render: the confirmed render is a segment PARTIAL — mirror the
    // confirmation into its registry entry (matched by segment_id + mp4_path so
    // a stale slot can never confirm a different partial).
    const segmentId = typeof render.segment_id === "string" && render.segment_id ? render.segment_id : null;
    const registry = state.segment_renders && typeof state.segment_renders === "object" && !Array.isArray(state.segment_renders)
      ? state.segment_renders
      : null;
    const registryEntry = segmentId && registry && registry[segmentId] && typeof registry[segmentId] === "object"
      ? registry[segmentId]
      : null;
    if (registryEntry && registryEntry.mp4_path === render.mp4_path) {
      next.segment_renders = {
        ...registry,
        [segmentId]: { ...registryEntry, confirmed: true, confirmed_at: ts },
      };
    }
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      mp4_path: render.mp4_path,
      confirmed: true,
      confirmed_at: ts,
      revision_count: render.revision_count,
      ...(segmentId ? { segment_id: segmentId } : {}),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_confirm_render",
  description: "Mark the latest full render as user-confirmed. Required before RENDER -> PACKAGE will unlock. Errors if no render has been completed or the MP4 is missing from disk. A subsequent vob_render_full call resets confirmation to false.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: confirmRender,
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
