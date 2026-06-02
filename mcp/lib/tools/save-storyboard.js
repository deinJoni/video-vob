"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  statePath,
  storyboardMarkdownPath,
  storyboardPath,
} = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { validateStoryboard, validateStoryboardContent } = require("../storyboard-schema.js");
const { renderStoryboardMarkdown } = require("../storyboard-markdown.js");

const MAX_STORYBOARD_LENGTH = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function parseContent(rawContent) {
  if (typeof rawContent !== "string") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a string of JSON");
  }
  if (rawContent.trim() === "") {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a non-empty JSON string");
  }
  if (rawContent.length > MAX_STORYBOARD_LENGTH) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `content exceeds ${MAX_STORYBOARD_LENGTH} character limit`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `content is not valid JSON: ${error.message || String(error)}`,
    );
  }
  const verdict = validateStoryboard(parsed);
  if (!verdict.ok) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `storyboard schema validation failed: ${verdict.errors.join("; ")}`,
      { schema_errors: verdict.errors },
    );
  }
  return parsed;
}

function saveStoryboard(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const storyboard = parseContent(args && args.content);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);

    const contentCheck = validateStoryboardContent(storyboard, state);
    if (!contentCheck.ok) {
      const summary = contentCheck.errors
        .map((e) => (typeof e === "string" ? e : `${e.code}: ${e.message}`))
        .join("; ");
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `storyboard content checks failed: ${summary}`,
        { content_errors: contentCheck.errors },
      );
    }

    const jsonFile = storyboardPath(id);
    const mdFile = storyboardMarkdownPath(id);
    const jsonText = `${JSON.stringify(storyboard, null, 2)}\n`;
    const mdText = renderStoryboardMarkdown(storyboard);

    writeFileAtomic(jsonFile, jsonText);
    writeFileAtomic(mdFile, mdText);

    const ts = nowIso();
    const prevStoryboard = state.storyboard && typeof state.storyboard === "object" && !Array.isArray(state.storyboard)
      ? state.storyboard
      : null;
    const prevRevisionCount = prevStoryboard && Number.isInteger(prevStoryboard.revision_count)
      ? prevStoryboard.revision_count
      : 0;
    const revisionCount = prevRevisionCount + 1;

    const next = {
      ...state,
      storyboard: {
        artifact_path: jsonFile,
        markdown_path: mdFile,
        saved_at: ts,
        confirmed: false,
        confirmed_at: null,
        revision_count: revisionCount,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "storyboard_saved", at: ts, revision_count: revisionCount },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      artifact_path: jsonFile,
      markdown_path: mdFile,
      saved_at: ts,
      confirmed: false,
      revision_count: revisionCount,
      scene_count: storyboard.scenes.length,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_save_storyboard",
  description: "Save (or overwrite) the storyboard for a project (the structural half of the PLAN gate). Input is a JSON string conforming to storyboard schema 1.0; the MCP server validates it, writes storyboard.json, and renders the human-readable storyboard.md from the JSON (markdown is never authored separately). Any save resets confirmed:false and increments revision_count — the user must explicitly approve again via vob_confirm_storyboard before the PLAN -> COMPOSE gate will unlock.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      content: {
        type: "string",
        minLength: 1,
        maxLength: MAX_STORYBOARD_LENGTH,
        description: "Storyboard JSON document as a string. Must satisfy storyboard schema 1.0.",
      },
    },
    required: ["project_id", "content"],
  },
  handler: saveStoryboard,
  role_bundles: ["orchestrator", "storyboarder"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["storyboard.json", "storyboard.md", "state.json"],
  hook_required: false,
});
