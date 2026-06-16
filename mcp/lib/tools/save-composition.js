"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { validateCompositionFiles, htmlAndCssEntries } = require("../composition-files.js");
const { recreateSourceSymlinks, resolveLayoutLinks, resolveSceneClipLinks, resolveSourceLinks, injectFontKit, injectCaptionKit } = require("../source-symlink.js");
const { runCompositionQc } = require("../composition-qc.js");
const { findTimeline, storyboardHasShorts, storyboardTimelines } = require("../storyboard-schema.js");
const { planSegmentById, renderPlanOf } = require("../render-segments.js");
// The save-time lint IS the gate lint — one implementation, one report format,
// one revision binding (see the post-commit block in saveComposition).
const lintCompositionTool = require("./lint-composition.js");

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

async function saveComposition(args) {
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

  // Fan-out scoping: a shorts[] storyboard requires short_id (the active
  // short this composition implements); a single-timeline one forbids it.
  // An unreadable storyboard can't validate either way — the stamp is kept
  // and QC degrades with its own warning.
  const shortId = typeof (args && args.short_id) === "string" && args.short_id.trim() !== ""
    ? args.short_id.trim()
    : null;
  const segmentIdArg = typeof (args && args.segment_id) === "string" && args.segment_id.trim() !== ""
    ? args.segment_id.trim()
    : null;
  if (shortId && segmentIdArg) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "short_id and segment_id are mutually exclusive — a composition implements either a fan-out short or a render segment, never both",
    );
  }
  if (storyboard) {
    if (storyboardHasShorts(storyboard)) {
      const validIds = storyboardTimelines(storyboard).map((t) => t.short_id).filter(Boolean);
      if (!shortId) {
        throw new ToolError(
          ERROR_CODES.INVALID_ARGUMENTS,
          `the storyboard is a multi-short fan-out — pass short_id for the short this composition implements (one of: ${validIds.join(", ")})`,
          { valid_short_ids: validIds },
        );
      }
      if (!findTimeline(storyboard, shortId)) {
        throw new ToolError(
          ERROR_CODES.INVALID_ARGUMENTS,
          `unknown short_id "${shortId}" — the storyboard defines: ${validIds.join(", ")}`,
          { valid_short_ids: validIds },
        );
      }
    } else if (shortId) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `short_id "${shortId}" given but the storyboard is single-timeline — omit short_id`,
      );
    }
  }

  // Segmented-render scoping: a segmented render plan (stamped at COMPOSE
  // entry) requires segment_id — the render segment this composition
  // implements; without a plan, segment_id is forbidden. Mirrors short_id.
  const statePre = readSessionStateStrict(id);
  const renderPlan = renderPlanOf(statePre);
  let activeSegment = null;
  if (renderPlan) {
    const validIds = renderPlan.segments.map((s) => s.segment_id);
    if (!segmentIdArg) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `this project renders as ${renderPlan.segments.length} segments — pass segment_id for the render segment this composition implements (one of: ${validIds.join(", ")})`,
        { valid_segment_ids: validIds },
      );
    }
    const planSegment = planSegmentById(statePre, segmentIdArg);
    if (!planSegment) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `unknown segment_id "${segmentIdArg}" — the render plan defines: ${validIds.join(", ")}`,
        { valid_segment_ids: validIds },
      );
    }
    activeSegment = { segment_id: planSegment.segment_id, scene_ids: planSegment.scene_ids };
  } else if (segmentIdArg) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `segment_id "${segmentIdArg}" given but this project has no segmented render plan (single continuous render) — omit segment_id`,
    );
  }

  const qc = runCompositionQc({
    files: htmlAndCssEntries(verdict.normalized),
    storyboard,
    sourceLinks: resolveSourceLinks(id),
    sceneClipLinks: resolveSceneClipLinks(id),
    layoutLinks: resolveLayoutLinks(id),
    checkTargetsOnDisk: true, // clips were materialized at COMPOSE entry; missing = real problem
    activeShortId: shortId,
    activeSegment,
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

  const saveResult = withSessionLock(id, () => {
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
    // Caption kit (v3.3): symlink compose/captions -> mcp/assets/captions so the
    // composer can read ./captions/manifest.json + the per-component reference
    // HTML. A composer-supplied captions/ dir wins.
    const captionKitResult = injectCaptionKit(composeRoot, {
      skip: writtenRelPaths.some((p) => p === "captions" || p.startsWith("captions/")),
    });
    symlinkResult.warnings.push(...captionKitResult.warnings);

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
        ...(shortId ? { short_id: shortId } : {}),
        ...(segmentIdArg ? { segment_id: segmentIdArg } : {}),
        // errors never stored — they reject before the lock
        qc: { error_count: 0, warning_count: qc.warning_count, findings: qc.findings.slice(0, 10) },
        fonts: { linked: fontResult.linked, css_path: fontResult.linked ? "fonts.css" : null },
        captions: { linked: captionKitResult.linked },
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
          ...(shortId ? { short_id: shortId } : {}),
          ...(segmentIdArg ? { segment_id: segmentIdArg } : {}),
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
      ...(shortId ? { short_id: shortId } : {}),
      ...(segmentIdArg ? { segment_id: segmentIdArg } : {}),
      qc: { error_count: 0, warning_count: qc.warning_count, findings: qc.findings.slice(0, 10) },
      fonts_linked: fontResult.linked,
      captions_kit_linked: captionKitResult.linked,
    };
  });

  // The composer's only feedback used to be the static QC above — qc.error_count
  // 0 on every accepted save — while the REAL gate verdict (hyperframes lint +
  // QC merged, vob_lint_composition) was orchestrator-only and ran after
  // handoff: the composer iterated blind and could make things worse. Run the
  // same merged lint here, on the just-committed files, so the save result IS
  // the gate verdict and the composer self-corrects before returning. Reuses
  // the lint tool's handler directly — its revision binding makes a racing
  // re-save fail this stamp instead of mislabeling the new files. An infra
  // failure (missing/crashed hyperframes, timeout) must not fail the save:
  // files are committed, lint_status stays "unknown", and the orchestrator's
  // own vob_lint_composition call is the fallback.
  try {
    const lint = await lintCompositionTool.handler({ project_id: id });
    return { ...saveResult, lint_status: lint.lint_status, lint };
  } catch (err) {
    const code = err && err.code ? `${err.code}: ` : "";
    const message = err && err.message ? err.message : String(err);
    return {
      ...saveResult,
      lint_error: `merged lint did not run — the save stands, lint_status stays "unknown" (the orchestrator's vob_lint_composition is the fallback): ${code}${message}`,
    };
  }
}

