"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonFile } = require("./storage.js");
const { missingIntentKeys } = require("./intent-schema.js");
const { composeDir, deliverablesDir, inspectSummaryPath, packageDir, packageFinalMp4Path, packageManifestPath, packageReadmePath, packageThumbnailPath } = require("./paths.js");

// True when a project carries externally-imported deliverables (the
// vob_import_deliverable escape hatch) that are on disk — its real output lives
// outside the single-timeline package/ slot.
function hasExternalDeliverables(state) {
  return Boolean(
    state
    && state.external_import === true
    && Array.isArray(state.deliverables)
    && state.deliverables.length > 0
    && fs.existsSync(deliverablesDir(state.project_id)),
  );
}

// Verdict convention: { allowed, blockers: [{ code, message, overridable?, ...fields }] }.
// A blocker WITHOUT an `overridable` field is overridable (legacy default);
// `overridable: false` makes transitionPhase refuse override_reason entirely.
function blocker(code, message, fields = {}) {
  return { code, message, ...fields };
}

function block(blockers) {
  return { allowed: false, blockers };
}

const ALLOWED = Object.freeze({ allowed: true, blockers: [] });

// INGEST -> INSPECT: a manifest.json must exist on disk and report at least
// one playable video stream. The state.manifest summary is convenient but the
// disk artifact is the source of truth. (Previously the INGEST -> INTENT
// gate; INSPECT now sits between INGEST and INTENT.)
function ingestToInspect(state) {
  const manifest = state && typeof state.manifest === "object" ? state.manifest : null;
  if (!manifest || typeof manifest.path !== "string" || !manifest.path) {
    return block([
      blocker(
        "manifest_missing",
        "no manifest recorded in state — call vob_ingest_file with the source path",
      ),
    ]);
  }
  if (!fs.existsSync(manifest.path)) {
    return block([
      blocker(
        "manifest_missing",
        `manifest file referenced by state is not on disk: ${manifest.path}`,
        { manifest_path: manifest.path },
      ),
    ]);
  }
  let document;
  try {
    document = readJsonFile(manifest.path);
  } catch (error) {
    return block([
      blocker(
        "manifest_unreadable",
        `manifest.json could not be parsed: ${error.message || String(error)}`,
        { manifest_path: manifest.path },
      ),
    ]);
  }
  const files = Array.isArray(document && document.files) ? document.files : [];
  const videoStreamCount = files.reduce((sum, entry) => {
    const n = Number(entry && entry.video_streams);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  if (videoStreamCount === 0) {
    return block([
      blocker(
        "no_video_streams",
        "manifest has no playable video streams — re-run vob_ingest_file with a valid video source",
        { manifest_path: manifest.path, file_count: files.length },
      ),
    ]);
  }
  return ALLOWED;
}

// INSPECT -> INTENT: inspect.json must exist on disk AND the user must have
// been shown the artifacts (user_acknowledged:true via vob_acknowledge_inspect).
// This is the comprehension gate: you cannot move to INTENT without someone
// having had the chance to look at frames + read the transcript.
function inspectToIntent(state) {
  const inspect = state && typeof state.inspect === "object" && !Array.isArray(state.inspect)
    ? state.inspect
    : null;
  if (!inspect || typeof inspect.summary_path !== "string" || !inspect.summary_path) {
    return block([
      blocker(
        "inspect_artifacts_missing",
        "no inspect summary recorded in state — call vob_inspect_source",
      ),
    ]);
  }
  if (!fs.existsSync(inspect.summary_path)) {
    return block([
      blocker(
        "inspect_artifacts_missing",
        `inspect summary referenced by state is not on disk: ${inspect.summary_path}`,
        { summary_path: inspect.summary_path },
      ),
    ]);
  }
  // Cross-check against the canonical disk path so a stale state slot can't
  // fake out the gate.
  const expectedSummary = inspectSummaryPath(state.project_id);
  if (!fs.existsSync(expectedSummary)) {
    return block([
      blocker(
        "inspect_artifacts_missing",
        `inspect summary missing from canonical path: ${expectedSummary}`,
        { expected_path: expectedSummary },
      ),
    ]);
  }
  if (inspect.user_acknowledged !== true) {
    return block([
      blocker(
        "inspect_not_acknowledged",
        "inspect artifacts have been written but the user has not been shown them — call vob_acknowledge_inspect after surfacing the findings",
        { summary_path: inspect.summary_path, overridable: false },
      ),
    ]);
  }
  return ALLOWED;
}

// INTENT -> PLAN: every required intent key must be present with a
// non-empty string value. Required keys = the always-required five PLUS any
// conditional keys made applicable by inspect findings (e.g. audio_treatment
// when audio is present). The blocker lists exactly which keys are missing
// so the orchestrator can re-ask only those. (Under adaptive intent the
// orchestrator pre-records proposed answers, so this gate typically passes
// with zero or one human question.)
function intentToPlan(state) {
  const answers = state && state.intent && state.intent.answers;
  let inspectSummary = null;
  if (state && state.inspect && typeof state.inspect.summary_path === "string" && state.inspect.summary_path) {
    if (fs.existsSync(state.inspect.summary_path)) {
      try {
        inspectSummary = readJsonFile(state.inspect.summary_path);
      } catch (error) {
        // A corrupt inspect.json must surface, not silently drop the
        // conditional intent keys it gates (audio_treatment, captions_style).
        return block([
          blocker(
            "inspect_summary_unreadable",
            `inspect.json exists but could not be parsed (${error.message || String(error)}) — re-run vob_inspect_source; conditional intent keys (audio_treatment, captions_style) cannot be derived from a corrupt summary`,
            { summary_path: state.inspect.summary_path },
          ),
        ]);
      }
    }
  }
  const missing = missingIntentKeys(answers, inspectSummary);
  if (missing.length > 0) {
    return block([
      blocker(
        "intent_answers_missing",
        `required intent answers missing: ${missing.join(", ")}`,
        { missing_keys: missing },
      ),
    ]);
  }
  return ALLOWED;
}

// PLAN -> COMPOSE: the single plan gate. Both halves of the plan must be saved
// on disk AND explicitly confirmed — the brief (creative direction) and the
// storyboard (A-roll order, chosen takes, B-roll placements). They are presented
// to the human together at one gate; internally each carries its own confirmed
// flag (set by vob_confirm_brief / vob_confirm_storyboard). The blocker codes are
// granular so the orchestrator knows which half still needs work.
function planToCompose(state) {
  const brief = state && typeof state.brief === "object" ? state.brief : null;
  if (!brief || typeof brief.path !== "string" || !brief.path) {
    return block([
      blocker(
        "brief_not_saved",
        "no brief recorded in state — call vob_save_brief with the draft markdown",
      ),
    ]);
  }
  if (!fs.existsSync(brief.path)) {
    return block([
      blocker(
        "brief_not_saved",
        `brief file referenced by state is not on disk: ${brief.path}`,
        { brief_path: brief.path },
      ),
    ]);
  }
  if (brief.confirmed !== true) {
    return block([
      blocker(
        "brief_not_confirmed",
        "brief has been saved but not confirmed — call vob_confirm_brief after the user explicitly approves the plan",
        { brief_path: brief.path },
      ),
    ]);
  }
  const storyboard = state && typeof state.storyboard === "object" ? state.storyboard : null;
  if (!storyboard || typeof storyboard.artifact_path !== "string" || !storyboard.artifact_path) {
    return block([
      blocker(
        "storyboard_not_saved",
        "no storyboard recorded in state — invoke the storyboarder subagent and call vob_save_storyboard with the JSON",
      ),
    ]);
  }
  if (!fs.existsSync(storyboard.artifact_path)) {
    return block([
      blocker(
        "storyboard_not_saved",
        `storyboard artifact referenced by state is not on disk: ${storyboard.artifact_path}`,
        { storyboard_path: storyboard.artifact_path },
      ),
    ]);
  }
  if (storyboard.confirmed !== true) {
    return block([
      blocker(
        "storyboard_not_confirmed",
        "storyboard has been saved but not confirmed — call vob_confirm_storyboard after the user explicitly approves the plan",
        { storyboard_path: storyboard.artifact_path },
      ),
    ]);
  }
  return ALLOWED;
}

// PLAN -> INTENT (back-edge): allowed when the user wants to re-clarify
// intent. Nominal check: state.intent.answers exists. Always passes under
// normal flow (INTENT was completed before PLAN was reachable).
function planToIntent(state) {
  const answers = state && state.intent && state.intent.answers;
  if (!answers || typeof answers !== "object") {
    return block([
      blocker(
        "intent_missing",
        "no intent answers recorded — cannot back-edge to INTENT without prior state",
      ),
    ]);
  }
  return ALLOWED;
}

// COMPOSE -> PREVIEW: composition saved on disk, lint run, no errors.
function composeToPreview(state) {
  const composition = state && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    return block([
      blocker(
        "composition_not_saved",
        "no composition recorded in state — invoke the composer subagent and call vob_save_composition",
      ),
    ]);
  }
  const composeRoot = composeDir(state.project_id);
  const missing = composition.files.filter((rel) => !fs.existsSync(path.join(composeRoot, rel)));
  if (missing.length > 0) {
    return block([
      blocker(
        "composition_not_saved",
        `composition files missing from disk: ${missing.slice(0, 5).join(", ")}`,
        { missing_files: missing },
      ),
    ]);
  }
  if (composition.lint_status === "unknown") {
    return block([
      blocker(
        "lint_not_run",
        "composition has been saved but not linted — call vob_lint_composition",
      ),
    ]);
  }
  if (composition.lint_status === "errors") {
    return block([
      blocker(
        "lint_errors_present",
        "lint reported errors that must be fixed — see lint_report_path and re-invoke the composer",
        { lint_report_path: composition.lint_report_path },
      ),
    ]);
  }
  return ALLOWED;
}

// COMPOSE -> PLAN (back-edge): nominal check that the storyboard half of the
// plan still exists on disk so the user has something to revise.
function composeToPlan(state) {
  const storyboard = state && typeof state.storyboard === "object" ? state.storyboard : null;
  if (!storyboard || typeof storyboard.artifact_path !== "string" || !fs.existsSync(storyboard.artifact_path)) {
    return block([
      blocker(
        "storyboard_not_saved",
        "cannot back-edge to PLAN — storyboard artifact is missing from disk",
      ),
    ]);
  }
  return ALLOWED;
}

// PREVIEW -> RENDER: preview render exists on disk AND explicitly confirmed.
function previewToRender(state) {
  const preview = state && typeof state.preview === "object" && !Array.isArray(state.preview)
    ? state.preview
    : null;
  if (!preview || typeof preview.render_path !== "string" || !preview.render_path) {
    return block([
      blocker(
        "preview_not_rendered",
        "no preview render recorded in state — call vob_render_preview",
      ),
    ]);
  }
  if (!fs.existsSync(preview.render_path)) {
    return block([
      blocker(
        "preview_not_rendered",
        `preview file referenced by state is not on disk: ${preview.render_path}`,
        { render_path: preview.render_path },
      ),
    ]);
  }
  if (preview.confirmed !== true) {
    return block([
      blocker(
        "preview_not_confirmed",
        "preview has been rendered but not confirmed — call vob_confirm_preview after the user explicitly approves",
        { render_path: preview.render_path, overridable: false },
      ),
    ]);
  }
  // Revision binding: a confirmed preview rendered against an older composition
  // revision is stale. Fires only when BOTH revisions are integers and differ —
  // pre-v2 sessions (no stamp) pass.
  const composition = state && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  const compRev = composition && Number.isInteger(composition.revision_count)
    ? composition.revision_count
    : null;
  const previewRev = Number.isInteger(preview.composition_revision_rendered)
    ? preview.composition_revision_rendered
    : null;
  if (compRev !== null && previewRev !== null && previewRev !== compRev) {
    return block([
      blocker(
        "preview_stale_composition",
        `preview was rendered against composition revision ${previewRev} but the composition is now revision ${compRev} — re-run vob_render_preview and re-confirm`,
        { composition_revision: compRev, composition_revision_rendered: previewRev },
      ),
    ]);
  }
  return ALLOWED;
}

// PREVIEW -> COMPOSE (back-edge): composition files must still exist so the
// user has something to iterate on.
function previewToCompose(state) {
  const composition = state && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    return block([
      blocker(
        "composition_not_saved",
        "cannot back-edge to COMPOSE — composition files are not recorded in state",
      ),
    ]);
  }
  return ALLOWED;
}

