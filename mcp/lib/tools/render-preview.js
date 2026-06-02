"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, rendersDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildRenderArgv, RENDER_TIMEOUT_MS } = require("../hyperframes-runner.js");

function nowIso() {
  return new Date().toISOString();
}

function filenameSafeTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

async function renderPreview(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const composeRoot = composeDir(id);
  const indexPath = path.join(composeRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `composition files missing from disk (expected ${indexPath}) — re-save the composition`,
    );
  }

  // Light state read for early validation. We do not hold the lock during the
  // (potentially multi-minute) render; we only lock to commit results.
  const state = readSessionStateStrict(id);
  const composition = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no composition saved — invoke the composer subagent and call vob_save_composition before rendering a preview",
    );
  }

  const rendersRoot = rendersDir(id);
  fs.mkdirSync(rendersRoot, { recursive: true });

  const outName = `preview-${filenameSafeTimestamp()}.mp4`;
  const outPath = path.join(rendersRoot, outName);
  const start = Date.now();

  const result = await runHyperframesWithRetry(
    buildRenderArgv({ composeRoot, outPath, quality: "draft" }),
    { timeoutMs: RENDER_TIMEOUT_MS, maxAttempts: 3 },
  );

  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render timed out after ${Math.round(RENDER_TIMEOUT_MS / 1000)}s`,
      { stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 2000) || null;
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render failed (exit ${result.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_preview: stderrPreview },
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render reported success but no output file at ${outPath}`,
      { stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null },
    );
  }

  const renderDurationSeconds = (Date.now() - start) / 1000;
  const ts = nowIso();

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const prevPreview = stateNow.preview && typeof stateNow.preview === "object" && !Array.isArray(stateNow.preview)
      ? stateNow.preview
      : null;
    const prevRevisionCount = prevPreview && Number.isInteger(prevPreview.revision_count)
      ? prevPreview.revision_count
      : 0;
    const revisionCount = prevRevisionCount + 1;

    const next = {
      ...stateNow,
      preview: {
        render_path: outPath,
        rendered_at: ts,
        render_duration_seconds: renderDurationSeconds,
        confirmed: false,
        confirmed_at: null,
        revision_count: revisionCount,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "preview_rendered",
          at: ts,
          revision_count: revisionCount,
          render_path: outPath,
          render_duration_seconds: renderDurationSeconds,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      render_path: outPath,
      rendered_at: ts,
      render_duration_seconds: renderDurationSeconds,
      revision_count: revisionCount,
      exit_code: 0,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_render_preview",
  description: "Run `hyperframes render --quality draft` against the session's compose/ directory, producing a low-resolution MP4 in renders/preview-<timestamp>.mp4. BLOCKING — typically 30s to a few minutes. Inform the user a render is starting before calling. On success, writes state.preview with render_path, rendered_at, render_duration_seconds, confirmed:false, and bumps preview.revision_count; appends 'preview_rendered' to history. On failure (non-zero exit, timeout, missing output): throws WITHOUT mutating state — prior successful preview survives a failed re-render. Re-rendering always resets preview.confirmed to false; the user must re-approve via vob_confirm_preview before PREVIEW -> RENDER will unlock.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  },
  handler: renderPreview,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: true,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["renders/preview-*.mp4", "state.json"],
  hook_required: false,
});