module.exports = Object.freeze({
  name: "vob_save_composition",
  description: "Save the hyperframes composition: map of relative-path → content (index.html required; .html/.css/.js/.json/.svg; ≤64 files, ≤256KiB each, ≤1MiB total). Fully replacing. The engine recreates ./source/ symlinks, the ./fonts.css font kit, and the ./captions/ caption-component kit (read ./captions/manifest.json to realize caption_segments[].animation), runs static QC (errors reject with details.qc_findings), resets preview/render confirmation, bumps revision_count — then runs the FULL merged lint (hyperframes lint + static QC, same engine as vob_lint_composition) on the committed files, stamps composition.lint_status, and returns the verdict: lint_status ('clean'|'warnings_only'|'errors') + lint.findings_summary (≤10) + lint.report_path. Fix errors and re-save until clean. If the lint binary itself fails, the save still succeeds with lint_status 'unknown' + lint_error. Fan-out: when the storyboard has shorts[], short_id is REQUIRED (the short this composition implements) — QC scopes scene coverage/master duration to that short and warns on refs into other shorts' clips. Segmented render: when state.render_plan is segmented (long-form chunking, stamped at COMPOSE entry), segment_id is REQUIRED — QC scopes to that render segment's scenes and warns on cross-segment clip refs. short_id and segment_id are mutually exclusive.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      short_id: {
        type: "string",
        minLength: 1,
        description: "Fan-out only: the storyboard short this composition implements. Required when the storyboard has shorts[]; forbidden otherwise.",
      },
      segment_id: {
        type: "string",
        minLength: 1,
        description: "Segmented render only: the render-plan segment this composition implements. Required when state.render_plan is segmented; forbidden otherwise.",
      },
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
  // The post-commit merged lint spawns hyperframes (npx fallback may fetch).
  network_access: true,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["compose/*", "compose/source/*", "compose/lint-report.json", "state.json"],
  hook_required: false,
});
