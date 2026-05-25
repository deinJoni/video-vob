"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonFile } = require("./storage.js");
const { missingIntentKeys } = require("./intent-schema.js");
const { composeDir } = require("./paths.js");

// Stub: always allowed, no blockers. Used for transitions that don't have
// real preconditions in this milestone (back-edges, plus everything from
// STORYBOARD onward which is still scaffold-only).
function allow() {
  return { allowed: true, blockers: [] };
}

function blocker(code, message, fields = {}) {
  return { code, message, ...fields };
}

function block(blockers) {
  return { allowed: false, blockers };
}

// INGEST -> INTENT: a manifest.json must exist on disk and report at least
// one playable video stream. The state.manifest summary is convenient but the
// disk artifact is the source of truth.
function ingestToIntent(state) {
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
  return { allowed: true, blockers: [] };
}

// INTENT -> BRIEF: every required intent key must be present with a
// non-empty string value. The blocker lists exactly which keys are missing
// so the orchestrator can re-ask only those.
function intentToBrief(state) {
  const answers = state && state.intent && state.intent.answers;
  const missing = missingIntentKeys(answers);
  if (missing.length > 0) {
    return block([
      blocker(
        "intent_answers_missing",
        `required intent answers missing: ${missing.join(", ")}`,
        { missing_keys: missing },
      ),
    ]);
  }
  return { allowed: true, blockers: [] };
}

// STORYBOARD -> COMPOSE: storyboard must be saved on disk AND explicitly
// confirmed. Mirrors the BRIEF -> STORYBOARD invariant: a save without
// confirmation, or a save followed by edits that reset confirmed:false,
// both block here.
function storyboardToCompose(state) {
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
        "storyboard has been saved but not confirmed — call vob_confirm_storyboard after the user explicitly approves",
        { storyboard_path: storyboard.artifact_path },
      ),
    ]);
  }
  return { allowed: true, blockers: [] };
}

// BRIEF -> STORYBOARD: brief must be saved on disk AND explicitly confirmed.
// A save without confirmation, or a save followed by edits that reset
// confirmed:false, both block here.
function briefToStoryboard(state) {
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
        "brief has been saved but not confirmed — call vob_confirm_brief after the user explicitly approves",
        { brief_path: brief.path },
      ),
    ]);
  }
  return { allowed: true, blockers: [] };
}

// COMPOSE -> PREVIEW: composition must be saved on disk, lint must have run,
// and lint must report no errors. "warnings_only" passes the gate (policy
// belongs in the orchestrator, which surfaces warnings to the user before
// transitioning). "errors" or "unknown" both block.
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
  return { allowed: true, blockers: [] };
}

// PREVIEW -> RENDER: a preview render must exist on disk AND be explicitly
// confirmed. Re-rendering resets confirmation to false (enforced by
// vob_render_preview), so this gate is the load-bearing checkpoint that
// guards full-quality render against unreviewed drafts.
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
        { render_path: preview.render_path },
      ),
    ]);
  }
  return { allowed: true, blockers: [] };
}

const GATES = Object.freeze({
  "INGEST->INTENT":      ingestToIntent,
  "INTENT->BRIEF":       intentToBrief,
  "BRIEF->STORYBOARD":   briefToStoryboard,
  "BRIEF->INTENT":       allow,
  "STORYBOARD->COMPOSE": storyboardToCompose,
  "STORYBOARD->BRIEF":   allow,
  "COMPOSE->PREVIEW":    composeToPreview,
  "COMPOSE->STORYBOARD": allow,
  "PREVIEW->RENDER":     previewToRender,
  "PREVIEW->COMPOSE":    allow,
  "PREVIEW->STORYBOARD": allow,
  "RENDER->PACKAGE":     allow,
  "PACKAGE->ITERATE":    allow,
  "ITERATE->COMPOSE":    allow,
  "ITERATE->STORYBOARD": allow,
});

function getGate(from, to) {
  return GATES[`${from}->${to}`] || null;
}

module.exports = { GATES, getGate };
