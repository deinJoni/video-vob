"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { validateCompositionFiles, htmlAndCssEntries } = require("../composition-files.js");
const { recreateSourceSymlinks, resolveSceneClipLinks, resolveSourceLinks, injectFontKit } = require("../source-symlink.js");
const { runCompositionQc } = require("../composition-qc.js");

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

  // Static QC pre-check (D6), BEFORE the lock/wipe: a QC-failing save leaves the
  // prior composition (and its lint status) fully intact, exactly like a
  // schema-failing save.
  let storyboard = null;
  try {
    storyboard = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8"));
  } catch {
    storyboard = null;
  }
  if (storyboard && (typeof storyboard !== "object" || Array.isArray(storyboard))) storyboard = null;

  const qc = runCompositionQc({
    files: htmlAndCssEntries(verdict.normalized),
    storyboard,
    sourceLinks: resolveSourceLinks(id),
    sceneClipLinks: resolveSceneClipLinks(id),
    checkTargetsOnDisk: true, // clips were materialized at COMPOSE entry; missing = real problem
  });
  if (qc.error_count > 0) {
    const hasUnresolvedRef = qc.findings.some((f) => f.rule === "vob/unresolved_source_ref");
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `composition QC failed: ${qc.error_count} error(s) — ${qc.findings
        .filter((f) => f.severity === "error").slice(0, 3).map((f) => f.rule).join(", ")}. Fix and re-save.`,
      {
        qc_findings: qc.findings.slice(0, 10),
        qc_error_count: qc.error_count,
        qc_warning_count: qc.warning_count,
        // Unresolved-ref fixes shouldn't need a storyboard round-trip: hand
        // back every legal ./source/ name.
        ...(hasUnresolvedRef ? { valid_source_refs: qc.expected_source_names } : {}),
      },
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

    const symlinkResult = recreateSourceSymlinks(id, composeRoot);
    // Font kit rides the same mechanism as ./source/ (D7). A composer-supplied
    // fonts.css wins — skipCss leaves its already-written file in place.
    const fontResult = injectFontKit(composeRoot, { skipCss: writtenRelPaths.includes("fonts.css") });
    symlinkResult.warnings.push(...fontResult.warnings);

    const ts = nowIso();
    const prev = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
      ? state.composition
      : null;
    const prevRevisionCount = prev && Number.isInteger(prev.revision_count) ? prev.revision_count : 0;
    const revisionCount = prevRevisionCount + 1;

    const prevPreviewSlot = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
      ? state.preview
      : null;
    const prevRenderSlot = state.render && typeof state.render === "object" && !Array.isArray(state.render)
      ? state.render
      : null;

    const next = {
      ...state,
      composition: {
        files: writtenRelPaths.slice().sort(),
        saved_at: ts,
        lint_status: "unknown",
        lint_report_path: null,
        lint_ran_at: null,
        revision_count: revisionCount,
        // errors never stored — they reject before the lock
        qc: { error_count: 0, warning_count: qc.warning_count, findings: qc.findings.slice(0, 10) },
        fonts: { linked: fontResult.linked, css_path: fontResult.linked ? "fonts.css" : null },
        ...(symlinkResult.warnings.length > 0
          ? { source_link_warnings: symlinkResult.warnings }
          : {}),
      },
      // D2: a composition save invalidates downstream human approvals. SKILL.md
      // claimed this reset existed; now it does. Slots are not deleted (paths
      // survive for display) — only confirmed/confirmed_at reset.
      ...(prevPreviewSlot
        ? { preview: { ...prevPreviewSlot, confirmed: false, confirmed_at: null } }
        : {}),
      ...(prevRenderSlot
        ? { render: { ...prevRenderSlot, confirmed: false, confirmed_at: null } }
        : {}),
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          kind: "composition_saved",
          at: ts,
          revision_count: revisionCount,
          file_count: writtenRelPaths.length,
          total_bytes: verdict.total_bytes,
          source_link_count: symlinkResult.links.length,
          scene_clip_link_count: Array.isArray(symlinkResult.scene_clip_links)
            ? symlinkResult.scene_clip_links.length
            : 0,
          reset_preview_confirmed: Boolean(prevPreviewSlot && prevPreviewSlot.confirmed === true),
          reset_render_confirmed: Boolean(prevRenderSlot && prevRenderSlot.confirmed === true),
          qc_warning_count: qc.warning_count,
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
      qc: { error_count: 0, warning_count: qc.warning_count, findings: qc.findings.slice(0, 10) },
      fonts_linked: fontResult.linked,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_save_composition",
  description: "Save the hyperframes composition: map of relative-path → content (index.html required; .html/.css/.js/.json/.svg; ≤64 files, ≤256KiB each, ≤1MiB total). Fully replacing. The engine recreates ./source/ symlinks and the ./fonts.css font kit, runs static QC (errors reject with details.qc_findings), resets lint_status to 'unknown' and preview/render confirmation, and bumps revision_count.",
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
  session_artifacts_written: ["compose/*", "compose/source/*", "state.json"],
  hook_required: false,
});
