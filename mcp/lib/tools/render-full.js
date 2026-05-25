"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, rendersDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesBlocking, FULL_RENDER_TIMEOUT_MS } = require("../hyperframes-runner.js");

function nowIso() {
  return new Date().toISOString();
}

function filenameSafeTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

function fileSizeBytes(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return null;
  }
}

async function renderFull(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const composeRoot = composeDir(id);
  const indexPath = path.join(composeRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `composition files missing from disk (expected ${indexPath}) — re-save the composition`,
    );
  }

  const state = readSessionStateStrict(id);
  const composition = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no composition saved — invoke the composer subagent and call vob_save_composition before rendering",
    );
  }
  const preview = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
    ? state.preview
    : null;
  if (!preview || preview.confirmed !== true) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      "preview has not been confirmed — call vob_confirm_preview before vob_render_full",
    );
  }

  const rendersRoot = rendersDir(id);
  fs.mkdirSync(rendersRoot, { recursive: true });

  const ts = filenameSafeTimestamp();
  const outPath = path.join(rendersRoot, `final-${ts}.mp4`);
  const stderrLogPath = path.join(rendersRoot, `render-${ts}.log`);

  // Audit the start of the render before the (potentially long) spawn so
  // failed/aborted attempts leave a trace in history.
  const startTs = nowIso();
  await withSessionLock(id, async () => {
    const stateNow = readSessionStateStrict(id);
    const prevRender = stateNow.render && typeof stateNow.render === "object" && !Array.isArray(stateNow.render)
      ? stateNow.render
      : null;
    const prevRevisionCount = prevRender && Number.isInteger(prevRender.revision_count)
      ? prevRender.revision_count
      : 0;
    const next = {
      ...stateNow,
      last_updated: startTs,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "render_started",
          at: startTs,
          expected_quality: "full",
          out_path: outPath,
          stderr_log_path: stderrLogPath,
          next_revision_count: prevRevisionCount + 1,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
  });

  const start = Date.now();
  const result = await runHyperframesBlocking(
    ["render", "--out", outPath, composeRoot],
    { cwd: composeRoot, timeoutMs: FULL_RENDER_TIMEOUT_MS, stderrLogPath },
  );

  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `npx hyperframes render timed out after ${Math.round(FULL_RENDER_TIMEOUT_MS / 1000)}s — partial log at ${stderrLogPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 2000) || null;
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `npx hyperframes render failed (exit ${result.exit_code}) — see ${stderrLogPath} for full output: ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_log_path: stderrLogPath, stderr_preview: stderrPreview },
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render reported success but no output file at ${outPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }

  const renderDurationSeconds = (Date.now() - start) / 1000;
  const sizeBytes = fileSizeBytes(outPath);
  const completedTs = nowIso();

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const prevRender = stateNow.render && typeof stateNow.render === "object" && !Array.isArray(stateNow.render)
      ? stateNow.render
      : null;
    const prevRevisionCount = prevRender && Number.isInteger(prevRender.revision_count)
      ? prevRender.revision_count
      : 0;
    const revisionCount = prevRevisionCount + 1;

    const next = {
      ...stateNow,
      render: {
        mp4_path: outPath,
        rendered_at: completedTs,
        render_duration_seconds: renderDurationSeconds,
        file_size_bytes: sizeBytes,
        stderr_log_path: stderrLogPath,
        confirmed: false,
        confirmed_at: null,
        revision_count: revisionCount,
      },
      last_updated: completedTs,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "render_completed",
          at: completedTs,
          revision_count: revisionCount,
          mp4_path: outPath,
          render_duration_seconds: renderDurationSeconds,
          file_size_bytes: sizeBytes,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      mp4_path: outPath,
      rendered_at: completedTs,
      render_duration_seconds: renderDurationSeconds,
      file_size_bytes: sizeBytes,
      stderr_log_path: stderrLogPath,
      revision_count: revisionCount,
      exit_code: 0,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_render_full",
  description: "Run `npx hyperframes render` (full quality, no --quality flag) against the session's compose/ directory, producing a final MP4 in renders/final-<timestamp>.mp4 and teeing stderr to renders/render-<timestamp>.log so the user can `tail -f` for progress. BLOCKING — typically 5 to 30 minutes depending on composition length and complexity. Inform the user the render is starting and point them at the log file before the call returns. Requires preview.confirmed === true. On success: writes state.render with mp4_path, rendered_at, render_duration_seconds, file_size_bytes, stderr_log_path, confirmed:false, and bumps render.revision_count; appends 'render_started' + 'render_completed' to history. On failure (non-zero exit, timeout, missing output): the 'render_started' event remains in history; render state is not promoted — prior successful render survives a failed re-render. Re-rendering always resets render.confirmed to false; the user must re-approve via vob_confirm_render before RENDER -> PACKAGE will unlock.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: renderFull,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: true,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["renders/final-*.mp4", "renders/render-*.log", "state.json"],
  hook_required: false,
});
