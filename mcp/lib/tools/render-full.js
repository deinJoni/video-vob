"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, renderStderrLogPath, rendersDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildRenderArgv, renderTimeoutMs, defaultRenderQuality } = require("../hyperframes-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { verifyRenderedMp4 } = require("../render-verify.js");
const { expectedTimelineDurationSeconds, findTimeline } = require("../storyboard-schema.js");

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

const RENDER_QUALITIES = new Set(["standard", "high"]);

async function renderFull(args) {
  const id = assertSafeProjectId(args && args.project_id);
  // Quality: explicit arg wins; else defaultRenderQuality() (high on >=10GB hosts). Docker is never an option.
  const quality = args && args.quality != null ? String(args.quality) : defaultRenderQuality();
  if (quality !== null && !RENDER_QUALITIES.has(quality)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `quality must be one of: ${[...RENDER_QUALITIES].join(", ")} (preview uses draft; unset defers to the host default)`,
    );
  }
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
  // Revision binding (D2): capture which composition revision the renderer is
  // actually consuming, at the PRE-render read. A save that lands mid-render
  // bumps composition.revision_count past this value, so the stale-render gate
  // detects the mismatch instead of false-passing a render of old files.
  const compositionRevisionRendered = Number.isInteger(composition.revision_count)
    ? composition.revision_count
    : null;
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

  // Timeout scales with the ACTIVE timeline's total (the composition's short
  // in fan-out; the document total otherwise), floored at the fixed 30-min
  // cap. Drift verification only gets an expectation when the active timeline
  // actually RESOLVED — the longest-short timeout fallback must never become a
  // false silent-truncation flag.
  let sbTotal = null;
  let expectedDurationSeconds = null;
  try {
    const sb = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8"));
    const shortId = typeof composition.short_id === "string" && composition.short_id !== ""
      ? composition.short_id
      : null;
    sbTotal = expectedTimelineDurationSeconds(sb, shortId);
    const timeline = findTimeline(sb, shortId);
    expectedDurationSeconds = timeline
      && Number.isFinite(timeline.total_target_duration_seconds) && timeline.total_target_duration_seconds > 0
      ? timeline.total_target_duration_seconds
      : null;
  } catch {}
  const timeoutMs = renderTimeoutMs("full", sbTotal);

  const ts = filenameSafeTimestamp();
  const outPath = path.join(rendersRoot, `final-${ts}.mp4`);
  const stderrLogPath = renderStderrLogPath(id, "render", ts);

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
          expected_quality: quality !== null ? quality : "standard(default)",
          out_path: outPath,
          stderr_log_path: stderrLogPath,
          next_revision_count: prevRevisionCount + 1,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
  });

  const start = Date.now();
  const result = await runHyperframesWithRetry(
    buildRenderArgv({ composeRoot, outPath, quality }),
    { timeoutMs, stderrLogPath, maxAttempts: 2 },
  );

  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render timed out after ${Math.round(timeoutMs / 1000)}s — partial log at ${stderrLogPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = stderrTail(result.stderr, 2000);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render failed (exit ${result.exit_code}) — see ${stderrLogPath} for full output: ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_log_path: stderrLogPath, stderr_preview: stderrPreview },
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render reported success but no output file at ${outPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }

  const renderDurationSeconds = (Date.now() - start) / 1000;
  const sizeBytes = fileSizeBytes(outPath);
  // Silent-truncation detector: ffprobe the MP4 vs the storyboard expectation.
  const verification = verifyRenderedMp4({ mp4Path: outPath, expectedDurationSeconds });
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

    // composition_revision_rendered was captured at the PRE-render read (see
    // above) — stamping the commit-time value would bind a render of OLD files
    // to a NEW revision saved mid-render, false-passing the stale gate.

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
        quality,
        composition_revision_rendered: compositionRevisionRendered,
        verification,
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
          duration_drift_seconds: verification.duration_drift_seconds,
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
      quality,
      composition_revision_rendered: compositionRevisionRendered,
      verification,
      exit_code: 0,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_render_full",
  description: "Render the final MP4 to renders/final-<ts>.mp4, teeing stderr to renders/render-<ts>.log (tail -f for progress). Requires preview.confirmed:true. quality: explicit 'standard'|'high', else defaults to 'high' on ≥10GB-RAM hosts (VOB_RENDER_QUALITY overrides). BLOCKING; timeout scales with storyboard duration (≥30 min; VOB_FULL_RENDER_TIMEOUT_MS overrides). Success returns mp4_path, file_size_bytes, stderr_log_path + ffprobe `verification`, and resets render confirmation. Failure leaves only the render_started audit entry.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      quality: { type: "string", enum: ["standard", "high"] },
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
