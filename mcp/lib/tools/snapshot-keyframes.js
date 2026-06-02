"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, snapshotsDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildSnapshotArgv } = require("../hyperframes-runner.js");

const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FRAMES = 16;
const DEFAULT_FRAMES = 5;

function nowIso() {
  return new Date().toISOString();
}

// Render full-fidelity key-frame stills from the current composition via
// `hyperframes snapshot`. Unlike ffmpeg-on-the-draft (which only samples
// the SOURCE video), snapshot renders the whole composition — overlays,
// captions, type — at the requested timecodes, so the user catches the
// text-legibility and fps-dependent issues a draft preview hides. The
// orchestrator computes the timecodes worth seeing (scene starts, key moments)
// and passes them; when omitted, we fall back to N evenly-spaced frames.
async function snapshotKeyframes(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const composeRoot = composeDir(id);
  const indexPath = path.join(composeRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `composition files missing from disk (expected ${indexPath}) — save a composition before snapshotting key frames`,
    );
  }

  const state = readSessionStateStrict(id);
  const composition = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no composition saved — vob_snapshot_keyframes needs a saved composition to render",
    );
  }

  // Timecodes (preferred) win over a frame count. Numbers are seconds.
  let timecodes = null;
  if (Array.isArray(args && args.timecodes) && args.timecodes.length > 0) {
    timecodes = args.timecodes
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t >= 0)
      .slice(0, MAX_FRAMES);
    if (timecodes.length === 0) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        "timecodes must contain at least one non-negative finite number (seconds)",
      );
    }
  }
  const frames = Number.isInteger(args && args.frames) && args.frames > 0
    ? Math.min(args.frames, MAX_FRAMES)
    : DEFAULT_FRAMES;

  // Wipe prior snapshots so the returned set reflects only this run (snapshot
  // writes deterministic names, but a prior run with more frames could linger).
  const snapsDir = snapshotsDir(id);
  fs.rmSync(snapsDir, { recursive: true, force: true });

  const start = Date.now();
  const result = await runHyperframesWithRetry(
    buildSnapshotArgv({ composeRoot, timecodes, frames }),
    { timeoutMs: SNAPSHOT_TIMEOUT_MS, maxAttempts: 3 },
  );

  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes snapshot timed out after ${Math.round(SNAPSHOT_TIMEOUT_MS / 1000)}s`,
      { stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 2000) || null;
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes snapshot failed (exit ${result.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_preview: stderrPreview },
    );
  }

  const stillPaths = fs.existsSync(snapsDir)
    ? fs.readdirSync(snapsDir)
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort()
        .map((name) => path.join(snapsDir, name))
    : [];
  if (stillPaths.length === 0) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `snapshot reported success but no PNG frames were written to ${snapsDir}`,
    );
  }
  const contactSheetAbs = path.join(snapsDir, "contact-sheet.jpg");
  const contactSheetPath = fs.existsSync(contactSheetAbs) ? contactSheetAbs : null;

  const snapshotDurationSeconds = (Date.now() - start) / 1000;
  const ts = nowIso();

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const next = {
      ...stateNow,
      last_updated: ts,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "keyframes_snapshotted",
          at: ts,
          count: stillPaths.length,
          timecodes: timecodes || null,
          frames: timecodes ? null : frames,
          snapshots_dir: snapsDir,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      snapshots_dir: snapsDir,
      still_paths: stillPaths,
      contact_sheet_path: contactSheetPath,
      count: stillPaths.length,
      timecodes: timecodes || null,
      snapshot_duration_seconds: snapshotDurationSeconds,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_snapshot_keyframes",
  description: "Render full-fidelity key-frame stills from the current composition via `hyperframes snapshot`, writing PNGs to compose/snapshots/ (plus a contact-sheet.jpg). Pass `timecodes` (array of seconds — e.g. scene starts or key moments) to capture exactly those frames; otherwise `frames` (default 5) evenly-spaced frames are captured. Unlike a draft MP4, these are rendered at full resolution with overlays/captions, so the user can verify text legibility and motion the draft hides. BLOCKING — renders via headless Chrome, typically 10–60s. Requires a saved composition (compose/index.html). Returns still_paths + contact_sheet_path for the orchestrator to Read and surface; appends a 'keyframes_snapshotted' history event. Snapshots are ephemeral review artifacts — the next vob_save_composition wipes compose/.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      timecodes: { type: "array", items: { type: "number", minimum: 0 }, minItems: 1, maxItems: 16 },
      frames: { type: "integer", minimum: 1, maximum: 16 },
    },
    required: ["project_id"],
  },
  handler: snapshotKeyframes,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: true,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["compose/snapshots/*.png", "compose/snapshots/contact-sheet.jpg", "state.json"],
  hook_required: false,
});
