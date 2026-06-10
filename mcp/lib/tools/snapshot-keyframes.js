"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, snapshotsDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildSnapshotArgv } = require("../hyperframes-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { findTimeline } = require("../storyboard-schema.js");

const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FRAMES = 16;
const DEFAULT_FRAMES = 5;

function nowIso() {
  return new Date().toISOString();
}

// Default timecodes from the storyboard: one frame just inside each scene.
// `start + min(0.5, dur/2)`: a frame exactly ON a scene boundary is ambiguous
// (either scene may render); 0.5s inside shows the scene's settled state
// including entrance-animated captions, and the hook frame lands at ≈0.5s —
// the cold-open moment the self-QC checklist inspects.
function storyboardDefaultTimecodes(projectId, shortId) {
  let sb = null;
  try {
    sb = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8"));
  } catch {
    return null;
  }
  // Fan-out: the composition implements ONE short — default frames come from
  // that short's scenes (the singleton form resolves via findTimeline too).
  const timeline = findTimeline(sb, shortId);
  const scenes = timeline ? timeline.scenes : null;
  if (!Array.isArray(scenes) || scenes.length === 0) return null;
  const out = [];
  let cursor = 0;
  for (const scene of scenes) {
    const d = Number(scene && scene.target_duration_seconds);
    if (!Number.isFinite(d) || d <= 0) return null; // malformed -> no defaults
    out.push(Math.round((cursor + Math.min(0.5, d / 2)) * 1000) / 1000);
    cursor += d;
  }
  return out.slice(0, MAX_FRAMES);
}

// Callable in COMPOSE the moment a composition is saved — deliberately NOT
// gated on lint or preview. It is the orchestrator's pre-render self-QC tool
// (snapshot ~10-60s vs minutes for a draft render).
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

  // Selection order: explicit timecodes -> storyboard scene defaults ->
  // `frames` evenly spaced. Numbers are seconds.
  let timecodes = null;
  let timecodeSource = "even_spacing";
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
    timecodeSource = "explicit";
  } else {
    const activeShortId = typeof composition.short_id === "string" && composition.short_id !== ""
      ? composition.short_id
      : null;
    const defaults = storyboardDefaultTimecodes(id, activeShortId);
    if (defaults && defaults.length > 0) {
      timecodes = defaults;
      timecodeSource = "storyboard_scenes";
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
      { stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = stderrTail(result.stderr, 2000);
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
          timecode_source: timecodeSource,
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
      timecode_source: timecodeSource,
      snapshot_duration_seconds: snapshotDurationSeconds,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_snapshot_keyframes",
  description: "Render full-resolution PNG stills + contact-sheet.jpg of the CURRENT composition via hyperframes snapshot. Callable in COMPOSE right after a save — no lint/preview required; this is the pre-render visual QC tool. timecodes (seconds) win; default = one frame just inside each storyboard scene; else `frames` evenly spaced. BLOCKING ~10–60s. Next save wipes compose/snapshots/.",
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
