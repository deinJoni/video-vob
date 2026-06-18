"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, renderStderrLogPath, rendersDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildRenderArgv, renderTimeoutMs } = require("../hyperframes-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { verifyRenderedMp4 } = require("../render-verify.js");
const { expectedTimelineDurationSeconds, findTimeline, allStoryboardScenes, realizedScopeDurationSeconds } = require("../storyboard-schema.js");
const { planSegmentById } = require("../render-segments.js");

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
  // Revision binding (D2): capture which composition revision the renderer is
  // actually consuming, at the PRE-render read. A save that lands mid-render
  // bumps composition.revision_count past this value, so the stale-render gate
  // detects the mismatch instead of false-passing a render of old files.
  const compositionRevisionRendered = Number.isInteger(composition.revision_count)
    ? composition.revision_count
    : null;

  const rendersRoot = rendersDir(id);
  fs.mkdirSync(rendersRoot, { recursive: true });

  // Timeout scales with the ACTIVE scope's total (the composition's render
  // segment in a segmented plan, its short in fan-out, the document total
  // otherwise), floored at the fixed 15-min cap. Drift verification only gets
  // an expectation when the active scope actually RESOLVED — a timeout
  // fallback must never become a false silent-truncation flag.
  let sbTotal = null;
  let expectedDurationSeconds = null;
  const segmentId = typeof composition.segment_id === "string" && composition.segment_id !== ""
    ? composition.segment_id
    : null;
  const planSegment = segmentId ? planSegmentById(state, segmentId) : null;
  if (planSegment) {
    // declared fallback (refined to the realized cut below if the storyboard reads)
    sbTotal = Number.isFinite(planSegment.target_duration_seconds) ? planSegment.target_duration_seconds : null;
    expectedDurationSeconds = sbTotal;
  }
  try {
    const sb = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8"));
    const shortId = typeof composition.short_id === "string" && composition.short_id !== ""
      ? composition.short_id
      : null;
    let scopeScenes = null;
    if (planSegment && Array.isArray(planSegment.scene_ids)) {
      const want = new Set(planSegment.scene_ids);
      scopeScenes = allStoryboardScenes(sb).filter((s) => s && want.has(s.scene_id));
    } else {
      sbTotal = expectedTimelineDurationSeconds(sb, shortId);
      const timeline = findTimeline(sb, shortId);
      scopeScenes = timeline && Array.isArray(timeline.scenes) ? timeline.scenes : null;
      expectedDurationSeconds = timeline
        && Number.isFinite(timeline.total_target_duration_seconds) && timeline.total_target_duration_seconds > 0
        ? timeline.total_target_duration_seconds
        : null;
    }
    // Drift expectation = the REALIZED cut (speed/layout-baked sceneOutputSeconds
    // sum), not the declared target — the target legitimately differs (that's the
    // PLAN_DURATION_INFEASIBLE lint's job), so comparing render duration to it
    // gives false silent-truncation flags. Fall back to declared when scenes
    // don't resolve.
    const realized = scopeScenes ? realizedScopeDurationSeconds(scopeScenes) : 0;
    if (realized > 0) expectedDurationSeconds = realized;
  } catch {}
  const timeoutMs = renderTimeoutMs("preview", sbTotal);

  const ts0 = filenameSafeTimestamp();
  const outPath = path.join(rendersRoot, `preview-${ts0}.mp4`);
  const stderrLogPath = renderStderrLogPath(id, "preview", ts0);
  const start = Date.now();

  const result = await runHyperframesWithRetry(
    buildRenderArgv({ composeRoot, outPath, quality: "draft" }),
    { timeoutMs, stderrLogPath, maxAttempts: 3 },
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
      `hyperframes render failed (exit ${result.exit_code}) — partial log at ${stderrLogPath}: ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_log_path: stderrLogPath, stderr_preview: stderrPreview },
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render reported success but no output file at ${outPath} — partial log at ${stderrLogPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }

  const renderDurationSeconds = (Date.now() - start) / 1000;
  // Silent-truncation detector + content QC: ffprobe the MP4 vs the realized cut,
  // and sample luma/volume so an all-black or silent preview (dropped clip /
  // failed audio mux — duration looks fine) is flagged before the human confirms.
  const verification = verifyRenderedMp4({ mp4Path: outPath, expectedDurationSeconds, checkContent: true });
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

    // composition_revision_rendered was captured at the PRE-render read (see
    // above) — stamping the commit-time value would bind a render of OLD files
    // to a NEW revision saved mid-render, false-passing the stale gate.

    const next = {
      ...stateNow,
      preview: {
        render_path: outPath,
        rendered_at: ts,
        render_duration_seconds: renderDurationSeconds,
        confirmed: false,
        confirmed_at: null,
        revision_count: revisionCount,
        stderr_log_path: stderrLogPath,
        composition_revision_rendered: compositionRevisionRendered,
        verification,
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
          duration_drift_seconds: verification.duration_drift_seconds,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      render_path: outPath,
      rendered_at: ts,
      render_duration_seconds: renderDurationSeconds,
      revision_count: revisionCount,
      stderr_log_path: stderrLogPath,
      composition_revision_rendered: compositionRevisionRendered,
      verification,
      exit_code: 0,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_render_preview",
  description: "Render a draft MP4 to renders/preview-<ts>.mp4, teeing stderr to renders/preview-<ts>.log. BLOCKING; timeout scales with storyboard duration (≥15 min; VOB_RENDER_TIMEOUT_MS overrides). Success returns render_path + ffprobe `verification` (duration drift vs storyboard, dims, audio) and resets preview confirmation. Failure throws without touching state.",
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
  session_artifacts_written: ["renders/preview-*.mp4", "renders/preview-*.log", "state.json"],
  hook_required: false,
});