// PREVIEW -> PLAN (back-edge): plan's storyboard half must still exist.
function previewToPlan(state) {
  return composeToPlan(state);
}

// RENDER -> PACKAGE: full render exists on disk AND explicitly confirmed.
// This is the new M5 load-bearing forward gate.
function renderToPackage(state) {
  const render = state && typeof state.render === "object" && !Array.isArray(state.render)
    ? state.render
    : null;
  if (!render || typeof render.mp4_path !== "string" || !render.mp4_path) {
    return block([
      blocker(
        "render_not_complete",
        "no full render recorded in state — call vob_render_full",
      ),
    ]);
  }
  if (!fs.existsSync(render.mp4_path)) {
    return block([
      blocker(
        "render_not_complete",
        `render file referenced by state is not on disk: ${render.mp4_path}`,
        { mp4_path: render.mp4_path },
      ),
    ]);
  }
  if (render.confirmed !== true) {
    return block([
      blocker(
        "render_not_confirmed",
        "render has been produced but not confirmed — call vob_confirm_render after the user explicitly approves",
        { mp4_path: render.mp4_path, overridable: false },
      ),
    ]);
  }
  // Revision binding: same stale-composition rule as PREVIEW -> RENDER.
  // Absent stamp (pre-v2) passes.
  const composition = state && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  const compRev = composition && Number.isInteger(composition.revision_count)
    ? composition.revision_count
    : null;
  const renderRev = Number.isInteger(render.composition_revision_rendered)
    ? render.composition_revision_rendered
    : null;
  if (compRev !== null && renderRev !== null && renderRev !== compRev) {
    return block([
      blocker(
        "render_stale_composition",
        `full render was produced against composition revision ${renderRev} but the composition is now revision ${compRev} — re-run vob_render_full and re-confirm`,
        { composition_revision: compRev, composition_revision_rendered: renderRev },
      ),
    ]);
  }
  // Ffmpeg is required for the next phase. Surface the install gap here
  // rather than after a packaging attempt fails.
  const ffmpeg = state.dependencies && state.dependencies.ffmpeg;
  if (ffmpeg && ffmpeg.ok === false) {
    return block([
      blocker(
        "ffmpeg_unavailable",
        `ffmpeg is required for PACKAGE but was not available at INGEST: ${ffmpeg.error || "unknown error"}. Install ffmpeg and re-run vob_ingest_file (or use override_reason if you've installed it since).`,
        { ffmpeg_error: ffmpeg.error || null },
      ),
    ]);
  }
  return ALLOWED;
}

