"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, briefPath, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { validateBriefGrounding } = require("../brief-validator.js");

const MAX_BRIEF_LENGTH = 100 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function validateContent(rawContent) {
  if (typeof rawContent !== "string") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a string");
  }
  if (rawContent.trim() === "") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a non-empty string");
  }
  if (rawContent.length > MAX_BRIEF_LENGTH) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `content exceeds ${MAX_BRIEF_LENGTH} character limit`,
    );
  }
  return rawContent.endsWith("\n") ? rawContent : `${rawContent}\n`;
}

function saveBrief(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const content = validateContent(args && args.content);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);
    const grounding = validateBriefGrounding(content, state);
    if (!grounding.ok) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `brief contains ungrounded claims: ${grounding.violations.map((v) => v.message).join("; ")}`,
        { violations: grounding.violations },
      );
    }
    const file = briefPath(id);
    writeFileAtomic(file, content);

    const ts = nowIso();
    const next = {
      ...state,
      brief: {
        path: file,
        saved_at: ts,
        confirmed: false,
        confirmed_at: null,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "brief_saved", at: ts },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      brief_path: file,
      saved_at: ts,
      confirmed: false,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_save_brief",
  description: "Save (or overwrite) the brief.md artifact for a project (the creative-direction half of the PLAN gate). Any save resets confirmed:false — the user must explicitly approve again via vob_confirm_brief before the PLAN -> COMPOSE gate will unlock.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      content: { type: "string", minLength: 1, maxLength: MAX_BRIEF_LENGTH },
    },
    required: ["project_id", "content"],
  },
  handler: saveBrief,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["brief.md", "state.json"],
  hook_required: false,
});
