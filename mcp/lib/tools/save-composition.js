"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { validateCompositionFiles } = require("../composition-files.js");

function nowIso() {
  return new Date().toISOString();
}

function wipeComposeDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.rmSync(abs, { recursive: true, force: true });
      } else {
        fs.rmSync(abs, { force: true });
      }
    } catch {}
  }
}

function saveComposition(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const verdict = validateCompositionFiles(args && args.files);
  if (!verdict.ok) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `composition validation failed: ${verdict.errors.join("; ")}`,
      { schema_errors: verdict.errors },
    );
  }

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);

    const composeRoot = composeDir(id);
    fs.mkdirSync(composeRoot, { recursive: true });
    wipeComposeDir(composeRoot);

    const writtenRelPaths = [];
    for (const entry of verdict.normalized) {
      const abs = path.join(composeRoot, entry.relPath);
      // Defense in depth: ensure abs stays inside composeRoot after resolve.
      const resolved = path.resolve(abs);
      if (!resolved.startsWith(path.resolve(composeRoot) + path.sep) && resolved !== path.resolve(composeRoot)) {
        throw new ToolError(
          ERROR_CODES.INVALID_ARGUMENTS,
          `composition file path escapes session compose dir: ${entry.relPath}`,
        );
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeFileAtomic(abs, entry.content);
      writtenRelPaths.push(entry.relPath);
    }

    const ts = nowIso();
    const prev = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
      ? state.composition
      : null;
    const prevRevisionCount = prev && Number.isInteger(prev.revision_count) ? prev.revision_count : 0;
    const revisionCount = prevRevisionCount + 1;

    const next = {
      ...state,
      composition: {
        files: writtenRelPaths.slice().sort(),
        saved_at: ts,
        lint_status: "unknown",
        lint_report_path: null,
        lint_ran_at: null,
        revision_count: revisionCount,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "composition_saved",
          at: ts,
          revision_count: revisionCount,
          file_count: writtenRelPaths.length,
          total_bytes: verdict.total_bytes,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      files_written: writtenRelPaths.slice().sort(),
      compose_dir: composeRoot,
      saved_at: ts,
      lint_status: "unknown",
      revision_count: revisionCount,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_save_composition",
  description: "Save (or overwrite) the hyperframes composition for a project. Input is a map of relative-path → string content; index.html is required, companion files optional (.html, .css, .js, .json, .svg only). Files are written atomically to the session's compose/ directory; any prior composition files are wiped first (save is fully replacing). Any save resets composition.lint_status to 'unknown' and increments revision_count — vob_lint_composition must run again before COMPOSE -> PREVIEW will unlock.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      files: {
        type: "object",
        minProperties: 1,
        maxProperties: 64,
        description: "Map of relative-path → file contents. index.html is required. Allowed extensions: .html, .css, .js, .json, .svg. Max 256 KiB per file, 1 MiB aggregate.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["project_id", "files"],
  },
  handler: saveComposition,
  role_bundles: ["composer"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["compose/*", "state.json"],
  hook_required: false,
});