// RENDER -> COMPOSE / PLAN (back-edges): destination artifact must
// still exist; archival of current renders/ is automatic in transitionPhase.
function renderToCompose(state) {
  return previewToCompose(state);
}

function renderToPlan(state) {
  return composeToPlan(state);
}

// PACKAGE -> ITERATE: all four package files must exist on disk — OR the
// project reached PACKAGE via the import escape hatch with external deliverables
// on record (those ARE the output; there is no single-timeline package to check).
function packageToIterate(state) {
  if (hasExternalDeliverables(state)) {
    return ALLOWED;
  }
  const pkg = state && typeof state.package === "object" && !Array.isArray(state.package)
    ? state.package
    : null;
  if (!pkg || typeof pkg.directory_path !== "string" || !pkg.directory_path) {
    return block([
      blocker(
        "package_incomplete",
        "no package recorded in state — call vob_package_output",
      ),
    ]);
  }
  const pkgRoot = packageDir(state.project_id);
  if (!fs.existsSync(pkgRoot)) {
    return block([
      blocker(
        "package_incomplete",
        `package directory missing from disk: ${pkgRoot}`,
        { package_dir: pkgRoot },
      ),
    ]);
  }
  const required = [
    { label: "final.mp4", path: packageFinalMp4Path(state.project_id) },
    { label: "thumbnail.jpg", path: packageThumbnailPath(state.project_id) },
    { label: "manifest.json", path: packageManifestPath(state.project_id) },
    { label: "README.md", path: packageReadmePath(state.project_id) },
  ];
  const missing = required.filter(({ path: p }) => !fs.existsSync(p)).map((r) => r.label);
  if (missing.length > 0) {
    return block([
      blocker(
        "package_incomplete",
        `package files missing from disk: ${missing.join(", ")} — re-run vob_package_output`,
        { missing_files: missing },
      ),
    ]);
  }
  return ALLOWED;
}

