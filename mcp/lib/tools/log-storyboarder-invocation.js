"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");

const MAX_NOTES_LENGTH = 8 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function normalizeRevisionNotes(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "revision_notes must be a string when present");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `revision_notes exceeds ${MAX_NOTES_LENGTH} character limit`,
    );
  }
  return trimmed;
}

function logStoryboarderInvocation(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const revisionNotes = normalizeRevisionNotes(args && args.revision_notes);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const storyboard = state.storyboard && typeof state.storyboard === "object" && !Array.isArray(state.storyboard)
      ? state.storyboard
      : null;
    const revisionCountAtInvocation = storyboard && Number.isInteger(storyboard.revision_count)
      ? storyboard.revision_count
      : 0;

    const ts = nowIso();
    const event = {
      kind: "storyboarder_invoked",
      at: ts,
      revision_count_at_invocation: revisionCountAtInvocation,
    };
    if (revisionNotes !== null) {
      event.revision_notes = revisionNotes;
    }

    const next = {
      ...state,
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        event,
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      logged_at: ts,
      revision_count_at_invocation: revisionCountAtInvocation,
      revision_notes: revisionNotes,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_log_storyboarder_invocation",
  description: "Append a `storyboarder_invoked` audit event to state.history before the orchestrator spawns the storyboarder subagent. Records the revision_count at invocation time and optional revision_notes (used on re-invocation passes). Does NOT mutate state.storyboard — the subagent's own vob_save_storyboard call does that.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      revision_notes: {
        type: "string",
        maxLength: MAX_NOTES_LENGTH,
        description: "Optional. The user-facing revision request that triggered this invocation. Omit on the first invocation of a project.",
      },
    },
    required: ["project_id"],
  },
  handler: logStoryboarderInvocation,
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