// PACKAGE -> COMPOSE / PLAN (back-edges).
function packageToCompose(state) {
  return previewToCompose(state);
}

function packageToPlan(state) {
  return composeToPlan(state);
}

// ITERATE -> COMPOSE / PLAN (back-edges).
function iterateToCompose(state) {
  return previewToCompose(state);
}

function iterateToPlan(state) {
  return composeToPlan(state);
}

const GATES = Object.freeze({
  "INGEST->INSPECT":  ingestToInspect,
  "INSPECT->INTENT":  inspectToIntent,
  "INTENT->PLAN":     intentToPlan,
  "PLAN->COMPOSE":    planToCompose,
  "PLAN->INTENT":     planToIntent,
  "COMPOSE->PREVIEW": composeToPreview,
  "COMPOSE->PLAN":    composeToPlan,
  "PREVIEW->RENDER":  previewToRender,
  "PREVIEW->COMPOSE": previewToCompose,
  "PREVIEW->PLAN":    previewToPlan,
  "RENDER->PACKAGE":  renderToPackage,
  "RENDER->COMPOSE":  renderToCompose,
  "RENDER->PLAN":     renderToPlan,
  "PACKAGE->ITERATE": packageToIterate,
  "PACKAGE->COMPOSE": packageToCompose,
  "PACKAGE->PLAN":    packageToPlan,
  "ITERATE->COMPOSE": iterateToCompose,
  "ITERATE->PLAN":    iterateToPlan,
});

function getGate(from, to) {
  return GATES[`${from}->${to}`] || null;
}

module.exports = { GATES, getGate };
